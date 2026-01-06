// @ts-ignore - osc has no type definitions
import osc from 'osc';
import { processValueForOsc, isBankSoundfont } from './sample-metadata.js';
import { resolveDrumMachineBankSync } from './on-demand-loader.js';
import { captureOscMessage, shouldCaptureOsc } from './file-writer.js';

// Default SuperDirt ports
const OSC_REMOTE_IP = '127.0.0.1';
const OSC_REMOTE_PORT = 57120;

let udpPort: any = null;
let isOpen = false;

// Clock synchronization
// AudioContext time starts at 0 when created, we need to map it to Unix/NTP time
let audioContextStartTime: number | null = null; // Unix time when AudioContext was created

/**
 * Parse a note name like "c4", "d#5", "eb3" into a MIDI note number
 * Returns undefined if the string is not a valid note name
 */
function parseNoteName(name: string): number | undefined {
  const match = name.toLowerCase().match(/^([a-g])([#bs]?)(-?\d+)?$/);
  if (!match) return undefined;
  
  const noteMap: Record<string, number> = {
    'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11,
  };
  
  let note = noteMap[match[1]];
  if (note === undefined) return undefined;
  
  if (match[2] === '#' || match[2] === 's') note += 1;  // 's' is also used for sharp
  else if (match[2] === 'b') note -= 1;
  
  const octave = match[3] ? parseInt(match[3], 10) : 4;
  return (octave + 1) * 12 + note;
}

/**
 * Set the AudioContext start time for clock synchronization
 * Call this once when the AudioContext is created
 */
export function setAudioContextStartTime(unixTimeSeconds: number): void {
  audioContextStartTime = unixTimeSeconds;
  console.log(`[osc] AudioContext start time set: ${unixTimeSeconds.toFixed(3)}`);
}

/**
 * Convert AudioContext time to Unix time in seconds
 */
function audioTimeToUnixTime(audioTime: number): number {
  if (audioContextStartTime === null) {
    // Fallback: assume AudioContext just started
    audioContextStartTime = Date.now() / 1000;
    console.warn('[osc] AudioContext start time not set, using fallback');
  }
  return audioContextStartTime + audioTime;
}

/**
 * Initialize the OSC UDP port for sending messages to SuperDirt
 */
export function initOsc(remoteIp = OSC_REMOTE_IP, remotePort = OSC_REMOTE_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    if (udpPort && isOpen) {
      console.log('[osc] Already connected');
      resolve();
      return;
    }

    udpPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0, // Let the OS assign a port
      remoteAddress: remoteIp,
      remotePort: remotePort,
    });

    udpPort.on('ready', () => {
      isOpen = true;
      console.log(`[osc] Connected - sending to ${remoteIp}:${remotePort}`);
      resolve();
    });

    udpPort.on('error', (e: Error) => {
      console.error('[osc] Error:', e.message);
      reject(e);
    });

    udpPort.on('close', () => {
      isOpen = false;
      console.log('[osc] Connection closed');
    });

    udpPort.open();
  });
}

/**
 * Close the OSC connection
 */
export function closeOsc(): void {
  if (udpPort) {
    udpPort.close();
    udpPort = null;
    isOpen = false;
  }
}

/**
 * Check if OSC is connected
 */
export function isOscConnected(): boolean {
  return isOpen;
}

/**
 * Synth sounds that have SuperDirt SynthDefs
 * These can be routed to OSC instead of requiring Web Audio
 */
const oscSynthSounds = new Set([
  'sine', 'sawtooth', 'saw', 'square', 'triangle', 'tri',
  'white', 'pink', 'brown',
  // ZZFX chip sounds
  'zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise'
]);

/**
 * Check if a sound name is a synth that can be played via OSC
 */
export function isSynthSoundForOsc(soundName: string): boolean {
  return oscSynthSounds.has(soundName);
}

/**
 * Get the OSC UDP port for sending additional messages (e.g., sample loading)
 */
export function getOscPort(): any {
  return udpPort;
}

/**
 * Convert superdough-style gain to SuperDirt gain
 * 
 * superdough uses linear gain (default 0.8, pattern gain applied directly)
 * SuperDirt's dirt_gate applies: amp = amp * gain^4 (where amp=1 by default)
 * 
 * To match volumes, we invert SuperDirt's gain^4 curve:
 * If we want output level L, we need: gain^4 = L
 * So: gain = L^0.25
 */
function convertGainForSuperDirt(superdoughGain: number): number {
  // Invert SuperDirt's gain^4 curve: gain = targetLevel^0.25
  return Math.pow(superdoughGain, 0.25);
}

/**
 * Calculate ADSR values matching superdough's getADSRValues behavior
 * Returns [attack, decay, sustain, release] with proper defaults
 * 
 * @param attack - Attack time in seconds
 * @param decay - Decay time in seconds
 * @param sustain - Sustain level (0-1)
 * @param release - Release time in seconds
 * @param defaultValues - Default values if no params specified [attack, decay, sustain, release]
 */
function getADSRValues(
  attack?: number,
  decay?: number, 
  sustain?: number,
  release?: number,
  defaultValues: [number, number, number, number] = [0.001, 0.001, 1, 0.01]
): [number, number, number, number] {
  const envmin = 0.001;
  const releaseMin = 0.01;
  const envmax = 1;
  
  // If no params set, return defaults
  if (attack == null && decay == null && sustain == null && release == null) {
    return defaultValues;
  }
  
  // Calculate sustain level based on which params are set
  // (matching superdough's behavior)
  let sustainLevel: number;
  if (sustain != null) {
    sustainLevel = sustain;
  } else if ((attack != null && decay == null) || (attack == null && decay == null)) {
    sustainLevel = envmax;
  } else {
    sustainLevel = envmin;
  }
  
  return [
    Math.max(attack ?? 0, envmin),
    Math.max(decay ?? 0, envmin),
    Math.min(sustainLevel, envmax),
    Math.max(release ?? 0, releaseMin)
  ];
}

/**
 * Convert a hap value to SuperDirt OSC message arguments
 * Based on @strudel/osc's parseControlsFromHap
 */
function hapToOscArgs(hap: any, cps: number): any[] {
  const rawValue = hap.value || {};
  const begin = hap.wholeOrPart?.()?.begin?.valueOf?.() ?? 0;
  const duration = hap.duration?.valueOf?.() ?? 1;
  const delta = duration / cps;

  // Process the value for pitched samples (converts note/freq to n + speed)
  const processedValue = processValueForOsc(rawValue);

  // Start with processed values, then apply defaults for missing fields
  const controls: Record<string, any> = {
    ...processedValue,
    cps,
    cycle: begin,
    delta,
  };
  
  // Convert gain to match superdough volume levels
  // superdough default is 0.8, pattern can override
  // Note: soundfont gain compensation (0.3 factor) is applied later for soundfonts
  let superdoughGain = controls.gain ?? 0.8;
  controls.gain = superdoughGain; // Store raw gain, convert later after soundfont check
  
  // Ensure 'n' defaults to 0 if not specified (first sample in bank)
  if (controls.n === undefined) {
    controls.n = 0;
  }
  
  // Ensure 'speed' defaults to 1 if not specified
  if (controls.speed === undefined) {
    controls.speed = 1;
  }
  
  // Ensure 'orbit' defaults to 0 if not specified (required by SuperDirt)
  if (controls.orbit === undefined) {
    controls.orbit = 0;
  }
  
  // Set amp to 1 to match superdough's gain behavior
  // SuperDirt's default amp is 0.4 (for headroom), but superdough applies gain linearly
  // without this reduction. Setting amp=1 ensures our gain conversion produces matching levels.
  if (controls.amp === undefined) {
    controls.amp = 1;
  }

  // Handle bank prefix - maps Strudel bank aliases to full SuperDirt bank names
  // e.g., bank="tr909" + s="bd" -> s="RolandTR909_bd"
  if (controls.bank && controls.s) {
    const bankAlias = String(controls.bank);
    const sound = String(controls.s);

    // Try to resolve drum machine alias (tr909 -> RolandTR909)
    const fullBankName = resolveDrumMachineBankSync(bankAlias);

    if (!fullBankName) {
      // Unknown bank alias - warn and use sound as-is
      console.warn(`[osc] Unknown bank "${bankAlias}" - valid banks include: TR808, TR909, Linn, DMX, etc. Using sound "${sound}" without bank prefix.`);
    } else if (sound.startsWith(bankAlias + '_')) {
      // Strudel already prefixed with alias (e.g., s="tr909_sd" with bank="tr909")
      // Replace alias prefix with full bank name: tr909_sd -> RolandTR909_sd
      controls.s = fullBankName + '_' + sound.slice(bankAlias.length + 1);
    } else if (sound.startsWith(fullBankName + '_')) {
      // Already has full bank prefix (e.g., s="RolandTR909_bd" with bank="RolandTR909")
      // Keep as-is
    } else {
      // Sound doesn't have bank prefix, add it
      controls.s = `${fullBankName}_${sound}`;
    }
    delete controls.bank; // Don't send bank to SuperDirt
  }

  // Handle roomsize -> size alias
  if (controls.roomsize) {
    controls.size = controls.roomsize;
  }

  // Handle speed adjustment for unit=c
  if (controls.unit === 'c' && controls.speed != null) {
    controls.speed = controls.speed / cps;
  }
  
  // Handle tremolo parameter mapping
  // Strudel uses: tremolo (Hz) or tremolosync (cycles), tremolodepth, tremoloskew, tremolophase, tremoloshape
  // We use custom strudel* params to use our strudel_tremolo module instead of SuperDirt's dirt_tremolo
  // Our module supports: strudelTremRate, strudelTremDepth, strudelTremSkew, strudelTremPhase, strudelTremShape
  if (controls.tremolosync != null) {
    // tremolosync is in cycles, convert to Hz using cps
    controls.strudelTremRate = controls.tremolosync * cps;
    delete controls.tremolosync;
  } else if (controls.tremolo != null) {
    // tremolo is already in Hz
    controls.strudelTremRate = controls.tremolo;
    delete controls.tremolo;
  }
  
  // If tremolo is active but tremolodepth not specified, default to 1 (matching superdough)
  if (controls.strudelTremRate != null && controls.tremolodepth == null) {
    controls.strudelTremDepth = 1;
  } else if (controls.tremolodepth != null) {
    controls.strudelTremDepth = controls.tremolodepth;
    delete controls.tremolodepth;
  }
  
  // Pass through tremolo shape parameters to our custom module
  if (controls.tremoloskew != null) {
    controls.strudelTremSkew = controls.tremoloskew;
    delete controls.tremoloskew;
  } else if (controls.strudelTremRate != null) {
    // superdough default: skew = tremoloshape != null ? 0.5 : 1
    // When no shape specified, skew defaults to 1 (pure ramp-down)
    // When shape is specified, skew defaults to 0.5 (symmetric)
    controls.strudelTremSkew = (controls.tremoloshape != null) ? 0.5 : 1.0;
  }
  if (controls.tremolophase != null) {
    controls.strudelTremPhase = controls.tremolophase;
    delete controls.tremolophase;
  }
  if (controls.tremoloshape != null) {
    // superdough shape: 0=tri, 1=sine, 2=ramp, 3=saw, 4=square
    controls.strudelTremShape = controls.tremoloshape;
    delete controls.tremoloshape;
  }
  
  // Delete any remaining tremolorate that might conflict with SuperDirt's module
  if (controls.tremolorate != null) {
    delete controls.tremolorate;
  }
  
  // Handle phaser parameter mapping
  // Strudel uses: phaserrate, phaserdepth
  // SuperDirt uses the same names, so no translation needed
  

  
  // Handle synth sounds (oscillators)
  // These use our custom strudel_* SynthDefs instead of sample playback
  const synthSoundMap: Record<string, string> = {
    // Basic waveforms
    'sine': 'strudel_sine',
    'sin': 'strudel_sine',      // alias
    'sawtooth': 'strudel_sawtooth',
    'saw': 'strudel_saw',
    'square': 'strudel_square',
    'sqr': 'strudel_square',    // alias
    'triangle': 'strudel_triangle',
    'tri': 'strudel_tri',
    // Noise types
    'white': 'strudel_white',
    'pink': 'strudel_pink',
    'brown': 'strudel_brown',
    // Extended synths
    'pulse': 'strudel_pulse',   // pulse wave with PWM
    'supersaw': 'strudel_supersaw', // unison detuned saws
    'sbd': 'strudel_sbd',       // synthesized bass drum
    // ZZFX chip sounds - all use strudel_zzfx with different zshape
    'zzfx': 'strudel_zzfx',
    'z_sine': 'strudel_zzfx',
    'z_sawtooth': 'strudel_zzfx',
    'z_triangle': 'strudel_zzfx',
    'z_square': 'strudel_zzfx',
    'z_tan': 'strudel_zzfx',
    'z_noise': 'strudel_zzfx',
  };
  
  // ZZFX shape mapping: sound name -> zshape value (0-4)
  // Matches superdough's wave shapes: 0=sin, 1=tri, 2=saw, 3=tan, 4=noise
  const zzfxShapeMap: Record<string, number> = {
    'zzfx': 0,        // default to sine
    'z_sine': 0,
    'z_triangle': 1,
    'z_sawtooth': 2,
    'z_square': 2,    // ZZFX doesn't have square, use saw with shapeCurve=0
    'z_tan': 3,
    'z_noise': 4,
  };
  
  const soundName = controls.s || controls.sound;
  const synthInstrument = soundName ? synthSoundMap[soundName] : undefined;
  
  if (synthInstrument) {
    // For synth sounds, we need to tell SuperDirt to use our SynthDef
    // Setting 'instrument' explicitly tells SuperDirt which SynthDef to use
    // We also set 's' to the synth name for compatibility
    controls.s = synthInstrument;
    controls.instrument = synthInstrument;  // Explicitly set instrument
    delete controls.sound; // Remove alias if present
    
    // Synth sounds use freq instead of sample playback
    // If note is specified, convert to freq (superdough uses MIDI note numbers or note names)
    if (controls.note !== undefined && controls.freq === undefined) {
      // Convert note to MIDI number, then to frequency
      let midiNote: number;
      if (typeof controls.note === 'number') {
        midiNote = controls.note;
      } else if (typeof controls.note === 'string') {
        // Parse note name like "c4", "d#5", "eb3"
        const parsed = parseNoteName(controls.note);
        midiNote = parsed !== undefined ? parsed : 60;
      } else {
        midiNote = 60;
      }
      controls.freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    } else if (controls.freq === undefined) {
      // Default frequency depends on synth type
      if (synthInstrument === 'strudel_sbd') {
        // sbd uses MIDI note 29 (F1 ≈ 43.65 Hz) as default
        // This matches superdough's getFrequencyFromValue(value, 29)
        controls.freq = 43.65;  // F1 - superdough default for sbd
      } else {
        // Other synths use MIDI note 36 (C2 = 65.41 Hz)
        // This matches superdough's synth.mjs default: note: o = 36
        controls.freq = 65.41;  // C2 - superdough default for all synths
      }
    }
    
    // Handle ZZFX-specific parameters
    if (synthInstrument === 'strudel_zzfx') {
      // Set zshape based on sound name (0=sin, 1=tri, 2=saw, 3=tan, 4=noise)
      if (controls.zshape === undefined && soundName) {
        controls.zshape = zzfxShapeMap[soundName] ?? 0;
      }
      // For z_square, use saw (shape 2) with shapeCurve 0 to get square-ish wave
      if (soundName === 'z_square' && controls.zshapeCurve === undefined) {
        controls.zshapeCurve = 0;
      }
      
      // Map Strudel ZZFX params to our SynthDef params
      // These match the param names from superdough/zzfx.mjs
      if (controls.slide !== undefined && controls.zslide === undefined) {
        controls.zslide = controls.slide;
      }
      if (controls.deltaSlide !== undefined && controls.zdeltaSlide === undefined) {
        controls.zdeltaSlide = controls.deltaSlide;
      }
      if (controls.curve !== undefined && controls.zshapeCurve === undefined) {
        controls.zshapeCurve = controls.curve;
      }
      if (controls.pitchJump !== undefined && controls.zpitchJump === undefined) {
        controls.zpitchJump = controls.pitchJump;
      }
      if (controls.pitchJumpTime !== undefined && controls.zpitchJumpTime === undefined) {
        controls.zpitchJumpTime = controls.pitchJumpTime;
      }
      // znoise, zmod, zrand are passed through as-is (already prefixed with z)
      
      // ZZFX has 0.25 volume baked into the SynthDef, so DON'T apply the 0.3 multiplier
      // that regular synths use. Just use the raw pattern gain.
      // (The 0.25 is roughly equivalent to the 0.3 in other synths)
      controls.gain = controls.gain ?? 0.8;
    } else if (synthInstrument === 'strudel_pulse') {
      // Pulse wave synth with PWM (pulse width modulation)
      // Map superdough's pulse params to our SynthDef
      // pw = pulse width (0-1, default 0.5 = square wave)
      // pwrate = LFO rate for PWM modulation (Hz)
      // pwsweep = PWM modulation depth (how much pw oscillates)
      if (controls.pw !== undefined) controls.pw = controls.pw;
      if (controls.pwrate !== undefined) controls.pwrate = controls.pwrate;
      if (controls.pwsweep !== undefined) controls.pwsweep = controls.pwsweep;
      
      // Apply standard synth gain reduction
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    } else if (synthInstrument === 'strudel_supersaw') {
      // Supersaw synth - multiple detuned sawtooth oscillators
      // Map superdough's supersaw params to our SynthDef
      // unison = number of voices (1-16)
      // spread = stereo spread of voices (-1 to 1)
      // detune = detune amount in semitones
      if (controls.unison !== undefined) controls.unison = controls.unison;
      if (controls.spread !== undefined) controls.spread = controls.spread;
      if (controls.detune !== undefined) controls.detune = controls.detune;
      
      // Apply standard synth gain reduction
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    } else if (synthInstrument === 'strudel_sbd') {
      // Synthesized bass drum
      // sbd uses its own envelope (not strudelEnv*), so we skip ADSR handling below
      // Parameters passed through to SynthDef:
      // decay = amplitude decay time
      // pdecay = pitch envelope decay time
      // penv = pitch envelope depth in semitones (how high the pitch starts)
      // clip = saturation amount (0 = soft tanh, higher = more distortion)
      // These params are already in controls and will be passed through as-is
      
      // sbd does NOT apply the 0.3 gain reduction that regular oscillators use
      // In superdough, sbd uses gainNode(1) for mixing, not gainNode(0.3)
      controls.gain = controls.gain ?? 0.8;
    } else {
      // For other synths (sine, saw, square, triangle, noise variants)
      // Apply superdough's oscillator gain reduction (0.3) here instead of in SynthDef
      // This matches synth.mjs: const g = gainNode(0.3);
      // The gain will then go through convertGainForSuperDirt() for the gain^4 curve
      controls.gain = (controls.gain ?? 0.8) * 0.3;
    }
    
    // Common envelope handling for most synths (ZZFX, pulse, supersaw, basic oscillators)
    // sbd has its own built-in envelope and doesn't use strudelEnv* params
    if (synthInstrument !== 'strudel_sbd') {
      // Calculate ADSR values matching superdough's getADSRValues behavior
      // This ensures sustainLevel is set correctly based on which params are specified
      // IMPORTANT: Check rawValue.sustain BEFORE we overwrite controls.sustain with delta
      // 
      // Synth defaults from superdough/synth.mjs line 44-48:
      //   [0.001, 0.05, 0.6, 0.01] = [attack, decay, sustain, release]
      // This means synths have a quick attack, 50ms decay to 60% sustain level
      const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
      const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
        controls.attack,
        controls.decay,
        patternSustainLevel,  // sustain LEVEL from pattern (0-1), not duration
        controls.release,
        [0.001, 0.05, 0.6, 0.01]  // synth defaults from superdough
      );
      
      // Calculate hold time: duration - attack - decay (release extends past)
      const holdTime = Math.max(0.001, delta - envAttack - envDecay);
      
      // Use our custom strudelEnv* params to avoid triggering SuperDirt's dirt_envelope
      // This gives us consistent ADSR behavior for both synths and samples
      controls.strudelEnvAttack = envAttack;
      controls.strudelEnvDecay = envDecay;
      controls.strudelEnvSustainLevel = envSustainLevel;
      controls.strudelEnvRelease = envRelease;
      controls.strudelEnvHold = holdTime;
      
      // Now set sustain to note duration (for SynthDef timing)
      // This controls how long the synth runs before doneAction frees it
      controls.sustain = delta;
      
      // Delete standard envelope params to prevent SuperDirt's dirt_envelope from triggering
      delete controls.attack;
      delete controls.decay;
      delete controls.release;
    } else {
      // sbd uses its own decay param for amplitude envelope
      // Just set sustain for SynthDef timing
      controls.sustain = delta;
      // Keep decay, pdecay, penv, clip - they're used by the sbd SynthDef
    }
    
    // Delete note since we've converted to freq
    delete controls.note;
    delete controls.n; // Synths don't use sample index
  }
  
  // Handle soundfont instruments
  // Soundfonts need looping + ADSR envelope, so we use our custom strudel_soundfont synth
  // Regular samples use the default dirt_sample synth (no looping)
  const bankName = controls.s || controls.sound;
  // Check if it's a soundfont: either registered as such OR starts with 'gm_' (GM soundfonts)
  const isSoundfont = bankName && (isBankSoundfont(bankName) || bankName.startsWith('gm_'));
  if (isSoundfont) {
    // Use our custom soundfont synth that loops and applies ADSR
    // Soundfont samples are stereo (converted by ffmpeg with -ac 2)
    controls.instrument = 'strudel_soundfont_2_2';
    
    // Use custom parameter names (sfAttack, sfRelease, sfSustain) to avoid
    // SuperDirt's internal parameter handling which overrides standard names
    if (controls.sfAttack == null) controls.sfAttack = controls.attack ?? 0.01;
    if (controls.sfRelease == null) controls.sfRelease = controls.release ?? 0.1;
    // sfSustain controls how long the note plays (use note duration from pattern)
    // Note: Strudel's 'sustain' param is the sustain LEVEL (0-1), not duration!
    // We always use delta (note duration) for sfSustain
    if (controls.sfSustain == null) controls.sfSustain = delta;
    
    // IMPORTANT: Delete standard envelope params so SuperDirt's core modules
    // don't apply their own envelope on top of our custom SynthDef's envelope.
    // Without this, sustain=0 (sustain LEVEL) causes SuperDirt to mute the sound.
    delete controls.attack;
    delete controls.decay;
    delete controls.sustain;
    delete controls.release;
    
    // speed is critical - without it SuperDirt passes invalid value and synth is silent
    if (controls.speed == null) controls.speed = 1;
    
    // Match superdough's soundfont gain compensation
    // In superdough, samples use getParamADSR with max gain 1.0 (sampler.mjs:315)
    // while soundfonts use max gain 0.3 (fontloader.mjs:163)
    // This compensates for soundfont samples being normalized louder than Dirt-Samples
    // Apply BEFORE converting to SuperDirt gain curve
    controls.gain = controls.gain * 0.3;
  } else if (!synthInstrument) {
    // Regular samples (not synths, not soundfonts)
    // If attack/release are specified, use our strudel_adsr module instead of dirt_envelope
    // This gives us consistent linear ADSR behavior matching superdough
    if (rawValue.attack !== undefined || rawValue.release !== undefined || 
        rawValue.decay !== undefined || rawValue.sustain !== undefined) {
      // Calculate ADSR values matching superdough's getADSRValues behavior
      const patternSustainLevel = typeof rawValue.sustain === 'number' ? rawValue.sustain : undefined;
      const [envAttack, envDecay, envSustainLevel, envRelease] = getADSRValues(
        controls.attack,
        controls.decay,
        patternSustainLevel,
        controls.release
      );
      
      // Calculate hold time: duration - attack - decay (release extends past)
      const holdTime = Math.max(0.001, delta - envAttack - envDecay);
      
      // Use our custom strudelEnv* params to trigger strudel_adsr module
      controls.strudelEnvAttack = envAttack;
      controls.strudelEnvDecay = envDecay;
      controls.strudelEnvSustainLevel = envSustainLevel;
      controls.strudelEnvRelease = envRelease;
      controls.strudelEnvHold = holdTime;
      
      // Delete standard envelope params to prevent dirt_envelope from triggering
      delete controls.attack;
      delete controls.decay;
      delete controls.sustain;
      delete controls.release;
    }
  }
  
  // Pan compensation for SuperDirt's equal-power panning
  // 
  // SuperDirt always applies DirtPan using Pan2, which uses equal-power panning.
  // At center (pan=0.5), Pan2 reduces each channel by sqrt(0.5) ≈ 0.707 (-3dB)
  // to maintain constant power when summed.
  //
  // superdough/WebAudio only applies a StereoPannerNode when pan is explicitly set.
  // When pan is not specified, no panner is added and the signal passes through unchanged.
  //
  // This means:
  // - No pan specified: superdough = full level, SuperDirt = -3dB → we need to boost by sqrt(2)
  // - Pan specified: both use equal-power panning → levels match
  //
  // The compensation factor is sqrt(2) ≈ 1.414 for the center position.
  // For other pan positions, the compensation gradually decreases to 1.0 at hard left/right.
  //
  // NOTE: ZZFX synths are excluded from pan compensation because their gain staging
  // is already calibrated differently (0.25 baked in vs 0.3 for regular synths).
  // Empirically, ZZFX without pan compensation matches better.
  const isZZFX = synthSoundMap[soundName]?.includes('zzfx');
  if (rawValue.pan === undefined && !isZZFX) {
    // No pan specified - SuperDirt will center with -3dB, compensate with sqrt(2)
    controls.gain = controls.gain * Math.SQRT2;
  }
  
  // Convert filter parameters to strudel* prefixed names
  // This avoids triggering SuperDirt's built-in dirt_lpf/dirt_hpf modules, which
  // would apply ADDITIONAL filtering on top of our strudel_filter module.
  // Using strudel* params ensures only our module handles filtering (consistent 12 dB/oct slope).
  // This applies to all sounds: synths, samples, and soundfonts.
  if (controls.cutoff !== undefined) {
    controls.strudelLpf = controls.cutoff;
    delete controls.cutoff;
  }
  if (controls.hcutoff !== undefined) {
    controls.strudelHpf = controls.hcutoff;
    delete controls.hcutoff;
  }
  if (controls.resonance !== undefined) {
    controls.strudelLpq = controls.resonance;
    delete controls.resonance;
  }
  if (controls.hresonance !== undefined) {
    controls.strudelHpq = controls.hresonance;
    delete controls.hresonance;
  }
  // Also handle lpf/hpf aliases that superdough uses
  if (controls.lpf !== undefined && controls.strudelLpf === undefined) {
    controls.strudelLpf = controls.lpf;
    delete controls.lpf;
  }
  if (controls.hpf !== undefined && controls.strudelHpf === undefined) {
    controls.strudelHpf = controls.hpf;
    delete controls.hpf;
  }
  if (controls.lpq !== undefined && controls.strudelLpq === undefined) {
    controls.strudelLpq = controls.lpq;
    delete controls.lpq;
  }
  if (controls.hpq !== undefined && controls.strudelHpq === undefined) {
    controls.strudelHpq = controls.hpq;
    delete controls.hpq;
  }
  
  // Handle bandpass filter - redirect to our strudel_filter module
  // bandf/bandq are Strudel's BPF parameters
  if (controls.bandf !== undefined && controls.strudelBpf === undefined) {
    controls.strudelBpf = controls.bandf;
    delete controls.bandf;
  }
  if (controls.bandq !== undefined && controls.strudelBpq === undefined) {
    controls.strudelBpq = controls.bandq;
    delete controls.bandq;
  }
  if (controls.bpf !== undefined && controls.strudelBpf === undefined) {
    controls.strudelBpf = controls.bpf;
    delete controls.bpf;
  }
  if (controls.bpq !== undefined && controls.strudelBpq === undefined) {
    controls.strudelBpq = controls.bpq;
    delete controls.bpq;
  }
  
  // Handle filter envelope parameters for lowpass filter
  // superdough uses: lpenv (amount in octaves), lpattack, lpdecay, lpsustain, lprelease, fanchor
  if (controls.lpenv !== undefined) {
    controls.strudelLpEnv = controls.lpenv;
    delete controls.lpenv;
  }
  if (controls.lpattack !== undefined) {
    controls.strudelLpAttack = controls.lpattack;
    delete controls.lpattack;
  }
  if (controls.lpdecay !== undefined) {
    controls.strudelLpDecay = controls.lpdecay;
    delete controls.lpdecay;
  }
  if (controls.lpsustain !== undefined) {
    controls.strudelLpSustain = controls.lpsustain;
    delete controls.lpsustain;
  }
  if (controls.lprelease !== undefined) {
    controls.strudelLpRelease = controls.lprelease;
    delete controls.lprelease;
  }
  
  // Handle filter envelope parameters for highpass filter
  // superdough uses: hpenv (amount in octaves), hpattack, hpdecay, hpsustain, hprelease
  if (controls.hpenv !== undefined) {
    controls.strudelHpEnv = controls.hpenv;
    delete controls.hpenv;
  }
  if (controls.hpattack !== undefined) {
    controls.strudelHpAttack = controls.hpattack;
    delete controls.hpattack;
  }
  if (controls.hpdecay !== undefined) {
    controls.strudelHpDecay = controls.hpdecay;
    delete controls.hpdecay;
  }
  if (controls.hpsustain !== undefined) {
    controls.strudelHpSustain = controls.hpsustain;
    delete controls.hpsustain;
  }
  if (controls.hprelease !== undefined) {
    controls.strudelHpRelease = controls.hprelease;
    delete controls.hprelease;
  }
  
  // Handle filter envelope parameters for bandpass filter
  // superdough uses: bpenv (amount in octaves), bpattack, bpdecay, bpsustain, bprelease
  if (controls.bpenv !== undefined) {
    controls.strudelBpEnv = controls.bpenv;
    delete controls.bpenv;
  }
  if (controls.bpattack !== undefined) {
    controls.strudelBpAttack = controls.bpattack;
    delete controls.bpattack;
  }
  if (controls.bpdecay !== undefined) {
    controls.strudelBpDecay = controls.bpdecay;
    delete controls.bpdecay;
  }
  if (controls.bpsustain !== undefined) {
    controls.strudelBpSustain = controls.bpsustain;
    delete controls.bpsustain;
  }
  if (controls.bprelease !== undefined) {
    controls.strudelBpRelease = controls.bprelease;
    delete controls.bprelease;
  }
  
  // Filter anchor point (0-1, where envelope pivots around cutoff frequency)
  if (controls.fanchor !== undefined) {
    controls.strudelFanchor = controls.fanchor;
    delete controls.fanchor;
  }
  
  // Filter type: '12db' (default) or '24db' (cascade two filters for steeper slope)
  // superdough also supports 'ladder' but that requires a different filter model
  if (controls.ftype !== undefined) {
    if (controls.ftype === '24db') {
      controls.strudelFtype = 1;  // 24dB mode - cascade filters
    } else {
      controls.strudelFtype = 0;  // 12dB mode (default)
    }
    delete controls.ftype;
  }
  
  // DJF (DJ Filter) - crossfades between lowpass and highpass
  // djf < 0.5 = lowpass, djf > 0.5 = highpass, djf = 0.5 = neutral
  // We pass this directly to the filter module as strudelDjf
  if (controls.djf !== undefined) {
    controls.strudelDjf = controls.djf;
    delete controls.djf;
  }
  
  // Convert gain to SuperDirt's gain curve (applies to all synth sounds)
  controls.gain = convertGainForSuperDirt(controls.gain);

  // Flatten to array of [key, value, key, value, ...]
  const args: any[] = [];
  for (const [key, val] of Object.entries(controls)) {
    if (val !== undefined && val !== null) {
      args.push({ type: 's', value: key });

      // Determine OSC type
      if (typeof val === 'number') {
        args.push({ type: 'f', value: val });
      } else if (typeof val === 'string') {
        args.push({ type: 's', value: val });
      } else {
        args.push({ type: 's', value: String(val) });
      }
    }
  }

  return args;
}

/**
 * Send a hap (event) to SuperDirt via OSC with proper timing
 * @param hap The hap (event) from Strudel
 * @param targetTime The target time in AudioContext seconds when this should play
 * @param cps Cycles per second (tempo)
 */
let oscDebug = false; // Set to true for debugging

export function setOscDebug(enabled: boolean): void {
  oscDebug = enabled;
}

export function sendHapToSuperDirt(hap: any, targetTime: number, cps: number): void {
  if (oscDebug) {
    console.log(`[osc] sendHapToSuperDirt called, hap.value:`, JSON.stringify(hap.value));
  }
  
  try {
    const args = hapToOscArgs(hap, cps);
    
    // Capture OSC message for file output if recording is enabled
    // This happens regardless of whether real-time OSC is connected
    if (shouldCaptureOsc()) {
      captureOscMessage(targetTime, '/dirt/play', args);
    }
    
    // Skip real-time sending if OSC not connected
    if (!udpPort || !isOpen) {
      return;
    }
    
    // Convert AudioContext time to Unix time for OSC timetag
    const unixTargetTime = audioTimeToUnixTime(targetTime);
    
    // Create OSC timetag (seconds offset from now)
    // osc.timeTag(n) creates a timetag n seconds from now
    const now = Date.now() / 1000;
    const secondsFromNow = unixTargetTime - now;
    
    // Build argsObj for routing and debug logging
    const argsObj: Record<string, any> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i]?.value && args[i+1]) {
        argsObj[args[i].value] = args[i+1].value;
      }
    }
    
    if (oscDebug) {
      // Just dump key args
      const speedStr = argsObj.speed?.toFixed?.(4) || argsObj.speed;
      const noteStr = argsObj.note !== undefined ? ` note=${argsObj.note}` : '';
      const freqStr = argsObj.freq !== undefined ? ` freq=${argsObj.freq?.toFixed?.(1)}` : '';
      const sustainStr = argsObj.sustain !== undefined ? ` sustain=${argsObj.sustain?.toFixed?.(3)}` : '';
      const tremStr = argsObj.tremolorate !== undefined ? ` tremolorate=${argsObj.tremolorate?.toFixed?.(2)} tremolodepth=${argsObj.tremolodepth}` : '';
      // Show our strudel ADSR params (strudelEnv*) instead of old attack/decay/release
      const strudelEnvStr = argsObj.strudelEnvAttack !== undefined ? 
        ` env(A=${argsObj.strudelEnvAttack?.toFixed?.(3)} D=${argsObj.strudelEnvDecay?.toFixed?.(3)} S=${argsObj.strudelEnvSustainLevel?.toFixed?.(2)} R=${argsObj.strudelEnvRelease?.toFixed?.(3)} H=${argsObj.strudelEnvHold?.toFixed?.(3)})` : '';
      const sfEnvStr = argsObj.sfSustain !== undefined ? ` sfAttack=${argsObj.sfAttack?.toFixed?.(3)} sfRelease=${argsObj.sfRelease?.toFixed?.(3)} sfSustain=${argsObj.sfSustain?.toFixed?.(3)}` : '';
      const instrStr = argsObj.instrument ? ` instrument=${argsObj.instrument}` : '';
      const orbitStr = argsObj.orbit !== undefined ? ` orbit=${argsObj.orbit}` : ' orbit=MISSING';
      // Show strudel filter params (strudelLpf/Hpf) instead of old cutoff/hcutoff
      const lpfStr = argsObj.strudelLpf !== undefined ? ` lpf=${argsObj.strudelLpf?.toFixed?.(0)}` : '';
      const hpfStr = argsObj.strudelHpf !== undefined ? ` hpf=${argsObj.strudelHpf?.toFixed?.(0)}` : '';
      const lpqStr = argsObj.strudelLpq !== undefined ? ` lpq=${argsObj.strudelLpq?.toFixed?.(2)}` : '';
      const hpqStr = argsObj.strudelHpq !== undefined ? ` hpq=${argsObj.strudelHpq?.toFixed?.(2)}` : '';
      const shapeStr = argsObj.shape !== undefined ? ` shape=${argsObj.shape?.toFixed?.(2)}` : '';
      const zshapeStr = argsObj.zshape !== undefined ? ` zshape=${argsObj.zshape}` : '';
      const zgainStr = argsObj.zgain !== undefined ? ` zgain=${argsObj.zgain?.toFixed?.(2)}` : '';
      const sustainLevelStr = argsObj.sustainLevel !== undefined ? ` sustainLevel=${argsObj.sustainLevel?.toFixed?.(2)}` : '';
      const ampStr = argsObj.amp !== undefined ? ` amp=${argsObj.amp?.toFixed?.(2)}` : '';
      // Show filter envelope params if present
      const lpEnvStr = argsObj.strudelLpEnv !== undefined ? ` lpenv=${argsObj.strudelLpEnv} lpdecay=${argsObj.strudelLpDecay?.toFixed?.(2)}` : '';
      const hpEnvStr = argsObj.strudelHpEnv !== undefined ? ` hpenv=${argsObj.strudelHpEnv}` : '';
      console.log(`[osc] SEND: s=${argsObj.s} n=${argsObj.n}${orbitStr} speed=${speedStr}${freqStr}${sustainStr}${sustainLevelStr}${noteStr}${lpfStr}${lpEnvStr}${lpqStr}${hpfStr}${hpEnvStr}${hpqStr}${shapeStr}${zshapeStr}${zgainStr}${tremStr}${strudelEnvStr}${sfEnvStr}${instrStr} gain=${argsObj.gain?.toFixed?.(2)}${ampStr} t+${secondsFromNow.toFixed(3)}s`);
      
      // Debug: print all OSC args to verify strudelEnv* params are sent
      if (argsObj.strudelEnvSustainLevel !== undefined) {
        console.log(`[osc] Full OSC args for synth:`);
        for (let i = 0; i < args.length; i += 2) {
          console.log(`  ${args[i].value}=${args[i+1].value}`);
        }
      }
    }
    
    // Send as OSC bundle with timetag for precise scheduling
    // SuperDirt will schedule the sound to play at the specified time
    // ALL sounds (synths and samples) go through /dirt/play to use our strudel_adsr module
    const bundle = {
      timeTag: osc.timeTag(secondsFromNow),
      packets: [{
        address: '/dirt/play',
        args,
      }]
    };

    udpPort.send(bundle);
  } catch (err) {
    console.error('[osc] Error sending hap:', err);
  }
}

/**
 * Send a simple test sound to verify connection
 */
export function sendTestSound(): void {
  if (!udpPort || !isOpen) {
    console.error('[osc] Not connected');
    return;
  }

  const args = [
    { type: 's', value: 's' },
    { type: 's', value: 'bd' },
    { type: 's', value: 'cps' },
    { type: 'f', value: 1 },
    { type: 's', value: 'delta' },
    { type: 'f', value: 1 },
    { type: 's', value: 'cycle' },
    { type: 'f', value: 0 },
  ];

  udpPort.send({
    address: '/dirt/play',
    args,
  });
  
  console.log('[osc] Test sound sent (bd)');
}
