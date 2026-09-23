/**
 * Phase 9E regression coverage: real Play, Pause, Resume, Seek and Song End.
 *
 * Every behavioural assertion drives the production playback path —
 * `audioEngine.play()` / `pause()` / `seek()` -> `AudioClockTransport` ->
 * `onStep` / `onSongEnd` -> `triggerCurrentStep` / `playAudioClipWithFades` —
 * against a fake AudioContext clock with manually pumped transport timers, so
 * results are deterministic and never depend on wall-clock audio.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';
import { audioEngine } from './audioEngine';
import type { Channel, PlaylistClip } from '../types/daw';

const STEP_SECONDS_AT_120_BPM = 0.125;
const STEP_SECONDS_PER_BAR = STEP_SECONDS_AT_120_BPM * 16;

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  setTargetAtTime(): void {}
  linearRampToValueAtTime(): void {}
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
  startCalls: Array<{ start: number; offset: number; duration?: number }> = [];
  /** Immediate interruptions (pause/seek/stop call stop() with no time). */
  stopCalls: number[] = [];
  /** The normal end-of-clip schedule (stop(startTime + duration)). */
  scheduledStopAt: number | null = null;
  connect(): void {}
  start(start?: number, offset?: number, duration?: number): void {
    this.startCalls.push({ start: start ?? 0, offset: offset ?? 0, duration });
  }
  stop(time?: number): void {
    if (time === undefined) {
      this.stopCalls.push(-1);
    } else {
      this.scheduledStopAt = time;
    }
  }
  addEventListener(): void {}
}

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';
  readonly sources: FakeBufferSource[] = [];

  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
}

type TimerCallback = () => void;
type EngineInternals = Record<string, any>;

const engine = audioEngine as unknown as EngineInternals;

const realWindow = (globalThis as any).window;
let timers: TimerCallback[] = [];
let savedInternals: EngineInternals = {};
let originalPlayNote: unknown;
let originalApplyAutomationValue: unknown;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'activeClipSources', 'isPlaying',
  'bpm', 'swing', 'metronome', 'currentStep', 'currentBar',
  'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'masterGain', 'mixerChannels'
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
  originalApplyAutomationValue = engine.applyAutomationValue;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  engine.applyAutomationValue = originalApplyAutomationValue;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
});

const makeChannel = (id: string, activeSteps: number[], totalSteps = 16): Channel => {
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

const makeAudioClip = (id: string, bufferId: string, startBar: number, lengthBars: number): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'audio',
  audioBufferId: bufferId,
  color: '#00e5ff',
  name: id
});

const makeAutomationClip = (id: string, channelId: string, startBar: number, lengthBars: number): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'automation',
  automationTarget: { type: 'channel_vol', targetId: channelId },
  automationPoints: [
    { x: 0, y: 0, tension: 0 },
    { x: 1, y: 1, tension: 0 }
  ],
  color: '#00e5ff',
  name: id
});

interface Take {
  fakeCtx: FakeAudioContext;
  transport: AudioClockTransport;
  triggered: Array<{ step: number; time: number; bar: number }>;
  reported: Array<{ step: number; bar: number }>;
  stateChanges: Array<{ playing: boolean; step: number; bar: number }>;
  /** Starts a new take on the same transport with the same project data. */
  resume: () => void;
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
  engine.activeClipSources = new Set();
  engine.masterGain = new FakeGainNode();
  engine.mixerChannels = new Map();
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);

  const triggered: Array<{ step: number; time: number; bar: number }> = [];
  const reported: Array<{ step: number; bar: number }> = [];
  const stateChanges: Array<{ playing: boolean; step: number; bar: number }> = [];

  engine.playNote = (_channel: Channel, note: { start: number }, time?: number) => {
    triggered.push({ step: note.start, time: time ?? 0, bar: engine.currentBar });
  };
  engine.setStepCallback((step: number, bar: number) => reported.push({ step, bar }));
  engine.setTransportStateCallback((state: { playing: boolean; step: number; bar: number }) => {
    stateChanges.push({ playing: state.playing, step: state.step, bar: state.bar });
  });

  const resume = (): void => {
    engine.play(
      options.channels,
      options.clips ?? [],
      options.mode ?? 'song',
      'pat-1',
      [],
      options.patternLengthSteps
    );
  };

  resume();

  return { fakeCtx, transport, triggered, reported, stateChanges, resume };
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

const stepsOf = (triggered: Take['triggered']): number[] => triggered.map(trigger => trigger.step);

const assertCloseTo = (actual: number, expected: number, message?: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`
  );
};

describe('Phase 9E: pause and resume', () => {
  it('pause preserves position and scheduled audio; resume continues from the paused step', () => {
    const channel = makeChannel('ch-pause', [0, 4, 8]);
    const clip = makePatternClip('clip-pause', 'ch-pause', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 6);
    assert.deepEqual(stepsOf(take.triggered), [0, 4]);

    engine.pause();
    assert.equal(engine.isPlaying, false);
    const pausedState = take.transport.getState();
    assert.equal(pausedState.playing, false);
    assertCloseTo(pausedState.positionSeconds, 6 * STEP_SECONDS_AT_120_BPM);
    assert.equal(pausedState.step, 6);
    assert.equal(pausedState.bar, 1);
    assert.equal(engine.currentStep, 6);
    assert.equal(engine.currentBar, 1);
    // The UI state feed reports the frozen position.
    assert.deepEqual(take.stateChanges.at(-1), { playing: false, step: 6, bar: 1 });

    // No events after the pause, even if a stale timer fires.
    pumpSteps(take.fakeCtx, 4);
    assert.deepEqual(stepsOf(take.triggered), [0, 4]);

    // Resume: the next audible step continues from the paused position.
    const resumeTime = take.fakeCtx.currentTime;
    take.resume();
    assert.equal(engine.isPlaying, true);
    pumpSteps(take.fakeCtx, 2);
    assert.deepEqual(stepsOf(take.triggered), [0, 4, 8]);
    // The resumed grid is continuous: step 8 lands two steps after the resume
    // instant, measured on the same audio clock (not a restart at bar one).
    assertCloseTo(take.triggered[2].time, resumeTime + 2 * STEP_SECONDS_AT_120_BPM);
  });

  it('pausing mid audio clip resumes the clip from the paused offset', () => {
    const channel = makeChannel('ch-midclip', []);
    const audioClip = makeAudioClip('audio-midclip', 'buf-midclip', 0, 4);
    engine.sampleBuffers = new Map([['buf-midclip', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [audioClip] });

    pumpSteps(take.fakeCtx, 4);
    assert.equal(take.fakeCtx.sources.length, 1);
    assertCloseTo(take.fakeCtx.sources[0].startCalls[0].offset, 0);

    engine.pause();
    assert.equal(take.fakeCtx.sources[0].stopCalls.length, 1, 'the paused take kills its clip source');

    take.resume();
    assert.equal(take.fakeCtx.sources.length, 2);
    const resumed = take.fakeCtx.sources[1];
    assertCloseTo(resumed.startCalls[0].offset, 4 * STEP_SECONDS_AT_120_BPM, 'clip continues from the paused offset');

    // The scheduler never adds a second source for the same clip body.
    pumpSteps(take.fakeCtx, 8);
    assert.equal(take.fakeCtx.sources.length, 2);
  });
});

describe('Phase 9E: seek', () => {
  it('seek while playing invalidates old events and continues from the new position', () => {
    const channel = makeChannel('ch-seek', [0, 4, 8, 12]);
    const clip = makePatternClip('clip-seek', 'ch-seek', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 4);
    assert.deepEqual(stepsOf(take.triggered), [0, 4]);

    engine.seek(1.0); // 8 steps in
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.currentStep, 8);
    assert.equal(engine.currentBar, 1);
    assertCloseTo(take.transport.getState().positionSeconds, 1.0);

    pumpSteps(take.fakeCtx, 4);
    // Steps 5-7 were skipped, 8-12 follow continuously from the seek point.
    assert.deepEqual(stepsOf(take.triggered), [0, 4, 8, 12]);
    // Post-seek audio time is re-based: the first new event fires just after
    // the seek instant (ctx 0.5 + 5ms scheduler nudge), not on the old grid.
    assertCloseTo(take.triggered[2].time, 0.505);
    assertCloseTo(take.triggered[3].time - take.triggered[2].time, STEP_SECONDS_AT_120_BPM * 4);
  });

  it('seek into an audio clip re-triggers it from the correct offset and never duplicates it', () => {
    const channel = makeChannel('ch-clipseek', []);
    const audioClip = makeAudioClip('audio-clipseek', 'buf-clipseek', 0, 4);
    engine.sampleBuffers = new Map([['buf-clipseek', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [audioClip] });

    pumpSteps(take.fakeCtx, 4);
    assert.equal(take.fakeCtx.sources.length, 1);

    engine.seek(1.0);
    assert.equal(take.fakeCtx.sources[0].stopCalls.length, 1, 'the old clip source is cancelled');
    assert.equal(take.fakeCtx.sources.length, 2);
    const retriggered = take.fakeCtx.sources[1];
    assertCloseTo(retriggered.startCalls[0].offset, 1.0, 'clip restarts from the seek offset into its body');
    assertCloseTo(retriggered.startCalls[0].start, take.fakeCtx.currentTime);

    // Crossing the clip's internal bars adds no second source (head-only trigger).
    pumpSteps(take.fakeCtx, 8);
    assert.equal(take.fakeCtx.sources.length, 2);

    // Seeking backwards into the same clip re-triggers again with the new offset.
    engine.seek(0.375);
    assert.equal(take.fakeCtx.sources[1].stopCalls.length, 1);
    assert.equal(take.fakeCtx.sources.length, 3);
    assertCloseTo(take.fakeCtx.sources[2].startCalls[0].offset, 0.375);

    pumpSteps(take.fakeCtx, 20);
    assert.equal(take.fakeCtx.sources.length, 3, 'no duplicate clip sources accumulate');
  });

  it('seeking past an audio clip end does not restart the clip', () => {
    const channel = makeChannel('ch-past', [0, 4]);
    const shortAudio = makeAudioClip('audio-short', 'buf-short', 0, 2);
    const tailPattern = makePatternClip('clip-tail', 'ch-past', 0, 8);
    engine.sampleBuffers = new Map([['buf-short', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [shortAudio, tailPattern] });

    pumpSteps(take.fakeCtx, 16);
    assert.equal(take.fakeCtx.sources.length, 1);

    // Past the clip end (4s) but inside the arrangement (16s).
    engine.seek(6.0);
    assert.equal(take.fakeCtx.sources[0].stopCalls.length, 1);
    assert.equal(take.fakeCtx.sources.length, 1, 'a finished clip is never re-triggered by a seek');

    pumpSteps(take.fakeCtx, 20);
    assert.equal(take.fakeCtx.sources.length, 1);
    assert.equal(engine.isPlaying, true);
  });

  it('seek while paused moves the position and resume continues from there', () => {
    const channel = makeChannel('ch-paused-seek', [0, 4]);
    const clip = makePatternClip('clip-paused-seek', 'ch-paused-seek', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 8);
    engine.pause();
    const reportedBefore = take.reported.length;

    engine.seek(4.0); // bar 3, step 0
    assert.equal(engine.isPlaying, false);
    assertCloseTo(take.transport.getState().positionSeconds, 4.0);
    assert.equal(engine.currentStep, 0);
    assert.equal(engine.currentBar, 3);

    // A paused take plays nothing after a seek.
    pumpSteps(take.fakeCtx, 4);
    assert.equal(take.reported.length, reportedBefore);

    // Resume fires the seeked step synchronously on the new take.
    take.resume();
    assert.deepEqual(take.reported.at(-1), { step: 0, bar: 3 }, 'resume starts on the seeked bar');
  });

  it('seek while stopped moves the position and play starts from there', () => {
    const channel = makeChannel('ch-stopped-seek', [0, 4]);
    const clip = makePatternClip('clip-stopped-seek', 'ch-stopped-seek', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 8);
    engine.stop();
    assertCloseTo(take.transport.getState().positionSeconds, 0);

    engine.seek(4.0); // bar 3, step 0
    assert.equal(engine.isPlaying, false);
    assertCloseTo(take.transport.getState().positionSeconds, 4.0);
    assert.equal(engine.currentBar, 3);
    assert.equal(engine.currentStep, 0);

    // Play from the stopped position fires the seeked step synchronously.
    take.resume();
    assert.deepEqual(take.reported.at(-1), { step: 0, bar: 3 });
  });

  it('song mode seeks never land past the arrangement end; landing there ends playback', () => {
    const channel = makeChannel('ch-clamp', [0, 4]);
    const shortAudio = makeAudioClip('audio-clamp', 'buf-clamp', 0, 2);
    const tailPattern = makePatternClip('clip-clamp', 'ch-clamp', 0, 8);
    engine.sampleBuffers = new Map([['buf-clamp', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [shortAudio, tailPattern] });

    pumpSteps(take.fakeCtx, 16);

    // The arrangement ends at bar 9 (8 bars). A seek beyond it clamps to the end.
    engine.seek(20.0);
    assertCloseTo(take.transport.getState().positionSeconds, 8 * STEP_SECONDS_PER_BAR);

    pumpSteps(take.fakeCtx, 2);
    assert.equal(engine.isPlaying, false, 'reaching the clamped end stops the take');
    assertCloseTo(take.transport.getState().positionSeconds, 8 * STEP_SECONDS_PER_BAR);
    assert.equal(engine.currentStep, 0);
    assert.equal(engine.currentBar, 9);

    pumpSteps(take.fakeCtx, 4);
    assert.equal(engine.isPlaying, false, 'nothing plays after the clamped end');
  });
});

describe('Phase 9E: song end', () => {
  it('Song Mode stops exactly at its real end and schedules nothing past it', () => {
    const channel = makeChannel('ch-end', [0, 4, 8, 12]);
    const clip = makePatternClip('clip-end', 'ch-end', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 64);

    // Exactly 64 step events (4 bars x 16 steps) and no more.
    assert.equal(take.reported.length, 64);
    assert.deepEqual(take.reported.at(-1), { step: 15, bar: 4 });
    assert.equal(engine.isPlaying, false);
    assertCloseTo(take.transport.getState().positionSeconds, 8.0, 'position is exactly on the end');
    assert.equal(engine.currentStep, 0);
    assert.equal(engine.currentBar, 5);
    assert.deepEqual(take.stateChanges.at(-1), { playing: false, step: 0, bar: 5 });

    // Every scheduled event of the four bars fired; nothing past bar 4.
    assert.equal(take.triggered.length, 16);
    assert.deepEqual(stepsOf(take.triggered), [0, 4, 8, 12, 0, 4, 8, 12, 0, 4, 8, 12, 0, 4, 8, 12]);

    pumpSteps(take.fakeCtx, 8);
    assert.equal(take.reported.length, 64, 'no events past the end');
    assert.equal(engine.isPlaying, false);
  });

  it('playing again after the song end restarts from the top', () => {
    const channel = makeChannel('ch-end-replay', [0, 4, 8, 12]);
    const clip = makePatternClip('clip-end-replay', 'ch-end-replay', 0, 4);
    const take = startTake({ channels: [channel], clips: [clip] });

    pumpSteps(take.fakeCtx, 64);
    assert.equal(engine.isPlaying, false);

    take.resume();
    assert.equal(engine.isPlaying, true);
    assertCloseTo(take.transport.getState().positionSeconds, 0, 'the take restarts at bar one');
    pumpSteps(take.fakeCtx, 2);
    assert.deepEqual(take.reported.at(-1), { step: 2, bar: 1 });
  });

  it('Pattern Mode keeps looping over Pattern.lengthSteps where Song Mode would end', () => {
    const channel = makeChannel('ch-pat-end', [0, 8]);
    const take = startTake({
      channels: [channel],
      mode: 'pat',
      patternLengthSteps: 16
    });

    pumpSteps(take.fakeCtx, 48);

    assert.equal(engine.isPlaying, true, 'Pattern Mode never hits a song end');
    assert.equal(take.reported.length, 49);
    // Three full 16-step loops past the point where the 4-bar song would end:
    // steps 0 and 8 of each loop, including the step-48 boundary.
    assert.deepEqual(stepsOf(take.triggered), [0, 8, 0, 8, 0, 8, 0]);
  });
});

describe('Phase 9E: automation and isolation after transport actions', () => {
  it('seek re-bases automation immediately instead of latching the pre-seek value', () => {
    const channel = makeChannel('ch-auto', []);
    channel.volume = 0.42;
    const autoClip = makeAutomationClip('auto-seek', 'ch-auto', 0, 4);

    const samples: number[] = [];
    engine.applyAutomationValue = (_target: unknown, value: number) => {
      samples.push(value);
    };

    const take = startTake({ channels: [channel], clips: [autoClip] });
    pumpSteps(take.fakeCtx, 8);
    assert.equal(samples.length, 9, 'steps 0-8 sampled the curve');
    assertCloseTo(samples[8], 8 / 64);

    engine.seek(2.0); // bar 2, step 0 -> relX 0.25
    assertCloseTo(samples.at(-1), 0.25, 'the seek writes the at-position value immediately');

    pumpSteps(take.fakeCtx, 8);
    for (let i = 9; i < samples.length; i += 1) {
      assert.ok(samples[i] >= 0.25 - 1e-12, `no latched pre-seek value (sample ${i})`);
    }
    assertCloseTo(samples.at(-1), 24 / 64);
  });

  it('transport actions never mutate the caller project data', () => {
    const projectChannels = [makeChannel('ch-iso', [0])];
    projectChannels[0].volume = 0.42;
    const projectClips: PlaylistClip[] = [
      makePatternClip('clip-iso', 'ch-iso', 0, 4),
      makeAutomationClip('auto-iso', 'ch-iso', 0, 4)
    ];
    const before = { channels: structuredClone(projectChannels), clips: structuredClone(projectClips) };

    const take = startTake({ channels: projectChannels, clips: projectClips });

    pumpSteps(take.fakeCtx, 8);
    engine.seek(2.0);
    engine.pause();

    assert.deepEqual(projectChannels, before.channels, 'playback never writes through to project channels');
    assert.deepEqual(projectClips, before.clips, 'playback never writes through to project clips');
    // The isolated take did receive the automation writes.
    assertCloseTo(engine.activeChannels[0].volume, 0.25);
  });
});

describe('Phase 9E: stop and source ownership', () => {
  it('stop cancels scheduled clip audio and resets the position', () => {
    const channel = makeChannel('ch-stop', []);
    const audioClip = makeAudioClip('audio-stop', 'buf-stop', 0, 4);
    engine.sampleBuffers = new Map([['buf-stop', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [audioClip] });

    pumpSteps(take.fakeCtx, 4);
    assert.equal(take.fakeCtx.sources.length, 1);

    engine.stop();
    assert.equal(take.fakeCtx.sources[0].stopCalls.length, 1, 'stop cancels the take clip source');
    assert.equal(engine.isPlaying, false);
    assertCloseTo(take.transport.getState().positionSeconds, 0);
    assert.equal(engine.currentStep, 0);
    assert.equal(engine.currentBar, 1);
  });

  it('resuming at a clip head triggers the clip exactly once for the new take', () => {
    const channel = makeChannel('ch-head', []);
    const audioClip = makeAudioClip('audio-head', 'buf-head', 1, 3);
    engine.sampleBuffers = new Map([['buf-head', { duration: 10 } as AudioBuffer]]);
    const take = startTake({ channels: [channel], clips: [audioClip] });

    pumpSteps(take.fakeCtx, 16); // bar 2 head at 2.0s
    assert.equal(take.fakeCtx.sources.length, 1);
    assertCloseTo(take.fakeCtx.sources[0].startCalls[0].offset, 0);

    engine.pause();
    assert.equal(take.fakeCtx.sources[0].stopCalls.length, 1);

    take.resume();
    pumpSteps(take.fakeCtx, 8);
    assert.equal(take.fakeCtx.sources.length, 2, 'resume re-triggers the head once, no duplicate source');
    assertCloseTo(take.fakeCtx.sources[1].startCalls[0].offset, 0, 'the head restart plays from the clip start');
  });
});

describe('Phase 9E: UI wiring (App transport handlers)', () => {
  it('App toggles between real pause and resume and seeks the engine, not just the readout', () => {
    // Source-level guard in the style of the existing transport-sync tests:
    // the handlers must call the engine transport actions directly.
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(source, /audioEngine\.pause\(\)/);
    assert.match(source, /audioEngine\.seek\(\(targetBar - 1\) \* secondsPerBar\)/);
    assert.doesNotMatch(source, /onSeekToBar=\{\(bar\) => setCurrentBar\(bar\)\}/);
  });
});
