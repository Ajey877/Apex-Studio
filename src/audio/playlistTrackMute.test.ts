/**
 * Phase 9F regression coverage: a playlist lane mute must actually silence the
 * pattern and audio clips placed on that lane — before playback and live during
 * Song Mode — without touching the mixer insert the clips route to, so lanes
 * and channels sharing one insert stay independent.
 *
 * Every behavioural assertion below drives the production playback path —
 * `audioEngine.play()` -> `AudioClockTransport` -> `onStep` -> `triggerCurrentStep`
 * (and `playAudioClipWithFades`) — against a fake AudioContext clock with manually
 * pumped transport timers, so results are deterministic and never depend on
 * wall-clock audio.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';
import { audioEngine } from './audioEngine';
import { createHistory } from '../state/projectHistory';
import { serializeProjectState } from '../state/projectPersistence';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import type { Channel, MixerTrack, Note, PlaylistClip, PlaylistTrack } from '../types/daw';

class FakeAudioContext {
  private _currentTime = 0;
  state = 'running';

  get currentTime(): number { return this._currentTime; }
  set currentTime(value: number) { this._currentTime = value; }

  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createGain(): FakeNode { return new FakeNode(); }
}

/** Minimal offline context: only needed so engine init paths never hit the DOM. */
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
  gain = {
    value: 1,
    setValueAtTime: () => undefined,
    setTargetAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined
  };
  connect(): void {}
  disconnect(): void {}
}

interface StartCall { time: number; offset: number; duration: number | undefined }

class FakeBufferSource {
  buffer: unknown = null;
  readonly started: StartCall[] = [];
  /** Immediate cancels (`stop()` with no time) — pause/seek/lane-mute teardown. */
  cancelCalls = 0;
  /** Natural end-of-clip stops scheduled by the engine with a stop time. */
  naturalStops = 0;

  connect(): void {}
  disconnect(): void {}
  detune = { setValueAtTime: () => undefined };
  playbackRate = { setValueAtTime: () => undefined };
  addEventListener(): void {}

  start(time: number = 0, offset: number = 0, duration?: number): void {
    this.started.push({ time, offset, duration });
  }

  stop(time?: number): void {
    if (time === undefined) this.cancelCalls += 1;
    else this.naturalStops += 1;
  }
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
let originalGetOrCreateMixerChannel: unknown;
let originalApplyAutomationValue: unknown;
let originalSetStepCallback: unknown;

const SAVED_KEYS = [
  'ctx', 'transport', 'activeVoices', 'isPlaying', 'bpm', 'swing', 'metronome',
  'currentStep', 'currentBar', 'activeChannels', 'activeClips', 'activeMixerTracks',
  'playbackProjectChannels', 'playbackProjectMixerTracks', 'activePlayMode',
  'activePatternId', 'activePatternLengthSteps', 'playbackGeneration',
  'stepCallback', 'transportStateCallback', 'sampleBuffers',
  'activeClipSources', 'activeClipSourceLanes', 'playlistLaneMutes'
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
  originalGetOrCreateMixerChannel = engine.getOrCreateMixerChannel;
  originalApplyAutomationValue = engine.applyAutomationValue;
  originalSetStepCallback = engine.setStepCallback;
});

afterEach(() => {
  engine.playNote = originalPlayNote;
  engine.updateMixerTrack = originalUpdateMixerTrack;
  engine.getOrCreateMixerChannel = originalGetOrCreateMixerChannel;
  engine.applyAutomationValue = originalApplyAutomationValue;
  engine.setStepCallback = originalSetStepCallback;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
});

const makeChannel = (id: string, activeSteps: number[], mixerTrackId = 1): Channel => {
  // 16-element steps array: Song Mode derives each clip's loop length from the
  // channel's content window, so hits repeat on a 16-step (one bar) cycle.
  const steps = new Array(16).fill(false);
  for (const step of activeSteps) steps[step] = true;
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'drumpad',
    mixerTrackId,
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

const makeTrack = (id: number, mute: boolean): PlaylistTrack => ({
  id,
  name: `Track ${id}`,
  color: '#ff6e00',
  volume: 0.8,
  pan: 0,
  mute,
  solo: false
});

/**
 * Playlist lane rows are array positions — the same coordinate space as
 * `PlaylistClip.trackIndex`. Track ids are labels (1-based by convention);
 * the mute flag binds to the row index.
 */
const tracksWithMutes = (mutedRows: number[], rowCount = 8): PlaylistTrack[] =>
  Array.from({ length: rowCount }, (_, row) => makeTrack(row + 1, mutedRows.includes(row)));

const makePatternClip = (
  clipId: string,
  trackIndex: number,
  channelId: string,
  startBar: number,
  lengthBars: number
): PlaylistClip => ({
  id: clipId,
  trackIndex,
  startBar,
  lengthBars,
  type: 'pattern',
  patternId: 'pat-1',
  channelId,
  color: '#00e5ff',
  name: clipId
});

const makeAudioClip = (
  clipId: string,
  trackIndex: number,
  startBar: number,
  lengthBars: number,
  extra: Partial<PlaylistClip> = {}
): PlaylistClip => ({
  id: clipId,
  trackIndex,
  startBar,
  lengthBars,
  type: 'audio',
  audioBufferId: `buf-${clipId}`,
  color: '#00ff88',
  name: clipId,
  ...extra
});

const makeFakeBuffer = (durationSeconds: number): AudioBuffer => ({ duration: durationSeconds } as AudioBuffer);

interface Trigger { step: number; time: number; bar: number }

interface Take {
  fakeCtx: FakeAudioContext;
  transport: AudioClockTransport;
  triggered: Trigger[];
  sources: FakeBufferSource[];
}

/**
 * Starts a Song Mode take through the real `audioEngine.play()` entrypoint with
 * a fake clock, then pumps the transport timers one step at a time. Clip audio
 * sources are recorded instead of rendered.
 */
const startSongTake = (options: {
  channels: Channel[];
  clips: PlaylistClip[];
  playlistTracks?: PlaylistTrack[];
  mutedLaneIndices?: number[]; // convenience: builds playlistTracks of the required length
  laneCount?: number;
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
  engine.activeClipSourceLanes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.isPlaying = false;
  engine.bpm = 120;
  engine.metronome = false;
  engine.setSwing(0);

  const sources: FakeBufferSource[] = [];
  const originalCreateBufferSource = fakeCtx.createBufferSource.bind(fakeCtx);
  fakeCtx.createBufferSource = () => {
    const source = originalCreateBufferSource();
    sources.push(source);
    return source;
  };

  engine.getOrCreateMixerChannel = () => ({ input: new FakeNode(), output: new FakeNode() });

  const triggered: Trigger[] = [];
  engine.playNote = (_channel: Channel, note: Note, time?: number) => {
    triggered.push({ step: note.start, time: time ?? 0, bar: engine.currentBar });
  };

  const clips = options.clips;
  for (const clip of clips) {
    if (clip.type === 'audio' && clip.audioBufferId) {
      engine.sampleBuffers.set(clip.audioBufferId, makeFakeBuffer(60));
    }
  }

  let playlistTracks = options.playlistTracks;
  if (!playlistTracks && options.mutedLaneIndices) {
    const laneCount = options.laneCount ?? 8;
    playlistTracks = Array.from({ length: laneCount }, (_, i) =>
      makeTrack(i + 1, options.mutedLaneIndices!.includes(i))
    );
  }

  engine.play(
    options.channels,
    clips,
    'song',
    'pat-1',
    [],
    undefined,
    playlistTracks
  );

  return { fakeCtx, transport, triggered, sources };
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

const startsForClip = (take: Take): StartCall[] =>
  take.sources.flatMap(source => source.started);

describe('Playlist lane mute — mapping', () => {
  it('A: playlistTracks[i].mute mutes lane row i only', () => {
    const { fakeCtx, triggered } = startSongTake({
      channels: [makeChannel('ch-a', [0]), makeChannel('ch-b', [4])],
      clips: [
        makePatternClip('clip-a', 0, 'ch-a', 0, 4),
        makePatternClip('clip-b', 1, 'ch-b', 0, 4)
      ],
      mutedLaneIndices: [0]
    });

    pumpSteps(fakeCtx, 4);

    // clip-a (muted lane 0) never triggers; clip-b (lane 1) plays its step-4 hit.
    assert.deepEqual(stepsOf(triggered), [4]);
  });

  it('B: a clip with a non-finite trackIndex is never lane-muted', () => {
    const { fakeCtx, triggered } = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [makePatternClip('clip-a', Number.NaN, 'ch-a', 0, 2)],
      mutedLaneIndices: [0, 1, 2, 3, 4, 5, 6, 7]
    });

    pumpSteps(fakeCtx, 2);

    assert.deepEqual(stepsOf(triggered), [0]);
  });
});

describe('Playlist lane mute — before playback (Song Mode)', () => {
  it('C: a pattern clip on a lane muted before play never triggers', () => {
    const { fakeCtx, triggered } = startSongTake({
      channels: [makeChannel('ch-a', [0, 8])],
      clips: [makePatternClip('clip-a', 2, 'ch-a', 0, 4)],
      mutedLaneIndices: [2]
    });

    pumpSteps(fakeCtx, 16);

    assert.deepEqual(stepsOf(triggered), []);
  });

  it('D: an audio clip on a lane muted before play never starts a source', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [makeAudioClip('clip-a', 0, 0, 2)],
      mutedLaneIndices: [0]
    });

    pumpSteps(take.fakeCtx, 8);

    assert.equal(startsForClip(take).length, 0);
  });

  it('E: clip mute and lane mute compose; the unmuted twin keeps playing', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0]), makeChannel('ch-b', [0])],
      clips: [
        makeAudioClip('clip-muted-twice', 0, 0, 4, { mute: true }),
        makeAudioClip('clip-live', 1, 0, 4)
      ],
      mutedLaneIndices: [0]
    });

    pumpSteps(take.fakeCtx, 1);

    // Only the lane-1 clip starts; the lane-0 clip is blocked by lane AND clip mute.
    assert.equal(startsForClip(take).length, 1);
  });
});

describe('Playlist lane mute — live during Song Mode', () => {
  it('F: muting a lane mid-take silences its pattern clip within one step; other lanes keep playing', () => {
    const channels = [makeChannel('ch-a', [0]), makeChannel('ch-b', [2])];
    const { fakeCtx, triggered } = startSongTake({
      channels,
      clips: [
        makePatternClip('clip-a', 0, 'ch-a', 0, 8),
        makePatternClip('clip-b', 1, 'ch-b', 0, 8)
      ],
      playlistTracks: tracksWithMutes([])
    });

    pumpSteps(fakeCtx, 2);
    assert.deepEqual(stepsOf(triggered), [0, 2]);

    // Live mute lane 0 (the production path: state edit -> synchronizePlaybackState).
    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([0], 2) });

    pumpSteps(fakeCtx, 16);

    // ch-a's bar-2 hit (tick 16) is suppressed by the lane mute; ch-b's loop
    // hit at tick 18 still fires. Nothing else sounds on the muted lane.
    assert.deepEqual(stepsOf(triggered), [0, 2, 2]);
  });

  it('G: unmuting a lane mid-take resumes its pattern clip at the next loop hit', () => {
    const { fakeCtx, triggered } = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [makePatternClip('clip-a', 0, 'ch-a', 0, 8)],
      playlistTracks: tracksWithMutes([])
    });

    pumpSteps(fakeCtx, 2);
    assert.deepEqual(stepsOf(triggered), [0]);

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([0], 2) });
    pumpSteps(fakeCtx, 14);
    // Tick 16 lands on ch-a's next loop hit and must be suppressed.
    assert.deepEqual(stepsOf(triggered), [0]);

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([], 2) });
    pumpSteps(fakeCtx, 16);

    // Tick 32: the lane is audible again and the loop hit fires.
    assert.deepEqual(stepsOf(triggered), [0, 0]);
  });

  it('H: muting a lane mid-clip stops its in-flight audio source; other lanes are untouched', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [
        makeAudioClip('clip-a', 0, 0, 8),
        makeAudioClip('clip-b', 1, 0, 8)
      ],
      playlistTracks: tracksWithMutes([])
    });

    pumpSteps(take.fakeCtx, 1);
    assert.equal(startsForClip(take).length, 2);

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([0], 2) });

    // Exactly the lane-0 source was cancelled; the lane-1 source keeps playing.
    // (Each source also carries one engine-scheduled natural end stop.)
    const cancelled = take.sources.filter(source => source.cancelCalls > 0);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0], take.sources[0]);
    assert.equal(take.sources[1].cancelCalls, 0);
    assert.equal(engine.activeClipSources.size, 1);
  });

  it('I: unmuting mid-clip restarts the spanning clip from the correct offset, exactly once', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [makeAudioClip('clip-a', 0, 0, 8)],
      playlistTracks: tracksWithMutes([0], 2)
    });

    // Advance 1s (8 steps) into the 8-bar clip, then unmute the lane live.
    pumpSteps(take.fakeCtx, 8);
    const positionSeconds = take.transport.getState().positionSeconds;
    assert.ok(positionSeconds > 0);

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([], 2) });

    const starts = startsForClip(take);
    assert.equal(starts.length, 1);
    const expectedOffset = positionSeconds; // clip starts at bar 1 -> offset == position
    assert.ok(
      Math.abs(starts[0].offset - expectedOffset) < 1e-6,
      `expected offset ~${expectedOffset}, got ${starts[0].offset}`
    );
  });

  it('J: unmuting never resurrects a clip that is already over, and does not double-trigger a clip starting exactly now', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0]), makeChannel('ch-b', [0])],
      clips: [
        makeAudioClip('clip-past', 0, 0, 1),  // bar 1 only: over after 16 steps
        makePatternClip('clip-future', 0, 'ch-b', 3, 1) // starts at bar 4, step 48
      ],
      playlistTracks: tracksWithMutes([0], 1)
    });

    // Pump to one step before the future clip starts (position 47 * 0.125 = 5.875s).
    pumpSteps(take.fakeCtx, 47);
    const startsBefore = startsForClip(take).length;
    assert.equal(startsBefore, 0); // lane muted: the bar-1 audio clip never sounded

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([], 1) });

    pumpSteps(take.fakeCtx, 2);

    // Only the future pattern clip materialised; the over audio clip stayed silent.
    assert.equal(startsForClip(take).length, 0);
    assert.deepEqual(stepsOf(take.triggered), [0]);
  });

  it('K: pause -> mute lane -> resume keeps the muted lane silent and restarts the still-unmuted spanning clip', () => {
    const channels = [makeChannel('ch-a', [0])];
    const clips = [
      makeAudioClip('clip-a', 0, 0, 8),
      makeAudioClip('clip-b', 1, 0, 8)
    ];
    const take = startSongTake({ channels, clips, playlistTracks: tracksWithMutes([]) });

    pumpSteps(take.fakeCtx, 8);
    engine.pause();

    // Mute lane 0 while paused (the production path writes state, play() receives it).
    engine.play(
      channels,
      clips,
      'song',
      'pat-1',
      [],
      undefined,
      tracksWithMutes([0], 2)
    );

    const starts = startsForClip(take);
    // Exactly one new source: clip-b restarted from the paused position; clip-a stays silent.
    assert.equal(starts.length, 3);
    assert.ok(Math.abs(starts[2].offset - 1.0) < 1e-6, `expected offset ~1.0, got ${starts[2].offset}`);
  });
});

describe('Playlist lane mute — lanes sharing a mixer insert', () => {
  it('L: muting one lane never silences another lane routed to the same insert, nor the channel living on it', () => {
    // ch-x lives on insert 1. Lane 3's audio clip routes there via its channelId;
    // lane 0's audio clip routes there via the lane->insert mapping (trackIndex + 1);
    // lane 4's pattern clip routes there through the channel.
    const channels = [makeChannel('ch-x', [0], 1), makeChannel('ch-other', [0], 2)];
    const { fakeCtx, triggered, sources } = startSongTake({
      channels,
      clips: [
        makeAudioClip('clip-lane0', 0, 0, 8),
        makeAudioClip('clip-lane3-shared-insert', 3, 0, 8, { channelId: 'ch-x' }),
        makePatternClip('clip-lane4-pattern', 4, 'ch-x', 0, 8),
        makePatternClip('clip-other-channel', 5, 'ch-other', 0, 8)
      ],
      playlistTracks: tracksWithMutes([])
    });

    pumpSteps(fakeCtx, 1);
    assert.deepEqual(stepsOf(triggered), [0, 0]); // both pattern clips trigger
    assert.equal(sources.reduce((n, source) => n + source.started.length, 0), 2);

    // Mute lane row 4 — the lane whose pattern clip plays the shared ch-x.
    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([4], 6) });

    pumpSteps(fakeCtx, 16);

    // Tick 16: the muted lane's pattern clip is suppressed; the unmuted channel's
    // clip on lane 5 still fires. Both insert-1 audio clip sources are untouched:
    // the lane mute never reached the shared mixer insert.
    assert.deepEqual(stepsOf(triggered), [0, 0, 0]);
    assert.equal(sources.filter(source => source.cancelCalls > 0).length, 0);
    assert.equal(engine.activeClipSources.size, 2);
  });

  it('M: muting a lane silences its channelId-routed clip without muting the shared insert for others', () => {
    const channels = [makeChannel('ch-x', [0], 1)];
    const take = startSongTake({
      channels,
      clips: [
        makeAudioClip('clip-lane0', 0, 0, 4),                       // insert 1 via lane mapping
        makeAudioClip('clip-lane1-via-channel', 1, 0, 4, { channelId: 'ch-x' }) // insert 1 via channel
      ],
      playlistTracks: tracksWithMutes([], 2)
    });

    pumpSteps(take.fakeCtx, 1);
    assert.equal(startsForClip(take).length, 2);

    // Mute lane row 1: its channel-routed clip dies, lane 0's clip on the SAME insert lives.
    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([1], 2) });

    const cancelled = take.sources.filter(source => source.cancelCalls > 0);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0], take.sources[1]);
    assert.equal(take.sources[0].cancelCalls, 0);
    assert.equal(engine.activeClipSources.size, 1);
  });
});

describe('Playlist lane mute — undo/redo and persistence', () => {
  it('N: undoing a lane-mute edit restores the audible state on the next take', () => {
    const project = createDefaultProjectState();
    project.channels = [makeChannel('ch-a', [0])];
    project.playlistClips = [makePatternClip('clip-a', 0, 'ch-a', 0, 4)];

    const history = createHistory(project);
    const mutedTracks = project.playlistTracks.map((t, i) => makeTrack(t.id, i === 0));
    const mutedState = { ...project, playlistTracks: mutedTracks };
    const afterMute = history.commit(mutedState as any, 'Track change');
    assert.equal(afterMute.present.playlistTracks[0].mute, true);

    const undone = afterMute.undo();
    assert.equal(undone.present.playlistTracks[0].mute, false);

    // The undone (audible) state plays; a take from the muted state does not.
    const silentTake = startSongTake({
      channels: project.channels,
      clips: project.playlistClips,
      playlistTracks: afterMute.present.playlistTracks
    });
    pumpSteps(silentTake.fakeCtx, 1);
    assert.deepEqual(stepsOf(silentTake.triggered), []);

    const audibleTake = startSongTake({
      channels: project.channels,
      clips: project.playlistClips,
      playlistTracks: undone.present.playlistTracks
    });
    pumpSteps(audibleTake.fakeCtx, 1);
    assert.deepEqual(stepsOf(audibleTake.triggered), [0]);
  });

  it('O: lane mute survives serialize -> normalize and still silences the lane', () => {
    const project = createDefaultProjectState();
    project.channels = [makeChannel('ch-a', [0])];
    project.playlistClips = [makePatternClip('clip-a', 1, 'ch-a', 0, 4)];
    const muted = {
      ...project,
      playlistTracks: project.playlistTracks.map((t, i) => makeTrack(t.id, i === 1))
    };

    const document = JSON.parse(serializeProjectState(muted as any));
    const restored = normalizeProjectState(document.state);
    assert.equal(restored.playlistTracks[1].mute, true);
    assert.equal(restored.playlistTracks[0].mute, false);

    const take = startSongTake({
      channels: restored.channels,
      clips: restored.playlistClips,
      playlistTracks: restored.playlistTracks
    });
    pumpSteps(take.fakeCtx, 1);

    assert.deepEqual(stepsOf(take.triggered), []);
  });
});

describe('Playlist lane mute — automation and transport preservation', () => {
  it('P: an automation clip keeps evaluating while an unrelated lane is muted live', () => {
    const automationClip: PlaylistClip = {
      id: 'clip-auto',
      trackIndex: 2,
      startBar: 0,
      lengthBars: 4,
      type: 'automation',
      color: '#a855f7',
      name: 'clip-auto',
      automationTarget: { type: 'mixer_vol', targetId: 1 },
      automationPoints: [
        { x: 0, y: 0.2 },
        { x: 1, y: 0.8 }
      ]
    };
    const { fakeCtx } = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [automationClip],
      playlistTracks: tracksWithMutes([], 3)
    });

    let applied = 0;
    engine.applyAutomationValue = () => { applied += 1; };

    pumpSteps(fakeCtx, 4);
    const beforeMute = applied;
    assert.ok(beforeMute >= 4);

    engine.synchronizePlaybackState({ playlistTracks: tracksWithMutes([1], 3) });

    pumpSteps(fakeCtx, 4);
    assert.ok(applied > beforeMute, 'automation must keep evaluating after an unrelated lane mute');
  });

  it('Q: a muted lane does not move the arrangement end — the song still halts on its real end', () => {
    // The muted audio clip extends the arrangement to 4 bars (64 steps); the
    // unmuted pattern clip only covers bar 1. Song end must stay at step 64.
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [
        makePatternClip('clip-a', 0, 'ch-a', 0, 1),
        makeAudioClip('clip-muted', 1, 0, 4)
      ],
      mutedLaneIndices: [1]
    });

    pumpSteps(take.fakeCtx, 70);

    // The pattern clip lives only on bar 1, so it fires exactly once; the song
    // then runs to the real end defined by the muted audio clip and halts.
    assert.deepEqual(stepsOf(take.triggered), [0]);
    assert.equal(engine.isPlaying, false);
  });

  it('R: Pattern Mode ignores lane mutes entirely', () => {
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
    engine.activeClipSourceLanes = new Map();
    engine.playlistLaneMutes = new Set();
    engine.isPlaying = false;
    engine.bpm = 120;
    engine.metronome = false;
    engine.setSwing(0);

    const triggered: Trigger[] = [];
    engine.playNote = (_channel: Channel, note: Note, time?: number) => {
      triggered.push({ step: note.start, time: time ?? 0, bar: engine.currentBar });
    };

    engine.play(
      [makeChannel('ch-a', [0, 4, 8, 12])],
      [],
      'pat',
      'pat-1',
      [],
      16,
      [makeTrack(1, true), makeTrack(2, true)]
    );

    pumpSteps(fakeCtx, 15);

    // One full 16-step loop, completely unaffected by the lane mutes.
    assert.deepEqual(stepsOf(triggered), [0, 4, 8, 12]);
  });

  it('S: legacy play() without playlistTracks keeps every lane audible', () => {
    const take = startSongTake({
      channels: [makeChannel('ch-a', [0])],
      clips: [
        makePatternClip('clip-a', 0, 'ch-a', 0, 2),
        makeAudioClip('clip-b', 1, 0, 2)
      ]
    });

    pumpSteps(take.fakeCtx, 1);

    assert.deepEqual(stepsOf(take.triggered), [0]);
    assert.equal(startsForClip(take).length, 1);
  });
});
