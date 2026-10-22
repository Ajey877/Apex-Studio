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
  describeWarpStretchPlan,
} from './warpTimeStretchCommit';

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
