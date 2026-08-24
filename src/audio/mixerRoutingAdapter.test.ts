import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerRoutingAdapter, MixerAudioNodePair } from './mixerRoutingAdapter';

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCount = 0;
  failNextConnect = false;

  connect(target: FakeAudioNode): void {
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error('simulated AudioNode connection failure');
    }
    this.connections.push(target);
  }

  disconnect(): void {
    this.connections.length = 0;
    this.disconnectCount += 1;
  }
}

function createNodes(count = 3): { pairs: Map<number, MixerAudioNodePair>; nodes: FakeAudioNode[] } {
  const nodes = Array.from({ length: count * 2 }, () => new FakeAudioNode());
  const pairs = new Map<number, MixerAudioNodePair>();
  for (let i = 0; i < count; i += 1) {
    pairs.set(i, {
      input: nodes[i * 2] as unknown as AudioNode,
      output: nodes[i * 2 + 1] as unknown as AudioNode,
    });
  }
  return { pairs, nodes };
}

describe('MixerRoutingAdapter', () => {
  it('routes a track directly to master', () => {
    const { pairs } = createNodes();
    const adapter = new MixerRoutingAdapter(pairs);
    assert.deepEqual(adapter.setRoute(1, 0), { valid: true });
    const source = pairs.get(1)!.output as unknown as FakeAudioNode;
    const master = pairs.get(0)!.input as unknown as FakeAudioNode;
    assert.equal(source.connections.length, 1);
    assert.equal(source.connections[0], master);
  });

  it('supports a bus chain and removes stale connections', () => {
    const { pairs } = createNodes();
    const adapter = new MixerRoutingAdapter(pairs);
    adapter.setRoute(1, 2);
    adapter.setRoute(2, 0);

    const track = pairs.get(1)!.output as unknown as FakeAudioNode;
    const bus = pairs.get(2)!.input as unknown as FakeAudioNode;
    assert.deepEqual(track.connections, [bus]);

    adapter.setRoute(1, 0);
    const master = pairs.get(0)!.input as unknown as FakeAudioNode;
    assert.deepEqual(track.connections, [master]);
  });

  it('rejects unknown tracks without changing the live graph', () => {
    const { pairs } = createNodes();
    const adapter = new MixerRoutingAdapter(pairs);
    adapter.setRoute(1, 0);
    const result = adapter.setRoute(1, 99);
    assert.equal(result.valid, false);
    assert.equal(adapter.getRoute(1), 0);
  });

  it('restores the previous route when an AudioNode connection fails', () => {
    const { pairs } = createNodes();
    const adapter = new MixerRoutingAdapter(pairs);
    adapter.setRoute(1, 0);

    const source = pairs.get(1)!.output as unknown as FakeAudioNode;
    source.failNextConnect = true;

    assert.throws(() => adapter.setRoute(1, 2), /simulated AudioNode connection failure/);
    assert.equal(adapter.getRoute(1), 0);
    const master = pairs.get(0)!.input as unknown as FakeAudioNode;
    assert.deepEqual(source.connections, [master]);
  });
});
