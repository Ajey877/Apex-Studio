import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BiquadFilterEffect } from './BiquadFilterEffect';

type Calls = { value: number; time: number }[];

function createContext(): { context: AudioContext; calls: Calls; node: BiquadFilterNode } {
  const calls: Calls = [];
  const parameter = { setValueAtTime(value: number, time: number) { calls.push({ value, time }); } } as unknown as AudioParam;
  const node = {
    type: 'lowpass',
    frequency: parameter,
    Q: parameter,
    gain: parameter,
    disconnect() {},
  } as unknown as BiquadFilterNode;
  const context = { currentTime: 10, sampleRate: 48000, createBiquadFilter: () => node } as unknown as AudioContext;
  return { context, calls, node };
}

describe('BiquadFilterEffect', () => {
  it('initializes and schedules frequency, Q and gain deterministically', () => {
    const { context, calls } = createContext();
    const effect = new BiquadFilterEffect(context, 'eq', 'highpass', 2000, 0.7, 3);
    assert.equal(effect.id, 'eq');
    assert.equal(effect.name, 'Biquad Filter');
    assert.equal(effect.input, effect.output);
    assert.deepEqual(calls, [
      { value: 2000, time: 10 },
      { value: 0.7, time: 10 },
      { value: 3, time: 10 },
    ]);
  });

  it('rejects non-finite and out-of-range parameters', () => {
    const { context } = createContext();
    const effect = new BiquadFilterEffect(context);
    assert.throws(() => effect.setParameter('frequency', 0, 0), /between 10 Hz/);
    assert.throws(() => effect.setParameter('frequency', 24001, 0), /Nyquist/);
    assert.throws(() => effect.setParameter('q', 0, 0), /Q/);
    assert.throws(() => effect.setParameter('gain', 41, 0), /gain/);
    assert.throws(() => effect.setParameter('frequency', Number.NaN, 0), /finite/);
    assert.throws(() => effect.setParameter('mix', 1, 0), /Unknown Biquad/);
    assert.throws(() => effect.setParameter('frequency', 1000, Number.POSITIVE_INFINITY), /time must be finite/);
  });

  it('changes filter type and disposes safely', () => {
    const { context, node } = createContext();
    const effect = new BiquadFilterEffect(context);
    effect.setType('peaking');
    assert.equal(node.type, 'peaking');
    assert.doesNotThrow(() => effect.dispose());
  });
});
