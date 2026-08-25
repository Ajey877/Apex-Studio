import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DelayEffect } from './DelayEffect';

type Param = { values: Array<{ value: number; time: number }>; setValueAtTime(value: number, time: number): void };
type Node = { connections: unknown[]; connect(target: unknown): void; disconnect(): void };

function node(): Node {
  return {
    connections: [],
    connect(target: unknown) { this.connections.push(target); },
    disconnect() { this.connections.length = 0; },
  };
}

function param(): Param {
  return {
    values: [],
    setValueAtTime(value: number, time: number) { this.values.push({ value, time }); },
  };
}

function createContext(): AudioContext {
  return {
    currentTime: 3,
    createGain: node,
    createDelay: () => ({ ...node(), delayTime: param() }),
  } as unknown as AudioContext;
}

describe('DelayEffect', () => {
  it('creates dry, wet, and bounded feedback routing', () => {
    const effect = new DelayEffect(createContext(), 'delay-test', 0.5, 0.4, 0.25);
    assert.equal((effect.input as unknown as Node).connections.length, 2);
    assert.equal((effect.output as unknown as Node).connections.length, 0);
  });

  it('schedules delay, feedback, and complementary dry/wet mix deterministically', () => {
    const context = createContext();
    const effect = new DelayEffect(context, 'delay-test', 0.25, 0.2, 0.5);
    effect.setParameter('delayTime', 0.75, 8);
    effect.setParameter('feedback', 0.6, 9);
    effect.setParameter('mix', 0.8, 10);

    const delayNode = effect as unknown as { delay: { delayTime: Param }; feedback: { gain: Param }; dry: { gain: Param }; wet: { gain: Param } };
    assert.deepEqual(delayNode.delay.delayTime.values.at(-1), { value: 0.75, time: 8 });
    assert.deepEqual(delayNode.feedback.gain.values.at(-1), { value: 0.6, time: 9 });
    assert.deepEqual(delayNode.dry.gain.values.at(-1), { value: 0.2, time: 10 });
    assert.deepEqual(delayNode.wet.gain.values.at(-1), { value: 0.8, time: 10 });
  });

  it('rejects unsafe parameters and rejects scheduling after disposal', () => {
    const effect = new DelayEffect(createContext());
    assert.throws(() => effect.setParameter('feedback', 0.99, 1), /less than 0.99/);
    assert.throws(() => effect.setParameter('feedback', -0.1, 1), /between 0/);
    assert.throws(() => effect.setParameter('mix', 1.1, 1), /between 0 and 1/);
    assert.throws(() => effect.setParameter('delayTime', 11, 1), /between 0 and 10/);
    assert.throws(() => effect.setParameter('delayTime', Number.NaN, 1), /must be finite/);
    assert.throws(() => effect.setParameter('delayTime', 1, Number.NaN), /time must be finite/);

    effect.dispose();
    effect.dispose();
    assert.throws(() => effect.setParameter('mix', 0.5, 1), /disposed/);
  });
});
