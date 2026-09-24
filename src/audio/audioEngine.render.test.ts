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


test('offline timeline accepts an exact minimum duration for renderer-backed bounce', async () => {
  const engine = audioEngine as any;
  const previousOfflineContext = (globalThis as any).OfflineAudioContext;
  const originalUpdateMixerTrack = engine.updateMixerTrack;
  const originalTriggerCurrentStep = engine.triggerCurrentStep;
  const originalCtx = engine.ctx;

  const triggerTimes: number[] = [];

  (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
  engine.updateMixerTrack = () => undefined;
  engine.triggerCurrentStep = (time: number) => triggerTimes.push(time);
  engine.ctx = null;

  try {
    const rendered = await engine.renderTimelineOffline(
      [],
      [],
      mixerTracks,
      120,
      1,
      44100,
      false,
      'pattern',
      undefined,
      16,
      undefined,
      2,
    );

    assert.equal(rendered.sampleRate, 44100);
    assert.equal(triggerTimes.length, 16);
    assert.equal(triggerTimes[0], 0);
    assert.equal(triggerTimes[15], 1.875);
  } finally {
    (globalThis as any).OfflineAudioContext = previousOfflineContext;
    engine.updateMixerTrack = originalUpdateMixerTrack;
    engine.triggerCurrentStep = originalTriggerCurrentStep;
    engine.ctx = originalCtx;
  }
});


test('registry-backed renderers receive the OfflineAudioContext for every instrument type', async () => {
  const engine = audioEngine as any;
  const previousOfflineContext = (globalThis as any).OfflineAudioContext;
  const originalRegistry = engine.instrumentRegistry;
  const originalUpdateMixerTrack = engine.updateMixerTrack;
  const originalGetOrCreateMixerChannel = engine.getOrCreateMixerChannel;
  const originalTriggerSidechainDucking = engine.triggerSidechainDucking;
  const originalCtx = engine.ctx;

  const seenTypes: string[] = [];
  const seenContexts: unknown[] = [];
  const instrumentTypes = [
    'minisynth', 'fmsynth', 'drumpad', 'wavetable', 'sampler',
    'grand_piano', 'rhodes_epiano', 'hammond_organ', 'harpsichord',
    'nylon_guitar', 'strings_ensemble', 'pizzicato_strings',
    'cinematic_brass', 'acid_303', 'reese_bass', 'sub_808',
    'slap_bass', 'supersaw_lead', 'ambient_pad', 'vox_choir',
    'marimba_bell', 'fm_bell', 'chiptune_8bit', 'independent_pluck',
  ];

  (globalThis as any).OfflineAudioContext = FakeOfflineContextForRegistry;
  engine.updateMixerTrack = () => undefined;
  engine.getOrCreateMixerChannel = () => ({ input: {} });
  engine.triggerSidechainDucking = () => undefined;
  engine.ctx = null;
  engine.instrumentRegistry = {
    get: (instrumentType: string) => {
      const original = originalRegistry.get(instrumentType);
      return (context: any) => {
        seenTypes.push(instrumentType);
        seenContexts.push(context.audioContext);
        return { stop: () => undefined };
      };
    },
    has: (instrumentType: string) => originalRegistry.has(instrumentType),
  };

  const channels = instrumentTypes.map((instrumentType, index) => ({
    id: `offline-${instrumentType}`,
    name: instrumentType,
    color: '#fff',
    instrumentType,
    mixerTrackId: index + 1,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: [true],
    notes: [],
    synthParams: {} as any,
  }));

  try {
    await engine.renderTimelineOffline(
      channels,
      [],
      [],
      120,
      1,
      44100,
      false,
      'pattern',
      undefined,
      16,
      undefined,
      2,
    );

    assert.deepEqual(seenTypes, instrumentTypes);
    assert.equal(seenContexts.length, instrumentTypes.length);
    assert.ok(seenContexts.every(context => context instanceof FakeOfflineContextForRegistry));
  } finally {
    (globalThis as any).OfflineAudioContext = previousOfflineContext;
    engine.instrumentRegistry = originalRegistry;
    engine.updateMixerTrack = originalUpdateMixerTrack;
    engine.getOrCreateMixerChannel = originalGetOrCreateMixerChannel;
    engine.triggerSidechainDucking = originalTriggerSidechainDucking;
    engine.ctx = originalCtx;
  }
});

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
  const progressEvents: Array<{ progress: number; status: string }> = [];

  (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
  engine.buildReverbImpulse = () => undefined;
  engine.updateMixerTrack = (track: MixerTrack) => updatedTrackIds.push(track.id);
  engine.triggerCurrentStep = (time: number) => triggerTimes.push(time);
  engine.bpm = 128;
  engine.ctx = null;
  engine.activePlayMode = 'pat';

  try {
    const rendered = await engine.renderTimelineOffline(
      [],
      [],
      mixerTracks,
      120,
      1,
      44100,
      false,
      'pattern',
      (progress: number, status: string) => progressEvents.push({ progress, status }),
    );

    assert.equal(rendered.sampleRate, 44100);
    assert.deepEqual(updatedTrackIds, [0, 1]);
    assert.equal(triggerTimes.length, 32);
    assert.equal(triggerTimes[0], 0);
    assert.equal(triggerTimes[31], 3.875);
    assert.equal(engine.bpm, 128);
    assert.equal(engine.ctx, originalCtx);
    assert.equal(engine.activePlayMode, 'pat');
    assert.ok(progressEvents.some(event => event.progress === 40 && /pattern mode/i.test(event.status)));
    assert.equal(progressEvents.at(-1)?.progress, 85);
    assert.match(progressEvents.at(-1)?.status ?? '', /Encoding WAV/);
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
