import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTERING_LIMITER_MAX_LOOKAHEAD_MS,
  MASTERING_LIMITER_PROCESSOR,
  MASTERING_LIMITER_SOURCE,
  limiterInterpolatingBranches,
  resolveLimiterLatencySamples,
  resolveLimiterLookaheadMs,
} from './masteringLimiter';
import { designInterpolatingFilters, measureTruePeak } from './truePeak';

/**
 * Phase 9B — signal-level tests for the real lookahead true-peak limiter.
 *
 * The processor source that ships is compiled and executed here verbatim
 * inside a minimal AudioWorklet host, then driven block-by-block with actual
 * sample data. Every assertion reads the *audio* the limiter emits (or the gain
 * reduction it reports), never a parameter assignment, so these tests fail if
 * the DSP is wrong rather than if a value moved.
 */

const BLOCK = 128;

interface LimiterOptions {
  sampleRate?: number;
  ceilingDb?: number;
  releaseMs?: number;
  lookaheadSamples?: number;
}

interface Report {
  type: string;
  reductionDb: number;
  peakReductionDb: number;
  gain: number;
  lookaheadSamples: number;
}

const createHarness = (options: LimiterOptions = {}) => {
  const sampleRate = options.sampleRate ?? 48000;
  const messages: Report[] = [];
  let ProcessorClass: (new () => {
    process: (
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ) => boolean;
  }) | null = null;

  class AudioWorkletProcessorStub {
    port: { postMessage: (message: Report) => void; onmessage: unknown };
    constructor() {
      this.port = {
        postMessage: (message: Report) => {
          messages.push(message);
        },
        onmessage: null,
      };
    }
  }

  const registerProcessor = (name: string, processor: unknown) => {
    if (name === MASTERING_LIMITER_PROCESSOR) ProcessorClass = processor as typeof ProcessorClass;
  };

  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', MASTERING_LIMITER_SOURCE)(
    AudioWorkletProcessorStub,
    registerProcessor,
    sampleRate,
  );
  assert.ok(ProcessorClass, 'the worklet source registers its processor');

  const instance = new ProcessorClass!();
  const parameters: Record<string, Float32Array> = {
    ceilingDb: Float32Array.of(options.ceilingDb ?? -0.2),
    releaseMs: Float32Array.of(options.releaseMs ?? 80),
    lookaheadSamples: Float32Array.of(options.lookaheadSamples ?? Math.round(sampleRate * 0.005)),
  };

  const processBlock = (left: Float32Array, right: Float32Array) => {
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    instance.process([[left, right]], [[outL, outR]], parameters);
    return { left: outL, right: outR };
  };

  return { processBlock, messages, sampleRate, parameters };
};

/** Runs a stereo signal through the limiter and returns the concatenated output. */
const render = (
  left: Float32Array,
  right: Float32Array,
  options: LimiterOptions = {},
) => {
  const harness = createHarness(options);
  const outL = new Float32Array(left.length);
  const outR = new Float32Array(right.length);
  for (let start = 0; start < left.length; start += BLOCK) {
    const end = Math.min(start + BLOCK, left.length);
    const blockL = new Float32Array(BLOCK);
    const blockR = new Float32Array(BLOCK);
    blockL.set(left.subarray(start, end));
    blockR.set(right.subarray(start, end));
    const result = harness.processBlock(blockL, blockR);
    outL.set(result.left.subarray(0, end - start), start);
    outR.set(result.right.subarray(0, end - start), start);
  }
  return { left: outL, right: outR, messages: harness.messages, sampleRate: harness.sampleRate };
};

const sine = (length: number, frequency: number, amplitude: number, sampleRate = 48000, phase = 0) => {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
  }
  return data;
};

const peakOf = (data: Float32Array) => {
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  return peak;
};

const dbToLinear = (db: number) => Math.pow(10, db / 20);

/**
 * Gain the limiter applied at `index`, measured as a *least-squares* ratio over
 * a short window.
 *
 * A single-sample ratio is unreliable: near a zero crossing the input is ~1e-15
 * and float noise decides the answer. Fitting `out ≈ g · in` over ±64 samples
 * gives the applied gain directly, which is the quantity the tests care about.
 */
const appliedGainAt = (input: Float32Array, output: Float32Array, index: number, half = 64): number => {
  let dot = 0;
  let energy = 0;
  for (let i = Math.max(0, index - half); i < Math.min(input.length, index + half); i += 1) {
    dot += input[i] * output[i];
    energy += input[i] * input[i];
  }
  return energy > 1e-12 ? dot / energy : 1;
};

// ---------------------------------------------------------------------------
// Detector identity
// ---------------------------------------------------------------------------

test('the worklet detector uses the same interpolation design as the true-peak meter', () => {
  const reference = designInterpolatingFilters(4, 12);
  const embedded = limiterInterpolatingBranches();
  assert.equal(embedded.length, reference.length, 'same number of phases');
  for (let phase = 0; phase < reference.length; phase += 1) {
    assert.equal(embedded[phase].length, reference[phase].length, `phase ${phase} tap count`);
    for (let tap = 0; tap < reference[phase].length; tap += 1) {
      assert.ok(
        Math.abs(embedded[phase][tap] - reference[phase][tap]) < 1e-12,
        `phase ${phase} tap ${tap} drifted from truePeak.ts (${embedded[phase][tap]} vs ${reference[phase][tap]})`,
      );
    }
  }
});

test('lookahead modes resolve to real, bounded delays', () => {
  assert.equal(resolveLimiterLookaheadMs({ maximizerLookahead: true }), 5, 'legacy true migrates to the documented 5 ms');
  assert.equal(resolveLimiterLookaheadMs({ maximizerLookahead: false }), 0, 'legacy false migrates to direct');
  assert.equal(resolveLimiterLookaheadMs({ maximizerLookaheadMs: 12 }), 12, 'an explicit value wins');
  assert.equal(resolveLimiterLookaheadMs({ maximizerLookaheadMs: 999 }), MASTERING_LIMITER_MAX_LOOKAHEAD_MS, 'clamped');
  assert.equal(resolveLimiterLookaheadMs({ maximizerLookaheadMs: -4 }), 0, 'never negative');
  assert.equal(resolveLimiterLatencySamples({ maximizerLookaheadMs: 5 }, 48000), 240);
  assert.equal(resolveLimiterLatencySamples({ maximizerLookaheadMs: 5 }, 44100), 221);
  assert.equal(resolveLimiterLatencySamples({ maximizerLookaheadMs: 0 }, 48000), 0);
});

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

test('a sample peak above the ceiling is attenuated before it is emitted', () => {
  const sampleRate = 48000;
  const ceilingDb = -0.2;
  const source = sine(sampleRate, 200, 1.4, sampleRate);
  const output = render(source, source, { sampleRate, ceilingDb });
  // Skip the lookahead so the steady state is measured.
  const settled = output.left.subarray(Math.round(sampleRate * 0.2));
  const peak = peakOf(settled);
  const ceiling = dbToLinear(ceilingDb);
  assert.ok(peak <= ceiling + 1e-6, `sample peak ${peak} must not exceed ceiling ${ceiling}`);
  assert.ok(peak > ceiling * 0.8, `the limiter must not over-attenuate (peak ${peak})`);
});

test('reconstructed inter-sample peaks stay under the ceiling', () => {
  const sampleRate = 48000;
  const ceilingDb = -0.2;
  // fs/4 at 45°: every sample sits at 0.707 × the waveform's true peak, so the
  // *sample* peak is far below the reconstructed peak. A clipper at the ceiling
  // would let this through; an inter-sample-aware limiter must not.
  const amplitude = 1.05;
  const source = sine(sampleRate * 2, sampleRate / 4, amplitude, sampleRate, Math.PI / 4);
  const inputTruePeak = measureTruePeak(source, source);
  assert.ok(inputTruePeak > -0.2 - 0.05, `fixture must really overshoot the ceiling (true peak ${inputTruePeak} dBFS)`);
  assert.ok(peakOf(source) < dbToLinear(-0.2), 'and its sample peak must sit below the ceiling');

  const output = render(source, source, { sampleRate, ceilingDb });
  const settled = output.left.subarray(Math.round(sampleRate * 0.5));
  const outputTruePeak = measureTruePeak(settled, output.right.subarray(Math.round(sampleRate * 0.5)));
  assert.ok(
    outputTruePeak <= ceilingDb + 0.25,
    `reconstructed output peak ${outputTruePeak} dBFS must stay at or below ${ceilingDb} dBFS (+0.25 dB tolerance)`,
  );
});

test('direct mode holds the sample ceiling but not the inter-sample one; lookahead holds both', () => {
  const sampleRate = 48000;
  const ceilingDb = -1;
  const ceiling = dbToLinear(ceilingDb);

  // An abrupt, full-scale 3 kHz burst over silence. Its sample peaks are the
  // only thing a causal limiter can see before a transient has been emitted;
  // the waveform it reconstructs between them is where the difference shows.
  const length = sampleRate * 2;
  const burstAt = Math.round(sampleRate * 0.5);
  const transient = new Float32Array(length);
  for (let i = burstAt; i < burstAt + 200; i += 1) {
    transient[i] = 2.4 * Math.sin((2 * Math.PI * 3000 * (i - burstAt)) / sampleRate);
  }
  const inputTruePeak = measureTruePeak(transient, transient);
  assert.ok(inputTruePeak > 7, `fixture must be a real overload (true peak ${inputTruePeak} dBFS)`);

  const direct = render(transient, transient, { sampleRate, ceilingDb, lookaheadSamples: 0 });
  const withLookahead = render(transient, transient, { sampleRate, ceilingDb });
  const delay = Math.round(sampleRate * 0.005);
  const directOut = direct.left.subarray(0, length);
  const lookaheadOut = withLookahead.left.subarray(delay);

  // Both modes cap the *emitted samples* exactly: that is the exact-cap rule.
  assert.ok(peakOf(directOut) <= ceiling + 1e-6, 'direct mode must hold the sample ceiling');
  assert.ok(peakOf(lookaheadOut) <= ceiling + 1e-6, 'lookahead mode must hold the sample ceiling');

  const directTruePeak = measureTruePeak(directOut, direct.right.subarray(0, length));
  const lookaheadTruePeak = measureTruePeak(lookaheadOut, withLookahead.right.subarray(delay));

  // Documented consequence of the setting, measured rather than asserted by
  // hand: a causal detector cannot duck a peak it has not seen, so the
  // reconstructed waveform still overshoots. The lookahead exists to remove
  // exactly this, and does.
  assert.ok(
    directTruePeak > ceilingDb + 0.3,
    `direct mode must show its documented inter-sample overshoot (got ${directTruePeak.toFixed(2)} dBFS against ${ceilingDb} dBFS)`,
  );
  assert.ok(
    directTruePeak < ceilingDb + 2,
    `direct-mode overshoot must stay bounded (got ${directTruePeak.toFixed(2)} dBFS)`,
  );
  assert.ok(
    lookaheadTruePeak <= ceilingDb + 0.25,
    `lookahead mode must hold the true-peak ceiling (got ${lookaheadTruePeak.toFixed(2)} dBFS)`,
  );
  assert.ok(
    lookaheadTruePeak < directTruePeak - 0.3,
    `lookahead must measurably beat direct on the same transient (${lookaheadTruePeak.toFixed(2)} vs ${directTruePeak.toFixed(2)})`,
  );
});

test('a lower ceiling produces proportionally more attenuation', () => {
  const sampleRate = 48000;
  const source = sine(sampleRate, 150, 1.2, sampleRate);
  const gentle = peakOf(render(source, source, { sampleRate, ceilingDb: -1 }).left);
  const hard = peakOf(render(source, source, { sampleRate, ceilingDb: -6 }).left);
  assert.ok(gentle > hard, 'a lower ceiling must attenuate more');
  assert.ok(hard <= dbToLinear(-6) + 1e-6, 'the tighter ceiling is respected');
});

test('material below the ceiling passes through essentially unchanged', () => {
  const sampleRate = 48000;
  const source = sine(sampleRate, 220, 0.5, sampleRate);
  const output = render(source, source, { sampleRate, ceilingDb: -0.2 });
  // Beyond the delay line the signal should be bit-comparable to the input.
  const delay = Math.round(sampleRate * 0.005);
  let maxDiff = 0;
  for (let i = delay + 2048; i < sampleRate; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(output.left[i] - source[i - delay]));
  }
  assert.ok(maxDiff < 1e-6, `unlimited material must pass through unchanged (max diff ${maxDiff})`);
  const reduction = output.messages.length ? Math.max(...output.messages.map(m => m.peakReductionDb)) : 0;
  assert.ok(reduction < 1e-6, `no gain reduction should be reported (${reduction} dB)`);
});

// ---------------------------------------------------------------------------
// Lookahead semantics
// ---------------------------------------------------------------------------

test('lookahead ducks before the transient; direct mode ducks on it', () => {
  const sampleRate = 48000;
  const lookaheadSamples = Math.round(sampleRate * 0.005);
  const length = sampleRate;
  const transientAt = Math.round(0.3 * sampleRate);
  const make = () => {
    const left = sine(length, 200, 0.2, sampleRate);
    const right = sine(length, 200, 0.2, sampleRate);
    for (let i = transientAt; i < transientAt + 220 && i < length; i += 1) {
      const bump = 3.2 * Math.sin((2 * Math.PI * 3000 * (i - transientAt)) / sampleRate);
      left[i] += bump;
      right[i] += bump;
    }
    return { left, right };
  };
  const source = make();

  const withLookahead = render(source.left, source.right, { sampleRate, lookaheadSamples });
  const direct = render(source.left, source.right, { sampleRate, lookaheadSamples: 0 });

  // Compare the applied *gain* just before the transient: with lookahead the
  // limiter is already ducking there; in direct mode it has not started. The
  // delayed render is compared against the same input window shifted by the
  // lookahead, so both measurements describe the same audio moment.
  const gainBefore = (output: Float32Array, delay: number) => {
    const end = transientAt - Math.round(lookaheadSamples / 2) + delay;
    return appliedGainAt(
      source.left.subarray(delay, delay + source.left.length),
      output.subarray(0, output.length - delay),
      end - delay,
    );
  };
  const gainWithLookahead = gainBefore(withLookahead.left, lookaheadSamples);
  const gainDirect = gainBefore(direct.left, 0);
  assert.ok(gainWithLookahead < 0.9, `lookahead must already be attenuating before the transient (gain ${gainWithLookahead})`);
  assert.ok(gainDirect > 0.97, `direct mode must not duck before the transient (gain ${gainDirect})`);

  // And both still hold the ceiling at the transient itself.
  const ceiling = dbToLinear(-0.2);
  for (let i = transientAt - lookaheadSamples; i < transientAt + 400 && i < length; i += 1) {
    const index = Math.max(0, i);
    assert.ok(Math.abs(withLookahead.left[index]) <= ceiling + 1e-6, `lookahead output ${index} exceeded the ceiling`);
  }
});

test('the mode changes the master latency by exactly the lookahead', () => {
  const sampleRate = 48000;
  const lookaheadSamples = Math.round(sampleRate * 0.005);
  // A single impulse identifies the delay directly.
  const left = new Float32Array(4096);
  const right = new Float32Array(4096);
  left[100] = 0.5;
  right[100] = 0.5;
  const delayed = render(left, right, { sampleRate, lookaheadSamples });
  const direct = render(left, right, { sampleRate, lookaheadSamples: 0 });
  const firstNonZero = (data: Float32Array) => data.findIndex(value => Math.abs(value) > 1e-9);
  assert.equal(firstNonZero(direct.left), 100, 'direct mode adds no delay');
  assert.equal(firstNonZero(delayed.left), 100 + lookaheadSamples, 'lookahead mode delays by exactly the lookahead');
});

// ---------------------------------------------------------------------------
// Gain reduction + release
// ---------------------------------------------------------------------------

test('a loud transient reports measured gain reduction and a safe signal reports none', () => {
  const sampleRate = 48000;
  const loud = sine(sampleRate, 400, 1.6, sampleRate);
  const loudOut = render(loud, loud, { sampleRate });
  const loudPeak = Math.max(...loudOut.messages.map(message => message.peakReductionDb));
  assert.ok(loudPeak > 3, `a signal 4 dB over the ceiling must report real reduction (got ${loudPeak} dB)`);

  const safe = sine(sampleRate, 400, 0.3, sampleRate);
  const safeOut = render(safe, safe, { sampleRate });
  const safePeak = Math.max(...safeOut.messages.map(message => message.peakReductionDb));
  assert.ok(safePeak < 0.01, `safe material must report no reduction (got ${safePeak} dB)`);
});

test('the reported reduction matches the gain actually applied', () => {
  const sampleRate = 48000;
  const source = sine(sampleRate, 300, 1.5, sampleRate);
  const output = render(source, source, { sampleRate });
  const delay = Math.round(sampleRate * 0.005);
  const lastReport = output.messages[output.messages.length - 1];
  // Reconstruct the applied gain from the tail of the render.
  const appliedGain = appliedGainAt(source.subarray(delay), output.left.subarray(0, output.left.length - delay), sampleRate - delay - 64);
  const appliedDb = -20 * Math.log10(appliedGain);
  assert.ok(Number.isFinite(lastReport.reductionDb));
  assert.ok(
    Math.abs(appliedDb - lastReport.reductionDb) < 1.5,
    `reported ${lastReport.reductionDb} dB vs applied ${appliedDb} dB`,
  );
  assert.ok(appliedDb > 3, `the fixture must actually require limiting (${appliedDb} dB)`);
});

test('release recovers smoothly without a jump and returns to unity', () => {
  const sampleRate = 48000;
  const length = sampleRate;
  const burstEnd = Math.round(0.25 * sampleRate);
  const source = new Float32Array(length);
  for (let i = 0; i < burstEnd; i += 1) {
    source[i] = 1.8 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  for (let i = burstEnd; i < length; i += 1) {
    source[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
  const output = render(source, source, { sampleRate, releaseMs: 100 });
  const delay = Math.round(sampleRate * 0.005);
  // Per-sample gain through the release. `out = gain · in` exactly, so a sample
  // whose delayed input is well away from a zero crossing reads the applied
  // gain directly; consecutive such samples give the true sample-to-sample step.
  const quietAmplitude = 0.25;
  const isUsable = (i: number) => Math.abs(source[i - delay]) > quietAmplitude * 0.2;
  const gainAt = (i: number) => output.left[i] / source[i - delay];
  let maxStep = 0;
  let deepest = 1;
  let last = 1;
  let steps = 0;
  for (let i = burstEnd + 2 * delay; i < length; i += 1) {
    if (!isUsable(i)) continue;
    const gain = gainAt(i);
    if (Math.abs(gain) > 1.001) continue; // never amplified: skip decay-tail noise
    deepest = Math.min(deepest, gain);
    if (isUsable(i - 1)) {
      maxStep = Math.max(maxStep, Math.abs(gain - gainAt(i - 1)));
      steps += 1;
    }
    last = gain;
  }
  assert.ok(steps > 500, `the release window must contain measurable samples (${steps})`);
  assert.ok(maxStep < 0.01, `release must not step the gain (largest single-sample change ${maxStep})`);
  assert.ok(last > 0.97, `gain must return to unity after the burst (got ${last})`);
  // 1.8 FS against a -0.2 dBFS ceiling needs ~0.54 of gain: the burst is
  // limited, not squashed, and the assertion below the third one pins the
  // ceiling itself.
  assert.ok(deepest < 0.6, `the burst must have ducked first (deepest ${deepest})`);
});

test('a longer release recovers more slowly', () => {
  const sampleRate = 48000;
  const length = sampleRate;
  const burstEnd = Math.round(0.2 * sampleRate);
  const source = new Float32Array(length);
  for (let i = 0; i < burstEnd; i += 1) source[i] = 1.8 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  for (let i = burstEnd; i < length; i += 1) source[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  const delay = Math.round(sampleRate * 0.005);
  const fast = render(source, source, { sampleRate, releaseMs: 30 });
  const slow = render(source, source, { sampleRate, releaseMs: 400 });
  const probe = burstEnd + Math.round(0.05 * sampleRate);
  const gainFast = appliedGainAt(source.subarray(delay + probe - 64, delay + probe + 64), fast.left.subarray(probe - 64, probe + 64), 64, 64);
  const gainSlow = appliedGainAt(source.subarray(delay + probe - 64, delay + probe + 64), slow.left.subarray(probe - 64, probe + 64), 64, 64);
  assert.ok(gainFast > gainSlow + 0.05, `short release must recover sooner (${gainFast} vs ${gainSlow})`);
});

// ---------------------------------------------------------------------------
// Stereo, silence, edge cases
// ---------------------------------------------------------------------------

test('stereo is limited with one linked gain, preserving the balance', () => {
  const sampleRate = 48000;
  const left = sine(sampleRate, 200, 1.8, sampleRate);
  const right = sine(sampleRate, 200, 0.45, sampleRate);
  const output = render(left, right, { sampleRate });
  const ceiling = dbToLinear(-0.2);
  const leftPeak = peakOf(output.left.subarray(4096));
  const rightPeak = peakOf(output.right.subarray(4096));
  assert.ok(leftPeak <= ceiling + 1e-6, 'the loud channel is limited');
  // A linked gain means the quiet channel is attenuated by the same factor, so
  // the L/R ratio of the input survives the limiting.
  const inputRatio = 1.8 / 0.45;
  const outputRatio = leftPeak / rightPeak;
  assert.ok(Math.abs(outputRatio - inputRatio) / inputRatio < 0.02, `channel balance must survive (${outputRatio} vs ${inputRatio})`);
});

test('silence stays silent, finite and unreduced', () => {
  const sampleRate = 48000;
  const silence = new Float32Array(2048);
  const output = render(silence, silence, { sampleRate });
  assert.equal(peakOf(output.left), 0, 'silence in, silence out');
  assert.equal(peakOf(output.right), 0);
  const reported = output.messages.length ? Math.max(...output.messages.map(m => m.peakReductionDb)) : 0;
  assert.equal(reported, 0, 'silence reports no reduction');
});

test('short buffers smaller than the lookahead remain finite and silent', () => {
  const sampleRate = 48000;
  const source = sine(64, 500, 2, sampleRate);
  const output = render(source, source, { sampleRate, lookaheadSamples: 240 });
  assert.equal(output.left.length, 64);
  for (const value of output.left) assert.ok(Number.isFinite(value));
  assert.equal(peakOf(output.left), 0, 'nothing has left the delay line yet');
});

test('non-finite input never produces non-finite output', () => {
  const sampleRate = 48000;
  const left = new Float32Array(2048);
  const right = new Float32Array(2048);
  left.fill(0.5);
  right.fill(0.5);
  left[300] = Number.NaN;
  right[700] = Number.POSITIVE_INFINITY;
  left[1400] = Number.NEGATIVE_INFINITY;
  const output = render(left, right, { sampleRate });
  for (const value of output.left) assert.ok(Number.isFinite(value), 'left output stays finite');
  for (const value of output.right) assert.ok(Number.isFinite(value), 'right output stays finite');
  assert.ok(peakOf(output.left) <= dbToLinear(-0.2) + 1e-6);
});

test('extreme ceilings and releases stay bounded', () => {
  const sampleRate = 48000;
  const source = sine(4096, 300, 8, sampleRate);
  const output = render(source, source, { sampleRate, ceilingDb: -24, releaseMs: 2000 });
  for (const value of output.left) assert.ok(Number.isFinite(value));
  const settled = peakOf(output.left.subarray(2048));
  assert.ok(settled <= dbToLinear(-24) + 1e-6, `a -24 dB ceiling is respected (${settled})`);
});

test('processing is deterministic for identical input', () => {
  const sampleRate = 48000;
  const source = sine(8192, 440, 1.4, sampleRate);
  const first = render(source, source, { sampleRate });
  const second = render(source, source, { sampleRate });
  for (let i = 0; i < first.left.length; i += 1) {
    assert.equal(first.left[i], second.left[i], 'identical input must give identical samples');
  }
  assert.deepEqual(
    first.messages.map(m => m.peakReductionDb),
    second.messages.map(m => m.peakReductionDb),
    'and identical measurements',
  );
});

test('changing the lookahead mid-stream does not break the stream', () => {
  const sampleRate = 48000;
  const harness = createHarness({ sampleRate, lookaheadSamples: 240 });
  const source = sine(BLOCK * 40, 300, 1.4, sampleRate);
  const collected: number[] = [];
  for (let start = 0; start < source.length; start += BLOCK) {
    const block = new Float32Array(BLOCK);
    block.set(source.subarray(start, start + BLOCK));
    if (start === BLOCK * 10) harness.parameters.lookaheadSamples = Float32Array.of(0);
    if (start === BLOCK * 20) harness.parameters.lookaheadSamples = Float32Array.of(480);
    const out = harness.processBlock(block, block);
    for (const value of out.left) {
      assert.ok(Number.isFinite(value), 'a mode change must not emit garbage');
      collected.push(value);
    }
  }
  assert.ok(collected.length > 0);
  assert.ok(peakOf(Float32Array.from(collected)) <= dbToLinear(-0.2) + 1e-6, 'the ceiling holds across a mode change');
});
