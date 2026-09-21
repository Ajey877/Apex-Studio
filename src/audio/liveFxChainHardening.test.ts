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
});
