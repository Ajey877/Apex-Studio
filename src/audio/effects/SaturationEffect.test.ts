import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SaturationEffect } from './SaturationEffect';

type FakeParam = { value: number; calls: Array<[number, number]>; setValueAtTime(value: number, time: number): void };
type FakeNode = { connections: unknown[]; connect(target: unknown): void; disconnect(): void };

function param(initial = 0): FakeParam {
  return {
    value: initial,
    calls: [],
    setValueAtTime(value, time) {
      this.value = value;
      this.calls.push([value, time]);
    },
  };
}

function node(): FakeNode {
  return {
    connections: [],
    connect(target) { this.connections.push(target); },
    disconnect() { this.connections.length = 0; },
  };
}

function context(): AudioContext {
  const makeGain = () => ({ ...node(), gain: param(1) });
  const makeShaper = () => ({ ...node(), curve: null, oversample: 'none' });
  return {
    currentTime: 10,
    createGain: makeGain,
    createWaveShaper: makeShaper,
  } as unknown as AudioContext;
}

describe('SaturationEffect', () => {
  it('constructs a soft-clipping dry/wet processor', () => {
    const effect = new SaturationEffect(context());
    assert.equal(effect.name, 'Saturation');
    assert.equal(effect.id, 'saturation');
    const input = effect.input as unknown as FakeNode;
    assert.equal(input.connections.length, 2);
  });

  it('validates and schedules drive and mix', () => {
    const effect = new SaturationEffect(context(), 'sat', 0.2, 0.5);
    assert.doesNotThrow(() => effect.setParameter('drive', 0.8, 20));
    assert.doesNotThrow(() => effect.setParameter('mix', 0.75, 20));
    assert.throws(() => effect.setParameter('drive', -0.01, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('drive', 1.01, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('mix', -0.01, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('mix', 1.01, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('unknown', 1, 20), /Unknown Saturation/);
  });

  it('rejects non-finite values and prevents use after disposal', () => {
    const effect = new SaturationEffect(context());
    assert.throws(() => effect.setParameter('drive', Number.NaN, 0), /must be finite/);
    assert.throws(() => effect.setParameter('mix', 0.2, Number.POSITIVE_INFINITY), /time must be finite/);
    effect.dispose();
    assert.doesNotThrow(() => effect.dispose());
    assert.throws(() => effect.setParameter('mix', 0.2, 0), /disposed/);
  });
});
