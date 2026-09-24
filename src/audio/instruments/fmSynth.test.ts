import type { Channel, Note } from '../../types/daw';

type Operation = [string, ...number[]];

class MockAudioParam {
  value = 0;
  constructor(private readonly operations: Operation[], private readonly name: string) {}
  setValueAtTime(value: number, time: number) { this.value = value; this.operations.push([`${this.name}.set`, value, time]); }
  linearRampToValueAtTime(value: number, time: number) { this.value = value; this.operations.push([`${this.name}.linear`, value, time]); }
  exponentialRampToValueAtTime(value: number, time: number) { this.value = value; this.operations.push([`${this.name}.exponential`, value, time]); }
  cancelScheduledValues(time: number) { this.operations.push([`${this.name}.cancel`, time]); }
}

class MockNode {
  readonly gain: MockAudioParam;
  readonly frequency: MockAudioParam;
  readonly detune: MockAudioParam;
  readonly operations: Operation[];
  type = '';
  Q = { value: 0 };
  constructor(operations: Operation[]) {
    this.operations = operations;
    this.gain = new MockAudioParam(operations, 'gain');
    this.frequency = new MockAudioParam(operations, 'frequency');
    this.detune = new MockAudioParam(operations, 'detune');
  }
  connect() { this.operations.push(['connect']); }
  start(time: number) { this.operations.push(['start', time]); }
  stop(time: number) { this.operations.push(['stop', time]); }
}

class MockAudioContext {
  readonly operations: Operation[] = [];
  currentTime = 0;
  createGain() { this.operations.push(['createGain']); return new MockNode(this.operations); }
  createBiquadFilter() { this.operations.push(['createBiquadFilter']); return new MockNode(this.operations); }
  createOscillator() { this.operations.push(['createOscillator']); return new MockNode(this.operations); }
}

const channel: Channel = {
  id: 'synth',
  name: 'Synth',
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: {
    osc1Type: 'sawtooth',
    osc1Octave: 0,
    osc1Detune: 0,
    osc1Mix: 0.8,
    osc2Type: 'square',
    osc2Octave: 0,
    osc2Detune: 12,
    osc2Mix: 0.5,
    filterType: 'lowpass',
    filterCutoff: 2500,
    filterResonance: 2,
    filterEnvAmount: 0.5,
    attack: 0.01,
    decay: 0.15,
    sustain: 0.6,
    release: 0.2,
    lfoRate: 4,
    lfoDepth: 0,
    lfoTarget: 'none',
    fmCarrierMultiplier: 1,
    fmModulatorMultiplier: 2,
    fmModulationIndex: 150,
    fmFeedback: 0,
    sampleRootNote: 60,
    sampleGlide: 0,
    sampleReverse: false,
    sampleLoop: false,
    sampleDrive: 0,
  },
};

const note: Note = {
  id: 'n1',
  pitch: 60,
  start: 0,
  duration: 4,
  velocity: 0.75,
};

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFmSynthVoice } from './fmSynth';

test('FM synth renders independently and returns a stoppable voice', () => {
  const context = new MockAudioContext();
  const handle = renderFmSynthVoice({
    channel: { ...channel, instrumentType: 'fmsynth' },
    note,
    time: 1.5,
    destination: {} as AudioNode,
    audioContext: context as unknown as BaseAudioContext,
    voiceId: 'voice-1',
  });

  assert.ok(handle);
  assert.equal(context.operations.filter(([name]) => name === 'createOscillator').length, 2);
  assert.equal(context.operations.filter(([name]) => name === 'start').length, 2);
  handle?.stop(2);
  assert.ok(context.operations.some(([name]) => name === 'gain.cancel'));
});
