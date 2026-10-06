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
    assert.throws(() => effect.setParameter('mix', 1.1, 20), /between 0 and 1/);
    assert.throws(() => effect.setParameter('unknown', 1, 20), /Unknown Chorus/);

    const depthGuard = new ChorusEffect(context(), 'depth-guard', 1, 0.002, 0.01, 0.2);
    assert.throws(() => depthGuard.setParameter('depth', 0.015, 20), /cannot exceed the base delay/);

    const delayGuard = new ChorusEffect(context(), 'delay-guard', 1, 0.01, 0.02, 0.2);
    assert.throws(() => delayGuard.setParameter('delay', 0.005, 20), /cannot be smaller than the modulation depth/);
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

  it('falls back to delayTime when ConstantSource is unavailable (offline)', () => {
    // This test does not claim acoustic equivalence; it only verifies that
    // the constructor does not throw and that the delay automation is routed
    // to the available AudioParam so an offline export does not crash.
    const delayParam = param();
    const delayNode = { ...node(), delayTime: delayParam };
    let delayConnects = 0;
    const originalConnect = delayNode.connect.bind(delayNode);
    // Count connections into delayTime is not directly observable in this mock,
    // but we can verify construction succeeds and dispose remains safe.

    function contextWithoutConstantSource(): AudioContext {
      const makeGain = () => ({ ...node(), gain: param(1) }) as unknown as GainNode;
      const makeDelay = () => delayNode as unknown as DelayNode;
      const makeOscillator = () => ({ ...node(), frequency: param(), start() {}, stop() {} }) as unknown as OscillatorNode;
      return {
        currentTime: 11,
        createGain: makeGain,
        createDelay: makeDelay,
        createOscillator: makeOscillator,
      } as unknown as AudioContext;
    }

    const ctx = contextWithoutConstantSource();
    let effect: ChorusEffect | undefined;
    assert.doesNotThrow(() => {
      effect = new ChorusEffect(ctx, 'fallback', 1.2, 0.003, 0.02, 0.25);
    });
    assert.ok(effect, 'effect must be constructed without ConstantSource');
    // After construction the fallback path should have scheduled the base delay
    // on delay.delayTime (since no offset node exists).
    assert.ok(delayParam.calls.some(([v]) => v === 0.02), 'fallback base delay scheduled on delayTime');

    // Clear and verify live automation routes to delayTime when offset is absent.
    delayParam.calls.length = 0;
    assert.doesNotThrow(() => effect!.setParameter('delay', 0.03, 15));
    assert.ok(
      delayParam.calls.some(([v, t]) => v === 0.03 && t === 15),
      'fallback delay update must route to delayTime',
    );

    // Other parameters must remain live-updatable without ConstantSource.
    assert.doesNotThrow(() => effect!.setParameter('rate', 2, 15));
    assert.doesNotThrow(() => effect!.setParameter('depth', 0.005, 15));
    assert.doesNotThrow(() => effect!.setParameter('mix', 0.5, 15));

    // Dispose must handle the absent ConstantSource and remain idempotent.
    assert.doesNotThrow(() => effect!.dispose());
    assert.doesNotThrow(() => effect!.dispose());
    assert.throws(() => effect!.setParameter('mix', 0.2, 20), /disposed/);

    void delayConnects;
    void originalConnect;
  });
});
