import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { MixerTrack, SidechainSettings } from '../types/daw';

/**
 * Phase 9A — detector lifecycle and routing rules at the engine boundary.
 *
 * These tests do not claim DSP correctness (the sample-level proof lives in
 * `sidechainDetectorWorklet.test.ts` and in the browser suite, which render real
 * `OfflineAudioContext` audio). They cover the graph rules: which routes attach
 * a detector, what gets torn down when a route changes, and that a missing
 * AudioWorklet degrades to unity gain instead of pretending to duck.
 */

class FakeParam {
  value = 1;
  readonly calls: Array<{ type: string; value: number }> = [];
  setValueAtTime(value: number): void {
    this.value = value;
    this.calls.push({ type: 'set', value });
  }
  setTargetAtTime(value: number): void {
    this.value = value;
    this.calls.push({ type: 'target', value });
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
    this.calls.push({ type: 'linear', value });
  }
  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
    this.calls.push({ type: 'exp', value });
  }
  cancelScheduledValues(): void {
    this.calls.push({ type: 'cancel', value: this.value });
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  connections: unknown[] = [];
  connect(target: unknown): void {
    this.connections.push(target);
  }
  disconnect(target?: unknown): void {
    if (target === undefined) this.connections = [];
    else this.connections = this.connections.filter(connection => connection !== target);
  }
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  static reset(): void {
    FakeWorkletNode.instances = [];
  }
  readonly parameters = new Map<string, FakeParam>([
    ['thresholdDb', new FakeParam()],
    ['ratio', new FakeParam()],
    ['maxReductionDb', new FakeParam()],
    ['attackMs', new FakeParam()],
    ['releaseMs', new FakeParam()],
  ]);
  readonly port = {
    onmessage: null as ((event: { data: { reductionDb: number; gain: number } }) => void) | null,
    closed: false,
    close(): void {
      this.closed = true;
    },
  };
  readonly processorName: string;
  constructor(_ctx: unknown, name: string) {
    super();
    this.processorName = name;
    FakeWorkletNode.instances.push(this);
  }
  /** Simulates a metering message from the audio thread. */
  emitReduction(reductionDb: number): void {
    this.port.onmessage?.({ data: { reductionDb, gain: Math.pow(10, -reductionDb / 20) } });
  }
}

const makeTrack = (id: number, sidechain?: SidechainSettings): MixerTrack => ({
  id,
  name: id === 0 ? 'Master' : `Insert ${id}`,
  color: '#fff',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  stereoWidth: 1,
  peakL: 0,
  peakR: 0,
  fxSlots: [],
  ...(sidechain ? { sidechain } : {}),
});

const levelSettings = (overrides: Partial<SidechainSettings> = {}): SidechainSettings => ({
  enabled: true,
  sourceTrackId: 1,
  amount: 0.75,
  attackMs: 5,
  releaseMs: 140,
  mode: 'level-detected',
  thresholdDb: -18,
  ratio: 4,
  ...overrides,
});

interface Harness {
  engine: any;
  ctx: any;
  restore: () => void;
}

const installHarness = (options: { withWorklet?: boolean } = {}): Harness => {
  const engine = audioEngine as any;
  const previous = {
    ctx: engine.ctx,
    masterGain: engine.masterGain,
    mixerChannels: engine.mixerChannels,
    mixerRoutingAdapter: engine.mixerRoutingAdapter,
    mixerRoutingChannelMap: engine.mixerRoutingChannelMap,
    channelPanners: engine.channelPanners,
    fxMaps: engine.__fxSlotEffectMaps,
    isOfflineRendering: engine.isOfflineRendering,
    lease: engine.offlineRenderLeaseHeld,
    depth: engine.offlineRenderOperationDepth,
    AudioWorkletNode: (globalThis as any).AudioWorkletNode,
  };

  const ctx: any = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'running',
    createGain: () => new FakeNode(),
    createAnalyser: () => Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 }),
    createStereoPanner: () => new FakePanner(),
    destination: new FakeNode(),
  };
  if (options.withWorklet !== false) {
    ctx.audioWorklet = {
      addModule: async () => undefined,
    };
  }

  engine.ctx = ctx;
  engine.masterGain = new FakeNode();
  engine.mixerChannels = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.channelPanners = new Map();
  engine.__fxSlotEffectMaps = new Map();
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.sidechainWorkletLoads = new WeakMap();
  engine.sidechainReductionDb = new Map();
  engine.sidechainReductionListeners = new Set();
  engine.sidechainDetectorWarningIssued = false;
  (globalThis as any).AudioWorkletNode = FakeWorkletNode;
  FakeWorkletNode.reset();

  return {
    engine,
    ctx,
    restore: () => {
      engine.ctx = previous.ctx;
      engine.masterGain = previous.masterGain;
      engine.mixerChannels = previous.mixerChannels;
      engine.mixerRoutingAdapter = previous.mixerRoutingAdapter;
      engine.mixerRoutingChannelMap = previous.mixerRoutingChannelMap;
      engine.channelPanners = previous.channelPanners;
      engine.__fxSlotEffectMaps = previous.fxMaps;
      engine.isOfflineRendering = previous.isOfflineRendering;
      engine.offlineRenderLeaseHeld = previous.lease;
      engine.offlineRenderOperationDepth = previous.depth;
      engine.sidechainReductionListeners = new Set();
      (globalThis as any).AudioWorkletNode = previous.AudioWorkletNode;
    },
  };
};

const createTracks = (engine: any, ...ids: number[]) => {
  engine.getOrCreateMixerChannel(0);
  for (const id of ids) engine.getOrCreateMixerChannel(id);
};

test('a level-detected route attaches a detector fed by the source post-fader output', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 1 })));
    await harness.engine.attachSidechainDetectors();

    const dest = harness.engine.mixerChannels.get(2);
    const source = harness.engine.mixerChannels.get(1);
    assert.ok(dest.sidechainDetector, 'the destination owns a detector');
    assert.equal(dest.sidechainDetector.sourceTrackId, 1);
    assert.equal(FakeWorkletNode.instances.length, 1);
    assert.ok(source.output.connections.includes(dest.sidechainDetector.node), 'the source post-fader output feeds the detector');
    assert.ok(dest.taps.includes(dest.sidechainDetector.node), 'the detector tap survives routing rebuilds');
    // The gain is fully driven by the detector's control signal.
    assert.equal(dest.duckingGain.gain.value, 0, 'the intrinsic gain is 0 while a detector drives the param');
    assert.ok(dest.sidechainDetector.control.connections.includes(dest.duckingGain.gain), 'the control signal drives the ducking AudioParam');
    assert.equal(harness.engine.hasSidechainDetector(2), true);
    assert.equal(harness.engine.hasSidechainDetector(1), false, 'the source track is not ducked by its own sidechain');
  } finally {
    harness.restore();
  }
});

test('the detector only listens: its output goes to the destination AudioParam, never to the destination input', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings()));
    await harness.engine.attachSidechainDetectors();
    const dest = harness.engine.mixerChannels.get(2);
    const node = dest.sidechainDetector.node as FakeWorkletNode;
    assert.equal(node.connections.length, 1, 'the worklet has exactly one outgoing edge');
    assert.equal(node.connections[0], dest.sidechainDetector.control);
    assert.ok(!node.connections.includes(dest.input), 'no audible edge into the destination input');
    assert.ok(!node.connections.includes(dest.output), 'the detector cannot feed itself back');
  } finally {
    harness.restore();
  }
});

test('note-triggered mode attaches no detector and keeps the legacy envelope', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    const settings = levelSettings({ mode: 'note-trigger', sourceTrackId: 1 });
    harness.engine.updateMixerTrack(makeTrack(2, settings));
    await harness.engine.attachSidechainDetectors();

    const dest = harness.engine.mixerChannels.get(2);
    assert.equal(dest.sidechainDetector, undefined, 'legacy mode has no detector');
    assert.equal(dest.duckingGain.gain.value, 1, 'legacy mode keeps unity intrinsic gain');

    harness.engine.triggerSidechainDucking(1, 0.5);
    const ramp = dest.duckingGain.gain.calls.filter((call: { type: string }) => call.type === 'linear' || call.type === 'exp');
    assert.equal(ramp.length, 2, 'the legacy note-triggered envelope still schedules its attack and release');
    const expectedMinGain = Math.max(0.02, 1 - settings.amount);
    assert.ok(Math.abs(ramp[0].value - expectedMinGain) < 1e-9, 'the legacy duck depth is unchanged');
  } finally {
    harness.restore();
  }
});

test('legacy documents without a mode resolve to note-trigger', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    const legacy = { enabled: true, sourceTrackId: 1, amount: 0.8, attackMs: 6, releaseMs: 180 } as SidechainSettings;
    harness.engine.updateMixerTrack(makeTrack(2, legacy));
    await harness.engine.attachSidechainDetectors();
    const dest = harness.engine.mixerChannels.get(2);
    assert.equal(dest.sidechain.mode, 'note-trigger');
    assert.equal(dest.sidechainDetector, undefined);
  } finally {
    harness.restore();
  }
});

test('a level-detected destination ignores the note-triggered envelope', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings()));
    await harness.engine.attachSidechainDetectors();
    const dest = harness.engine.mixerChannels.get(2);
    const before = dest.duckingGain.gain.calls.length;
    harness.engine.triggerSidechainDucking(1, 1.0);
    assert.equal(dest.duckingGain.gain.calls.length, before, 'no ramps may fight the detector');
  } finally {
    harness.restore();
  }
});

test('invalid routes fail safe: self, missing source and feedback cycles', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2, 3);

    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 2 })));
    await harness.engine.attachSidechainDetectors();
    assert.equal(harness.engine.mixerChannels.get(2).sidechainDetector, undefined, 'self-routing is refused');
    assert.equal(harness.engine.mixerChannels.get(2).duckingGain.gain.value, 1);

    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 99 })));
    await harness.engine.attachSidechainDetectors();
    assert.equal(harness.engine.mixerChannels.get(2).sidechainDetector, undefined, 'a missing source is refused');

    // Route the destination into the source, so tapping the source would close a loop.
    harness.engine.updateMixerTrack({ ...makeTrack(2, levelSettings({ sourceTrackId: 1 })), routingTargetId: 3 });
    harness.engine.updateMixerTrack({ ...makeTrack(3), routingTargetId: 1 });
    await harness.engine.attachSidechainDetectors();
    assert.equal(harness.engine.mixerChannels.get(2).sidechainDetector, undefined, 'a feedback cycle is refused');
    assert.equal(harness.engine.mixerChannels.get(2).duckingGain.gain.value, 1, 'the refused route leaves unity gain');
  } finally {
    harness.restore();
  }
});

test('disabling, changing the source and removing a channel detach cleanly', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2, 3);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 1 })));
    await harness.engine.attachSidechainDetectors();
    const first = harness.engine.mixerChannels.get(2).sidechainDetector.node as FakeWorkletNode;

    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 3 })));
    await harness.engine.attachSidechainDetectors();
    const second = harness.engine.mixerChannels.get(2).sidechainDetector;
    assert.equal(second.sourceTrackId, 3, 'the detector follows the new source');
    assert.ok(first.port.closed, 'the replaced detector is closed, not orphaned');
    assert.equal(FakeWorkletNode.instances.length, 2, 'exactly one replacement is created');
    assert.ok(!harness.engine.mixerChannels.get(1).output.connections.includes(first), 'the old tap edge is gone');

    harness.engine.updateMixerTrack(makeTrack(2, { ...levelSettings(), enabled: false }));
    await harness.engine.attachSidechainDetectors();
    assert.equal(harness.engine.mixerChannels.get(2).sidechainDetector, undefined);
    assert.equal(harness.engine.mixerChannels.get(2).duckingGain.gain.value, 1, 'disabling restores unity gain');

    harness.engine.updateMixerTrack(makeTrack(2, levelSettings({ sourceTrackId: 3 })));
    await harness.engine.attachSidechainDetectors();
    assert.ok(harness.engine.mixerChannels.get(2).sidechainDetector);
    harness.engine.removeMixerChannel(3);
    assert.equal(harness.engine.mixerChannels.get(2).sidechainDetector, undefined, 'removing the source detaches the detector');
    assert.equal(harness.engine.mixerChannels.get(2).duckingGain.gain.value, 1);
  } finally {
    harness.restore();
  }
});

test('repeated syncs are idempotent and never duplicate detectors', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings()));
    await harness.engine.attachSidechainDetectors();
    await harness.engine.attachSidechainDetectors();
    await harness.engine.attachSidechainDetectors();
    assert.equal(FakeWorkletNode.instances.length, 1);
    assert.equal(harness.engine.mixerChannels.get(2).taps.filter((tap: unknown) => tap === FakeWorkletNode.instances[0]).length, 1);
  } finally {
    harness.restore();
  }
});

test('measured reduction from the audio thread reaches subscribers', async () => {
  const harness = installHarness();
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings()));
    await harness.engine.attachSidechainDetectors();
    const seen: Array<{ trackId: number; reductionDb: number }> = [];
    const unsubscribe = harness.engine.onSidechainReduction((snapshot: { trackId: number; reductionDb: number }) => seen.push(snapshot));
    const node = harness.engine.mixerChannels.get(2).sidechainDetector.node as FakeWorkletNode;
    node.emitReduction(9.5);
    assert.equal(harness.engine.getSidechainReductionDb(2), 9.5);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reductionDb, 9.5);
    unsubscribe();
    node.emitReduction(3);
    assert.equal(seen.length, 1, 'unsubscribed meters stop receiving updates');
    assert.equal(harness.engine.getSidechainReductionDb(2), 3);
  } finally {
    harness.restore();
  }
});

test('a context without AudioWorklet support fails safe instead of faking ducking', async () => {
  const harness = installHarness({ withWorklet: false });
  try {
    createTracks(harness.engine, 1, 2);
    harness.engine.updateMixerTrack(makeTrack(2, levelSettings()));
    await harness.engine.attachSidechainDetectors();
    const dest = harness.engine.mixerChannels.get(2);
    assert.equal(dest.sidechainDetector, undefined);
    assert.equal(dest.duckingGain.gain.value, 1, 'no detector means no attenuation');
    assert.equal(FakeWorkletNode.instances.length, 0);
  } finally {
    harness.restore();
  }
});
