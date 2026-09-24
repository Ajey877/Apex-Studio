/**
 * Phase 26 — final renderer-backed offline audio behavior verification.
 *
 * These tests deliberately exercise AudioEngine -> InstrumentRegistry ->
 * production renderer implementations -> OfflineAudioContext. The fake
 * OfflineAudioContext only supplies deterministic Web Audio scheduling and a
 * small graph evaluator because Node does not provide a browser Web Audio
 * implementation.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { audioEngine } from './audioEngine';
import type { Channel, Note } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const BAR_SECONDS = 2;

class FakeAudioParam {
  value = 1;
  private events: Array<{ time: number; value: number }> = [];

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ time, value });
  }

  setTargetAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ time, value });
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ time, value });
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ time, value });
  }

  cancelScheduledValues(_time: number) {}

  valueAt(time: number) {
    let value = this.events.length ? this.events[0].value : this.value;
    for (const event of this.events) {
      if (event.time <= time) value = event.value;
      else break;
    }
    return value;
  }
}

type FakeKind =
  | 'destination'
  | 'gain'
  | 'panner'
  | 'filter'
  | 'analyser'
  | 'bufferSource'
  | 'oscillator';

class FakeNode {
  readonly connections: FakeNode[] = [];
  readonly gain = new FakeAudioParam();
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();
  readonly playbackRate = new FakeAudioParam();
  readonly pan = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
  readonly sources: FakeNode[] = [];
  type = 'sine';
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startTime: number | null = null;
  startOffset = 0;
  startDuration: number | undefined;
  stopTime: number | undefined;
  startCalls = 0;
  stopCalls = 0;

  constructor(
    readonly context: FakeOfflineAudioContext,
    readonly kind: FakeKind,
  ) {}

  connect(destination: any) {
    if (destination instanceof FakeNode) {
      this.connections.push(destination);
    }
    return destination;
  }

  disconnect() {
    this.connections.length = 0;
  }

  start(time = 0, offset = 0, duration?: number) {
    this.startCalls += 1;
    this.startTime = time;
    this.startOffset = offset;
    this.startDuration = duration;
  }

  stop(time?: number) {
    this.stopCalls += 1;
    this.stopTime = time ?? this.context.currentTime;
  }

  addEventListener(_type: string, _listener: () => void, _options?: unknown) {}
}

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    fill?: (channel: number, index: number) => number,
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, (_, channel) => {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i++) data[i] = fill?.(channel, i) ?? 0;
      return data;
    });
  }

  getChannelData(channel: number) {
    return this.channels[channel];
  }

  copyToChannel(source: Float32Array, channel: number) {
    this.channels[channel].set(source.subarray(0, this.length));
  }
}

class FakeOfflineAudioContext {
  static instances: FakeOfflineAudioContext[] = [];

  readonly destination: FakeNode;
  readonly nodes: FakeNode[] = [];
  currentTime = 0;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.destination = this.node('destination');
    FakeOfflineAudioContext.instances.push(this);
  }

  node(kind: FakeKind) {
    const node = new FakeNode(this, kind);
    this.nodes.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createBufferSource() { return this.node('bufferSource'); }
  createGain() { return this.node('gain'); }
  createOscillator() { return this.node('oscillator'); }
  createBiquadFilter() { return this.node('filter'); }
  createStereoPanner() { return this.node('panner'); }
  createAnalyser() { return this.node('analyser'); }

  async startRendering() {
    const output = new FakeAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);

    for (let i = 0; i < this.length; i++) {
      const time = i / this.sampleRate;
      let l = 0;
      let r = 0;

      for (const source of this.nodes.filter(node => node.kind === 'bufferSource' || node.kind === 'oscillator')) {
        const mono = this.sourceValue(source, time);
        if (mono === 0) continue;
        const emitted = this.emit(source, mono, mono, time, new Set<FakeNode>());
        l += emitted.left;
        r += emitted.right;
      }

      left[i] = l;
      right[i] = r;
    }

    return output;
  }

  private sourceValue(source: FakeNode, time: number): number {
    if (source.startTime === null || time < source.startTime) return 0;
    if (source.stopTime !== undefined && time >= source.stopTime) return 0;
    const elapsed = time - source.startTime;
    if (source.startDuration !== undefined && elapsed >= source.startDuration) return 0;

    if (source.kind === 'oscillator') {
      const frequency = Math.max(0, source.frequency.valueAt(time));
      const phase = (elapsed * frequency) % 1;
      switch (source.type) {
        case 'square': return phase < 0.5 ? 1 : -1;
        case 'sawtooth': return 2 * phase - 1;
        case 'triangle': return 1 - 4 * Math.abs(Math.round(phase) - phase);
        default: return Math.sin(phase * Math.PI * 2);
      }
    }

    const buffer = source.buffer;
    if (!buffer) return 0;

    const rate = source.playbackRate.valueAt(time);
    const rawIndex = source.startOffset * buffer.sampleRate + elapsed * buffer.sampleRate * rate;
    const loopStart = source.loopStart * buffer.sampleRate;
    const loopEnd = source.loopEnd * buffer.sampleRate;
    let index = rawIndex;

    if (source.loop && loopEnd > loopStart) {
      const span = loopEnd - loopStart;
      index = loopStart + ((((rawIndex - loopStart) % span) + span) % span);
    }

    if (index < 0 || index >= buffer.length) return 0;
    const i0 = Math.floor(index);
    const i1 = Math.min(buffer.length - 1, i0 + 1);
    const frac = index - i0;
    const data = buffer.getChannelData(0);
    return data[i0] * (1 - frac) + data[i1] * frac;
  }

  private emit(
    node: FakeNode,
    left: number,
    right: number,
    time: number,
    visited: Set<FakeNode>,
  ): { left: number; right: number } {
    if (visited.has(node)) return { left: 0, right: 0 };
    const nextVisited = new Set(visited);
    nextVisited.add(node);

    let l = left;
    let r = right;

    if (node.kind === 'gain' || node.kind === 'filter' || node.kind === 'analyser') {
      const gain = node.kind === 'gain' ? node.gain.valueAt(time) : 1;
      l *= gain;
      r *= gain;
    } else if (node.kind === 'panner') {
      const pan = Math.max(-1, Math.min(1, node.pan.valueAt(time)));
      const angle = (pan + 1) * Math.PI / 4;
      const mono = (l + r) / 2;
      l = mono * Math.cos(angle);
      r = mono * Math.sin(angle);
    }

    if (node.kind === 'destination') return { left: l, right: r };

    let outL = 0;
    let outR = 0;
    for (const connection of node.connections) {
      const emitted = this.emit(connection, l, r, time, nextVisited);
      outL += emitted.left;
      outR += emitted.right;
    }
    return { left: outL, right: outR };
  }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;
const realWindow = (globalThis as any).window;
let savedCtx: unknown;
let savedSampleBuffers: unknown;

const makeSample = (channels = 1) =>
  new FakeAudioBuffer(channels, 256, SAMPLE_RATE, (channel, index) => {
    const ramp = index / 255;
    return channel === 0 ? ramp : ramp * 0.75;
  });

const makeBaseChannel = (overrides: Record<string, unknown> = {}): Channel => ({
  id: 'phase26-audio',
  name: 'Phase 26',
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {
    osc1Type: 'sine',
    osc2Type: 'triangle',
    osc1Level: 0.7,
    osc2Level: 0.3,
    filterType: 'lowpass',
    filterCutoff: 18000,
    filterResonance: 1,
    sampleLoop: false,
  },
  ...overrides,
} as Channel);

const note = (id: string, start: number, pitch = 60, duration = 1, velocity = 1): Note =>
  ({ id, start, pitch, duration, velocity } as Note);

const renderBounce = (channel: Channel, minBars = 1) =>
  audioEngine.bounceChannelToAudioClip(channel, BPM, minBars);

const peak = (buffer: AudioBuffer, channel = 0) => {
  const data = buffer.getChannelData(channel);
  let max = 0;
  for (const value of data) max = Math.max(max, Math.abs(value));
  return max;
};

const energy = (buffer: AudioBuffer, channel: number, fromSeconds: number, toSeconds: number) => {
  const data = buffer.getChannelData(channel);
  const from = Math.max(0, Math.floor(fromSeconds * buffer.sampleRate));
  const to = Math.min(data.length, Math.ceil(toSeconds * buffer.sampleRate));
  let sum = 0;
  for (let i = from; i < to; i++) sum += Math.abs(data[i]);
  return sum;
};

beforeEach(() => {
  FakeOfflineAudioContext.instances = [];
  savedCtx = engine.ctx;
  savedSampleBuffers = engine.sampleBuffers;
  engine.ctx = null;
  engine.sampleBuffers = new Map();
  (globalThis as any).window = { OfflineAudioContext: FakeOfflineAudioContext };
});

afterEach(() => {
  engine.ctx = savedCtx;
  engine.sampleBuffers = savedSampleBuffers;
  (globalThis as any).window = realWindow;
});

describe('Phase 26 final renderer-backed audio behavior', () => {
  it('sampler resolves the real registered sampler renderer, sample buffer, timing and gain', async () => {
    const sample = makeSample();
    engine.sampleBuffers.set('phase26-sampler', sample);

    const channel = makeBaseChannel({
      instrumentType: 'sampler',
      volume: 0.5,
      customSample: {
        id: 'phase26-sampler',
        name: 'Deterministic',
        duration: sample.duration,
        sampleRate: sample.sampleRate,
        channels: 1,
        waveformPeaks: [],
        rootPitch: 60,
      },
      steps: [true, ...new Array(15).fill(false)],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const sources = ctx.nodes.filter(node => node.kind === 'bufferSource');

    assert.equal(sources.length, 1, 'valid sampler sample uses the sampler renderer, not subtractive fallback');
    assert.equal(ctx.nodes.filter(node => node.kind === 'oscillator').length, 0, 'no fallback oscillator was created');
    assert.equal(sources[0].buffer, sample);
    assert.equal(sources[0].startTime, 0);
    assert.equal(sources[0].startOffset, 0);
    assert.equal(sources[0].startDuration, sample.duration);
    assert.equal(sources[0].playbackRate.value, 1);
    assert.equal((sources[0].connections[0] as FakeNode).gain.value, 0.5 * 0.9);
    assert.ok(peak(result.buffer) > 0, 'sampler produced non-silent offline audio');
  });

  it('sampled drum pad uses the real renderer and preserves tuning, trim, reverse, loop, gain and pan', async () => {
    const sample = makeSample();
    engine.sampleBuffers.set('phase26-drum', sample);

    const channel = makeBaseChannel({
      instrumentType: 'drumpad',
      volume: 0.8,
      steps: [true, ...new Array(15).fill(false)],
      drumPads: [{
        id: 'pad',
        note: 36,
        name: 'Deterministic Kick',
        sampleId: 'phase26-drum',
        volume: 0.75,
        pan: 0.8,
        tuneSemitones: 2,
        trimStart: 0.1,
        trimEnd: 0.9,
        reverse: true,
        loop: true,
        loopStart: 0.2,
        loopEnd: 0.8,
        chokeGroup: 0,
      }],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const source = ctx.nodes.find(node => node.kind === 'bufferSource')!;
    const gain = ctx.nodes.find(node => node.kind === 'gain' && node.connections.some(n => n.kind === 'panner'))!;
    const panner = ctx.nodes.find(node => node.kind === 'panner')!;

    assert.equal(source.buffer, sample);
    assert.ok(Math.abs(source.playbackRate.value + Math.pow(2, 2 / 12)) < 1e-9);
    assert.equal(source.loop, true);
    assert.equal(source.loopStart, 0.2 * sample.duration);
    assert.equal(source.loopEnd, 0.8 * sample.duration);
    assert.equal(source.startOffset, 0.9 * sample.duration);
    assert.equal(source.startDuration, undefined);
    assert.equal(gain.gain.value, 0.9 * 0.8 * 0.75);
    assert.equal(panner.pan.value, 0.8);
    assert.ok(peak(result.buffer) > 0, 'sampled drum pad produced non-silent audio');
    assert.ok(energy(result.buffer, 1, 0, 0.5) > energy(result.buffer, 0, 0, 0.5), 'positive pan favors the right channel');
  });

  it('offline drum-pad choke stops the earlier sampled voice through AudioEngine ownership', async () => {
    const sample = makeSample();
    engine.sampleBuffers.set('phase26-choke', sample);

    const channel = makeBaseChannel({
      instrumentType: 'drumpad',
      steps: [true, true, ...new Array(14).fill(false)],
      drumPads: [{
        id: 'pad',
        note: 36,
        name: 'Choked Kick',
        sampleId: 'phase26-choke',
        volume: 1,
        pan: 0,
        tuneSemitones: 0,
        trimStart: 0,
        trimEnd: 1,
        reverse: false,
        loop: false,
        loopStart: 0,
        loopEnd: 1,
        chokeGroup: 7,
      }],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const sources = ctx.nodes.filter(node => node.kind === 'bufferSource');

    assert.equal(sources.length, 2);
    assert.ok(sources[0].stopCalls >= 1, 'the first sampled pad voice was explicitly stopped by the choke group');
    assert.ok(
      sources[0].stopTime !== undefined &&
      sources[0].stopTime > 0.12 &&
      sources[0].stopTime < 0.25,
      'the first voice stops at the second hit rather than at its natural end',
    );
    assert.equal(sources[1].stopCalls, 0, 'the newer choke-group voice remains active');
    assert.ok(peak(result.buffer) > 0);
  });

  it('invokes a real multi-source legacy renderer and keeps every scheduled source alive until its own end', async () => {
    const channel = makeBaseChannel({
      instrumentType: 'rhodes_epiano',
      steps: [true, ...new Array(15).fill(false)],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const oscillators = ctx.nodes.filter(node => node.kind === 'oscillator');

    assert.equal(oscillators.length, 3, 'Rhodes renderer schedules tine, bell and tremolo LFO sources');
    assert.ok(oscillators.every(source => source.startCalls === 1), 'all sources were scheduled');
    assert.ok(oscillators.every(source => source.stopTime !== undefined), 'all sources have an explicit natural stop');
    assert.ok(peak(result.buffer) > 0, 'multi-source renderer produced non-silent audio');
  });

  it('renders overlapping notes as simultaneous contributions through the shared renderer path', async () => {
    const channel = makeBaseChannel({
      instrumentType: 'minisynth',
      notes: [note('a', 0, 60, 1, 1), note('b', 0, 72, 1, 1)],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const oscillators = ctx.nodes.filter(node => node.kind === 'oscillator');

    assert.equal(oscillators.length, 4, 'two overlapping subtractive-synth notes create two oscillator pairs');
    assert.ok(peak(result.buffer) > 0);
    assert.ok(energy(result.buffer, 0, 0, 0.1) > 0, 'first note contributes');
    assert.ok(energy(result.buffer, 0, 0.1, 0.2) > 0, 'overlap remains audible after the second note begins');
  });

  it('retains a multi-source voice tail beyond the note trigger/duration window', async () => {
    const channel = makeBaseChannel({
      instrumentType: 'rhodes_epiano',
      notes: [note('tail', 0, 60, 1, 1)],
    });

    const result = await renderBounce(channel);
    const ctx = FakeOfflineAudioContext.instances[0];
    const sources = ctx.nodes.filter(node => node.kind === 'oscillator');

    assert.ok(sources.some(source => (source.stopTime ?? 0) > 0.6), 'voice source is scheduled beyond the note duration');
    assert.ok(energy(result.buffer, 0, 0.45, 0.65) > 0, 'offline output retains audible tail content');
    assert.equal(result.buffer.length, SAMPLE_RATE * BAR_SECONDS, 'buffer duration remains the fixed bounce duration');
  });

  it('preserves stereo pan direction without relying on exact floating-point samples', async () => {
    const sample = makeSample();
    engine.sampleBuffers.set('phase26-pan', sample);

    const channel = makeBaseChannel({
      instrumentType: 'drumpad',
      steps: [true, ...new Array(15).fill(false)],
      drumPads: [{
        id: 'pad',
        note: 36,
        name: 'Pan Test',
        sampleId: 'phase26-pan',
        volume: 1,
        pan: 0.75,
        tuneSemitones: 0,
        trimStart: 0,
        trimEnd: 1,
        reverse: false,
        loop: false,
        loopStart: 0,
        loopEnd: 1,
        chokeGroup: 0,
      }],
    });

    const result = await renderBounce(channel);
    assert.ok(energy(result.buffer, 1, 0, 0.25) > energy(result.buffer, 0, 0, 0.25));
  });

  it('produces deterministic repeated offline bounce output for the same project state', async () => {
    const sample = makeSample();
    engine.sampleBuffers.set('phase26-deterministic', sample);

    const channel = makeBaseChannel({
      instrumentType: 'sampler',
      volume: 0.7,
      customSample: {
        id: 'phase26-deterministic',
        name: 'Deterministic',
        duration: sample.duration,
        sampleRate: sample.sampleRate,
        channels: 1,
        waveformPeaks: [],
        rootPitch: 60,
      },
      notes: [note('a', 0, 60, 1, 0.8), note('b', 4, 67, 1, 0.6)],
    });

    const first = await renderBounce(channel);
    const second = await renderBounce(channel);

    assert.equal(first.buffer.sampleRate, second.buffer.sampleRate);
    assert.equal(first.buffer.length, second.buffer.length);
    assert.equal(first.buffer.numberOfChannels, second.buffer.numberOfChannels);

    for (const channelIndex of [0, 1]) {
      const a = first.buffer.getChannelData(channelIndex);
      const b = second.buffer.getChannelData(channelIndex);
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        assert.ok(Math.abs(a[i] - b[i]) <= 1e-6, `determinism mismatch at channel ${channelIndex}, sample ${i}`);
      }
    }
  });
});
