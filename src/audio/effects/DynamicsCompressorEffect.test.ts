import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DynamicsCompressorEffect } from './DynamicsCompressorEffect';

function parameter(initial = 0) {
  return {
    value: initial,
    calls: [] as Array<[number, number]>,
    setValueAtTime(value: number, time: number) {
      this.value = value;
      this.calls.push([value, time]);
    },
  };
}

type FakeCompressor = ReturnType<typeof createFakeCompressor>;

function createFakeCompressor() {
  return {
    threshold: parameter(-24),
    knee: parameter(30),
    ratio: parameter(12),
    attack: parameter(0.003),
    release: parameter(0.25),
    reduction: 0,
    connect() {},
    disconnect() {},
  };
}

function createContext(fakeNode: FakeCompressor = createFakeCompressor()): AudioContext {
  return {
    currentTime: 12.5,
    createDynamicsCompressor: () => fakeNode,
  } as unknown as AudioContext;
}

describe('DynamicsCompressorEffect', () => {
  it('initializes and schedules all compressor parameters deterministically', () => {
    const node = createFakeCompressor();
    const effect = new DynamicsCompressorEffect(createContext(node), 'comp', -18, 20, 4, 0.01, 0.2);

    assert.equal(node.threshold.value, -18);
    assert.equal(node.knee.value, 20);
    assert.equal(node.ratio.value, 4);
    assert.equal(node.attack.value, 0.01);
    assert.equal(node.release.value, 0.2);
    assert.deepEqual(node.threshold.calls, [[-18, 12.5]]);
    assert.equal(effect.id, 'comp');
  });

  it('validates parameter ranges and unknown parameters', () => {
    const effect = new DynamicsCompressorEffect(createContext());
    assert.throws(() => effect.setParameter('threshold', -101, 1), RangeError);
    assert.throws(() => effect.setParameter('knee', 41, 1), RangeError);
    assert.throws(() => effect.setParameter('ratio', 0.9, 1), RangeError);
    assert.throws(() => effect.setParameter('attack', -0.01, 1), RangeError);
    assert.throws(() => effect.setParameter('release', 1.01, 1), RangeError);
    assert.throws(() => effect.setParameter('attack', Number.NaN, 1), /must be finite/);
    assert.throws(() => effect.setParameter('release', 0.2, Number.NaN), /time must be finite/);
    assert.throws(() => effect.setParameter('unknown', 1, 1), /Unknown Dynamics Compressor/);
  });

  it('exposes reduction and safely disposes the processor', () => {
    const node = createFakeCompressor();
    const effect = new DynamicsCompressorEffect(createContext(node));
    assert.equal(effect.reduction, 0);
    assert.doesNotThrow(() => effect.dispose());
  });
});
