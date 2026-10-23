/**
 * Phase 8A — Vocal pitch-correction render/commit pipeline: integration evidence.
 *
 * Mirrors the Phase 7A warp-commit harness: production
 * `commitVocalPitchCorrection` driven against REAL PCM (web-audio-engine
 * AudioBuffers) and a fake asset store with the real durability contract
 * (`registerAsset` ≈ audioEngine.setSampleBuffer wrapped by the persistence
 * installer; `waitForAsset` ≈ waitForSampleBufferPersistence).
 *
 * Covered acceptance points:
 * - commit produces REAL corrected PCM (measured frequency lands on the
 *   target scale note) under a NEW unique 'vocal-tune-' asset id, with the
 *   original asset bit-identical (undo safety) and the durability gate
 *   awaited before the clip is returned;
 * - preview/commit agreement: the committed buffer is bit-identical to the
 *   direct `vocalCorrectAudioBuffer` render of the same source + settings;
 * - formantShift / vibratoDepth / humanize are NOT applied: non-zero values
 *   in the persisted settings cannot change the rendered PCM;
 * - clip geometry: lengthBars/startBar/offset/fades/take/repitch untouched
 *   (duration-preserving correction keeps every meaning valid), waveform
 *   recomputed from the corrected PCM;
 * - hydration fallback when the source is only in the persisted store;
 * - typed honest refusals (non-audio clip, missing source, unavailable
 *   source, too-short source, invalid settings, no confident pitch, nothing
 *   to correct, persistence failure) with NOTHING registered or published;
 * - undo/redo restore the original reference and its bit-identical PCM;
 * - save/load round trip references only the corrected asset and rehydrates
 *   its exact PCM;
 * - real offline render (production `renderTimelineOffline`): the committed
 *   clip exports audio whose measured pitch is the corrected target note
 *   while the original clip still exports the off-scale source pitch.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import type { MixerTrack, PlaylistClip, ProjectState, VocalTunerSettings } from '../types/daw';
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { getAudioIdsForProject, serializeProjectState } from '../state/projectPersistence';
import { normalizeProjectState } from '../state/projectState';
import { vocalCorrectAudioBuffer } from './vocalPitchCorrection';
import {
  VocalCorrectionCommitError,
  analyseVocalCorrectionSource,
  buildVocalCorrectionAssetId,
  commitVocalPitchCorrection,
  describeVocalCorrectionPlan,
  toVocalCorrectionSettings,
} from './vocalPitchCorrectionCommit';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

const SR = 44100;
const BPM = 120; // 1 bar = 2 s
const FIXED_NOW = 1700000008000;

/** The off-scale fixture: A4 + 47 cents; C-major target A4 (440 Hz). */
const SOURCE_HZ = 452.0;
const TARGET_HZ = 440.0;

let ctx: OfflineAudioContext;
before(() => {
  ctx = new RealOfflineAudioContext(2, SR * 4, SR);
});

const makeToneBuffer = (seconds: number, freq: number, amplitude = 0.7): AudioBuffer => {
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

/** Dominant frequency via autocorrelation with parabolic refinement. */
const dominantFrequency = (data: Float32Array, fromSec: number, toSec: number): number => {
  const a = Math.floor(fromSec * SR);
  const b = Math.min(data.length, Math.floor(toSec * SR));
  const n = b - a;
  const minLag = Math.floor(SR / 1100);
  const maxLag = Math.min(Math.floor(SR / 60), Math.floor(n / 2));
  const scoreAt = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i < n - lag; i += 1) sum += data[a + i] * data[a + i + lag];
    return sum;
  };
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const s = scoreAt(lag);
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = scoreAt(bestLag - 1);
    const y2 = scoreAt(bestLag + 1);
    const denom = y0 - 2 * bestScore + y2;
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(delta) < 1) return SR / (bestLag + delta);
    }
  }
  return SR / bestLag;
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

const SOURCE_ID = 'vocal-src-1';

/**
 * Persisted tuner settings with DELIBERATELY NON-ZERO formant/vibrato/humanize
 * values: the pipeline must ignore them (they are not applied in this
 * milestone) — proven by bit-identity against the three-field render.
 */
const makeSettings = (overrides: Partial<VocalTunerSettings> = {}): VocalTunerSettings => ({
  enabled: true,
  scale: 'major',
  rootKey: 0,
  retuneSpeedMs: 0,
  formantShift: 3.5,
  vibratoDepth: 0.7,
  humanize: 0.9,
  ...overrides,
});

const makeClip = (): PlaylistClip => ({
  id: 'vocal-clip-1',
  trackIndex: 2,
  startBar: 4,
  lengthBars: 0.5, // 1 s window at 120 BPM — matches the 1.0 s source
  type: 'audio',
  audioBufferId: SOURCE_ID,
  audioName: 'Lead Vocal Take 3',
  color: '#8b5cf6',
  name: 'Lead Vocal Take 3',
  // Non-default repitch fields + an unavailable flag: the commit must leave
  // their meanings untouched and clear only the stale flag.
  timeStretchRate: 1.2,
  pitchShiftSemitones: -3,
  warpMode: 'repitch',
  fadeInBars: 0,
  fadeOutBars: 0,
  audioUnavailable: true,
}) as PlaylistClip;

const seedWorld = (sourceHz = SOURCE_HZ, seconds = 1.0): { world: FakeWorld; sourceSnapshot: Float32Array[] } => {
  const world = makeWorld();
  const source = makeToneBuffer(seconds, sourceHz);
  world.store.set(SOURCE_ID, source);
  world.persisted.set(SOURCE_ID, source);
  return { world, sourceSnapshot: snapshotBuffer(source) };
};

describe('Phase 8A: vocal pitch-correction commit pipeline', () => {
  it('commits REAL corrected PCM as a new durable vocal-tune asset with untouched source and geometry', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const settings = makeSettings();

    const result = await commitVocalPitchCorrection(makeClip(), settings, makeDeps(world));

    // New unique asset — never the source id — registered AND persisted before return.
    assert.match(result.correctedAssetId, /^vocal-tune-vocal-clip-1-\d+$/);
    assert.notEqual(result.correctedAssetId, SOURCE_ID);
    assert.deepEqual(world.registerCalls, [result.correctedAssetId]);
    assert.deepEqual(world.waitCalls, [result.correctedAssetId], 'durability gate awaited before publishing');
    assert.ok(world.persisted.has(result.correctedAssetId), 'corrected asset is durable');

    // The original asset is bit-identical: undo can always go home.
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);

    // Real corrected PCM: exact duration, measured pitch ON the target note.
    const corrected = result.correctedBuffer;
    assert.equal(corrected.length, Math.round(1.0 * SR), 'duration preserved exactly');
    assert.equal(corrected.numberOfChannels, 2);
    const outF0 = dominantFrequency(corrected.getChannelData(0), 0.35, 0.65);
    const inF0 = dominantFrequency(world.store.get(SOURCE_ID)!.getChannelData(0), 0.35, 0.65);
    assert.ok(Math.abs(inF0 - SOURCE_HZ) / SOURCE_HZ <= 0.01, `source measures ${inF0.toFixed(2)} Hz`);
    assert.ok(Math.abs(outF0 - TARGET_HZ) / TARGET_HZ <= 0.01, `corrected measures ${outF0.toFixed(2)} Hz (target ${TARGET_HZ})`);

    // Preview/commit agreement: bit-identical to the direct render.
    const reference = vocalCorrectAudioBuffer(world.store.get(SOURCE_ID)!, toVocalCorrectionSettings(settings), makeDeps(world).createBuffer);
    assertBuffersIdentical(corrected, snapshotBuffer(reference));

    // The summary/analysis are real measurements, not labels.
    assert.ok(result.summary.voicedRatio >= 0.85, `voicedRatio ${result.summary.voicedRatio}`);
    assert.ok(Math.abs(result.summary.meanCentsApplied - 47) <= 4, `mean cents applied ${result.summary.meanCentsApplied}`);
    assert.equal(result.summary.measuredNoteName, 'A4');
    assert.equal(result.summary.targetNoteName, 'A4');
    assert.equal(result.analysis.correctedFrameCount > 0, true);

    // Clip geometry: duration-preserving correction changes ONLY the asset
    // reference, the waveform and the stale unavailable flag.
    assert.equal(result.clip.audioBufferId, result.correctedAssetId);
    assert.equal(result.clip.lengthBars, 0.5, 'lengthBars untouched');
    assert.equal(result.clip.startBar, 4);
    assert.equal(result.clip.timeStretchRate, 1.2, 'Repitch rate untouched');
    assert.equal(result.clip.pitchShiftSemitones, -3, 'Repitch detune untouched');
    assert.equal(result.clip.warpMode, 'repitch');
    assert.equal(result.clip.id, 'vocal-clip-1');
    assert.equal(result.clip.audioUnavailable, undefined);
    assert.ok(Array.isArray(result.clip.audioWaveform));
    assert.equal(result.clip.audioWaveform!.length, 64);
    for (const peak of result.clip.audioWaveform!) assert.ok(peak >= 0 && peak <= 1);
    assert.ok(result.clip.audioWaveform!.some(peak => peak > 0.1), 'peaks reflect real corrected content');
  });

  it('never applies formantShift / vibratoDepth / humanize — non-zero values cannot change the PCM', async () => {
    const { world } = seedWorld();
    const withExtras = await commitVocalPitchCorrection(makeClip(), makeSettings({ formantShift: -12, vibratoDepth: 1, humanize: 1 }), makeDeps(world));
    const plainWorld = seedWorld().world;
    const plain = await commitVocalPitchCorrection(makeClip(), makeSettings({ formantShift: 0, vibratoDepth: 0, humanize: 0 }), makeDeps(plainWorld));
    assertBuffersIdentical(withExtras.correctedBuffer, snapshotBuffer(plain.correctedBuffer));
  });

  it('hydrates the source from the persisted store when it is absent from engine memory', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const source = world.store.get(SOURCE_ID)!;
    world.store.delete(SOURCE_ID);
    world.hydratable.set(SOURCE_ID, source);

    const result = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));

    assert.match(result.correctedAssetId, /^vocal-tune-/);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('refuses non-audio clips and clips without source audio with typed errors, registering nothing', async () => {
    const { world } = seedWorld();
    const patternClip = { ...makeClip(), type: 'pattern', audioBufferId: undefined } as unknown as PlaylistClip;
    await assert.rejects(
      () => commitVocalPitchCorrection(patternClip, makeSettings(), makeDeps(world)),
      (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'unsupported-clip'
    );
    const noSource = { ...makeClip(), audioBufferId: undefined } as PlaylistClip;
    await assert.rejects(
      () => commitVocalPitchCorrection(noSource, makeSettings(), makeDeps(world)),
      (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'no-source-audio'
    );
    assert.deepEqual(world.registerCalls, [], 'nothing registered on refusal');
  });

  it('refuses with a typed source-unavailable error when the audio is gone everywhere', async () => {
    const { world } = seedWorld();
    world.store.delete(SOURCE_ID);
    world.persisted.delete(SOURCE_ID);
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world)),
      (error: unknown) =>
        error instanceof VocalCorrectionCommitError &&
        error.failure === 'source-unavailable' &&
        /not available/i.test(error.message)
    );
    assert.deepEqual(world.registerCalls, []);
  });

  it('refuses a too-short source with a typed unsupported-source error', async () => {
    const world = makeWorld();
    const tiny = ctx.createBuffer(1, 1000, SR);
    world.store.set(SOURCE_ID, tiny);
    world.persisted.set(SOURCE_ID, tiny);
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world)),
      (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'unsupported-source'
    );
    assert.deepEqual(world.registerCalls, []);
  });

  it('refuses invalid settings with a typed error before touching any asset', async () => {
    const { world } = seedWorld();
    const invalid: VocalTunerSettings[] = [
      makeSettings({ retuneSpeedMs: 200 }),
      makeSettings({ retuneSpeedMs: -5 }),
      makeSettings({ rootKey: 12 }),
      makeSettings({ rootKey: 1.5 }),
      makeSettings({ scale: 'not-a-scale' as never }),
    ];
    for (const settings of invalid) {
      await assert.rejects(
        () => commitVocalPitchCorrection(makeClip(), settings, makeDeps(world)),
        (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'invalid-settings',
        `must refuse ${JSON.stringify(settings)}`
      );
    }
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), undefined, makeDeps(world)),
      (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'invalid-settings'
    );
    assert.deepEqual(world.registerCalls, []);
  });

  it('refuses silence with no-confident-pitch: never renders an "uncorrected" clip as a success', async () => {
    const world = makeWorld();
    const silence = ctx.createBuffer(2, SR, SR);
    world.store.set(SOURCE_ID, silence);
    world.persisted.set(SOURCE_ID, silence);
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world)),
      (error: unknown) =>
        error instanceof VocalCorrectionCommitError &&
        error.failure === 'no-confident-pitch' &&
        /NOT attempted/i.test(error.message)
    );
    assert.deepEqual(world.registerCalls, [], 'a refused correction registers nothing');
  });

  it('refuses an already-in-tune clip with nothing-to-correct instead of duplicating an unchanged asset', async () => {
    const { world } = seedWorld(440); // A4 — a C-major scale note
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world)),
      (error: unknown) =>
        error instanceof VocalCorrectionCommitError &&
        error.failure === 'nothing-to-correct' &&
        /already sits inside the selected key and scale/i.test(error.message)
    );
    assert.deepEqual(world.registerCalls, []);
  });

  it('reports a typed persist-failed error when the durable write fails — the clip is never published', async () => {
    const { world, sourceSnapshot } = seedWorld();
    world.failPersistence = true;
    await assert.rejects(
      () => commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world)),
      (error: unknown) =>
        error instanceof VocalCorrectionCommitError &&
        error.failure === 'persist-failed' &&
        /clip was not changed/i.test(error.message)
    );
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
  });

  it('allocates a unique asset id when the generated id already exists and never overwrites it', async () => {
    const { world } = seedWorld();
    const first = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));
    const second = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));
    assert.notEqual(second.correctedAssetId, first.correctedAssetId, 'same-millisecond recommit must not clobber');
    assert.ok(world.persisted.has(first.correctedAssetId) && world.persisted.has(second.correctedAssetId));

    // Builder unit: collision suffix semantics.
    assert.equal(buildVocalCorrectionAssetId('c1', 100, () => false), 'vocal-tune-c1-100');
    assert.equal(buildVocalCorrectionAssetId('c1', 100, id => id === 'vocal-tune-c1-100'), 'vocal-tune-c1-100-2', 'a taken base id gets the collision suffix');
    assert.equal(buildVocalCorrectionAssetId('c1', 100, id => id === 'vocal-tune-c1-100' || id === 'vocal-tune-c1-100-2'), 'vocal-tune-c1-100-3');
    assert.throws(
      () => buildVocalCorrectionAssetId('c1', 100, () => true),
      (error: unknown) => error instanceof VocalCorrectionCommitError && error.failure === 'persist-failed'
    );
  });

  it('undo/redo restores the original reference and its bit-identical PCM; redo returns the corrected asset', async () => {
    const { world, sourceSnapshot } = seedWorld();
    const before = makeClip();
    const result = await commitVocalPitchCorrection(before, makeSettings(), makeDeps(world));
    const correctedSnapshot = snapshotBuffer(result.correctedBuffer);

    // The history stack the App commits through onUpdateClip holds whole clip states.
    const history: PlaylistClip[][] = [[before], [result.clip]];
    let cursor = 1;

    cursor -= 1; // undo
    const undone = history[cursor][0];
    assert.equal(undone.audioBufferId, SOURCE_ID, 'undo restores the original audio reference');
    assert.equal(undone.lengthBars, 0.5);
    assertBuffersIdentical(world.store.get(SOURCE_ID)!, sourceSnapshot);
    assert.ok(world.store.has(result.correctedAssetId), 'corrected asset survives for redo');

    cursor += 1; // redo
    const redone = history[cursor][0];
    assert.equal(redone.audioBufferId, result.correctedAssetId);
    assertBuffersIdentical(world.store.get(result.correctedAssetId)!, correctedSnapshot);
  });

  it('save/load round trip: serialized state references only the corrected asset and rehydration returns its exact PCM', async () => {
    const { world } = seedWorld();
    const result = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));

    const state = { playlistClips: [result.clip], recordings: [] } as unknown as ProjectState;
    const serialized = serializeProjectState(state);
    const parsed = JSON.parse(serialized) as { persistenceVersion?: number; state?: unknown };
    const restored = normalizeProjectState(parsed.state ?? parsed);
    const ids = getAudioIdsForProject(restored);
    assert.ok(ids.includes(result.correctedAssetId), 'project save must carry the corrected asset');
    assert.ok(!ids.includes(SOURCE_ID), 'the committed clip no longer references the source asset');

    const freshWorld = makeWorld();
    freshWorld.hydratable.set(result.correctedAssetId, world.persisted.get(result.correctedAssetId)!);
    const hydrated = await makeDeps(freshWorld).hydrateSource(result.correctedAssetId);
    assert.equal(hydrated, true);
    assertBuffersIdentical(freshWorld.store.get(result.correctedAssetId)!, snapshotBuffer(result.correctedBuffer));
  });

  it('describes the real correction plan (key, note names, cents, voiced share) before any commit', async () => {
    // 410 Hz (≈ G#4, midi 67.8) in C major → nearest scale note G4, about
    // −78 cents: the plan must show a DIFFERENT target note name than the
    // measured one. (415.3 Hz would sit exactly on the G4/A4 tie boundary.)
    const { world } = seedWorld(410);
    const planned = await analyseVocalCorrectionSource(makeClip(), makeSettings(), makeDeps(world));
    const plan = describeVocalCorrectionPlan(planned);
    assert.match(plan, /C major/);
    assert.match(plan, /G#4 → G4/);
    assert.match(plan, /mean 7[789]¢/, plan);
    assert.match(plan, /hard snap/);
    assert.match(plan, /confidently voiced/);
    assert.ok(!/\d+\s*Hz/.test(plan), 'the plan speaks in note names and cents, never fabricated Hz readouts');
    assert.deepEqual(world.registerCalls, [], 'analysis alone registers nothing');

    // Retune wording follows the setting.
    const glided = await analyseVocalCorrectionSource(makeClip(), makeSettings({ retuneSpeedMs: 25 }), makeDeps(world));
    assert.match(describeVocalCorrectionPlan(glided), /25 ms glide/);
  });

  it('preview and commit agree exactly: the analysed plan matches the committed render', async () => {
    const { world } = seedWorld();
    const planned = await analyseVocalCorrectionSource(makeClip(), makeSettings(), makeDeps(world));
    const committed = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));
    assert.equal(committed.analysis.frameCount, planned.analysis.frameCount);
    assert.equal(committed.analysis.correctedFrameCount, planned.analysis.correctedFrameCount);
    assert.equal(committed.summary.meanCentsApplied, planned.summary.meanCentsApplied);
    const preview = vocalCorrectAudioBuffer(planned.sourceBuffer, planned.settings, makeDeps(world).createBuffer);
    assertBuffersIdentical(committed.correctedBuffer, snapshotBuffer(preview));
  });
});

// ---------------------------------------------------------------------------
// Real offline render: the committed clip must export the CORRECTED pitch
// through the production render path while the original exports the source.
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

describe('Phase 8A: committed correction in real offline export', () => {
  before(() => {
    (globalThis as any).OfflineAudioContext = RealOfflineAudioContext;
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  it('exports the corrected target pitch where the original clip exports the off-scale source pitch', async () => {
    const { world } = seedWorld();
    const result = await commitVocalPitchCorrection(makeClip(), makeSettings(), makeDeps(world));

    audioEngine.setSampleBuffer(SOURCE_ID, world.store.get(SOURCE_ID)!);
    audioEngine.setSampleBuffer(result.correctedAssetId, result.correctedBuffer);

    // Isolate the baked-in correction from repitch layering (rate 1, no
    // detune) and drop the fixture's stale unavailable flag — the buffers ARE
    // registered below, and the committed clip clears the flag anyway.
    const isolate = (clip: PlaylistClip): PlaylistClip => ({
      ...clip,
      startBar: 0,
      trackIndex: 0,
      timeStretchRate: 1,
      pitchShiftSemitones: 0,
      audioUnavailable: undefined,
    });

    const originalRender = await renderSong(isolate(makeClip()));
    const originalF0 = dominantFrequency(originalRender.getChannelData(0), 0.15, 0.85);
    assert.ok(Math.abs(originalF0 - SOURCE_HZ) / SOURCE_HZ <= 0.01, `original export measures ${originalF0.toFixed(2)} Hz`);

    const correctedRender = await renderSong(isolate(result.clip));
    const correctedF0 = dominantFrequency(correctedRender.getChannelData(0), 0.15, 0.85);
    assert.ok(Math.abs(correctedF0 - TARGET_HZ) / TARGET_HZ <= 0.012, `corrected export measures ${correctedF0.toFixed(2)} Hz (target ${TARGET_HZ})`);
    assert.ok(Math.abs(correctedF0 - originalF0) > 8, 'the export measurably differs from the uncorrected source');
  });
});
