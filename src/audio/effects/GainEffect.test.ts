import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GainEffect } from './GainEffect';

type GainCall = { value: number; time: number };

function createContext(): { context: AudioContext; calls: GainCall[] } {
  const calls: GainCall[] = [];
  const disconnect = () => undefined;
  const connect = () => undefined;
  const gainParam = {
    setValueAtTime(value: number, time: number) {
      calls.push({ value, time });
    },
  } as unknown as AudioParam;

  const createGain = () => ({
    connect,
    disconnect,
    gain: gainParam,
  }) as unknown as GainNode;

  return {
    context: {
      currentTime: 10,
      createGain,
    } as unknown as AudioContext,
    calls,
  };
}

describe('GainEffect', () => {
  it('creates a connected gain processor and schedules gain changes', () => {
    const { context, calls } = createContext();
    const effect = new GainEffect(context, 'track-gain', 0.5);

    assert.equal(effect.id, 'track-gain');
    assert.equal(effect.name, 'Gain');
    assert.deepEqual(calls, [{ value: 0.5, time: 10 }]);

    effect.setParameter('gain', 1.25, 12.5);
    assert.deepEqual(calls, [
      { value: 0.5, time: 10 },
      { value: 1.25, time: 12.5 },
    ]);
  });

  it('rejects unknown, non-finite, and out-of-range values', () => {
    const { context } = createContext();
    const effect = new GainEffect(context);

    assert.throws(() => effect.setParameter('mix', 1, 0), /Unknown Gain/);
    assert.throws(() => effect.setParameter('gain', Number.NaN, 0), /finite/);
    assert.throws(() => effect.setParameter('gain', -0.1, 0), /between 0 and 4/);
    assert.throws(() => effect.setParameter('gain', 4.1, 0), /between 0 and 4/);
    assert.throws(() => effect.setParameter('gain', 1, Number.POSITIVE_INFINITY), /time must be finite/);
  });

  it('disposes its owned nodes safely', () => {
    const { context } = createContext();
    const effect = new GainEffect(context);
    assert.doesNotThrow(() => effect.dispose());
  });
});
