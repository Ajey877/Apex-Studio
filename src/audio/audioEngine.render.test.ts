import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { MixerTrack } from '../types/daw';

class FakeParam {
  value = 1;
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
}

class FakeNode {
  gain = new FakeParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeOfflineAudioContext {
  readonly destination = new FakeNode();
  readonly sampleRate: number;
  currentTime = 0;

  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode & { fftSize: number; smoothingTimeConstant: number } {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 });
  }
  createBuffer(): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array(1) };
  }
  async startRendering(): Promise<AudioBuffer> {
    return { sampleRate: this.sampleRate } as AudioBuffer;
  }
}

const mixerTracks: MixerTrack[] = [
  {
    id: 0,
    name: 'Master',
    color: '#fff',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  },
  {
    id: 1,
    name: 'Insert 1',
    color: '#fff',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  },
];

test('offline timeline render drives the same live song scheduling entrypoint and restores engine state', async () => {
  const engine = audioEngine as any;
  const previousOfflineContext = (globalThis as any).OfflineAudioContext;
  const originalBuildReverbImpulse = engine.buildReverbImpulse;
  const originalUpdateMixerTrack = engine.updateMixerTrack;
  const originalTriggerCurrentStep = engine.triggerCurrentStep;
  const originalBpm = engine.bpm;
  const originalCtx = engine.ctx;
  const originalPlayMode = engine.activePlayMode;

  const triggerTimes: number[] = [];
  const updatedTrackIds: number[] = [];

  (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
  engine.buildReverbImpulse = () => undefined;
  engine.updateMixerTrack = (track: MixerTrack) => updatedTrackIds.push(track.id);
  engine.triggerCurrentStep = (time: number) => triggerTimes.push(time);
  engine.bpm = 128;
  engine.ctx = null;
  engine.activePlayMode = 'pat';

  try {
    const rendered = await engine.renderTimelineOffline([], [], mixerTracks, 120, 1, 44100);

    assert.equal(rendered.sampleRate, 44100);
    assert.deepEqual(updatedTrackIds, [0, 1]);
    assert.equal(triggerTimes.length, 16);
    assert.equal(triggerTimes[0], 0);
    assert.equal(triggerTimes[15], 1.875);
    assert.equal(engine.bpm, 128);
    assert.equal(engine.ctx, originalCtx);
    assert.equal(engine.activePlayMode, 'pat');
  } finally {
    (globalThis as any).OfflineAudioContext = previousOfflineContext;
    engine.buildReverbImpulse = originalBuildReverbImpulse;
    engine.updateMixerTrack = originalUpdateMixerTrack;
    engine.triggerCurrentStep = originalTriggerCurrentStep;
    engine.bpm = originalBpm;
    engine.ctx = originalCtx;
    engine.activePlayMode = originalPlayMode;
  }
});
