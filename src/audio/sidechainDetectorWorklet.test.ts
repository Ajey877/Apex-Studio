import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDECHAIN_DETECTOR_PROCESSOR,
  SIDECHAIN_DETECTOR_SOURCE,
} from './sidechainDetectorWorklet';

/**
 * Phase 9A — signal-level tests for the real sidechain detector.
 *
 * The processor source that the browser runs is executed here verbatim in a
 * minimal AudioWorklet host: the source string is compiled with stub
 * `AudioWorkletProcessor` / `registerProcessor` / `sampleRate` globals, then
 * driven block-by-block with actual sample data. The assertions read the gain
 * signal the processor produces (the same signal that drives the destination's
 * `duckingGain` AudioParam), so they measure DSP behaviour rather than the
 * shape of a parameter assignment.
 */

const SAMPLE_RATE = 48000;
const BLOCK = 128;

interface DetectorParams {
  thresholdDb?: number;
  ratio?: number;
  maxReductionDb?: number;
  attackMs?: number;
  releaseMs?: number;
}

interface MeterMessage {
  reductionDb: number;
  gain: number;
}

const loadProcessor = () => {
  const messages: MeterMessage[] = [];
  let ProcessorClass: (new () => {
    process: (
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ) => boolean;
  }) | null = null;

  class AudioWorkletProcessorStub {
    port: { postMessage: (message: MeterMessage) => void; onmessage: unknown };
    constructor() {
      this.port = {
        postMessage: (message: MeterMessage) => {
          messages.push(message);
        },
        onmessage: null,
      };
    }
  }

  const registerProcessor = (name: string, processor: unknown) => {
    if (name === SIDECHAIN_DETECTOR_PROCESSOR) ProcessorClass = processor as typeof ProcessorClass;
  };

  // eslint-disable-next-line no-new-func
  new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    SIDECHAIN_DETECTOR_SOURCE,
  )(AudioWorkletProcessorStub, registerProcessor, SAMPLE_RATE);

  assert.ok(ProcessorClass, 'the worklet source registers its processor');
  const instance = new ProcessorClass!();
  const parameters: Record<string, Float32Array> = {
    thresholdDb: Float32Array.of(-18),
    ratio: Float32Array.of(4),
    maxReductionDb: Float32Array.of(12),
    attackMs: Float32Array.of(5),
    releaseMs: Float32Array.of(140),
  };
  return { instance, parameters, messages };
};

/** Runs the detector over a generated signal and returns the applied gain per sample. */
const runDetector = (
  blocks: number,
  signal: (sampleIndex: number) => number,
  params: DetectorParams = {},
) => {
  const { instance, parameters, messages } = loadProcessor();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) parameters[name] = Float32Array.of(value);
  }
  const gains = new Float32Array(blocks * BLOCK);
  for (let block = 0; block < blocks; block += 1) {
    const input = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i += 1) {
      input[i] = signal(block * BLOCK + i);
    }
    const output = [new Float32Array(BLOCK)];
    instance.process([[input]], [output], parameters);
    gains.set(output[0], block * BLOCK);
  }
  return { gains, messages };
};

const sine = (amplitude: number, frequency = 220) => (sampleIndex: number) =>
  amplitude * Math.sin((2 * Math.PI * frequency * sampleIndex) / SAMPLE_RATE);

const blocksForSeconds = (seconds: number) => Math.ceil((seconds * SAMPLE_RATE) / BLOCK);

const minGain = (gains: Float32Array) => gains.reduce((min, value) => Math.min(min, value), Infinity);
const maxGain = (gains: Float32Array) => gains.reduce((max, value) => Math.max(max, value), -Infinity);

test('sub-threshold audio causes no material attenuation', () => {
  // -26 dBFS source against a -18 dBFS threshold: the detector must not duck.
  const { gains, messages } = runDetector(blocksForSeconds(0.5), sine(0.05), {
    thresholdDb: -18,
    ratio: 4,
    attackMs: 1,
    releaseMs: 40,
  });
  const floor = minGain(gains);
  assert.ok(floor > 0.999, `expected unity gain below threshold, got ${floor}`);
  assert.ok(
    messages.every(message => message.reductionDb < 0.05),
    'the measured reduction stays at 0 dB below threshold',
  );
});

test('above-threshold audio produces the documented ratio reduction', () => {
  // 0.5 peak = -6.02 dBFS, threshold -30 dB, ratio 4 -> 17.98 dB of reduction.
  const amplitude = 0.5;
  const levelDb = 20 * Math.log10(amplitude);
  const expectedReductionDb = Math.min(24, (levelDb - -30) * (1 - 1 / 4));
  const { gains } = runDetector(blocksForSeconds(0.6), sine(amplitude), {
    thresholdDb: -30,
    ratio: 4,
    maxReductionDb: 24,
    attackMs: 2,
    releaseMs: 100,
  });
  const settledGain = minGain(gains.subarray(gains.length - BLOCK * 20));
  const measuredReductionDb = -20 * Math.log10(settledGain);
  assert.ok(
    Math.abs(measuredReductionDb - expectedReductionDb) < 0.5,
    `expected ~${expectedReductionDb.toFixed(2)} dB reduction, measured ${measuredReductionDb.toFixed(2)} dB`,
  );
});

test('a louder source produces more reduction with identical settings', () => {
  const settings: DetectorParams = { thresholdDb: -36, ratio: 20, maxReductionDb: 30, attackMs: 1, releaseMs: 60 };
  const quiet = runDetector(blocksForSeconds(0.5), sine(0.1), settings).gains;
  const loud = runDetector(blocksForSeconds(0.5), sine(0.4), settings).gains;
  const quietReductionDb = -20 * Math.log10(minGain(quiet.subarray(quiet.length - BLOCK * 10)));
  const loudReductionDb = -20 * Math.log10(minGain(loud.subarray(loud.length - BLOCK * 10)));
  assert.ok(loudReductionDb > quietReductionDb + 3, `louder input must duck more (${loudReductionDb.toFixed(2)} vs ${quietReductionDb.toFixed(2)} dB)`);
});

test('the duck depth ceiling limits reduction and the ratio changes the slope', () => {
  const deep = runDetector(blocksForSeconds(0.5), sine(0.5), {
    thresholdDb: -40, ratio: 20, maxReductionDb: 6, attackMs: 1, releaseMs: 60,
  }).gains;
  const deepReductionDb = -20 * Math.log10(minGain(deep.subarray(deep.length - BLOCK * 10)));
  assert.ok(Math.abs(deepReductionDb - 6) < 0.4, `maxReductionDb caps the duck at 6 dB, measured ${deepReductionDb.toFixed(2)}`);

  const gentle = runDetector(blocksForSeconds(0.5), sine(0.5), {
    thresholdDb: -40, ratio: 2, maxReductionDb: 30, attackMs: 1, releaseMs: 60,
  }).gains;
  const steep = runDetector(blocksForSeconds(0.5), sine(0.5), {
    thresholdDb: -40, ratio: 10, maxReductionDb: 30, attackMs: 1, releaseMs: 60,
  }).gains;
  const gentleReductionDb = -20 * Math.log10(minGain(gentle.subarray(gentle.length - BLOCK * 10)));
  const steepReductionDb = -20 * Math.log10(minGain(steep.subarray(steep.length - BLOCK * 10)));
  assert.ok(steepReductionDb > gentleReductionDb + 3, 'a higher ratio must duck further');
});

test('attack and release shape the measured envelope', () => {
  const signal = (index: number) => (index < SAMPLE_RATE * 0.25 ? sine(0.6)(index) : 0);
  const fastAttack = runDetector(blocksForSeconds(0.5), signal, {
    thresholdDb: -30, ratio: 8, maxReductionDb: 24, attackMs: 1, releaseMs: 200,
  }).gains;
  const slowAttack = runDetector(blocksForSeconds(0.5), signal, {
    thresholdDb: -30, ratio: 8, maxReductionDb: 24, attackMs: 40, releaseMs: 200,
  }).gains;

  const atTwentyMs = Math.round(0.02 * SAMPLE_RATE);
  assert.ok(fastAttack[atTwentyMs] < slowAttack[atTwentyMs] - 0.02, 'a faster attack must clamp down sooner');

  const fastRelease = runDetector(blocksForSeconds(1), signal, {
    thresholdDb: -30, ratio: 8, maxReductionDb: 24, attackMs: 1, releaseMs: 30,
  }).gains;
  const slowRelease = runDetector(blocksForSeconds(1), signal, {
    thresholdDb: -30, ratio: 8, maxReductionDb: 24, attackMs: 1, releaseMs: 400,
  }).gains;
  const releaseCheckSample = Math.round(SAMPLE_RATE * 0.4);
  assert.ok(fastRelease[releaseCheckSample] > slowRelease[releaseCheckSample] + 0.05, 'a shorter release must recover sooner');
});

test('a sustained source holds a steady duck and silence returns to unity', () => {
  const sustained = runDetector(blocksForSeconds(0.8), sine(0.5), {
    thresholdDb: -30, ratio: 4, maxReductionDb: 18, attackMs: 5, releaseMs: 100,
  }).gains;
  const window = sustained.subarray(Math.round(0.4 * SAMPLE_RATE), Math.round(0.75 * SAMPLE_RATE));
  assert.ok(maxGain(window) - minGain(window) < 0.002, 'the duck is stable for a sustained note');

  const decay = runDetector(blocksForSeconds(1.2), index => (index < SAMPLE_RATE * 0.25 ? sine(0.5)(index) : 0), {
    thresholdDb: -30, ratio: 4, maxReductionDb: 18, attackMs: 2, releaseMs: 60,
  }).gains;
  assert.ok(decay[decay.length - 1] > 0.995, 'gain returns to unity after the source stops');
});

test('the applied gain is finite, bounded and deterministic', () => {
  const render = () => runDetector(blocksForSeconds(0.4), sine(0.9), {
    thresholdDb: -24, ratio: 12, maxReductionDb: 20, attackMs: 3, releaseMs: 80,
  }).gains;
  const first = render();
  const second = render();
  for (let i = 0; i < first.length; i += 1) {
    assert.ok(Number.isFinite(first[i]), 'gain must be finite');
    assert.ok(first[i] >= 0 && first[i] <= 1, `gain must stay inside [0,1], saw ${first[i]}`);
    assert.equal(first[i], second[i], 'identical input must produce an identical envelope');
  }
});

test('meter messages report the measured gain reduction', () => {
  const { gains, messages } = runDetector(blocksForSeconds(0.5), sine(0.5), {
    thresholdDb: -30, ratio: 4, maxReductionDb: 18, attackMs: 2, releaseMs: 80,
  });
  assert.ok(messages.length > 5, 'the detector reports periodically');
  const last = messages[messages.length - 1];
  const expected = -20 * Math.log10(last.gain);
  assert.ok(Number.isFinite(last.reductionDb));
  assert.ok(Math.abs(last.reductionDb - expected) < 1e-6, 'reported dB is derived from the applied gain');
  const finalGain = gains[gains.length - 1];
  assert.ok(Math.abs(last.reductionDb + 20 * Math.log10(finalGain)) < 0.6, 'the meter follows the real envelope');
});

test('silence with no input connected settles at unity', () => {
  const { gains } = runDetector(blocksForSeconds(0.3), () => 0, { thresholdDb: -60, ratio: 20, maxReductionDb: 30 });
  assert.ok(minGain(gains) > 0.9999, 'an empty detector input must never attenuate the destination');
});
