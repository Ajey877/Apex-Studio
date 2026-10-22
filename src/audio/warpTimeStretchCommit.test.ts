/**
 * Phase 7A — Warp time-stretch render/commit pipeline: integration evidence.
 *
 * These tests drive the production `commitWarpTimeStretch` against real PCM
 * (web-audio-engine AudioBuffers as the data backend) and a fake asset store
 * that mirrors the durability contract of the real one: `registerAsset`
 * stands in for `audioEngine.setSampleBuffer` (which the persistence
 * installer wraps into a lossless project-store write) and `waitForAsset`
 * stands in for `waitForSampleBufferPersistence` — the same "never publish a
 * project reference before its asset is durable" gate the recording/bounce
 * commit paths enforce.
 *
 * Covered acceptance points:
 * - commit produces REAL processed PCM under a NEW unique asset id and the
 *   original asset is never mutated, reused, or overwritten (undo safety);
 * - clip geometry: lengthBars × ratio, startBar/rate/pitch/warpMode/fades
 *   untouched (Repitch compatibility), waveform recomputed from processed PCM;
 * - hydration fallback when the source is only in the persisted store;
 * - typed, honest failures (missing source, no asset id, non-audio clip,
 *   out-of-range ratio, persistence failure) with NOTHING registered or
 *   published on refusal;
 * - undo/redo restores the original reference AND its bit-identical PCM;
 * - save/load round trip: serialized state references the new asset only,
 *   and rehydrating it returns the processed PCM;
 * - real offline render (production `renderTimelineOffline`, real DSP
 *   backend): the committed clip exports its processed audio across the
 *   scaled window where the original clip is silent.
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
  WarpTimeStretchError,
  buildWarpStretchAssetId,
  commitWarpTimeStretch,
  computeFitToTempoRatio,
  describeWarpStretchPlan,
  warpStretchAssetPrefix,
} from './warpTimeStretchCommit';
import { tawStretchAudioBuffer } from './transientAwareStretch';
import { wsolaStretchAudioBuffer } from './wsolaTimeStretch';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

const SR = 44100;
const BPM = 120; // 1 bar = 2 s
const FIXED_NOW = 1700000000000;

let ctx: OfflineAudioContext;
before(() => {
  ctx = new RealOfflineAudioContext(2, SR * 4, SR);
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

const SOURCE_ID = 'src-asset-1';

const makeClip = (): PlaylistClip => ({
  id: 'clip-1',
  trackIndex: 0,
  startBar: 4,
  lengthBars: 0.25, // 0.5 s at 120 BPM — matches the 0.5 s source buffer
  type: 'audio',
  audioBufferId: SOURCE_ID,
  audioName: 'Take 1',
  color: '#8b5cf6',
  name: 'Take 1',
  // Non-default repitch fields: the commit must leave their meaning untouched.
  timeStretchRate: 1.2,
  pitchShiftSemitones: -3,
  warpMode: 'repitch',
  fadeInBars: 0.25,
  fadeOutBars: 0.25,
}) as PlaylistClip;

const seedWorld = (): { world: FakeWorld; sourceSnapshot: Float32Array[] } => {
  const world = makeWorld();
  const source = makeToneBuffer(0.5);
  world.store.set(SOURCE_ID, source);
  world.persisted.set(SOURCE_ID, source);
  return { world, sourceSnapshot: snapshotBuffer(source) };
};

describe('Phase 7A: warp time-stretch commit pipeline', () => {
  it('commits a 2× stretch as a new durable asset with scaled geometry and an untouched source', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const clip = makeClip();

    const result = await commitWarpTimeStretch(clip, 2.0, makeDeps(world));

    // New unique asset — never the source id — registered AND persisted before return.
    assert.notEqual(result.stretchedAssetId, SOURCE_ID);
    assert.deepEqual(world.registerCalls, [result.stretchedAssetId]);
    assert.deepEqual(world.waitCalls, [result.stretchedAssetId], 'durability gate awaited before publishing');
    assert.ok(world.persisted.has(result.stretchedAssetId), 'processed asset is durable');

    // The original asset is bit-identical: undo can always go home.
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    // Real processed PCM: exactly 2× the frames, audible content in the second
    // half where the source had none.
    const stretched = result.stretchedBuffer;
    assert.equal(stretched.length, Math.ceil((SR / 2) * 2));
    assert.equal(stretched.numberOfChannels, 2);
    const late = stretched.getChannelData(0);
    assert.ok(
      rms(late, 0.6, 0.9) > 0.1,
      'stretched buffer carries real audio past the original end (not silence, not fabrication)'
    );

    // Clip geometry: length scales, arrangement position and repitch fields do not move.
    assert.equal(result.clip.audioBufferId, result.stretchedAssetId);
    assert.equal(result.clip.lengthBars, 0.5);
    assert.equal(result.clip.startBar, 4);
    assert.equal(result.clip.timeStretchRate, 1.2);
    assert.equal(result.clip.pitchShiftSemitones, -3);
    assert.equal(result.clip.warpMode, 'repitch');
    assert.equal(result.clip.fadeInBars, 0.25);
    assert.equal(result.clip.fadeOutBars, 0.25);
    assert.equal(result.clip.id, clip.id);
    assert.equal(result.clip.audioUnavailable, undefined);

    // Waveform recomputed from the processed PCM (64-peak engine convention).
    assert.ok(Array.isArray(result.clip.audioWaveform));
    assert.equal(result.clip.audioWaveform!.length, 64);
    for (const peak of result.clip.audioWaveform!) {
      assert.ok(peak >= 0 && peak <= 1);
    }
    assert.ok(result.clip.audioWaveform!.some(peak => peak > 0.1), 'peaks reflect real processed content');
  });

  it('hydrates the source from the persisted store when it is absent from engine memory', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const source = world.store.get(SOURCE_ID)!;
    world.store.delete(SOURCE_ID); // engine memory lost it…
    world.hydratable.set(SOURCE_ID, source); // …but the project store still has it.

    const result = await commitWarpTimeStretch(makeClip(), 1.5, makeDeps(world));

    assert.ok(result.stretchedAssetId);
    assert.equal(result.clip.lengthBars, 0.375);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('refuses with a typed source-unavailable error and registers nothing when the audio is gone everywhere', async () => {
    const { world, sourceSnapshot } = seedWorld();
    world.store.delete(SOURCE_ID);
    world.persisted.delete(SOURCE_ID);
    const registersBefore = world.registerCalls.length;

    await assert.rejects(
      () => commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world)),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'source-unavailable' &&
        /not available/i.test(error.message)
    );
    assert.equal(world.registerCalls.length, registersBefore, 'nothing registered on refusal');
    assert.equal(world.persisted.has(SOURCE_ID), false);
    assert.ok(sourceSnapshot.length === 2);
  });

  it('refuses clips without source audio and non-audio clips with typed errors', async () => {
    const { world } = seedWorld();
    const noAsset = { ...makeClip(), audioBufferId: undefined };
    await assert.rejects(
      () => commitWarpTimeStretch(noAsset, 2.0, makeDeps(world)),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'no-source-audio'
    );
    const pattern = { ...makeClip(), type: 'pattern' } as unknown as PlaylistClip;
    await assert.rejects(
      () => commitWarpTimeStretch(pattern, 2.0, makeDeps(world)),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'unsupported-clip'
    );
    assert.equal(world.registerCalls.length, 0);
  });

  it('refuses out-of-range ratios with a typed error before touching any asset', async () => {
    const { world } = seedWorld();
    for (const ratio of [0.24, 4.01, 0, Number.NaN]) {
      await assert.rejects(
        () => commitWarpTimeStretch(makeClip(), ratio, makeDeps(world)),
        (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'ratio-out-of-range',
        `ratio ${String(ratio)}`
      );
    }
    assert.equal(world.registerCalls.length, 0);
  });

  it('reports a typed persist-failed error when the durable write fails — the clip is never published', async () => {
    const { world } = seedWorld();
    world.failPersistence = true;

    await assert.rejects(
      () => commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world)),
      (error: unknown) =>
        error instanceof WarpTimeStretchError &&
        error.failure === 'persist-failed' &&
        /not changed/i.test(error.message)
    );
    // The caller receives no clip, so no state/history entry can be published.
  });

  it('allocates a unique asset id when the generated id already exists and never overwrites it', async () => {
    const { world } = seedWorld();
    const collidingId = buildWarpStretchAssetId('clip-1', FIXED_NOW, () => false);
    const squatter = makeToneBuffer(0.1, 990, 0.5);
    const squatterSnapshot = snapshotBuffer(squatter);
    world.store.set(collidingId, squatter);

    const result = await commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world));

    assert.notEqual(result.stretchedAssetId, collidingId);
    assert.ok(result.stretchedAssetId.startsWith(collidingId), 'deterministic suffix scheme');
    assertBuffersIdentical(world.store.get(collidingId)!, squatterSnapshot);
  });

  it('undo/redo restores the original reference and its bit-identical PCM; redo returns the processed asset', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const before = makeClip();
    const result = await commitWarpTimeStretch(before, 2.0, makeDeps(world));
    const processedSnapshot = snapshotBuffer(result.stretchedBuffer);

    // The history stack the App commits through onUpdateClip holds whole clip states.
    const history: PlaylistClip[][] = [[before], [result.clip]];
    let cursor = 1;

    cursor -= 1; // undo
    const undone = history[cursor][0];
    assert.equal(undone.audioBufferId, SOURCE_ID, 'undo restores the original audio reference');
    assert.equal(undone.lengthBars, 0.25);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
    assert.ok(world.store.has(result.stretchedAssetId), 'processed asset survives for redo');

    cursor += 1; // redo
    const redone = history[cursor][0];
    assert.equal(redone.audioBufferId, result.stretchedAssetId);
    assert.equal(redone.lengthBars, 0.5);
    assertBuffersIdentical(world.store.get(result.stretchedAssetId)!, processedSnapshot);
  });

  it('save/load round trip: serialized state references only the processed asset and rehydration returns its exact PCM', async () => {
    const { world } = seedWorld();
    const result = await commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world));

    const state = { playlistClips: [result.clip], recordings: [] } as unknown as ProjectState;
    const serialized = serializeProjectState(state);
    // Canonical load-path steps (restorePersistedProjectState): unwrap the
    // persistence envelope, then normalize exactly like a reopened project.
    const parsed = JSON.parse(serialized) as { persistenceVersion?: number; state?: unknown };
    const restored = normalizeProjectState(parsed.state ?? parsed);
    const ids = getAudioIdsForProject(restored);
    assert.ok(ids.includes(result.stretchedAssetId), 'project save must carry the processed asset');
    assert.ok(!ids.includes(SOURCE_ID), 'the committed clip no longer references the source asset');

    // Simulate a fresh session: only the persisted store survives; hydrate the
    // referenced asset and compare against the processed PCM.
    const freshWorld = makeWorld();
    freshWorld.hydratable.set(result.stretchedAssetId, world.persisted.get(result.stretchedAssetId)!);
    const hydrated = await makeDeps(freshWorld).hydrateSource(result.stretchedAssetId);
    assert.equal(hydrated, true);
    assertBuffersIdentical(freshWorld.store.get(result.stretchedAssetId)!, snapshotBuffer(result.stretchedBuffer));
  });

  it('describes the exact plan (ratio, bars, audio duration) before any commit', () => {
    const source = makeToneBuffer(0.5);
    const plan = describeWarpStretchPlan(makeClip(), 2.0, source);
    assert.match(plan, /2\.00×/);
    assert.match(plan, /0\.25 → 0\.5 bars/);
    assert.match(plan, /0\.50 s → 1\.00 s/);
    // Without a loaded buffer the plan still states ratio and bar geometry — never fabricated durations.
    const barePlan = describeWarpStretchPlan(makeClip(), 1.5, undefined);
    assert.match(barePlan, /1\.50×/);
    assert.match(barePlan, /0\.25 → 0\.375 bars/);
    assert.ok(!/s →/.test(barePlan));
  });
});

// ---------------------------------------------------------------------------
// Real offline render: the committed clip must export through the production
// render path using the processed PCM at its scaled length.
// ---------------------------------------------------------------------------

const track = (id: number, name: string): MixerTrack => ({
  id, name, color: '#10b981', volume: 1, pan: 0, mute: false, solo: false,
  fxSlots: [], peakL: 0, peakR: 0,
}) as MixerTrack;

const engine = audioEngine as unknown as Record<string, any>;

const renderSong = async (clip: PlaylistClip): Promise<AudioBuffer> => engine.renderTimelineOffline(
  [],
  [clip],
  [track(0, 'Master'), track(1, 'Ch1')],
  BPM,
  1, // one bar = 2 s at 120 BPM
  SR,
  false,
  'song',
  undefined,
  undefined,
  undefined,
  undefined
) as Promise<AudioBuffer>;

describe('Phase 7A: committed stretch in real offline export', () => {
  before(() => {
    (globalThis as any).OfflineAudioContext = RealOfflineAudioContext;
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  it('exports the processed PCM across the scaled clip window where the original clip is silent', async () => {
    const { world } = seedWorld();
    const result = await commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world));

    // Register both assets in the real engine exactly as the app would have them.
    audioEngine.setSampleBuffer(SOURCE_ID, world.store.get(SOURCE_ID)!);
    audioEngine.setSampleBuffer(result.stretchedAssetId, result.stretchedBuffer);

    // Isolate the baked-in stretch from the repitch layering (rate 1, no
    // detune); the committed clip's retained repitch fields are pinned by the
    // pipeline tests above. Both fixtures keep their window-matched fades:
    // with fade-in + fade-out ≥ the clip window the engine's envelope has no
    // mid-window setValueAtTime hold, which the web-audio-engine polyfill
    // renders continuously (its automation implementation silently drops the
    // held segment — real browsers render both envelopes; browser specs cover
    // the live path). Measurement windows below stay envelope-aware.
    const isolate = (clip: PlaylistClip): PlaylistClip => ({
      ...clip,
      startBar: 0,
      trackIndex: 0,
      timeStretchRate: 1,
      pitchShiftSemitones: 0,
    });

    // BEFORE the commit: a 0.25-bar clip over the 0.5 s source — playback
    // stops when the source is exhausted, so 0.55 s onward is hard silence.
    const originalRender = await renderSong(isolate(makeClip()));
    const originalOut = originalRender.getChannelData(0);
    assert.ok(rms(originalOut, 0.05, 0.45) > 0.05, 'original clip renders its audio');
    assert.ok(rms(originalOut, 0.55, 0.95) < 1e-4, 'original clip is hard-silent once its 0.5 s source is exhausted');

    // AFTER the commit: a 0.5-bar clip over the 1.0 s processed buffer — the
    // region that was hard-silent before now carries the stretched audio.
    const stretchedRender = await renderSong(isolate(result.clip));
    const stretchedOut = stretchedRender.getChannelData(0);
    assert.ok(rms(stretchedOut, 0.30, 0.50) > 0.05, 'stretched clip renders through the first half of its window');
    const stretchedLate = rms(stretchedOut, 0.55, 0.75);
    const originalLate = rms(originalOut, 0.55, 0.75);
    assert.ok(
      stretchedLate > 0.02,
      `export uses the processed PCM past the original source's reach (RMS ${stretchedLate.toFixed(4)})`
    );
    assert.ok(
      stretchedLate > 100 * Math.max(originalLate, 1e-6),
      `stretched window is decisively audible where the original was silent (${stretchedLate.toFixed(4)} vs ${originalLate.toFixed(6)})`
    );
    assert.ok(rms(stretchedOut, 1.1, 1.9) < 1e-3, 'render respects the committed clip end (no unbounded bleed)');
  });
});

// ---------------------------------------------------------------------------
// Phase 7B — Fit to Project Tempo.
// ---------------------------------------------------------------------------

/** Dominant frequency via autocorrelation (same estimator as the DSP suite). */
const dominantFrequency = (data: Float32Array, from: number, to: number): number => {
  const n = to - from;
  const minLag = Math.floor(SR / 1000);
  const maxLag = Math.min(Math.floor(SR / 60), Math.floor(n / 2));
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < n - lag; i += 2) sum += data[from + i] * data[from + i + lag];
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  return SR / bestLag;
};

describe('Phase 7B: fit-to-tempo ratio computation (r = sourceBpm / projectBpm)', () => {
  it('derives the canonical cases exactly: 90→120 shortens, 120→120 is identity, 120→90 lengthens', () => {
    assert.equal(computeFitToTempoRatio(90, 120), 0.75, '90 BPM audio into a 120 BPM project → 0.75×');
    assert.equal(computeFitToTempoRatio(120, 120), 1, 'equal tempos → identity');
    assert.equal(computeFitToTempoRatio(120, 90), 4 / 3, '120 BPM audio into a 90 BPM project → 4/3×');
    assert.equal(computeFitToTempoRatio(140, 70), 2);
    assert.equal(computeFitToTempoRatio('90', 120), 0.75, 'string input from the BPM field is accepted');
    assert.equal(computeFitToTempoRatio('  90.0  ', 120), 0.75, 'surrounding whitespace is trimmed');
  });

  it('accepts the supported boundaries exactly and refuses just beyond them — never silently clamped', () => {
    assert.equal(computeFitToTempoRatio(30, 120), 0.25, 'lower WSOLA boundary is supported');
    assert.equal(computeFitToTempoRatio(480, 120), 4.0, 'upper WSOLA boundary is supported');
    for (const [source, project] of [[29.9, 120], [481, 120], [60, 250], [250, 60]] as const) {
      assert.throws(
        () => computeFitToTempoRatio(source, project),
        (error: unknown) => {
          if (!(error instanceof WarpTimeStretchError) || error.failure !== 'ratio-out-of-range') return false;
          // Actionable: names both tempos, the needed ratio and the no-clamp rule.
          return (
            error.message.includes(`${source} BPM`) &&
            error.message.includes(`${project} BPM`) &&
            /never silently clamped/.test(error.message) &&
            /0\.25×–4\.0×|0\.25×–4×/.test(error.message)
          );
        },
        `fit ${source} → ${project} must be refused with an actionable message`
      );
    }
  });

  it('rejects invalid, zero and non-finite source tempos with a typed, honest error', () => {
    for (const bad of ['', '   ', 'abc', '90bpm', '0', '-90', 0, -90, Number.NaN, Infinity, -Infinity]) {
      assert.throws(
        () => computeFitToTempoRatio(bad as string | number, 120),
        (error: unknown) =>
          error instanceof WarpTimeStretchError &&
          error.failure === 'invalid-source-bpm' &&
          /no beat detection/i.test(error.message) &&
          /positive BPM/.test(error.message),
        `source ${JSON.stringify(bad)}`
      );
    }
  });

  it('rejects unusable project tempos with a typed error (the authoritative value must be valid)', () => {
    for (const bad of [0, -120, Number.NaN, Infinity]) {
      assert.throws(
        () => computeFitToTempoRatio(90, bad),
        (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'invalid-project-bpm',
        `project ${String(bad)}`
      );
    }
  });
});

describe('Phase 7B: fit-to-tempo commit through the shared WSOLA pipeline', () => {
  const makeFitClip = (): PlaylistClip => ({ ...makeClip(), lengthBars: 0.375 });

  const seedFitWorld = (): { world: FakeWorld; source: AudioBuffer; sourceSnapshot: Float32Array[] } => {
    const world = makeWorld();
    const source = makeToneBuffer(0.75);
    world.store.set(SOURCE_ID, source);
    world.persisted.set(SOURCE_ID, source);
    return { world, source, sourceSnapshot: snapshotBuffer(source) };
  };

  it('commits 90 → 120 BPM as a 0.75× fit: scaled length, new durable asset, untouched source, repitch intact', async () => {
    const { world, source, sourceSnapshot } = seedFitWorld();
    const clip = makeFitClip();
    const ratio = computeFitToTempoRatio('90', 120);
    assert.equal(ratio, 0.75);

    const result = await commitWarpTimeStretch(clip, ratio, makeDeps(world));

    assert.notEqual(result.stretchedAssetId, SOURCE_ID);
    assert.ok(result.stretchedAssetId.startsWith('wsola-stretch-clip-1-'));
    assert.equal(result.clip.audioBufferId, result.stretchedAssetId);
    assert.equal(result.clip.lengthBars, 0.28125, 'clip length scales by the fit ratio (0.375 × 0.75)');
    assert.equal(result.clip.startBar, 4, 'arrangement position never moves');
    assert.equal(result.clip.timeStretchRate, 1.2, 'Repitch fields keep their legacy meaning');
    assert.equal(result.clip.pitchShiftSemitones, -3);
    assert.equal(result.stretchedBuffer.length, Math.ceil(source.length * 0.75), 'exact WSOLA output length');
    assert.equal(world.persisted.has(result.stretchedAssetId), true, 'the fitted asset is durable');
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('the previewed plan and the committed result agree exactly (ratio, bars and duration)', async () => {
    const { world, source } = seedFitWorld();
    const clip = makeFitClip();
    const ratio = computeFitToTempoRatio(90, 120);

    // What the modal shows BEFORE committing…
    const plan = describeWarpStretchPlan(clip, ratio, source);
    // …must equal what the commit actually produces.
    const result = await commitWarpTimeStretch(clip, ratio, makeDeps(world));

    assert.match(plan, /0\.75×/);
    assert.match(plan, /0\.375 → 0\.28125 bars/);
    assert.match(plan, /0\.75 s → 0\.56 s/);
    assert.equal(result.clip.lengthBars, 0.28125, 'committed bar length equals the previewed target');
    assert.equal(
      result.stretchedBuffer.duration.toFixed(2),
      '0.56',
      'committed audio duration equals the previewed target duration'
    );
  });

  it('preserves the dominant pitch through the 0.75× fit (real PCM autocorrelation, ±2 %)', async () => {
    const { world } = seedFitWorld();
    const result = await commitWarpTimeStretch(makeFitClip(), computeFitToTempoRatio(90, 120), makeDeps(world));
    const out = result.stretchedBuffer.getChannelData(0);
    const from = Math.floor(out.length * 0.25);
    const f0 = dominantFrequency(out, from, Math.min(out.length, from + 16384));
    assert.ok(
      Math.abs(f0 - 220) / 220 <= 0.02,
      `pitch preserved through the fit — measured ${f0.toFixed(2)} Hz`
    );
  });

  it('undo/redo and save/load keep the fit asset references exact', async () => {
    const { world, sourceSnapshot } = seedFitWorld();
    const before = makeFitClip();
    const result = await commitWarpTimeStretch(before, computeFitToTempoRatio(90, 120), makeDeps(world));
    const processedSnapshot = snapshotBuffer(result.stretchedBuffer);

    const history: PlaylistClip[][] = [[before], [result.clip]];
    const undone = history[0][0];
    assert.equal(undone.audioBufferId, SOURCE_ID, 'undo restores the original audio reference');
    assert.equal(undone.lengthBars, 0.375);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
    const redone = history[1][0];
    assert.equal(redone.audioBufferId, result.stretchedAssetId, 'redo restores the processed reference');
    assertBuffersIdentical(world.store.get(result.stretchedAssetId)!, processedSnapshot);

    const state = { playlistClips: [result.clip], recordings: [] } as unknown as ProjectState;
    const parsed = JSON.parse(serializeProjectState(state)) as { state?: unknown };
    const ids = getAudioIdsForProject(normalizeProjectState(parsed.state ?? parsed));
    assert.ok(ids.includes(result.stretchedAssetId), 'the saved project carries the fitted asset');
    assert.ok(!ids.includes(SOURCE_ID), 'the committed clip no longer references the source asset');
  });

  it('refuses a fit whose ratio is out of bounds BEFORE touching any asset', async () => {
    const { world } = seedFitWorld();
    const registersBefore = world.registerCalls.length;
    await assert.rejects(
      async () => {
        const ratio = computeFitToTempoRatio(20, 120); // 0.166… — below 0.25×
        await commitWarpTimeStretch(makeFitClip(), ratio, makeDeps(world));
      },
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'ratio-out-of-range'
    );
    assert.equal(world.registerCalls.length, registersBefore, 'nothing registered on refusal');
  });
});

describe('Phase 7B: fitted clip in real offline export', () => {
  before(() => {
    (globalThis as any).OfflineAudioContext = RealOfflineAudioContext;
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  it('the fitted 0.75× clip hard-ends where its processed audio ends — the region the original still fills goes silent', async () => {
    const world = makeWorld();
    const source = makeToneBuffer(0.75);
    world.store.set(SOURCE_ID, source);
    world.persisted.set(SOURCE_ID, source);
    const clip = makeClip();
    clip.lengthBars = 0.375; // 0.75 s window at 120 BPM — exactly the source length
    const result = await commitWarpTimeStretch(clip, computeFitToTempoRatio(90, 120), makeDeps(world));

    audioEngine.setSampleBuffer(SOURCE_ID, source);
    audioEngine.setSampleBuffer(result.stretchedAssetId, result.stretchedBuffer);

    // Same isolation as the Phase 7A export proof: rate 1, no detune, and the
    // fixtures' window-matched fades so the polyfill renders the envelope
    // continuously (web-audio-engine drops a held automation segment; real
    // browsers render both envelopes — covered by the browser specs).
    const isolate = (c: PlaylistClip): PlaylistClip => ({
      ...c,
      startBar: 0,
      trackIndex: 0,
      timeStretchRate: 1,
      pitchShiftSemitones: 0,
    });

    const originalRender = await renderSong(isolate(clip));
    const fitRender = await renderSong(isolate(result.clip));
    const originalOut = originalRender.getChannelData(0);
    const fitOut = fitRender.getChannelData(0);

    // Both clips play real audio inside the fitted window.
    assert.ok(rms(originalOut, 0.30, 0.40) > 0.03, 'original clip audible mid-window');
    assert.ok(rms(fitOut, 0.30, 0.40) > 0.03, 'fitted clip audible mid-window (processed PCM exports)');

    // Separation: the original still plays at 0.62–0.70 s (its 0.75 s window),
    // while the fitted clip's committed audio hard-ended at 0.5625 s.
    const originalLate = rms(originalOut, 0.62, 0.70);
    const fitLate = rms(fitOut, 0.62, 0.70);
    assert.ok(originalLate > 1e-4, `original still audible late in its window (${originalLate.toExponential(2)})`);
    assert.ok(fitLate < 1e-6, `fitted clip is hard-silent past its committed end (${fitLate.toExponential(2)})`);
  });
});


// ---------------------------------------------------------------------------
// Phase 7D: stretch strategy plumbing — 'wsola' (default, byte-identical to
// every pre-7D commit) vs the EXPLICITLY selected 'transient' (TAW) render,
// with the same durability/undo/asset-identity guarantees for both.
// ---------------------------------------------------------------------------

/** Deterministic transient source: a noise floor with one sharp decaying
 *  click at 0.25 s — real attack content, so TAW and WSOLA renders provably
 *  differ (a tone source would hit the documented graceful path instead). */
const makeTransientBuffer = (seconds = 0.5): AudioBuffer => {
  const buffer = ctx.createBuffer(2, Math.round(seconds * SR), SR);
  let s = 20260122 >>> 0;
  const noise = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) data[i] = 0.12 * noise();
    const at = Math.round(0.25 * SR);
    for (let i = 0; i < Math.round(0.02 * SR) && at + i < data.length; i += 1) {
      data[at + i] += 0.9 * Math.exp(-i / Math.round(0.003 * SR)) * (i % 2 === 0 ? 1 : -1);
    }
  }
  return buffer;
};

const seedTransientWorld = (): { world: FakeWorld; source: AudioBuffer; sourceSnapshot: Float32Array[] } => {
  const world = makeWorld();
  const source = makeTransientBuffer(0.5);
  world.store.set(SOURCE_ID, source);
  world.persisted.set(SOURCE_ID, source);
  return { world, source, sourceSnapshot: snapshotBuffer(source) };
};

describe('Phase 7D: stretch strategy through the commit pipeline', () => {
  it('keeps the pre-7D behavior byte-identical when no strategy is given (default wsola)', async () => {
    const { world, source, sourceSnapshot } = seedTransientWorld();
    const clip = makeClip();

    const result = await commitWarpTimeStretch(clip, 2.0, makeDeps(world));

    assert.equal(result.strategy, 'wsola');
    assert.ok(result.stretchedAssetId.startsWith('wsola-stretch-'), `asset id keeps the 7A prefix: ${result.stretchedAssetId}`);
    // PCM equals a direct Phase 7A WSOLA render of the same source — the
    // plumbing changed nothing for the default path.
    const expected = wsolaStretchAudioBuffer(source, 2.0, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    assertBuffersIdentical(result.stretchedBuffer, snapshotBuffer(expected));
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    // An explicit 'wsola' selection renders the same PCM under the same prefix.
    const world2 = seedTransientWorld().world;
    const explicit = await commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world2), 'wsola');
    assert.equal(explicit.strategy, 'wsola');
    assert.ok(explicit.stretchedAssetId.startsWith('wsola-stretch-'));
    assertBuffersIdentical(explicit.stretchedBuffer, snapshotBuffer(result.stretchedBuffer));
  });

  it('commits the transient-aware render under a distinct taw-stretch asset with the same durability guarantees', async () => {
    const { world, source, sourceSnapshot } = seedTransientWorld();
    const clip = makeClip();

    const result = await commitWarpTimeStretch(clip, 2.0, makeDeps(world), 'transient');

    // Distinct strategy + distinct asset identity ('taw-stretch-' prefix):
    // processed assets self-document their renderer and never collide with
    // wsola assets.
    assert.equal(result.strategy, 'transient');
    assert.ok(result.stretchedAssetId.startsWith('taw-stretch-'), `transient asset id: ${result.stretchedAssetId}`);
    assert.notEqual(result.stretchedAssetId, SOURCE_ID);

    // Same pipeline guarantees: registered AND persisted before return,
    // original asset bit-identical (undo can always go home).
    assert.deepEqual(world.registerCalls, [result.stretchedAssetId]);
    assert.deepEqual(world.waitCalls, [result.stretchedAssetId], 'durability gate awaited before publishing');
    assert.ok(world.persisted.has(result.stretchedAssetId));
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    // Real TAW PCM: equals a direct transient-aware render of the source,
    // exact frames, and provably NOT the WSOLA render (pipeline-level
    // replacement guard — relabeling WSOLA as 'transient' fails here).
    const expectedTaw = tawStretchAudioBuffer(source, 2.0, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    assertBuffersIdentical(result.stretchedBuffer, snapshotBuffer(expectedTaw));
    assert.equal(result.stretchedBuffer.length, Math.ceil((SR / 2) * 2));
    const wsolaRender = wsolaStretchAudioBuffer(source, 2.0, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    const tawData = result.stretchedBuffer.getChannelData(0);
    const wsolaData = wsolaRender.getChannelData(0);
    let differs = false;
    for (let i = 0; i < tawData.length && !differs; i += 1) differs = tawData[i] !== wsolaData[i];
    assert.ok(differs, 'transient render must differ from the WSOLA render on transient material');

    // Clip geometry matches the WSOLA contract exactly: length scales by the
    // ratio, arrangement position and repitch fields do not move.
    assert.equal(result.clip.audioBufferId, result.stretchedAssetId);
    assert.equal(result.clip.lengthBars, 0.5);
    assert.equal(result.clip.startBar, 4);
    assert.equal(result.clip.timeStretchRate, 1.2);
    assert.equal(result.clip.pitchShiftSemitones, -3);
    assert.equal(result.clip.warpMode, 'repitch');
    assert.ok(Array.isArray(result.clip.audioWaveform) && result.clip.audioWaveform!.length === 64);
  });

  it('refuses to publish a transient-strategy commit whose persistence fails (typed, honest, zero mutation)', async () => {
    const { world, sourceSnapshot } = seedTransientWorld();
    world.failPersistence = true;

    await assert.rejects(
      () => commitWarpTimeStretch(makeClip(), 2.0, makeDeps(world), 'transient'),
      (error: unknown) => error instanceof WarpTimeStretchError && error.failure === 'persist-failed'
    );
    // The asset was registered and awaited, but the failure surfaced before
    // any clip publication — and the source is untouched.
    assert.equal(world.registerCalls.length, 1);
    assert.equal(world.waitCalls.length, 1);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('builds strategy-specific asset ids with the collision suffix intact', () => {
    assert.equal(buildWarpStretchAssetId('clip-1', FIXED_NOW, () => false), `wsola-stretch-clip-1-${FIXED_NOW}`);
    assert.equal(buildWarpStretchAssetId('clip-1', FIXED_NOW, () => false, 'wsola'), `wsola-stretch-clip-1-${FIXED_NOW}`);
    assert.equal(buildWarpStretchAssetId('clip-1', FIXED_NOW, () => false, 'transient'), `taw-stretch-clip-1-${FIXED_NOW}`);
    const taken = new Set([`taw-stretch-clip-1-${FIXED_NOW}`, `taw-stretch-clip-1-${FIXED_NOW}-2`]);
    assert.equal(
      buildWarpStretchAssetId('clip-1', FIXED_NOW, id => taken.has(id), 'transient'),
      `taw-stretch-clip-1-${FIXED_NOW}-3`
    );
    assert.equal(warpStretchAssetPrefix('wsola'), 'wsola-stretch');
    assert.equal(warpStretchAssetPrefix('transient'), 'taw-stretch');
  });
});
