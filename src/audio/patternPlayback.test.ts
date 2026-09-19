/**
 * Phase 9B regression coverage: Pattern Mode must loop over the whole pattern
 * length instead of the historical one-bar (16 step) window.
 *
 * Every behavioural assertion below drives the production playback path —
 * `audioEngine.play()` -> `AudioClockTransport` -> `onStep` -> `triggerCurrentStep`
 * -> `playNote` — against a fake AudioContext clock with manually pumped transport
 * timers, so results are deterministic and never depend on wall-clock audio.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';
import { audioEngine, resolvePatternLoopLengthSteps } from './audioEngine';
import { serializeProjectState } from '../state/projectPersistence';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import type { Channel, MixerTrack, Note, PlaylistClip } from '../types/daw';

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';

  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }
}

/** Minimal offline context: the renderer only builds the master graph and renders. */
class FakeOfflineAudioContext {
  readonly destination = new FakeNode();
  readonly sampleRate: number;

  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode & { fftSize: number; smoothingTimeConstant: number } {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 });
  }
  async startRendering(): Promise<AudioBuffer> {
    return { sampleRate: this.sampleRate } as AudioBuffer;
  }
}

class FakeNode {
  gain = { value: 1, setValueAtTime: () => undefined, setTargetAtTime: () => undefined };
  connect(): void {}
  disconnect(): void {}
}

type TimerCallback = () => void;
type EngineInternals = Record<string, any>;

const engine = audioEngine as unknown as EngineInternals;

const STEP_SECONDS_AT_120_BPM = 0.125;
const realWindow = (globalThis as any).window;
const realOfflineAudioContext = (globalThis as any).OfflineAudioContext;

let timers: TimerCallback[] = [];
let savedInternals: EngineInternals = {};
let originalPlayNote: unknown;
let originalUpdateMixerTrack: unknown;
let originalTriggerCurrentStep: unknown;
let originalApplyAutomationValue: unknown;
let originalSetStepCallback: unknown;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'isPlaying', 'bpm', 'swing', 'metronome',
  'currentStep', 'currentBar', 'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers'
];

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (callback: TimerCallback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => undefined,
    OfflineAudioContext: undefined
  };

  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  originalPlayNote = engine.playNote;
  originalUpdateMixerTrack = engine.updateMixerTrack;
  originalTriggerCurrentStep = engine.triggerCurrentStep;
  originalApplyAutomationValue = engine.applyAutomationValue;
  originalSetStepCallback = engine.setStepCallback;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  engine.updateMixerTrack = originalUpdateMixerTrack;
  engine.triggerCurrentStep = originalTriggerCurrentStep;
  engine.applyAutomationValue = originalApplyAutomationValue;
  engine.setStepCallback = originalSetStepCallback;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
});

const makeChannel = (id: string, activeSteps: number[], totalSteps = 32): Channel => {
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
    notes: [],
    synthParams: {} as any
  };
};

const makeNoteChannel = (id: string, noteStarts: number[]): Channel => ({
  ...makeChannel(id, [], 16),
  instrumentType: 'minisynth',
  notes: noteStarts.map((start, index): Note => ({
    id: `${id}-n${index}`, pitch: 60 + index, start, duration: 1, velocity: 0.9
  }))
});

/** One triggered event, identified by the step the scheduler played it on. */
interface Trigger { step: number; time: number; bar: number }

interface Take {
  fakeCtx: FakeAudioContext;
  transport: AudioClockTransport;
  triggered: Trigger[];
  reported: { step: number; bar: number }[];
}

/**
 * Starts a take through the real `audioEngine.play()` entrypoint using a fake
 * clock, then pumps the transport timers one step at a time.
 */
const startTake = (options: {
  channels: Channel[];
  clips?: PlaylistClip[];
  mode?: 'pat' | 'song';
  patternLengthSteps?: number;
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
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);

  const triggered: Trigger[] = [];
  const reported: { step: number; bar: number }[] = [];

  engine.playNote = (_channel: Channel, note: Note, time?: number) => {
    triggered.push({ step: note.start, time: time ?? 0, bar: engine.currentBar });
  };
  engine.setStepCallback((step: number, bar: number) => reported.push({ step, bar }));

  engine.play(
    options.channels,
    options.clips ?? [],
    options.mode ?? 'pat',
    'pat-1',
    [],
    options.patternLengthSteps
  );

  return { fakeCtx, transport, triggered, reported };
};

/**
 * Advances the fake audio clock by `steps` steps from its current position,
 * running every pending transport timer at each step boundary.
 */
const pumpSteps = (fakeCtx: FakeAudioContext, steps: number): void => {
  const startTick = Math.round(fakeCtx.currentTime / STEP_SECONDS_AT_120_BPM);
  for (let tick = startTick; tick <= startTick + steps; tick += 1) {
    fakeCtx.currentTime = tick * STEP_SECONDS_AT_120_BPM;
    const pending = timers;
    timers = [];
    for (const callback of pending) callback();
  }
};

const stepsOf = (triggered: Trigger[]): number[] => triggered.map(trigger => trigger.step);

const assertCloseTo = (actual: number, expected: number, message?: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`
  );
};

describe('Pattern Mode loop boundary', () => {
  it('A: plays every step of a 16-step pattern', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-16', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 16)],
      patternLengthSteps: 16
    });

    pumpSteps(fakeCtx, 15);

    assert.deepEqual(stepsOf(triggered), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('B: wraps a 16-step pattern from step 15 back to step 0', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-16', [0, 15], 16)],
      patternLengthSteps: 16
    });

    pumpSteps(fakeCtx, 33);

    assert.deepEqual(stepsOf(triggered), [0, 15, 0, 15, 0]);
    assertCloseTo(triggered[2].time, 16 * STEP_SECONDS_AT_120_BPM);
  });

  it('C: a 32-step pattern reaches step 16', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-32', [0, 15, 16, 31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 16);

    assert.deepEqual(stepsOf(triggered), [0, 15, 16]);
    assertCloseTo(triggered[2].time, 16 * STEP_SECONDS_AT_120_BPM);
  });

  it('D: a 32-step pattern reaches step 31', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-32', [0, 15, 16, 31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 31);

    assert.deepEqual(stepsOf(triggered), [0, 15, 16, 31]);
    assertCloseTo(triggered[3].time, 31 * STEP_SECONDS_AT_120_BPM);
  });

  it('E: a 32-step pattern wraps from step 31 back to step 0', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-32', [0, 15, 16, 31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 48);

    assert.deepEqual(stepsOf(triggered), [0, 15, 16, 31, 0, 15, 16]);
    assert.equal(triggered[4].step, 0);
    assertCloseTo(triggered[4].time, 32 * STEP_SECONDS_AT_120_BPM);
  });

  it('F: an event that exists only on step 16 triggers exactly once per loop', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-only-16', [16])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 16);

    assert.deepEqual(stepsOf(triggered), [16]);
    assertCloseTo(triggered[0].time, 16 * STEP_SECONDS_AT_120_BPM);
  });

  it('G: an event that exists only on step 31 triggers exactly once per loop', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-only-31', [31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 47);

    assert.deepEqual(stepsOf(triggered), [31]);
    assertCloseTo(triggered[0].time, 31 * STEP_SECONDS_AT_120_BPM);
  });

  it('H: no duplicate or missing trigger at the 15 -> 16 boundary', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-boundary', [15, 16])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 16);

    assert.deepEqual(stepsOf(triggered), [15, 16]);
    assertCloseTo(triggered[1].time - triggered[0].time, STEP_SECONDS_AT_120_BPM);
  });

  it('I: no duplicate or missing trigger at the 31 -> 0 boundary', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-boundary', [0, 31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 32);

    assert.deepEqual(stepsOf(triggered), [0, 31, 0]);
    assertCloseTo(triggered[2].time - triggered[1].time, STEP_SECONDS_AT_120_BPM);
  });

  it('reaches piano roll notes written past step 15', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeNoteChannel('ch-notes', [0, 16, 31])],
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 31);

    assert.deepEqual(stepsOf(triggered), [0, 16, 31]);
  });

  it('keeps a 16-step pattern one bar long even while a 32-step channel is idle in its second bar', () => {
    const { fakeCtx, triggered } = startTake({
      channels: [makeChannel('ch-16', [0, 8], 32)],
      patternLengthSteps: 16
    });

    pumpSteps(fakeCtx, 32);

    assert.deepEqual(stepsOf(triggered), [0, 8, 0, 8, 0]);
  });
});

describe('resolvePatternLoopLengthSteps', () => {
  it('uses the declared pattern length raised to whole bars', () => {
    assert.equal(resolvePatternLoopLengthSteps([], 32), 32);
    assert.equal(resolvePatternLoopLengthSteps([], 64), 64);
    assert.equal(resolvePatternLoopLengthSteps([], 48), 48);
  });

  it('treats a supplied Pattern.lengthSteps as authoritative and floors to one bar', () => {
    assert.equal(resolvePatternLoopLengthSteps([makeChannel('a', [0, 8], 16)], 16), 16);
    assert.equal(resolvePatternLoopLengthSteps([makeChannel('a', [0, 15], 32)], 16), 16);
    assert.equal(resolvePatternLoopLengthSteps([makeChannel('a', [0, 28], 32)], 16), 16);
    assert.equal(resolvePatternLoopLengthSteps([makeNoteChannel('n', [20])], 16), 16);
    assert.equal(resolvePatternLoopLengthSteps([], undefined), 16);
  });

  it('falls back to channel content only when no Pattern model is available', () => {
    assert.equal(resolvePatternLoopLengthSteps([makeChannel('a', [0, 28], 32)]), 32);
    assert.equal(resolvePatternLoopLengthSteps([makeNoteChannel('n', [20])]), 32);
    assert.equal(resolvePatternLoopLengthSteps([makeChannel('a', [63], 64)]), 64);
  });
});

describe('Pattern Mode persistence', () => {
  it('J: a 32-step pattern survives save, reload and still reaches steps 16 and 31', () => {
    const project = createDefaultProjectState();
    project.patterns = [{ id: 'pat-32', name: 'Two Bar', color: '#ff6e00', lengthSteps: 32 }];
    project.selectedPatternId = 'pat-32';
    project.channels = [makeChannel('ch-persist', [0, 15, 16, 31], 32)];

    // Same round trip the persistence boundary uses: serialize -> parse -> normalize.
    const restored = normalizeProjectState(
      (JSON.parse(serializeProjectState(project)) as { state: unknown }).state
    );

    assert.equal(restored.patterns[0].lengthSteps, 32);
    assert.equal(restored.channels[0].steps.length, 32);
    assert.equal(restored.channels[0].steps[16], true);
    assert.equal(restored.channels[0].steps[31], true);

    const { fakeCtx, triggered } = startTake({
      channels: restored.channels,
      patternLengthSteps: restored.patterns[0].lengthSteps
    });
    pumpSteps(fakeCtx, 31);

    assert.deepEqual(stepsOf(triggered), [0, 15, 16, 31]);
  });
});

describe('Pattern Mode playback snapshot and live synchronization (Phase 9A)', () => {
  it('K: edits made while Pattern Mode plays reach the active take and stay isolated from project state', () => {
    const projectChannels = [makeChannel('ch-live', [0, 4], 16)];
    const projectChannelsBeforeEdit = structuredClone(projectChannels);

    const { fakeCtx, transport, triggered } = startTake({
      channels: projectChannels,
      patternLengthSteps: 16
    });

    pumpSteps(fakeCtx, 4);
    assert.deepEqual(stepsOf(triggered), [0, 4]);
    assert.equal(transport.getState().step, 4);

    // The scheduler must never write through to the caller's project objects.
    assert.deepEqual(projectChannels, projectChannelsBeforeEdit);

    // Extend the declared pattern and its channel content while the transport
    // keeps running. Pattern.lengthSteps owns the boundary; the channel edit is
    // merged into the isolated playback snapshot (Phase 9A).
    const extended = makeChannel('ch-live', [0, 4, 20], 32);
    engine.synchronizePlaybackState({ channels: [extended], patternLengthSteps: 32 });

    assert.deepEqual(engine.activeChannels[0].steps.length, 32);
    assert.deepEqual(engine.playbackProjectChannels[0].steps.length, 32);
    // Project-owned array is still the untouched snapshot source.
    assert.deepEqual(projectChannels, projectChannelsBeforeEdit);

    pumpSteps(fakeCtx, 20);

    // Step 20 was unreachable while the take looped at 16 steps; the live edit
    // moved the loop boundary so it now plays inside the running take.
    assert.deepEqual(stepsOf(triggered), [0, 4, 20]);
    assertCloseTo(triggered[2].time, 20 * STEP_SECONDS_AT_120_BPM);
    // Reported position passes step 15 without wrapping, proving the loop is 32 long.
    assert.equal(transport.getState().step, 24);
  });

  it('updates a running take when only Pattern.lengthSteps changes 16 -> 32 -> 16', () => {
    const projectChannels = [makeChannel('ch-length-live', [0, 15], 16)];
    const projectBefore = structuredClone(projectChannels);
    const { fakeCtx, transport } = startTake({
      channels: projectChannels,
      patternLengthSteps: 16
    });

    pumpSteps(fakeCtx, 4);
    assert.equal(transport.getState().step, 4);

    // This is the exact update App sends for a Channel Rack length click when no
    // Channel.steps data changes. The active playback snapshot must adopt it.
    engine.synchronizePlaybackState({ patternLengthSteps: 32 });
    assert.equal(engine.activePatternLengthSteps, 32);
    pumpSteps(fakeCtx, 16);
    assert.equal(transport.getState().step, 20, 'the take passes step 15 without restarting');

    engine.synchronizePlaybackState({ patternLengthSteps: 16 });
    assert.equal(engine.activePatternLengthSteps, 16);
    assert.equal(transport.getState().step, 4, 'the same continuous position is re-wrapped to one bar');
    assert.deepEqual(projectChannels, projectBefore, 'scheduler synchronization never mutates project state');
  });

  it('ignores declared pattern-length synchronization in Song Mode', () => {
    const channel = makeChannel('ch-song-sync', [0], 16);
    const clip: PlaylistClip = {
      id: 'clip-song-sync', trackIndex: 0, startBar: 0, lengthBars: 4,
      type: 'pattern', channelId: channel.id, color: '#fff', name: 'Song'
    };
    const { fakeCtx, transport } = startTake({
      channels: [channel], clips: [clip], mode: 'song', patternLengthSteps: 16
    });

    engine.synchronizePlaybackState({ patternLengthSteps: 32 });
    pumpSteps(fakeCtx, 20);

    assert.equal(engine.activePatternLengthSteps, 32, 'the project value is retained for a later mode change');
    assert.equal(transport.getState().step, 4, 'Song Mode still reports the one-bar playlist grid');
  });

  it('keeps the playback take isolated from automation writes during Pattern Mode', () => {
    const projectChannels = [makeChannel('ch-iso', [0])];
    projectChannels[0].volume = 0.42;

    const { fakeCtx } = startTake({ channels: projectChannels, patternLengthSteps: 16 });
    pumpSteps(fakeCtx, 8);

    assert.equal(projectChannels[0].volume, 0.42);
    assert.equal(engine.activeChannels[0].volume, 0.42);
    assert.notEqual(engine.activeChannels, projectChannels);
  });
});

describe('Song Mode is unaffected by the pattern loop boundary', () => {
  const songSetup = () => {
    const channel = makeChannel('ch-song', [0, 4, 16], 32);
    const clip: PlaylistClip = {
      id: 'clip-song',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 4,
      type: 'pattern',
      channelId: 'ch-song',
      color: '#ff6e00',
      name: 'Two Bar Block'
    };
    return { channel, clip };
  };

  it('L: keeps reporting the one-bar step grid for playlist scheduling', () => {
    const { channel, clip } = songSetup();
    const { fakeCtx, reported, triggered } = startTake({
      channels: [channel],
      clips: [clip],
      mode: 'song',
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 48);

    assert.ok(reported.length > 32);
    assert.ok(reported.every(entry => entry.step >= 0 && entry.step <= 15));
    assert.equal(Math.max(...reported.map(entry => entry.step)), 15);
    assert.deepEqual([...new Set(reported.map(entry => entry.bar))], [1, 2, 3, 4]);
    // Clip-relative looping still walks the 32-step channel across bars 1-2.
    assert.deepEqual(stepsOf(triggered), [0, 4, 16, 0, 4, 16]);
  });

  it('keeps the 16-step clip loop for one-bar channels', () => {
    const { channel, clip } = songSetup();
    const oneBarChannel = makeChannel('ch-song', [0, 8], 16);
    const oneBarClip: PlaylistClip = { ...clip, channelId: 'ch-song' };

    const { fakeCtx, triggered } = startTake({
      channels: [oneBarChannel],
      clips: [oneBarClip],
      mode: 'song',
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 48);

    assert.deepEqual(stepsOf(triggered), [0, 8, 0, 8, 0, 8, 0]);
  });
});

describe('Automation timing is unchanged', () => {
  const automationClip = (): PlaylistClip => ({
    id: 'auto-1',
    trackIndex: 0,
    startBar: 0,
    lengthBars: 4,
    type: 'automation',
    color: '#00e5ff',
    name: 'Cutoff',
    automationTarget: { type: 'channel_filter_cutoff', targetId: 'ch-song' },
    automationPoints: [
      { x: 0, y: 0, tension: 0 },
      { x: 1, y: 1, tension: 0 }
    ]
  });

  it('M: samples automation on the bar grid across the 15 -> 16 boundary in Song Mode', () => {
    const samples: { value: number; bar: number; step: number }[] = [];
    engine.applyAutomationValue = (_target: unknown, value: number) => {
      samples.push({ value, bar: engine.currentBar, step: engine.currentStep });
    };

    const { fakeCtx } = startTake({
      channels: [makeChannel('ch-song', [0], 16)],
      clips: [automationClip()],
      mode: 'song',
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 32);

    assert.equal(samples.length, 33);
    assert.deepEqual(
      samples.slice(14, 18).map(sample => ({ bar: sample.bar, step: sample.step })),
      [{ bar: 1, step: 14 }, { bar: 1, step: 15 }, { bar: 2, step: 0 }, { bar: 2, step: 1 }]
    );
    for (let index = 1; index < samples.length; index += 1) {
      assert.ok(samples[index].value >= samples[index - 1].value, 'automation must stay monotonic');
    }
    assertCloseTo(samples[16].value - samples[0].value, 0.25);
  });

  it('M: never evaluates automation clips in Pattern Mode', () => {
    const samples: number[] = [];
    engine.applyAutomationValue = (_target: unknown, value: number) => samples.push(value);

    const { fakeCtx } = startTake({
      channels: [makeChannel('ch-song', [0, 16], 32)],
      clips: [automationClip()],
      mode: 'pat',
      patternLengthSteps: 32
    });

    pumpSteps(fakeCtx, 31);

    assert.deepEqual(samples, []);
  });
});

describe('Offline render parity', () => {
  const masterTrack = (): MixerTrack => ({
    id: 0, name: 'Master', color: '#fff', volume: 1, pan: 0, mute: false, solo: false,
    stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: []
  });

  const renderPatternScope = async (
    channels: Channel[],
    patternLengthSteps?: number,
    totalBars = 4
  ): Promise<number[]> => {
    (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
    engine.ctx = null;
    engine.updateMixerTrack = () => undefined;
    const visitedSteps: number[] = [];
    engine.triggerCurrentStep = () => visitedSteps.push(engine.currentStep);

    await engine.renderTimelineOffline(
      channels,
      [],
      [masterTrack()],
      120,
      totalBars,
      44100,
      false,
      'pattern',
      undefined,
      patternLengthSteps
    );
    return visitedSteps;
  };

  it('renders every step of a 32-step pattern loop', async () => {
    const visitedSteps = await renderPatternScope([makeChannel('ch-32', [0, 16, 31], 32)]);

    assert.equal(visitedSteps.length, 64);
    assert.ok(visitedSteps.includes(16));
    assert.ok(visitedSteps.includes(31));
    assert.deepEqual(visitedSteps.slice(0, 4), [0, 1, 2, 3]);
    assert.deepEqual(visitedSteps.slice(30, 34), [30, 31, 0, 1]);
  });

  it('keeps the historical one-bar loop for 16-step patterns', async () => {
    const visitedSteps = await renderPatternScope([makeChannel('ch-16', [0, 15], 16)], 16);

    assert.equal(visitedSteps.length, 64);
    assert.equal(Math.max(...visitedSteps), 15);
    assert.deepEqual(visitedSteps.slice(14, 18), [14, 15, 0, 1]);
  });

  it('exports a declared 32-step loop even when steps 16-31 contain no notes', async () => {
    // Critical Phase 9D regression: channel content alone resolves to 16 here.
    const channel = makeChannel('ch-empty-tail', [0, 8], 16);
    assert.equal(resolvePatternLoopLengthSteps([channel]), 16);

    const visitedSteps = await renderPatternScope([channel], 32);

    assert.equal(visitedSteps.length, 64);
    assert.equal(Math.max(...visitedSteps), 31);
    assert.deepEqual(visitedSteps.slice(30, 34), [30, 31, 0, 1]);
  });

  it('exports a declared 32-step loop containing unique events on 16, 20 and 31', async () => {
    const channel = makeChannel('ch-late-events', [0, 15, 16, 20, 31], 32);
    const visitedSteps = await renderPatternScope([channel], 32);

    for (const step of [0, 15, 16, 20, 31]) assert.ok(visitedSteps.includes(step));
    assert.deepEqual(visitedSteps.slice(31, 33), [31, 0]);
  });

  it('exports a declared 64-step loop, including an empty final three bars', async () => {
    const channel = makeChannel('ch-64-empty-tail', [0, 8], 16);
    const visitedSteps = await renderPatternScope([channel], 64);

    assert.equal(visitedSteps.length, 64);
    assert.deepEqual(visitedSteps, Array.from({ length: 64 }, (_, step) => step));
    assert.equal(Math.max(...visitedSteps), 63);
  });

  it('restores the active live pattern length after offline export', async () => {
    engine.activePatternLengthSteps = 32;
    await renderPatternScope([makeChannel('ch-export', [0], 16)], 64);
    assert.equal(engine.activePatternLengthSteps, 32);
  });
});
