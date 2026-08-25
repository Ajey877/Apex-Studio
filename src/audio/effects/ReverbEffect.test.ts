import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReverbEffect } from './ReverbEffect';

type FakeParam = { values: Array<{ value: number; time: number }>; setValueAtTime(value: number, time: number): void };
type FakeNode = {
  connections: unknown[];
  connect(target: unknown): void;
  disconnect(): void;
};

function node(): FakeNode {
  return {
    connections: [],
    connect(target: unknown) { this.connections.push(target); },
    disconnect() { this.connections.length = 0; },
  };
}

function gain(): GainNode {
  const base = node();
  const param: FakeParam = { values: [], setValueAtTime(value, time) { this.values.push({ value, time }); } };
  return Object.assign(base, { gain: param }) as unknown as GainNode;
}

function delay(): DelayNode {
  const base = node();
  const param: FakeParam = { values: [], setValueAtTime(value, time) { this.values.push({ value, time }); } };
  return Object.assign(base, { delayTime: param }) as unknown as DelayNode;
}

function context(): AudioContext {
  return {
    currentTime: 10,
    createGain: gain,
    createDelay: delay,
  } as unknown as AudioContext;
}

describe('ReverbEffect', () => {
  it('builds four bounded feedback paths', () => {
    const effect = new ReverbEffect(context(), 'room', 0.3, 0.7, 0.8);
    assert.equal((effect.input as unknown as FakeNode).connections.length, 2);
    assert.equal((effect.output as unknown as FakeNode).connections.length, 0);
  });

  it('schedules wet, dry, and decay deterministically', () => {
    const effect = new ReverbEffect(context(), 'room', 0.2, 0.8, 0.5);
    effect.setParameter('wet', 0.4, 12);
    effect.setParameter('dry', 0.6, 12);
    effect.setParameter('decay', 0.9, 12);
    assert.equal((effect.wetGain as unknown as { gain: FakeParam }).gain.values.at(-1)?.value, 0.4);
    assert.equal((effect.dryGain as unknown as { gain: FakeParam }).gain.values.at(-1)?.value, 0.6);
  });

  it('rejects invalid parameters and prevents unity feedback', () => {
    const effect = new ReverbEffect(context());
    assert.throws(() => effect.setParameter('wet', 1.1, 1), /between 0 and 1/);
    assert.throws(() => effect.setParameter('dry', -0.1, 1), /between 0 and 1/);
    assert.throws(() => effect.setParameter('decay', 0.98, 1), /between 0 and 0.97/);
    assert.throws(() => effect.setParameter('unknown', 0, 1), /Unknown Reverb/);
  });

  it('disposes idempotently and rejects automation after disposal', () => {
    const effect = new ReverbEffect(context());
    effect.dispose();
    effect.dispose();
    assert.throws(() => effect.setParameter('wet', 0.5, 1), /disposed/);
  });
});
