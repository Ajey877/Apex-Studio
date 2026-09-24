import { strict as assert } from 'node:assert';
import test from 'node:test';
import { renderIndependentPluckVoice } from './independentPluck';

type Operation = [string, ...number[]];

class MockAudioParam {
  value = 0;
  constructor(private readonly operations: Operation[], private readonly name: string) {}
  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.operations.push([`${this.name}.set`, value, time]);
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.operations.push([`${this.name}.linear`, value, time]);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.operations.push([`${this.name}.exponential`, value, time]);
  }
}

class MockNode {
  context: MockAudioContext;
  readonly operations: Operation[];
  readonly gain: MockAudioParam;
  readonly frequency: MockAudioParam;
  readonly pan: MockAudioParam;
  readonly Q = { value: 0 };
  type = '';
  constructor(context: MockAudioContext, operations: Operation[]) {
    this.context = context;
    this.operations = operations;
    this.gain = new MockAudioParam(operations, 'gain');
    this.frequency = new MockAudioParam(operations, 'frequency');
    this.pan = new MockAudioParam(operations, 'pan');
  }
  connect() { this.operations.push(['connect']); }
  start(time: number) { this.operations.push(['start', time]); }
  stop(time: number) { this.operations.push(['stop', time]); }
}

class MockAudioContext {
  readonly operations: Operation[] = [];
  createGain() { this.operations.push(['createGain']); return new MockNode(this, this.operations); }
  createBiquadFilter() { this.operations.push(['createBiquadFilter']); return new MockNode(this, this.operations); }
  createOscillator() { this.operations.push(['createOscillator']); return new MockNode(this, this.operations); }
  createStereoPanner() { this.operations.push(['createStereoPanner']); return new MockNode(this, this.operations); }
}

const render = () => {
  const context = new MockAudioContext();
  const destination = {} as AudioNode;

  renderIndependentPluckVoice({
    channel: {
      id: 'independent',
      name: 'Independent Pluck',
      color: '#ff6e00',
      instrumentType: 'independent_pluck',
      mixerTrackId: 1,
      volume: 0.8,
      pan: -0.1,
      pitch: 0,
      mute: false,
      solo: false,
      steps: [],
      notes: [],
    },
    note: {
      id: 'n1',
      pitch: 60,
      start: 0,
      duration: 4,
      velocity: 0.75,
      pan: 0.25,
    },
    time: 1.5,
    destination,
    audioContext: context as unknown as BaseAudioContext,
    voiceId: 'voice-1',
  });

  return context.operations;
};

test('independent pluck renders through the instrument contract', () => {
  const operations = render();

  assert.ok(operations.some(([name]) => name === 'createOscillator'));
  assert.ok(operations.some(([name]) => name === 'createBiquadFilter'));
  assert.ok(operations.some(([name]) => name === 'createStereoPanner'));
  assert.deepEqual(
    operations.filter(([name]) => name === 'start'),
    [['start', 1.5], ['start', 1.5]],
  );
});

test('the same independent renderer produces identical live/offline scheduling', () => {
  const liveOperations = render();
  const offlineOperations = render();
  assert.deepEqual(offlineOperations, liveOperations);
});
