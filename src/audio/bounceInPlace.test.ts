/**
 * Phase 26 — Bounce-In-Place renderer convergence.
 *
 * Bounce-In-Place is intentionally tested as orchestration here. The actual
 * instrument DSP is covered by the shared InstrumentRegistry/renderers and the
 * offline timeline renderer tests. These tests prove that bounce no longer owns
 * a second DSP implementation and that its historical timing/metadata contract
 * is preserved at the renderer boundary.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioEngine, resolvePlayableContentLengthSteps } from './audioEngine';
import type { Channel, Note } from '../types/daw';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 44100;
const STEPS_PER_BAR = 16;

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    seed = 0,
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      (_, channel) => Float32Array.from(
        { length },
        (_, index) => channel === 0 && index % 1000 === seed ? 0.8 : 0,
      ),
    );
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

const makeChannel = (
  id: string,
  activeSteps: number[],
  totalSteps = 16,
  overrides: Partial<Channel> = {},
): Channel => {
  const steps = new Array(totalSteps).fill(false);
  for (const step of activeSteps) steps[step] = true;
  return {
    id,
    name: id,
    color: '#ff6e00',
    instrumentType: 'drumpad',
    mixerTrackId: 1,
    volume: 0.9,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
    synthParams: {} as Channel['synthParams'],
    ...overrides,
  };
};

const makeNote = (id: string, start: number, duration = 1): Note => ({
  id,
  pitch: 60,
  start,
  duration,
  velocity: 0.9,
});

const expectedLength = (bars: number, bpm: number): number =>
  Math.floor(SAMPLE_RATE * bars * STEPS_PER_BAR * ((60 / bpm) / 4));

let originalRenderTimelineOffline: unknown;
let originalSampleBuffers: unknown;
let originalCtx: unknown;

beforeEach(() => {
  originalRenderTimelineOffline = engine.renderTimelineOffline;
  originalSampleBuffers = engine.sampleBuffers;
  originalCtx = engine.ctx;
  engine.sampleBuffers = new Map();
  engine.ctx = null;
});

afterEach(() => {
  engine.renderTimelineOffline = originalRenderTimelineOffline;
  engine.sampleBuffers = originalSampleBuffers;
  engine.ctx = originalCtx;
});

describe('Phase 26: renderer-backed bounce contract', () => {
  it('delegates the complete bounce to the authoritative offline timeline renderer', async () => {
    const channel = makeChannel('32-step', [16, 20, 31], 32);
    const rendered = new FakeAudioBuffer(2, expectedLength(2, 128), SAMPLE_RATE, 0);
    let call: unknown[] | undefined;

    engine.renderTimelineOffline = async (...args: unknown[]) => {
      call = args;
      return rendered;
    };

    const result = await audioEngine.bounceChannelToAudioClip(channel, 128, 1);

    assert.ok(call);
    assert.deepEqual(call![0], [{ ...structuredClone(channel), arp: undefined, mute: false }]);
    assert.deepEqual(call![1], []);
    assert.deepEqual(call![2], []);
    assert.equal(call![3], 128);
    assert.equal(call![4], 2);
    assert.equal(call![5], SAMPLE_RATE);
    assert.equal(call![6], false);
    assert.equal(call![7], 'pattern');
    assert.equal(call![9], 32);
    assert.equal(call![10], undefined);
    assert.equal(call![11], 2 * 4 * (60 / 128));

    assert.equal(result.buffer, rendered);
    assert.equal(result.lengthBars, 2);
    assert.equal(result.bpm, 128);
    assert.equal(result.waveform.length, 32);
    assert.equal(engine.sampleBuffers.size, 1);
  });

  it('preserves the resolved loop length and minimum-bar rounding contract', async () => {
    const calls: number[] = [];
    engine.renderTimelineOffline = async (...args: unknown[]) => {
      calls.push(Number(args[4]));
      return new FakeAudioBuffer(2, expectedLength(Number(args[4]), Number(args[3])), SAMPLE_RATE);
    };

    const channel = makeChannel('64-step', [63], 64);
    const result = await audioEngine.bounceChannelToAudioClip(channel, 150, 5);

    assert.equal(resolvePlayableContentLengthSteps(channel), 64);
    assert.equal(result.lengthBars, 8);
    assert.deepEqual(calls, [8]);
    assert.equal(result.buffer.length, expectedLength(8, 150));
  });

  it('uses the engine BPM when the supplied BPM is invalid and keeps the transport clamp', async () => {
    engine.bpm = 96;
    engine.renderTimelineOffline = async (...args: unknown[]) =>
      new FakeAudioBuffer(2, expectedLength(Number(args[4]), Number(args[3])), SAMPLE_RATE);

    const fallback = await audioEngine.bounceChannelToAudioClip(makeChannel('fallback', [0]), Number.NaN, 1);
    assert.equal(fallback.bpm, 96);

    const low = await audioEngine.bounceChannelToAudioClip(makeChannel('low', [0]), 5, 1);
    const high = await audioEngine.bounceChannelToAudioClip(makeChannel('high', [0]), 999, 1);
    assert.equal(low.bpm, 20);
    assert.equal(high.bpm, 300);
  });

  it('derives the waveform from the renderer-produced AudioBuffer', async () => {
    const rendered = new FakeAudioBuffer(2, expectedLength(1, 120), SAMPLE_RATE, 0);
    engine.renderTimelineOffline = async () => rendered;

    const { waveform } = await audioEngine.bounceChannelToAudioClip(makeChannel('wave', [0]), 120, 1);

    assert.equal(waveform.length, 32);
    assert.equal(waveform[0], 1);
    assert.equal(waveform.slice(1).every(value => value === 0), true);
  });
});

describe('Phase 26: duplicate offline DSP removal guard', () => {
  it('contains no independent sample-array synthesis in bounceChannelToAudioClip', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    const start = source.indexOf('public async bounceChannelToAudioClip(');
    const end = source.indexOf('public getMasterLoudnessMetrics()', start);
    assert.ok(start >= 0 && end > start);
    const bounceSource = source.slice(start, end);

    assert.match(bounceSource, /renderTimelineOffline\(/);
    assert.doesNotMatch(bounceSource, /Math\.sin\(/);
    assert.doesNotMatch(bounceSource, /createBuffer\(2,\s*length/);
    assert.doesNotMatch(bounceSource, /copyToChannel\(/);
  });

  it('keeps the public bounce result shape used by PlaylistArranger', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    const start = source.indexOf('public async bounceChannelToAudioClip(');
    const end = source.indexOf('public getMasterLoudnessMetrics()', start);
    const bounceSource = source.slice(start, end);

    assert.match(bounceSource, /Promise<\{ buffer: AudioBuffer; waveform: number\[\]; lengthBars: number; bpm: number \}>/);
    assert.match(bounceSource, /return \{ buffer: renderedBuffer, waveform, lengthBars, bpm: safeBpm \}/);
  });
});

describe('Phase 26: bounce callers remain contract-compatible', () => {
  it('PlaylistArranger still consumes rendered buffer, waveform, and lengthBars', () => {
    const source = readFileSync(new URL('../components/PlaylistArranger.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const handleBounceTrack');
    const end = source.indexOf('const handleAddMarker', start);
    const handler = source.slice(start, end);

    assert.match(handler, /bounceChannelToAudioClip\(channel, bpm, MIN_BOUNCE_BARS\)/);
    assert.match(handler, /const \{ buffer, waveform, lengthBars \}/);
    assert.match(handler, /lengthBars,/);
    assert.match(handler, /audioWaveform: waveform/);
  });

  it('the old standalone renderNoteOffline helper is not referenced by the production source', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    const marker = 'private renderNoteOffline(';
    const start = source.indexOf(marker);
    assert.ok(start >= 0);
    const before = source.slice(0, start);
    assert.equal((before.match(/renderNoteOffline\s*\(/g) || []).length, 0);
  });
});
