/**
 * SuperDirt Launcher - Manages SuperCollider/SuperDirt lifecycle
 * 
 * This module handles:
 * - Detecting if sclang (SuperCollider) is installed
 * - Installing SuperDirt quark if needed
 * - Starting SuperDirt with proper settings
 * - Managing the sclang process lifecycle
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { platform, homedir } from 'os';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Strudel samples cache directory - matches sample-manager.ts
const STRUDEL_SAMPLES_DIR = join(homedir(), '.local', 'share', 'strudel-samples');

// Note: The startup script is generated dynamically by generateStartupScript()
// to allow customization of port, channels, and orbits

export interface SuperDirtLauncherOptions {
  /** Port for SuperDirt to listen on (default: 57120) */
  port?: number;
  /** Number of audio channels (default: 2) */
  channels?: number;
  /** Number of orbits (default: 12) */
  orbits?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Timeout for startup in milliseconds (default: 30000) */
  startupTimeout?: number;
}

export class SuperDirtLauncher {
  private sclangProcess: ChildProcess | null = null;
  private sclangPid: number | null = null;
  private isRunning = false;
  private options: Required<SuperDirtLauncherOptions>;
  private tempScriptPath: string | null = null;
  private weStartedJack = false;

  constructor(options: SuperDirtLauncherOptions = {}) {
    this.options = {
      port: options.port ?? 57120,
      channels: options.channels ?? 2,
      orbits: options.orbits ?? 12,
      verbose: options.verbose ?? false,
      startupTimeout: options.startupTimeout ?? 30000,
    };
  }

  /**
   * Check if sclang (SuperCollider) is available on the system
   */
  static isSclangAvailable(): boolean {
    try {
      execSync('which sclang', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if SuperDirt quark is installed
   */
  static isSuperDirtInstalled(): boolean {
    const home = process.env.HOME || '';
    const quarksPath = join(home, '.local', 'share', 'SuperCollider', 'downloaded-quarks', 'SuperDirt');
    return existsSync(quarksPath);
  }

  /**
   * Install SuperDirt quark (blocking operation)
   * Returns true if successful, false otherwise
   */
  static installSuperDirt(): boolean {
    console.log('[superdirt] Installing SuperDirt quark...');
    try {
      // This can take a while as it downloads from GitHub
      execSync('echo \'Quarks.install("SuperDirt"); 0.exit;\' | sclang', {
        stdio: 'inherit',
        timeout: 120000, // 2 minute timeout
      });
      console.log('[superdirt] SuperDirt quark installed successfully');
      return true;
    } catch (err) {
      console.error('[superdirt] Failed to install SuperDirt:', err);
      return false;
    }
  }

  /**
   * Generate the startup script with current options
   * Includes Strudel sample loading handler for dynamic sample loading
   * and custom SynthDefs for ADSR envelope support
   */
  private generateStartupScript(): string {
    const { port, channels, orbits } = this.options;
    
    // Escape the path for SuperCollider string
    const escapedSamplesDir = STRUDEL_SAMPLES_DIR.replace(/\\/g, '\\\\');
    
    return `(
// Kill any existing servers to ensure clean state
// This is important because server options must be set BEFORE boot
Server.killAll;

// Optimized server settings for heavy sample usage
// MUST be set before boot, otherwise defaults are used
s.options.numBuffers = 1024 * 256;  // 262144 buffers for samples
s.options.memSize = 8192 * 32;      // 256MB memory
s.options.numWireBufs = 128;        // More interconnect buffers
s.options.maxNodes = 1024 * 32;     // 32768 nodes

"Server options configured, booting server...".postln;

s.waitForBoot {
    "*** SuperCollider server booted ***".postln;
    
    // Increase latency to avoid "late" messages
    s.latency = 0.3;
    
    ~dirt = SuperDirt(${channels}, s);
    ~dirt.loadSoundFiles;
    
    // Load Strudel samples cache if it exists
    ~strudelSamplesPath = "${escapedSamplesDir}";
    if(File.exists(~strudelSamplesPath), {
        "Loading Strudel samples from: %".format(~strudelSamplesPath).postln;
        ~dirt.loadSoundFiles(~strudelSamplesPath +/+ "*");
    }, {
        "Strudel samples cache not found (will be created when samples are loaded)".postln;
    });
    
    s.sync;
    ~dirt.start(${port}, 0 ! ${orbits});
    
    // ========================================
    // Strudel Soundfont SynthDefs
    // These loop samples and apply ADSR envelope - used for soundfont instruments
    // Regular samples use the default dirt_sample SynthDefs (no looping)
    // ========================================
    
    (1..SuperDirt.maxSampleNumChannels).do { |sampleNumChannels|
      var name = format("strudel_soundfont_%_%", sampleNumChannels, ${channels});
      
      // Soundfont synth: loops sample with ADSR envelope
      // NOTE: We use custom parameter names (sfAttack, sfRelease, sfSustain) to avoid
      // SuperDirt's internal parameter handling which overrides standard names
      SynthDef(name, { |out, bufnum, sustain = 1, begin = 0, end = 1, speed = 1, endSpeed = 1, 
                        freq = 440, pan = 0, sfAttack = 0.01, sfRelease = 0.1, sfSustain = 1|
        var sound, rate, phase, numFrames, env, holdTime, phasorRate;
        
        numFrames = max(BufFrames.ir(bufnum), 1);
        
        // Use speed directly - it's already pitch-adjusted
        rate = Line.kr(speed, endSpeed, sfSustain);
        
        // Phasor rate: samples to advance per audio sample
        phasorRate = rate * BufRateScale.ir(bufnum);
        
        // Loop through sample using Phasor
        phase = Phasor.ar(0, phasorRate, begin * numFrames, end * numFrames, begin * numFrames);
        
        sound = BufRd.ar(
          numChannels: sampleNumChannels,
          bufnum: bufnum,
          phase: phase,
          loop: 1,
          interpolation: 4
        );
        
        // ADSR envelope using our custom params
        holdTime = max(0.001, sfSustain - sfAttack - sfRelease);
        env = EnvGen.kr(
          Env.linen(sfAttack, holdTime, sfRelease, 1, \\sin),
          doneAction: 2
        );
        
        sound = sound * env;
        sound = DirtPan.ar(sound, ${channels}, pan);
        
        Out.ar(out, sound)
      }, [\\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr, \\ir, \\ir, \\ir]).add;
      
      ("Strudel: Added " ++ name).postln;
    };
    
    s.sync;  // Ensure soundfont SynthDefs are registered with server
    "*** Strudel soundfont SynthDefs loaded ***".postln;
    
    // ========================================
    // Oscillator Synths (sine, sawtooth, square, triangle, noise)
    // These match superdough's basic waveform synths for OSC-only operation
    // ========================================
    
    // Sine wave oscillator (pure tone)
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // 'sustain' param is the note duration (set by osc-output.ts)
    // Line.kr with doneAction:2 frees the synth after sustain time
    // Filtering is handled by the strudel_filter module (not in individual synths)
    // Vibrato: vib = LFO rate in Hz, vibmod = depth in semitones (default 0.5)
    // Pitch envelope: penv = depth in semitones, pattack/pdecay/psustain/prelease = ADSR
    //                 panchor = pivot point (0-1, default = psustain)
    SynthDef(\\strudel_sine, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                               vib = 0, vibmod = 0.5,
                               penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      // Pitch envelope: modulates pitch in semitones with ADSR
      // panchor = -1 means use psustain as anchor (superdough default)
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      // Map envelope (0-1) to semitones: min = -penv*anchor, max = penv*(1-anchor)
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      
      // Vibrato: sinusoidal pitch modulation
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      
      // Combine: base freq * 2^((pitchEnv + vibrato) / 12)
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = SinOsc.ar(modFreq);
      // Free synth after sustain time (envelope applied by strudel_adsr module)
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_sine".postln;
    
    // Sawtooth wave oscillator
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // RMS compensation: SC's Saw.ar has lower RMS than Web Audio's normalized sawtooth
    // due to band-limiting. Factor of 2.0 matches RMS levels between the two backends.
    // Vibrato + Pitch envelope support
    SynthDef(\\strudel_sawtooth, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   vib = 0, vibmod = 0.5,
                                   penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = Saw.ar(modFreq) * 2.0;  // RMS compensation for band-limited Saw
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_sawtooth".postln;
    
    // Alias for sawtooth (superdough uses 'saw')
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    SynthDef(\\strudel_saw, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              vib = 0, vibmod = 0.5,
                              penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = Saw.ar(modFreq) * 2.0;  // RMS compensation for band-limited Saw
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_saw".postln;
    
    // Square wave oscillator
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // RMS compensation: SC's Pulse.ar has lower RMS than Web Audio's normalized square
    // Vibrato + Pitch envelope support
    SynthDef(\\strudel_square, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                 vib = 0, vibmod = 0.5,
                                 penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = Pulse.ar(modFreq, 0.5) * 1.9;  // RMS compensation for band-limited Pulse
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_square".postln;
    
    // Triangle wave oscillator
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // Vibrato + Pitch envelope support
    SynthDef(\\strudel_triangle, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   vib = 0, vibmod = 0.5,
                                   penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = LFTri.ar(modFreq);
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_triangle".postln;
    
    // Alias for triangle (superdough uses 'tri')
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    SynthDef(\\strudel_tri, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                              vib = 0, vibmod = 0.5,
                              penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      sound = LFTri.ar(modFreq);
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_tri".postln;
    
    // White noise generator
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    SynthDef(\\strudel_white, { |out, freq = 440, sustain = 1, pan = 0, speed = 1|
      var sound;
      sound = WhiteNoise.ar;
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_white".postln;
    
    // Pink noise generator - Paul Kellet algorithm to match superdough
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // Superdough uses 6 IIR filters + delayed sample, summed and scaled by 0.11
    SynthDef(\\strudel_pink, { |out, freq = 440, sustain = 1, pan = 0, speed = 1|
      var sound, white;
      var b0, b1, b2, b3, b4, b5, b6;
      // Paul Kellet pink noise filter (matches superdough exactly)
      // FOS.ar(in, a0, a1, b1): y[n] = a0*x[n] + a1*x[n-1] + b1*y[n-1]
      white = WhiteNoise.ar;
      b0 = FOS.ar(white, 0.0555179, 0, 0.99886);
      b1 = FOS.ar(white, 0.0750759, 0, 0.99332);
      b2 = FOS.ar(white, 0.153852, 0, 0.969);
      b3 = FOS.ar(white, 0.3104856, 0, 0.8665);
      b4 = FOS.ar(white, 0.5329522, 0, 0.55);
      b5 = FOS.ar(white, -0.016898, 0, -0.7616);
      b6 = Delay1.ar(white * 0.115926);  // b6 = previous white sample
      sound = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + (white * 0.5362)) * 0.11;
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_pink".postln;
    
    // Brown noise generator - matches superdough algorithm exactly
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // Superdough: c[m] = (a + 0.02 * b) / 1.02, a = c[m]
    // This is: y[n] = (1/1.02) * y[n-1] + (0.02/1.02) * x[n]
    //        = 0.9804 * y[n-1] + 0.0196 * x[n]
    // Use FOS.ar(in, a0, a1, b1): y[n] = a0*x[n] + a1*x[n-1] + b1*y[n-1]
    SynthDef(\\strudel_brown, { |out, freq = 440, sustain = 1, pan = 0, speed = 1|
      var sound;
      // Superdough brown noise: y[n] = 0.9804 * y[n-1] + 0.0196 * x[n]
      sound = FOS.ar(WhiteNoise.ar, 0.0196, 0, 0.9804);
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_brown".postln;
    
    s.sync;  // Ensure oscillator SynthDefs are registered with server
    "*** Strudel oscillator SynthDefs loaded ***".postln;
    
    // ========================================
    // ZZFX Chip Sound Synth
    // Exact port of ZzFX algorithm from zzfx_fork.mjs
    // https://github.com/KilledByAPixel/ZzFX
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // ========================================
    
    SynthDef(\\strudel_zzfx, { |out, freq = 220, sustain = 1, pan = 0, speed = 1,
                               zshape = 0, zshapeCurve = 1, zslide = 0, zdeltaSlide = 0,
                               zrand = 0, znoise = 0, zmod = 0,
                               zpitchJump = 0, zpitchJumpTime = 0|
      var sound;
      var pi2, sampleRate;
      var freqRadians, slide, deltaSlide, modulation, noise;
      var phase, freqAccum, slideAccum, modPhase, f;
      var waveSin, waveTri, waveSaw, waveTan, waveNoise;
      var sampleIndex;
      
      pi2 = 2pi;
      sampleRate = SampleRate.ir;
      
      // Convert frequency to radians/sample (like ZZFX line 32)
      freqRadians = freq * (1 + (zrand * 2 * Rand(-1, 1))) * pi2 / sampleRate;
      
      // Scale slide params (like ZZFX lines 31, 50)
      slide = zslide * (500 * pi2) / (sampleRate * sampleRate);
      deltaSlide = zdeltaSlide * (500 * pi2) / (sampleRate ** 3);
      
      // modulation *= PI2 / sampleRate
      modulation = zmod * pi2 / sampleRate;
      
      // noise param (for phase jitter)
      noise = znoise;
      
      // Phase accumulator using Integrator for cumulative slide
      slideAccum = Integrator.ar(K2A.ar(deltaSlide), 1) + slide;
      freqAccum = Integrator.ar(slideAccum, 1) + freqRadians;
      
      // Modulation: f = frequency * cos(modulation * tm++)
      modPhase = Phasor.ar(0, modulation, 0, inf);
      f = freqAccum * cos(modPhase);
      
      // Phase with noise jitter
      sampleIndex = Phasor.ar(0, 1, 0, inf);
      phase = Integrator.ar(
        f * (1 - (noise * (1 - (((sin(sampleIndex) + 1) * 1e9) % 2)))),
        1
      );
      
      // ZZFX waveform formulas
      waveSin = sin(phase);
      waveTri = 1 - (4 * abs((phase / pi2).round(1) - (phase / pi2)));
      waveSaw = 1 - (((((2 * phase / pi2) % 2) + 2) % 2));
      waveTan = tan(phase).clip(-1, 1);
      waveNoise = sin(((phase % pi2) ** 3));
      
      // Select waveform based on zshape
      sound = Select.ar(zshape.clip(0, 4), [
        waveSin, waveTri, waveSaw, waveTan, waveNoise
      ]);
      
      // Apply shape curve
      sound = sound.sign * (sound.abs ** zshapeCurve.max(0.01));
      
      // Apply ZZFX base volume (0.25)
      sound = sound * 0.25;
      
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_zzfx".postln;
    
    s.sync;  // Ensure ZZFX SynthDef is registered with server
    "*** Strudel ZZFX SynthDef loaded ***".postln;
    
    // ========================================
    // Pulse Wave Synth with PWM (pulse width modulation)
    // Matches superdough's pulse synth with pw, pwrate, pwsweep params
    // NO internal envelope - the strudel_adsr module applies ADSR to all sounds
    // ========================================
    
    SynthDef(\\strudel_pulse, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                pw = 0.5, pwrate = 1, pwsweep = 0, vib = 0, vibmod = 0.5,
                                penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, width, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      // Pitch envelope: modulates pitch in semitones with ADSR
      // panchor = -1 means use psustain as anchor (superdough default)
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      // Map envelope (0-1) to semitones: min = -penv*anchor, max = penv*(1-anchor)
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      
      // Vibrato: sinusoidal pitch modulation
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      
      // Combine: base freq * 2^((pitchEnv + vibrato) / 12)
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      // Pulse width modulation: pw oscillates around the base pw value
      width = pw + (SinOsc.kr(pwrate) * pwsweep);
      width = width.clip(0.01, 0.99);  // Prevent aliasing at extremes
      
      // Gain of 0.7 tuned to match browser superdough output level
      sound = Pulse.ar(modFreq, width) * 0.7;
      
      Line.kr(0, 0, sustain, doneAction: 2);
      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }).add;
    "Added: strudel_pulse".postln;
    
    // ========================================
    // Supersaw Synth - Multiple detuned sawtooth oscillators
    // Matches superdough's supersaw with unison, spread, detune params
    // Uses strudelEnv* params for ADSR envelope
    // Filtering is handled by the strudel_filter module (not in individual synths)
    // ========================================
    
    SynthDef(\\strudel_supersaw, { |out, freq = 440, sustain = 1, pan = 0, speed = 1,
                                   unison = 5, spread = 0.6, detune = 0.18, vib = 0, vibmod = 0.5,
                                   penv = 0, pattack = 0.001, pdecay = 0.001, psustain = 1, prelease = 0.001, panchor = -1|
      var sound, voices, freqs, pans, gainAdjust, modFreq, vibMod, pitchEnvMod, pitchEnv, penvAnchor;
      
      // Pitch envelope: modulates pitch in semitones with ADSR
      // panchor = -1 means use psustain as anchor (superdough default)
      penvAnchor = Select.kr(panchor < 0, [panchor, psustain]);
      pitchEnv = EnvGen.kr(
        Env.adsr(pattack, pdecay, psustain, prelease, curve: -4),
        gate: 1, doneAction: 0
      );
      // Map envelope (0-1) to semitones: min = -penv*anchor, max = penv*(1-anchor)
      pitchEnvMod = Select.kr(penv.abs > 0.001, [
        0,
        pitchEnv.linlin(0, 1, penv.neg * penvAnchor, penv * (1 - penvAnchor))
      ]);
      
      // Vibrato: sinusoidal pitch modulation
      vibMod = Select.kr(vib > 0, [0, vibmod * SinOsc.kr(vib)]);
      
      // Combine: base freq * 2^((pitchEnv + vibrato) / 12)
      modFreq = freq * speed * (2 ** ((pitchEnvMod + vibMod) / 12));
      
      // Clamp unison to reasonable range (1-16 for performance)
      voices = unison.clip(1, 16);
      
      // Generate detuned frequencies for each voice
      // Spread them evenly from -detune to +detune semitones
      freqs = Array.fill(16, { |i|
        var detuneAmount = (i - (voices - 1) / 2) / (voices.max(2) - 1) * 2;
        modFreq * (2 ** (detuneAmount * detune / 12))
      });
      
      // Pan spread: voices spread from -spread to +spread
      pans = Array.fill(16, { |i|
        var panPos = (i - (voices - 1) / 2) / (voices.max(2) - 1) * 2;
        panPos * spread
      });
      
      // Mix all voices with gain compensation
      gainAdjust = 1 / voices.sqrt;
      sound = Mix.fill(16, { |i|
        var sig = Saw.ar(freqs[i]) * (i < voices);  // Mute unused voices
        Pan2.ar(sig, pans[i])
      }) * gainAdjust * 2.0;  // 2.0 = RMS compensation for Saw
      
      // No internal envelope - strudel_adsr module handles ADSR
      // Just free after sustain duration
      Line.kr(0, 0, sustain, doneAction: 2);

      Out.ar(out, DirtPan.ar(sound, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_supersaw".postln;
    
    // ========================================
    // Synthesized Bass Drum (sbd)
    // Matches superdough's sbd synth with decay, pdecay, penv params
    // Triangle oscillator + brown noise transient + pitch envelope
    // ========================================
    
    SynthDef(\\strudel_sbd, { |out, freq = 55, sustain = 1, pan = 0, speed = 1,
                              decay = 0.5, pdecay = 0.5, penv = 36, clip = 0|
      var osc, noise, env, noiseEnv, pitchEnv, mix;
      var attackhold = 0.02;
      var noiselvl = 1.2;
      var noisedecay = 0.025;
      
      // Pitch envelope: starts at penv semitones above freq, drops exponentially
      pitchEnv = EnvGen.kr(
        Env.new([penv * 100, 0.001], [pdecay], \\exp),
        doneAction: 0
      );
      
      // Triangle oscillator with pitch envelope
      osc = LFTri.ar((freq * speed) * (2 ** (pitchEnv / 1200)));
      
      // Soft saturation (tanh waveshaper like superdough)
      osc = (osc * 2).tanh;
      
      // Amplitude envelope for oscillator
      env = EnvGen.kr(
        Env.new([1, 1, 0.001], [attackhold, decay], \\exp),
        doneAction: 0
      );
      
      // Brown noise transient
      noise = FOS.ar(WhiteNoise.ar, 0.0196, 0, 0.9804);
      noiseEnv = EnvGen.kr(
        Env.new([noiselvl, 0.001], [noisedecay], \\exp),
        doneAction: 0
      );
      
      // Mix oscillator and noise
      mix = (osc * env) + (noise * noiseEnv);
      
      // Overall envelope with optional clip
      mix = mix * EnvGen.kr(
        Env.new([1, 1, 0], [decay.max(0.01), 0.01]),
        doneAction: 2
      );
      
      Out.ar(out, DirtPan.ar(mix, ${channels}, pan));
    }, [\\ir, \\ir, \\ir, \\kr, \\ir, \\kr, \\kr, \\kr]).add;
    "Added: strudel_sbd".postln;
    
    s.sync;  // Ensure new synths are registered
    "*** Strudel pulse/supersaw/sbd SynthDefs loaded ***".postln;
    
    // ========================================
    // Strudel ADSR Envelope Module (for SAMPLES only)
    // Synths have built-in envelopes, but samples use SuperDirt's sample SynthDefs
    // This module applies ADSR envelope to samples when strudelEnv* params are present
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_envelope
    // ========================================
    
    SynthDef("strudel_adsr" ++ ${channels}, { |out, strudelEnvAttack = 0.001, strudelEnvDecay = 0.001, 
                                               strudelEnvSustainLevel = 1, strudelEnvRelease = 0.01,
                                               strudelEnvHold = 1|
      var signal, env;
      signal = In.ar(out, ${channels});
      // ADSR envelope with linear curves to match superdough
      // Levels: 0 -> 1 (attack) -> sustainLevel (decay) -> sustainLevel (hold) -> 0 (release)
      env = EnvGen.ar(
        Env.new(
          [0, 1, strudelEnvSustainLevel, strudelEnvSustainLevel, 0],
          [strudelEnvAttack, strudelEnvDecay, strudelEnvHold, strudelEnvRelease],
          \\lin
        )
      );
      ReplaceOut.ar(out, signal * env);
    }, [\\ir, \\ir, \\ir, \\ir, \\ir, \\ir]).add;
    "Added: strudel_adsr${channels}".postln;
    
    // Register the strudel_adsr module with SuperDirt (for samples)
    // This module triggers when strudelEnvAttack parameter is present
    // and applies our ADSR envelope INSTEAD of SuperDirt's dirt_envelope
    ~dirt.addModule('strudel_adsr',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_adsr' ++ ${channels},
          [
            strudelEnvAttack: ~strudelEnvAttack,
            strudelEnvDecay: ~strudelEnvDecay,
            strudelEnvSustainLevel: ~strudelEnvSustainLevel,
            strudelEnvRelease: ~strudelEnvRelease,
            strudelEnvHold: ~strudelEnvHold,
            out: ~out
          ])
      }, { ~strudelEnvAttack.notNil });
    "*** Strudel ADSR module registered (for samples) ***".postln;
    
    s.sync;
    
    // ========================================
    // Strudel Filter Module (for SAMPLES and SYNTHS)
    // Applies HPF/LPF/BPF filtering when strudelHpf/strudelLpf/strudelBpf params are present
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_lpf/dirt_hpf modules
    // This is a single module that handles all filtering, rather than duplicating
    // filter code in every SynthDef
    // 
    // The filter uses 12dB/octave resonant filters (RLPF/RHPF) to match superdough.
    // At extreme values (LPF at 20kHz, HPF at 20Hz), filters are essentially transparent.
    //
    // Filter envelope support:
    // - strudelLpEnv/strudelHpEnv/strudelBpEnv: envelope amount in octaves (can be negative)
    // - strudelLpAttack/strudelHpAttack/strudelBpAttack: attack time
    // - strudelLpDecay/strudelHpDecay/strudelBpDecay: decay time  
    // - strudelLpSustain/strudelHpSustain/strudelBpSustain: sustain level (0-1)
    // - strudelLpRelease/strudelHpRelease/strudelBpRelease: release time
    // - strudelFanchor: anchor point (0=env sweeps up from cutoff, 1=sweeps down, 0.5=centered)
    // ========================================
    
    SynthDef("strudel_filter" ++ ${channels}, { |out, sustain = 1,
                                                 strudelLpf = 20000, strudelHpf = 20,
                                                 strudelLpq = 1, strudelHpq = 1,
                                                 strudelBpf = 0, strudelBpq = 1,
                                                 strudelLpEnv = 0, strudelHpEnv = 0, strudelBpEnv = 0,
                                                 strudelLpAttack = 0.005, strudelLpDecay = 0.14,
                                                 strudelLpSustain = 0, strudelLpRelease = 0.1,
                                                 strudelHpAttack = 0.005, strudelHpDecay = 0.14,
                                                 strudelHpSustain = 0, strudelHpRelease = 0.1,
                                                 strudelBpAttack = 0.005, strudelBpDecay = 0.14,
                                                 strudelBpSustain = 0, strudelBpRelease = 0.1,
                                                 strudelFanchor = 0,
                                                 strudelFtype = 0,
                                                 strudelDjf = -1|
      var signal, rqLpf, rqHpf, rqBpf, lpfFreq, hpfFreq, bpfFreq;
      var lpfEnvFreq, hpfEnvFreq, bpfEnvFreq, lpfEnv, hpfEnv, bpfEnv;
      var lpfEnvAbs, hpfEnvAbs, bpfEnvAbs, lpfOffset, hpfOffset, bpfOffset;
      var lpfMin, lpfMax, hpfMin, hpfMax, bpfMin, bpfMax;
      var djfV, djfCutoff, djfSignal;
      
      signal = In.ar(out, ${channels});
      
      // DJF (DJ Filter) - crossfade between LPF and HPF
      // djf < 0.49 = lowpass, djf > 0.51 = highpass, 0.49-0.51 = neutral
      // Cutoff formula from superdough: (v * 11)^4
      // strudelDjf = -1 means disabled (default), 0-1 means active
      signal = Select.ar(strudelDjf >= 0, [
        signal,  // DJF disabled - pass through unchanged
        {
          // Calculate v and cutoff based on djf value
          // For lowpass (djf < 0.49): v = djf * 2
          // For highpass (djf > 0.51): v = (djf - 0.5) * 2
          var isLowpass = strudelDjf < 0.49;
          var isHighpass = strudelDjf > 0.51;
          var isNeutral = (strudelDjf >= 0.49) * (strudelDjf <= 0.51);
          var lpV = (strudelDjf * 2).clip(0, 1);
          var hpV = ((strudelDjf - 0.5) * 2).clip(0, 1);
          var lpCut = ((lpV * 11) ** 4).clip(20, 20000);
          var hpCut = ((hpV * 11) ** 4).clip(20, 20000);
          
          // Apply LPF, HPF, or pass through based on djf value
          // Using simple RLPF/RHPF with fixed moderate Q
          var filteredLp = RLPF.ar(signal, lpCut, 0.7);
          var filteredHp = RHPF.ar(signal, hpCut, 0.7);
          
          Select.ar(isLowpass, [
            Select.ar(isHighpass, [signal, filteredHp]),
            filteredLp
          ])
        }.value
      ]);
      
      // Convert Q to rq for SuperCollider's RLPF/RHPF/BPF
      // WebAudio BiquadFilter uses Q directly, SC uses rq = 1/Q
      // However, the resonance gain differs between implementations.
      // Using 1/sqrt(Q) instead of 1/Q reduces SC's resonance to match WebAudio better.
      // Empirically tested: 1/Q gives +4-6dB difference at high Q, 1/sqrt(Q) is closer.
      rqLpf = (1/strudelLpq.max(0.001).sqrt).clip(0.01, 2);
      rqHpf = (1/strudelHpq.max(0.001).sqrt).clip(0.01, 2);
      rqBpf = (1/strudelBpq.max(0.001).sqrt).clip(0.01, 2);
      
      // Base frequencies
      lpfFreq = strudelLpf.clip(20, 20000);
      hpfFreq = strudelHpf.clip(20, 20000);
      bpfFreq = strudelBpf.clip(20, 20000);
      
      // Apply filter envelopes if env amount is non-zero
      // superdough uses octave-based envelope: freq * 2^(env * envelope_value)
      // fanchor determines the pivot point: 0 = sweep up from cutoff, 1 = sweep down, 0.5 = centered
      
      // LPF envelope
      lpfEnvAbs = strudelLpEnv.abs;
      lpfOffset = lpfEnvAbs * strudelFanchor;
      lpfMin = (lpfFreq * (2 ** lpfOffset.neg)).clip(20, 20000);
      lpfMax = (lpfFreq * (2 ** (lpfEnvAbs - lpfOffset))).clip(20, 20000);
      // If env is negative, swap min and max
      // NOTE: Using numeric curve -4 instead of \exp because SC's \exp symbol curve
      // doesn't work with envelopes that start at or pass through 0 (produces NaN).
      // -4 gives a similar exponential-like decay without the NaN issue.
      lpfEnv = EnvGen.kr(
        Env.adsr(strudelLpAttack, strudelLpDecay, strudelLpSustain, strudelLpRelease, curve: -4),
        gate: 1, doneAction: 0
      );
      lpfEnvFreq = Select.kr(strudelLpEnv < 0, [
        lpfEnv.linexp(0, 1, lpfMin.max(20), lpfMax.max(20)),
        lpfEnv.linexp(0, 1, lpfMax.max(20), lpfMin.max(20))
      ]);
      // If no envelope, just use base frequency
      lpfEnvFreq = Select.kr(strudelLpEnv.abs > 0.001, [lpfFreq, lpfEnvFreq]);
      
      // HPF envelope  
      hpfEnvAbs = strudelHpEnv.abs;
      hpfOffset = hpfEnvAbs * strudelFanchor;
      hpfMin = (hpfFreq * (2 ** hpfOffset.neg)).clip(20, 20000);
      hpfMax = (hpfFreq * (2 ** (hpfEnvAbs - hpfOffset))).clip(20, 20000);
      hpfEnv = EnvGen.kr(
        Env.adsr(strudelHpAttack, strudelHpDecay, strudelHpSustain, strudelHpRelease, curve: -4),
        gate: 1, doneAction: 0
      );
      hpfEnvFreq = Select.kr(strudelHpEnv < 0, [
        hpfEnv.linexp(0, 1, hpfMin.max(20), hpfMax.max(20)),
        hpfEnv.linexp(0, 1, hpfMax.max(20), hpfMin.max(20))
      ]);
      hpfEnvFreq = Select.kr(strudelHpEnv.abs > 0.001, [hpfFreq, hpfEnvFreq]);
      
      // BPF envelope
      bpfEnvAbs = strudelBpEnv.abs;
      bpfOffset = bpfEnvAbs * strudelFanchor;
      bpfMin = (bpfFreq * (2 ** bpfOffset.neg)).clip(20, 20000);
      bpfMax = (bpfFreq * (2 ** (bpfEnvAbs - bpfOffset))).clip(20, 20000);
      bpfEnv = EnvGen.kr(
        Env.adsr(strudelBpAttack, strudelBpDecay, strudelBpSustain, strudelBpRelease, curve: -4),
        gate: 1, doneAction: 0
      );
      bpfEnvFreq = Select.kr(strudelBpEnv < 0, [
        bpfEnv.linexp(0, 1, bpfMin.max(20), bpfMax.max(20)),
        bpfEnv.linexp(0, 1, bpfMax.max(20), bpfMin.max(20))
      ]);
      bpfEnvFreq = Select.kr(strudelBpEnv.abs > 0.001, [bpfFreq, bpfEnvFreq]);
      
      // Apply filters
      // LPF and HPF always applied (with neutral defaults: LPF=20000, HPF=20)
      // strudelFtype: 0 = 12dB/oct (single filter), 1 = 24dB/oct (cascade two filters)
      signal = RLPF.ar(signal, lpfEnvFreq, rqLpf);
      signal = Select.ar(strudelFtype > 0, [
        signal,
        RLPF.ar(signal, lpfEnvFreq, rqLpf)  // Second pass for 24dB slope
      ]);
      
      signal = RHPF.ar(signal, hpfEnvFreq, rqHpf);
      signal = Select.ar(strudelFtype > 0, [
        signal,
        RHPF.ar(signal, hpfEnvFreq, rqHpf)  // Second pass for 24dB slope
      ]);
      
      // BPF only applied when strudelBpf > 0 (default is 0 = disabled)
      // Uses envelope-modulated frequency
      // Also cascades when strudelFtype > 0 for 24dB slope
      signal = Select.ar(strudelBpf > 0, [
        signal,
        Select.ar(strudelFtype > 0, [
          BPF.ar(signal, bpfEnvFreq, rqBpf),
          BPF.ar(BPF.ar(signal, bpfEnvFreq, rqBpf), bpfEnvFreq, rqBpf)  // Cascade for 24dB
        ])
      ]);
      
      ReplaceOut.ar(out, signal);
    }, [\\ir, \\ir, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\kr, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\ir, \\kr]).add;
    "Added: strudel_filter${channels} (with envelope support, BPF, 24dB mode, and DJF)".postln;
    
    // Register the strudel_filter module with SuperDirt
    // This module triggers when strudelLpf, strudelHpf, strudelBpf, or strudelDjf parameters are present
    // and applies our filters INSTEAD of SuperDirt's dirt_lpf/dirt_hpf/dirt_bpf modules
    ~dirt.addModule('strudel_filter',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_filter' ++ ${channels},
          [
            sustain: ~sustain ? 1,
            strudelLpf: ~strudelLpf ? 20000,
            strudelHpf: ~strudelHpf ? 20,
            strudelLpq: ~strudelLpq ? 1,
            strudelHpq: ~strudelHpq ? 1,
            strudelBpf: ~strudelBpf ? 0,
            strudelBpq: ~strudelBpq ? 1,
            strudelLpEnv: ~strudelLpEnv ? 0,
            strudelHpEnv: ~strudelHpEnv ? 0,
            strudelBpEnv: ~strudelBpEnv ? 0,
            strudelLpAttack: ~strudelLpAttack ? 0.005,
            strudelLpDecay: ~strudelLpDecay ? 0.14,
            strudelLpSustain: ~strudelLpSustain ? 0,
            strudelLpRelease: ~strudelLpRelease ? 0.1,
            strudelHpAttack: ~strudelHpAttack ? 0.005,
            strudelHpDecay: ~strudelHpDecay ? 0.14,
            strudelHpSustain: ~strudelHpSustain ? 0,
            strudelHpRelease: ~strudelHpRelease ? 0.1,
            strudelBpAttack: ~strudelBpAttack ? 0.005,
            strudelBpDecay: ~strudelBpDecay ? 0.14,
            strudelBpSustain: ~strudelBpSustain ? 0,
            strudelBpRelease: ~strudelBpRelease ? 0.1,
            strudelFanchor: ~strudelFanchor ? 0,
            strudelFtype: ~strudelFtype ? 0,
            strudelDjf: ~strudelDjf ? -1,
            out: ~out
          ])
      }, { ~strudelLpf.notNil || ~strudelHpf.notNil || ~strudelBpf.notNil || ~strudelDjf.notNil });
    "*** Strudel filter module registered (with envelope support, BPF, 24dB mode, and DJF) ***".postln;
    
    // ========================================
    // Strudel Tremolo Module (for SAMPLES and SYNTHS)
    // Matches superdough's tremolo implementation with LFO shapes
    // Uses custom parameter names to avoid triggering SuperDirt's dirt_tremolo
    //
    // Parameters:
    // - strudelTremRate: LFO frequency in Hz
    // - strudelTremDepth: modulation depth (0-1, can exceed 1 for clipping effects)
    // - strudelTremSkew: triangle wave skew (0-1, 0.5 = symmetric)
    // - strudelTremPhase: phase offset (0-1)
    // - strudelTremShape: waveform (0=tri, 1=sine, 2=ramp, 3=saw, 4=square)
    //
    // superdough tremolo behavior:
    // - Base gain = max(1 - depth, 0)
    // - LFO adds to base gain with range [0, depth]
    // - Result: amplitude modulates between (1-depth) and 1
    // ========================================
    
    SynthDef("strudel_tremolo" ++ ${channels}, { |out,
                                                  strudelTremRate = 1, strudelTremDepth = 1,
                                                  strudelTremSkew = 0.5, strudelTremPhase = 0,
                                                  strudelTremShape = 0|
      var signal, lfo, phase, baseGain, modGain;
      var triLfo, sineLfo, rampLfo, sawLfo, squareLfo;
      var shapeIdx;
      
      signal = In.ar(out, ${channels});
      
      // Calculate phase with offset
      phase = Phasor.ar(0, strudelTremRate / SampleRate.ir, 0, 1);
      phase = (phase + strudelTremPhase).mod(1);
      
      // Pre-compute all LFO shapes (all are audio rate since phase is audio rate)
      
      // 0: Triangle with skew
      // When phase < skew: ramp up from 0 to 1
      // When phase >= skew: ramp down from 1 to 0
      triLfo = (phase < strudelTremSkew).if(
        phase / strudelTremSkew.max(0.001),
        1 - ((phase - strudelTremSkew) / (1 - strudelTremSkew).max(0.001))
      );
      
      // 1: Sine (0-1 range like superdough)
      sineLfo = (1 + (phase * 2pi).sin) * 0.5;
      
      // 2: Ramp (0 to 1)
      rampLfo = phase;
      
      // 3: Saw (1 to 0)
      sawLfo = 1 - phase;
      
      // 4: Square with skew (duty cycle)
      squareLfo = (phase < strudelTremSkew).if(1, 0);
      
      // Select shape using index
      shapeIdx = strudelTremShape.round.clip(0, 4);
      lfo = SelectX.ar(shapeIdx, [triLfo, sineLfo, rampLfo, sawLfo, squareLfo]);
      
      // superdough applies a curve: Math.pow(lfo, 1.5)
      // This softens the LFO shape, making peaks rounder
      lfo = lfo.pow(1.5);
      
      // superdough behavior: baseGain + lfo * depth
      // where baseGain = max(1 - depth, 0)
      // This means at depth=1: modulates 0 to 1
      // At depth=0.5: modulates 0.5 to 1
      baseGain = (1 - strudelTremDepth).max(0);
      modGain = baseGain + (lfo * strudelTremDepth);
      
      signal = signal * modGain;
      
      ReplaceOut.ar(out, signal);
    }, [\\ir, \\kr, \\kr, \\kr, \\kr, \\kr]).add;
    "Added: strudel_tremolo${channels}".postln;
    
    // Register the strudel_tremolo module with SuperDirt
    ~dirt.addModule('strudel_tremolo',
      { |dirtEvent|
        dirtEvent.sendSynth('strudel_tremolo' ++ ${channels},
          [
            strudelTremRate: ~strudelTremRate ? 1,
            strudelTremDepth: ~strudelTremDepth ? 1,
            strudelTremSkew: ~strudelTremSkew ? 0.5,
            strudelTremPhase: ~strudelTremPhase ? 0,
            strudelTremShape: ~strudelTremShape ? 0,
            out: ~out
          ])
      }, { ~strudelTremRate.notNil });
    "*** Strudel tremolo module registered ***".postln;
    
    // Re-order modules to put strudel modules BEFORE out_to
    // Without this, our modules run AFTER the signal is sent to output
    ~dirt.orderModules([
        'sound', 'vowel', 'shape', 'hpf', 'bpf', 'crush', 'coarse', 'lpf',
        'pshift', 'envelope', 'grenvelo', 'tremolo', 'phaser', 'waveloss',
        'squiz', 'fshift', 'triode', 'krush', 'octer', 'ring', 'distort',
        'spectral-delay', 'spectral-freeze', 'spectral-comb', 'spectral-smear',
        'spectral-scram', 'spectral-binshift', 'spectral-hbrick', 'spectral-lbrick',
        'spectral-conformer', 'spectral-enhance', 'dj-filter', 'compressor',
        'strudel_adsr',      // Our ADSR module
        'strudel_tremolo',   // Our tremolo module (before filter for consistent behavior)
        'strudel_filter',    // Our filter module
        'out_to', 'map_from'
    ]);
    "*** Module order updated (strudel modules before out_to) ***".postln;
    
    s.sync;
    
    // ========================================
    // OSC Handlers
    // ========================================
    
    // OSC handler for dynamic sample loading from Strudel
    // When new samples are downloaded, the server sends this message
    // After loading, sends confirmation back to the server
    OSCdef(\\strudelLoadSamples, { |msg|
        var path, replyPort;
        path = msg[1].asString;
        // Use SC's if() syntax - the ? operator doesn't work like JS ternary
        replyPort = if(msg[2].notNil, { msg[2].asInteger }, { 0 });
        "Strudel: Loading samples from %".format(path).postln;
        ~dirt.loadSoundFiles(path);
        "Strudel: Samples loaded".postln;
        // Send confirmation back to the server if reply port was provided
        if(replyPort > 0, {
            NetAddr("127.0.0.1", replyPort).sendMsg('/strudel/samplesLoaded', path);
            "Strudel: Sent load confirmation to port %".format(replyPort).postln;
        });
    }, '/strudel/loadSamples');
    
    // OSC handler for Strudel synths - bypasses SuperDirt entirely
    // This avoids double envelope application from dirt_envelope
    // Message format: /strudel/synth synthName, param1, value1, param2, value2, ...
    OSCdef(\\strudelSynth, { |msg|
        var synthName, args, synth, time, latency;
        synthName = msg[1].asSymbol;
        
        // Parse args as key-value pairs starting from msg[2]
        args = [];
        forBy(2, msg.size - 1, 2, { |i|
            if(msg[i].notNil && msg[i+1].notNil, {
                args = args ++ [msg[i].asSymbol, msg[i+1]];
            });
        });
        
        // Schedule synth with small latency for timing accuracy
        latency = 0.05;
        SystemClock.sched(latency, {
            Synth(synthName, args);
            nil;
        });
    }, '/strudel/synth');
    "*** Strudel synth OSC handler registered: /strudel/synth ***".postln;
    
    "*** SuperDirt listening on port ${port} ***".postln;
    "*** Strudel OSC handler registered: /strudel/loadSamples ***".postln;
    "*** Ready for OSC messages ***".postln;
};
)
`;
  }

  /**
   * Start SuperDirt
   * Returns a promise that resolves when SuperDirt is ready
   * On Linux, automatically starts JACK if not running
   */
  async start(): Promise<boolean> {
    if (this.isRunning) {
      console.log('[superdirt] Already running');
      return true;
    }

    if (!SuperDirtLauncher.isSclangAvailable()) {
      console.error('[superdirt] sclang not found - install SuperCollider first');
      return false;
    }

    // On Linux, SuperDirt requires JACK - start it if not running
    if (platform() === 'linux') {
      if (!isJackRunning()) {
        console.log('[superdirt] JACK not running, attempting to start...');
        // Try common audio devices
        let result = startJack('hw:1');
        if (!result.started) {
          result = startJack('hw:0');
        }
        if (result.started) {
          this.weStartedJack = result.weStartedIt;
          console.log('[superdirt] JACK started successfully');
        } else {
          console.error('[superdirt] Could not start JACK - SuperDirt requires JACK on Linux');
          console.error('[superdirt] Please start JACK manually: jack_control start');
          return false;
        }
      } else {
        console.log('[superdirt] JACK is running');
      }
    }

    // Check/install SuperDirt quark
    if (!SuperDirtLauncher.isSuperDirtInstalled()) {
      console.log('[superdirt] SuperDirt quark not found, installing...');
      if (!SuperDirtLauncher.installSuperDirt()) {
        return false;
      }
    }

    // Write startup script to temp file
    const script = this.generateStartupScript();
    this.tempScriptPath = join(tmpdir(), `superdirt_${Date.now()}.scd`);
    writeFileSync(this.tempScriptPath, script);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error('[superdirt] Startup timeout - SuperDirt may not be ready');
        resolve(false);
      }, this.options.startupTimeout);

      console.log('[superdirt] Starting sclang...');
      
      this.sclangProcess = spawn('sclang', [this.tempScriptPath!], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Don't detach - sclang should die when parent dies
        detached: false,
      });
      
      // On Unix, set up parent death signal so sclang dies if we crash
      // This uses prctl(PR_SET_PDEATHSIG) on Linux via a workaround
      if (process.platform !== 'win32' && this.sclangProcess.pid) {
        // Store PID for cleanup tracking
        this.sclangPid = this.sclangProcess.pid;
      }

      let stdoutBuffer = '';

      this.sclangProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdoutBuffer += text;
        
        if (this.options.verbose) {
          process.stdout.write(`[sclang] ${text}`);
        }

        // Check for ready signal
        if (text.includes('Ready for OSC messages')) {
          clearTimeout(timeout);
          this.isRunning = true;
          console.log('[superdirt] SuperDirt is ready!');
          resolve(true);
        }

        // Check for common errors
        if (text.includes('ERROR') || text.includes('Exception')) {
          console.error('[superdirt] Error detected in sclang output');
        }
      });

      this.sclangProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // sclang outputs a lot to stderr that isn't actually errors
        if (this.options.verbose) {
          process.stderr.write(`[sclang:err] ${text}`);
        }
      });

      this.sclangProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[superdirt] Failed to start sclang:', err.message);
        resolve(false);
      });

      this.sclangProcess.on('exit', (code, signal) => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.cleanup();
        
        if (code !== 0 && code !== null) {
          console.log(`[superdirt] sclang exited with code ${code}`);
        } else if (signal) {
          console.log(`[superdirt] sclang killed by signal ${signal}`);
        }
      });
    });
  }

  /**
   * Stop SuperDirt and cleanup
   * Also stops JACK if we started it
   * This method is synchronous to work properly in signal handlers
   */
  stop(): void {
    console.log('[superdirt] stop() called, weStartedJack:', this.weStartedJack);
    
    if (this.sclangProcess) {
      console.log('[superdirt] Stopping sclang (PID:', this.sclangPid, ')...');
      
      // Kill sclang process
      try {
        this.sclangProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      
      // Also kill any child processes (scsynth is spawned by sclang)
      if (this.sclangPid && process.platform !== 'win32') {
        try {
          // Kill any child processes (scsynth)
          execSync(`pkill -P ${this.sclangPid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore errors
        }
        
        // Force kill sclang by PID
        try {
          execSync(`kill -9 ${this.sclangPid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore
        }
      }
    }
    
    // Kill ALL sclang and scsynth processes (not just ours)
    // This ensures nothing is keeping JACK alive
    if (process.platform !== 'win32') {
      try {
        execSync('pkill -9 sclang 2>/dev/null || true', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
      try {
        execSync('pkill -9 scsynth 2>/dev/null || true', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
      
      // Wait a moment for processes to die before stopping JACK
      // JACK won't stop if clients are still connected
      try {
        execSync('sleep 0.5', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
    }
    
    this.cleanup();
    this.isRunning = false;
    this.sclangProcess = null;
    this.sclangPid = null;
    
    // Stop JACK if we started it
    if (this.weStartedJack) {
      console.log('[superdirt] Stopping JACK (we started it)...');
      stopJack();
      this.weStartedJack = false;
    } else {
      console.log('[superdirt] Not stopping JACK (we did not start it)');
    }
  }

  /**
   * Check if SuperDirt is currently running
   */
  isActive(): boolean {
    return this.isRunning && this.sclangProcess !== null && !this.sclangProcess.killed;
  }

  /**
   * Cleanup temp files
   */
  private cleanup(): void {
    if (this.tempScriptPath && existsSync(this.tempScriptPath)) {
      try {
        unlinkSync(this.tempScriptPath);
      } catch {
        // Ignore cleanup errors
      }
      this.tempScriptPath = null;
    }
  }
}

/**
 * Check if JACK server is running and accepting connections (Linux only)
 *
 * With PipeWire, JACK is provided by PipeWire. We should:
 * 1. First check if PipeWire is running (provides JACK interface)
 * 2. Then check if traditional JACK server is running
 *
 * IMPORTANT: The jackdbus daemon process may exist without the JACK server being started.
 * We need to check if the JACK server is actually running and accepting connections.
 */
export function isJackRunning(): boolean {
  if (platform() !== 'linux') {
    return true; // Assume OK on non-Linux
  }

  // Method 0: Check for PipeWire first (provides JACK interface on modern systems)
  // PipeWire runs even without jackdbus and provides libjack compatibility
  try {
    // Check if pw-cli works - if it does, PipeWire is running and provides JACK
    const pwInfo = execSync('pw-cli info 0 2>/dev/null', { stdio: 'pipe', timeout: 5000 }).toString();
    if (pwInfo.includes('PipeWire') && pwInfo.includes('version')) {
      console.log('[jack] PipeWire detected (provides JACK interface)');
      return true;
    }
  } catch {
    // pw-cli failed or PipeWire not running
  }

  // Method 1: Try jack_lsp - this actually connects to the JACK server
  // If JACK isn't running or accepting connections, this will fail
  // This is the most reliable method but jack_lsp may not be installed
  try {
    execSync('jack_lsp 2>/dev/null', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    // jack_lsp failed or not installed
  }

  // Method 2: Use jack_control status (DBus)
  // This reports the actual server state, not just if jackdbus daemon is running
  // Output format: "--- status\nstarted" or "--- status\nstopped"
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    // Check for "started" on its own line (not just anywhere in output)
    if (result.split('\n').some(line => line.trim() === 'started')) {
      return true;
    }
    // If we got a valid response with "stopped", JACK is definitely not running
    if (result.split('\n').some(line => line.trim() === 'stopped')) {
      return false;
    }
  } catch {
    // jack_control not available or failed
  }

  // Method 3: Check if jackd process is running (not jackdbus)
  // jackdbus is just the DBus service daemon, it can run without JACK server started
  try {
    const result = execSync('pgrep -x jackd 2>/dev/null', { timeout: 5000 }).toString();
    if (result.trim()) {
      return true;
    }
  } catch {
    // No jackd process found
  }

  return false;
}

/**
 * Start JACK with default settings (Linux only)
 * Prefers jack_control (DBus) if available, falls back to jackd
 * Returns { started: boolean, weStartedIt: boolean }
 *
 * IMPORTANT: On systems with PipeWire, we should NOT try to start a separate JACK server.
 * PipeWire provides a JACK-compatible interface and applications should connect to it directly.
 * We detect PipeWire via pw-cli and skip starting traditional JACK.
 */
export function startJack(device = 'hw:0'): { started: boolean; weStartedIt: boolean } {
  if (platform() !== 'linux') {
    return { started: true, weStartedIt: false };
  }

  if (isJackRunning()) {
    console.log('[jack] JACK is already running');
    return { started: true, weStartedIt: false };
  }

  // Check if PipeWire is running - if so, we can't start traditional JACK
  // Applications should connect to PipeWire's JACK interface via libjack
  try {
    execSync('pw-cli info 0 2>/dev/null', { stdio: 'pipe', timeout: 5000 });
    console.log('[jack] PipeWire is running - cannot start traditional JACK server');
    console.log('[jack] Applications should use libjack to connect to PipeWire');
    return { started: true, weStartedIt: false };
  } catch {
    // PipeWire not running, proceed to start traditional JACK
  }

  console.log('[jack] Attempting to start JACK...');
  
  // Method 1: Try jack_control (DBus) - preferred method
  try {
    // First check if jack_control is available
    execSync('which jack_control', { stdio: 'ignore' });
    
    // Configure ALSA driver
    execSync(`jack_control ds alsa`, { stdio: 'ignore' });
    execSync(`jack_control dps device ${device}`, { stdio: 'ignore' });
    execSync(`jack_control dps rate 48000`, { stdio: 'ignore' });
    execSync(`jack_control dps period 1024`, { stdio: 'ignore' });
    
    // Start JACK
    const result = execSync('jack_control start 2>&1', { timeout: 10000 }).toString();
    if (!result.includes('error') && !result.includes('Error')) {
      // Wait a moment and verify
      execSync('sleep 1');
      if (isJackRunning()) {
        console.log('[jack] JACK started via DBus');
        return { started: true, weStartedIt: true };
      }
    }
  } catch {
    // jack_control failed, try direct jackd
  }
  
  // Method 2: Try starting jackd directly
  try {
    const jackd = spawn('jackd', ['-d', 'alsa', '-d', device, '-r', '48000', '-p', '1024'], {
      detached: true,
      stdio: 'ignore',
    });
    
    jackd.unref();
    
    // Wait a moment for JACK to start
    execSync('sleep 1');
    
    if (isJackRunning()) {
      console.log('[jack] JACK started via jackd');
      return { started: true, weStartedIt: true };
    } else {
      console.error('[jack] JACK failed to start');
      return { started: false, weStartedIt: false };
    }
  } catch (err) {
    console.error('[jack] Failed to start JACK:', err);
    return { started: false, weStartedIt: false };
  }
}

/**
 * Stop JACK (Linux only)
 * Use jack_control if available, otherwise pkill jackd
 * This is synchronous to ensure JACK is stopped before process exits
 */
export function stopJack(): void {
  if (platform() !== 'linux') {
    return;
  }

  // Check if JACK is actually running before trying to stop
  let jackRunning = false;
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    jackRunning = result.split('\n').some(line => line.trim() === 'started');
    console.log('[jack] Current status:', jackRunning ? 'started' : 'stopped');
  } catch {
    // If we can't check status, assume it might be running
    jackRunning = true;
  }
  
  if (!jackRunning) {
    console.log('[jack] JACK is not running, nothing to stop');
    return;
  }

  console.log('[jack] Stopping JACK...');
  
  // Try up to 3 times with a small delay between attempts
  // JACK might not stop immediately if clients are disconnecting
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync('jack_control stop 2>&1', { timeout: 10000, stdio: 'pipe' });
      
      // Small delay then verify it stopped
      execSync('sleep 0.3', { stdio: 'ignore', timeout: 2000 });
      
      const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
      if (result.split('\n').some(line => line.trim() === 'stopped')) {
        console.log('[jack] JACK stopped via DBus (attempt', attempt + ')');
        return;
      }
      console.log('[jack] jack_control stop attempt', attempt, '- still running, retrying...');
    } catch (err) {
      console.log('[jack] jack_control stop attempt', attempt, 'failed:', err);
    }
    
    // Wait before retry
    if (attempt < 3) {
      try {
        execSync('sleep 0.5', { stdio: 'ignore', timeout: 2000 });
      } catch {
        // Ignore
      }
    }
  }
  
  // Fallback: Kill jackd directly (if running standalone, not via DBus)
  console.log('[jack] DBus stop failed, trying pkill jackd...');
  try {
    execSync('pkill -x jackd 2>/dev/null || true', { stdio: 'ignore', timeout: 5000 });
    console.log('[jack] Sent kill signal to jackd');
  } catch {
    // Ignore errors
  }
  
  // Final status check
  try {
    const result = execSync('jack_control status 2>&1', { timeout: 5000 }).toString();
    const stillRunning = result.split('\n').some(line => line.trim() === 'started');
    if (stillRunning) {
      console.error('[jack] WARNING: JACK is still running after stop attempts!');
    } else {
      console.log('[jack] JACK stopped');
    }
  } catch {
    // Ignore
  }
}
