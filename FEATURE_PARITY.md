# Feature Parity: WebAudio vs SuperDirt/OSC

This document tracks feature parity between the WebAudio backend (superdough) and our SuperDirt/OSC backend.

**Last Updated:** 2026-01-06

## Similarity Score Legend

| Score | Rating | Description |
|-------|--------|-------------|
| 95-100 | Excellent | Near-perfect match |
| 85-94 | Good | Minor differences, production-ready |
| 70-84 | Fair | Noticeable differences, usable |
| 50-69 | Poor | Significant differences |
| <50 | Bad | Not matching / broken |

---

## Implemented Features

### Basic Samples & Playback

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Sample playback | `s("bd sd hh sd")` | 0.96 | 92.1% | Good |
| Sample speed | `s("bd").speed(2)` | 0.89 | 93.2% | Good |
| Sample note | `s("piano").note("c4")` | 1.00 | 94.0% | Good |

### Synthesizers

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Sine | `note("c4").s("sine")` | 1.00 | 97.2% | Excellent |
| Saw | `note("c4").s("saw")` | 1.00 | 94.0% | Good |
| Square | `note("c4").s("square")` | 0.99 | 92.4% | Good |
| Triangle | `note("c4").s("triangle")` | 1.00 | 96.4% | Excellent |
| Pulse | `note("c4").s("pulse")` | 0.83 | 88.2% | Good |
| Supersaw | `note("c3").s("supersaw")` | 0.84 | 81.2% | Fair - detuning differs |

### Noise Generators

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| White noise | `s("white")` | 0.00 | 55.4% | Expected - random |
| Pink noise | `s("pink")` | 0.66 | 75.8% | Fair - algorithm differs |
| Brown noise | `s("brown")` | 0.76 | 71.9% | Fair - algorithm differs |

*Note: Noise generators have low spectral correlation because they produce random output. RMS levels are close.*

### Filters

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| LPF basic | `s("saw").lpf(500)` | 1.00 | 95.6% | Excellent |
| LPF + resonance | `s("saw").lpf(500).lpq(10)` | 0.93 | 65.1% | Poor - Q scaling differs |
| HPF basic | `s("white").hpf(2000)` | 0.47 | 46.7% | Poor - needs work |
| HPF + resonance | `s("white").hpf(1000).hpq(10)` | 0.52 | 64.6% | Poor - Q scaling differs |
| LPF envelope | `s("bd").lpf(500).lpenv(2).lpdecay(0.5)` | 0.99 | 96.7% | Excellent |
| LPF env negative | `s("saw").lpf(2000).lpenv(-2)` | 1.00 | 96.2% | Excellent |
| BPF | `s("saw").bpf(500).bpq(10)` | 1.00 | 64.6% | Poor - gain differs significantly |

### Tremolo

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Basic | `s("bd").tremolo(4)` | 1.00 | 92.9% | Good |
| With depth | `s("bd").tremolo(8).tremolodepth(0.5)` | 0.95 | 93.3% | Good |
| Sine shape | `s("bd").tremolo(4).tremoloshape(1)` | 0.99 | 98.4% | Excellent |
| Square shape | `s("bd").tremolo(4).tremoloshape(4)` | 1.00 | 98.1% | Excellent |

### Amplitude Envelope (ADSR)

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Attack | `s("saw").attack(0.2)` | 1.00 | 94.7% | Good |
| Decay + Sustain | `s("saw").decay(0.3).sustain(0.5)` | 0.98 | 80.2% | Fair |
| Full ADSR | `s("saw").attack(0.1).decay(0.2).sustain(0.7).release(0.3)` | 0.99 | 85.1% | Good |

### Effects

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Pan | `s("bd").pan(0.5)` | 0.95 | 78.4% | Fair |
| Shape (distortion) | `s("bd").shape(0.5)` | 0.92 | 93.2% | Good |
| Crush (bitcrush) | `s("bd").crush(4)` | 0.99 | 97.5% | Excellent |
| Coarse | `s("bd").coarse(8)` | 0.94 | 88.9% | Good |
| Delay | `s("bd").delay(0.5)` | 0.98 | 91.4% | Good |
| Reverb | `s("bd").room(0.5)` | - | - | Untested |
| Phaser | `s("saw").phaserrate(2)` | - | - | Untested |

### Gain & Dynamics

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| Gain | `s("bd").gain(0.5)` | - | - | Uses SuperDirt built-in |
| Velocity | `s("bd").velocity(0.5)` | - | - | Uses SuperDirt built-in |
| Compressor | `s("bd").compressor(-20)` | - | - | Uses SuperDirt built-in |

### Soundfonts

| Feature | Pattern | Spectral | Similarity | Status |
|---------|---------|----------|------------|--------|
| GM Piano | `note("c4").s("gm_acoustic_grand_piano")` | - | - | Untested |
| GM Strings | `note("c4").s("gm_string_ensemble_1")` | - | - | Untested |

---

## Not Implemented

### High Priority (commonly used)

| Feature | Controls | Difficulty | Notes |
|---------|----------|------------|-------|
| Vibrato | `vib`, `vibmod` | Easy | Simple pitch LFO |
| Pitch Envelope | `penv`, `pattack`, `pdecay`, `psustain`, `prelease`, `panchor` | Medium | Similar to filter env |
| FM Synthesis | `fmi`, `fmh`, `fmenv`, `fmattack`, `fmdecay`, `fmsustain`, `fmrelease` | Hard | Frequency modulation |
| Pulse Width Mod | `pw`, `pwrate`, `pwsweep` | Medium | PWM on pulse wave |

### Medium Priority

| Feature | Controls | Difficulty | Notes |
|---------|----------|------------|-------|
| Ladder Filter | `ftype('ladder')` | Medium | Moog-style 24dB filter |
| 24dB Filter | `ftype('24db')` | Easy | Cascade two 12dB filters |
| DJF | `djf` | Medium | DJ-style low/high morph |
| Bandpass Envelope | `bpenv`, `bpattack`, `bpdecay`, etc. | Easy | Same as LP/HP env |

### Low Priority (specialized)

| Feature | Controls | Difficulty | Notes |
|---------|----------|------------|-------|
| Wavetable Synth | `wt`, `wtenv`, `warp`, etc. | Very Hard | Complex wavetable modulation |
| Phase Vocoder | `stretch` | Very Hard | Time stretching |
| Sidechain/Duck | `duckorbit`, `duckdepth`, etc. | Hard | Cross-orbit ducking |
| Convolution Reverb | `ir`, `irspeed`, `irbegin` | Medium | Impulse response reverb |
| Analyser | `analyze`, `fft` | N/A | Visualization only |
| ByteBeat | `bbexpr`, `bbst` | Medium | Byte beat expressions |

---

## Known Issues

### Major
1. **HPF on noise differs** - Different filter characteristics on white noise (46.7%)
2. **Filter Q scaling** - High resonance values produce different results (65.1%)
3. **BPF gain mismatch** - Bandpass filter has ~20dB gain difference (64.6%)

### Minor
6. **Supersaw detuning** - Slightly different detuning algorithm
7. **ADSR curve shapes** - Minor differences in envelope curves
8. **Pan law** - Slight level differences at extreme pan positions

---

## Testing Commands

```bash
# Run all feature tests
cd server && node test-features.mjs

# Test specific pattern
cd server && node compare-backends.mjs 's("bd sd hh sd").lpf(500)' 2

# Full regression suite
cd server && node compare-backends.mjs --all
```

---

## Changelog

### 2026-01-06
- Fixed delay effect for capture mode (11.6% → 91.4%)
  - createFeedbackDelay now added to nodeWebAudio.AudioContext.prototype before context creation
  - Exposed DelayNode globally for superdough's feedbackdelay.mjs detection

### 2026-01-05
- Fixed pitched sample banks (`s("piano").note("c4")`) - now 94.0% similarity
- Fixed render-pattern-sc.mjs to load Strudel samples cache
- Added tremolo module with 5 waveform shapes (pow 1.5 curve)
- Added filter envelope support (lpenv, hpenv with ADSR)
- Fixed NaN issue with exponential envelope curves
- Initial feature parity document created
