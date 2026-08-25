import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChorusEffect } from './effects/ChorusEffect';

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
  const makeDelay = () => ({ ...node(), delayTime: param() });
  const makeOscillator = () => ({ ...node(), frequency: param(), start() {}, stop() {} });
  const makeConstant = () => ({ ...node(), offset: param(), start() {}, stop() {} });
  return {
    currentTime: 10,
    createGain: makeGain,
    createDelay: makeDelay,
    createOscillator: makeOscillator,
    createConstantSource: makeConstant,
  } as unknown as AudioContext;
}

describe('ChorusEffect', () => {
  it('constructs a modulated delay and applies defaults', () => {
    const effect = new ChorusEffect(context());
    assert.equal(effect.name, 'Chorus');
    assert.equal(effect.id, 'chorus');
    const input = effect.input as unknown as FakeNode;
    const output = effect.output as unknown as FakeNode;
    assert.equal(input.connections.length, 2);
    assert.equal(output.connections.length, 0);
  });

  it('validates and schedules all parameters', () => {
    const effect = new ChorusEffect(context(), 'c', 1, 0.002, 0.02, 0.2);
    assert.doesNotThrow(() => effect.setParameter('rate', 5, 20));
    assert.doesNotThrow(() => effect.setParameter('depth', 0.01, 20));
    assert.doesNotThrow(() => effect.setParameter('delay', 0.04, 20));
    assert.doesNotThrow(() => effect.setParameter('mix', 0.75, 20));
    assert.throws(() => effect.setParameter('rate', 0, 20), /between 0.05 and 20/);
    assert.throws(() => effect.setParameter('depth', 0.021, 20), /between 0 and 0.02/);
    assert.throws(() => effect.setParameter('depth', 0.05, 20), /cannot exceed the base delay/);
    assert.throws(() => effect.setParameter('delay', 0.081, 20), /between 0.005 and 0.08/);
    assert.throws(() => effect.setParameter('delay', 0.005, 20), /cannot be smaller than the modulation depth/);
    assert.throws(() => effect.setParameter('mix', 1.1, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('unknown', 1, 20), /Unknown Chorus/);
  });

  it('rejects unsafe constructor modulation combinations', () => {
    assert.throws(() => new ChorusEffect(context(), 'unsafe', 1, 0.02, 0.005), /cannot exceed the base delay/);
  });

  it('rejects non-finite values and prevents use after disposal', () => {
    const effect = new ChorusEffect(context());
    assert.throws(() => effect.setParameter('mix', Number.NaN, 0), /must be finite/);
    assert.throws(() => effect.setParameter('mix', 0.2, Number.POSITIVE_INFINITY), /time must be finite/);
    effect.dispose();
    assert.doesNotThrow(() => effect.dispose());
    assert.throws(() => effect.setParameter('mix', 0.2, 0), /disposed/);
  });
});
