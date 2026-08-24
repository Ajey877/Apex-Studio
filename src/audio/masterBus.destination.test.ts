import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MasterBus } from './masterBus';

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
}

class FakeNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): void {
    if (!this.connections.includes(target)) this.connections.push(target);
  }
  disconnect(target?: unknown): void {
    if (target === undefined) this.connections.length = 0;
    else this.connections.splice(this.connections.indexOf(target), 1);
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 32;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(target: Float32Array): void { target.fill(0); }
}

function fakeContext(): AudioContext {
  return {
    currentTime: 0,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createAnalyser: () => new FakeAnalyser(),
  } as unknown as AudioContext;
}

function connections(node: AudioNode): unknown[] {
  return (node as unknown as FakeNode).connections;
}

describe('MasterBus destination lifecycle', () => {
  it('connects the initial destination exactly once', () => {
    const bus = new MasterBus(fakeContext());
    const destination = new FakeNode();
    bus.connectDestination(destination as unknown as AudioNode);
    assert.deepEqual(connections(bus.output), [destination]);
  });

  it('replaces the previous destination without leaving a stale output', () => {
    const bus = new MasterBus(fakeContext());
    const first = new FakeNode();
    const second = new FakeNode();
    bus.connectDestination(first as unknown as AudioNode);
    bus.connectDestination(second as unknown as AudioNode);
    assert.deepEqual(connections(bus.output), [second]);
  });

  it('does not duplicate the same destination', () => {
    const bus = new MasterBus(fakeContext());
    const destination = new FakeNode();
    bus.connectDestination(destination as unknown as AudioNode);
    bus.connectDestination(destination as unknown as AudioNode);
    assert.deepEqual(connections(bus.output), [destination]);
  });

  it('fully disconnects the active destination during disposal', () => {
    const bus = new MasterBus(fakeContext());
    const destination = new FakeNode();
    bus.connectDestination(destination as unknown as AudioNode);
    bus.dispose();
    assert.deepEqual(connections(bus.output), []);
  });
});
