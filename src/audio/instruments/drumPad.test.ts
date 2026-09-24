import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderDrumPadVoice } from './drumPad';

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
  exponentialRampToValueAtTime(value: number) { this.value = value; }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly playbackRate = new FakeParam();
  readonly pan = new FakeParam();
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startArgs: unknown[] | null = null;
  stopCalls = 0;
  connect() {}
  start(...args: unknown[]) { this.startArgs = args; }
  stop() { this.stopCalls += 1; if (this.stopCalls === 1) this.onended?.(); }
}

class FakeContext {
  currentTime = 0;
  readonly sources: FakeNode[] = [];
  readonly gains: FakeNode[] = [];
  readonly panners: FakeNode[] = [];
  createBufferSource() { const node = new FakeNode(); this.sources.push(node); return node; }
  createGain() { const node = new FakeNode(); this.gains.push(node); return node; }
  createStereoPanner() { const node = new FakeNode(); this.panners.push(node); return node; }
}

const makeChannel = (padOverrides: Record<string, unknown> = {}) => ({
  id: 'drum-test',
  name: 'Drums',
  color: '#fff',
  instrumentType: 'drumpad',
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: {} as any,
  drumPads: [{
    id: 'pad-36',
    note: 36,
    name: 'Kick',
    sampleId: 'kick',
    volume: 1,
    pan: 0,
    tuneSemitones: 2,
    trimStart: 0.1,
    trimEnd: 0.9,
    reverse: true,
    loop: true,
    chokeGroup: 1,
    ...padOverrides,
  }],
}) as any;

const note = {
  id: 'note',
  pitch: 36,
  start: 0,
  duration: 1,
  velocity: 0.75,
} as any;

describe('drum-pad renderer', () => {
  it('preserves sample selection, tuning, reverse, trim, loop, gain and pan', () => {
    const ctx = new FakeContext();
    const buffer = { duration: 2 } as AudioBuffer;
    let ended = 0;

    const handle = renderDrumPadVoice({
      channel: makeChannel({ volume: 0.9, pan: 0.25 }),
      note,
      time: 2,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'voice',
      onEnded: () => { ended += 1; },
      getSampleBuffer: id => id === 'kick' ? buffer : undefined,
    });

    assert.ok(handle);
    const source = ctx.sources[0];
    assert.equal(source.buffer, buffer);
    assert.ok(Math.abs(source.playbackRate.value + Math.pow(2, 2 / 12)) < 1e-9);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 0.2);
    assert.equal(source.loopEnd, 1.8);
    assert.equal(ctx.gains[0].gain.value, 0.75 * 1 * 0.9);
    assert.equal(ctx.panners[0].pan.value, 0.25);
    assert.deepEqual(source.startArgs, [2, 1.8, undefined]);

    source.onended?.();
    assert.equal(ended, 1);
  });

  it('returns no handle when the selected pad has no sample buffer', () => {
    const ctx = new FakeContext();
    const result = renderDrumPadVoice({
      channel: makeChannel(),
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

  it('is explicit about natural completion and keeps stop idempotent', () => {
    const ctx = new FakeContext();
    let ended = 0;
    const handle = renderDrumPadVoice({
      channel: makeChannel({ reverse: false, loop: false }),
      note,
      time: 0,
      destination: {} as AudioNode,
      audioContext: ctx as any,
      voiceId: 'stop',
      onEnded: () => { ended += 1; },
      getSampleBuffer: () => ({ duration: 1 } as AudioBuffer),
    });

    assert.ok(handle);
    handle.stop(0.5);
    handle.stop(0.5);
    assert.equal(ctx.sources[0].stopCalls, 2);
    assert.equal(ended, 1);
  });
});
