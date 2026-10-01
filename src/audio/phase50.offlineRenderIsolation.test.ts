import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AudioClockTransport } from './transport';
import { audioEngine } from './audioEngine';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';

class FakeAudioParam {
  value: number;
  constructor(value = 1) { this.value = value; }
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class FakeAudioNode {
  readonly connections: unknown[] = [];
  gain = new FakeAudioParam(1);
  pan = new FakeAudioParam(0);
  frequency = new FakeAudioParam(440);
  Q = new FakeAudioParam(1);
  delayTime = new FakeAudioParam(0);
  threshold = new FakeAudioParam(-24);
  knee = new FakeAudioParam(30);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
  playbackRate = new FakeAudioParam(1);
  detune = new FakeAudioParam(0);
  fftSize = 512;
  smoothingTimeConstant = 0.8;
  type: string = 'sine';
  buffer: AudioBuffer | null = null;
  curve: Float32Array | null = null;
  oversample = 'none';
  startCalls: number[] = [];
  stopCalls: number[] = [];
  connect(target: unknown): unknown { this.connections.push(target); return target; }
  disconnect(): void { this.connections.length = 0; }
  start(when = 0): void { this.startCalls.push(when); }
  stop(when = 0): void { this.stopCalls.push(when); }
  addEventListener(): void {}
  getFloatTimeDomainData(target: Float32Array): void { target.fill(0); }
  getByteFrequencyData(target: Uint8Array): void { target.fill(0); }
  getByteTimeDomainData(target: Uint8Array): void { target.fill(128); }
}

class FakeOfflineAudioContext {
  static instances: FakeOfflineAudioContext[] = [];
  readonly destination = new FakeAudioNode();
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  currentTime = 0;
  readonly createdGains: FakeAudioNode[] = [];
  readonly createdOscillators: FakeAudioNode[] = [];
  readonly createdBufferSources: FakeAudioNode[] = [];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    FakeOfflineAudioContext.instances.push(this);
  }

  createGain(): FakeAudioNode {
    const node = new FakeAudioNode();
    this.createdGains.push(node);
    return node;
  }
  createAnalyser(): FakeAudioNode { return new FakeAudioNode(); }
  createStereoPanner(): FakeAudioNode { return new FakeAudioNode(); }
  createOscillator(): FakeAudioNode {
    const node = new FakeAudioNode();
    this.createdOscillators.push(node);
    return node;
  }
  createBufferSource(): FakeAudioNode {
    const node = new FakeAudioNode();
    this.createdBufferSources.push(node);
    return node;
  }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel],
      copyFromChannel: () => undefined,
      copyToChannel: () => undefined,
    } as unknown as AudioBuffer;
  }
  async startRendering(): Promise<AudioBuffer> {
    const data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
    return {
      numberOfChannels: this.numberOfChannels,
      length: this.length,
      sampleRate: this.sampleRate,
      duration: this.length / this.sampleRate,
      getChannelData: (channel: number) => data[channel],
      copyFromChannel: () => undefined,
      copyToChannel: () => undefined,
    } as unknown as AudioBuffer;
  }
}

class FakeLiveAudioContext extends FakeOfflineAudioContext {
  state: AudioContextState = 'running';
  async resume(): Promise<void> { this.state = 'running'; }
  async decodeAudioData(): Promise<AudioBuffer> {
    return this.createBuffer(1, 1, this.sampleRate);
  }
}

const engine = audioEngine as any;
const savedEngineState: Record<string, unknown> = {};
const engineFields = [
  'ctx', 'liveCtx', 'transport', 'isPlaying', 'playbackGeneration', 'isOfflineRendering',
  'offlineRenderLeaseHeld', 'offlineRenderOperationDepth', 'masterGain', 'masterAnalyser',
  'grossBeatNode', 'mixerChannels', 'mixerRoutingAdapter', 'mixerRoutingChannelMap',
  'impulseResponses', 'activeVoices', 'activeDrumPadVoices', 'activeClipSources',
  'activeClipSourceLanes', 'playlistLaneMutes', 'activeChannels', 'activeClips',
  'activeMixerTracks', 'playbackProjectChannels', 'playbackProjectMixerTracks',
  'activePlayMode', 'activePatternId', 'activePatternLengthSteps', 'currentStep',
  'currentBar', 'bpm', 'swing', 'metronome', 'grossBeatState', 'timerId',
  'transportStateCallback', 'stepCallback', 'measurementTimerId', 'measurementPumping',
  'sampleBuffers', 'projectOwnedSampleBufferIds', 'sessionSampleBufferIds',
  'liveSampleBuffersDuringOfflineRender', 'liveProjectSampleBufferIdsDuringOfflineRender',
  'liveSessionSampleBufferIdsDuringOfflineRender',
];

let previousWindow: unknown;
let previousOfflineAudioContext: unknown;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalBuildReverbImpulse: unknown;
let originalStartMasterMeasurementPump: unknown;
let originalStopMasterMeasurementPump: unknown;
let originalResetMasterMeasurement: unknown;

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'export-channel',
    name: 'Export channel',
    color: '#38bdf8',
    instrumentType: 'minisynth',
    mixerTrackId: 1,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array.from({ length: 16 }, () => false),
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    ...overrides,
  };
}

function makeMixerTrack(id: number, volume = 0.8): MixerTrack {
  return {
    id,
    name: id === 0 ? 'Master' : `Insert ${id}`,
    color: '#38bdf8',
    volume,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  };
}

function makeClip(id: string): PlaylistClip {
  return {
    id,
    name: id,
    trackIndex: 0,
    startBar: 0,
    lengthBars: 1,
    type: 'pattern',
    channelId: 'export-channel',
    color: '#38bdf8',
  };
}

const projectMixerTracks = [makeMixerTrack(0, 1), makeMixerTrack(1, 0.8)];

function resetEngineForTest(): void {
  if (engine.transport) {
    try { engine.transport.stop(false); } catch { /* test teardown */ }
  }
  for (const field of engineFields) savedEngineState[field] = engine[field];

  engine.ctx = null;
  engine.liveCtx = null;
  engine.transport = null;
  engine.isPlaying = false;
  engine.playbackGeneration = 0;
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.masterGain = null;
  engine.masterAnalyser = null;
  engine.grossBeatNode = null;
  engine.mixerChannels = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.impulseResponses = new Map();
  engine.activeVoices = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.activeChannels = [];
  engine.activeClips = [];
  engine.activeMixerTracks = [];
  engine.playbackProjectChannels = [];
  engine.playbackProjectMixerTracks = [];
  engine.activePlayMode = 'pat';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.currentStep = 0;
  engine.currentBar = 1;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.grossBeatState = {
    enabled: false,
    preset: 'half_time',
    mix: 1,
    speed: 0.5,
    tapeStopActive: false,
    tapeStopDurationMs: 600,
    gateSteps: Array.from({ length: 16 }, (_, index) => index % 2 === 0),
    pitchShiftSemitones: -12,
  };
  engine.timerId = null;
  engine.transportStateCallback = null;
  engine.stepCallback = null;
  engine.measurementTimerId = null;
  engine.measurementPumping = false;
  engine.sampleBuffers = new Map();
  engine.projectOwnedSampleBufferIds = new Set();
  engine.sessionSampleBufferIds = new Set();
  engine.liveSampleBuffersDuringOfflineRender = null;
  engine.liveProjectSampleBufferIdsDuringOfflineRender = null;
  engine.liveSessionSampleBufferIdsDuringOfflineRender = null;
  engine.buildReverbImpulse = () => undefined;
  engine.startMasterMeasurementPump = () => undefined;
  engine.stopMasterMeasurementPump = () => undefined;
  engine.resetMasterMeasurement = () => undefined;
}

function restoreEngineAfterTest(): void {
  if (engine.transport && engine.transport !== savedEngineState.transport) {
    try { engine.transport.stop(false); } catch { /* test teardown */ }
  }
  for (const field of engineFields) engine[field] = savedEngineState[field];
  engine.buildReverbImpulse = originalBuildReverbImpulse;
  engine.startMasterMeasurementPump = originalStartMasterMeasurementPump;
  engine.stopMasterMeasurementPump = originalStopMasterMeasurementPump;
  engine.resetMasterMeasurement = originalResetMasterMeasurement;
}

async function renderAndMutateWhilePaused(
  action: (offlineContext: FakeOfflineAudioContext) => void | Promise<void>,
  channels: Channel[] = [makeChannel()],
  clips: PlaylistClip[] = [makeClip('export-snapshot')],
): Promise<AudioBuffer> {
  let releaseRenderBatch: (() => void) | null = null;
  let notifyRenderPaused: (() => void) | null = null;
  const renderPaused = new Promise<void>(resolve => { notifyRenderPaused = resolve; });
  const continueBatch = new Promise<void>(resolve => { releaseRenderBatch = resolve; });
  let heldFirstBatch = false;

  originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    if (!heldFirstBatch && delay === 0) {
      heldFirstBatch = true;
      notifyRenderPaused?.();
      void continueBatch.then(() => callback(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback as never, delay as never, ...args as never);
  }) as typeof globalThis.setTimeout;

  const renderPromise = engine.renderTimelineOffline(
    channels,
    clips,
    projectMixerTracks,
    120,
    1,
    44100,
    false,
    'pattern',
    undefined,
    16,
    undefined,
  ) as Promise<AudioBuffer>;

  let actionError: unknown;
  try {
    await renderPaused;
    const offlineContext = FakeOfflineAudioContext.instances.at(-1)!;
    await action(offlineContext);
  } catch (error) {
    actionError = error;
  } finally {
    releaseRenderBatch?.();
  }

  let renderError: unknown;
  let result: AudioBuffer | undefined;
  try {
    result = await renderPromise;
  } catch (error) {
    renderError = error;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  if (actionError) throw actionError;
  if (renderError) throw renderError;
  return result!;
}

// These are explicit node:test hooks rather than global before/after hooks so
// every case owns its own audio context and does not depend on test ordering.
function beginTestEnvironment(): void {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  previousWindow = (globalThis as any).window;
  previousOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  originalClearTimeout = globalThis.clearTimeout;
  originalBuildReverbImpulse = engine.buildReverbImpulse;
  originalStartMasterMeasurementPump = engine.startMasterMeasurementPump;
  originalStopMasterMeasurementPump = engine.stopMasterMeasurementPump;
  originalResetMasterMeasurement = engine.resetMasterMeasurement;
  resetEngineForTest();
  FakeOfflineAudioContext.instances = [];
  (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
  (globalThis as any).window = {
    OfflineAudioContext: FakeOfflineAudioContext,
    AudioContext: FakeLiveAudioContext,
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      originalSetTimeout(callback as never, delay as never, ...args as never),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => originalClearTimeout(handle),
  };
}

function endTestEnvironment(): void {
  restoreEngineAfterTest();
  (globalThis as any).OfflineAudioContext = previousOfflineAudioContext;
  if (previousWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = previousWindow;
}

function isolatedTest(name: string, run: () => void | Promise<void>): void {
  test(name, async () => {
    beginTestEnvironment();
    try {
      await run();
    } finally {
      endTestEnvironment();
    }
  });
}

isolatedTest('Phase 50 A: project synchronization / undo cannot replace the offline render snapshot', async () => {
  const offlineChannel = makeChannel({ volume: 0.8 });
  const originalClips = [makeClip('export-snapshot')];
  await renderAndMutateWhilePaused(() => {
    assert.equal(engine.isPlaying, true, 'the renderer marks only its own schedule as playing');
    engine.synchronizePlaybackState({
      channels: [makeChannel({ volume: 0.2 })],
      clips: [makeClip('undo-replacement')],
      patternLengthSteps: 32,
    });
    assert.equal(engine.activeChannels[0].volume, offlineChannel.volume);
    assert.equal(engine.activeClips[0].id, originalClips[0].id);
  }, [offlineChannel], originalClips);
});

isolatedTest('Phase 50 B/F: live play cannot create a transport bound to OfflineAudioContext', async () => {
  let attemptedTransport: AudioClockTransport | null = null;
  let transportWasCreatedDuringRender = false;
  let contextDuringRender: unknown;
  let playingDuringRender: unknown;
  await renderAndMutateWhilePaused((offlineContext) => {
    engine.play([], [], 'pat', undefined, [], 16);
    attemptedTransport = engine.transport;
    transportWasCreatedDuringRender = engine.transport !== null;
    contextDuringRender = engine.ctx;
    playingDuringRender = engine.isPlaying;
    assert.equal(contextDuringRender, offlineContext);
  });
  if (attemptedTransport) attemptedTransport.stop(false);
  assert.equal(transportWasCreatedDuringRender, false, 'offline renderer keeps its transport slot reserved');
  assert.equal(playingDuringRender, true, 'play does not change the render playing state');
});

isolatedTest('Phase 50 C: live stop cannot change the offline render playing state', async () => {
  await renderAndMutateWhilePaused(() => {
    assert.equal(engine.isPlaying, true);
    engine.stop();
    assert.equal(engine.isPlaying, true, 'live Stop is ignored while the offline lease is held');
  });
});

isolatedTest('Phase 50 D: live mixer edits cannot write into the offline graph', async () => {
  await renderAndMutateWhilePaused(() => {
    const mixerChannel = engine.mixerChannels.get(1);
    assert.ok(mixerChannel);
    const renderGain = mixerChannel.output.gain.value;
    engine.updateMixerTrack({ ...projectMixerTracks[1], volume: 0.12 });
    assert.equal(mixerChannel.output.gain.value, renderGain);
  });
});

isolatedTest('Phase 50 E: live automation cannot mutate offline scheduled project values', async () => {
  const channel = makeChannel({ volume: 0.8 });
  await renderAndMutateWhilePaused(() => {
    const renderedChannel = engine.activeChannels[0];
    engine.applyAutomationValue(
      { type: 'channel_vol', targetId: renderedChannel.id },
      0,
      engine.activeChannels,
      engine.activeMixerTracks,
      0,
    );
    assert.equal(renderedChannel.volume, channel.volume);
  }, [channel]);
});

isolatedTest('Phase 50 voice: live note triggers cannot add voices to the offline graph', async () => {
  const originalPlaySingleVoice = engine.playSingleVoice;
  let liveVoiceCount = 0;
  engine.playSingleVoice = () => { liveVoiceCount += 1; };
  try {
    await renderAndMutateWhilePaused(() => {
      engine.playNote(makeChannel(), {
        id: 'live-note-during-export',
        pitch: 60,
        start: 0,
        duration: 1,
        velocity: 0.9,
      });
      assert.equal(liveVoiceCount, 0, 'live notes are rejected before voice creation');
    });
  } finally {
    engine.playSingleVoice = originalPlaySingleVoice;
  }
});

isolatedTest('Phase 50 J: render restores the original live context and playing transport state', async () => {
  const liveContext = new FakeLiveAudioContext(2, 44100, 44100);
  const liveTransport = new AudioClockTransport(liveContext as unknown as AudioContext);
  engine.ctx = liveContext;
  engine.transport = liveTransport;
  engine.isPlaying = true;
  liveTransport.start();
  assert.equal(liveTransport.getState().playing, true);

  await engine.renderTimelineOffline(
    [makeChannel()],
    [makeClip('export-snapshot')],
    projectMixerTracks,
    120,
    1,
    44100,
    false,
    'pattern',
    undefined,
    16,
  );

  assert.equal(engine.isPlaying, true);
  assert.equal(engine.ctx, liveContext);
  assert.equal(engine.transport, liveTransport);
  assert.equal((liveTransport as any).context, liveContext);
  assert.equal(liveTransport.getState().playing, true);
  liveTransport.stop(false);
});

isolatedTest('Phase 50 G: combined live mutations cannot alter offline render trigger count', async () => {
  const noteTriggers: number[] = [];
  const originalPlayNote = engine.playNote;
  engine.playNote = (_channel: Channel, note: { start: number }) => noteTriggers.push(note.start);
  const channel = makeChannel({ steps: Array.from({ length: 16 }, (_, index) => index === 0) });
  try {
    await renderAndMutateWhilePaused(() => {
      engine.synchronizePlaybackState({
        channels: [makeChannel({ steps: Array.from({ length: 16 }, () => true) })],
        clips: [],
      });
      engine.play([makeChannel({ steps: Array.from({ length: 16 }, () => true) })], [], 'pat', undefined, [], 16);
      engine.updateMixerTrack({ ...projectMixerTracks[1], volume: 0.05 });
      engine.applyAutomationValue(
        { type: 'channel_vol', targetId: channel.id },
        0,
        engine.activeChannels,
        engine.activeMixerTracks,
        0,
      );
      engine.stop();
    }, [channel], []);
    assert.equal(noteTriggers.length, 2, 'only the renderer schedules its two step-zero events');
  } finally {
    engine.playNote = originalPlayNote;
  }
});

isolatedTest('Phase 50 I/L/K: renderer schedules offline audio and playback still works afterward', async () => {
  const scheduledContexts: unknown[] = [];
  const originalPlayNote = engine.playNote;
  engine.playNote = function (_channel: Channel, _note: unknown) {
    scheduledContexts.push(this.ctx);
  };
  try {
    const rendered = await engine.renderTimelineOffline(
      [makeChannel({ steps: Array.from({ length: 16 }, (_, index) => index === 0) })],
      [],
      projectMixerTracks,
      120,
      1,
      44100,
      false,
      'pattern',
      undefined,
      16,
    );
    const renderedContext = FakeOfflineAudioContext.instances.at(-1)!;
    assert.equal(rendered.sampleRate, 44100, 'offline export resolves successfully');
    assert.ok(renderedContext.createdGains.length > 0, 'the offline graph is constructed');
    assert.equal(scheduledContexts.length, 2, 'the renderer schedules its two pattern passes');
    assert.ok(scheduledContexts.every(context => context === renderedContext), 'renderer-internal schedule uses OfflineAudioContext');
    assert.equal(engine.isOfflineRendering, false);
    assert.equal(engine.ctx, null);

    const liveContext = new FakeLiveAudioContext(2, 44100, 44100);
    engine.ctx = liveContext;
    scheduledContexts.length = 0;
    engine.play([makeChannel({ steps: Array.from({ length: 16 }, (_, index) => index === 0) })], [], 'pat', undefined, [], 16);
    assert.equal(engine.isPlaying, true);
    assert.ok(engine.transport, 'normal playback creates a transport after export');
    assert.equal((engine.transport as any).context, liveContext);
    assert.equal(scheduledContexts[0], liveContext, 'normal playback schedules on the live context');
    engine.stop();
  } finally {
    engine.playNote = originalPlayNote;
  }
});

isolatedTest('Phase 50 H: App transport, record and undo shortcuts are guarded during offline rendering', () => {
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const handlerStart = appSource.indexOf('const handleKeyDown = (e: KeyboardEvent) =>');
  const handlerEnd = appSource.indexOf('const handleKeyUp = (e: KeyboardEvent) =>', handlerStart);
  assert.notEqual(handlerStart, -1, 'App keyboard handler exists');
  assert.notEqual(handlerEnd, -1, 'App key-up handler follows the key-down handler');
  const handler = appSource.slice(handlerStart, handlerEnd);
  const leaseGuardIndex = handler.indexOf('isOfflineRenderLeaseHeld()');
  assert.notEqual(leaseGuardIndex, -1, 'keyboard mutations consult the offline-render lease');
  assert.ok(leaseGuardIndex < handler.indexOf("if (shortcut.action === 'undo')"), 'offline guard runs before undo/redo actions');
  for (const shortcut of ['Space', 'KeyL', 'KeyR', 'KeyM', 'Numpad0', 'Home']) {
    assert.ok(handler.includes(shortcut), `offline guard must account for ${shortcut}`);
  }
  assert.ok(handler.includes('shortcut.action !== \'none\''), 'offline guard accounts for Ctrl+Z and Ctrl+Shift+Z');
  assert.ok(handler.includes("e.key === '0'"), 'offline guard accounts for the stop key');
  assert.ok(handler.includes('KEY_NOTE_MAP[e.code]'), 'offline guard accounts for keyboard note triggers');
});

/*
 * Baseline a449b553e94298daaaf1e3badf849acd7cffc265 run (before production
 * edits): 8 failures and 1 passing control (A-H and J failed; I passed).
 * Synchronization replaced the renderer snapshot; play created an
 * OfflineAudioContext transport; stop flipped the render's playing flag; mixer
 * and automation writes reached the offline graph/state; the combined actions
 * changed its note count; App shortcuts had no render guard; and the renderer
 * stopped the original live transport without restoring its playing state.
 * The separate voice-trigger assertion additionally pins the same baseline
 * defect for live notes; the renderer/export and post-render playback controls
 * I/L/K pass on the untouched baseline.
 * The render/export, renderer-internal scheduling and post-render playback
 * controls (I/L/K) pass on the baseline.
 */
