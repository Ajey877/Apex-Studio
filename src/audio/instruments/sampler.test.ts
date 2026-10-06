import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSamplerVoice } from './sampler';

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly playbackRate = new FakeParam();
  readonly Q = { value: 0 };
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startArgs: unknown[] | null = null;
  stopCalls = 0;
  type = '';
  connect() {}
  start(...args: unknown[]) { this.startArgs = args; }
  stop() { this.stopCalls += 1; }
}

class FakeContext {
  currentTime = 0;
  readonly sources: FakeNode[] = [];
  createBufferSource() { const node = new FakeNode(); this.sources.push(node); return node; }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
}

const channel = (overrides: Record<string, unknown> = {}) => ({
  id: 'sampler-test',
  name: 'Sampler',
  color: '#fff',
  instrumentType: 'sampler',
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: {
    filterType: 'lowpass',
    filterCutoff: 18000,
    filterResonance: 1,
    sampleLoop: false,
  },
  customSample: {
    id: 'sample',
    name: 'Sample',
    duration: 2,
    sampleRate: 44100,
    channels: 1,
    waveformPeaks: [],
    rootPitch: 60,
  },
  ...overrides,
} as any);

const note = { id: 'note', pitch: 72, start: 0, duration: 1, velocity: 1 } as any;

describe('sampler renderer', () => {
  it('uses the narrow resolver and existing zone/rate/trim/reverse/loop helpers', () => {
    const ctx = new FakeContext();
    const buffer = { duration: 2 } as AudioBuffer;
    let ended = 0;
    const handle = renderSamplerVoice({
      channel: channel({
        pitch: 1,
        sampleZones: [{
          id: 'zone',
          sampleId: 'sample',
          lowNote: 0,
          highNote: 127,
          rootNote: 60,
          lowVelocity: 0,
          highVelocity: 127,
          tuneSemitones: 2,
          trimStart: 0.1,
          trimEnd: 0.9,
          reverse: true,
          loop: true,
          loopStart: 0.2,
          loopEnd: 0.8,
        }],
      }),
      note,
      time: 3,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'voice',
      onEnded: () => { ended += 1; },
      getSampleBuffer: (id) => id === 'sample' ? buffer : undefined,
    });

    assert.ok(handle);
    const source = ctx.sources[0];
    assert.equal(source.buffer, buffer);
    // Contract: playbackRate = 2^((notePitch - rootNote) + channelPitch + tuneSemitones)/12
    // Example: (72 - 60) + 1 (channelPitch) + 2 (tune) = 15 semitones => 2^(15/12)
    // reverse:true => negative rate
    assert.ok(Math.abs(source.playbackRate.value + Math.pow(2, 15 / 12)) < 1e-9);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 0.4);
    assert.equal(source.loopEnd, 1.6);
    assert.deepEqual(source.startArgs, [3, 1.8, undefined]);

    source.onended?.();
    assert.equal(ended, 1);
  });

  it('applies root note, channel pitch, and zone tuning additively', () => {
    const ctx = new FakeContext();
    const buffer = { duration: 1 } as AudioBuffer;
    // No zone tuning, no channel pitch: one octave above root (72 vs 60) => 2^(12/12)=2
    const handle1 = renderSamplerVoice({
      channel: channel({ pitch: 0, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones:0 } as any]}),
      note, time: 0, destination: {} as AudioNode, audioContext: ctx as any, voiceId:'v1', getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle1);
    assert.ok(Math.abs(ctx.sources[0].playbackRate.value - Math.pow(2, 12/12)) < 1e-9);

    // With channel pitch and tune, they add
    const ctx2 = new FakeContext();
    const handle2 = renderSamplerVoice({
      channel: channel({ pitch: 2, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones: -1 } as any]}),
      note: { id:'n', pitch: 60, start:0, duration:1, velocity:1 } as any, time: 0, destination: {} as AudioNode, audioContext: ctx2 as any, voiceId:'v2', getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle2);
    // (60-60)+2 + (-1) =1 semitone => 2^(1/12)
    assert.ok(Math.abs(ctx2.sources[0].playbackRate.value - Math.pow(2, 1/12)) < 1e-9);

    // Reverse playback flips sign
    const ctx3 = new FakeContext();
    const handle3 = renderSamplerVoice({
      channel: channel({ pitch: 0, sampleZones: [{ id:'z', sampleId:'sample', lowNote:0, highNote:127, rootNote:60, lowVelocity:0, highVelocity:127, tuneSemitones:0, reverse:true } as any]}),
      note: { id:'n', pitch: 60, start:0, duration:1, velocity:1 } as any, time: 0, destination: {} as AudioNode, audioContext: ctx3 as any, voiceId:'v3', getSampleBuffer: id=> id==='sample'?buffer:undefined,
    });
    assert.ok(handle3);
    // root 60, note 60 => 0 semitones, reverse => -1
    assert.ok(Math.abs(ctx3.sources[0].playbackRate.value + 1) < 1e-9);
  });

  it('returns no voice when the resolver cannot supply the selected sample', () => {
    const ctx = new FakeContext();
    const result = renderSamplerVoice({
      channel: channel(),
      note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'missing',
      getSampleBuffer: () => undefined,
    });

    assert.equal(result, undefined);
    assert.equal(ctx.sources.length, 0);
  });

  it('stop is safe to call repeatedly', () => {
    const ctx = new FakeContext();
    const handle = renderSamplerVoice({
      channel: channel(),
      note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'stop',
      getSampleBuffer: () => ({ duration: 1 } as AudioBuffer),
    });

    assert.ok(handle);
    handle.stop(0.5);
    handle.stop(0.5);
    assert.equal(ctx.sources[0].stopCalls, 2);
  });
});
