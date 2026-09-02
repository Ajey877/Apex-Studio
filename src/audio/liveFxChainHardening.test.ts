import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxSlot, MixerTrack } from '../types/daw';
import { installLiveFxChainHardening } from './liveFxChainHardening';

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

function param(value = 0): FakeParam {
  return {
    value,
    values: [],
    setValueAtTime(next, time) {
      this.value = next;
      this.values.push({ value: next, time });
    },
  };
}

function node(): FakeNode {
  return {
    connections: [],
    disconnectCalls: 0,
    connect(target) { this.connections.push(target); },
    disconnect() { this.connections.length = 0; this.disconnectCalls += 1; },
  };
}

function makeContext() {
  const nodes: Array<Record<string, unknown>> = [];
  const make = <T extends Record<string, unknown>>(extra: T = {} as T): T & FakeNode => {
    const created = Object.assign(node(), extra) as T & FakeNode;
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

  return { context, nodes };
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
});
