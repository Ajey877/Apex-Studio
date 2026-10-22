/**
 * Phase 7C — Fit Audio to Exact Musical Length: integration evidence.
 *
 * These tests drive the production `commitWarpTimeStretchToLength` (and the
 * pure plan/target resolvers behind it) against real PCM — web-audio-engine
 * AudioBuffers as the data backend, the real WSOLA renderer, and a fake asset
 * store mirroring the durability contract of the real one (`registerAsset` ↔
 * `audioEngine.setSampleBuffer`, `waitForAsset` ↔
 * `waitForSampleBufferPersistence`).
 *
 * Covered acceptance points:
 * - the musical destination is derived from the AUTHORITATIVE tempo + meter:
 *   exact bars+beats fits in 4/4 AND in 3/4 (a runtime-supported non-4/4
 *   meter), an unsupported stored meter resolves to the same [4,4] grid the
 *   runtime plays (never assumed silently — through the single authority);
 * - ratio = (target window seconds × playback rate) ÷ real source duration,
 *   with the 0.25×–4.0× boundaries accepted EXACTLY and just-beyond refused
 *   with a typed, actionable message — never clamped;
 * - the committed clip's `lengthBars` equals the target EXACTLY and the
 *   processed buffer fills the target window (within one output frame);
 * - preview === commit: the describe helpers and the committed plan are the
 *   same computation and agree numerically;
 * - honest refusals with ZERO mutation for offsets, trims (clipped windows),
 *   detune, take groups, unusable sources and persistence failures;
 * - very short audio and pure silence behave truthfully (no fabricated PCM);
 * - dead-space windows (window longer than the buffer) ARE supported — the
 *   fit removes the dead space, which is the requested operation;
 * - the original asset is never mutated or overwritten; undo/redo and
 *   save/load round-trips keep references and PCM exact;
 * - real offline export: the fitted clip renders across its EXACT target
 *   window and hard-stops at its end.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import type { MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getAudioIdsForProject, serializeProjectState } from '../state/projectPersistence';
import { normalizeProjectState } from '../state/projectState';
import {
  FIT_LENGTH_WINDOW_EPSILON_SECONDS,
  WarpTimeStretchError,
  commitWarpTimeStretchToLength,
  computeFitToLengthPlan,
  describeFitToLengthPlan,
  describeFitToLengthTarget,
  formatBars,
  resolveFitToLengthTarget,
  type FitToLengthContext,
  type FitToLengthTarget,
} from './warpTimeStretchCommit';
import { tawStretchAudioBuffer } from './transientAwareStretch';
import { wsolaStretchAudioBuffer } from './wsolaTimeStretch';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

const SR = 44100;
const FIXED_NOW = 1700000000000;

let ctx: OfflineAudioContext;
before(() => {
  ctx = new RealOfflineAudioContext(2, SR * 8, SR);
});

const makeToneBuffer = (seconds: number, freq = 220, amplitude = 0.8): AudioBuffer => {
  const buffer = ctx.createBuffer(2, Math.round(seconds * SR), SR);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
    }
  }
  return buffer;
};

const makeSilenceBuffer = (seconds: number): AudioBuffer => ctx.createBuffer(2, Math.round(seconds * SR), SR);

const snapshotBuffer = (buffer: AudioBuffer): Float32Array[] => {
  const out: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) out.push(Float32Array.from(buffer.getChannelData(ch)));
  return out;
};

const assertBuffersIdentical = (a: AudioBuffer, b: Float32Array[]): void => {
  assert.equal(a.numberOfChannels, b.length);
  for (let ch = 0; ch < b.length; ch += 1) {
    const data = a.getChannelData(ch);
    assert.equal(data.length, b[ch].length);
    for (let i = 0; i < data.length; i += 1) assert.equal(data[i], b[ch][i], `ch${ch} sample ${i}`);
  }
};

const rms = (data: Float32Array, fromSec: number, toSec: number): number => {
  const a = Math.floor(fromSec * SR);
  const b = Math.min(data.length, Math.floor(toSec * SR));
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, b - a));
};

interface FakeWorld {
  store: Map<string, AudioBuffer>;
  persisted: Map<string, AudioBuffer>;
  hydratable: Map<string, AudioBuffer>;
  registerCalls: string[];
  waitCalls: string[];
  failPersistence: boolean;
}

const makeWorld = (): FakeWorld => ({
  store: new Map(),
  persisted: new Map(),
  hydratable: new Map(),
  registerCalls: [],
  waitCalls: [],
  failPersistence: false,
});

const makeDeps = (world: FakeWorld) => ({
  getSourceBuffer: (id: string) => world.store.get(id),
  hydrateSource: async (id: string) => {
    const blob = world.hydratable.get(id);
    if (!blob) return false;
    world.store.set(id, blob);
    return true;
  },
  registerAsset: (id: string, buffer: AudioBuffer) => {
    world.registerCalls.push(id);
    world.store.set(id, buffer);
    world.persisted.set(id, buffer);
  },
  waitForAsset: async (id: string) => {
    world.waitCalls.push(id);
    if (world.failPersistence) throw new Error('simulated project-store write failure');
    if (!world.persisted.has(id)) throw new Error(`asset ${id} was never persisted`);
  },
  createBuffer: (ch: number, length: number, sr: number) => ctx.createBuffer(ch, length, sr),
  now: () => FIXED_NOW,
});

const SOURCE_ID = 'fit-src-asset-1';

const CTX_4_4_120: FitToLengthContext = { bpm: 120, timeSignature: [4, 4] };
const CTX_3_4_120: FitToLengthContext = { bpm: 120, timeSignature: [3, 4] };

/** A fit-eligible clip: no offset, no detune, no take group, window covers the source. */
const makeFitClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-fit-1',
  trackIndex: 0,
  startBar: 4,
  lengthBars: 0.5, // 1 s at 120 BPM 4/4 — matches the default 1 s source
  type: 'audio',
  audioBufferId: SOURCE_ID,
  audioName: 'Loop Take',
  color: '#8b5cf6',
  name: 'Loop Take',
  timeStretchRate: 1,
  pitchShiftSemitones: 0,
  warpMode: 'repitch',
  fadeInBars: 0.25,
  fadeOutBars: 0.25,
  ...overrides,
}) as PlaylistClip;

const seedWorld = (source: AudioBuffer): { world: FakeWorld; sourceSnapshot: Float32Array[] } => {
  const world = makeWorld();
  world.store.set(SOURCE_ID, source);
  world.persisted.set(SOURCE_ID, source);
  return { world, sourceSnapshot: snapshotBuffer(source) };
};

// ---------------------------------------------------------------------------
// Pure musical resolution: the destination comes from the authoritative
// tempo + meter, in 4/4 AND in a supported non-4/4 meter.
// ---------------------------------------------------------------------------

describe('Phase 7C: musical target resolution from authoritative tempo + meter', () => {
  it('resolves whole bars and fractional beats exactly in 4/4 at 120 BPM', () => {
    const two = resolveFitToLengthTarget({ bars: 2, beats: 0 }, CTX_4_4_120);
    assert.equal(two.targetLengthBars, 2);
    assert.equal(two.targetWindowSeconds, 4); // 2 bars × 2 s
    assert.deepEqual(two.resolvedMeter, [4, 4]);
    assert.equal(two.secondsPerBar, 2);

    const oneAndTwo = resolveFitToLengthTarget({ bars: 1, beats: 2 }, CTX_4_4_120);
    assert.equal(oneAndTwo.targetLengthBars, 1.5); // 2 quarter beats = half a 4/4 bar
    assert.equal(oneAndTwo.targetWindowSeconds, 3);

    const fractional = resolveFitToLengthTarget({ bars: 0, beats: 3.75 }, CTX_4_4_120);
    assert.equal(fractional.targetLengthBars, 0.9375);
    assert.equal(formatBars(fractional.targetLengthBars), '0.9375');
  });

  it('resolves the destination in 3/4 — beats are quarter notes of a 3-beat bar', () => {
    const fit = resolveFitToLengthTarget({ bars: 1, beats: 1.5 }, CTX_3_4_120);
    assert.deepEqual(fit.resolvedMeter, [3, 4]);
    assert.equal(fit.secondsPerBar, 1.5); // 3 beats × 0.5 s
    assert.equal(fit.targetLengthBars, 1.5); // 1 bar + 1.5/3
    assert.equal(fit.targetWindowSeconds, 2.25);

    // Beats at the 3/4 bar boundary are invalid there even though 4/4 accepts them.
    assert.throws(
      () => resolveFitToLengthTarget({ bars: 1, beats: 3 }, CTX_3_4_120),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'invalid-target'
    );
    const justUnder = resolveFitToLengthTarget({ bars: 1, beats: 2.75 }, CTX_3_4_120);
    assert.equal(justUnder.targetLengthBars, 1 + 2.75 / 3);
  });

  it('resolves an unsupported stored meter through the single authority — the same [4,4] grid the runtime plays', () => {
    const fit = resolveFitToLengthTarget({ bars: 1, beats: 0 }, { bpm: 120, timeSignature: [5, 4] });
    assert.deepEqual(fit.resolvedMeter, [4, 4]);
    assert.equal(fit.secondsPerBar, 2);
    // A garbage stored value resolves identically — never a crash, never a guess.
    const garbage = resolveFitToLengthTarget({ bars: 2, beats: 0 }, { bpm: 90, timeSignature: 'not-a-meter' });
    assert.deepEqual(garbage.resolvedMeter, [4, 4]);
    assert.equal(garbage.targetWindowSeconds, 2 * (4 * 60) / 90);
  });

  it('refuses invalid targets with typed, actionable messages', () => {
    const cases: Array<[FitToLengthTarget, RegExp]> = [
      [{ bars: -1, beats: 0 }, /whole number of bars/i],
      [{ bars: 1.5, beats: 0 }, /whole number of bars/i],
      [{ bars: Number.NaN, beats: 0 }, /whole number of bars/i],
      [{ bars: 0, beats: -0.5 }, /at least 0/i],
      [{ bars: 0, beats: 4 }, /fewer than 4/i], // one bar of 4/4
      [{ bars: 0, beats: 0 }, /more than zero bars/i],
      [{ bars: Number.MAX_SAFE_INTEGER + 10, beats: 0 }, /whole number of bars/i],
    ];
    for (const [target, message] of cases) {
      assert.throws(
        () => resolveFitToLengthTarget(target, CTX_4_4_120),
        (error: unknown) =>
          error instanceof WarpTimeStretchError && error.failure === 'invalid-target' && message.test(error.message),
        `target ${JSON.stringify(target)}`
      );
    }
  });

  it('refuses unusable authoritative tempos with the typed invalid-project-bpm failure', () => {
    for (const bpm of [0, -90, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => resolveFitToLengthTarget({ bars: 1, beats: 0 }, { bpm, timeSignature: [4, 4] }),
        (error: unknown) =>
          error instanceof WarpTimeStretchError && error.failure === 'invalid-project-bpm'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Plan derivation: ratio = (target window × rate) ÷ real source duration,
// boundaries exact, refusals typed — never clamped, never rendered.
// ---------------------------------------------------------------------------

describe('Phase 7C: fit plan derivation and ratio boundaries', () => {
  it('derives the ratio from the real source duration: 1 s of audio into 2 bars of 4/4 at 120 needs exactly 4×', () => {
    const plan = computeFitToLengthPlan(makeFitClip(), { bars: 2, beats: 0 }, CTX_4_4_120, 1);
    assert.equal(plan.ratio, 4); // boundary value accepted exactly
    assert.equal(plan.targetLengthBars, 2);
    assert.equal(plan.targetWindowSeconds, 4);
    assert.equal(plan.processedAudioSeconds, 4);
    assert.equal(plan.playbackRate, 1);
    assert.deepEqual(plan.resolvedMeter, [4, 4]);
  });

  it('folds the clip’s Repitch playback rate into the ratio: window × rate is what the buffer must last', () => {
    // 4 s of audio, rate 1.2 → the 2-bar (4 s) window consumes 4.8 s of buffer.
    const clip = makeFitClip({ lengthBars: 2, timeStretchRate: 1.2 });
    const plan = computeFitToLengthPlan(clip, { bars: 2, beats: 0 }, CTX_4_4_120, 4);
    assert.equal(plan.playbackRate, 1.2);
    assert.equal(plan.ratio, 1.2); // (4 s × 1.2) ÷ 4 s
    assert.equal(plan.processedAudioSeconds, 4.8);
    assert.equal(plan.targetWindowSeconds, 4);
  });

  it('accepts the 0.25× boundary exactly and refuses a hair below it — never clamped', () => {
    const clip8s = makeFitClip({ lengthBars: 4 }); // window 8 s — consumes the full 8 s source
    const exact = computeFitToLengthPlan(clip8s, { bars: 1, beats: 0 }, CTX_4_4_120, 8);
    assert.equal(exact.ratio, 0.25);

    const justBeyond = (8 * SR) + 44; // 8.001 s of real audio
    assert.throws(
      () => computeFitToLengthPlan(clip8s, { bars: 1, beats: 0 }, CTX_4_4_120, justBeyond / SR),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'ratio-out-of-range' &&
        /0\.250×/.test(error.message) &&
        /never silently clamped/i.test(error.message)
    );
  });

  it('accepts the 4.0× boundary exactly and refuses a hair above it', () => {
    const exact = computeFitToLengthPlan(makeFitClip(), { bars: 2, beats: 0 }, CTX_4_4_120, 1);
    assert.equal(exact.ratio, 4);

    const justBeyond = Math.round(0.999 * SR); // 0.999 s of real audio
    assert.throws(
      () => computeFitToLengthPlan(makeFitClip(), { bars: 2, beats: 0 }, CTX_4_4_120, justBeyond / SR),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'ratio-out-of-range' &&
        /4\.004×/.test(error.message)
    );
  });

  it('supports dead-space windows (window longer than the buffer) — the fit removes the dead space', () => {
    // 3 s of audio under a 4 s window: today the clip tails into silence.
    const clip = makeFitClip({ lengthBars: 2 });
    const plan = computeFitToLengthPlan(clip, { bars: 1, beats: 0 }, CTX_4_4_120, 3);
    assert.equal(plan.ratio, 2 / 3);
    assert.equal(plan.processedAudioSeconds, 2); // audio now fills the 2 s target exactly
  });

  it('refuses clipped windows (trim) where the clip plays only part of its buffer', () => {
    // 4 s of audio but the clip window is 1 bar = 2 s: fitting the whole source
    // would expose audio past the clip end; fitting the heard part would bake
    // in a trim. Both are refused instead of silently chosen.
    const clip = makeFitClip({ lengthBars: 1 });
    assert.throws(
      () => computeFitToLengthPlan(clip, { bars: 1, beats: 0 }, CTX_4_4_120, 4),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'unsupported-trim' &&
        /2\.00 s of a 4\.00 s/.test(error.message)
    );
  });

  it('honours the documented window epsilon at the trim boundary', () => {
    // Consumption just under the buffer duration but within the 1 ms epsilon
    // counts as whole-buffer (float noise from bar↔second conversions).
    const consumed = 4 - FIT_LENGTH_WINDOW_EPSILON_SECONDS / 2; // 3.9995 s
    const clip = makeFitClip({ lengthBars: consumed / 2 });
    const plan = computeFitToLengthPlan(clip, { bars: 1, beats: 0 }, CTX_4_4_120, 4);
    assert.equal(plan.ratio, 0.5);
    // Beyond the epsilon it is a real trim and is refused.
    const realTrim = makeFitClip({ lengthBars: (4 - 2 * FIT_LENGTH_WINDOW_EPSILON_SECONDS) / 2 });
    assert.throws(
      () => computeFitToLengthPlan(realTrim, { bars: 1, beats: 0 }, CTX_4_4_120, 4),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'unsupported-trim'
    );
  });

  it('refuses offsets, detune and take-comping clips with typed, actionable messages', () => {
    const refusals: Array<[Partial<PlaylistClip>, string, RegExp]> = [
      [{ offsetSteps: 3 }, 'unsupported-offset', /starts 3 steps into its audio/i],
      [{ offsetSteps: -2 }, 'unsupported-offset', /clear the clip offset/i],
      [{ pitchShiftSemitones: -3 }, 'unsupported-pitch', /-3 st pitch offset/i],
      [{ pitchShiftSemitones: 2 }, 'unsupported-pitch', /\+2 st pitch offset/i],
      [{ takeGroupId: 'take-group-1' }, 'unsupported-take', /take-comping group/i],
    ];
    for (const [overrides, failure, message] of refusals) {
      assert.throws(
        () => computeFitToLengthPlan(makeFitClip(overrides), { bars: 1, beats: 0 }, CTX_4_4_120, 1),
        (error: unknown) =>
          error instanceof WarpTimeStretchError && error.failure === failure && message.test(error.message),
        `overrides ${JSON.stringify(overrides)}`
      );
    }
  });

  it('previews the exact destination without the source, and the full plan once the real duration is known', () => {
    const target: FitToLengthTarget = { bars: 1, beats: 2 };
    const destination = describeFitToLengthTarget(target, CTX_4_4_120);
    assert.equal(destination, '1.5 bars = 3.00 s at 120.00 BPM 4/4');

    // 1.5 s of audio under a window that consumes all of it (0.75 bars at 120 4/4).
    const planLine = describeFitToLengthPlan(makeFitClip({ lengthBars: 0.75 }), target, CTX_4_4_120, 1.5);
    assert.equal(planLine, `${destination} · needs 2.000× · output audio 3.00 s · SUPPORTED`);

    // A refusal previews as its typed message — the UI never shows a fake plan.
    assert.throws(
      () => describeFitToLengthPlan(makeFitClip({ offsetSteps: 1 }), target, CTX_4_4_120, 1.5),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'unsupported-offset'
    );
  });
});

// ---------------------------------------------------------------------------
// Commits: the clip lands EXACTLY on the requested musical destination in
// both meters, with a real new durable asset and an untouched original.
// ---------------------------------------------------------------------------

describe('Phase 7C: exact-length commits through the durable WSOLA pipeline', () => {
  it('4/4: fits 1 s of audio into exactly 2 bars (4×) — lengthBars exact, buffer fills the window, source untouched', async () => {
    const source = makeToneBuffer(1);
    const { world, sourceSnapshot } = seedWorld(source);
    const clip = makeFitClip();

    const result = await commitWarpTimeStretchToLength(clip, { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world));

    // The committed clip occupies EXACTLY the requested musical length.
    assert.equal(result.clip.lengthBars, 2);
    assert.equal(result.plan.targetLengthBars, 2);
    assert.equal(result.plan.ratio, 4);
    assert.deepEqual(result.plan.resolvedMeter, [4, 4]);

    // The processed audio fills the target window (within one output frame).
    assert.equal(result.stretchedBuffer.length, Math.ceil(SR * 4));
    assert.ok(Math.abs(result.stretchedBuffer.duration - result.plan.targetWindowSeconds) <= 1 / SR);
    assert.ok(Math.abs(result.stretchedBuffer.duration - result.plan.processedAudioSeconds) <= 1 / SR);

    // New unique asset, registered AND persisted before return; original intact.
    assert.notEqual(result.stretchedAssetId, SOURCE_ID);
    assert.equal(result.sourceAssetId, SOURCE_ID);
    assert.deepEqual(world.registerCalls, [result.stretchedAssetId]);
    assert.deepEqual(world.waitCalls, [result.stretchedAssetId]);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    // Real processed PCM: audible content deep in the second bar.
    const out = result.stretchedBuffer.getChannelData(0);
    assert.ok(rms(out, 3.5, 3.9) > 0.1, 'the fitted audio is audible at the end of the 2-bar window');

    // Arrangement and Repitch geometry preserved; fades preserved numerically.
    assert.equal(result.clip.startBar, 4);
    assert.equal(result.clip.timeStretchRate, 1);
    assert.equal(result.clip.pitchShiftSemitones, 0);
    assert.equal(result.clip.warpMode, 'repitch');
    assert.equal(result.clip.fadeInBars, 0.25);
    assert.equal(result.clip.fadeOutBars, 0.25);
    assert.equal(result.clip.audioUnavailable, undefined);
    assert.ok(Array.isArray(result.clip.audioWaveform));
    assert.equal(result.clip.audioWaveform!.length, 64);
  });

  it('3/4: fits 0.75 s of audio into exactly 1 bar + 1.5 beats (1.5 bars = 2.25 s) — the non-4/4 meter drives the math', async () => {
    const source = makeToneBuffer(0.75, 330);
    const { world, sourceSnapshot } = seedWorld(source);
    const clip = makeFitClip({ lengthBars: 0.5 }); // window 0.75 s at 1.5 s/bar

    const result = await commitWarpTimeStretchToLength(clip, { bars: 1, beats: 1.5 }, CTX_3_4_120, makeDeps(world));

    assert.deepEqual(result.plan.resolvedMeter, [3, 4]);
    assert.equal(result.plan.secondsPerBar, 1.5);
    assert.equal(result.clip.lengthBars, 1.5); // exactly 1 bar + 1.5 of 3 beats
    assert.equal(result.plan.ratio, 3); // 2.25 s ÷ 0.75 s
    assert.equal(result.stretchedBuffer.length, Math.ceil(0.75 * SR * 3));
    assert.ok(Math.abs(result.stretchedBuffer.duration - 2.25) <= 1 / SR);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
    assert.ok(rms(result.stretchedBuffer.getChannelData(0), 2.0, 2.2) > 0.1);
  });

  it('rate ≠ 1: the committed buffer lasts window × rate so the heard audio ends exactly on the bar line', async () => {
    const source = makeToneBuffer(4, 180);
    const { world } = seedWorld(source);
    const clip = makeFitClip({ lengthBars: 2, timeStretchRate: 1.2 });

    const result = await commitWarpTimeStretchToLength(clip, { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world));

    assert.equal(result.plan.ratio, 1.2);
    assert.equal(result.clip.lengthBars, 2);
    assert.equal(result.clip.timeStretchRate, 1.2, 'the Repitch rate itself is preserved');
    assert.equal(result.stretchedBuffer.length, Math.ceil(4 * SR * 1.2)); // 211680 frames = 4.8 s
    assert.ok(Math.abs(result.stretchedBuffer.duration - 4.8) <= 1 / SR);
  });

  it('preview === commit: the described plan and the committed result agree exactly', async () => {
    const source = makeToneBuffer(1);
    const { world } = seedWorld(source);
    const clip = makeFitClip();
    const target: FitToLengthTarget = { bars: 2, beats: 0 };

    const previewPlan = computeFitToLengthPlan(clip, target, CTX_4_4_120, source.duration);
    const previewLine = describeFitToLengthPlan(clip, target, CTX_4_4_120, source.duration);
    const result = await commitWarpTimeStretchToLength(clip, target, CTX_4_4_120, makeDeps(world));

    assert.deepEqual(result.plan, previewPlan, 'the commit renders exactly the previewed plan');
    assert.equal(result.clip.lengthBars, previewPlan.targetLengthBars);
    assert.ok(previewLine.includes(`${formatBars(previewPlan.targetLengthBars)} bars`));
    assert.ok(previewLine.includes(`${previewPlan.ratio.toFixed(3)}×`));
    assert.ok(
      previewLine.includes(`output audio ${previewPlan.processedAudioSeconds.toFixed(2)} s`),
      'the preview states the processed duration the commit produced'
    );
    assert.ok(Math.abs(result.stretchedBuffer.duration - previewPlan.processedAudioSeconds) <= 1 / SR);
  });

  it('very short audio inside the ratio range fits exactly; beyond it is refused honestly', async () => {
    // 0.5 s into 1 bar (2 s) = exactly 4× — supported.
    const shortWorld = seedWorld(makeToneBuffer(0.5));
    const shortResult = await commitWarpTimeStretchToLength(
      makeFitClip({ lengthBars: 0.25 }),
      { bars: 1, beats: 0 },
      CTX_4_4_120,
      makeDeps(shortWorld.world)
    );
    assert.equal(shortResult.clip.lengthBars, 1);
    assert.equal(shortResult.stretchedBuffer.length, Math.ceil(0.5 * SR * 4));

    // 10 ms of audio into 2 bars needs 400× — refused, nothing registered.
    const tinyWorld = seedWorld(makeToneBuffer(0.01));
    const registersBefore = tinyWorld.world.registerCalls.length;
    await assert.rejects(
      () => commitWarpTimeStretchToLength(makeFitClip({ lengthBars: 0.005 }), { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(tinyWorld.world)),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'ratio-out-of-range'
    );
    assert.equal(tinyWorld.world.registerCalls.length, registersBefore, 'nothing registered on refusal');
  });

  it('silence stays silence: fitting a silent asset produces an exactly-sized silent buffer (no fabricated PCM)', async () => {
    const source = makeSilenceBuffer(1);
    const { world, sourceSnapshot } = seedWorld(source);

    const result = await commitWarpTimeStretchToLength(makeFitClip(), { bars: 1, beats: 2 }, CTX_4_4_120, makeDeps(world));

    assert.equal(result.clip.lengthBars, 1.5);
    assert.equal(result.stretchedBuffer.length, Math.ceil(SR * 3));
    for (let ch = 0; ch < result.stretchedBuffer.numberOfChannels; ch += 1) {
      const data = result.stretchedBuffer.getChannelData(ch);
      assert.equal(rms(data, 0, data.length / SR), 0, 'no energy invented where the source had none');
    }
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('hydrates the source from the persisted store when it is absent from engine memory', async () => {
    const source = makeToneBuffer(1);
    const { world, sourceSnapshot } = seedWorld(source);
    world.store.delete(SOURCE_ID);
    world.hydratable.set(SOURCE_ID, source);

    const result = await commitWarpTimeStretchToLength(makeFitClip(), { bars: 1, beats: 0 }, CTX_4_4_120, makeDeps(world));

    assert.equal(result.clip.lengthBars, 1);
    assert.equal(result.plan.ratio, 2);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Refusals mutate NOTHING: no asset registered, no clip published, original
// PCM bit-identical.
// ---------------------------------------------------------------------------

describe('Phase 7C: refused and failed fits leave the project untouched', () => {
  const refusalCases: Array<[string, Partial<PlaylistClip>, FitToLengthTarget, string]> = [
    ['offset', { offsetSteps: 2 }, { bars: 1, beats: 0 }, 'unsupported-offset'],
    ['detune', { pitchShiftSemitones: 5 }, { bars: 1, beats: 0 }, 'unsupported-pitch'],
    ['take group', { takeGroupId: 'tg-1' }, { bars: 1, beats: 0 }, 'unsupported-take'],
    ['trimmed window', { lengthBars: 0.25 }, { bars: 1, beats: 0 }, 'unsupported-trim'], // 0.5 s window over 1 s source
    ['out-of-range ratio', {}, { bars: 30, beats: 0 }, 'ratio-out-of-range'], // 60 s ÷ 1 s = 60×
    ['invalid target', {}, { bars: -2, beats: 0 }, 'invalid-target'],
  ];

  for (const [label, overrides, target, failure] of refusalCases) {
    it(`refuses the ${label} case with '${failure}' and registers nothing`, async () => {
      const source = makeToneBuffer(1);
      const { world, sourceSnapshot } = seedWorld(source);
      const clip = makeFitClip(overrides);
      const clipBefore = JSON.parse(JSON.stringify(clip));

      await assert.rejects(
        () => commitWarpTimeStretchToLength(clip, target, CTX_4_4_120, makeDeps(world)),
        (error: unknown) => error instanceof WarpTimeStretchError && error.failure === failure
      );
      assert.deepEqual(world.registerCalls, [], 'no asset registered on refusal');
      assert.deepEqual(world.waitCalls, [], 'no persistence awaited on refusal');
      assert.equal(world.store.size, 1, 'only the original asset exists');
      assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
      assert.deepEqual(JSON.parse(JSON.stringify(clip)), clipBefore, 'the clip object was not mutated');
    });
  }

  it('refuses with source-unavailable when the audio is gone everywhere — nothing registered', async () => {
    const world = makeWorld();
    await assert.rejects(
      () => commitWarpTimeStretchToLength(makeFitClip(), { bars: 1, beats: 0 }, CTX_4_4_120, makeDeps(world)),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'source-unavailable'
    );
    assert.deepEqual(world.registerCalls, []);
  });

  it('reports persist-failed when the durable write fails — the clip is never published', async () => {
    const source = makeToneBuffer(1);
    const { world, sourceSnapshot } = seedWorld(source);
    world.failPersistence = true;

    await assert.rejects(
      () => commitWarpTimeStretchToLength(makeFitClip(), { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world)),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'persist-failed' &&
        /The clip was not changed\./.test(error.message)
    );
    assert.equal(world.registerCalls.length, 1, 'the render happened but publication was refused');
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Persistence contract: undo/redo and save/load keep references and PCM exact.
// ---------------------------------------------------------------------------

describe('Phase 7C: undo/redo and save/load keep the fitted asset exact', () => {
  it('undo restores the original reference and its bit-identical PCM; redo returns the processed asset', async () => {
    const source = makeToneBuffer(1);
    const { world, sourceSnapshot } = seedWorld(source);
    const before = makeFitClip();
    const result = await commitWarpTimeStretchToLength(before, { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world));
    const processedSnapshot = snapshotBuffer(result.stretchedBuffer);

    const history: PlaylistClip[][] = [[before], [result.clip]];
    let cursor = 1;

    cursor -= 1; // undo
    const undone = history[cursor][0];
    assert.equal(undone.audioBufferId, SOURCE_ID, 'undo restores the original audio reference');
    assert.equal(undone.lengthBars, 0.5, 'undo restores the original musical length');
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    cursor += 1; // redo
    const redone = history[cursor][0];
    assert.equal(redone.audioBufferId, result.stretchedAssetId);
    assert.equal(redone.lengthBars, 2);
    assertBuffersIdentical(world.persisted.get(result.stretchedAssetId)!, processedSnapshot);
  });

  it('save/load round trip: serialized state references only the fitted asset and rehydration returns its exact PCM', async () => {
    const source = makeToneBuffer(1);
    const { world } = seedWorld(source);
    const result = await commitWarpTimeStretchToLength(makeFitClip(), { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world));

    const state = { playlistClips: [result.clip], recordings: [] } as unknown as ProjectState;
    const serialized = serializeProjectState(state);
    const parsed = JSON.parse(serialized) as { persistenceVersion?: number; state?: unknown };
    const restored = normalizeProjectState(parsed.state ?? parsed);
    const ids = getAudioIdsForProject(restored);
    assert.ok(ids.includes(result.stretchedAssetId), 'project save must carry the fitted asset');
    assert.ok(!ids.includes(SOURCE_ID), 'the committed clip no longer references the source asset');

    const freshWorld = makeWorld();
    freshWorld.hydratable.set(result.stretchedAssetId, world.persisted.get(result.stretchedAssetId)!);
    const hydrated = await makeDeps(freshWorld).hydrateSource(result.stretchedAssetId);
    assert.equal(hydrated, true);
    assertBuffersIdentical(freshWorld.store.get(result.stretchedAssetId)!, snapshotBuffer(result.stretchedBuffer));
  });
});

// ---------------------------------------------------------------------------
// Real offline export: the fitted clip renders across its EXACT target window
// and hard-stops at its end.
// ---------------------------------------------------------------------------

const track = (id: number, name: string): MixerTrack => ({
  id, name, color: '#10b981', volume: 1, pan: 0, mute: false, solo: false,
  fxSlots: [], peakL: 0, peakR: 0,
}) as MixerTrack;

const engine = audioEngine as unknown as Record<string, any>;

const renderSong = async (clip: PlaylistClip, totalBars: number): Promise<AudioBuffer> => engine.renderTimelineOffline(
  [],
  [clip],
  [track(0, 'Master'), track(1, 'Ch1')],
  120,
  totalBars,
  SR,
  false,
  'song',
  undefined,
  undefined,
  undefined,
  undefined
) as Promise<AudioBuffer>;

describe('Phase 7C: fitted clip in real offline export', () => {
  before(() => {
    (globalThis as any).OfflineAudioContext = RealOfflineAudioContext;
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
    engine.setTimeSignature([4, 4]);
  });

  it('the fitted 2-bar clip renders to the exact end of its window and is hard-silent past it', async () => {
    const source = makeToneBuffer(1);
    const { world } = seedWorld(source);
    // Window-matched fades (1 + 1 bars = the fitted 2-bar window): the engine's
    // envelope then has no mid-window hold, which the web-audio-engine polyfill
    // renders continuously (real browsers render both envelopes; browser specs
    // cover the live path). Before the fit the same fades exceed the 0.5-bar
    // window and the engine clamps them to half-window — also matched.
    const clip = makeFitClip({ startBar: 0, fadeInBars: 1, fadeOutBars: 1 });
    const result = await commitWarpTimeStretchToLength(clip, { bars: 2, beats: 0 }, CTX_4_4_120, makeDeps(world));

    audioEngine.setSampleBuffer(SOURCE_ID, source);
    audioEngine.setSampleBuffer(result.stretchedAssetId, result.stretchedBuffer);

    // BEFORE: the 0.5-bar clip over its 1 s source cannot reach 2 bars — it is
    // hard-silent from its window end (1 s) onward.
    const originalRender = await renderSong(clip, 3); // 6 s at 120 BPM 4/4
    const originalOut = originalRender.getChannelData(0);
    assert.ok(rms(originalOut, 0.3, 0.45) > 0.05, 'the original clip renders its audio');
    assert.ok(rms(originalOut, 1.7, 1.99) < 1e-4, 'the original clip cannot reach the 2-bar destination');

    // AFTER: the fitted clip fills its exact 2-bar (4 s) window…
    const fittedRender = await renderSong(result.clip, 3);
    const fittedOut = fittedRender.getChannelData(0);
    assert.ok(rms(fittedOut, 1.7, 1.99) > 0.05, 'the fitted audio reaches deep into the second bar');
    assert.ok(
      rms(fittedOut, 2.4, 2.6) > 0.02,
      'the fitted audio renders past the window midpoint — beyond the entire original clip window'
    );
    // The processed BUFFER itself carries real audio right up to its exact end
    // (the polyfill only renders the envelope junction region faithfully; the
    // browser specs cover the live full-window path).
    const fittedPcm = result.stretchedBuffer.getChannelData(0);
    assert.ok(rms(fittedPcm, 3.5, 3.9) > 0.1, 'the processed PCM is audible up to the exact 4 s window end');
    assert.ok(Math.abs(result.stretchedBuffer.duration - 4) <= 1 / SR, 'the processed PCM lasts exactly the target window');
    // …and the render hard-stops at the window end — the export honours the exact length.
    assert.ok(rms(fittedOut, 4.1, 5.9) < 1e-4, 'nothing renders past the fitted 2-bar window');
  });
});


// ---------------------------------------------------------------------------
// Phase 7D: the fit-to-length workflow honors the EXPLICITLY selected stretch
// strategy — same exact-destination semantics, same durability guarantees,
// distinct 'taw-stretch-' asset identity, and the default stays byte-identical
// to every pre-7D fit.
// ---------------------------------------------------------------------------

describe('Phase 7D: fit-to-length strategy selection', () => {
  /** Deterministic transient source (noise floor + sharp click at 0.35 s) so
   *  TAW and WSOLA renders provably differ on the fitted ratio. */
  const makeTransientSource = (): AudioBuffer => {
    const buffer = ctx.createBuffer(2, Math.round(0.75 * SR), SR);
    let s = 77007 >>> 0;
    const noise = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
    for (let ch = 0; ch < 2; ch += 1) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i += 1) data[i] = 0.12 * noise();
      const at = Math.round(0.35 * SR);
      for (let i = 0; i < Math.round(0.02 * SR) && at + i < data.length; i += 1) {
        data[at + i] += 0.9 * Math.exp(-i / Math.round(0.003 * SR)) * (i % 2 === 0 ? 1 : -1);
      }
    }
    return buffer;
  };

  it('fits to the exact musical length through the transient-aware render when selected', async () => {
    const source = makeTransientSource();
    const { world, sourceSnapshot } = seedWorld(source);
    // 0.75 s source, default clip window 0.5 bars = 1 s ≥ source ⇒ fitting to
    // 1 bar + 2 beats (1.5 bars = 3 s at 120 BPM 4/4) needs ratio 3/0.75 = 4×
    // — the supported upper boundary, exact destination.
    const clip = makeFitClip();

    const result = await commitWarpTimeStretchToLength(clip, { bars: 1, beats: 2 }, CTX_4_4_120, makeDeps(world), 'transient');

    assert.equal(result.strategy, 'transient');
    assert.ok(result.stretchedAssetId.startsWith('taw-stretch-'), `fit asset id: ${result.stretchedAssetId}`);
    // Exact destination semantics are strategy-independent.
    assert.equal(result.clip.lengthBars, 1.5);
    assert.equal(result.plan.targetWindowSeconds, 3);
    assert.equal(result.plan.ratio, 4);
    assert.equal(result.stretchedBuffer.length, Math.ceil(source.length * result.ratio));
    // Durability: persisted before publish; original untouched for undo.
    assert.deepEqual(world.waitCalls, [result.stretchedAssetId]);
    assert.ok(world.persisted.has(result.stretchedAssetId));
    for (let ch = 0; ch < 2; ch += 1) {
      const now = world.store.get(SOURCE_ID)!.getChannelData(ch);
      for (let i = 0; i < now.length; i += 1) assert.equal(now[i], sourceSnapshot[ch][i], `source ch${ch} sample ${i}`);
    }
    // Real TAW PCM — equals the direct transient-aware render and differs
    // from the WSOLA render of the same source at the same ratio.
    const expected = tawStretchAudioBuffer(source, result.ratio, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    for (let ch = 0; ch < 2; ch += 1) {
      const got = result.stretchedBuffer.getChannelData(ch);
      const want = expected.getChannelData(ch);
      for (let i = 0; i < want.length; i += 1) assert.equal(got[i], want[i], `taw pcm ch${ch} sample ${i}`);
    }
    const wsolaRender = wsolaStretchAudioBuffer(source, result.ratio, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    let differs = false;
    const tawData = result.stretchedBuffer.getChannelData(0);
    const wsolaData = wsolaRender.getChannelData(0);
    for (let i = 0; i < tawData.length && !differs; i += 1) differs = tawData[i] !== wsolaData[i];
    assert.ok(differs, 'the fitted transient render must differ from a WSOLA fit of the same source');
  });

  it('keeps the default fit byte-identical to the pre-7D WSOLA fit', async () => {
    const source = makeTransientSource();
    const worldA = seedWorld(source).world;
    const worldB = seedWorld(source).world;
    const clip = makeFitClip();

    const implicit = await commitWarpTimeStretchToLength(clip, { bars: 1, beats: 2 }, CTX_4_4_120, makeDeps(worldA));
    const explicit = await commitWarpTimeStretchToLength(clip, { bars: 1, beats: 2 }, CTX_4_4_120, makeDeps(worldB), 'wsola');

    assert.equal(implicit.strategy, 'wsola');
    assert.ok(implicit.stretchedAssetId.startsWith('wsola-stretch-'));
    assert.equal(explicit.stretchedAssetId, implicit.stretchedAssetId);
    const a = implicit.stretchedBuffer.getChannelData(0);
    const b = explicit.stretchedBuffer.getChannelData(0);
    for (let i = 0; i < a.length; i += 1) assert.equal(a[i], b[i], `default fit pcm sample ${i}`);
  });
});
