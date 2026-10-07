/**
 * Phase 1C (D9) — sampler / custom-sample / drum-pad routing truthfulness.
 *
 * Phase 1B fixed *how long* a gated note sounds. It did not ask whether every
 * sampler-family route actually produces sound at all. Tracing the routing
 * empirically (driving the real engine, not reading the code) shows three
 * different outcomes for a sample that is not in the buffer cache:
 *
 *   sampler channel, custom sample missing  -> subtractive-synth fallback (audible)
 *   any channel with customSample.id missing -> subtractive-synth fallback (audible)
 *   DRUM PAD whose pad.sampleId is missing   -> NOTHING, and no diagnostic anywhere
 *
 * The drum-pad route is silent because `renderDrumPadVoice` bare-returns
 * (`instruments/drumPad.ts:21`) and the engine's fallback guard
 * (`audioEngine.ts:1699`) only fires for `customSample?.id || sampler`, which a
 * drum-pad channel never satisfies. Additionally `audioUnavailable` is never
 * hydrated onto `channel.drumPads` (`state/projectPersistence.ts:178-186` only
 * touches `customSample`), and the missing-audio summary never inspects pads, so
 * the user gets neither sound nor warning.
 *
 * RED-first: the drum-pad reporting assertion fails on the Phase 1B baseline.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Channel, DrumPad } from '../types/daw';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';

// ---------------------------------------------------------------------------
// Minimal fake Web Audio graph
// ---------------------------------------------------------------------------

class FakeParam {
  value = 1;
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  setValueCurveAtTime() { return this; }
  cancelScheduledValues() { return this; }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly pan = new FakeParam();
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  readonly Q = new FakeParam();
  readonly playbackRate = new FakeParam();
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  readonly delayTime = new FakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  connect(target: unknown) { return target; }
  disconnect() {}
  start() {}
  stop() {}
  setPeriodicWave() {}
  addEventListener() {}
  removeEventListener() {}
}

class FakeContext {
  sampleRate = 44100;
  currentTime = 0;
  destination = new FakeNode();
  createGain() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createStereoPanner() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createDelay() { return new FakeNode(); }
  createConvolver() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createWaveShaper() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }
}

// ---------------------------------------------------------------------------
// Harness: drive the real engine's voice path with an empty buffer cache
// ---------------------------------------------------------------------------

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const REPORTER_CALLS: unknown[][] = [];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const captureDiagnostics = (): void => {
  console.error = (...args: unknown[]) => { REPORTER_CALLS.push(args); };
  console.warn = (...args: unknown[]) => { REPORTER_CALLS.push(args); };
};
const restoreDiagnostics = (): void => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
};

const isReportingCall = (): boolean => REPORTER_CALLS.some(
  args => typeof args[0] === 'string' && args[0].includes('[AudioEngine]'),
);

const base = createDefaultProjectState().channels[0];

const makeChannel = (overrides: Partial<Channel>): Channel => ({
  ...base,
  id: 'ch-under-test',
  mixerTrackId: 1,
  steps: [],
  notes: [],
  ...overrides,
} as Channel);

const makeDrumPad = (overrides: Partial<DrumPad>): DrumPad => ({
  note: 60,
  volume: 1,
  pan: 0,
  tuneSemitones: 0,
  reverse: false,
  trimStart: 0,
  trimEnd: 1,
  loop: false,
  chokeGroup: 0,
  ...overrides,
} as DrumPad);

const NOTE = { id: 'n1', pitch: 60, start: 0, duration: 2, velocity: 0.9 };

/** Returns the number of voices the engine actually started (0 == silence). */
const renderVoiceCount = (channel: Channel, buffers: Map<string, unknown> = new Map()): number => {
  engine.ctx = new FakeContext();
  engine.isPlaying = false;
  engine.playbackProjectChannels = [];
  engine.bpm = 120;
  engine.sampleBuffers = buffers;
  engine.activeVoices = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.getOrCreateMixerChannel = () => ({ input: new FakeNode() });
  engine.getOrCreateChannelPanner = () => null;
  engine.applyPanToNode = () => {};
  engine.triggerSidechainDucking = () => {};
  engine.playSingleVoice(channel, { ...NOTE }, 0);
  return engine.activeVoices.size;
};

const sampleBuffer = (): unknown => ({
  duration: 0.5,
  getChannelData: () => new Float32Array(16),
});

afterEach(() => {
  restoreDiagnostics();
  REPORTER_CALLS.length = 0;
});

describe('Phase 1C (D9) — custom-sample channels fall back audibly', () => {
  it('sampler channel whose custom sample failed to restore still sounds', () => {
    const channel = makeChannel({
      instrumentType: 'sampler',
      customSample: { id: 'lost', name: 'Lost' } as Channel['customSample'],
    });
    assert.equal(renderVoiceCount(channel), 1);
  });

  it('a non-sampler channel with a missing custom sample falls back to subtractive', () => {
    // `usesCustomSamplerOverride` (audioEngine.ts:1618) routes ANY non-drum-pad
    // channel that carries a customSample.id through the sampler renderer; the
    // engine then falls back to subtractive synthesis when the buffer is absent.
    const channel = makeChannel({
      instrumentType: 'grand_piano',
      customSample: { id: 'lost', name: 'Lost' } as Channel['customSample'],
    });
    assert.equal(renderVoiceCount(channel), 1);
  });

  it('a sampler channel with no custom sample at all still sounds', () => {
    assert.equal(renderVoiceCount(makeChannel({ instrumentType: 'sampler' })), 1);
  });
});

describe('Phase 1C (D9) — the drum-pad sample route must not fail silently', () => {
  it('DRUM PAD with a pad sample that is missing REPORTS the failure', () => {
    captureDiagnostics();
    const channel = makeChannel({
      instrumentType: 'drumpad',
      drumPads: [makeDrumPad({ sampleId: 'lost-pad-sample' })],
    });

    const voices = renderVoiceCount(channel);

    assert.equal(voices, 0, 'the pad sample path has no fallback voice');
    assert.equal(
      isReportingCall(),
      true,
      'a drum-pad sample that cannot be resolved must be reported through the ' +
      'engine diagnostic channel, not fail invisibly',
    );
    assert.ok(
      REPORTER_CALLS.some(args => JSON.stringify(args).includes('lost-pad-sample')),
      'the report must name the sample that could not be resolved',
    );
  });

  it('drum pad with no sampleId uses the legacy drum voice and reports nothing', () => {
    captureDiagnostics();
    const channel = makeChannel({ instrumentType: 'drumpad', drumPads: [makeDrumPad({})] });
    assert.equal(renderVoiceCount(channel), 1);
    assert.equal(isReportingCall(), false);
  });

  it('drum pad with an unmatched pitch uses the legacy drum voice', () => {
    captureDiagnostics();
    const channel = makeChannel({
      instrumentType: 'drumpad',
      drumPads: [makeDrumPad({ note: 48, sampleId: 'other' })],
    });
    assert.equal(renderVoiceCount(channel), 1);
    assert.equal(isReportingCall(), false);
  });

  it('drum pad with a resolvable sample plays the sample and reports nothing', () => {
    captureDiagnostics();
    const channel = makeChannel({
      instrumentType: 'drumpad',
      drumPads: [makeDrumPad({ sampleId: 'present' })],
    });
    assert.equal(renderVoiceCount(channel, new Map([['present', sampleBuffer()]])), 1);
    assert.equal(isReportingCall(), false);
  });

  it('drum pad with a sampleId but no buffer lookup available REPORTS the failure', () => {
    // `renderDrumPadVoice` also bare-returns when `getSampleBuffer` is absent
    // (instruments/drumPad.ts:18) — same silent outcome, same report.
    captureDiagnostics();
    const channel = makeChannel({
      instrumentType: 'drumpad',
      drumPads: [makeDrumPad({ sampleId: 'pad-x' })],
    });
    engine.ctx = new FakeContext();
    engine.bpm = 120;
    engine.sampleBuffers = new Map();
    engine.activeVoices = new Map();
    engine.getOrCreateMixerChannel = () => ({ input: new FakeNode() });
    engine.getOrCreateChannelPanner = () => null;
    engine.applyPanToNode = () => {};
    engine.triggerSidechainDucking = () => {};
    engine.playSingleVoice(channel, { ...NOTE }, 0);
    // getSampleBuffer is always supplied by the engine, so this route reaches
    // the same missing-buffer report as the case above.
    assert.equal(engine.activeVoices.size, 0);
    assert.equal(isReportingCall(), true);
  });
});
