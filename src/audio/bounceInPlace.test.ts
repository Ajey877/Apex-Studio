/**
 * Phase 9C regression coverage: Bounce-In-Place must follow project timing.
 *
 * Before this fix `bounceChannelToAudioClip()` read the channel through a
 * hardcoded 16-step window (`s % 16`), so steps 16-31 of a 32-step pattern were
 * silently omitted from the stem, and the Playlist caller passed a literal
 * 130 BPM regardless of the project tempo while stamping a fixed 4-bar length on
 * the resulting PlaylistClip.
 *
 * Every test below drives the production `audioEngine.bounceChannelToAudioClip()`
 * path against a deterministic offline-context double and checks the rendered
 * samples exactly, so results never depend on real audio hardware or timing.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioEngine, resolvePlayableContentLengthSteps } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import type { Channel, Note } from '../types/daw';

// ---------------------------------------------------------------------------
// Deterministic offline audio double
// ---------------------------------------------------------------------------

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
  copyToChannel(source: Float32Array, channel: number): void { this.channels[channel].set(source.subarray(0, this.length)); }
}

class FakeOfflineAudioContext {
  static created: FakeOfflineAudioContext[] = [];

  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    FakeOfflineAudioContext.created.push(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 44100;
const STEPS_PER_BAR = 16;
const realWindow = (globalThis as any).window;
let savedCtx: unknown;
let savedBpm: unknown;
let savedSampleBuffers: unknown;

beforeEach(() => {
  FakeOfflineAudioContext.created = [];
  (globalThis as any).window = { OfflineAudioContext: FakeOfflineAudioContext };
  savedCtx = engine.ctx;
  savedBpm = engine.bpm;
  savedSampleBuffers = engine.sampleBuffers;
  // No live AudioContext in node: the engine falls back to 44.1 kHz, pin it explicitly.
  engine.ctx = null;
  engine.sampleBuffers = new Map();
});

afterEach(() => {
  engine.ctx = savedCtx;
  engine.bpm = savedBpm;
  engine.sampleBuffers = savedSampleBuffers;
  (globalThis as any).window = realWindow;
});

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const makeChannel = (id: string, activeSteps: number[], totalSteps = 16, overrides: Partial<Channel> = {}): Channel => {
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
    ...overrides
  };
};

const makeNote = (id: string, start: number, duration = 1): Note => ({ id, pitch: 60, start, duration, velocity: 0.9 });

const stepSeconds = (bpm: number): number => (60 / bpm) / 4;

/** Sample index at which step `step` of the rendered stem begins (mirrors the renderer's rounding). */
const stepStartSample = (step: number, bpm: number): number => Math.floor(step * stepSeconds(bpm) * SAMPLE_RATE);

/** Expected buffer length for `bars` bars at `bpm` (mirrors the renderer's rounding). */
const expectedLength = (bars: number, bpm: number): number => Math.floor(SAMPLE_RATE * bars * STEPS_PER_BAR * stepSeconds(bpm));

const bounce = (channel: Channel, bpm: number, minBars?: number) =>
  audioEngine.bounceChannelToAudioClip(channel, bpm, minBars);

/**
 * The renderer's response to a single hit, captured from the production path
 * itself (one bar, only step 0 active, same instrument and volume as `template`).
 * The bounce renderer is linear and time-invariant: every hit adds this same
 * kernel at its step's start sample, so a stem can be checked sample-for-sample
 * against the superposition of the kernel at the expected steps and nothing else.
 */
const captureHitKernel = async (template: Channel): Promise<Float32Array> => {
  const single: Channel = { ...template, steps: [true, ...new Array(15).fill(false)], notes: [] };
  const { buffer } = await bounce(single, 120, 1);
  return Float32Array.from(buffer.getChannelData(0));
};

const superpose = (kernel: Float32Array, hitSteps: number[], bpm: number, length: number): Float32Array => {
  const out = new Float32Array(length);
  for (const step of [...hitSteps].sort((a, b) => a - b)) {
    const start = stepStartSample(step, bpm);
    for (let i = 0; i < kernel.length && start + i < length; i++) out[start + i] += kernel[i];
  }
  return out;
};

/** Assert the stem contains a hit at exactly `hitSteps` (at `bpm` spacing) and nothing else. */
const assertHitsExactlyAt = (buffer: AudioBuffer, kernel: Float32Array, bpm: number, hitSteps: number[], label: string): void => {
  const expected = superpose(kernel, hitSteps, bpm, buffer.length);
  const stepSamples = stepSeconds(bpm) * SAMPLE_RATE;
  for (const channel of [0, 1]) {
    const actual = buffer.getChannelData(channel);
    assert.equal(actual.length, expected.length, `${label}: rendered length`);
    for (let i = 0; i < actual.length; i++) {
      if (Math.abs(actual[i] - expected[i]) > 1e-6) {
        assert.fail(
          `${label}: channel ${channel} differs at sample ${i} (step ${Math.floor(i / stepSamples)}): ` +
          `rendered ${actual[i]} but expected hits only at steps [${hitSteps.join(', ')}] (${expected[i]})`
        );
      }
    }
  }
};

/** Peak absolute amplitude within [from, to) of the left channel. */
const peakBetween = (buffer: AudioBuffer, from: number, to: number): number => {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = Math.max(0, from); i < Math.min(to, data.length); i++) {
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
};

const DRUM = makeChannel('drum-template', [], 16);
const SYNTH = makeChannel('synth-template', [], 16, { instrumentType: 'minisynth' });

// ---------------------------------------------------------------------------
// 1. 16-step channels keep their existing behaviour
// ---------------------------------------------------------------------------

describe('Phase 9C: 16-step bounce is preserved', () => {
  it('the single-hit kernel is a real, decaying transient (sanity check for the exact-match helper)', async () => {
    const kernel = await captureHitKernel(DRUM);
    assert.equal(kernel.length, expectedLength(1, 120));
    const hitSamples = Math.floor(0.35 * SAMPLE_RATE);
    assert.ok(peakBetween({ getChannelData: () => kernel } as unknown as AudioBuffer, 0, 200) > 0.3, 'audible onset');
    assert.equal(peakBetween({ getChannelData: () => kernel } as unknown as AudioBuffer, hitSamples, kernel.length), 0, 'silent after the hit window');
  });

  it('renders every active step of a 16-step channel across the requested bars, and nothing else', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('kick', [0, 4, 8, 12], 16);
    const bpm = 120;
    const { buffer, waveform, lengthBars } = await bounce(channel, bpm, 4);

    assert.equal(lengthBars, 4, 'a one-bar channel bounced with minBars=4 keeps the 4-bar stem');
    assert.equal(buffer.length, expectedLength(4, bpm));
    assert.equal(waveform.length, 32, 'waveform preview keeps its 32 peaks');

    const expected: number[] = [];
    for (let bar = 0; bar < 4; bar++) for (const s of [0, 4, 8, 12]) expected.push(bar * 16 + s);
    assertHitsExactlyAt(buffer, kernel, bpm, expected, '16-step four-on-the-floor over 4 bars');
  });

  it('bounces the default project channel exactly as before (one bar, one pass)', async () => {
    const channel = createDefaultProjectState().channels[0];
    assert.equal(channel.steps.length, 16);
    const kernel = await captureHitKernel(channel);

    const { buffer, lengthBars } = await bounce(channel, 130, 1);
    assert.equal(lengthBars, 1);
    assert.equal(buffer.length, expectedLength(1, 130), 'same length the Phase 8A workflow relied on');
    assertHitsExactlyAt(buffer, kernel, 130, [0, 4, 8, 12], 'default project channel');
  });

  it('inactive steps stay silent (no phantom hits are introduced)', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('rim', [3], 16);
    const bpm = 100;
    const { buffer } = await bounce(channel, bpm, 1);
    assertHitsExactlyAt(buffer, kernel, bpm, [3], 'single rim shot');
    assert.equal(peakBetween(buffer, 0, stepStartSample(3, bpm)), 0, 'nothing before the first hit');
  });
});

// ---------------------------------------------------------------------------
// 2. 32-step channels: the second bar must survive
// ---------------------------------------------------------------------------

describe('Phase 9C: 32-step bounce reads the whole pattern', () => {
  it('steps 16, 20 and 31 are rendered instead of being dropped', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('hat', [16, 20, 31], 32);
    const bpm = 128;
    const { buffer, lengthBars } = await bounce(channel, bpm, 1);

    assert.equal(lengthBars, 2, 'a 32-step channel renders both bars');
    assertHitsExactlyAt(buffer, kernel, bpm, [16, 20, 31], '32-step hits in bar 2 only');
    assert.equal(peakBetween(buffer, 0, stepStartSample(16, bpm)), 0, 'bar 1 is silent: nothing was folded back with % 16');
    assert.ok(peakBetween(buffer, stepStartSample(16, bpm), buffer.length) > 0.3, 'bar 2 is audible');
  });

  it('bar 1 and bar 2 content is rendered at distinct positions and not aliased onto each other', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('perc', [2, 18], 32);
    const bpm = 128;
    const { buffer, lengthBars } = await bounce(channel, bpm, 1);
    assert.equal(lengthBars, 2);
    assert.equal(buffer.length, expectedLength(2, bpm), 'step 18 is inside the stem, not cut off after bar 1');
    assertHitsExactlyAt(buffer, kernel, bpm, [2, 18], 'steps 2 and 18');
  });

  it('repeats whole 32-step passes when a longer minimum length is requested', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('clap', [16, 20, 31], 32);
    const bpm = 128;
    const { buffer, lengthBars } = await bounce(channel, bpm, 4);

    assert.equal(lengthBars, 4, 'two full 2-bar passes');
    assertHitsExactlyAt(buffer, kernel, bpm, [16, 20, 31, 48, 52, 63], 'two passes of a 32-step pattern');
  });

  it('never truncates to partial passes: a 3-bar minimum on a 2-bar loop rounds up to 4 bars', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('loop', [0, 31], 32);
    const { lengthBars, buffer } = await bounce(channel, 120, 3);
    assert.equal(lengthBars, 4);
    assertHitsExactlyAt(buffer, kernel, 120, [0, 31, 32, 63], '3-bar minimum on a 2-bar loop');
  });

  it('piano-roll notes past step 15 are rendered', async () => {
    const kernel = await captureHitKernel(SYNTH);
    const channel = makeChannel('lead', [], 16, {
      instrumentType: 'minisynth',
      notes: [makeNote('n1', 0), makeNote('n2', 17), makeNote('n3', 30)]
    });
    const bpm = 128;
    const { buffer, lengthBars } = await bounce(channel, bpm, 1);

    assert.equal(lengthBars, 2, 'content up to step 30 makes the channel two bars long');
    assertHitsExactlyAt(buffer, kernel, bpm, [0, 17, 30], 'piano-roll notes at 0, 17 and 30');
  });

  it('a note whose duration crosses the bar line extends the loop the same way playback does', async () => {
    const channel = makeChannel('pad', [], 16, {
      instrumentType: 'minisynth',
      notes: [makeNote('long', 15, 4)]
    });
    const { lengthBars } = await bounce(channel, 120, 1);
    assert.equal(lengthBars, 2);
    assert.equal(resolvePlayableContentLengthSteps(channel), 32);
  });

  it('bounce uses the same channel length resolution Song Mode uses for pattern clips', async () => {
    const kernel = await captureHitKernel(DRUM);
    for (const [total, active] of [[16, [0]], [32, [16]], [64, [63]]] as Array<[number, number[]]>) {
      const channel = makeChannel(`ch-${total}`, active, total);
      const expectedBars = resolvePlayableContentLengthSteps(channel) / STEPS_PER_BAR;
      const { lengthBars, buffer } = await bounce(channel, 120, 1);
      assert.equal(lengthBars, expectedBars, `${total}-step channel resolves to ${expectedBars} bar(s)`);
      assertHitsExactlyAt(buffer, kernel, 120, active, `${total}-step channel`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Tempo follows the project instead of a literal 130
// ---------------------------------------------------------------------------

describe('Phase 9C: bounce tempo follows project BPM', () => {
  it('step spacing and stem duration are derived from the BPM that was passed in', async () => {
    const kernel = await captureHitKernel(DRUM);
    const channel = makeChannel('kick', [0, 4, 8, 12], 16);
    for (const bpm of [90, 128, 140, 174]) {
      const { buffer, bpm: usedBpm } = await bounce(channel, bpm, 1);
      assert.equal(usedBpm, bpm);
      assert.equal(buffer.length, expectedLength(1, bpm), `stem length at ${bpm} BPM`);
      assertHitsExactlyAt(buffer, kernel, bpm, [0, 4, 8, 12], `onsets on the ${bpm} BPM grid`);
    }
  });

  it('different project tempos produce different stems (no hidden 130 BPM constant)', async () => {
    const channel = makeChannel('kick', [0, 8], 16);
    const slow = await bounce(channel, 90, 1);
    const fast = await bounce(channel, 174, 1);
    const at130 = await bounce(channel, 130, 1);

    assert.ok(slow.buffer.length > at130.buffer.length && at130.buffer.length > fast.buffer.length);
    assert.notEqual(slow.buffer.length, expectedLength(1, 130));
    assert.notEqual(fast.buffer.length, expectedLength(1, 130));
    // The second hit sits on the tempo's own grid, not on the 130 BPM grid.
    assert.ok(peakBetween(slow.buffer, stepStartSample(8, 90), stepStartSample(8, 90) + 200) > 0.3);
    assert.equal(peakBetween(slow.buffer, stepStartSample(8, 130), stepStartSample(8, 130) + 200), 0);
  });

  it('falls back to the engine transport tempo (synced from meta.bpm) when no valid BPM is supplied', async () => {
    engine.bpm = 96;
    const channel = makeChannel('kick', [0], 16);
    const { buffer, bpm } = await bounce(channel, Number.NaN, 1);
    assert.equal(bpm, 96);
    assert.equal(buffer.length, expectedLength(1, 96));
  });

  it('clamps out-of-range tempos to the same 20-300 BPM range the transport enforces', async () => {
    const channel = makeChannel('kick', [0], 16);
    assert.equal((await bounce(channel, 5, 1)).bpm, 20);
    assert.equal((await bounce(channel, 999, 1)).bpm, 300);
  });
});

// ---------------------------------------------------------------------------
// 4. Clip metadata and audio duration agree
// ---------------------------------------------------------------------------

describe('Phase 9C: PlaylistClip metadata matches the rendered audio', () => {
  it('the returned lengthBars converts to exactly the rendered duration at the bounce tempo', async () => {
    const cases: Array<{ channel: Channel; bpm: number; minBars: number }> = [
      { channel: makeChannel('a', [0, 4, 8, 12], 16), bpm: 128, minBars: 4 },
      { channel: makeChannel('b', [16, 20, 31], 32), bpm: 128, minBars: 4 },
      { channel: makeChannel('c', [16, 20, 31], 32), bpm: 95, minBars: 1 },
      { channel: makeChannel('d', [63], 64), bpm: 150, minBars: 4 },
      { channel: makeChannel('e', [], 16, { instrumentType: 'minisynth', notes: [makeNote('n', 40)] }), bpm: 110, minBars: 4 }
    ];

    for (const { channel, bpm, minBars } of cases) {
      const { buffer, lengthBars, bpm: usedBpm } = await bounce(channel, bpm, minBars);
      const expectedSeconds = lengthBars * 4 * (60 / usedBpm);
      assert.ok(Number.isInteger(lengthBars), 'clip lengths stay on whole bars');
      assert.ok(lengthBars >= minBars, 'the stem is never shorter than the requested minimum');
      assert.ok(
        Math.abs(buffer.duration - expectedSeconds) < 1 / SAMPLE_RATE,
        `${channel.id}: metadata ${expectedSeconds.toFixed(4)}s vs audio ${buffer.duration.toFixed(4)}s`
      );
      // Song Mode plays an audio clip for lengthBars * 4 beats at the project tempo:
      // the whole stem is consumed and nothing past the clip end exists to be dropped.
      const playbackSeconds = lengthBars * 4 * (60 / bpm);
      assert.ok(Math.abs(playbackSeconds - buffer.duration) < 1 / SAMPLE_RATE);
    }
  });

  it('the offline context is sized to the returned metadata, not to a fixed 4 bars', async () => {
    const channel = makeChannel('hat', [16, 31], 32);
    const { lengthBars, bpm } = await bounce(channel, 128, 1);
    assert.equal(FakeOfflineAudioContext.created.length, 1);
    const ctx = FakeOfflineAudioContext.created[0];
    assert.equal(lengthBars, 2);
    assert.equal(ctx.length, expectedLength(lengthBars, bpm));
    assert.notEqual(ctx.length, expectedLength(4, bpm));
    assert.equal(ctx.sampleRate, SAMPLE_RATE);
    assert.equal(ctx.numberOfChannels, 2);
  });

  it('the last hit of the pattern is inside the rendered buffer', async () => {
    const channel = makeChannel('tail', [31], 32);
    const bpm = 128;
    const { buffer } = await bounce(channel, bpm, 1);
    const lastOnset = stepStartSample(31, bpm);
    assert.ok(lastOnset < buffer.length);
    assert.ok(peakBetween(buffer, lastOnset, lastOnset + 200) > 0.3);
  });
});

// ---------------------------------------------------------------------------
// 5. The Playlist caller wires project timing through (no literal 130 / % 16)
// ---------------------------------------------------------------------------

describe('Phase 9C: UI caller follows project timing', () => {
  const engineSource = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
  const playlistSource = readFileSync(new URL('../components/PlaylistArranger.tsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

  const bounceFnStart = engineSource.indexOf('public async bounceChannelToAudioClip(');
  const bounceFnEnd = engineSource.indexOf('public getMasterLoudnessMetrics()', bounceFnStart);
  const bounceFn = engineSource.slice(bounceFnStart, bounceFnEnd);

  it('the engine bounce path resolves steps through the channel loop length, never % 16', () => {
    assert.ok(bounceFnStart > 0 && bounceFnEnd > bounceFnStart, 'bounce function located');
    assert.doesNotMatch(bounceFn, /%\s*16\b/, 'no hardcoded 16-step wrap in the bounce step-resolution path');
    assert.match(bounceFn, /resolvePlayableContentLengthSteps\(channel\)/);
    assert.match(bounceFn, /s % loopLengthSteps/);
    assert.doesNotMatch(bounceFn, /bpm:\s*number\s*=\s*130/, 'no 130 BPM default on the engine API');
  });

  it('PlaylistArranger passes the project BPM and the rendered length to the clip', () => {
    const handlerStart = playlistSource.indexOf('const handleBounceTrack');
    const handlerEnd = playlistSource.indexOf('const handleAddMarker', handlerStart);
    const handler = playlistSource.slice(handlerStart, handlerEnd);

    assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'bounce handler located');
    assert.doesNotMatch(handler, /\b130\b/, 'no literal 130 BPM in the Bounce-In-Place caller');
    assert.match(handler, /bounceChannelToAudioClip\(channel, bpm, MIN_BOUNCE_BARS\)/);
    assert.match(handler, /const \{ buffer, waveform, lengthBars \} = await audioEngine\.bounceChannelToAudioClip/);
    assert.doesNotMatch(handler, /lengthBars:\s*4\b/, 'clip length is no longer a fixed 4 bars');
    assert.match(handler, /^\s*lengthBars,\s*$/m, 'clip length comes from the rendered audio');
    assert.match(playlistSource, /^\s*bpm: number;\s*$/m, 'the component declares a bpm prop');
  });

  it('App feeds the project tempo from project state into the Playlist', () => {
    const start = appSource.indexOf('<PlaylistArranger');
    const end = appSource.indexOf('/>', start);
    const usage = appSource.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.match(usage, /bpm=\{projectState\.meta\.bpm\}/);
  });
});
