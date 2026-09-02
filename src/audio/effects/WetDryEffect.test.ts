import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AudioEffect } from './AudioEffect';
import { WetDryEffect } from './WetDryEffect';

type FakeParam = {
  value: number;
  setValueAtTime(value: number, _time: number): void;
};

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

function createGain(): FakeNode & { gain: FakeParam } {
  return Object.assign(createNode(), {
    gain: {
      value: 1,
      setValueAtTime(value: number, _time: number) {
        this.value = value;
      },
    },
  });
}

function createContext(): AudioContext {
  return {
    currentTime: 0,
    createGain,
  } as unknown as AudioContext;
}

function createEffect(disposed: string[]): AudioEffect {
  return {
    id: 'test-effect',
    name: 'Test Effect',
    input: createNode() as unknown as AudioNode,
    output: createNode() as unknown as AudioNode,
    setParameter(name, value) {
      if (!Number.isFinite(value)) throw new Error(`bad ${name}`);
    },
    dispose() {
      disposed.push('test-effect');
    },
  };
}

describe('WetDryEffect', () => {
  it('creates parallel dry and wet paths', () => {
    const effect = createEffect([]);
    const wrapper = new WetDryEffect(createContext(), effect, 0.25);
    const input = wrapper.input as unknown as FakeNode;
    const dry = (wrapper as unknown as { dry: FakeNode }).dry;
    const wet = (wrapper as unknown as { wet: FakeNode }).wet;

    assert.equal(input.connections.length, 2);
    assert.equal(dry.connections.length, 1);
    assert.equal(wet.connections.length, 1);
  });

  it('sets dry and wet gains as complementary values', () => {
    const wrapper = new WetDryEffect(createContext(), createEffect([]), 0.25);
    const dry = (wrapper as unknown as { dry: FakeNode & { gain: FakeParam } }).dry;
    const wet = (wrapper as unknown as { wet: FakeNode & { gain: FakeParam } }).wet;

    assert.equal(dry.gain.value, 0.75);
    assert.equal(wet.gain.value, 0.25);

    wrapper.setParameter('mix', 1, 0);
    assert.equal(dry.gain.value, 0);
    assert.equal(wet.gain.value, 1);
  });

  it('validates mix and forwards non-mix parameters', () => {
    const forwarded: Array<[string, number]> = [];
    const effect = createEffect([]);
    effect.setParameter = (name, value) => forwarded.push([name, value]);
    const wrapper = new WetDryEffect(createContext(), effect, 0.5);

    assert.throws(() => wrapper.setParameter('mix', -0.01, 0), /between 0 and 1/);
    assert.throws(() => wrapper.setParameter('mix', 1.01, 0), /between 0 and 1/);
    assert.throws(() => wrapper.setParameter('mix', Number.NaN, 0), /must be finite/);

    wrapper.setParameter('drive', 0.6, 0.5);
    assert.deepEqual(forwarded, [['drive', 0.6]]);
  });

  it('disposes the wrapper and wrapped effect exactly once', () => {
    const disposed: string[] = [];
    const wrapper = new WetDryEffect(createContext(), createEffect(disposed));

    wrapper.dispose();
    wrapper.dispose();

    assert.deepEqual(disposed, ['test-effect']);
    assert.throws(() => wrapper.setParameter('mix', 0.5, 0), /disposed/);
  });
});
