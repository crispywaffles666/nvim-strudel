/**
 * Audio API polyfill for Node.js
 * 
 * This module MUST be imported first, before any other modules that use Web Audio API.
 * It sets up globalThis.AudioContext and adds all the prototype methods that
 * superdough expects (like createReverb).
 * 
 * The key issue: With ESM static imports, all imports are hoisted and resolved
 * BEFORE any code executes. So we can't do:
 * 
 *   import * as nodeWebAudio from 'node-web-audio-api';
 *   Object.assign(globalThis, nodeWebAudio);  // Runs AFTER superdough is loaded!
 *   import { superdough } from 'superdough';  // Already loaded without polyfill
 * 
 * This module exports a function that sets up the polyfill, which we call
 * immediately at the top of strudel-engine.ts.
 */

import * as nodeWebAudio from 'node-web-audio-api';
import { initWorkletPolyfill } from './worklet-polyfill.js';

// IMPORTANT: Expose DelayNode globally immediately so that superdough's feedbackdelay.mjs
// can detect it and add createFeedbackDelay to AudioContext.prototype.
// feedbackdelay.mjs checks: if (typeof DelayNode !== 'undefined')
// This must happen at module evaluation time, before superdough is imported.
(globalThis as any).DelayNode = nodeWebAudio.DelayNode;

// Store whether we've initialized
let initialized = false;

// Offline rendering configuration
let offlineConfig: {
  duration: number;
  sampleRate: number;
  channels: number;
} | null = null;

// Store the offline context for later access
let offlineContext: InstanceType<typeof nodeWebAudio.OfflineAudioContext> | null = null;

// Real-time capture configuration
let captureConfig: {
  duration: number;
  sampleRate: number;
  channels: number;
} | null = null;

/**
 * Check if we're in a mode that uses a shared/singleton AudioContext.
 * Used by worklet-polyfill to avoid closing the shared context.
 */
export function isSharedContextMode(): boolean {
  return offlineConfig !== null || captureConfig !== null;
}

// Capture state
let captureContext: InstanceType<typeof nodeWebAudio.AudioContext> | null = null;
let captureGain: GainNode | null = null;
let captureProcessor: ScriptProcessorNode | null = null;
let capturedLeft: number[] = [];
let capturedRight: number[] = [];
let captureTargetSamples = 0;
let captureTotalSamples = 0;

// Track scheduled worklet disconnects for cleanup on hush
const scheduledDisconnects = new Map<any, NodeJS.Timeout>();

// Track all active worklet nodes with their end times for statistics
interface TrackedNode {
  node: any;
  name: string;
  endTime: number;
  createdAt: number;
}
const activeWorkletNodes = new Map<any, TrackedNode>();

/**
 * Get statistics about active audio worklet nodes
 */
export function getWorkletStats(): {
  total: number;
  pending: number;  // Nodes waiting to be disconnected
  byType: Record<string, number>;
} {
  const now = Date.now();
  const byType: Record<string, number> = {};
  let pending = 0;
  
  for (const [node, info] of activeWorkletNodes) {
    byType[info.name] = (byType[info.name] || 0) + 1;
    if (scheduledDisconnects.has(node)) {
      pending++;
    }
  }
  
  return {
    total: activeWorkletNodes.size,
    pending,
    byType,
  };
}

/**
 * Get count of active nodes that haven't finished yet
 * @param ctx AudioContext to check against
 */
export function getActiveNodeCount(ctx?: any): number {
  if (!ctx) return activeWorkletNodes.size;
  
  const currentTime = ctx.currentTime;
  let active = 0;
  
  for (const [_, info] of activeWorkletNodes) {
    if (info.endTime > currentTime) {
      active++;
    }
  }
  
  return active;
}

/**
 * Wait for all tracked worklet nodes to finish (or timeout)
 * This is useful for glitch-free context transitions
 * @param ctx AudioContext to check against
 * @param maxWaitMs Maximum time to wait in milliseconds (default: 5000)
 * @returns Promise that resolves when all nodes are done or timeout reached
 */
export async function waitForNodesToFinish(ctx: any, maxWaitMs = 5000): Promise<{ waited: number; remaining: number }> {
  const startTime = Date.now();
  
  // Find the latest end time among all tracked nodes
  let latestEnd = 0;
  const currentTime = ctx.currentTime;
  
  for (const [_, info] of activeWorkletNodes) {
    if (info.endTime > currentTime) {
      latestEnd = Math.max(latestEnd, info.endTime);
    }
  }
  
  if (latestEnd <= currentTime) {
    // All nodes already finished
    return { waited: 0, remaining: 0 };
  }
  
  // Calculate how long to wait (audio time to real time, plus buffer)
  const waitTimeMs = Math.min((latestEnd - currentTime) * 1000 + 200, maxWaitMs);
  
  await new Promise(resolve => setTimeout(resolve, waitTimeMs));
  
  const remaining = getActiveNodeCount(ctx);
  return { 
    waited: Date.now() - startTime, 
    remaining 
  };
}

/**
 * Cancel all scheduled worklet disconnects (for hush/stop)
 */
export function cancelScheduledDisconnects(): void {
  for (const [node, timeout] of scheduledDisconnects) {
    clearTimeout(timeout);
    try {
      node.disconnect();
    } catch {
      // Already disconnected
    }
  }
  scheduledDisconnects.clear();
  activeWorkletNodes.clear();
}

/**
 * Configure offline rendering mode.
 * Call this BEFORE initAudioPolyfill() to enable offline rendering.
 * When enabled, AudioContext will return an OfflineAudioContext instead.
 * 
 * NOTE: Offline rendering does NOT support AudioWorklet-based synths (pulse, supersaw)
 * due to a limitation in node-web-audio-api. Use configureCaptureMode() for those.
 * 
 * @param duration - Duration in seconds to render
 * @param sampleRate - Sample rate (default: 48000)
 * @param channels - Number of channels (default: 2 for stereo)
 */
export function configureOfflineRendering(duration: number, sampleRate = 48000, channels = 2): void {
  if (initialized) {
    throw new Error('configureOfflineRendering must be called before initAudioPolyfill');
  }
  offlineConfig = { duration, sampleRate, channels };
  console.log(`[audio-polyfill] Offline rendering configured: ${duration}s @ ${sampleRate}Hz, ${channels}ch`);
}

/**
 * Configure real-time capture mode.
 * Call this BEFORE initAudioPolyfill() to enable real-time audio capture.
 * 
 * Unlike offline rendering, this plays audio in real-time and captures it.
 * This mode supports ALL synths including AudioWorklet-based ones (pulse, supersaw).
 * 
 * @param duration - Duration in seconds to capture
 * @param sampleRate - Sample rate (default: 48000)
 * @param channels - Number of channels (default: 2 for stereo)
 */
export function configureCaptureMode(duration: number, sampleRate = 48000, channels = 2): void {
  if (initialized) {
    throw new Error('configureCaptureMode must be called before initAudioPolyfill');
  }
  captureConfig = { duration, sampleRate, channels };
  captureTargetSamples = Math.ceil(duration * sampleRate);
  console.log(`[audio-polyfill] Capture mode configured: ${duration}s @ ${sampleRate}Hz, ${channels}ch`);
}

/**
 * Get capture progress (0-1)
 */
export function getCaptureProgress(): number {
  if (!captureConfig) return 0;
  return Math.min(1, captureTotalSamples / captureTargetSamples);
}

/**
 * Reset capture buffers - call this right before playback starts
 * to avoid capturing silence during initialization
 */
export function resetCapture(): void {
  if (!captureConfig) return;
  capturedLeft = [];
  capturedRight = [];
  captureTotalSamples = 0;
  console.log('[audio-polyfill] Capture buffers reset');
}

/**
 * Check if capture is complete
 */
export function isCaptureComplete(): boolean {
  if (!captureConfig) return false;
  return captureTotalSamples >= captureTargetSamples;
}

/**
 * Get the captured audio as an AudioBuffer.
 * Call this after capture is complete.
 */
export function getCapturedAudio(): AudioBuffer {
  if (!captureContext || !captureConfig) {
    throw new Error('Not in capture mode or capture not started');
  }
  if (!isCaptureComplete()) {
    console.warn('[audio-polyfill] Capture not complete yet, returning partial buffer');
  }
  
  const buffer = captureContext.createBuffer(
    captureConfig.channels,
    capturedLeft.length,
    captureConfig.sampleRate
  );
  buffer.getChannelData(0).set(new Float32Array(capturedLeft));
  if (captureConfig.channels > 1) {
    buffer.getChannelData(1).set(new Float32Array(capturedRight));
  }
  
  return buffer;
}

/**
 * Wait for capture to complete
 * @param progressCallback - Optional callback called periodically with progress (0-1)
 */
export async function waitForCapture(progressCallback?: (progress: number) => void): Promise<AudioBuffer> {
  if (!captureConfig) {
    throw new Error('Not in capture mode');
  }
  
  await new Promise<void>(resolve => {
    const checkInterval = setInterval(() => {
      if (progressCallback) {
        progressCallback(getCaptureProgress());
      }
      if (isCaptureComplete()) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });
  
  return getCapturedAudio();
}

/**
 * Get the offline audio context (only available after init in offline mode)
 */
export function getOfflineContext(): InstanceType<typeof nodeWebAudio.OfflineAudioContext> | null {
  return offlineContext;
}

/**
 * Render the offline context to an AudioBuffer.
 * Call this after all audio has been scheduled.
 */
export async function renderOffline(): Promise<AudioBuffer> {
  if (!offlineContext) {
    throw new Error('Not in offline rendering mode');
  }
  console.log('[audio-polyfill] Starting offline render...');
  const buffer = await offlineContext.startRendering();
  console.log(`[audio-polyfill] Render complete: ${buffer.duration}s, ${buffer.numberOfChannels}ch`);
  return buffer;
}

/**
 * Initialize the Web Audio API polyfill for Node.js
 * This adds AudioContext and related classes to globalThis,
 * and patches AudioContext.prototype with methods superdough expects.
 */
export function initAudioPolyfill(): void {
  if (initialized) return;
  initialized = true;

  // Add all node-web-audio-api exports to globalThis
  Object.assign(globalThis, nodeWebAudio);
  
  // CRITICAL: Add createFeedbackDelay to nodeWebAudio.AudioContext.prototype FIRST
  // This ensures the method is available even on raw contexts created in capture/offline modes.
  // superdough's Orbit class stores a reference to the audioContext and calls 
  // this.audioContext.createFeedbackDelay() later, so the method must be on the prototype.
  if (!(nodeWebAudio.AudioContext.prototype as any).createFeedbackDelay) {
    const { DelayNode } = nodeWebAudio;
    
    // FeedbackDelayNode extends DelayNode with wet gain and feedback loop
    class FeedbackDelayNode extends DelayNode {
      private delayGainNode: GainNode;
      public feedback: AudioParam;
      public delayGain: GainNode;
      
      constructor(ac: AudioContext, wet: number, time: number, feedbackAmount: number) {
        super(ac as any);
        wet = Math.abs(wet);
        this.delayTime.value = time;
        
        // Create feedback gain node for the feedback loop
        const feedbackGain = ac.createGain();
        feedbackGain.gain.value = Math.min(Math.abs(feedbackAmount), 0.995);
        this.feedback = feedbackGain.gain;
        
        // Create delay gain node for wet/dry mix
        const delayGain = ac.createGain();
        delayGain.gain.value = wet;
        this.delayGainNode = delayGain;
        this.delayGain = delayGain;
        
        // Connect the feedback loop:
        // delay -> feedbackGain -> delay (loop)
        // delay -> delayGain -> output
        (this as any).connect(feedbackGain);
        (this as any).connect(delayGain);
        feedbackGain.connect(this as any);
      }
      
      // Override connect to route through the wet gain
      connect(target: any, outputIndex?: number, inputIndex?: number): any {
        return this.delayGainNode.connect(target, outputIndex, inputIndex);
      }
      
      start(t: number): void {
        // Set the delay gain at the time when the delay starts producing output
        this.delayGainNode.gain.setValueAtTime(this.delayGainNode.gain.value, t + this.delayTime.value);
      }
    }
    
    (nodeWebAudio.AudioContext.prototype as any).createFeedbackDelay = function(
      this: AudioContext,
      wet: number,
      time: number,
      feedback: number
    ): FeedbackDelayNode {
      return new FeedbackDelayNode(this, wet, time, feedback);
    };
    
    console.log('[audio-polyfill] Added createFeedbackDelay to nodeWebAudio.AudioContext.prototype');
  }

  // Check if we're in offline rendering mode
  if (offlineConfig) {
    // Create an OfflineAudioContext and return it whenever AudioContext is requested
    const { duration, sampleRate, channels } = offlineConfig;
    const length = Math.ceil(duration * sampleRate);
    
    offlineContext = new nodeWebAudio.OfflineAudioContext({
      numberOfChannels: channels,
      length,
      sampleRate,
    });
    
    console.log(`[audio-polyfill] Created OfflineAudioContext: ${duration}s, ${sampleRate}Hz, ${channels}ch`);
    
    // Replace AudioContext with a function that returns our singleton OfflineAudioContext
    // Using a Proxy to make it work with both `new AudioContext()` and as a constructor
    const offlineCtx = offlineContext;
    (globalThis as any).AudioContext = new Proxy(function AudioContext() {}, {
      construct(_target, _args) {
        console.log('[audio-polyfill] AudioContext requested, returning OfflineAudioContext');
        return offlineCtx as any;
      },
      apply(_target, _thisArg, _args) {
        console.log('[audio-polyfill] AudioContext called, returning OfflineAudioContext');
        return offlineCtx as any;
      }
    });
  } else if (captureConfig) {
    // Real-time capture mode: Create a real AudioContext but proxy destination
    // to capture audio through a ScriptProcessorNode
    const { sampleRate } = captureConfig;
    
    // Create the real audio context
    const realContext = new nodeWebAudio.AudioContext({ 
      latencyHint: 'playback',
      sampleRate,
    });
    captureContext = realContext as any;
    
    // Reset capture buffers
    capturedLeft = [];
    capturedRight = [];
    captureTotalSamples = 0;
    
    // Create capture chain
    const gain = realContext.createGain();
    const processor = realContext.createScriptProcessor(4096, 2, 2);
    captureGain = gain as any;
    captureProcessor = processor as any;
    
    // Copy destination properties to our gain node so superdough can read them
    // Use defineProperty for read-only properties
    const realDest = realContext.destination;
    Object.defineProperty(gain, 'maxChannelCount', { value: realDest.maxChannelCount, configurable: true });
    try { (gain as any).channelCount = realDest.channelCount; } catch {}
    try { (gain as any).channelCountMode = realDest.channelCountMode; } catch {}
    try { (gain as any).channelInterpretation = realDest.channelInterpretation; } catch {}
    
    // Set up capture processor
    processor.onaudioprocess = (e: any) => {
      if (captureTotalSamples >= captureTargetSamples) return;
      
      const inputLeft = e.inputBuffer.getChannelData(0);
      const inputRight = e.inputBuffer.getChannelData(1);
      const outputLeft = e.outputBuffer.getChannelData(0);
      const outputRight = e.outputBuffer.getChannelData(1);
      
      for (let i = 0; i < inputLeft.length && captureTotalSamples < captureTargetSamples; i++) {
        capturedLeft.push(inputLeft[i]);
        capturedRight.push(inputRight[i]);
        // Pass through to output (so we can hear it)
        outputLeft[i] = inputLeft[i];
        outputRight[i] = inputRight[i];
        captureTotalSamples++;
      }
    };
    
    // Connect capture chain
    gain.connect(processor);
    processor.connect(realContext.destination);
    
    console.log(`[audio-polyfill] Capture mode enabled: intercepting destination`);
    
    // Create a proxy AudioContext that returns our captureGain as destination
    const createProxyContext = () => {
      return new Proxy(realContext as object, {
        get(target: any, prop: string) {
          if (prop === 'destination') {
            return gain;
          }
          const value = target[prop];
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        },
        set(target: any, prop: string, value: any) {
          target[prop] = value;
          return true;
        }
      });
    };
    
    // Replace AudioContext constructor
    (globalThis as any).AudioContext = new Proxy(function AudioContext() {}, {
      construct() {
        console.log('[audio-polyfill] AudioContext requested, returning capture proxy');
        return createProxyContext();
      },
      apply() {
        return createProxyContext();
      }
    });
    
    console.log(`[audio-polyfill] Capture context created: ${realContext.sampleRate}Hz`);
    
  } else {
    // Normal real-time mode: wrap AudioContext to use 'playback' latency hint by default on Linux
    // This prevents audio glitches/underruns with ALSA backend
    // See: https://github.com/niccolorosato/node-web-audio-api#audio-backend-and-latency
    const OriginalAudioContext = (globalThis as any).AudioContext;
    (globalThis as any).AudioContext = class AudioContextWrapper extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        // Default to 'playback' latency hint on Linux for stable audio
        // Users can override with WEB_AUDIO_LATENCY env var or explicit option
        const defaultOptions: AudioContextOptions = {
          latencyHint: process.env.WEB_AUDIO_LATENCY as AudioContextLatencyCategory || 'playback',
          ...options,
        };
        super(defaultOptions);
        console.log(`[audio-polyfill] AudioContext created with latencyHint: ${defaultOptions.latencyHint}`);
      }
    };
  }

  // Add a minimal `window` object for superdough code that expects it
  // (e.g., reverbGen.mjs assigns to window.filterNode, dspworklet.mjs adds event listener)
  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      ...globalThis,
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
    };
  } else if (!(globalThis as any).window.addEventListener) {
    // If window exists but doesn't have addEventListener (we set window = globalThis)
    (globalThis as any).window.addEventListener = () => {};
    (globalThis as any).window.removeEventListener = () => {};
    (globalThis as any).window.postMessage = () => {};
  }

  // Add a minimal `document` object for @strudel/core that checks for mousemove
  // This is a stub that does nothing - we don't have a real DOM in Node.js
  if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      createElement: () => ({}),
      body: {},
      head: {},
    };
  }

  // Add CustomEvent for @strudel/core event dispatching
  if (typeof (globalThis as any).CustomEvent === 'undefined') {
    (globalThis as any).CustomEvent = class CustomEvent extends Event {
      detail: any;
      constructor(type: string, options?: { detail?: any }) {
        super(type);
        this.detail = options?.detail;
      }
    };
  }

  console.log('[audio-polyfill] Web Audio API polyfilled for Node.js');

  // Now manually add the prototype methods that superdough's reverb.mjs adds
  // (since reverb.mjs checks for AudioContext at module load time, which happens
  // before our polyfill runs due to ESM import hoisting)
  
  const AudioContext = (globalThis as any).AudioContext;
  if (!AudioContext) {
    console.error('[audio-polyfill] AudioContext not available after polyfill!');
    return;
  }
  
  // IMPORTANT: Add methods to BOTH the global AudioContext.prototype AND 
  // nodeWebAudio.AudioContext.prototype. This is needed because in capture mode,
  // we create a raw nodeWebAudio.AudioContext which doesn't go through our wrapper.
  // Adding to the nodeWebAudio prototype ensures all contexts have these methods.
  const prototypesToPatch = [
    AudioContext.prototype,
    nodeWebAudio.AudioContext.prototype,
  ];
  
  // Filter to unique prototypes (they might be the same in normal mode)
  const uniquePrototypes = [...new Set(prototypesToPatch)];
  
  // Helper to add a method to all AudioContext prototypes
  const addToAllPrototypes = (name: string, method: Function) => {
    for (const proto of uniquePrototypes) {
      if (!(proto as any)[name]) {
        (proto as any)[name] = method;
      }
    }
  };

  // Add adjustLength method (from superdough/reverb.mjs)
  const adjustLengthMethod = function(
    this: AudioContext,
    duration: number,
    buffer: AudioBuffer,
    speed = 1,
    offsetAmount = 0
  ): AudioBuffer {
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const sampleOffset = Math.floor(clamp(offsetAmount, 0, 1) * buffer.length);
    const newLength = buffer.sampleRate * duration;
    const newBuffer = this.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const oldData = buffer.getChannelData(channel);
      const newData = newBuffer.getChannelData(channel);

      for (let i = 0; i < newLength; i++) {
        let position = (sampleOffset + i * Math.abs(speed)) % oldData.length;
        if (speed < 1) {
          position = position * -1;
        }
        newData[i] = oldData[Math.floor(position)] || 0;
      }
    }
    return newBuffer;
  };
  addToAllPrototypes('adjustLength', adjustLengthMethod);
  console.log('[audio-polyfill] Added AudioContext.prototype.adjustLength');

  // Add createReverb method (from superdough/reverb.mjs)
  // Uses addToAllPrototypes to ensure it's available on both global AudioContext
  // and nodeWebAudio.AudioContext (needed for capture mode proxy)
  const createReverbMethod = function(
    this: AudioContext,
    duration?: number,
    fade?: number,
    lp?: number,
    dim?: number,
    ir?: AudioBuffer,
    irspeed?: number,
    irbegin?: number
  ): ConvolverNode & { generate: Function; duration?: number; fade?: number; lp?: number; dim?: number; ir?: AudioBuffer; irspeed?: number; irbegin?: number } {
    const convolver = this.createConvolver() as ConvolverNode & {
      generate: Function;
      duration?: number;
      fade?: number;
      lp?: number;
      dim?: number;
      ir?: AudioBuffer;
      irspeed?: number;
      irbegin?: number;
    };
    
    const ctx = this;
    
    convolver.generate = function(
      d = 2,
      fadeIn = 0.1,
      lpFreq = 15000,
      dimFreq = 1000,
      irBuffer?: AudioBuffer,
      irSpeed?: number,
      irBegin?: number
    ) {
      convolver.duration = d;
      convolver.fade = fadeIn;
      convolver.lp = lpFreq;
      convolver.dim = dimFreq;
      convolver.ir = irBuffer;
      convolver.irspeed = irSpeed;
      convolver.irbegin = irBegin;
      
      if (irBuffer) {
        convolver.buffer = (ctx as any).adjustLength(d, irBuffer, irSpeed, irBegin);
      } else {
        // Generate synthetic reverb impulse response
        // This is a simplified version - the original uses reverbGen.mjs
        const sampleRate = ctx.sampleRate;
        const length = Math.floor(sampleRate * d);
        const buffer = ctx.createBuffer(2, length, sampleRate);
        
        for (let channel = 0; channel < 2; channel++) {
          const data = buffer.getChannelData(channel);
          for (let i = 0; i < length; i++) {
            // Exponential decay with random noise
            const t = i / sampleRate;
            const decay = Math.exp(-3 * t / d);
            // Apply fade in
            const fadeEnv = t < fadeIn ? t / fadeIn : 1;
            data[i] = (Math.random() * 2 - 1) * decay * fadeEnv;
          }
        }
        
        // Apply simple lowpass filter effect by averaging nearby samples
        // (This is a very rough approximation of the original)
        if (lpFreq < 20000) {
          for (let channel = 0; channel < 2; channel++) {
            const data = buffer.getChannelData(channel);
            const filterStrength = Math.max(1, Math.floor(20000 / lpFreq));
            for (let i = filterStrength; i < length; i++) {
              let sum = 0;
              for (let j = 0; j < filterStrength; j++) {
                sum += data[i - j];
              }
              data[i] = sum / filterStrength;
            }
          }
        }
        
        convolver.buffer = buffer;
      }
    };
    
    convolver.generate(duration, fade, lp, dim, ir, irspeed, irbegin);
    return convolver;
  };
  addToAllPrototypes('createReverb', createReverbMethod);
  console.log('[audio-polyfill] Added AudioContext.prototype.createReverb');
  
  // Initialize AudioWorklet polyfill for processors like shape, crush, etc.
  initWorkletPolyfill();

  // Wrap AudioWorkletNode to auto-disconnect nodes with 'end' parameter
  // This fixes the memory leak in superdough where LFO nodes for tremolo
  // are created but never disconnected (they're not added to the audioNodes array)
  // See: https://github.com/tidalcycles/strudel/issues/XXX (to be reported)
  //
  // The challenge: superdough's getWorklet() creates the node first, THEN sets parameters.
  // So we can't read 'end' at construction time. Instead, we defer the check using queueMicrotask.
  const OriginalAudioWorkletNode = (globalThis as any).AudioWorkletNode;
  if (OriginalAudioWorkletNode) {
    (globalThis as any).AudioWorkletNode = class AudioWorkletNodeWrapper extends OriginalAudioWorkletNode {
      constructor(context: AudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        
        // Check if this worklet has an 'end' parameter (like LFOProcessor)
        const endParam = this.parameters.get('end');
        if (endParam) {
          const node = this;
          const ctx = context;
          const nodeName = name;
          const createdAt = Date.now();
          
          // Defer the check to allow superdough's getWorklet() to set the parameters
          queueMicrotask(() => {
            const endTime = endParam.value;
            const currentTime = ctx.currentTime;
            
            // Track this node
            activeWorkletNodes.set(node, {
              node,
              name: nodeName,
              endTime,
              createdAt,
            });
            
            if (endTime > 0 && endTime > currentTime) {
              // Schedule disconnect slightly after end time (add 100ms buffer for processing)
              const delayMs = Math.max(0, (endTime - currentTime) * 1000 + 100);
              
              const timeout = setTimeout(() => {
                try {
                  node.disconnect();
                } catch {
                  // Already disconnected
                }
                scheduledDisconnects.delete(node);
                activeWorkletNodes.delete(node);
              }, delayMs);
              
              scheduledDisconnects.set(node, timeout);
            }
          });
        }
      }
    };
    console.log('[audio-polyfill] AudioWorkletNode wrapped for auto-disconnect (fixes tremolo leak)');
  }
}

/**
 * Load our Node.js-compatible worklets onto a specific audio context
 * Call this after superdough's audio context is available
 */
export async function loadNodeWorklets(ctx: any): Promise<void> {
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const workletPath = path.join(__dirname, 'worklets-node.js');
  
  console.log('[audio-polyfill] Loading Node.js worklets onto audio context...');
  try {
    await ctx.audioWorklet.addModule(workletPath);
    console.log('[audio-polyfill] Successfully loaded worklets-node.js');
  } catch (err) {
    console.error('[audio-polyfill] Failed to load worklets-node.js:', err);
    throw err;
  }
}

// Export the nodeWebAudio for convenience
export { nodeWebAudio };
