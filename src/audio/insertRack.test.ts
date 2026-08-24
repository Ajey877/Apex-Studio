import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelInsertRack } from './insertRack';

class FakeNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
  disconnect(): void { this.connections.length = 0; }
}

function fakeContext(): AudioContext {
  return {
    createGain: () => new FakeNode(),
  } as unknown as AudioContext;
}

function connections(node: AudioNode): unknown[] {
  return (node as unknown as FakeNode).connections;
}

describe('ChannelInsertRack', () => {
  it('passes directly through when no inserts are active', () => {
    const rack = new ChannelInsertRack(fakeContext());
    assert.equal(connections(rack.input)[0], rack.output);
  });

  it('builds inserts in order', () => {
    const rack = new ChannelInsertRack(fakeContext());
    const first = new FakeNode() as unknown as AudioNode;
    const second = new FakeNode() as unknown as AudioNode;

    rack.add('eq', first);
    rack.add('compressor', second);

    assert.equal(connections(rack.input)[0], first);
    assert.equal(connections(first)[0], second);
    assert.equal(connections(second)[0], rack.output);
  });

  it('bypasses an insert without changing the surrounding chain', () => {
    const rack = new ChannelInsertRack(fakeContext());
    const first = new FakeNode() as unknown as AudioNode;
    const second = new FakeNode() as unknown as AudioNode;
    rack.add('eq', first);
    rack.add('compressor', second);

    rack.setBypassed('eq', true);

    assert.equal(connections(rack.input)[0], second);
    assert.equal(connections(second)[0], rack.output);
    assert.equal(connections(first).length, 0);
  });

  it('moves inserts deterministically', () => {
    const rack = new ChannelInsertRack(fakeContext());
    const first = new FakeNode() as unknown as AudioNode;
    const second = new FakeNode() as unknown as AudioNode;
    rack.add('eq', first);
    rack.add('compressor', second);

    rack.move('compressor', 0);

    assert.deepEqual(rack.getSlots().map((slot) => slot.id), ['compressor', 'eq']);
    assert.equal(connections(rack.input)[0], second);
    assert.equal(connections(second)[0], first);
    assert.equal(connections(first)[0], rack.output);
  });

  it('rejects duplicate ids and unknown operations', () => {
    const rack = new ChannelInsertRack(fakeContext());
    const node = new FakeNode() as unknown as AudioNode;
    rack.add('eq', node);
    assert.throws(() => rack.add('eq', new FakeNode() as unknown as AudioNode));
    assert.throws(() => rack.setBypassed('missing', true));
    assert.throws(() => rack.remove('missing'));
  });

  it('disposes every owned insert connection', () => {
    const rack = new ChannelInsertRack(fakeContext());
    const node = new FakeNode() as unknown as AudioNode;
    rack.add('eq', node);

    rack.dispose();

    assert.equal(connections(rack.input).length, 0);
    assert.equal(connections(node).length, 0);
    assert.equal(rack.getSlots().length, 0);
  });
});
