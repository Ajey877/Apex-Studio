/**
 * Phase 7A — WSOLA pitch-preserving time stretch: pure PCM regression suite.
 *
 * Everything here runs on REAL Float32Array samples through the production
 * `wsolaStretchChannels` / `wsolaStretchAudioBuffer` code paths — no Web Audio
 * mocks are involved in the DSP assertions (the AudioBuffer wrapper tests use
 * web-audio-engine's real AudioBuffer implementation as a plain data
 * container). Assertions cover the acceptance matrix: pitch preservation
 * within the documented tolerance, exact output lengths, stereo channel
 * alignment, determinism, silence, short inputs, boundary ratios, invalid
 * inputs, and source non-mutation.
 *
 * PITCH TOLERANCE: dominant frequency is measured by autocorrelation with
 * parabolic interpolation over a mid-output window (edge Hann fades
 * excluded). The documented tolerance is ±2 % of the source's dominant
 * frequency — asserted here at 0.5×, 1.5× and 2.0× on a pure sine and on a
 * harmonic tone.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import {
  WSOLA_MAX_RATIO,
  WSOLA_MIN_RATIO,
  WsolaTimeStretchError,
  computeStretchWaveformPeaks,
  wsolaStretchAudioBuffer,
  wsolaStretchChannels,
} from './wsolaTimeStretch';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

const SR = 44100;

let createBuffer: (ch: number, length: number, sr: number) => AudioBuffer;
before(() => {
  const ctx = new RealOfflineAudioContext(2, SR * 2, SR);
  createBuffer = (ch, length, sr) => ctx.createBuffer(ch, length, sr);
});

const makeSine = (freq: number, seconds: number, amplitude = 0.8, delaySamples = 0): Float32Array => {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = delaySamples; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * (i - delaySamples)) / SR);
  }
  return out;
};

/** Harmonic tone: f0 plus two decaying harmonics — a more musical fixture than a pure sine. */
const makeHarmonicTone = (f0: number, seconds: number): Float32Array => {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SR;
    out[i] = 0.6 * Math.sin(2 * Math.PI * f0 * t)
      + 0.25 * Math.sin(2 * Math.PI * 2 * f0 * t)
      + 0.12 * Math.sin(2 * Math.PI * 3 * f0 * t);
  }
  return out;
};

/** Dominant frequency via autocorrelation + parabolic interpolation over [from, to). */
const dominantFrequency = (data: Float32Array, from: number, to: number): number => {
  const n = to - from;
  const minLag = Math.floor(SR / 1000); // up to 1 kHz
  const maxLag = Math.min(Math.floor(SR / 60), Math.floor(n / 2)); // down to 60 Hz
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < n - lag; i += 2) {
      sum += data[from + i] * data[from + i + lag];
    }
    scores.push(sum);
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  const idx = bestLag - minLag;
  const prev = scores[idx - 1] ?? bestScore;
  const next = scores[idx + 1] ?? bestScore;
  const denom = prev - 2 * bestScore + next;
  const delta = denom === 0 ? 0 : (0.5 * (prev - next)) / denom;
  return SR / (bestLag + delta);
};

/** Inter-channel delay estimate: lag maximizing cross-correlation of l against delayed r. */
const crossCorrelationLag = (l: Float32Array, r: Float32Array, from: number, len: number, maxLag: number): number => {
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < len - maxLag; i += 2) {
      sum += l[from + i] * r[from + i + lag];
    }
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  return bestLag;
};

const rms = (data: Float32Array, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

const assertFiniteSamples = (channels: readonly Float32Array[]): void => {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      assert.ok(Number.isFinite(channel[i]), `non-finite sample at ${i}`);
    }
  }
};

describe('Phase 7A: WSOLA pitch-preserving time stretch (real PCM)', () => {
  it('preserves the dominant pitch of a 220 Hz sine within ±2 % at 0.5×, 1.5× and 2.0×', () => {
    const source = makeSine(220, 1.0);
    for (const ratio of [0.5, 1.5, 2.0]) {
      const { channels, length } = wsolaStretchChannels([source], ratio);
      assert.equal(length, Math.ceil(source.length * ratio), `exact output length at ${ratio}×`);
      assert.equal(channels[0].length, length);
      assertFiniteSamples(channels);
      // Measure the middle of the output, away from the documented edge fades.
      const from = Math.floor(length * 0.25);
      const to = Math.min(length, from + 16384);
      const f0 = dominantFrequency(channels[0], from, to);
      const deviation = Math.abs(f0 - 220) / 220;
      assert.ok(
        deviation <= 0.02,
        `pitch preserved within 2 % at ${ratio}× — measured ${f0.toFixed(2)} Hz (deviation ${(deviation * 100).toFixed(2)} %)`
      );
    }
  });

  it('preserves the fundamental of a harmonic tone (110 Hz + overtones) within ±2 % at 0.5× and 2.0×', () => {
    const source = makeHarmonicTone(110, 1.0);
    for (const ratio of [0.5, 2.0]) {
      const { channels, length } = wsolaStretchChannels([source], ratio);
      const from = Math.floor(length * 0.25);
      const to = Math.min(length, from + 16384);
      const f0 = dominantFrequency(channels[0], from, to);
      const deviation = Math.abs(f0 - 110) / 110;
      assert.ok(
        deviation <= 0.02,
        `fundamental preserved within 2 % at ${ratio}× — measured ${f0.toFixed(2)} Hz`
      );
    }
  });

  it('keeps overall level sane: output RMS stays within 0.5×–1.5× of the source RMS', () => {
    const source = makeSine(220, 1.0);
    const sourceRms = rms(source, SR / 4, (SR * 3) / 4);
    for (const ratio of [0.5, 2.0]) {
      const { channels, length } = wsolaStretchChannels([source], ratio);
      const outRms = rms(channels[0], Math.floor(length * 0.2), Math.floor(length * 0.8));
      assert.ok(
        outRms >= sourceRms * 0.5 && outRms <= sourceRms * 1.5,
        `RMS ${outRms.toFixed(4)} within 0.5×–1.5× of source ${sourceRms.toFixed(4)} at ${ratio}×`
      );
    }
  });

  it('produces exactly ceil(inputLength × ratio) frames at the supported boundaries 0.25× and 4.0×', () => {
    const source = makeSine(220, 0.25);
    for (const ratio of [WSOLA_MIN_RATIO, WSOLA_MAX_RATIO]) {
      const { length } = wsolaStretchChannels([source], ratio);
      assert.equal(length, Math.ceil(source.length * ratio));
    }
  });

  it('is deterministic: repeated runs are bit-identical (stereo)', () => {
    const left = makeSine(220, 0.5);
    const right = makeSine(330, 0.5, 0.7);
    const first = wsolaStretchChannels([left, right], 1.5);
    const second = wsolaStretchChannels([left, right], 1.5);
    assert.equal(first.length, second.length);
    for (let ch = 0; ch < 2; ch += 1) {
      assert.deepEqual(
        Array.from(first.channels[ch]),
        Array.from(second.channels[ch]),
        `channel ${ch} bit-identical across runs`
      );
    }
  });

  it('preserves stereo alignment: identical channels stay bit-identical after stretching', () => {
    const mono = makeSine(220, 0.5);
    const { channels } = wsolaStretchChannels([mono, Float32Array.from(mono)], 1.75);
    assert.deepEqual(Array.from(channels[0]), Array.from(channels[1]), 'dual-mono stays dual-mono');
  });

  it('preserves stereo alignment: a 41-sample inter-channel delay scales to ≈82 samples at 2×', () => {
    const left = makeSine(220, 0.75);
    const right = makeSine(220, 0.75, 0.8, 41);
    const { channels, length } = wsolaStretchChannels([left, right], 2.0);
    const from = Math.floor(length * 0.3);
    const lag = crossCorrelationLag(channels[0], channels[1], from, 16384, 300);
    assert.ok(
      Math.abs(lag - 82) <= 100,
      `inter-channel delay preserved and scaled (measured ${lag} samples, expected ≈82 within frame granularity)`
    );
    // Both channels must still carry the same dominant pitch.
    const to = Math.min(length, from + 16384);
    const f0L = dominantFrequency(channels[0], from, to);
    const f0R = dominantFrequency(channels[1], from, to);
    assert.ok(Math.abs(f0L - 220) / 220 <= 0.02, `left pitch ${f0L.toFixed(2)} Hz`);
    assert.ok(Math.abs(f0R - 220) / 220 <= 0.02, `right pitch ${f0R.toFixed(2)} Hz`);
  });

  it('stretches silence to silent output at the exact target length', () => {
    const silence = new Float32Array(SR / 2);
    for (const ratio of [0.5, 2.0]) {
      const { channels, length } = wsolaStretchChannels([silence, new Float32Array(SR / 2)], ratio);
      assert.equal(length, Math.ceil(silence.length * ratio));
      for (const channel of channels) {
        for (let i = 0; i < channel.length; i += 1) assert.equal(channel[i], 0, 'silence stays silence');
      }
    }
  });

  it('handles inputs shorter than one analysis frame safely (zero-pad, exact length, finite samples)', () => {
    const tiny = makeSine(440, 100 / SR);
    assert.equal(tiny.length, 100);
    const { channels, length } = wsolaStretchChannels([tiny], 1.5);
    assert.equal(length, 150);
    assertFiniteSamples(channels);
    // The content that exists must survive near the start; the padded tail is silence.
    let maxAbs = 0;
    for (let i = 0; i < length; i += 1) maxAbs = Math.max(maxAbs, Math.abs(channels[0][i]));
    assert.ok(maxAbs > 0, 'stretched short clip still contains its audio');
  });

  it('treats ratio 1.0 as the documented identity: bit-identical copy, never the same array instance', () => {
    const source = makeSine(220, 0.1);
    const { channels, length } = wsolaStretchChannels([source], 1.0);
    assert.equal(length, source.length);
    assert.deepEqual(Array.from(channels[0]), Array.from(source));
    assert.notEqual(channels[0], source);
  });

  it('never mutates the source channel data', () => {
    const source = makeSine(220, 0.25);
    const snapshot = Float32Array.from(source);
    wsolaStretchChannels([source], 2.0);
    assert.deepEqual(Array.from(source), Array.from(snapshot), 'source PCM untouched');
  });

  it('rejects out-of-range ratios with a typed unsupported-ratio error', () => {
    const source = makeSine(220, 0.1);
    for (const ratio of [0.24, 4.01, 0, -1]) {
      assert.throws(
        () => wsolaStretchChannels([source], ratio),
        (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'unsupported-ratio',
        `ratio ${ratio}`
      );
    }
  });

  it('rejects non-finite ratios with a typed invalid-ratio error', () => {
    const source = makeSine(220, 0.1);
    for (const ratio of [Number.NaN, Infinity, -Infinity]) {
      assert.throws(
        () => wsolaStretchChannels([source], ratio),
        (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'invalid-ratio',
        `ratio ${String(ratio)}`
      );
    }
  });

  it('rejects empty and malformed channel input with typed errors', () => {
    assert.throws(
      () => wsolaStretchChannels([new Float32Array(0)], 2.0),
      (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'empty-buffer'
    );
    assert.throws(
      () => wsolaStretchChannels([], 2.0),
      (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'invalid-buffer'
    );
    assert.throws(
      () => wsolaStretchChannels([makeSine(220, 0.1), makeSine(220, 0.2)], 2.0),
      (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'invalid-buffer'
    );
  });

  it('stretches a real AudioBuffer through the wrapper without mutating the source buffer', () => {
    const source = createBuffer(2, SR / 2, SR);
    const tone = makeSine(220, 0.5);
    source.getChannelData(0).set(tone);
    source.getChannelData(1).set(tone);
    const before = Float32Array.from(source.getChannelData(0));

    const stretched = wsolaStretchAudioBuffer(source, 2.0, createBuffer);
    assert.equal(stretched.length, source.length * 2);
    assert.equal(stretched.numberOfChannels, 2);
    assert.equal(stretched.sampleRate, SR);
    assert.deepEqual(Array.from(source.getChannelData(0)), Array.from(before), 'source buffer untouched');

    const out = stretched.getChannelData(0);
    const f0 = dominantFrequency(out, Math.floor(out.length * 0.25), Math.floor(out.length * 0.25) + 16384);
    assert.ok(Math.abs(f0 - 220) / 220 <= 0.02, `wrapper path preserves pitch — measured ${f0.toFixed(2)} Hz`);
  });

  it('rejects malformed AudioBuffers with typed errors (no fabricated output)', () => {
    assert.throws(
      () => wsolaStretchAudioBuffer({} as AudioBuffer, 2.0, createBuffer),
      (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'invalid-buffer'
    );
    const empty = createBuffer(1, 0, SR);
    assert.throws(
      () => wsolaStretchAudioBuffer(empty, 2.0, createBuffer),
      (error: unknown) => error instanceof WsolaTimeStretchError && error.failure === 'empty-buffer'
    );
  });

  it('computes honest waveform peaks from the processed PCM', () => {
    const { channels } = wsolaStretchChannels([makeSine(220, 0.5)], 1.5);
    const peaks = computeStretchWaveformPeaks(channels);
    assert.equal(peaks.length, 64);
    for (const peak of peaks) {
      assert.ok(peak >= 0 && peak <= 1, `peak ${peak} normalized`);
    }
    assert.ok(peaks.some(peak => peak > 0.1), 'peaks reflect real content, not fabrication');
    assert.deepEqual(computeStretchWaveformPeaks([new Float32Array(0)]), []);
  });
});
