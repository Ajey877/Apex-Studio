import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MasterBus } from './masterBus';

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
}

class FakeNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
  disconnect(): void { this.connections.length = 0; }
}

class FakeAnalyser extends FakeNode {
  fftSize = 32;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(target: Float32Array): void { target.fill(0); }
}

function fakeContext(): AudioContext {
  return {
    currentTime: 2,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createAnalyser: () => new FakeAnalyser(),
  } as unknown as AudioContext;
}

function connections(node: AudioNode): unknown[] {
  return (node as unknown as FakeNode).connections;
}

describe('MasterBus', () => {
  it('builds one deterministic final gain and meter path', () => {
    const bus = new MasterBus(fakeContext());
    assert.equal(connections(bus.input)[0], bus.gain);
    assert.equal(connections(bus.gain)[0], bus.meter);
    assert.equal(connections(bus.meter)[0], bus.output);
  });

  it('applies clamped master gain in linear units', () => {
    const bus = new MasterBus(fakeContext());
    bus.setGainDb(-6);
    assert.equal((bus.gain.gain as unknown as FakeParam).value.toFixed(3), '0.501');
    bus.setGainDb(999);
    assert.equal((bus.gain.gain as unknown as FakeParam).value.toFixed(3), '3.981');
    bus.setGainDb(-999);
    assert.equal((bus.gain.gain as unknown as FakeParam).value, 0);
  });

  it('reports deterministic silent master levels', () => {
    const bus = new MasterBus(fakeContext());
    assert.deepEqual(bus.getMeterLevels(), { peak: 0, rms: 0 });
  });

  it('connects only its final output to the destination', () => {
    const bus = new MasterBus(fakeContext());
    const destination = new FakeNode();
    bus.connectDestination(destination as unknown as AudioNode);
    assert.deepEqual(connections(bus.output), [destination]);
  });
});
