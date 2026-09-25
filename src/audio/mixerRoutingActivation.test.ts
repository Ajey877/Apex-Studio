import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MixerRoutingAdapter } from './mixerRoutingAdapter';
import { audioEngine } from './audioEngine';
import type { MixerTrack } from '../types/daw';

class FakeParam {
  value = 1;
  setTargetAtTime(value: number): void { this.value = value; }
  setValueAtTime(value: number): void { this.value = value; }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  readonly gain = new FakeParam();
  readonly pan = new FakeParam();
  fftSize = 0;
  smoothingTimeConstant = 0;

  connect(target: FakeNode): void {
    this.connections.push(target);
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeContext {
  currentTime = 0;
  readonly destination = new FakeNode();

  createGain(): FakeNode { return new FakeNode(); }
  createStereoPanner(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
}

class FakeOfflineContext extends FakeContext {
  static instances: FakeOfflineContext[] = [];
  readonly nodes: FakeNode[] = [];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    super();
    FakeOfflineContext.instances.push(this);
  }

  createGain(): FakeNode {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }

  createStereoPanner(): FakeNode {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }

  createAnalyser(): FakeNode {
    const node = new FakeNode();
    this.nodes.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number): any {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }

  async startRendering(): Promise<any> {
    return this.createBuffer(this.numberOfChannels, this.length, this.sampleRate);
  }
}

const nodes = (ids: number[]) => new Map(ids.map(id => [id, {
  input: new FakeNode(),
  output: new FakeNode(),
}]));

const makeTrack = (id: number, routingTargetId?: number): MixerTrack => ({
  id,
  name: id === 0 ? 'Master' : `Track ${id}`,
  color: '#fff',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  stereoWidth: 1,
  peakL: 0,
  peakR: 0,
    routingTargetId,
  sends: { send1: 0, send2: 0 },
  fxSlots: [],
});

describe('Phase 27 mixer routing activation', () => {
  it('preserves default track -> Master routing', () => {
    const graph = nodes([0, 1, 2]);
    const adapter = new MixerRoutingAdapter(graph as any);

    const result = adapter.syncRoutes([
      { trackId: 1, targetId: 0 },
      { trackId: 2, targetId: 0 },
    ]);

    assert.equal(result.valid, true);
    assert.equal(adapter.getRoute(1), 0);
    assert.equal(adapter.getRoute(2), 0);
    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(0)!.input]);
    assert.deepEqual(graph.get(2)!.output.connections, [graph.get(0)!.input]);
  });

  it('routes A -> B and replaces A -> C without stale or duplicate connections', () => {
    const graph = nodes([0, 1, 2, 3]);
    const adapter = new MixerRoutingAdapter(graph as any);

    assert.equal(adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 0 },
      { trackId: 3, targetId: 0 },
    ]).valid, true);
    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(2)!.input]);

    assert.equal(adapter.syncRoutes([
      { trackId: 1, targetId: 3 },
      { trackId: 2, targetId: 0 },
      { trackId: 3, targetId: 0 },
    ]).valid, true);
    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(3)!.input]);
    assert.equal(graph.get(1)!.output.connections.includes(graph.get(2)!.input), false);
    assert.equal(graph.get(1)!.output.connections.length, 1);
  });

  it('removes an explicit route by restoring A -> Master', () => {
    const graph = nodes([0, 1, 2]);
    const adapter = new MixerRoutingAdapter(graph as any);

    adapter.syncRoutes([{ trackId: 1, targetId: 2 }, { trackId: 2, targetId: 0 }]);
    assert.equal(adapter.syncRoutes([{ trackId: 1, targetId: 0 }, { trackId: 2, targetId: 0 }]).valid, true);
    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(0)!.input]);
  });

  it('supports multi-level A -> B -> C -> Master', () => {
    const graph = nodes([0, 1, 2, 3]);
    const adapter = new MixerRoutingAdapter(graph as any);

    assert.equal(adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 3 },
      { trackId: 3, targetId: 0 },
    ]).valid, true);

    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(2)!.input]);
    assert.deepEqual(graph.get(2)!.output.connections, [graph.get(3)!.input]);
    assert.deepEqual(graph.get(3)!.output.connections, [graph.get(0)!.input]);
  });

  it('rejects self-routes, two-node cycles, three-node cycles, and invalid destinations', () => {
    const graph = nodes([0, 1, 2, 3]);
    const adapter = new MixerRoutingAdapter(graph as any);
    adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 3 },
      { trackId: 3, targetId: 0 },
    ]);

    assert.equal(adapter.syncRoutes([{ trackId: 1, targetId: 1 }]).valid, false);
    assert.equal(adapter.getRoute(1), 2);

    assert.equal(adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 1 },
      { trackId: 3, targetId: 0 },
    ]).valid, false);
    assert.equal(adapter.getRoute(1), 2);
    assert.equal(adapter.getRoute(2), 3);

    assert.equal(adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 3 },
      { trackId: 3, targetId: 1 },
    ]).valid, false);
    assert.equal(adapter.getRoute(1), 2);

    assert.equal(adapter.syncRoutes([{ trackId: 1, targetId: 99 }]).valid, false);
    assert.equal(adapter.getRoute(1), 2);
  });

  it('rolls back a failed graph application without losing the previous topology', () => {
    const graph = nodes([0, 1, 2]);
    const adapter = new MixerRoutingAdapter(graph as any);
    adapter.syncRoutes([{ trackId: 1, targetId: 0 }, { trackId: 2, targetId: 0 }]);

    const originalConnect = graph.get(1)!.output.connect.bind(graph.get(1)!.output);
    let failOnce = true;
    graph.get(1)!.output.connect = (target: FakeNode) => {
      if (failOnce && target === graph.get(2)!.input) {
        failOnce = false;
        throw new Error('simulated connection failure');
      }
      originalConnect(target);
    };

    assert.throws(() => adapter.syncRoutes([
      { trackId: 1, targetId: 2 },
      { trackId: 2, targetId: 0 },
    ]), /simulated connection failure/);

    assert.equal(adapter.getRoute(1), 0);
    assert.deepEqual(graph.get(1)!.output.connections, [graph.get(0)!.input]);
  });

  it('integrates routing into the live AudioEngine mixer graph', () => {
    const engine = audioEngine as any;
    const previousCtx = engine.ctx;
    const previousMasterGain = engine.masterGain;
    const previousMixerChannels = engine.mixerChannels;
    const previousAdapter = engine.mixerRoutingAdapter;

    const ctx = new FakeContext();
    engine.ctx = ctx;
    engine.masterGain = new FakeNode();
    engine.mixerChannels = new Map();
    engine.mixerRoutingAdapter = null;

    try {
      const master = engine.getOrCreateMixerChannel(0);
      engine.updateMixerTrack(makeTrack(0));
      const a = engine.getOrCreateMixerChannel(1);
      const b = engine.getOrCreateMixerChannel(2);

      engine.updateMixerTrack(makeTrack(2));
      engine.updateMixerTrack(makeTrack(1, 2));

      assert.deepEqual(a.output.connections, [b.input]);
      assert.equal(a.output.connections.includes(master.input), false);

      engine.updateMixerTrack(makeTrack(1, 0));
      assert.deepEqual(a.output.connections, [master.input]);
    } finally {
      engine.ctx = previousCtx;
      engine.masterGain = previousMasterGain;
      engine.mixerChannels = previousMixerChannels;
      engine.mixerRoutingAdapter = previousAdapter;
    }
  });

  it('constructs the same routed topology for OfflineAudioContext', async () => {
    const engine = audioEngine as any;
    const previousOffline = (globalThis as any).OfflineAudioContext;
    const previousWindow = (globalThis as any).window;
    const previousCtx = engine.ctx;

    (globalThis as any).OfflineAudioContext = FakeOfflineContext;
    (globalThis as any).window = { OfflineAudioContext: FakeOfflineContext };
    engine.ctx = null;
    FakeOfflineContext.instances = [];

    const tracks = [
      makeTrack(0),
      makeTrack(1, 2),
      makeTrack(2, 3),
      makeTrack(3, 0),
    ];

    try {
      await engine.renderTimelineOffline([], [], tracks, 120, 1, 44100, false, 'song', undefined, undefined, undefined, 1);
      const ctx = FakeOfflineContext.instances[0];
      assert.ok(ctx);

      // Each mixer channel is created as five nodes:
      // input, output, duckingGain, panner, analyser.
      // The offline master bus creates three nodes before the mixer channels.
      // Track 1 output must feed Track 2 input, Track 2 output -> Track 3 input,
      // and Track 3 output -> Master input.
      const masterInput = ctx.nodes[3];
      const track1Output = ctx.nodes[9];
      const track2Input = ctx.nodes[13];
      const track2Output = ctx.nodes[14];
      const track3Input = ctx.nodes[18];
      const track3Output = ctx.nodes[19];

      assert.deepEqual(track1Output.connections, [track2Input]);
      assert.deepEqual(track2Output.connections, [track3Input]);
      assert.deepEqual(track3Output.connections, [masterInput]);
      assert.equal((engine.mixerChannels as Map<number, any>).size, 0, 'offline graph state is restored after rendering');
    } finally {
      engine.ctx = previousCtx;
      (globalThis as any).OfflineAudioContext = previousOffline;
      (globalThis as any).window = previousWindow;
    }
  });

  it('keeps mixer mute gain semantics intact on a routed track', () => {
    const engine = audioEngine as any;
    const previousCtx = engine.ctx;
    const previousMasterGain = engine.masterGain;
    const previousMixerChannels = engine.mixerChannels;
    const previousAdapter = engine.mixerRoutingAdapter;
    const ctx = new FakeContext();
    engine.ctx = ctx;
    engine.masterGain = new FakeNode();
    engine.mixerChannels = new Map();
    engine.mixerRoutingAdapter = null;

    try {
      const target = engine.getOrCreateMixerChannel(2);
      engine.getOrCreateMixerChannel(0);
      engine.updateMixerTrack(makeTrack(2, 0));
      engine.updateMixerTrack(makeTrack(2, 0));
      engine.updateMixerTrack({ ...makeTrack(2, 0), mute: true });
      assert.equal(target.output.gain.value, 0);
      engine.updateMixerTrack({ ...makeTrack(2, 0), mute: false });
      assert.equal(target.output.gain.value, 1);
    } finally {
      engine.ctx = previousCtx;
      engine.masterGain = previousMasterGain;
      engine.mixerChannels = previousMixerChannels;
      engine.mixerRoutingAdapter = previousAdapter;
    }
  });

  it('export and stem entrypoints retain the routing state they pass to the shared offline renderer', async () => {
    const engine = audioEngine as any;
    const original = engine.renderTimelineOffline;
    const calls: MixerTrack[][] = [];
    engine.renderTimelineOffline = async (...args: any[]) => {
      calls.push(args[2]);
      return {
        numberOfChannels: 2,
        length: 1,
        sampleRate: 44100,
        duration: 1,
        getChannelData: () => new Float32Array(1),
      };
    };

    const tracks = [makeTrack(0), makeTrack(1, 2), makeTrack(2, 0)];
    try {
      await engine.renderProjectToWav([], [], 120, 1, 16, tracks);
      await engine.renderProjectStems([], [], tracks, 120, 1, 16, 'song', undefined, undefined, false);
      assert.equal(calls.length >= 2, true);
      assert.deepEqual(calls[0].map((t: MixerTrack) => t.routingTargetId), [undefined, 2, 0]);
      assert.deepEqual(calls[1].map((t: MixerTrack) => t.routingTargetId), [undefined, 2, 0]);
    } finally {
      engine.renderTimelineOffline = original;
    }
  });
});

