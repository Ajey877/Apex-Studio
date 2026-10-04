/**
 * Phase 64 — F4 (engine half): the bounced stem must carry the mixer the user
 * monitored.
 *
 * `bounceChannelToAudioClip` called `renderTimelineOffline` with
 * `mixerTracks = []` and `includeMixerFx = false`, so every bounced stem was
 * dry: the channel's insert FX, its fader and its bus routing were bypassed
 * even though the same channel is heard through them during playback.
 *
 * These tests drive the real renderer against a simulated OfflineAudioContext
 * and assert on the graph it actually builds.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { Channel, MixerTrack } from '../types/daw';

const SAMPLE_RATE = 8000;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

class SimParam {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class SimNode {
  readonly connections: SimNode[] = [];
  readonly gained = new SimParam(1);
  readonly pan = new SimParam(0);
  readonly frequency = new SimParam(440);
  readonly detune = new SimParam(0);
  readonly Q = new SimParam(1);
  delayTime = new SimParam(0.35);
  constructor(readonly kind: string) {}
  get gain(): SimParam { return this.gained; }
  connect(target: SimNode): SimNode {
    if (!this.connections.includes(target)) this.connections.push(target);
    return target;
  }
  disconnect(): void { this.connections.length = 0; }
  start(): void {}
  stop(): void {}
  setPeriodicWave(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class SimAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0];
  }
}

/** Offline contexts created by the renderer, so the built graph can be inspected. */
let offlineContexts: SimAudioContext[] = [];
/** Mixer-track output gain snapshot taken while the offline graph is alive. */
let mixerGainAtRender: Map<number, number> = new Map();

class SimAudioContext {
  readonly sampleRate = SAMPLE_RATE;
  readonly length = SAMPLE_RATE * 8;
  readonly numberOfChannels = 2;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new SimNode('destination');
  readonly nodes: SimNode[] = [];

  constructor() {
    offlineContexts.push(this);
  }

  private track(kind: string): SimNode {
    const node = new SimNode(kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): SimNode { return this.track('gain'); }
  createStereoPanner(): SimNode { return this.track('panner'); }
  createAnalyser(): SimNode { return this.track('analyser'); }
  createOscillator(): SimNode { return this.track('oscillator'); }
  createBiquadFilter(): SimNode { return this.track('biquad'); }
  createDelay(): SimNode { return this.track('delay'); }
  createConvolver(): SimNode { return this.track('convolver'); }
  createDynamicsCompressor(): SimNode { return this.track('compressor'); }
  createWaveShaper(): SimNode { return this.track('waveshaper'); }
  createBuffer(channels: number, length: number, sampleRate: number): SimAudioBuffer {
    return new SimAudioBuffer(channels, length, sampleRate);
  }
  resume(): Promise<void> { return Promise.resolve(); }

  async startRendering(): Promise<SimAudioBuffer> {
    mixerGainAtRender = new Map();
    for (const [trackId, channel] of engine.mixerChannels as Map<number, any>) {
      mixerGainAtRender.set(trackId, channel.output.gain.value);
    }
    return new SimAudioBuffer(2, this.length, this.sampleRate);
  }
}

function makeChannel(id: string, mixerTrackId = 1, overrides: Partial<Channel> = {}): Channel {
  const steps = new Array(16).fill(false);
  steps[0] = true;
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'minisynth',
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    mixerTrackId,
    ...overrides,
  };
}

function makeMixerTracks(): MixerTrack[] {
  return [0, 1].map(id => ({
    id,
    name: id === 0 ? 'Master' : 'Insert 1',
    color: '#fff',
    volume: id === 0 ? 0.9 : 0.6,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: id === 1
      ? [{ id: 'fx-1-delay', type: 'delay' as const, name: 'Tape Delay', enabled: true, mix: 0.5, params: { time: 0.25, feedback: 0.4 } }]
      : [],
  }));
}

const SAVED_FIELDS = ['ctx', 'liveCtx', 'mixerChannels', 'channelPanners', 'sampleBuffers',
  'impulseResponses', 'isOfflineRendering', 'bpm', 'masterGain', 'grossBeatNode'] as const;
const savedState: Record<string, unknown> = {};

const delayNodesInLastRender = (): number =>
  (offlineContexts[offlineContexts.length - 1]?.nodes ?? []).filter(node => node.kind === 'delay').length;

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  offlineContexts = [];
  mixerGainAtRender = new Map();
  engine.ctx = new SimAudioContext();
  engine.bpm = 120;
  engine.sampleBuffers = new Map();
  engine.impulseResponses = new Map();
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
  (globalThis as any).OfflineAudioContext = SimAudioContext;
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).window = undefined;
});

describe('Phase 64 F4 — bounce renders through the channel mixer strip', () => {
  it('routes the bounce through the project mixer tracks so insert FX are rendered', async () => {
    offlineContexts = [];
    const channel = makeChannel('ch-bounced', 1);

    await audioEngine.bounceChannelToAudioClip(channel, 120, 1, {
      mixerTracks: makeMixerTracks(),
      includeMixerFx: true,
    });

    assert.equal(delayNodesInLastRender(), 1, 'the insert delay must exist in the bounce graph');
  });

  it('applies the insert fader to the bounced stem', async () => {
    const channel = makeChannel('ch-bounced', 1);

    await audioEngine.bounceChannelToAudioClip(channel, 120, 1, {
      mixerTracks: makeMixerTracks(),
      includeMixerFx: true,
    });

    assert.equal(
      mixerGainAtRender.get(1),
      0.6,
      'the strip fader must shape the bounced stem, not unity',
    );
  });

  it('keeps the legacy no-mixer bounce contract when no options are supplied', async () => {
    offlineContexts = [];
    const channel = makeChannel('ch-bounced', 1);

    const result = await audioEngine.bounceChannelToAudioClip(channel, 120, 1);

    assert.equal(delayNodesInLastRender(), 0, 'an option-less bounce stays dry (existing callers)');
    assert.equal(result.lengthBars, 1);
  });

  it('still renders the channel content and returns the documented shape', async () => {
    const channel = makeChannel('ch-bounced', 1);

    const result = await audioEngine.bounceChannelToAudioClip(channel, 120, 2, {
      mixerTracks: makeMixerTracks(),
      includeMixerFx: true,
    });

    assert.equal(result.lengthBars, 2);
    assert.equal(result.bpm, 120);
    assert.equal(result.waveform.length, 32);
    assert.ok(result.buffer.length > 0);
  });
});
