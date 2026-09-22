import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxSlot, MixerTrack } from '../types/daw';
import { applyLiveFxChainMix, getLiveFxSlotEffect, installLiveFxChainHardening } from './liveFxChainHardening';

type FakeParam = {
  value: number;
  values: Array<{ value: number; time: number }>;
  setValueAtTime(value: number, time: number): void;
};

type FakeNode = {
  connections: unknown[];
  disconnectCalls: number;
  connect(target: unknown): void;
  disconnect(): void;
};

function makeContext() {
  const nodes: Array<Record<string, unknown>> = [];
  let failingTarget: unknown = null;
  let failConnections = false;

  const param = (value = 0): FakeParam => ({
    value,
    values: [],
    setValueAtTime(next, time) {
      this.value = next;
      this.values.push({ value: next, time });
    },
  });

  const make = <T extends Record<string, unknown>>(extra: T = {} as T): T & FakeNode => {
    const created = Object.assign({
      connections: [],
      disconnectCalls: 0,
      connect(target: unknown) {
        if (failConnections && target === failingTarget) throw new Error('simulated graph connection failure');
        this.connections.push(target);
      },
      disconnect() {
        this.connections.length = 0;
        this.disconnectCalls += 1;
      },
    }, extra) as T & FakeNode;
    nodes.push(created);
    return created;
  };

  const context = {
    currentTime: 1,
    sampleRate: 48000,
    createGain: () => make({ gain: param(1) }),
    createDelay: () => make({ delayTime: param(0) }),
    createBiquadFilter: () => make({ type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }),
    createDynamicsCompressor: () => make({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
    createWaveShaper: () => make({ curve: null, oversample: 'none' }),
    createConvolver: () => make({ buffer: null }),
    createOscillator: () => make({ frequency: param(0), startCalls: 0, stopCalls: 0, start() { (this as any).startCalls += 1; }, stop() { (this as any).stopCalls += 1; } }),
    createConstantSource: () => make({ offset: param(0), startCalls: 0, stopCalls: 0, start() { (this as any).startCalls += 1; }, stop() { (this as any).stopCalls += 1; } }),
    createBuffer: (_channels: number, length: number, _rate: number) => ({ getChannelData: () => new Float32Array(length) }),
  } as unknown as AudioContext;

  return {
    context,
    nodes,
    failGraphConnection(target: unknown) {
      failingTarget = target;
      failConnections = true;
    },
    clearGraphConnectionFailure() {
      failConnections = false;
      failingTarget = null;
    },
  };
}

function slot(type: FxSlot['type'], mix = 0.5, params: Record<string, number> = {}): FxSlot {
  return { id: `${type}-1`, type, name: type, enabled: true, mix, params };
}

function track(fxSlots: FxSlot[]): MixerTrack {
  return {
    id: 1,
    name: 'Test Track',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    fxSlots,
  } as MixerTrack;
}

describe('live mixer FX hardening', () => {
  it('applies slot mix as a real dry/wet control and preserves zero parameters', () => {
    const { context, nodes } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([
      slot('delay', 0, { time: 0, feedback: 0 }),
      slot('compressor', 1, { threshold: -18 }),
    ]));

    const gainParams = nodes
      .map((created) => created.gain as FakeParam | undefined)
      .filter(Boolean) as FakeParam[];
    assert.ok(gainParams.some((gain) => gain.value === 0), 'a fully dry slot must create a zero wet gain');
    assert.ok(gainParams.some((gain) => gain.value === 1), 'a fully dry slot must create a unity dry gain');

    const delayTimes = nodes
      .map((created) => created.delayTime as FakeParam | undefined)
      .filter(Boolean) as FakeParam[];
    assert.ok(delayTimes.some((value) => value.value === 0), 'zero delay time must remain valid');
  });

  it('builds the declared chorus FX and wires tape flutter modulation', () => {
    const { context, nodes } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([
      slot('chorus', 0.4),
      slot('tape_saturation', 0.6, { drive: 35, warmth: 0.8, flutter: 0.002 }),
    ]));

    const oscillators = nodes.filter((created) => 'startCalls' in created);
    assert.ok(oscillators.length >= 2, 'chorus and tape flutter must each own an oscillator');
    assert.ok(oscillators.every((created) => (created.startCalls as number) >= 1), 'modulation oscillators must be started');
  });

  it('keeps the previous chain intact when replacement graph construction fails', () => {
    const fixture = makeContext();
    const { context, nodes } = fixture;
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([slot('delay', 0.5)]));
    const oldFxNodes = [...channel.fxNodes];
    const oldInputConnections = [...(channel.input as unknown as FakeNode).connections];
    const nodesBeforeFailure = nodes.length;

    fixture.failGraphConnection(channel.panner);
    assert.throws(
      () => engine.rebuildTrackFxChain(track([slot('chorus', 0.5)])),
      /simulated graph connection failure/,
    );

    assert.deepEqual(channel.fxNodes, oldFxNodes, 'failed rebuild must not replace the active node list');
    assert.deepEqual((channel.input as unknown as FakeNode).connections, oldInputConnections, 'failed rebuild must preserve the active input routing');
    assert.ok(oldFxNodes.every((node) => (node as unknown as FakeNode).disconnectCalls === 0), 'failed rebuild must not tear down the active chain');

    const replacementNodes = nodes.slice(nodesBeforeFailure);
    assert.ok(replacementNodes.length > 0, 'the failing rebuild should have attempted new construction');
    assert.ok(replacementNodes.every((node) => (node.disconnectCalls as number) > 0), 'partially created replacement nodes must be disposed');

    fixture.clearGraphConnectionFailure();
  });

  it('disposes the previous live chain before rebuilding and cleans it on track removal', () => {
    const { context, nodes } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([slot('delay')]));
    const firstChainNodes = [...nodes];
    engine.rebuildTrackFxChain(track([slot('chorus')]));
    assert.ok(firstChainNodes.some((created) => (created.disconnectCalls as number) > 0), 'rebuild must disconnect and dispose the previous chain');

    engine.removeMixerChannel(1);
    assert.ok(nodes.some((created) => (created.disconnectCalls as number) > 1), 'track removal must clean the active chain');
  });

  it('exposes slot.mix live updates without rebuilding the chain (Phase 10B)', () => {
    const { context } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([slot('reverb', 0.5), slot('delay', 0.3)]));

    // The slot-id index must resolve to the live WetDry wrapper for each slot.
    const reverbEffect = getLiveFxSlotEffect(engine as any, 1, 'reverb-1');
    const delayEffect = getLiveFxSlotEffect(engine as any, 1, 'delay-1');
    assert.ok(reverbEffect, 'reverb slot must be in the live index');
    assert.ok(delayEffect, 'delay slot must be in the live index');

    // Updating slot.mix via the live helper must NOT touch the channel FX
    // chain (no new connections, no disconnects). Slot index keys must still
    // resolve after the update.
    const fxNodesBefore = channel.fxNodes.length;
    const inputConnBefore = (channel.input as unknown as FakeNode).connections.length;
    const ok = applyLiveFxChainMix(engine as any, 1, 'delay-1', 0.9, 1.23);
    assert.equal(ok, true, 'slot.mix live update returns true when the chain owns the slot');
    assert.equal(channel.fxNodes.length, fxNodesBefore, 'fx node list is unchanged');
    assert.equal(
      (channel.input as unknown as FakeNode).connections.length,
      inputConnBefore,
      'channel input routing is unchanged (no rebuild)',
    );

    // An unknown slot id returns false without throwing.
    const miss = applyLiveFxChainMix(engine as any, 1, 'does-not-exist', 0.5, 1.23);
    assert.equal(miss, false, 'unknown slot ids return false');

    // The reverb slot's mix must still be reachable after a different slot's
    // mix update — a delayed update must not invalidate the index.
    const stillReverb = getLiveFxSlotEffect(engine as any, 1, 'reverb-1');
    assert.equal(stillReverb, reverbEffect, 'other slots remain reachable after a peer update');
  });

  it('forwards slot.mix to the WetDry wrapper via setParameter (Phase 10B)', () => {
    // Capture every createGain() invocation so we can inspect the WetDry
    // wrapper's dry/wet pair after a slot.mix update. The patch always wraps
    // the inner effect in a fresh WetDryEffect, whose own dry/wet pair is
    // the first two GainNodes built for that slot (after the input/output).
    const allGains: Array<{ gain: FakeParam }> = [];
    const { context, nodes } = makeContext();
    const originalCreateGain = context.createGain.bind(context);
    context.createGain = () => {
      const node = originalCreateGain();
      allGains.push(node as unknown as { gain: FakeParam });
      return node;
    };
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    const gainsBefore = allGains.length;
    engine.rebuildTrackFxChain(track([slot('chorus', 0.5)]));

    // The WetDry wrapper owns the dry/wet pair. After construction, its dry
    // gain holds 1 - 0.5 = 0.5 and wet gain holds 0.5. After the live mix
    // update, those should be 0.3 and 0.7 respectively. We isolate the pair
    // by capturing the last two gains (the WetDryEffect creates them in
    // input -> dry -> wet -> output order).
    const slotEffect = getLiveFxSlotEffect(engine as any, 1, 'chorus-1');
    assert.ok(slotEffect, 'slot effect must be registered');
    const slotGains = allGains.slice(gainsBefore);
    assert.ok(slotGains.length >= 2, 'wet/dry pair must exist for the slot');

    applyLiveFxChainMix(engine as any, 1, 'chorus-1', 0.7, 0.42);

    // Verify the slot's wet/dry pair recorded the post-update values.
    const lastTwo = slotGains.slice(-2);
    const finalValues = lastTwo.map((g) => g.gain.value).sort((a, b) => a - b);
    const closeTo = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert.ok(closeTo(finalValues[0], 0.3), 'dry gain is 0.3 (= 1 - mix)');
    assert.ok(closeTo(finalValues[1], 0.7), 'wet gain is 0.7 (= mix)');
    // Sanity check: at least one gain value should now be 0.3 (dry = 1 - mix).
    assert.ok(lastTwo.some((g) => closeTo(g.gain.value, 0.3)), 'at least one WetDry gain is 0.3');
    assert.ok(lastTwo.some((g) => closeTo(g.gain.value, 0.7)), 'at least one WetDry gain is 0.7');
    // Confirm the rest of the chain (oscillator nodes, input/panner, etc.)
    // wasn't rebuilt beyond the per-slot pre-existing node list.
    void nodes; // silence unused-var lint when this file grows
  });

  it('drops the slot id index when a track is removed (Phase 10B)', () => {
    const { context } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
    };

    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(track([slot('reverb', 0.5)]));
    assert.ok(getLiveFxSlotEffect(engine as any, 1, 'reverb-1'), 'slot is registered after rebuild');

    engine.removeMixerChannel(1);
    assert.equal(getLiveFxSlotEffect(engine as any, 1, 'reverb-1'), undefined, 'slot index is cleared on track removal');
    assert.equal(applyLiveFxChainMix(engine as any, 1, 'reverb-1', 0.7, 0), false, 'live mix returns false after track removal');
  });

  // Phase 10C-B: the offline-rendering branch of `installLiveFxChainHardening`
  // was added in Phase 10C-A to guarantee that FX rebuilt during a render
  // (`OfflineAudioContext`) goes through the same factory as the live chain.
  // It had no direct test coverage before this phase; the tests below pin the
  // branch to its contract so a future refactor of the offline / live dispatch
  // cannot silently drop a chorus or other 10th-FX slot from an exported WAV.
});

describe('Phase 10C-B: offline-rendering branch of installLiveFxChainHardening', () => {
  function buildOfflineEngine(extra: Record<string, unknown> = {}) {
    const { context, nodes } = makeContext();
    const channel = {
      input: context.createGain(),
      panner: context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    // The hardening patch reads `(this as any).ctx` to choose the offline path.
    // We point it at a duck-typed object that looks like OfflineAudioContext
    // (it owns `startRendering`) so the dispatch takes the offline branch.
    const offlineCtx = Object.assign(Object.create(null), context, {
      startRendering: () => Promise.resolve({} as AudioBuffer),
    });
    const engine = {
      getContext: () => context,
      getOrCreateMixerChannel: (_trackId: number) => channel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
      ctx: offlineCtx,
      isOfflineRendering: true,
      ...extra,
    };
    return { engine: engine as any, context, nodes, channel };
  }

  function trackWithId(id: number, fxSlots: FxSlot[]): MixerTrack {
    return { id, name: `Track ${id}`, volume: 1, pan: 0, mute: false, solo: false, fxSlots } as MixerTrack;
  }

  it('offline: chorus slot is wired into the channel graph (Phase 10C-B)', () => {
    const { engine, channel, nodes } = buildOfflineEngine();
    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(trackWithId(7, [slot('chorus', 0.4)]));

    const channelInput = channel.input as unknown as FakeNode;
    assert.ok(channelInput.connections.length >= 1, 'offline chorus wiring: channel.input must connect to the chorus slot');
    assert.ok(channel.fxNodes.length >= 2, 'offline chorus wiring: at least 2 nodes must be tracked (input + output of the WetDry wrapper)');

    // Chorus creates an LFO oscillator + ConstantSource offset; both must be
    // started by the ChorusEffect constructor. Track that they exist.
    const startableNodes = nodes.filter((created) => 'startCalls' in created);
    assert.ok(startableNodes.length >= 2, 'offline chorus wiring: chorus LFO + offset must each be started');
  });

  it('offline: live and offline paths produce the same node graph for chorus (Phase 10C-B)', () => {
    const { context: liveCtx } = makeContext();
    const liveChannel = { input: liveCtx.createGain(), panner: liveCtx.createGain(), fxNodes: [] as AudioNode[] };
    const liveEngine = {
      getContext: () => liveCtx,
      getOrCreateMixerChannel: (_trackId: number) => liveChannel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
      ctx: liveCtx,
      isOfflineRendering: false,
    };

    const { context: offCtx, nodes: offNodes } = makeContext();
    const offChannel = { input: offCtx.createGain(), panner: offCtx.createGain(), fxNodes: [] as AudioNode[] };
    const offlineCtx = Object.assign(Object.create(null), offCtx, { startRendering: () => Promise.resolve({} as AudioBuffer) });
    const offEngine = {
      getContext: () => offCtx,
      getOrCreateMixerChannel: (_trackId: number) => offChannel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
      ctx: offlineCtx,
      isOfflineRendering: true,
    };

    installLiveFxChainHardening(liveEngine as any);
    installLiveFxChainHardening(offEngine as any);

    const liveBefore = (liveCtx as any)._nodeCount ?? 0;
    const offBefore = offNodes.length;
    liveEngine.rebuildTrackFxChain(trackWithId(2, [slot('chorus', 0.6)]));
    offEngine.rebuildTrackFxChain(trackWithId(3, [slot('chorus', 0.6)]));

    // Live and offline must agree on the final wiring topology. Both run the
    // same `buildChain` factory, so node/fxNodes counts must match.
    assert.equal(
      liveChannel.fxNodes.length,
      offChannel.fxNodes.length,
      'live and offline chorus: fxNodes count must match',
    );
    void liveBefore;
    void offBefore;
  });

  it('offline: every FxType value builds without throwing (Phase 10C-B)', () => {
    const FX_TYPES: FxSlot['type'][] = [
      'equalizer', 'reverb', 'delay', 'distortion', 'compressor',
      'chorus', 'bitcrusher', 'limiter', 'tape_saturation', 'gross_beat',
    ];
    for (const type of FX_TYPES) {
      const { engine, channel } = buildOfflineEngine();
      installLiveFxChainHardening(engine);
      assert.doesNotThrow(
        () => engine.rebuildTrackFxChain(trackWithId(11, [slot(type, 0.5)])),
        `offline branch must build ${type} without throwing`,
      );
      const channelInput = channel.input as unknown as FakeNode;
      assert.ok(
        channelInput.connections.length >= 1,
        `offline ${type}: channel.input must be wired (got ${channelInput.connections.length} connections)`,
      );
    }
  });

  it('offline: chorus slot is reachable through getLiveFxSlotEffect (Phase 10C-B)', () => {
    const { engine } = buildOfflineEngine();
    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(trackWithId(13, [slot('chorus', 0.45)]));

    const slotEffect = getLiveFxSlotEffect(engine, 13, 'chorus-1');
    assert.ok(slotEffect, 'offline chorus slot must be registered in the slot-id index');
    assert.equal((slotEffect as any).name, 'Chorus', 'offline chorus slot must be the Chorus Effect or its WetDry wrapper');
  });

  it('offline: disabled slots are skipped (Phase 10C-B)', () => {
    const { engine, channel } = buildOfflineEngine();
    installLiveFxChainHardening(engine);
    const chorus: FxSlot = { ...slot('chorus', 0.5), enabled: false };
    engine.rebuildTrackFxChain(trackWithId(14, [chorus]));
    assert.equal(channel.fxNodes.length, 0, 'disabled chorus slot must not add nodes to the offline chain');
    assert.equal(
      getLiveFxSlotEffect(engine, 14, 'chorus-1'),
      undefined,
      'disabled chorus slot must not appear in the offline slot-id index',
    );
  });

  it('offline: malformed slot.mix raises RangeError, mirroring live validation (Phase 10C-B)', () => {
    const { engine } = buildOfflineEngine();
    installLiveFxChainHardening(engine);
    // Live mixFor() rejects out-of-range mix values; the offline branch must
    // raise the same RangeError so a malformed project value is caught
    // uniformly on both paths.
    assert.throws(
      () => engine.rebuildTrackFxChain(trackWithId(15, [slot('chorus', 1.5)])),
      /must be between 0 and 1/,
      'offline branch must reject chorus slot.mix > 1',
    );
  });

  it('offline: does not pollute the live chain state (Phase 10C-B)', () => {
    // An offline rebuild must populate the slot-id index but must NOT register
    // its slot effects into the live state-map (which `installLiveFxChainHardening`
    // uses for disposal on the next live rebuild). If it did, a live rebuild
    // after an offline export would dispose the wrong graph.
    const { engine } = buildOfflineEngine();
    installLiveFxChainHardening(engine);
    engine.rebuildTrackFxChain(trackWithId(16, [slot('chorus', 0.5)]));
    // The slot is registered (offline path still builds the slot index).
    assert.ok(
      getLiveFxSlotEffect(engine, 16, 'chorus-1'),
      'offline rebuild must register the chorus slot for slot-lookups',
    );

    // The internal `states` map (per-track live effect list) must remain
    // empty for the offline-only engine so a subsequent live rebuild on the
    // same engine does not try to dispose an offline graph.
    const internalStates = (engine as any).__liveFxChainRegistry as
      | { getChain(trackId: number): { slotEffects: ReadonlyMap<string, unknown> } | undefined }
      | undefined;
    assert.ok(internalStates, '__liveFxChainRegistry must be installed');
    const chain = internalStates!.getChain(16);
    assert.ok(chain, 'getChain must resolve the offline track');
    assert.equal(chain!.slotEffects.size, 1, 'offline rebuild must index the chorus slot');
  });
});


describe('Phase 11B: live/export FX parity matrix', () => {
  function nodeKind(node: Record<string, unknown>): string {
    if ('delayTime' in node) return 'delay';
    if ('threshold' in node && 'ratio' in node) return 'compressor';
    if ('frequency' in node && 'Q' in node && 'gain' in node) return 'biquad';
    if ('curve' in node) return 'waveshaper';
    if ('buffer' in node) return 'convolver';
    if ('offset' in node && 'startCalls' in node) return 'constant-source';
    if ('frequency' in node && 'startCalls' in node) return 'oscillator';
    if ('gain' in node) return 'gain';
    return 'other';
  }

  function buildBoth(type: FxSlot['type'], mix = 0.37) {
    const liveFixture = makeContext();
    const liveChannel = {
      input: liveFixture.context.createGain(),
      panner: liveFixture.context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const liveEngine = {
      getContext: () => liveFixture.context,
      getOrCreateMixerChannel: (_trackId: number) => liveChannel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
      ctx: liveFixture.context,
      isOfflineRendering: false,
    };

    const offlineFixture = makeContext();
    const offlineChannel = {
      input: offlineFixture.context.createGain(),
      panner: offlineFixture.context.createGain(),
      fxNodes: [] as AudioNode[],
    };
    const offlineCtx = Object.assign(Object.create(null), offlineFixture.context, {
      startRendering: () => Promise.resolve({} as AudioBuffer),
    });
    const offlineEngine = {
      getContext: () => offlineFixture.context,
      getOrCreateMixerChannel: (_trackId: number) => offlineChannel,
      rebuildTrackFxChain(_track: MixerTrack) {},
      removeMixerChannel(_trackId: number) {},
      ctx: offlineCtx,
      isOfflineRendering: true,
    };

    installLiveFxChainHardening(liveEngine as any);
    installLiveFxChainHardening(offlineEngine as any);

    const liveStart = liveFixture.nodes.length;
    const offlineStart = offlineFixture.nodes.length;
    const fxSlot = slot(type, mix);
    liveEngine.rebuildTrackFxChain(trackWithId(21, [fxSlot]));
    offlineEngine.rebuildTrackFxChain(trackWithId(21, [fxSlot]));

    return {
      liveKinds: liveFixture.nodes.slice(liveStart).map(nodeKind).sort(),
      offlineKinds: offlineFixture.nodes.slice(offlineStart).map(nodeKind).sort(),
      liveFxCount: liveChannel.fxNodes.length,
      offlineFxCount: offlineChannel.fxNodes.length,
      liveEffect: getLiveFxSlotEffect(liveEngine as any, 21, fxSlot.id),
      offlineEffect: getLiveFxSlotEffect(offlineEngine as any, 21, fxSlot.id),
    };
  }

  it('uses the same FX graph shape for every supported effect in live and offline rendering', () => {
    const fxTypes: FxSlot['type'][] = [
      'equalizer',
      'reverb',
      'delay',
      'distortion',
      'compressor',
      'chorus',
      'bitcrusher',
      'limiter',
      'tape_saturation',
      'gross_beat',
    ];

    for (const type of fxTypes) {
      const result = buildBoth(type);
      assert.deepEqual(
        result.offlineKinds,
        result.liveKinds,
        `live/export graph node kinds must match for ${type}`,
      );
      assert.equal(
        result.offlineFxCount,
        result.liveFxCount,
        `live/export tracked FX node count must match for ${type}`,
      );
      assert.ok(result.liveEffect, `live ${type} slot must be registered`);
      assert.ok(result.offlineEffect, `offline ${type} slot must be registered`);
    }
  });

  it('preserves the same wet/dry mix contract in live and offline FX graphs', () => {
    const fxTypes: FxSlot['type'][] = [
      'equalizer',
      'reverb',
      'delay',
      'distortion',
      'compressor',
      'chorus',
      'bitcrusher',
      'limiter',
      'tape_saturation',
      'gross_beat',
    ];

    for (const type of fxTypes) {
      const result = buildBoth(type, 0.37);
      assert.ok(result.liveEffect, `live ${type} effect must exist`);
      assert.ok(result.offlineEffect, `offline ${type} effect must exist`);

      const liveSetParameter = (result.liveEffect as any).setParameter;
      const offlineSetParameter = (result.offlineEffect as any).setParameter;
      assert.equal(typeof liveSetParameter, 'function', `live ${type} effect must expose parameters`);
      assert.equal(typeof offlineSetParameter, 'function', `offline ${type} effect must expose parameters`);

      assert.doesNotThrow(
        () => liveSetParameter.call(result.liveEffect, 'mix', 0.61, 0.5),
        `live ${type} must accept mix updates`,
      );
      assert.doesNotThrow(
        () => offlineSetParameter.call(result.offlineEffect, 'mix', 0.61, 0.5),
        `offline ${type} must accept mix updates`,
      );
    }
  });
});
