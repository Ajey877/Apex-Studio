import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AudioEffect } from './AudioEffect';
import { EffectRack } from './effectRack';

type FakeNode = {
  connections: unknown[];
  connect(target: unknown): void;
  disconnect(): void;
};

function createNode(): FakeNode {
  return {
    connections: [],
    connect(target: unknown) {
      this.connections.push(target);
    },
    disconnect() {
      this.connections.length = 0;
    },
  };
}

function createContext(): AudioContext {
  return {
    createGain: createNode,
  } as unknown as AudioContext;
}

function createEffect(id: string, disposed: string[]): AudioEffect {
  return {
    id,
    name: id,
    input: createNode() as unknown as AudioNode,
    output: createNode() as unknown as AudioNode,
    setParameter() {},
    dispose() {
      disposed.push(id);
    },
  };
}

describe('EffectRack', () => {
  it('builds a deterministic serial effect chain', () => {
    const disposed: string[] = [];
    const rack = new EffectRack(createContext());
    const first = createEffect('first', disposed);
    const second = createEffect('second', disposed);

    rack.add(first);
    rack.add(second);

    const slots = rack.getSlots();
    assert.deepEqual(slots.map((slot) => slot.id), ['first', 'second']);
    assert.equal(slots.every((slot) => !slot.bypassed), true);
    assert.equal((first.input as unknown as FakeNode).connections.length, 1);
    assert.equal((second.input as unknown as FakeNode).connections.length, 1);
  });

  it('bypasses and restores a slot without disposing it', () => {
    const disposed: string[] = [];
    const rack = new EffectRack(createContext());
    const first = createEffect('first', disposed);
    rack.add(first);

    rack.setBypassed('first', true);
    assert.equal(rack.getSlots()[0]?.bypassed, true);
    assert.equal((first.input as unknown as FakeNode).connections.length, 0);
    assert.deepEqual(disposed, []);

    rack.setBypassed('first', false);
    assert.equal(rack.getSlots()[0]?.bypassed, false);
    assert.equal((first.input as unknown as FakeNode).connections.length, 1);
  });

  it('supports deterministic ordering and rejects duplicate or invalid slots', () => {
    const disposed: string[] = [];
    const rack = new EffectRack(createContext());
    const first = createEffect('first', disposed);
    const second = createEffect('second', disposed);

    rack.add(first);
    assert.throws(() => rack.add(first), /already exists/);
    assert.throws(() => rack.move('first', 1.5), /must be an integer/);
    assert.throws(() => rack.move('missing', 0), /Unknown effect slot/);

    rack.add(second);
    rack.move('second', 0);
    assert.deepEqual(rack.getSlots().map((slot) => slot.id), ['second', 'first']);
  });

  it('disposes removed and remaining effects exactly once', () => {
    const disposed: string[] = [];
    const rack = new EffectRack(createContext());
    const first = createEffect('first', disposed);
    const second = createEffect('second', disposed);

    rack.add(first);
    rack.add(second);
    rack.remove('first');
    assert.deepEqual(disposed, ['first']);

    rack.dispose();
    assert.deepEqual(disposed, ['first', 'second']);
    assert.deepEqual(rack.getSlots(), []);
  });
});
