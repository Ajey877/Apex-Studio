/**
 * Phase 1F — Truthful 3/4 time signature runtime: engine, transport,
 * scheduler, offline render and bounce parity.
 *
 * Core invariant of this phase: for supported meters the runtime bar size is
 * `stepsPerBar(project.meta.timeSignature)` — 3/4 is 12 sixteenth-note steps
 * and 1.5 seconds per bar at 120 BPM. Live playback, production offline
 * rendering and bounce must all agree on that grid. Phase 1E's content-extent
 * rule (note tails never expand the loop) survives unchanged.
 *
 * Every behavioural assertion drives the production playback path through a
 * fake AudioContext clock with manually pumped transport timers, exactly like
 * `audioEngine.transport.test.ts`, so results are deterministic.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';
import { audioEngine } from './audioEngine';
import type { Channel, PlaylistClip } from '../types/daw';

const STEP_SECONDS_AT_120_BPM = 0.125;

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  setTargetAtTime(): void {}
  linearRampToSeconds(): void {}
  exponentialRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect(): void {}
  disconnect(): void {}
}

class FakePannerNode {
  pan = new FakeAudioParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeAnalyserNode {
  fftSize = 256;
  smoothingTimeConstant = 0.7;
  connect(): void {}
  disconnect(): void {}
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  detune = new FakeAudioParam();
  playbackRate = new FakeAudioParam();
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
  connect(): void {}
}

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';

  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }

  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
}

/** Minimal OfflineAudioContext mock (same approach as audioEngine.phase10b.offline.test.ts). */
class MockOfflineAudioContext {
  readonly destination = { connect: () => {} };
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  currentTime = 0;

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain() { return { gain: { setValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }, connect: () => {}, disconnect: () => {} }; }
  createStereoPanner() { return { pan: { setValueAtTime() {}, setTargetAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.7, connect: () => {}, disconnect: () => {}, getFloatTimeDomainData() {} }; }
  createBufferSource() { return { buffer: null, start() {}, stop() {}, connect: () => {}, disconnect: () => {} }; }
  createOscillator() { return { frequency: { setValueAtTime() {} }, start() {}, stop() {}, connect: () => {}, disconnect: () => {} }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 1 }, gain: { setValueAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createDelay() { return { delayTime: { setValueAtTime() {} }, connect: () => {}, disconnect: () => {} }; }
  createConvolver() { return { buffer: null, normalize: true, connect: () => {}, disconnect: () => {} }; }
  createWaveShaper() { return { curve: null, oversample: 'none', connect: () => {}, disconnect: () => {} }; }
  createDynamicsCompressor() { return { threshold: { value: 0 }, ratio: { value: 1 }, attack: { value: 0 }, release: { value: 0 }, reduction: 0, connect: () => {}, disconnect: () => {} }; }
  createBuffer(_c: number, len: number, _sr: number) {
    return {
      numberOfChannels: 1,
      length: len,
      sampleRate: 44100,
      duration: len / 44100,
      getChannelData: () => new Float32Array(len),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
  async startRendering() {
    return {
      numberOfChannels: 2,
      length: Math.max(1, this.length),
      sampleRate: this.sampleRate,
      duration: Math.max(1, this.length) / this.sampleRate,
      getChannelData: () => new Float32Array(Math.max(1, this.length)),
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }
}

type TimerCallback = () => void;
type EngineInternals = Record<string, any>;

const engine = audioEngine as unknown as EngineInternals;

const realWindow = (globalThis as any).window;
let timers: TimerCallback[] = [];
let savedInternals: EngineInternals = {};
let originalPlayNote: unknown;
let prevOfflineCtx: unknown;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'isPlaying',
  'bpm', 'swing', 'meter', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'masterGain', 'mixerChannels', 'isOfflineRendering', 'offlineRenderLeaseHeld',
  'playlistLaneMutes'
];

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (callback: TimerCallback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
  };

  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  originalPlayNote = engine.playNote;
  prevOfflineCtx = (globalThis as any).OfflineAudioContext;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  (globalThis as any).OfflineAudioContext = prevOfflineCtx;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
});

const makeChannel = (id: string, activeSteps: number[], totalSteps = 16, notes: Channel['notes'] = []): Channel => {
  const steps = new Array(totalSteps).fill(false);
  for (const step of activeSteps) steps[step] = true;
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'drumpad',
    mixerTrackId: 1,
    volume: 0.9,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes,
    synthParams: {} as any
  };
};

const makePatternClip = (id: string, channelId: string, startBar: number, lengthBars: number): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'pattern',
  channelId,
  color: '#ff6e00',
  name: id
});

interface Take {
  fakeCtx: FakeAudioContext;
  transport: AudioClockTransport;
  triggered: Array<{ step: number; time: number; bar: number }>;
  reported: Array<{ step: number; bar: number }>;
}

/**
 * Starts a take through the real `audioEngine.play()` entrypoint using a fake
 * clock. The project meter is published to the engine exactly the way App.tsx
 * publishes it (`setTimeSignature`), before the take starts.
 */
const startTake = (options: {
  channels: Channel[];
  clips?: PlaylistClip[];
  mode?: 'pat' | 'song';
  patternLengthSteps?: number;
  meter?: [number, number];
}): Take => {
  timers = [];
  const fakeCtx = new FakeAudioContext();
  const transport = new AudioClockTransport(fakeCtx as unknown as AudioContext, {
    lookAheadSeconds: 0.1,
    scheduleIntervalMs: 25
  });

  engine.ctx = fakeCtx;
  engine.transport = transport;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);
  if (options.meter) {
    assert.equal(typeof engine.setTimeSignature, 'function', 'the engine must expose setTimeSignature');
    engine.setTimeSignature(options.meter);
  }

  const triggered: Take['triggered'] = [];
  const reported: Take['reported'] = [];

  engine.playNote = (_channel: Channel, note: { start: number }, time?: number) => {
    triggered.push({ step: note.start, time: time ?? 0, bar: engine.currentBar });
  };
  engine.setStepCallback((step: number, bar: number) => reported.push({ step, bar }));

  engine.play(
    options.channels,
    options.clips ?? [],
    options.mode ?? 'song',
    'pat-1',
    [],
    options.patternLengthSteps
  );

  return { fakeCtx, transport, triggered, reported };
};

/** Advances the fake clock `steps` step boundaries, pumping transport timers. */
const pumpSteps = (fakeCtx: FakeAudioContext, steps: number): void => {
  const startTick = Math.round(fakeCtx.currentTime / STEP_SECONDS_AT_120_BPM);
  for (let tick = startTick; tick <= startTick + steps; tick += 1) {
    fakeCtx.currentTime = tick * STEP_SECONDS_AT_120_BPM;
    const pending = timers;
    timers = [];
    for (const callback of pending) callback();
  }
};

const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9;

// ---------------------------------------------------------------------------
// TEST A / TEST M — 4/4 runtime behaviour is unchanged
// ---------------------------------------------------------------------------
describe('Phase 1F TEST A/M — 4/4 runtime unchanged', () => {
  it('TEST A: 120 BPM 4/4 keeps 16 steps and a 2.0 s bar', () => {
    const channel = makeChannel('ch-44', [0]);
    const clip = makePatternClip('clip-44', 'ch-44', 1, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song' });

    assert.equal(take.transport.getState().beatsPerBar, 4, 'default transport meter stays 4/4');
    pumpSteps(take.fakeCtx, 20);
    const first = take.triggered[0];
    assert.ok(first, 'the clip must trigger');
    assert.ok(closeTo(first.time, 2.0), `startBar 1 at ${first.time}s, expected 2.0s (16 steps)`);
  });

  it('TEST M: a 4/4 arrangement ends after 16 steps per bar', () => {
    const channel = makeChannel('ch-44-end', [0]);
    const clip = makePatternClip('clip-44-end', 'ch-44-end', 0, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song' });

    pumpSteps(take.fakeCtx, 20);
    const state = take.transport.getState();
    assert.equal(state.playing, false, 'a 1-bar 4/4 song must stop at its end');
    assert.ok(closeTo(state.positionSeconds, 2.0), `song end at ${state.positionSeconds}s, expected 2.0s`);
  });

  it('TEST M: 4/4 bar boundaries stay on the 16-step grid', () => {
    const channel = makeChannel('ch-44-grid', [0], 32);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 32 });

    pumpSteps(take.fakeCtx, 33);
    assert.deepEqual(take.reported[0], { step: 0, bar: 1 });
    assert.deepEqual(take.reported[15], { step: 15, bar: 1 });
    assert.deepEqual(take.reported[16], { step: 16, bar: 2 });
    assert.deepEqual(take.reported[32], { step: 0, bar: 3 });
  });
});

// ---------------------------------------------------------------------------
// TEST B — 3/4 runtime step count
// ---------------------------------------------------------------------------
describe('Phase 1F TEST B — 3/4 step count in the runtime', () => {
  it('a one-bar 3/4 clip spans 12 steps for the song scheduler', () => {
    const channel = makeChannel('ch-34', [0], 12);
    const clip = makePatternClip('clip-34', 'ch-34', 0, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song', meter: [3, 4] });

    const endSteps = engine.resolveSongEndSteps();
    assert.equal(endSteps, 12, `song end ${endSteps} steps, expected 12 for one 3/4 bar`);
    assert.equal(take.transport.getState().beatsPerBar, 3, '3/4 transport reports 3 beats per bar');
  });
});

// ---------------------------------------------------------------------------
// TEST C — 3/4 bar duration at runtime
// ---------------------------------------------------------------------------
describe('Phase 1F TEST C — a 3/4 bar lasts 1.5 s at 120 BPM', () => {
  it('a one-bar 3/4 arrangement ends at 1.5 s, not 2.0 s', () => {
    const channel = makeChannel('ch-34-dur', [0], 12);
    const clip = makePatternClip('clip-34-dur', 'ch-34-dur', 0, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song', meter: [3, 4] });

    pumpSteps(take.fakeCtx, 20);
    const state = take.transport.getState();
    assert.equal(state.playing, false, 'a 1-bar 3/4 song must stop at its end');
    assert.ok(closeTo(state.positionSeconds, 1.5), `song end at ${state.positionSeconds}s, expected 1.5s`);
  });
});

// ---------------------------------------------------------------------------
// TEST D — 3/4 scheduler bar boundaries
// ---------------------------------------------------------------------------
describe('Phase 1F TEST D — 3/4 scheduler boundaries', () => {
  it('step 11 stays in bar 1, step 12 opens bar 2, step 24 opens bar 3', () => {
    const channel = makeChannel('ch-34-grid', [0], 24);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 24, meter: [3, 4] });

    pumpSteps(take.fakeCtx, 25);
    assert.deepEqual(take.reported[0], { step: 0, bar: 1 }, 'step 0 begins bar 1');
    assert.deepEqual(take.reported[11], { step: 11, bar: 1 }, 'step 11 remains inside bar 1');
    assert.deepEqual(take.reported[12], { step: 12, bar: 2 }, 'step 12 begins bar 2');
    assert.deepEqual(take.reported[23], { step: 23, bar: 2 }, 'step 23 remains inside bar 2');
    assert.deepEqual(take.reported[24], { step: 0, bar: 3 }, 'step 24 begins bar 3');
  });
});

// ---------------------------------------------------------------------------
// TEST E — a 12-step pattern loops after 12 steps in 3/4
// ---------------------------------------------------------------------------
describe('Phase 1F TEST E — 3/4 pattern loop', () => {
  it('a 12-step pattern wraps at step 12', () => {
    const channel = makeChannel('ch-34-loop', [0, 11], 12);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 12, meter: [3, 4] });

    pumpSteps(take.fakeCtx, 13);
    assert.equal(take.reported.length >= 13, true, 'at least 13 steps must be reported');
    assert.deepEqual(take.reported[11], { step: 11, bar: 1 }, 'step 11 closes the first 3/4 bar');
    assert.deepEqual(take.reported[12], { step: 0, bar: 2 }, 'the loop wraps to step 0 in bar 2');

    const stepZeroHits = take.triggered.filter(hit => hit.step === 0);
    assert.equal(stepZeroHits.length, 2, 'step 0 must trigger on both passes');
    assert.ok(closeTo(stepZeroHits[1].time, 12 * STEP_SECONDS_AT_120_BPM), 'second pass starts at step 12');
  });
});

// ---------------------------------------------------------------------------
// TEST F — 3/4 Song scheduling
// ---------------------------------------------------------------------------
describe('Phase 1F TEST F — Song mode uses 12-step bars in 3/4', () => {
  it('a 2-bar 3/4 clip repeats its content every 12 steps and ends at step 24', () => {
    const channel = makeChannel('ch-34-song', [5], 12);
    const clip = makePatternClip('clip-34-song', 'ch-34-song', 0, 2);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song', meter: [3, 4] });

    pumpSteps(take.fakeCtx, 26);
    assert.equal(take.triggered.length, 2, `expected 2 triggers, got ${take.triggered.length}`);
    assert.ok(closeTo(take.triggered[0].time, 5 * STEP_SECONDS_AT_120_BPM), 'first hit at step 5');
    assert.ok(closeTo(take.triggered[1].time, 17 * STEP_SECONDS_AT_120_BPM), 'second hit at step 17 (5 + 12), not 21 (5 + 16)');

    const state = take.transport.getState();
    assert.equal(state.playing, false, 'the arrangement ends after 2 bars');
    assert.ok(closeTo(state.positionSeconds, 3.0), `song end at ${state.positionSeconds}s, expected 3.0s (2 × 1.5s)`);
  });
});

// ---------------------------------------------------------------------------
// TEST I — playlist positioning: startBar 1 = 12 steps in 3/4
// ---------------------------------------------------------------------------
describe('Phase 1F TEST I — playlist positioning in 3/4', () => {
  it('a clip at startBar 1 triggers 12 steps (1.5 s) after the origin', () => {
    const channel = makeChannel('ch-34-start', [0], 1);
    const clip = makePatternClip('clip-34-start', 'ch-34-start', 1, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song', meter: [3, 4] });

    pumpSteps(take.fakeCtx, 26);
    assert.ok(take.triggered.length >= 1, 'the clip must trigger');
    assert.ok(
      closeTo(take.triggered[0].time, 1.5),
      `startBar 1 triggered at ${take.triggered[0].time}s, expected 1.5s (12 steps)`
    );
  });
});

// ---------------------------------------------------------------------------
// TEST G — production offline rendering parity
// ---------------------------------------------------------------------------
describe('Phase 1F TEST G — offline render uses the same 12-step bar', () => {
  it('a 2-bar 3/4 song renders 3.0 s and schedules 24 steps', async () => {
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    engine.setTimeSignature([3, 4]);
    engine.bpm = 120;
    engine.setSwing(0);

    const channel = makeChannel('ch-34-offline', [0, 5], 12);
    const clip = makePatternClip('clip-34-offline', 'ch-34-offline', 0, 2);

    const hitTimes: number[] = [];
    engine.playNote = (_channel: Channel, _note: { start: number }, time?: number) => { hitTimes.push(time ?? 0); };

    const buffer = await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [],
      120,
      2,
      44100,
      false,
      'song',
      undefined,
      undefined,
      [],
      0
    );

    assert.ok(closeTo(buffer.duration, 3.0), `rendered ${buffer.duration}s, expected 3.0s (2 × 1.5s bars)`);
    // Content repeats every 12 steps: hits at global steps 0/5 and 12/17.
    const has = (step: number) => hitTimes.some(t => closeTo(t, step * STEP_SECONDS_AT_120_BPM));
    assert.ok(has(0), 'offline schedules the bar 1 downbeat');
    assert.ok(has(12), 'offline schedules step 12 (bar 2 downbeat)');
    assert.ok(!has(16), 'offline must not use the 16-step grid in 3/4');
  });

  it('a 2-bar 4/4 song still renders 4.0 s', async () => {
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    engine.setTimeSignature([4, 4]);
    engine.bpm = 120;
    engine.setSwing(0);

    const channel = makeChannel('ch-44-offline', [0], 16);
    const clip = makePatternClip('clip-44-offline', 'ch-44-offline', 0, 2);

    const buffer = await audioEngine.renderTimelineOffline(
      [channel],
      [clip],
      [],
      120,
      2,
      44100,
      false,
      'song',
      undefined,
      undefined,
      [],
      0
    );

    assert.ok(closeTo(buffer.duration, 4.0), `rendered ${buffer.duration}s, expected 4.0s (2 × 2.0s bars)`);
  });
});

// ---------------------------------------------------------------------------
// TEST H — bounce parity
// ---------------------------------------------------------------------------
describe('Phase 1F TEST H — bounce uses the same bar duration', () => {
  it('bouncing 12 steps of 3/4 content produces a 1.5 s stem', async () => {
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    engine.setTimeSignature([3, 4]);
    engine.bpm = 120;
    engine.setSwing(0);

    const channel = makeChannel('ch-34-bounce', [0], 12);
    const result = await audioEngine.bounceChannelToAudioClip(channel, 120, 1);
    assert.equal(result.lengthBars, 1, 'one 3/4 bar of content bounces to one bar');
    assert.ok(closeTo(result.buffer.duration, 1.5), `bounce rendered ${result.buffer.duration}s, expected 1.5s`);
  });

  it('bouncing 16 steps of 4/4 content still produces a 2.0 s stem', async () => {
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    engine.setTimeSignature([4, 4]);
    engine.bpm = 120;
    engine.setSwing(0);

    const channel = makeChannel('ch-44-bounce', [0], 16);
    const result = await audioEngine.bounceChannelToAudioClip(channel, 120, 1);
    assert.equal(result.lengthBars, 1);
    assert.ok(closeTo(result.buffer.duration, 2.0), `bounce rendered ${result.buffer.duration}s, expected 2.0s`);
  });
});

// ---------------------------------------------------------------------------
// TEST P — Phase 1E extent invariant survives the meter work
// ---------------------------------------------------------------------------
describe('Phase 1F TEST P — note tails never expand the musical loop extent', () => {
  it('4/4: a tail crossing the bar line does not double the 16-step loop', () => {
    const channel = makeChannel('ch-tail-44', [], 16, [
      { id: 'n-tail', pitch: 60, start: 15.75, duration: 1, velocity: 0.9 },
    ]);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 16 });

    pumpSteps(take.fakeCtx, 33);
    const tailHits = take.triggered.filter(hit => hit.step === 15.75);
    assert.equal(tailHits.length, 2, 'the onset fires once per loop pass');
    assert.ok(closeTo(tailHits[1].time, 31.75 * STEP_SECONDS_AT_120_BPM), 'second pass at step 31.75, not 47.75 (a doubled loop)');
  });

  it('3/4: a tail crossing the 12-step bar line does not double the loop', () => {
    const channel = makeChannel('ch-tail-34', [], 12, [
      { id: 'n-tail-34', pitch: 60, start: 11.75, duration: 1, velocity: 0.9 },
    ]);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 12, meter: [3, 4] });

    pumpSteps(take.fakeCtx, 25);
    const tailHits = take.triggered.filter(hit => hit.step === 11.75);
    assert.equal(tailHits.length, 2, 'the onset fires once per loop pass');
    assert.ok(closeTo(tailHits[1].time, 23.75 * STEP_SECONDS_AT_120_BPM), 'second pass at step 23.75, not 27.75 (a 16-step loop)');
  });
});

// ---------------------------------------------------------------------------
// Behavioural mutation guards
// ---------------------------------------------------------------------------
describe('Phase 1F mutation guards (runtime)', () => {
  it('guard: a fixed STEPS_PER_BAR = 16 in the 3/4 runtime path fails here', () => {
    const channel = makeChannel('ch-guard-grid', [0], 12);
    const clip = makePatternClip('clip-guard-grid', 'ch-guard-grid', 0, 1);
    const take = startTake({ channels: [channel], clips: [clip], mode: 'song', meter: [3, 4] });
    pumpSteps(take.fakeCtx, 20);
    const state = take.transport.getState();
    // Any restored 16-step grid pushes the end of a one-bar 3/4 song to 2.0 s.
    assert.ok(closeTo(state.positionSeconds, 1.5), `song end ${state.positionSeconds}s implies a restored fixed bar size`);
  });

  it('guard: fixed 4-beat transport logic fails here', () => {
    const channel = makeChannel('ch-guard-beats', [0], 12);
    const take = startTake({ channels: [channel], clips: [], mode: 'pat', patternLengthSteps: 12, meter: [3, 4] });
    assert.equal(take.transport.getState().beatsPerBar, 3, 'transport must expose the 3/4 beat count');
  });

  it('guard: live, offline and bounce share one meter (parity)', async () => {
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    engine.setTimeSignature([3, 4]);
    engine.bpm = 120;
    engine.setSwing(0);

    // Live: one 3/4 bar ends at 1.5 s.
    const channel = makeChannel('ch-guard-parity', [0], 12);
    const clip = makePatternClip('clip-guard-parity', 'ch-guard-parity', 0, 1);
    engine.activeClips = [clip];
    assert.equal(engine.resolveSongEndSteps(), 12, 'live song grid');

    // Offline: same meter, same bar duration.
    const buffer = await audioEngine.renderTimelineOffline([channel], [clip], [], 120, 1, 44100, false, 'song', undefined, undefined, [], 0);
    assert.ok(closeTo(buffer.duration, 1.5), 'offline render bar duration must match live');

    // Bounce: same meter again.
    const result = await audioEngine.bounceChannelToAudioClip(channel, 120, 1);
    assert.ok(closeTo(result.buffer.duration, 1.5), 'bounce bar duration must match live');
  });
});
