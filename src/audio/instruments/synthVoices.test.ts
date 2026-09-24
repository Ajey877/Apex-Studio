import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSubtractiveSynthVoice } from './subtractiveSynth';
import { renderFmSynthVoice } from './fmSynth';
import type { Channel, Note } from '../../types/daw';

class Param {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
}
class Node {
  gain = new Param();
  frequency = new Param();
  detune = new Param();
  Q = { value: 0 };
  type = '';
  connect() {}
  start() {}
  stop() {}
}
class Context {
  currentTime = 0;
  createGain() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createOscillator() { return new Node(); }
}
const channel: Channel = {
  id: 'synth', name: 'Synth', color: '#fff', instrumentType: 'minisynth',
  mixerTrackId: 1, volume: 0.8, pan: 0, pitch: 0, mute: false, solo: false,
  steps: [], notes: [],
  synthParams: {
    osc1Type: 'sawtooth', osc1Octave: 0, osc1Detune: 0, osc1Mix: 0.8,
    osc2Type: 'square', osc2Octave: 0, osc2Detune: 12, osc2Mix: 0.5,
    filterType: 'lowpass', filterCutoff: 2500, filterResonance: 2,
    filterEnvAmount: 0.5, attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.2,
    lfoRate: 4, lfoDepth: 0, lfoTarget: 'none',
    fmCarrierMultiplier: 1, fmModulatorMultiplier: 2, fmModulationIndex: 150, fmFeedback: 0,
    sampleRootNote: 60, sampleGlide: 0, sampleReverse: false, sampleLoop: false, sampleDrive: 0,
  },
};
const note: Note = { id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 };

test('subtractive renderer is independent of AudioEngine state', () => {
  const handle = renderSubtractiveSynthVoice({
    channel, note, time: 0, destination: {} as AudioNode,
    audioContext: new Context() as unknown as BaseAudioContext, voiceId: 'v1',
  });
  assert.ok(handle);
  assert.equal(typeof handle.stop, 'function');
});

test('FM renderer is independent of AudioEngine state', () => {
  const handle = renderFmSynthVoice({
    channel: { ...channel, instrumentType: 'fmsynth' }, note, time: 0,
    destination: {} as AudioNode,
    audioContext: new Context() as unknown as BaseAudioContext, voiceId: 'v2',
  });
  assert.ok(handle);
  assert.equal(typeof handle.stop, 'function');
});
