import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { installLiveFxChainHardening } from './liveFxChainHardening';
import { createDefaultProjectState } from '../state/projectState';
import { updateMacroRackInProjectState } from '../state/projectMutations';
import { resolveMacroRack } from '../state/macroMappings';
import type { MasterMacroKnob, MixerTrack, ProjectState } from '../types/daw';

/**
 * Phase 51 — the Master Macro Rack must produce exactly one set of resolved
 * parameter values, and both render paths must consume that same set.
 *
 *   macro value -> mapping -> resolved value -> ProjectState
 *                                                 |--> live graph  (updateMixerTrack / playback publication)
 *                                                 '--> offline graph (renderTimelineOffline arguments)
 *
 * The tests drive the real `audioEngine` mixer path and the real offline
 * timeline renderer (with a fake Web Audio surface, exactly as the Phase 10A/50
 * suites do), then compare the gain values each path actually received. If a
 * future change made macros resolve separately per render path, the two
 * assertions in `live and offline converge...` would disagree.
 */

// --- fake Web Audio surface ------------------------------------------------

const recordedParams: Array<{ type: string; value: number }> = [];

class FakeAudioParam {
  value: number;
  constructor(value = 1) {
    this.value = value;
  }
  setValueAtTime(value: number): void {
    this.value = value;
    recordedParams.push({ type: 'setValueAtTime', value });
  }
  setTargetAtTime(value: number): void {
    this.value = value;
    recordedParams.push({ type: 'setTargetAtTime', value });
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
    recordedParams.push({ type: 'linearRamp', value });
  }
  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
    recordedParams.push({ type: 'exponentialRamp', value });
  }
  cancelScheduledValues(): void {}
}

class FakeAudioNode {
  readonly connections: unknown[] = [];
  gain = new FakeAudioParam(1);
  pan = new FakeAudioParam(0);
  frequency = new FakeAudioParam(440);
  Q = new FakeAudioParam(1);
  delayTime = new FakeAudioParam(0);
  offset = new FakeAudioParam(0);
  threshold = new FakeAudioParam(-24);
  knee = new FakeAudioParam(30);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
  playbackRate = new FakeAudioParam(1);
  detune = new FakeAudioParam(0);
  fftSize = 256;
  smoothingTimeConstant = 0.7;
  type: string = 'lowpass';
  buffer: AudioBuffer | null = null;
  curve: Float32Array | null = null;
  oversample = 'none';
  connect(target: unknown): unknown {
    this.connections.push(target);
    return target;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0);
  }
  getByteFrequencyData(target: Uint8Array): void {
    target.fill(0);
  }
  getByteTimeDomainData(target: Uint8Array): void {
    target.fill(128);
  }
  getChannelData(): Float32Array {
    return new Float32Array(128);
  }
}

class FakeContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new FakeAudioNode();
  readonly sampleRate = 44100;
  readonly nodes: FakeAudioNode[] = [];

  private node(): FakeAudioNode {
    const node = new FakeAudioNode();
    this.nodes.push(node);
    return node;
  }
  createGain(): FakeAudioNode { return this.node(); }
  createStereoPanner(): FakeAudioNode { return this.node(); }
  createAnalyser(): FakeAudioNode { return this.node(); }
  createBiquadFilter(): FakeAudioNode { return this.node(); }
  createDelay(): FakeAudioNode { return this.node(); }
  createConvolver(): FakeAudioNode { return this.node(); }
  createWaveShaper(): FakeAudioNode { return this.node(); }
  createDynamicsCompressor(): FakeAudioNode { return this.node(); }
  createOscillator(): FakeAudioNode { return this.node(); }
  createConstantSource(): FakeAudioNode { return this.node(); }
  createBufferSource(): FakeAudioNode { return this.node(); }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel],
      copyFromChannel: () => undefined,
      copyToChannel: () => undefined
    } as unknown as AudioBuffer;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    return this.createBuffer(1, 1, this.sampleRate);
  }
}

class FakeOfflineAudioContext extends FakeContext {
  static instances: FakeOfflineAudioContext[] = [];
  readonly numberOfChannels: number;
  readonly length: number;

  constructor(channels: number, length: number, sampleRate: number) {
    super();
    this.numberOfChannels = channels;
    this.length = length;
    (this as { sampleRate: number }).sampleRate = sampleRate;
    FakeOfflineAudioContext.instances.push(this);
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
      copyToChannel: () => undefined
    } as unknown as AudioBuffer;
  }
}

// --- engine harness --------------------------------------------------------

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
  'transportStateCallback', 'stepCallback', 'sampleBuffers', 'projectOwnedSampleBufferIds',
  'sessionSampleBufferIds', 'liveSampleBuffersDuringOfflineRender',
  'liveProjectSampleBufferIdsDuringOfflineRender', 'liveSessionSampleBufferIdsDuringOfflineRender'
];

const MACRO_TARGET_TRACK = 5;
const RESOLVED_MIXER_VOLUME = 0.9375; // mixer_volume 0..1.25 at 75% travel
const RESOLVED_REVERB_WET = 0.7; // reverb_wet 0.1..0.9 at 75% travel
const RESOLVED_DELAY_FEEDBACK = 0.989;
const RESOLVED_CHANNEL_VOLUME = 0.8; // channel_volume 0.2..1 at 75% travel
const RESOLVED_FILTER_CUTOFF = 18000;
const BLOCKED_LIVE_VOLUME = 0.021; // deliberately unlike any preset gain

const rack: MasterMacroKnob[] = [
  {
    id: 'macro-phase51',
    name: 'PHASE 51 SWEEP',
    value: 0.75,
    color: '#00ff88',
    mappings: [
      { targetType: 'mixer_volume', targetId: MACRO_TARGET_TRACK, min: 0, max: 1.25, curve: 'linear' },
      { targetType: 'reverb_wet', targetId: MACRO_TARGET_TRACK, min: 0.1, max: 0.9, curve: 'linear' },
      { targetType: 'channel_volume', targetId: 'ch-1', min: 0.2, max: 1, curve: 'linear' }
    ]
  },
  {
    id: 'macro-phase51-delay',
    name: 'PHASE 51 DELAY',
    value: 1,
    color: '#00e5ff',
    mappings: [
      { targetType: 'delay_feedback', targetId: MACRO_TARGET_TRACK, min: 0, max: RESOLVED_DELAY_FEEDBACK, curve: 'linear' },
      { targetType: 'filter_cutoff', targetId: 'ch-1', min: 200, max: 18000, curve: 'exponential' }
    ]
  }
];

/** Applies the macro rack through the real mutation boundary. */
const applyRack = (state: ProjectState): ProjectState =>
  updateMacroRackInProjectState(state, rack);

const trackOf = (state: ProjectState, id: number): MixerTrack =>
  state.mixerTracks.find(track => track.id === id)!;

const slotOf = (state: ProjectState, trackId: number, slotId: string) =>
  trackOf(state, trackId).fxSlots.find(slot => slot.id === slotId)!;

const hasRecordedValue = (
  value: number,
  type?: 'setValueAtTime' | 'setTargetAtTime',
  tolerance = 1e-9
): boolean =>
  recordedParams.some(entry =>
    (type === undefined || entry.type === type) && Math.abs(entry.value - value) < tolerance
  );

beforeEach(() => {
  for (const field of engineFields) savedEngineState[field] = engine[field];
  recordedParams.length = 0;
  FakeOfflineAudioContext.instances.length = 0;

  engine.ctx = null;
  engine.liveCtx = null;
  engine.transport = null;
  engine.isPlaying = false;
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
  engine.activeChannelVoices = undefined;
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.activeChannels = [];
  engine.activeClips = [];
  engine.activeMixerTracks = [];
  engine.playbackProjectChannels = [];
  engine.playbackProjectMixerTracks = [];
  engine.activePlayMode = 'song';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.currentStep = 0;
  engine.currentBar = 1;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.sampleBuffers = new Map();
  engine.projectOwnedSampleBufferIds = new Set();
  engine.sessionSampleBufferIds = new Set();

  // main.tsx installs the production live/offline FX factory at app init; the
  // macro wet/feedback targets are only observable through it.
  installLiveFxChainHardening(audioEngine);
  (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
  engine.buildReverbImpulse = () => undefined;
  engine.startMasterMeasurementPump = () => undefined;
  engine.stopMasterMeasurementPump = () => undefined;
  engine.resetMasterMeasurement = () => undefined;
});

afterEach(() => {
  for (const field of engineFields) engine[field] = savedEngineState[field];
  engine.buildReverbImpulse = savedEngineState.buildReverbImpulse as never;
  delete (globalThis as any).OfflineAudioContext;
});

// --- tests -----------------------------------------------------------------

describe('Phase 51 macro runtime', () => {
  it('resolves all seven target kinds to real parameter writes', () => {
    const state = createDefaultProjectState();

    const sevenRack: MasterMacroKnob[] = [{
      id: 'macro-all-targets',
      name: 'ALL TARGETS',
      value: 0.5,
      color: '#ff6e00',
      mappings: [
        { targetType: 'channel_volume', targetId: 'ch-1', min: 0.2, max: 1, curve: 'linear' },
        { targetType: 'channel_pan', targetId: 'ch-1', min: -1, max: 1, curve: 'linear' },
        { targetType: 'mixer_volume', targetId: MACRO_TARGET_TRACK, min: 0, max: 1.25, curve: 'linear' },
        { targetType: 'mixer_pan', targetId: MACRO_TARGET_TRACK, min: -1, max: 1, curve: 'linear' },
        { targetType: 'filter_cutoff', targetId: 'ch-1', min: 200, max: 18000, curve: 'exponential' },
        { targetType: 'reverb_wet', targetId: MACRO_TARGET_TRACK, min: 0, max: 1, curve: 'linear' },
        { targetType: 'delay_feedback', targetId: MACRO_TARGET_TRACK, min: 0, max: 0.989, curve: 'linear' }
      ]
    }];

    const resolved = updateMacroRackInProjectState(state, sevenRack);
    const resolution = resolveMacroRack(sevenRack, state);

    assert.equal(resolution.parameters.length, 7);
    assert.equal(resolution.unresolved.length, 0);
    assert.ok(Math.abs(resolved.channels[0].volume - 0.6) < 1e-12, 'channel volume is 60% of its range');
    assert.equal(resolved.channels[0].pan, 0);
    assert.equal(trackOf(resolved, MACRO_TARGET_TRACK).volume, 0.625);
    assert.equal(trackOf(resolved, MACRO_TARGET_TRACK).pan, 0);
    assert.equal(resolved.channels[0].synthParams.filterCutoff, 4650);
    assert.equal(slotOf(resolved, MACRO_TARGET_TRACK, 'fx-5-delay').params.feedback, 0.4945);
    assert.ok(
      Math.abs(slotOf(resolved, MACRO_TARGET_TRACK, 'fx-5-verb').mix - 0.5) < 1e-12,
      'reverb wet resolves onto the existing reverb slot'
    );
  });

  it('applies the rack atomically, so one state carries the knobs and their targets', () => {
    const state = createDefaultProjectState();
    const resolved = applyRack(state);

    assert.equal(resolved.macroKnobs![0].value, 0.75);
    assert.equal(trackOf(resolved, MACRO_TARGET_TRACK).volume, RESOLVED_MIXER_VOLUME);
    assert.ok(Math.abs(slotOf(resolved, MACRO_TARGET_TRACK, 'fx-5-verb').mix - RESOLVED_REVERB_WET) < 1e-12);
    assert.equal(slotOf(resolved, MACRO_TARGET_TRACK, 'fx-5-delay').params.feedback, RESOLVED_DELAY_FEEDBACK);
    assert.equal(resolved.channels[0].volume, RESOLVED_CHANNEL_VOLUME);
    assert.equal(resolved.channels[0].synthParams.filterCutoff, RESOLVED_FILTER_CUTOFF);
    assert.deepEqual(resolved, applyRack(state), 'resolution is deterministic');
  });

  it('live and offline converge on exactly the same mixer gain for the same rack', async () => {
    const resolved = applyRack(createDefaultProjectState());
    const expected = trackOf(resolved, MACRO_TARGET_TRACK).volume;

    // Offline: the real timeline renderer, fed the resolved project state.
    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      true,
      'song',
      undefined,
      undefined,
      undefined,
      0
    );
    const offlineApplied = hasRecordedValue(expected);

    // Live: the real mixer path the app calls when the transport is idle.
    engine.ctx = new FakeContext();
    engine.masterGain = new FakeAudioNode();
    engine.mixerChannels = new Map();
    engine.updateMixerTrack(trackOf(resolved, MACRO_TARGET_TRACK));
    const liveGain = engine.getOrCreateMixerChannel(MACRO_TARGET_TRACK).output.gain.value;

    assert.ok(offlineApplied, 'the offline graph received the macro-resolved mixer gain');
    assert.equal(liveGain, expected, 'the live graph received the same macro-resolved gain');
    assert.equal(offlineApplied && liveGain === expected, true);
  });

  it('offline export receives the resolved value, not the pre-macro one', async () => {
    const baseline = createDefaultProjectState();
    const resolved = applyRack(baseline);
    const preMacroValue = trackOf(baseline, MACRO_TARGET_TRACK).volume;
    assert.notEqual(preMacroValue, RESOLVED_MIXER_VOLUME, 'the fixture must move the value');

    let offlineTrackVolume: number | null = null;

    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      true,
      'song',
      (percent: number) => {
        if (percent >= 40 && offlineTrackVolume === null && engine.activeMixerTracks.length > 0) {
          const offlineTracks = structuredClone(engine.activeMixerTracks) as MixerTrack[];
          offlineTrackVolume = offlineTracks.find(track => track.id === MACRO_TARGET_TRACK)?.volume ?? null;
        }
      },
      undefined,
      undefined,
      0
    );

    assert.equal(
      offlineTrackVolume,
      RESOLVED_MIXER_VOLUME,
      'the offline take was built from the macro-resolved mixer volume'
    );
    assert.notEqual(offlineTrackVolume, preMacroValue);
    assert.ok(
      hasRecordedValue(RESOLVED_MIXER_VOLUME, 'setTargetAtTime'),
      'and that exact value reached the offline mixer gain'
    );
  });

  it('offline FX chains are built from the macro-resolved wet and feedback values', async () => {
    const resolved = applyRack(createDefaultProjectState());

    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      true,
      'song',
      undefined,
      undefined,
      undefined,
      0
    );

    assert.ok(
      hasRecordedValue(RESOLVED_REVERB_WET, 'setValueAtTime'),
      'the offline reverb wet/dry wrapper was built with the resolved wet value'
    );
    assert.ok(
      hasRecordedValue(1 - RESOLVED_REVERB_WET, 'setValueAtTime'),
      'and its complementary dry value'
    );
    assert.ok(
      hasRecordedValue(RESOLVED_DELAY_FEEDBACK, 'setValueAtTime'),
      'the offline delay feedback gain is the resolved value'
    );
  });

  it('offline channels carry the resolved channel volume and filter cutoff', async () => {
    const resolved = applyRack(createDefaultProjectState());
    let channelsSeenByOffline: ProjectState['channels'] | null = null;

    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      true,
      'song',
      (percent: number) => {
        if (percent >= 40 && channelsSeenByOffline === null) {
          channelsSeenByOffline = structuredClone(engine.activeChannels);
        }
      },
      undefined,
      undefined,
      0
    );

    assert.ok(channelsSeenByOffline !== null, 'the render reported progress while its state was live');
    const offlineChannel = (channelsSeenByOffline as ProjectState['channels'])[0];
    assert.equal(offlineChannel.volume, RESOLVED_CHANNEL_VOLUME);
    assert.equal(offlineChannel.synthParams.filterCutoff, RESOLVED_FILTER_CUTOFF);
  });

  it('honours the Phase 50 offline lease: live macro writes are blocked while it is held', async () => {
    const resolved = applyRack(createDefaultProjectState());
    let leaseHeldDuringRender = false;
    let sawBlockedWrite = false;
    let volumeSeenByOfflineAfterBlockedWrite: number | null = null;

    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      true,
      'song',
      (percent: number) => {
        if (percent < 40 || sawBlockedWrite || engine.offlineRenderOperationDepth > 0) return;
        // Wait until the frozen offline take has actually been published.
        if (engine.activeMixerTracks.length === 0) return;
        leaseHeldDuringRender = engine.isOfflineRenderLeaseHeld();
        sawBlockedWrite = true;
        // A macro move that arrives mid-render must not disturb the frozen take.
        engine.updateMixerTrack({
          ...trackOf(resolved, MACRO_TARGET_TRACK),
          volume: BLOCKED_LIVE_VOLUME
        });
        const offlineTracks = structuredClone(engine.activeMixerTracks) as MixerTrack[];
        volumeSeenByOfflineAfterBlockedWrite =
          offlineTracks.find(track => track.id === MACRO_TARGET_TRACK)?.volume ?? null;
      },
      undefined,
      undefined,
      0
    );

    assert.equal(leaseHeldDuringRender, true, 'the render holds the offline lease');
    assert.equal(engine.isOfflineRenderLeaseHeld(), false, 'the lease is released afterwards');
    assert.equal(
      hasRecordedValue(BLOCKED_LIVE_VOLUME),
      false,
      'the blocked live write never reached the offline graph'
    );
    assert.equal(
      volumeSeenByOfflineAfterBlockedWrite,
      RESOLVED_MIXER_VOLUME,
      'the frozen offline take kept the macro-resolved value'
    );
    assert.ok(
      hasRecordedValue(RESOLVED_MIXER_VOLUME, 'setTargetAtTime'),
      'the offline graph still carries the macro-resolved value'
    );
    assert.equal(
      trackOf(resolved, MACRO_TARGET_TRACK).volume,
      RESOLVED_MIXER_VOLUME,
      'the resolved project state is unaffected by the blocked live write'
    );
  });

  it('an unresolvable macro target is a silent no-op at runtime', async () => {
    const state = createDefaultProjectState();
    const brokenRack: MasterMacroKnob[] = [{
      ...rack[0],
      mappings: [
        { targetType: 'channel_volume', targetId: 'bass', min: 0.4, max: 1, curve: 'linear' },
        { targetType: 'mixer_volume', targetId: 99, min: 0, max: 1.25, curve: 'linear' },
        { targetType: 'reverb_wet', targetId: 1, min: 0, max: 1, curve: 'linear' }
      ]
    }];

    const resolved = updateMacroRackInProjectState(state, brokenRack);

    assert.deepEqual(resolved.channels, state.channels);
    assert.deepEqual(resolved.mixerTracks, state.mixerTracks);
    assert.equal(resolved.macroKnobs![0].value, 0.75, 'the knob still moves');

    // The export path still renders, because nothing was written with a bad value.
    await engine.renderTimelineOffline(
      resolved.channels,
      [],
      resolved.mixerTracks,
      128,
      1,
      44100,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      0
    );
    assert.equal(engine.isOfflineRenderLeaseHeld(), false);
  });
});
