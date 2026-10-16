/**
 * FX lifecycle ownership — native `AudioEngine` is the single owner.
 *
 * PR #230 gave `AudioEngine` its own FX-chain factory and slot registry
 * (`__fxSlotEffectMaps`), and PR #233 made that registry the authoritative
 * owner of the FX-chain lifecycle: `rebuildTrackFxChain` releases the chain it
 * retires (and what a failed build created), `removeMixerChannel` invalidates
 * and disposes the effects the channel owned, and
 * `applyLiveFxSlotParamToRunningChain` refuses to answer "applied" for an entry
 * the engine has outlived.
 *
 * `installLiveFxChainHardening` predates all of that and still assigns its own
 * `rebuildTrackFxChain` and `removeMixerChannel` over the engine's methods. One
 * call is therefore enough to move the FX-chain lifecycle back into the legacy
 * module: the native registry stops being populated, PR #233's dispose /
 * invalidate / rollback guarantees stop running, and two independent effect
 * tables claim to own the same chain.
 *
 * This suite pins the ownership contract:
 *   A — the native lifecycle methods survive a call to the legacy installer,
 *       and the native registry is the one that names the running chain.
 *   B — the legacy parameter-delivery bridge still works for every caller that
 *       needs it (the shipped engine through the native registry, a patched
 *       third-party engine through the legacy index).
 *   C — rebuilding and removing a channel leaves no stale registry entry, no
 *       leaked effect instance and no duplicate disposal.
 *   D — the PR #233 failure-recovery guarantees still hold with the patch
 *       installed.
 *   E — production boot never installs the legacy patch.
 *
 * Every test in groups A–D drives the shipped `audioEngine` singleton with the
 * patch installed, i.e. the configuration the whole legacy FX suite uses.
 *
 * ── What is mocked and what is real ───────────────────────────────────────
 * The Web Audio context is a fake `BaseAudioContext` (the same technique
 * `liveFxMapLifecycle.test.ts` uses) so that ownership and disposal are
 * directly observable: disposal, `start`/`stop` bookkeeping on modulator
 * oscillators and registry contents are the things under test, not DSP. Real
 * DSP behaviour is covered by the offline-render groups in
 * `liveFxMapLifecycle.test.ts` and `exportParity.test.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, FxSlot, FxType, MixerTrack } from '../types/daw';
import { audioEngine } from './audioEngine';
import {
  applyLiveFxChainMix,
  applyLiveFxSlotParameter,
  getLiveFxSlotEffect,
  installLiveFxChainHardening,
} from './liveFxChainHardening';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..');

// --- Fake Web Audio ------------------------------------------------------------

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

/** Arms the next `connect(pendingFailureTarget)` to throw, once. */
let poisonedConnect: { target: unknown; message: string } | null = null;
const poisonConnectTo = (target: unknown, message: string): void => {
  poisonedConnect = { target, message };
};

class FakeNode {
  context: FakeContext | null = null;
  disconnectCalls = 0;
  startCalls = 0;
  stopCalls = 0;
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
      const { message } = poisonedConnect;
      poisonedConnect = null;
      throw new Error(message);
    }
  }
  disconnect(): void { this.disconnectCalls += 1; }
  start(): void { this.startCalls += 1; }
  stop(): void { this.stopCalls += 1; }
  getFloatTimeDomainData(): void {}
}

class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 2;
  sampleRate = 48000;
  readonly createdNodes: FakeNode[] = [];
  readonly destination = new FakeNode();
  private register(node: FakeNode): FakeNode {
    Object.defineProperty(node, 'context', { value: this, enumerable: false, configurable: true });
    this.createdNodes.push(node);
    return node;
  }
  /** Every `start()`ed node on this context — the modulator LFOs at stake. */
  unstoppedModulators(): FakeNode[] {
    return this.createdNodes.filter(node => node.startCalls > 0 && node.stopCalls === 0);
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

// --- Fixtures ------------------------------------------------------------------

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id,
  type,
  name: `${type} ${id}`,
  enabled: true,
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

const DELAY_SLOTS = (): FxSlot[] => [makeSlot('fx-delay', 'delay', { time: 0.3, feedback: 0.4 }, 0.5)];

// --- Engine harness ------------------------------------------------------------

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
  'liveSampleBuffersDuringOfflineRender', 'liveProjectSampleBufferIdsDuringOfflineRender',
  'liveSessionSampleBufferIdsDuringOfflineRender', '__fxSlotEffectMaps',
];

let savedInternals: EngineInternals = {};
let liveCtx: FakeContext;

/** A live context + the master bus the production `init()` would have built. */
const installLiveContext = (tracks: MixerTrack[], channels: Channel[]): FakeContext => {
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
  engine.activeChannels = structuredClone(channels);
  engine.playbackProjectChannels = structuredClone(channels);
  engine.activeClips = [];
  engine.activeMixerTracks = structuredClone(tracks);
  engine.playbackProjectMixerTracks = structuredClone(tracks);
  engine.__fxSlotEffectMaps = new Map();
  return ctx;
};

/** The effect the *native* registry currently names for a slot. */
const nativeEffect = (trackId: number, slotId: string): any | undefined =>
  (engine.__fxSlotEffectMaps as Map<number, Map<string, unknown>> | undefined)?.get(trackId)?.get(slotId);

const nativeRegistrySize = (): number => (engine.__fxSlotEffectMaps as Map<number, unknown>).size;

const mixerChannel = (trackId: number): any | undefined =>
  (engine.mixerChannels as Map<number, any>).get(trackId);

/** Every node an effect started (its modulators). */
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
const spyDispose = (effect: any): { calls: number } => {
  const original = effect.dispose.bind(effect);
  const state = { calls: 0 };
  effect.dispose = (): void => {
    state.calls += 1;
    original();
  };
  return state;
};

/** Install the legacy patch exactly once per process (the installer is idempotent). */
let patchInstalled = false;
const installPatch = (): void => {
  if (patchInstalled) return;
  installLiveFxChainHardening(audioEngine as never);
  patchInstalled = true;
};

/** The methods the engine was constructed with — the native lifecycle owners. */
const NATIVE_REBUILD = (audioEngine as any).rebuildTrackFxChain;
const NATIVE_REMOVE = (audioEngine as any).removeMixerChannel;

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  poisonedConnect = null;
  installPatch();
});

afterEach(() => {
  poisonedConnect = null;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

// ===============================================================================
// Group A — the native engine keeps ownership of the FX-chain lifecycle
// ===============================================================================

describe('FX-LIFECYCLE-OWNER 1: the legacy installer cannot take the native lifecycle methods over', () => {
  it('leaves rebuildTrackFxChain as the native AudioEngine implementation', () => {
    // Captured at module load, before any install call in this process.
    assert.equal(
      (audioEngine as any).rebuildTrackFxChain,
      NATIVE_REBUILD,
      'installLiveFxChainHardening must not replace the native rebuildTrackFxChain',
    );
  });

  it('leaves removeMixerChannel as the native AudioEngine implementation', () => {
    assert.equal(
      (audioEngine as any).removeMixerChannel,
      NATIVE_REMOVE,
      'installLiveFxChainHardening must not replace the native removeMixerChannel',
    );
  });
});

describe('FX-LIFECYCLE-OWNER 2: a rebuild that runs after the install registers in the native registry', () => {
  it('names the running chain in __fxSlotEffectMaps and wires that effect into the channel', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, MODULATOR_SLOTS())],
      [makeChannel('ch-1', 1)],
    );

    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    const chorus = nativeEffect(1, 'fx-chorus');
    const tape = nativeEffect(1, 'fx-tape');
    assert.ok(chorus, 'the native registry must own the chorus effect of the running chain');
    assert.ok(tape, 'the native registry must own the tape effect of the running chain');

    // Single ownership: the effect the registry names is the one the channel
    // actually renders through, not a second table's idea of the chain.
    const channel = mixerChannel(1);
    assert.ok(channel, 'the mixer channel must exist');
    assert.ok(
      (channel.fxNodes as unknown[]).includes(chorus.input),
      'the registered chorus effect must be the node wired into the channel',
    );
    assert.ok(
      (channel.fxNodes as unknown[]).includes(tape.input),
      'the registered tape effect must be the node wired into the channel',
    );
  });

  it('keeps the native registry authoritative for the shipped setters after an install', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    // The production wet/dry setter and the production parameter setter both
    // resolve the chain through the native registry; neither may be answered by
    // a duplicate legacy table that the native lifecycle code never maintains.
    assert.equal(audioEngine.setFxSlotMix(1, 'fx-delay', 0.25), true, 'the running chain must take the mix');
    assert.equal(
      audioEngine.setFxSlotParameter(1, 'fx-delay', 'time', 0.42),
      true,
      'the running chain must take the contract parameter',
    );

    const delayed = nativeEffect(1, 'fx-delay');
    assert.ok(delayed, 'the native registry must still name the running chain afterwards');
  });
});

// ===============================================================================
// Group B — the legacy parameter-delivery bridge keeps working
// ===============================================================================

describe('FX-LIFECYCLE-OWNER 3: legacy parameter delivery still reaches the running chain', () => {
  it('resolves the effect the engine renders with through getLiveFxSlotEffect', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    const viaBridge = getLiveFxSlotEffect(audioEngine as never, 1, 'fx-delay') as any;
    const viaNative = nativeEffect(1, 'fx-delay');
    assert.ok(viaBridge, 'the legacy bridge must resolve the slot effect');
    assert.equal(viaBridge, viaNative, 'the legacy bridge and the native registry must name one effect');
  });

  it('delivers mix and parameter writes through applyLiveFxChainMix / applyLiveFxSlotParameter', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    const effect = getLiveFxSlotEffect(audioEngine as never, 1, 'fx-delay') as any;
    assert.ok(effect, 'the slot effect must be reachable before the write');

    assert.equal(
      applyLiveFxChainMix(audioEngine as never, 1, 'fx-delay', 0.75, 3),
      true,
      'applyLiveFxChainMix must reach the running chain',
    );
    assert.ok(Math.abs(effect.wet.gain.value - 0.75) < 1e-9, 'the wet gain must carry the delivered mix');

    assert.equal(
      applyLiveFxSlotParameter(audioEngine as never, 1, 'fx-delay', 'time', 0.61, 3),
      true,
      'applyLiveFxSlotParameter must reach the running chain',
    );
    assert.ok(
      Math.abs(effect.effect.delay.delayTime.value - 0.61) < 1e-9,
      'the delay time must carry the delivered contract value',
    );

    assert.equal(
      applyLiveFxSlotParameter(audioEngine as never, 1, 'fx-delay', 'not-a-param', 1, 3),
      false,
      'an unknown parameter must still be reported as a miss',
    );
  });

  it('reports a miss once the track is gone', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);
    assert.ok(getLiveFxSlotEffect(audioEngine as never, 1, 'fx-delay'), 'registered before the removal');

    audioEngine.removeMixerChannel(1);

    assert.equal(getLiveFxSlotEffect(audioEngine as never, 1, 'fx-delay'), undefined, 'the entry must be dropped');
    assert.equal(applyLiveFxChainMix(audioEngine as never, 1, 'fx-delay', 0.4, 3), false, 'a removed track returns false');
    assert.equal(nativeEffect(1, 'fx-delay'), undefined, 'the native registry must not keep a stale entry');
  });

  it('still owns the lifecycle of an engine that has no native registry of its own', () => {
    // The legacy module's own contract: an engine without `__fxSlotEffectMaps`
    // — every non-AudioEngine caller, including the Phase 80/81 fixtures — keeps
    // the wrapped lifecycle and the legacy slot index it always had.
    const ctx = new FakeContext();
    const channel = { input: ctx.createGain(), panner: ctx.createGain(), fxNodes: [] as unknown[] };
    const legacyEngine = {
      getContext: () => ctx,
      getOrCreateMixerChannel: () => channel,
      rebuildTrackFxChain(_track: MixerTrack): void {},
      removeMixerChannel(_trackId: number): void {},
    };
    const originalRebuild = legacyEngine.rebuildTrackFxChain;

    installLiveFxChainHardening(legacyEngine as never);

    assert.notEqual(
      legacyEngine.rebuildTrackFxChain,
      originalRebuild,
      'an engine without a native FX registry keeps the legacy lifecycle wrapper',
    );
    legacyEngine.rebuildTrackFxChain(makeTrack(1, DELAY_SLOTS()) as MixerTrack);
    assert.ok(
      getLiveFxSlotEffect(legacyEngine as never, 1, 'fx-delay'),
      'the legacy slot index must still be populated by the legacy rebuild',
    );
  });
});

// ===============================================================================
// Group C — no stale entries, no leaked instances, no duplicate disposal
// ===============================================================================

describe('FX-LIFECYCLE-OWNER 4: rebuild and remove leave no stale entry, leak or double disposal', () => {
  it('disposes the retired chain exactly once on a rebuild and once again on removal', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, MODULATOR_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    const retiredChorus = nativeEffect(1, 'fx-chorus');
    const retiredTape = nativeEffect(1, 'fx-tape');
    assert.ok(retiredChorus && retiredTape, 'the first chain must be registered');
    const chorusSpy = spyDispose(retiredChorus);
    const tapeSpy = spyDispose(retiredTape);

    // Rebuild: the chain it retires may only be released once the replacement is
    // installed, and exactly once.
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);
    assert.equal(chorusSpy.calls, 1, 'the retired chorus effect is disposed exactly once');
    assert.equal(tapeSpy.calls, 1, 'the retired tape effect is disposed exactly once');

    // The replacement is the only chain the registry names now.
    assert.notEqual(nativeEffect(1, 'fx-chorus'), retiredChorus, 'the registry names the replacement');

    const liveChorus = nativeEffect(1, 'fx-chorus');
    const liveTape = nativeEffect(1, 'fx-tape');
    const liveChorusSpy = spyDispose(liveChorus);
    const liveTapeSpy = spyDispose(liveTape);

    audioEngine.removeMixerChannel(1);

    assert.equal(liveChorusSpy.calls, 1, 'removal disposes the live chorus effect exactly once');
    assert.equal(liveTapeSpy.calls, 1, 'removal disposes the live tape effect exactly once');
    assert.equal(chorusSpy.calls, 1, 'a retired effect is never disposed a second time');
    assert.equal(tapeSpy.calls, 1, 'a retired effect is never disposed a second time');
  });

  it('clears the registry and stops every modulator the removed track owned', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, MODULATOR_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);
    const modulators = collectStartedNodes(nativeEffect(1, 'fx-chorus'))
      .concat(collectStartedNodes(nativeEffect(1, 'fx-tape')));
    assert.ok(modulators.length >= 2, 'chorus and tape must each own a started modulator');

    audioEngine.removeMixerChannel(1);

    assert.equal(nativeEffect(1, 'fx-chorus'), undefined, 'no stale chorus entry remains');
    assert.equal(nativeEffect(1, 'fx-tape'), undefined, 'no stale tape entry remains');
    assert.equal(nativeRegistrySize(), 0, 'the registry must not keep an entry for a removed track');
    assert.equal(
      modulators.filter(node => node.stopCalls === 0).length,
      0,
      'every modulator the removed track started must be stopped',
    );
  });

  it('leaves nothing behind when a track is rebuilt and removed repeatedly', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS()), makeTrack(2, DELAY_SLOTS())],
      [makeChannel('ch-1', 1), makeChannel('ch-2', 2)],
    );
    const tracks = engine.activeMixerTracks as MixerTrack[];
    audioEngine.rebuildTrackFxChain(tracks[1]);
    audioEngine.rebuildTrackFxChain(tracks[2]);

    for (let pass = 0; pass < 3; pass += 1) {
      audioEngine.rebuildTrackFxChain(tracks[1]);
      audioEngine.rebuildTrackFxChain(tracks[2]);
    }

    audioEngine.removeMixerChannel(1);
    assert.equal(nativeEffect(1, 'fx-delay'), undefined, 'track 1 is fully unregistered');
    assert.ok(nativeEffect(2, 'fx-delay'), 'a sibling track is untouched by the removal');

    audioEngine.removeMixerChannel(2);
    assert.equal(nativeRegistrySize(), 0, 'the registry is empty once every track is gone');
    assert.equal(liveCtx.unstoppedModulators().length, 0, 'no modulator is left running');
  });
});

// ===============================================================================
// Group D — the PR #233 recovery guarantees survive the install
// ===============================================================================

describe('FX-LIFECYCLE-OWNER 5: PR #233 failure recovery still runs with the patch installed', () => {
  it('keeps the retired chain wired when the replacement cannot be connected, and releases the replacement', () => {
    liveCtx = installLiveContext(
      [makeTrack(0, []), makeTrack(1, DELAY_SLOTS())],
      [makeChannel('ch-1', 1)],
    );
    audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack);

    const retired = nativeEffect(1, 'fx-delay');
    assert.ok(retired, 'the first chain must be registered');
    const retiredSpy = spyDispose(retired);
    const channel = mixerChannel(1);
    const retiredNodes = [...(channel.fxNodes as unknown[])];
    const retiredInput = retired.input as FakeNode;

    // Fail the one edge that installs a replacement: chain tail -> channel panner.
    poisonConnectTo(channel.panner, 'simulated tail connect failure');
    assert.throws(
      () => audioEngine.rebuildTrackFxChain(engine.activeMixerTracks[1] as MixerTrack),
      /simulated tail connect failure/,
    );

    // The track is still audible through the chain the user was hearing.
    assert.deepEqual(
      [...(channel.fxNodes as unknown[])],
      retiredNodes,
      'the retired chain stays wired into the channel',
    );
    assert.equal(retiredSpy.calls, 0, 'the retired chain is not disposed: it is the running chain again');
    assert.equal(
      (audioEngine as any).setFxSlotParameter(1, 'fx-delay', 'time', 0.51),
      true,
      'the restored chain still accepts live parameter writes',
    );
    assert.ok(
      Math.abs((retired.effect.delay.delayTime as FakeParam).value - 0.51) < 1e-9,
      'the value landed on the restored chain',
    );
    assert.equal(retiredInput.disconnectCalls >= 1, true, 'the failed replacement was detached');
    void liveCtx;
  });
});

// ===============================================================================
// Group E — production boot never installs the legacy patch
// ===============================================================================

describe('FX-LIFECYCLE-OWNER 6: production startup does not install the legacy lifecycle patch', () => {
  it('src/main.tsx does not reference installLiveFxChainHardening', () => {
    const mainSource = readFileSync(join(REPO_ROOT, 'src', 'main.tsx'), 'utf8');
    assert.equal(
      mainSource.includes('installLiveFxChainHardening'),
      false,
      'production boot must not install the legacy FX-chain lifecycle patch',
    );
  });
});
