#!/usr/bin/env node
/**
 * Test all features for parity scoring
 */
import { execSync } from 'child_process';

const features = [
  // Basic sounds
  { name: 'sample-basic', pattern: 's("bd sd hh sd")', duration: 2 },
  { name: 'sample-speed', pattern: 's("bd").speed(2)', duration: 2 },
  { name: 'sample-note', pattern: 's("piano").note("c4 e4 g4")', duration: 2 },
  
  // Synths
  { name: 'synth-sine', pattern: 'note("c4").s("sine").release(0.01)', duration: 2 },
  { name: 'synth-saw', pattern: 'note("c4").s("saw").release(0.01)', duration: 2 },
  { name: 'synth-square', pattern: 'note("c4").s("square").release(0.01)', duration: 2 },
  { name: 'synth-triangle', pattern: 'note("c4").s("triangle").release(0.01)', duration: 2 },
  { name: 'synth-pulse', pattern: 'note("c4").s("pulse").release(0.1)', duration: 2 },
  { name: 'synth-supersaw', pattern: 'note("c3").s("supersaw").release(0.5)', duration: 2 },
  
  // Noise
  { name: 'noise-white', pattern: 's("white").release(0.01)', duration: 2 },
  { name: 'noise-pink', pattern: 's("pink").release(0.01)', duration: 2 },
  { name: 'noise-brown', pattern: 's("brown").release(0.01)', duration: 2 },
  
  // Filters
  { name: 'filter-lpf', pattern: 'note("c4").s("saw").lpf(500).release(0.01)', duration: 2 },
  { name: 'filter-lpf-q', pattern: 'note("c4").s("saw").lpf(500).lpq(10).release(0.01)', duration: 2 },
  { name: 'filter-hpf', pattern: 's("white").hpf(2000).release(0.01)', duration: 2 },
  { name: 'filter-hpf-q', pattern: 's("white").hpf(1000).hpq(10).release(0.01)', duration: 2 },
  { name: 'filter-lpenv', pattern: 's("bd sd hh sd").lpf(500).lpenv(2).lpdecay(0.5)', duration: 2 },
  { name: 'filter-lpenv-neg', pattern: 'note("c4").s("saw").lpf(2000).lpenv(-2).lpdecay(0.3).release(0.1)', duration: 2 },
  { name: 'filter-bpf', pattern: 'note("c4").s("saw").bpf(500).bpq(10).release(0.01)', duration: 2 },
  
  // Tremolo
  { name: 'tremolo-basic', pattern: 's("bd sd hh sd").tremolo(4)', duration: 2 },
  { name: 'tremolo-depth', pattern: 's("bd sd hh sd").tremolo(8).tremolodepth(0.5)', duration: 2 },
  { name: 'tremolo-sine', pattern: 's("bd sd hh sd").tremolo(4).tremoloshape(1)', duration: 2 },
  { name: 'tremolo-square', pattern: 's("bd sd hh sd").tremolo(4).tremoloshape(4)', duration: 2 },
  
  // Envelope
  { name: 'env-attack', pattern: 'note("c4").s("saw").attack(0.2).release(0.1)', duration: 2 },
  { name: 'env-decay', pattern: 'note("c4").s("saw").decay(0.3).sustain(0.5).release(0.1)', duration: 2 },
  { name: 'env-full', pattern: 'note("c4").s("saw").attack(0.1).decay(0.2).sustain(0.7).release(0.3)', duration: 2 },
  
  // Effects
  { name: 'fx-pan', pattern: 's("bd sd hh sd").pan("<0 0.5 1>")', duration: 2 },
  { name: 'fx-shape', pattern: 's("bd sd").shape(0.5)', duration: 2 },
  { name: 'fx-crush', pattern: 's("bd sd hh sd").crush(4)', duration: 2 },
  { name: 'fx-coarse', pattern: 's("bd sd hh sd").coarse(8)', duration: 2 },
  { name: 'fx-delay', pattern: 's("bd sd").delay(0.5).delaytime(0.25).delayfeedback(0.5)', duration: 3 },
  { name: 'fx-room', pattern: 's("bd sd").room(0.5).roomsize(2)', duration: 3 },
  
  // Gain/velocity
  { name: 'gain-basic', pattern: 's("bd sd hh sd").gain("<0.5 1 0.7 1>")', duration: 2 },
  { name: 'velocity', pattern: 's("bd sd hh sd").velocity("<0.5 1 0.7 1>")', duration: 2 },
  
  // Phaser
  { name: 'fx-phaser', pattern: 'note("c4").s("saw").phaserrate(2).phaserdepth(0.5).release(0.1)', duration: 2 },
  
  // Soundfonts
  { name: 'soundfont-piano', pattern: 'note("c4 e4 g4 c5").s("gm_acoustic_grand_piano")', duration: 2 },
  { name: 'soundfont-strings', pattern: 'note("c3 e3 g3").s("gm_string_ensemble_1").release(0.5)', duration: 3 },
];

console.log('Testing feature parity...\n');
console.log('Feature                  | RMS Diff | Peak Diff | Spectral | Similarity');
console.log('-------------------------|----------|-----------|----------|------------');

for (const f of features) {
  try {
    const result = execSync(
      `node compare-backends.mjs '${f.pattern.replace(/'/g, "\\'")}' ${f.duration} 2>&1`,
      { timeout: 180000, encoding: 'utf-8' }
    );
    
    // Parse results
    const rmsMatch = result.match(/RMS:.*Diff=([+-]?[\d.]+)dB/);
    const peakMatch = result.match(/Peak:.*Diff=([+-]?[\d.]+)dB/);
    const spectralMatch = result.match(/Spectral correlation: ([\d.-]+)/);
    const similarityMatch = result.match(/Similarity: ([\d.]+)\/100/);
    
    const rms = rmsMatch ? rmsMatch[1] : 'ERR';
    const peak = peakMatch ? peakMatch[1] : 'ERR';
    const spectral = spectralMatch ? parseFloat(spectralMatch[1]).toFixed(2) : 'ERR';
    const similarity = similarityMatch ? similarityMatch[1] : 'ERR';
    
    const name = f.name.padEnd(24);
    console.log(`${name} | ${rms.padStart(7)}dB | ${peak.padStart(8)}dB | ${spectral.padStart(8)} | ${similarity.padStart(10)}`);
  } catch (e) {
    console.log(`${f.name.padEnd(24)} | FAILED - ${e.message?.slice(0, 30) || 'unknown error'}`);
  }
}
