/**
 * FX-map lifecycle safety — native production-path regressions.
 *
 * PR #230 gave `AudioEngine` its own native FX-slot registry
 * (`__fxSlotEffectMaps`, populated by `rebuildTrackFxChain`) and PR #232 made
 * that registry the authority for live parameter/mix updates. The registry owns
 * real `AudioEffect` instances, and several of those effects start a modulator
 * oscillator of their own (`ChorusEffect` starts `lfo` + `lfoOffset`; the tape
 * composite starts its flutter LFO). `CompositeEffect.dispose()` /
 * `ChorusEffect.dispose()` are the only calls that stop them.
 *
 * The native registry never called `dispose()`: it dropped its own map entries
 * and `disconnect()`ed nodes, which detaches a graph but leaves a started LFO
 * running forever. `installLiveFxChainHardening` *did* have that lifecycle
 * handling — and PR #230 removed it from production boot, where it had been
 * compensating. This suite therefore deliberately does NOT install
 * `installLiveFxChainHardening`: every test drives the shipped `audioEngine`
 * singleton through the code the shipped app actually runs.
 *
 * ── What is mocked and what is real ───────────────────────────────────────
 * Groups 1–7 are MOCKED LIFECYCLE tests. They use a fake BaseAudioContext so
 * that ownership (dispose calls), modulator state (`start`/`stop`), registry
 * contents and AudioParam writes are directly observable. They prove the
 * lifecycle bookkeeping is correct; they do not prove anything about DSP.
 * Group 8 is REAL DSP validation: it renders audio in `web-audio-engine`'s
 * `OfflineAudioContext` (the same pure-JS engine the `realOfflineRenderNode`
 * harness uses) and measures the samples, so it proves (a) that `dispose()` is
 * a real Web Audio teardown that actually stops a started modulator rather than
 * a bookkeeping flag, and (b) that routing audio through the engine chain
 * — including a full offline export — still sounds the same and still hands the
 * live chain back afterwards.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import type { Channel, FxSlot, FxType, MixerTrack } from '../types/daw';
import { audioEngine } from './audioEngine';
import { createEffect } from './liveFxChainHardening';
import type { AudioEffect } from './effects/AudioEffect';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

// --- Fake Web Audio ------------------------------------------------------------
//
// Every node carries `startedModulators` bookkeeping (`startCalls`/`stopCalls`)
// and a `context` back-reference, because the lifecycle defects are exactly
// "a started source nobody stopped" and "a node that belongs to a context the
// engine no longer renders in".

class FakeParam {
  value: number;
  readonly writes: Array<{ value: number; time: number }> = [];
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number, time = 0): void {
    this.value = value;
    this.writes.push({ value, time });
  }
  linearRampToValueAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
  setTargetAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
  exponentialRampToValueAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
  cancelScheduledValues(): void { this.writes.push({ value: this.value, time: -1 }); }
}

/**
 * When armed, every `FakeNode.connect(target)` whose target is `poisonedConnect.target`
 * throws — once per queued message, then the arm disarms so the *next* edge to
 * the same target succeeds. `connect()` is looked up on the prototype, so nodes
 * created *during* a call under test are covered too: that is what lets a test
 * fail the last connection a chain build makes (its tail -> channel panner edge),
 * which is the `InvalidAccessError`/`InvalidStateError` shape a real browser
 * produces for a node from another or a closed context.
 */
let poisonedConnect: { target: unknown; messages: string[] } | null = null;
const poisonConnectTo = (target: unknown, message: string | string[]): void => {
  poisonedConnect = { target, messages: Array.isArray(message) ? [...message] : [message] };
};

class FakeNode {
  /**
   * Set by the owning FakeContext, mirroring `AudioNode.context`. Non-enumerable
   * on purpose: the node graph is cyclic, and a node object leaking into an
   * assertion diff makes the test reporter walk the whole graph.
   */
  context: FakeContext | null = null;
  connectCalls = 0;
  incomingCalls = 0;
  failedConnects = 0;
  disconnectCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  throwOnDisconnect = false;
  gain = new FakeParam(1);
  pan = new FakeParam(0);
  offset = new FakeParam(0);
  delayTime = new FakeParam(0);
  frequency = new FakeParam(1000);
  Q = new FakeParam(1);
  threshold = new FakeParam(0);
  knee = new FakeParam(0);
  ratio = new FakeParam(1);
  attack = new FakeParam(0);
  release = new FakeParam(0);
  type = 'lowpass';
  curve: Float32Array | null = null;
  oversample: 'none' | '2x' | '4x' = 'none';
  buffer: AudioBuffer | null = null;
  normalize = true;
  fftSize = 0;
  smoothingTimeConstant = 0;
  connect(target?: unknown): void {
    if (poisonedConnect && target === poisonedConnect.target) {
      this.failedConnects += 1;
      const message = poisonedConnect.messages.shift();
      if (poisonedConnect.messages.length === 0) poisonedConnect = null;
      throw new Error(message ?? 'simulated connect failure');
    }
    this.connectCalls += 1;
    if (target instanceof FakeNode) target.incomingCalls += 1;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
    if (this.throwOnDisconnect) throw new Error('fake node disconnect failed');
  }
  start(): void { this.startCalls += 1; }
  stop(): void { this.stopCalls += 1; }
  getFloatTimeDomainData(): void {}
}

/**
 * A context that implements exactly what the engine's mixer/FX path needs.
 * `createChannelSplitter`/`createChannelMerger` are intentionally absent, so
 * `init()` skips the mastering processor and the master measurement tap — the
 * same graceful degradation the engine already documents for lightweight
 * contexts.
 */
class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 2;
  sampleRate = 48000;
  readonly createdNodes: FakeNode[] = [];
  readonly destination = new FakeNode();
  readonly id = `ctx-${Math.random().toString(36).slice(2, 8)}`;

  private register(node: FakeNode): FakeNode {
    Object.defineProperty(node, 'context', { value: this, enumerable: false, configurable: true });
    this.createdNodes.push(node);
    return node;
  }
  /** Every `start()`ed node on this context — i.e. the modulators at stake. */
  startedModulators(): FakeNode[] {
    return this.createdNodes.filter(node => node.startCalls > 0);
  }
  unstoppedModulators(): FakeNode[] {
    return this.startedModulators().filter(node => node.stopCalls === 0);
  }
  createGain(): FakeNode { return this.register(new FakeNode()); }
  createDelay(): FakeNode { return this.register(new FakeNode()); }
  createBiquadFilter(): FakeNode { return this.register(new FakeNode()); }
  createDynamicsCompressor(): FakeNode { return this.register(new FakeNode()); }
  createConvolver(): FakeNode { return this.register(new FakeNode()); }
  createWaveShaper(): FakeNode { return this.register(new FakeNode()); }
  createOscillator(): FakeNode { return this.register(new FakeNode()); }
  createConstantSource(): FakeNode { return this.register(new FakeNode()); }
  createStereoPanner(): FakeNode { return this.register(new FakeNode()); }
  createAnalyser(): FakeNode { return this.register(new FakeNode()); }
  createBufferSource(): FakeNode { return this.register(new FakeNode()); }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data: Float32Array[] = [];
    for (let index = 0; index < channels; index += 1) data.push(new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel] ?? data[0]!,
    } as unknown as AudioBuffer;
  }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
}

class MockOfflineAudioContext extends FakeContext {
  currentTime = 0;
  state = 'suspended' as unknown as AudioContextState;
  readonly length: number;
  /** Set to make `startRendering()` fail, to exercise the `finally` restore. */
  static failNextRender = false;
  constructor(_channels: number, length: number, sampleRate: number) {
    super();
    this.length = length;
    this.sampleRate = sampleRate;
  }
  async startRendering(): Promise<AudioBuffer> {
    if (MockOfflineAudioContext.failNextRender) {
      MockOfflineAudioContext.failNextRender = false;
      throw new Error('simulated OfflineAudioContext render failure');
    }
    return this.createBuffer(2, Math.max(1, this.length), this.sampleRate);
  }
}

// --- Fixtures ------------------------------------------------------------------

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8, enabled = true): FxSlot => ({
  id,
  type,
  name: `${type} ${id}`,
  enabled,
  mix,
  params,
});

const makeTrack = (id: number, fxSlots: FxSlot[]): MixerTrack => ({
  id,
  name: `Insert ${id}`,
  color: '#ffffff',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  routingTargetId: 0,
  fxSlots,
} as MixerTrack);

const makeChannel = (id: string, mixerTrackId = 1): Channel => ({
  id,
  name: id,
  color: '#ff6e00',
  instrumentType: 'minisynth',
  mixerTrackId,
  volume: 0.9,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {
    filterCutoff: 3500,
    filterResonance: 1,
    filterType: 'lowpass',
    filterEnvAmount: 0,
    attack: 0.01,
    decay: 0.15,
    sustain: 0.6,
    release: 0.2,
    unisonVoices: 1,
    osc2Mix: 0.65,
  },
} as Channel);

/** Chorus + tape: both families own a *started* modulator LFO. */
const MODULATOR_SLOTS = (): FxSlot[] => [
  makeSlot('fx-chorus', 'chorus', { rate: 3.1, depth: 0.004, delay: 0.02 }, 0.7),
  makeSlot('fx-tape', 'tape_saturation', { drive: 30, warmth: 0.5, flutter: 0.002 }, 0.6),
];

const modulatorTracks = (): MixerTrack[] => [
  makeTrack(0, []),
  makeTrack(1, MODULATOR_SLOTS()),
  makeTrack(2, [makeSlot('fx-delay', 'delay', { time: 0.3, feedback: 0.4 }, 0.5)]),
];

const modulatorChannels = (): Channel[] => [makeChannel('ch-1', 1), makeChannel('ch-2', 2)];

// --- Engine harness (mirrors `liveFxAutomationProductionPath.test.ts`) ---------

const SAVED_KEYS = [
  'ctx', 'liveCtx', 'masterGain', 'masterAnalyser', 'grossBeatNode', 'mixerChannels', 'channelPanners',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'isPlaying', 'isOfflineRendering', 'currentBar', 'currentStep',
  'activePlayMode', 'activePatternId', 'activePatternLengthSteps', 'bpm', 'swing', 'metronome',
  'playlistLaneMutes', 'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'impulseResponses',
  'activeVoices', 'activeVoiceChannelVolumes', 'activeDrumPadVoices', 'activeClipSources',
  'activeClipSourceLanes', 'activeClipSourceChannels', 'activeClipChannelVolumes',
  'offlineRenderLeaseHeld', 'offlineRenderOperationDepth', 'transport', 'sampleBuffers',
  'projectOwnedSampleBufferIds', 'sessionSampleBufferIds', 'masteringProcessor',
  'masterSplitter', 'masterAnalyserL', 'masterAnalyserR', 'masterMeasurementSource',
  'liveSampleBuffersDuringOfflineRender', 'liveProjectSampleBufferIdsDuringOfflineRender',
  'liveSessionSampleBufferIdsDuringOfflineRender', 'playbackGeneration',
  '__fxSlotEffectMaps',
];

let savedInternals: EngineInternals = {};
let savedOfflineCtor: unknown;
let savedWindow: unknown;
let liveCtx: FakeContext;

/** A live context + the master bus the production `init()` would have built. */
const installLiveContext = (): FakeContext => {
  const ctx = new FakeContext();
  engine.ctx = ctx;
  engine.liveCtx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.impulseResponses = new Map();
  engine.activeVoices = new Map();
  engine.activeVoiceChannelVolumes = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.activeClipSourceChannels = new Map();
  engine.activeClipChannelVolumes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.sampleBuffers = new Map();
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.isOfflineRendering = false;
  engine.isPlaying = true;
  engine.activePlayMode = 'song';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.currentBar = 1;
  engine.currentStep = 0;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.transport = null;
  engine.activeChannels = structuredClone(modulatorChannels());
  engine.playbackProjectChannels = structuredClone(modulatorChannels());
  engine.activeClips = [];
  engine.activeMixerTracks = structuredClone(modulatorTracks());
  engine.playbackProjectMixerTracks = structuredClone(modulatorTracks());
  engine.__fxSlotEffectMaps = new Map();
  return ctx;
};

/** Build the live insert chains with the *production* chain builder. */
const buildLiveChains = (): void => {
  for (const track of engine.activeMixerTracks as MixerTrack[]) {
    engine.rebuildTrackFxChain(track);
  }
};

/** The effect the native registry currently names for a slot. */
const registeredEffect = (trackId: number, slotId: string): any | undefined =>
  (engine.__fxSlotEffectMaps as Map<number, Map<string, AudioEffect>> | undefined)?.get(trackId)?.get(slotId);

const mixerChannel = (trackId: number): any | undefined =>
  (engine.mixerChannels as Map<number, any>).get(trackId);

/** Object identity as a boolean: keeps assertion failures to `true`/`false`. */
const sameObject = (a: unknown, b: unknown): boolean => Object.is(a, b);

/** The inner `ChorusEffect` (or tape `CompositeEffect`) behind a WetDry wrapper. */
const innerEffect = (wrapper: any): any => wrapper?.effect ?? wrapper;

/**
 * True when an effect's own disposal flag is set. `WetDryEffect` and
 * `ChorusEffect` keep one; the tape `CompositeEffect` has none, so its teardown
 * is proven by `collectStartedNodes()` below instead of by a flag.
 */
const isDisposed = (effect: any): boolean => Boolean(effect) && effect.disposed === true;

/** Every node an effect started (its modulators), walking the wrapper/inner/composite fields. */
const collectStartedNodes = (value: any, found: FakeNode[] = []): FakeNode[] => {
  if (!value || typeof value !== 'object') return found;
  if (value instanceof FakeNode) {
    if (value.startCalls > 0) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStartedNodes(item, found);
    return found;
  }
  for (const key of ['effect', 'effects', 'nodes', 'lfo', 'lfoOffset']) {
    if (key in value) collectStartedNodes((value as any)[key], found);
  }
  return found;
};

/** Replace `dispose()` with a spy that still runs the real disposal. */
const spyDispose = (effect: any): { calls: number; original: () => void } => {
  const holder = effect;
  const original = holder.dispose.bind(holder);
  const state = { calls: 0, original };
  holder.dispose = (): void => {
    state.calls += 1;
    original();
  };
  return state;
};

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  savedOfflineCtor = (globalThis as any).OfflineAudioContext;
  savedWindow = (globalThis as any).window;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  MockOfflineAudioContext.failNextRender = false;
  poisonedConnect = null;
  liveCtx = installLiveContext();
  buildLiveChains();
});

afterEach(() => {
  poisonedConnect = null;
  MockOfflineAudioContext.failNextRender = false;
  (globalThis as any).OfflineAudioContext = savedOfflineCtor;
  if (savedWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = savedWindow;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

// ===============================================================================
// Group 1 — mixer-channel removal must dispose the effects the registry owns
// ===============================================================================

describe('FX-LIFECYCLE 1: removing a mixer channel invalidates the native FX map and disposes the owned effects', () => {
  it('disposes every effect owned by the removed track and drops the registry entry', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    assert.equal(Boolean(chorus && tape), true, 'the live chain must be registered before the removal');
    const chorusSpy = spyDispose(chorus);
    const tapeSpy = spyDispose(tape);
    assert.equal(isDisposed(chorus), false, 'the chain is live, so nothing is disposed yet');
    assert.ok(
      liveCtx.unstoppedModulators().length >= 2,
      'setup: chorus and tape each own a started modulator before the removal',
    );

    engine.removeMixerChannel(1);

    assert.equal(chorusSpy.calls, 1, 'the chorus effect owned by the removed channel must be disposed exactly once');
    assert.equal(tapeSpy.calls, 1, 'the tape effect owned by the removed channel must be disposed exactly once');
    assert.equal(isDisposed(innerEffect(chorus)), true, 'ChorusEffect.dispose() must have run');
    const ownedModulators = [...collectStartedNodes(chorus), ...collectStartedNodes(tape)];
    assert.equal(ownedModulators.length >= 3, true,
      `setup: the chorus LFO + offset source and the tape flutter LFO are all started (found ${ownedModulators.length})`);
    assert.equal(ownedModulators.every(node => node.stopCalls >= 1), true,
      'every started modulator of the removed chain must be stopped by the removal');
    assert.equal(engine.__fxSlotEffectMaps.has(1), false, 'the removed channel must not leave FX-map entries behind');
    assert.equal(liveCtx.unstoppedModulators().length, 0, 'no modulator owned by the removed chain may keep running');
  });

  it('leaves other tracks and the master channel untouched', () => {
    const removed = registeredEffect(1, 'fx-chorus');
    const other = registeredEffect(2, 'fx-delay');
    const removedSpy = spyDispose(removed);
    const otherSpy = spyDispose(other);

    engine.removeMixerChannel(1);

    assert.equal(removedSpy.calls, 1);
    assert.equal(otherSpy.calls, 0, 'removing one channel must not dispose another track’s chain');
    assert.equal(isDisposed(innerEffect(other)), false);
    assert.equal(engine.__fxSlotEffectMaps.has(2), true, 'the surviving track must stay registered');
    assert.equal(mixerChannel(2) !== undefined, true);
  });

  it('is idempotent: a second removal of the same track disposes nothing twice', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const spy = spyDispose(chorus);

    engine.removeMixerChannel(1);
    engine.removeMixerChannel(1);

    assert.equal(spy.calls, 1, 'a disposed effect must not be disposed again by a repeat removal');
  });

  it('keeps master track 0 (never removable) — and its chain — intact', () => {
    engine.updateMixerTrack(makeTrack(0, [makeSlot('fx-master-delay', 'delay', { time: 0.25, feedback: 0.3 }, 0.5)]));
    const masterEffect = registeredEffect(0, 'fx-master-delay');
    assert.equal(Boolean(masterEffect), true, 'the master insert must be registered by the production builder');
    const spy = spyDispose(masterEffect);

    engine.removeMixerChannel(0);

    assert.equal(spy.calls, 0, 'the master chain must never be disposed by a channel removal');
    assert.equal(engine.__fxSlotEffectMaps.has(0), true);
    assert.equal(mixerChannel(0) !== undefined, true);
  });
});

// ===============================================================================
// Group 2 — replacing a chain must dispose the OLD effects, never the new ones
// ===============================================================================

describe('FX-LIFECYCLE 2: replacing a live chain disposes the old effects and leaves the new chain alone', () => {
  it('disposes the previous chain (and stops its started modulators) on rebuild', () => {
    const oldChorus = registeredEffect(1, 'fx-chorus');
    const oldTape = registeredEffect(1, 'fx-tape');
    const oldChorusSpy = spyDispose(oldChorus);
    const oldTapeSpy = spyDispose(oldTape);

    engine.rebuildTrackFxChain(makeTrack(1, MODULATOR_SLOTS()));

    assert.equal(oldChorusSpy.calls, 1, 'the replaced chorus effect must be disposed');
    assert.equal(oldTapeSpy.calls, 1, 'the replaced tape effect must be disposed');
    assert.equal(liveCtx.unstoppedModulators().length, 3,
      'only the 3 modulators of the chain that replaced it (chorus lfo + lfoOffset, tape lfo) may still be running');
  });

  it('never disposes the chain that is installed, while the retired one is released', () => {
    const chorusWrapper = registeredEffect(1, 'fx-chorus');
    const installedSpy = spyDispose(chorusWrapper);
    const installedChorus = innerEffect(chorusWrapper);
    const rateParam = installedChorus.lfo.frequency as FakeParam;
    const writesBefore = rateParam.writes.length;

    // Another track rebuilding its own chain must not touch this one.
    const otherTrack = (engine.activeMixerTracks as MixerTrack[]).find(track => track.id === 2)!;
    engine.rebuildTrackFxChain(otherTrack);
    assert.equal(installedSpy.calls, 0, 'rebuilding another track must not dispose this track’s chain');

    // A live parameter write must not dispose the chain it is applying to either.
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 7.5), true,
      'a live chain must report a successful parameter update');
    assert.equal(installedSpy.calls, 0, 'applying a value must never dispose the running chain');
    assert.ok(rateParam.writes.length > writesBefore, 'the write must reach the LFO AudioParam');
    assert.equal(rateParam.value, 7.5, 'the LFO rate must be the value the user set');
    assert.equal(isDisposed(installedChorus), false, 'and the chain must still be alive to take the next one');

    // The rebuild that *replaces* this chain releases exactly the retired instance.
    engine.rebuildTrackFxChain(makeTrack(1, [makeSlot('fx-chorus', 'chorus', { rate: 4.5, depth: 0.004, delay: 0.02 }, 0.7)]));
    const rebuiltChorus = innerEffect(registeredEffect(1, 'fx-chorus'));
    assert.equal(sameObject(rebuiltChorus, installedChorus), false, 'a rebuild installs a fresh effect instance');
    assert.equal(installedSpy.calls, 1, 'the retired chain must be disposed by the rebuild that replaced it');
    assert.equal(isDisposed(installedChorus), true);
    assert.equal(isDisposed(rebuiltChorus), false, 'the replacement stays live');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 6.25), true,
      'and the fresh chain takes live writes');
    assert.equal(rebuiltChorus.lfo.frequency.value, 6.25);
  });

  it('one throwing dispose must not strand the other effects of the replaced chain', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    chorus.dispose = (): void => { throw new Error('simulated dispose failure'); };
    const tapeSpy = spyDispose(tape);

    assert.doesNotThrow(() => engine.rebuildTrackFxChain(makeTrack(1, MODULATOR_SLOTS())),
      'a single disposal error must not escape into the caller that only wanted to refresh a chain');
    assert.equal(tapeSpy.calls, 1, 'the other effect of the replaced chain must still be disposed');
    assert.equal(collectStartedNodes(tape).every(node => node.stopCalls >= 1), true,
      'the effect behind a failed sibling must have its modulator stopped');
    assert.equal(Boolean(registeredEffect(1, 'fx-chorus')), true, 'the new chain must be registered despite the failed disposal');

    // and the new chain is fully functional afterwards
    const freshTapeLfo = innerEffect(registeredEffect(1, 'fx-tape')).nodes.find((node: any) => node.startCalls > 0);
    assert.equal(Boolean(freshTapeLfo), true, 'the rebuilt tape modulator must be started');
    assert.doesNotThrow(() => engine.removeMixerChannel(1), 'cleanup of the rebuilt chain must still work');
    assert.equal(freshTapeLfo.stopCalls >= 1, true, 'the rebuilt tape modulator must be stoppable');
  });

  it('clearing a track of enabled slots disposes the old chain and registers nothing', () => {
    const chorusSpy = spyDispose(registeredEffect(1, 'fx-chorus'));
    const tapeSpy = spyDispose(registeredEffect(1, 'fx-tape'));

    engine.rebuildTrackFxChain(makeTrack(1, MODULATOR_SLOTS().map(slot => ({ ...slot, enabled: false }))));

    assert.equal(chorusSpy.calls, 1, 'bypassing every slot must still dispose the chain it retires');
    assert.equal(tapeSpy.calls, 1);
    assert.equal(liveCtx.unstoppedModulators().length, 0);
    assert.equal(registeredEffect(1, 'fx-chorus'), undefined, 'a bypassed slot must not stay in the FX map');
    assert.equal(registeredEffect(1, 'fx-tape'), undefined);
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 5), false, 'a bypassed slot must report a rebuild, not success');
  });
});

// ===============================================================================
// Group 3 — partially constructed chains
// ===============================================================================

describe('FX-LIFECYCLE 3: a chain that fails half-built is cleaned up and never registered', () => {
  /** `mixFor` in the production factory rejects a mix outside [0,1] — a real failure mode for a corrupt project. */
  const corruptPair = (): MixerTrack => makeTrack(1, [
    makeSlot('fx-chorus', 'chorus', { rate: 3.1, depth: 0.004, delay: 0.02 }, 0.7),
    makeSlot('fx-bad', 'delay', { time: 0.3, feedback: 0.4 }, 7.5),
  ]);

  it('disposes the effects it did create and leaves no FX-map entry naming a half-built chain', () => {
    const goodBefore = registeredEffect(1, 'fx-chorus');
    const beforeSpy = spyDispose(goodBefore);

    assert.throws(() => engine.rebuildTrackFxChain(corruptPair()), RangeError,
      'the failure must still reach the caller — it is not swallowed');

    const leakedModulators = liveCtx.unstoppedModulators();
    assert.equal(leakedModulators.length, 0,
      `a half-built chain must dispose what it created; ${leakedModulators.length} modulator(s) were left started`);
    assert.equal(engine.__fxSlotEffectMaps.get(1), undefined,
      'the FX map must not name a chain that was never finished');
    assert.equal(registeredEffect(1, 'fx-bad'), undefined, 'the failed slot must not be registered');
    assert.equal(beforeSpy.calls >= 1, true, 'the chain the rebuild retired must be disposed too');
    const channel = mixerChannel(1);
    assert.equal(channel.fxNodes.length, 0, 'the channel must not keep nodes of an abandoned chain in its FX list');
  });

  it('reports no success for a slot of the abandoned chain, while the take keeps the state write', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const rateParam = innerEffect(chorus).lfo.frequency as FakeParam;
    const writesBefore = rateParam.writes.length;

    assert.throws(() => engine.rebuildTrackFxChain(corruptPair()), RangeError);

    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 9), false,
      'a failed build must not leave a live-apply path that claims the value landed');
    assert.equal(rateParam.writes.length, writesBefore, 'no write may land on an effect whose chain was abandoned');
    assert.equal(engine.setFxSlotMix(1, 'fx-chorus', 0.5), false,
      'the mix setter must likewise ask for a rebuild rather than reporting success');
    const track = (engine.activeMixerTracks as MixerTrack[]).find(t => t.id === 1)!;
    assert.equal(track.fxSlots[0].mix, 0.5,
      'the take still records the value (the Phase 80 "state is the source of truth" contract), so the next chain picks it up');
  });

  it('recovers: a following valid rebuild installs a working chain', () => {
    assert.throws(() => engine.rebuildTrackFxChain(corruptPair()), RangeError);

    engine.rebuildTrackFxChain(makeTrack(1, MODULATOR_SLOTS()));

    const chorus = innerEffect(registeredEffect(1, 'fx-chorus'));
    assert.equal(Boolean(chorus), true, 'the recovery build must be registered');
    assert.equal(isDisposed(chorus), false, 'the recovery chain must not be disposed');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 6.25), true);
    assert.equal(chorus.lfo.frequency.value, 6.25);
    assert.equal(liveCtx.unstoppedModulators().length, 3,
      'exactly the 3 modulators of the current chain are running; anything more is a leak from an abandoned chain');
  });

  it('survives an effect whose input cannot even be disconnected', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    chorus.input.throwOnDisconnect = true;
    (chorus as any).input.disconnect = () => { throw new Error('simulated disconnect failure'); };

    assert.doesNotThrow(() => engine.rebuildTrackFxChain(makeTrack(1, MODULATOR_SLOTS())),
      'defensive cleanup must not turn a node error into a rebuild failure');
    assert.equal(Boolean(registeredEffect(1, 'fx-chorus')), true, 'the new chain must still be installed');
  });
});

// ===============================================================================
// Group 4 — context recreation
// ===============================================================================

describe('FX-LIFECYCLE 4: recreating the AudioContext must not reuse mixer nodes or FX from the old context', () => {
  const installWindowWith = (AudioContextClass: unknown): void => {
    (globalThis as any).window = { AudioContext: AudioContextClass, webkitAudioContext: undefined };
  };

  it('drops context-bound mixer channels and disposes FX when a closed context is replaced', () => {
    const staleCtx = liveCtx;
    const chorus = registeredEffect(1, 'fx-chorus');
    const staleChannel = mixerChannel(1);
    assert.equal(Boolean(chorus && staleChannel), true, 'setup: a stale chain and channel must exist');
    const chorusSpy = spyDispose(chorus);
    staleCtx.state = 'closed';
    installWindowWith(FakeContext);

    engine.init();

    const newCtx: FakeContext = engine.ctx;
    assert.equal(sameObject(newCtx, staleCtx), false, 'a fresh context must be created');
    assert.equal(chorusSpy.calls, 1, 'effects bound to the abandoned context must be disposed');
    assert.equal(isDisposed(innerEffect(chorus)), true);
    assert.equal(staleCtx.unstoppedModulators().length, 0, 'the old context must not be left with a running modulator');
    assert.equal(engine.__fxSlotEffectMaps.size, 0, 'the FX map must not survive a context change');
    assert.equal(sameObject(mixerChannel(1), staleChannel), false, 'context-bound mixer channels must not be reused in the new context');
    assert.equal(mixerChannel(1).input.context, newCtx, 'the rebuilt channel must belong to the new context');
    assert.equal(sameObject(engine.mixerRoutingChannelMap, engine.mixerChannels), true, 'the routing adapter must be re-anchored to the new channel map');
  });

  it('rebuilds the insert chain against the new context instead of writing into the dead one', () => {
    const staleCtx = liveCtx;
    const staleEffect = registeredEffect(1, 'fx-chorus');
    const staleParam = innerEffect(staleEffect).lfo.frequency as FakeParam;
    const staleWrites = staleParam.writes.length;
    staleCtx.state = 'closed';
    installWindowWith(FakeContext);

    engine.init();
    const newCtx: FakeContext = engine.ctx;
    const rebuilt = innerEffect(registeredEffect(1, 'fx-chorus'));
    assert.equal(rebuilt, undefined, 'the FX map must start empty after context recreation');

    // The mixer tracks are still the live take, so re-arming playback rebuilds
    // their chains on the new context.
    for (const track of engine.activeMixerTracks as MixerTrack[]) engine.rebuildTrackFxChain(track);
    const fresh = innerEffect(registeredEffect(1, 'fx-chorus'));
    assert.equal(Boolean(fresh), true, 'a chain built on the new context must be registered');
    assert.equal(sameObject(fresh, staleEffect), false, 'the chain must be rebuilt, not carried over');
    assert.equal(sameObject(fresh.lfo.context, newCtx), true, 'every node of the new chain must belong to the new context');

    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 5.5), true);
    assert.equal(fresh.lfo.frequency.value, 5.5, 'the update must land on the new context’s param');
    assert.equal((staleParam as FakeParam).writes.length, staleWrites, 'the dead context must receive no writes');
    assert.notEqual(newCtx, staleCtx);
  });

  it('leaves an already-running context alone (no teardown on a no-op init)', () => {
    const effect = registeredEffect(1, 'fx-chorus');
    const spy = spyDispose(effect);
    const channel = mixerChannel(1);
    installWindowWith(FakeContext);

    engine.init();

    assert.equal(spy.calls, 0, 'init() on a live context must dispose nothing');
    assert.equal(sameObject(engine.ctx, liveCtx), true, 'and must not replace the context');
    assert.equal(sameObject(mixerChannel(1), channel), true, 'or rebuild the mixer channels');
  });
});

// ===============================================================================
// Group 5 — offline rendering must not touch live FX-map ownership
// ===============================================================================

describe('FX-LIFECYCLE 5: an offline render isolates registry ownership from the live chain', () => {
  it('never writes offline effects into the live FX map while the render runs', async () => {
    const liveMap = engine.__fxSlotEffectMaps as Map<number, Map<string, AudioEffect>>;
    const liveChorus = registeredEffect(1, 'fx-chorus');
    const liveChorusSpy = spyDispose(liveChorus);
    const observations: Array<{ liveMapEntry: unknown; engineMap: unknown }> = [];

    await audioEngine.renderTimelineOffline(
      structuredClone(modulatorChannels()),
      [],
      structuredClone(modulatorTracks()),
      120,
      1,
      undefined,
      true,
      'song',
      (progress: number) => {
        if (progress >= 70) {
          observations.push({
            liveMapEntry: liveMap.get(1)?.get('fx-chorus'),
            engineMap: engine.__fxSlotEffectMaps,
          });
        }
      },
    );

    assert.equal(observations.length > 0, true, 'the render must report progress once its own chains are built');
    for (const observation of observations) {
      assert.equal(sameObject(observation.liveMapEntry, liveChorus), true,
        'the live FX map must keep naming the live chain while an offline render rebuilds its own');
      assert.equal(sameObject(observation.engineMap, liveMap), false,
        'the render must build its chains on a registry of its own, not on the live map');
    }
    assert.equal(liveChorusSpy.calls, 0,
      'constructing the offline chain must never dispose the live effects it is not allowed to own');
    assert.equal(isDisposed(innerEffect(liveChorus)), false);
    assert.equal(sameObject(engine.__fxSlotEffectMaps, liveMap), true, 'the live map must be handed back after the render');
  });

  it('disposes nothing that the live take still owns, and registers the offline chain separately', async () => {
    const liveDelay = registeredEffect(2, 'fx-delay');
    const liveDelaySpy = spyDispose(liveDelay);
    let offlineDelay: unknown;

    await audioEngine.renderTimelineOffline(
      structuredClone(modulatorChannels()),
      [],
      structuredClone(modulatorTracks()),
      120,
      1,
      undefined,
      true,
      'song',
      (progress: number) => {
        if (progress >= 70 && !offlineDelay) offlineDelay = registeredEffect(2, 'fx-delay');
      },
    );

    assert.equal(Boolean(offlineDelay), true, 'the render must register its own chain so its slots stay live-updatable');
    assert.equal(sameObject(offlineDelay, liveDelay), false, 'the render chain is a distinct instance');
    assert.equal(liveDelaySpy.calls, 0, 'the live chain must survive the render untouched');
    assert.equal(sameObject(registeredEffect(2, 'fx-delay'), liveDelay), true, 'and the live map must name the live chain again');
  });
});

// ===============================================================================
// Group 6 — the live registry must come back after success *and* failure
// ===============================================================================

describe('FX-LIFECYCLE 6: both render outcomes restore the live registry and leave live effects writable', () => {
  const runRender = async (): Promise<AudioBuffer> => audioEngine.renderTimelineOffline(
    structuredClone(modulatorChannels()),
    [] as unknown as [],
    structuredClone(modulatorTracks()),
    120,
    1,
    undefined,
    true,
  );

  it('a successful render hands the registry back and the live effect accepts writes again', async () => {
    const liveChorus = registeredEffect(1, 'fx-chorus');
    const rateParam = innerEffect(liveChorus).lfo.frequency as FakeParam;
    const writesBefore = rateParam.writes.length;

    await runRender();

    assert.equal(engine.isOfflineRendering, false);
    assert.equal(engine.offlineRenderLeaseHeld, false);
    assert.equal(sameObject(registeredEffect(1, 'fx-chorus'), liveChorus), true);
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 4.25), true,
      'post-export live automation must report that the running chain took the value');
    assert.equal(rateParam.value, 4.25);
    assert.ok(rateParam.writes.length > writesBefore, 'and the write must reach the live AudioParam');
    assert.equal(engine.setFxSlotMix(1, 'fx-chorus', 0.25), true);
    assert.equal((liveChorus as any).wet.gain.value, 0.25, 'the wet/dry mix must follow the live setter after an export');
  });

  it('a failed render still restores the registry in `finally`, and the live chain keeps working', async () => {
    const liveChorus = registeredEffect(1, 'fx-chorus');
    const liveChorusSpy = spyDispose(liveChorus);
    const rateParam = innerEffect(liveChorus).lfo.frequency as FakeParam;
    MockOfflineAudioContext.failNextRender = true;

    await assert.rejects(() => runRender(), /simulated OfflineAudioContext render failure/);

    assert.equal(engine.isOfflineRendering, false, 'a failed render must clear the offline flag');
    assert.equal(engine.offlineRenderLeaseHeld, false, 'and release the render lease');
    assert.equal(sameObject(engine.__fxSlotEffectMaps.get(1)?.get('fx-chorus'), liveChorus), true,
      'the live registry must be restored even when the render threw');
    assert.equal(liveChorusSpy.calls, 0, 'a failed render must not dispose the live chain');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 6.5), true,
      'the live chain must still be writable after a failed export');
    assert.equal(rateParam.value, 6.5);
  });
});

// ===============================================================================
// Group 7 — stale direct setter calls
// ===============================================================================

describe('FX-LIFECYCLE 7: a stale FX-map entry must never report a successful update', () => {
  it('returns false and writes nothing when the entry names an effect from an obsolete context', () => {
    const staleCtx = liveCtx;
    const chorus = registeredEffect(1, 'fx-chorus');
    const rateParam = innerEffect(chorus).lfo.frequency as FakeParam;
    const writesBefore = rateParam.writes.length;
    const wetWritesBefore = (chorus as any).wet.gain.writes.length as number;

    // What context recreation used to leave behind: the entry is still in the
    // map, its channel is still in the map, but the engine renders elsewhere.
    staleCtx.state = 'closed';
    const newCtx = new FakeContext();
    engine.ctx = newCtx;
    engine.liveCtx = newCtx;

    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 9.5), false,
      'a write into an effect of a context the engine no longer renders in must not claim success');
    assert.equal(rateParam.writes.length, writesBefore, 'and it must not touch the obsolete AudioParam');
    assert.equal(engine.setFxSlotMix(1, 'fx-chorus', 0.1), false, 'the same holds for the wet/dry setter');
    assert.equal((chorus as any).wet.gain.writes.length, wetWritesBefore, 'and it must not move the obsolete wet gain either');
    assert.equal(engine.__fxSlotEffectMaps.get(1), undefined,
      'the stale entry must be invalidated so the next caller rebuilds instead of writing to dead nodes');

    // State remains the source of truth: the take itself was still updated.
    const track = (engine.activeMixerTracks as MixerTrack[]).find(t => t.id === 1)!;
    assert.equal(track.fxSlots.find(s => s.id === 'fx-chorus')!.mix, 0.1);
  });

  it('returns false for a track whose channel is gone, and invalidates only that track', () => {
    // Simulate the ownership loss directly: drop the channel without the
    // removal path having a chance to clean the registry.
    (engine.mixerChannels as Map<number, unknown>).delete(1);
    const orphan = registeredEffect(1, 'fx-chorus');
    const orphanParam = innerEffect(orphan).lfo.frequency as FakeParam;
    const writesBefore = orphanParam.writes.length;

    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 8), false,
      'an entry without a live mixer channel must not report success');
    assert.equal(orphanParam.writes.length, writesBefore, 'no write may land on an orphaned effect');
    assert.equal(engine.__fxSlotEffectMaps.has(1), false, 'the orphaned track entry must be dropped');
    assert.equal(engine.__fxSlotEffectMaps.has(2), true, 'the other track must be untouched');
    assert.equal(Boolean(registeredEffect(2, 'fx-delay')), true, 'and its chain must stay usable');
    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.42), true,
      'a valid entry must still be applied directly, without a rebuild');
  });

  it('still applies a valid update in place, and rebuilds only when there is no live chain', () => {
    const delay = innerEffect(registeredEffect(2, 'fx-delay'));
    const delayTime = delay.delay.delayTime as FakeParam;
    const before = delayTime.writes.length;

    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.5), true);
    assert.equal(delayTime.value, 0.5, 'the delay-time translation must still reach the running AudioParam');
    assert.ok(delayTime.writes.length > before);

    engine.removeMixerChannel(2);
    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.75), false,
      'after the channel is gone the caller must be told to rebuild');
    const track = (engine.activeMixerTracks as MixerTrack[]).find(t => t.id === 2)!;
    assert.equal(track.fxSlots[0].params.time, 0.75, 'state still records the value for the next chain');
  });
});

// ===============================================================================
// Group 8 — REAL DSP validation (rendered audio, no mocks)
// ===============================================================================

const peakToPeak = (channel: Float32Array): number => {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < channel.length; i += 1) {
    if (channel[i] < min) min = channel[i];
    if (channel[i] > max) max = channel[i];
  }
  return max - min;
};

const mean = (channel: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < channel.length; i += 1) sum += channel[i];
  return sum / Math.max(1, channel.length);
};

const rms = (channel: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i];
  return Math.sqrt(sum / Math.max(1, channel.length));
};

const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
};

describe('FX-LIFECYCLE 8: real DSP — what disposal and chain replacement do to rendered audio', () => {
  /**
   * Render a constant source through a GainNode whose gain is modulated by the
   * chorus LFO the production factory started. This measures the modulator
   * itself in real Web Audio: if `dispose()` only flipped a flag, the rendered
   * buffer would still oscillate.
   */
  const renderLfoProbe = async (disposeEffect: boolean): Promise<Float32Array> => {
    const sampleRate = 44100;
    const ctx = new RealOfflineAudioContext(1, Math.round(sampleRate * 0.25), sampleRate);
    const slot = makeSlot('real-chorus', 'chorus', { rate: 8, depth: 0.004, delay: 0.02 }, 1);
    // The very factory `rebuildTrackFxChain` uses.
    const effect = createEffect(ctx as unknown as AudioContext, slot)!;
    const chorus = innerEffect(effect) as any;

    const probe = ctx.createGain();
    const carrier = ctx.createConstantSource();
    carrier.offset.value = 1;
    carrier.connect(probe);
    chorus.lfo.connect(probe.gain);
    probe.connect(ctx.destination);
    carrier.start(0);

    if (disposeEffect) effect.dispose();

    const buffer = await ctx.startRendering();
    return buffer.getChannelData(0);
  };

  it('dispose() really stops a started modulator (rendered LFO output goes flat)', async () => {
    const running = await renderLfoProbe(false);
    const disposed = await renderLfoProbe(true);

    assert.ok(peakToPeak(running) > 0.5, `the undisposed LFO must modulate the rendered signal (got p2p ${peakToPeak(running).toFixed(4)})`);
    assert.ok(rms(running) > 0.05, 'and the undisposed probe carries real energy');
    assert.ok(peakToPeak(disposed) < 1e-9,
      `after dispose() the LFO must be stopped and disconnected: rendered signal must be exactly the DC carrier (got p2p ${peakToPeak(disposed).toFixed(9)})`);
    assert.ok(Math.abs(mean(disposed) - 1) < 1e-4, 'the undisposed modulation aside, the carrier itself must be intact');
    assert.ok(maxAbsDiff(running, disposed) > 0.05,
      `the two renders must differ — otherwise this test proves nothing (max diff ${maxAbsDiff(running, disposed).toFixed(4)})`);
  });

  it('replacing a live chain renders exactly the new chain through the production graph', async () => {
    const sampleRate = 44100;
    const frames = Math.round(sampleRate * 0.2);

    const chorusTrack = () => makeTrack(1, [makeSlot('fx-chorus', 'chorus', { rate: 5, depth: 0.004, delay: 0.02 }, 0.7)]);
    const eqTrack = () => makeTrack(1, [makeSlot('fx-eq', 'equalizer', {
      lowFreq: 120, lowGain: 15, lowQ: 1,
      midFreq: 1000, midGain: -12, midQ: 1,
      highFreq: 6000, highGain: 6, highQ: 1,
    }, 0.8)]);

    /** Build a channel, feed a real oscillator through it, optionally replace the chain, render. */
    const renderChain = async (build: 'chorus-only' | 'eq-only' | 'chorus-then-eq'): Promise<Float32Array> => {
      const ctx = new RealOfflineAudioContext(2, frames, sampleRate);
      // Point the engine at this real context with a fresh, minimal live state.
      engine.ctx = ctx as unknown as AudioContext;
      engine.liveCtx = ctx as unknown as AudioContext;
      engine.isOfflineRendering = false;
      engine.offlineRenderLeaseHeld = false;
      engine.offlineRenderOperationDepth = 0;
      engine.mixerChannels = new Map();
      engine.channelPanners = new Map();
      engine.mixerRoutingAdapter = null;
      engine.mixerRoutingChannelMap = null;
      engine.impulseResponses = new Map();
      engine.__fxSlotEffectMaps = new Map();
      engine.masterGain = ctx.createGain();
      engine.grossBeatNode = ctx.createGain();
      engine.masterAnalyser = ctx.createAnalyser();
      engine.masteringProcessor = null;
      engine.masterGain.connect(ctx.destination);

      const channel = engine.getOrCreateMixerChannel(1);
      const carrier = ctx.createOscillator();
      carrier.frequency.value = 220;
      const carrierGain = ctx.createGain();
      carrierGain.gain.value = 0.4;
      carrier.connect(carrierGain);
      carrierGain.connect(channel.input as AudioNode);
      carrier.start(0);

      if (build === 'chorus-only' || build === 'chorus-then-eq') engine.rebuildTrackFxChain(chorusTrack());
      if (build === 'eq-only') engine.rebuildTrackFxChain(eqTrack());
      if (build === 'chorus-then-eq') engine.rebuildTrackFxChain(eqTrack());

      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);
      assert.equal(data.some(sample => Number.isNaN(sample)), false, 'the rendered chain must not produce NaN samples');
      return data;
    };

    const chorusOnly = await renderChain('chorus-only');
    const eqOnly = await renderChain('eq-only');
    const replaced = await renderChain('chorus-then-eq');

    assert.ok(rms(eqOnly) > 0.05, 'setup: the EQ chain renders audible audio on its own');
    assert.equal(maxAbsDiff(replaced, eqOnly), 0,
      'a replaced chain must render bit-identically to the new chain alone — the teardown of the old chain may not reach into the new one, and the new one must stay fully wired');
    assert.ok(maxAbsDiff(replaced, chorusOnly) > 1e-3,
      'and it must not still be rendering the retired chain (max diff ' + maxAbsDiff(replaced, chorusOnly).toFixed(4) + ')');
  });

  it('a real offline export through the FX chain still hands a writable live chain back', async () => {
    // Real render context for the export, mocked live context for the take.
    const liveChorus = registeredEffect(1, 'fx-chorus');
    assert.equal(Boolean(liveChorus), true, 'setup: the live take owns a chorus chain');
    const liveCtxRef = liveCtx;
    const disposedBefore = isDisposed(innerEffect(liveChorus));
    let offlineRegistered: unknown;

    const savedRealOffline = (globalThis as any).OfflineAudioContext;
    (globalThis as any).OfflineAudioContext = RealOfflineAudioContext;
    try {
      await audioEngine.renderTimelineOffline(
        structuredClone(modulatorChannels()),
        [],
        structuredClone(modulatorTracks()),
        120,
        1,
        44100,
        true,
        'song',
        (progress: number) => {
          if (progress >= 70 && !offlineRegistered) offlineRegistered = registeredEffect(1, 'fx-chorus');
        },
      );
    } finally {
      (globalThis as any).OfflineAudioContext = savedRealOffline;
    }

    assert.equal(Boolean(offlineRegistered), true, 'the export must have built its own chorus chain');
    assert.equal(sameObject(offlineRegistered, liveChorus), false, 'on its own context');
    assert.equal(sameObject(engine.ctx, liveCtxRef), true, 'and the live context must be back in place');
    assert.equal(sameObject(registeredEffect(1, 'fx-chorus'), liveChorus), true, 'the live FX map must name the live chain again');
    assert.equal(isDisposed(innerEffect(liveChorus)), disposedBefore, 'the live chain must not have been disposed by the export');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 3.9), true,
      'a real-context render must leave the live chain writable, including its context check');
    assert.equal(innerEffect(liveChorus).lfo.frequency.value, 3.9);
  });
});

// ===============================================================================
// Group 9 — invalidating a stale entry must release what it drops
//           (review follow-up 1: dispose the obsolete effects before their
//            references are lost; keep valid effects and other tracks intact)
// ===============================================================================

describe('FX-LIFECYCLE 9: a stale entry is disposed as it is invalidated (mocked lifecycle)', () => {
  it('disposes the whole obsolete track entry — effects and their started modulators — and nothing else', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    const other = registeredEffect(2, 'fx-delay');
    const chorusSpy = spyDispose(chorus);
    const tapeSpy = spyDispose(tape);
    const otherSpy = spyDispose(other);
    const chorusRate = innerEffect(chorus).lfo.frequency as FakeParam;
    const rateWritesBefore = chorusRate.writes.length;

    // What context recreation used to leave behind: the engine moved on, the
    // entries did not.
    liveCtx.state = 'closed';
    const newCtx = new FakeContext();
    engine.ctx = newCtx;
    engine.liveCtx = newCtx;

    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 9.5), false,
      'a stale entry must still report a rebuild rather than a successful write');

    assert.equal(chorusSpy.calls, 1, 'the effect named by the invalidated entry must be disposed as the entry goes');
    assert.equal(tapeSpy.calls, 1, 'and so must its sibling on the same obsolete track');
    assert.equal(isDisposed(innerEffect(chorus)), true, 'ChorusEffect.dispose() must have run');
    assert.equal(collectStartedNodes(chorus).every(node => node.stopCalls >= 1), true,
      'the obsolete chorus modulators must no longer be running');
    assert.equal(collectStartedNodes(tape).every(node => node.stopCalls >= 1), true,
      'and the obsolete tape flutter LFO with them');
    assert.equal(chorusRate.writes.length, rateWritesBefore, 'invalidation must not write to the obsolete AudioParam');
    assert.equal(engine.__fxSlotEffectMaps.has(1), false, 'and the entry must be gone');

    // Scoped: the invalidation of track 1 disposes only track 1's effects.
    assert.equal(otherSpy.calls, 0, 'an unrelated track must not be disposed by another track’s invalidation');
    assert.equal(isDisposed(innerEffect(other)), false, 'its chain stays alive');
    assert.equal(engine.__fxSlotEffectMaps.has(2), true, 'and stays registered/owned');
    // That entry names the abandoned context too, so it is released — with its
    // effect — when it is itself reached, rather than being dropped silently.
    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.44), false, '…until its own staleness is detected');
    assert.equal(otherSpy.calls, 1, 'and then the effect is disposed, not just unlinked');
  });

  it('releases an orphaned track while a valid track keeps applying updates in place', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    const other = registeredEffect(2, 'fx-delay');
    const chorusSpy = spyDispose(chorus);
    const tapeSpy = spyDispose(tape);
    const otherSpy = spyDispose(other);
    const wetParam = (chorus as any).wet.gain as FakeParam;
    const wetWritesBefore = wetParam.writes.length;

    // A channel removed without going through `removeMixerChannel`.
    (engine.mixerChannels as Map<number, unknown>).delete(1);

    assert.equal(engine.setFxSlotMix(1, 'fx-chorus', 0.3), false,
      'the wet/dry setter must not claim success on an orphaned chain either');
    assert.equal(chorusSpy.calls, 1, 'the orphaned chorus must be disposed, not just unlinked');
    assert.equal(tapeSpy.calls, 1, 'with the rest of its track');
    assert.equal(wetParam.writes.length, wetWritesBefore, 'and the value may not land on the orphaned wet gain');
    assert.equal(collectStartedNodes(tape).every(node => node.stopCalls >= 1), true,
      'no modulator of the orphaned chain may keep running');
    assert.equal(engine.__fxSlotEffectMaps.has(1), false);
    const track = (engine.activeMixerTracks as MixerTrack[]).find(t => t.id === 1)!;
    assert.equal(track.fxSlots[0].mix, 0.3, 'the take still records the value for the next rebuild');

    assert.equal(otherSpy.calls, 0, 'the valid track is untouched by that cleanup');
    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.4), true, 'and remains directly writable');
    assert.equal(innerEffect(other).delay.delayTime.value, 0.4, 'with the value reaching its AudioParam');
  });

  it('a slot-level staleness disposes only that slot and keeps its sibling usable', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    const chorusSpy = spyDispose(chorus);
    const tapeSpy = spyDispose(tape);
    const tapeWet = (tape as any).wet.gain as FakeParam;
    const tapeWetWritesBefore = tapeWet.writes.length;
    const channel = mixerChannel(1);

    // The tape node has been wired out of the chain; the chorus is still in it.
    channel.fxNodes = channel.fxNodes.filter((node: any) => node !== (tape as any).input);

    assert.equal(engine.setFxSlotMix(1, 'fx-tape', 0.25), false, 'a slot off the chain must not report success');
    assert.equal(tapeSpy.calls, 1, 'the detached slot effect must be disposed');
    assert.equal(collectStartedNodes(tape).every(node => node.stopCalls >= 1), true, 'its modulator stopped');
    assert.equal(tapeWet.writes.length, tapeWetWritesBefore, 'and no value written into it');
    assert.equal(registeredEffect(1, 'fx-tape'), undefined, 'that slot entry alone is invalidated');

    assert.equal(chorusSpy.calls, 0, 'the sibling still on the chain must not be disposed');
    assert.equal(engine.__fxSlotEffectMaps.has(1), true, 'and the track entry survives for it');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 7), true, 'which stays directly writable');
    assert.equal(innerEffect(chorus).lfo.frequency.value, 7);
  });

  it('one obsolete effect refusing to die must not strand the others being invalidated', () => {
    const chorus = registeredEffect(1, 'fx-chorus');
    const tape = registeredEffect(1, 'fx-tape');
    chorus.dispose = (): void => { throw new Error('simulated dispose failure during invalidation'); };
    const tapeSpy = spyDispose(tape);

    (engine.mixerChannels as Map<number, unknown>).delete(1);

    assert.doesNotThrow(() => engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 5),
      'the setter must not surface a disposal error to the caller');
    assert.equal(tapeSpy.calls, 1, 'the sibling of the effect that refused to die is still disposed');
    assert.equal(collectStartedNodes(tape).every(node => node.stopCalls >= 1), true);
    assert.equal(engine.__fxSlotEffectMaps.has(1), false, 'the invalidation completes either way');
    assert.equal(engine.setFxSlotParameter(1, 'fx-tape', 'rate', 5), false, 'and nothing is left to write into');
  });
});

// ===============================================================================
// Group 10 — a chain may only be retired once its replacement is connected
//            (review follow-up 2: guard the final tail connection)
// ===============================================================================

describe('FX-LIFECYCLE 10: the retired chain survives until the replacement is fully connected (mocked lifecycle)', () => {
  const chorusSlot = (): FxSlot => makeSlot('fx-chorus', 'chorus', { rate: 3.1, depth: 0.004, delay: 0.02 }, 0.7);

  it('a failing tail connection rewires the retired chain and releases only the new one', () => {
    const previous = registeredEffect(1, 'fx-chorus');
    const previousTape = registeredEffect(1, 'fx-tape');
    const previousSpy = spyDispose(previous);
    const previousTapeSpy = spyDispose(previousTape);
    const channel = mixerChannel(1);
    const panner = channel.panner as FakeNode;
    const nodesBefore = liveCtx.createdNodes.length;
    const modulatorsBefore = liveCtx.unstoppedModulators().length;
    const pannerIncomingBefore = panner.incomingCalls;

    // Fail the last connection the build makes: chain tail -> channel panner.
    poisonConnectTo(panner, 'simulated tail connect failure');

    assert.throws(
      () => engine.rebuildTrackFxChain(makeTrack(1, [chorusSlot()])),
      /simulated tail connect failure/,
      'the original error must reach the caller unchanged',
    );

    // The half-built chain is released — modulators included — not orphaned.
    const createdModulators = liveCtx.createdNodes.slice(nodesBefore).filter(node => node.startCalls > 0);
    assert.equal(createdModulators.length >= 1, true, 'setup: the failed build did start a modulator of its own');
    assert.equal(createdModulators.every(node => node.stopCalls >= 1), true,
      'the half-installed chain must be disposed — modulators included — instead of being dropped unreferenced');

    // The retired chain is neither disposed by an unfinished replacement nor left
    // disconnected-but-owned: it is put back, so nothing runs unowned.
    assert.equal(previousSpy.calls, 0, 'a rebuild that never connected its replacement may not dispose the retired chain');
    assert.equal(isDisposed(innerEffect(previous)), false);
    assert.equal(isDisposed(innerEffect(previousTape)), false, '…and the rollback must be all-or-nothing, not half a chain');
    assert.equal(channel.fxNodes.includes((previous as any).input), true,
      'the retired chain must be wired back onto the channel');
    assert.equal(panner.incomingCalls, pannerIncomingBefore + 1,
      'its tail must be connected to the panner again, so the track is not muted');
    assert.equal(sameObject(registeredEffect(1, 'fx-chorus'), previous), true,
      'and the registry must own exactly those restored effects');

    // Restored and wired means live: writes are accepted again, not refused.
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 6), true,
      'the restored chain is the running chain, so a live write must be applied');
    assert.equal(innerEffect(previous).lfo.frequency.value, 6, '…and land on its AudioParam');
    assert.equal(previousSpy.calls, 0, 'a write into the restored chain must not dispose it');

    // No modulator is left running that nothing owns any more.
    assert.equal(liveCtx.unstoppedModulators().length, modulatorsBefore,
      'every still-running modulator after the failure must belong to the restored chain');

    // Ownership is intact, so a later removal releases it normally.
    engine.removeMixerChannel(1);
    assert.equal(previousSpy.calls, 1, 'the restored chain is disposed by the next lifecycle event that retires it');
    assert.equal(previousTapeSpy.calls, 1);
    assert.equal(liveCtx.unstoppedModulators().length, 0, 'and no modulator of this track survives it');
  });

  it('an empty chain whose bypass fails still leaves the retired chain wired and owned', () => {
    const channel = mixerChannel(2);
    const panner = channel.panner as FakeNode;
    const delay = registeredEffect(2, 'fx-delay');
    const delaySpy = spyDispose(delay);
    const delayTime = innerEffect(delay).delay.delayTime as FakeParam;
    const writesBefore = delayTime.writes.length;
    const pannerIncomingBefore = panner.incomingCalls;

    // An empty chain connects `channel.input` straight to the panner: the very
    // last call of the build.
    poisonConnectTo(panner, 'simulated bypass connect failure');
    assert.throws(() => engine.rebuildTrackFxChain(makeTrack(2, [])), /simulated bypass connect failure/,
      'the caller must still learn that the rebuild did not happen');

    assert.equal(delaySpy.calls, 0, 'clearing a track of its slots must not dispose the chain it had');
    assert.equal(delayTime.writes.length, writesBefore, '…and no write may reach the retired effect either');
    assert.equal(panner.incomingCalls, pannerIncomingBefore + 1,
      'the rollback reconnects the retired chain’s tail, so the track keeps playing');
    assert.equal(sameObject(registeredEffect(2, 'fx-delay'), delay), true,
      'the retired chain stays owned by the registry, never orphaned');
    assert.equal(channel.fxNodes.length > 0, true, '…and is still listed on the channel');

    // Because it is wired again, it is live again.
    assert.equal(engine.setFxSlotParameter(2, 'fx-delay', 'time', 0.9), true,
      'a restored chain accepts writes rather than being reported as stale');
    assert.equal(delayTime.value, 0.9);
  });

  it('when the rollback itself cannot reconnect, the retired chain is released rather than retained unusable', () => {
    const previous = registeredEffect(1, 'fx-chorus');
    const previousTape = registeredEffect(1, 'fx-tape');
    const previousSpy = spyDispose(previous);
    const previousTapeSpy = spyDispose(previousTape);
    const channel = mixerChannel(1);
    const panner = channel.panner as FakeNode;
    const nodesBefore = liveCtx.createdNodes.length;

    // Every edge into the panner fails: the tail, the rollback, and the bypass.
    poisonConnectTo(panner, [
      'simulated tail connect failure',
      'simulated rollback connect failure',
      'simulated bypass connect failure',
    ]);

    assert.throws(
      () => engine.rebuildTrackFxChain(makeTrack(1, [chorusSlot()])),
      /simulated tail connect failure/,
      'a failing rollback must not mask the original error',
    );

    const createdModulators = liveCtx.createdNodes.slice(nodesBefore).filter(node => node.startCalls > 0);
    assert.equal(createdModulators.every(node => node.stopCalls >= 1), true, 'the new chain is still disposed');
    assert.equal(previousSpy.calls, 1, 'with nothing wired anywhere, the retired effects can no longer be used — they are released');
    assert.equal(previousTapeSpy.calls, 1, '…both of them');
    assert.equal(isDisposed(innerEffect(previous)), true);
    assert.equal(engine.__fxSlotEffectMaps.has(1), false, 'and the entry goes with them, so nothing is retained-but-unusable');
    assert.equal(channel.fxNodes.length, 0, 'the channel keeps no wiring for a chain that was never installed');
    assert.equal(liveCtx.unstoppedModulators().length, 0,
      'this outcome must be deterministic: after it, no modulator of the track is left running');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 5), false, 'and the setters report a rebuild');
  });

  it('recovers: once the connection works, the next rebuild installs and retires correctly', () => {
    const previous = registeredEffect(1, 'fx-chorus');
    const previousSpy = spyDispose(previous);
    const channel = mixerChannel(1);
    poisonConnectTo(channel.panner as FakeNode, 'simulated tail connect failure');
    assert.throws(() => engine.rebuildTrackFxChain(makeTrack(1, [chorusSlot()])), /simulated tail connect failure/);

    engine.rebuildTrackFxChain(makeTrack(1, [makeSlot('fx-chorus', 'chorus', { rate: 5.5, depth: 0.004, delay: 0.02 }, 0.7)]));

    const installed = innerEffect(registeredEffect(1, 'fx-chorus'));
    assert.equal(Boolean(installed), true, 'the recovery build must be installed');
    assert.equal(installed.lfo.frequency.value, 5.5, 'with its own parameters');
    assert.equal(previousSpy.calls, 1, 'and the chain it replaced disposed exactly once');
    assert.equal(engine.setFxSlotParameter(1, 'fx-chorus', 'rate', 8.5), true, 'the installed chain is live-updatable');
    assert.equal(installed.lfo.frequency.value, 8.5);
    assert.equal(liveCtx.unstoppedModulators().length, 2,
      'no modulator from the failed attempt or the retired chain may still be running');
  });
});
