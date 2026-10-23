/**
 * Phase 8A: the render/commit pipeline behind the Vocal Tuner's OFFLINE
 * pitch correction — the same durability architecture the Warp stretch
 * commits (Phase 7A–7D) established.
 *
 * WHAT A COMMIT DOES
 * 1. Resolves the SELECTED clip's real source PCM — engine memory first, then
 *    the persisted-asset store via the existing hydration path. If neither
 *    has it, the commit fails with a typed, honest error. Nothing is fabricated.
 * 2. Analyses the source with the real YIN pipeline (`vocalPitchCorrection.ts`)
 *    and REFUSES — typed, actionable, zero mutation — when the material does
 *    not support an honest correction:
 *      - `no-confident-pitch`: too little of the source is confidently voiced
 *        (silence, noise, polyphonic or out-of-range material). The commit
 *        never renders an uncorrected clip while claiming correction.
 *      - `nothing-to-correct`: the material is confidently measured but every
 *        note already sits inside the in-tune dead zone of the selected
 *        key/scale — committing would duplicate an unchanged asset.
 * 3. Renders corrected PCM (EXACT same frame count, sample rate and channel
 *    count; stereo shares every timing/pitch decision) and registers it under
 *    a NEW unique asset id (`vocal-tune-…`) through the `setSampleBuffer`
 *    seam the persistence installer wraps, awaiting the durable write BEFORE
 *    any project state is published.
 * 4. Returns the updated clip: `audioBufferId` points at the corrected asset
 *    and `audioWaveform` is recomputed from the corrected PCM. Because the
 *    correction preserves duration EXACTLY, every other piece of clip geometry
 *    keeps its precise meaning: `lengthBars`, `startBar`, `offsetSteps`,
 *    fades, take groups, `pitchShiftSemitones` and `timeStretchRate` are all
 *    deliberately untouched (Repitch stays a separate workflow, as does the
 *    WSOLA/TAW stretch — pitch correction never routes through either).
 *
 * WHAT A COMMIT NEVER DOES
 * - It never mutates, reuses or overwrites the ORIGINAL source asset: undo
 *   (which restores the previous clip state) plays/exports the original again.
 * - It never publishes success without a committed, persisted asset.
 * - It never applies `formantShift`, `vibratoDepth` or `humanize`: those
 *   persisted settings are explicitly NOT part of this milestone, and the UI
 *   keeps saying so.
 * - The persisted `enabled` flag does not gate or imply anything automatic:
 *   correction happens only when the user explicitly renders/commits it.
 *   There is no live pitch processing in the signal path.
 */
import type { PlaylistClip, VocalTunerSettings } from '../types/daw';
import { computeStretchWaveformPeaks } from './wsolaTimeStretch';
import {
  VocalPitchCorrectionError,
  analyseVocalPitch,
  midiToNoteName,
  summariseVocalCorrection,
  validateVocalCorrectionSettings,
  vocalCorrectAudioBuffer,
  type VocalCorrectionSettings,
  type VocalCorrectionSummary,
  type VocalPitchAnalysis,
} from './vocalPitchCorrection';

export {
  VOCAL_F0_MIN_HZ,
  VOCAL_F0_MAX_HZ,
  VOCAL_MAX_CORRECTION_CENTS,
  VOCAL_IN_TUNE_DEADZONE_CENTS,
  VOCAL_MIN_RETUNE_MS,
  VOCAL_MAX_RETUNE_MS,
} from './vocalPitchCorrection';
export type { VocalCorrectionSettings, VocalCorrectionSummary, VocalPitchAnalysis };

export type VocalCorrectionCommitFailure =
  | 'unsupported-clip'
  | 'no-source-audio'
  | 'source-unavailable'
  | 'unsupported-source'
  | 'invalid-settings'
  | 'no-confident-pitch'
  | 'nothing-to-correct'
  | 'correction-failed'
  | 'persist-failed';

/** Typed commit failure so the UI can surface honest, specific messages. */
export class VocalCorrectionCommitError extends Error {
  public readonly failure: VocalCorrectionCommitFailure;
  constructor(failure: VocalCorrectionCommitFailure, message: string) {
    super(message);
    this.name = 'VocalCorrectionCommitError';
    this.failure = failure;
  }
}

/**
 * Commit-refusal thresholds for "the source does not carry enough confident
 * pitch to correct honestly". Both are deliberately low: the tool serves
 * vocal-style material where verses may contain breaths and gaps, but a
 * near-silent or purely percussive source must refuse instead of pretending.
 */
export const VOCAL_MIN_VOICED_FRAMES = 8;
export const VOCAL_MIN_VOICED_RATIO = 0.02;

/** The settings slice the correction consumes, extracted from the persisted tuner state. */
export const toVocalCorrectionSettings = (settings: VocalTunerSettings | undefined | null): VocalCorrectionSettings => {
  if (!settings || typeof settings !== 'object') {
    throw new VocalCorrectionCommitError(
      'invalid-settings',
      'The project has no vocal tuner settings to correct with — open the Vocal Tuner and choose a root key, scale and retune speed first.'
    );
  }
  try {
    return validateVocalCorrectionSettings({
      rootKey: settings.rootKey,
      scale: settings.scale,
      retuneSpeedMs: settings.retuneSpeedMs,
    });
  } catch (error) {
    if (error instanceof VocalPitchCorrectionError) {
      throw new VocalCorrectionCommitError('invalid-settings', error.message);
    }
    throw error;
  }
};

/**
 * Everything the pipeline touches about the running app, injected so the
 * commit path is testable in Node against real PCM and a fake asset store —
 * the identical dependency shape the Warp stretch commits use.
 */
export interface VocalCorrectionDeps {
  /** In-memory lookup (audioEngine.getSampleBuffer). */
  getSourceBuffer: (id: string) => AudioBuffer | undefined;
  /** Persisted-asset fallback (audioPersistence.hydrateAudioClip). */
  hydrateSource: (id: string) => Promise<boolean>;
  /** Registration + persistence seam (audioEngine.setSampleBuffer, wrapped). */
  registerAsset: (id: string, buffer: AudioBuffer) => void;
  /** Durability gate (waitForSampleBufferPersistence). */
  waitForAsset: (id: string) => Promise<void>;
  /** Backend buffer factory (audioEngine.getContext().createBuffer). */
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer;
  /** Injectable clock for unique asset ids. */
  now: () => number;
}

const CORRECTED_ASSET_PREFIX = 'vocal-tune';

/**
 * Unique, collision-guarded id for the corrected asset. The original id is
 * never reused — overwriting the source would destroy undo.
 */
export const buildVocalCorrectionAssetId = (
  clipId: string,
  now: number,
  isTaken: (id: string) => boolean
): string => {
  const base = `${CORRECTED_ASSET_PREFIX}-${clipId}-${now}`;
  if (!isTaken(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new VocalCorrectionCommitError(
    'persist-failed',
    'Could not allocate a unique asset id for the corrected audio. Nothing was committed.'
  );
};

/** The real source PCM — engine memory first, persisted store second. */
const resolveCorrectionSource = async (sourceAssetId: string, deps: VocalCorrectionDeps): Promise<AudioBuffer> => {
  let source = deps.getSourceBuffer(sourceAssetId);
  if (!source) {
    let hydrated = false;
    try {
      hydrated = await deps.hydrateSource(sourceAssetId);
    } catch {
      hydrated = false;
    }
    if (hydrated) source = deps.getSourceBuffer(sourceAssetId);
  }
  if (!source) {
    throw new VocalCorrectionCommitError(
      'source-unavailable',
      'The source audio for this clip is not available (it was not found in memory or in the project audio store), so nothing was analysed, corrected or committed.'
    );
  }
  return source;
};

const assertCorrectableClip = (clip: PlaylistClip): void => {
  if (!clip || clip.type !== 'audio') {
    throw new VocalCorrectionCommitError(
      'unsupported-clip',
      'Offline pitch correction works on audio clips only — select the recorded audio clip you want to tune.'
    );
  }
  if (!clip.audioBufferId) {
    throw new VocalCorrectionCommitError(
      'no-source-audio',
      'This audio clip has no source audio asset — there is nothing to analyse or correct.'
    );
  }
};

/** The measured analysis plus the honest, displayable summary of a source. */
export interface VocalCorrectionAnalysisResult {
  sourceBuffer: AudioBuffer;
  analysis: VocalPitchAnalysis;
  summary: VocalCorrectionSummary;
  settings: VocalCorrectionSettings;
}

/**
 * Analyse WITHOUT committing: resolves the real source, runs the real YIN
 * analysis and builds the plan summary the UI shows before any render. Typed
 * refusals (no confident pitch / nothing to correct) happen here too, so the
 * user sees the honest verdict before spending a render — and the preview and
 * the commit can never disagree (both call the same pure functions).
 */
export const analyseVocalCorrectionSource = async (
  clip: PlaylistClip,
  settings: VocalTunerSettings | undefined | null,
  deps: VocalCorrectionDeps
): Promise<VocalCorrectionAnalysisResult> => {
  assertCorrectableClip(clip);
  const correctionSettings = toVocalCorrectionSettings(settings);
  const source = await resolveCorrectionSource(clip.audioBufferId as string, deps);

  let analysis: VocalPitchAnalysis;
  let channels: Float32Array[];
  try {
    channels = [];
    for (let ch = 0; ch < source.numberOfChannels; ch += 1) channels.push(source.getChannelData(ch));
    analysis = analyseVocalPitch(channels, source.sampleRate, correctionSettings);
  } catch (error) {
    if (error instanceof VocalPitchCorrectionError) {
      const failure: VocalCorrectionCommitFailure =
        error.failure === 'invalid-settings' ? 'invalid-settings'
        : error.failure === 'unsupported-source' ? 'unsupported-source'
        : 'correction-failed';
      throw new VocalCorrectionCommitError(failure, error.message);
    }
    throw error;
  }

  assertHonestCorrectionIsPossible(analysis);
  return {
    sourceBuffer: source,
    analysis,
    summary: summariseVocalCorrection(analysis, correctionSettings),
    settings: correctionSettings,
  };
};

/** The two measurement-based refusals, shared by analysis and commit. */
const assertHonestCorrectionIsPossible = (analysis: VocalPitchAnalysis): void => {
  if (
    analysis.voicedFrameCount < VOCAL_MIN_VOICED_FRAMES ||
    analysis.voicedRatio < VOCAL_MIN_VOICED_RATIO
  ) {
    throw new VocalCorrectionCommitError(
      'no-confident-pitch',
      `Only ${(analysis.voicedRatio * 100).toFixed(1)} % of this clip's frames carry a confidently measured pitch (silence, noise, chords and material outside ${'75–1000 Hz'} are honestly unvoiced). Pitch correction was NOT attempted and nothing was committed — this tool corrects monophonic vocal-style material, and it never renders an "uncorrected" clip while claiming success.`
    );
  }
  if (analysis.correctedFrameCount === 0) {
    throw new VocalCorrectionCommitError(
      'nothing-to-correct',
      'This clip already sits inside the selected key and scale: every confidently measured note is within the 5-cent in-tune dead zone, so a correction render would be a bit-identical copy. Nothing was committed — no duplicate asset was created.'
    );
  }
};

export interface VocalPitchCorrectionCommit {
  /** The clip to publish through the caller's existing update path (undo/redo included). */
  clip: PlaylistClip;
  /** The untouched original asset id — still registered, still persisted. */
  sourceAssetId: string;
  /** The new corrected asset id the committed clip now references. */
  correctedAssetId: string;
  /** The corrected PCM, for audition/verification. */
  correctedBuffer: AudioBuffer;
  /** The real analysis the render used (preview/commit agreement evidence). */
  analysis: VocalPitchAnalysis;
  summary: VocalCorrectionSummary;
  settings: VocalCorrectionSettings;
}

/**
 * Analyse → render → NEW unique durable asset → updated clip. Throws typed
 * `VocalCorrectionCommitError`s on every refusal path; a refused or failed
 * commit mutates nothing and publishes nothing.
 */
export const commitVocalPitchCorrection = async (
  clip: PlaylistClip,
  settings: VocalTunerSettings | undefined | null,
  deps: VocalCorrectionDeps
): Promise<VocalPitchCorrectionCommit> => {
  const planned = await analyseVocalCorrectionSource(clip, settings, deps);
  const { sourceBuffer: source, analysis, summary, settings: correctionSettings } = planned;
  const sourceAssetId = clip.audioBufferId as string;

  let corrected: AudioBuffer;
  try {
    corrected = vocalCorrectAudioBuffer(source, correctionSettings, deps.createBuffer);
  } catch (error) {
    if (error instanceof VocalPitchCorrectionError) {
      throw new VocalCorrectionCommitError('correction-failed', error.message);
    }
    throw error;
  }

  // Register under a NEW id and wait for persistence before publishing state:
  // the same durability gate the recording/bounce/stretch commit paths enforce.
  const correctedAssetId = buildVocalCorrectionAssetId(clip.id, deps.now(), id => Boolean(deps.getSourceBuffer(id)));
  try {
    deps.registerAsset(correctedAssetId, corrected);
    await deps.waitForAsset(correctedAssetId);
  } catch (error) {
    throw new VocalCorrectionCommitError(
      'persist-failed',
      `The corrected audio could not be registered and persisted (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`
    );
  }

  const processedChannels: Float32Array[] = [];
  for (let ch = 0; ch < corrected.numberOfChannels; ch += 1) processedChannels.push(corrected.getChannelData(ch));

  const correctedClip: PlaylistClip = {
    ...clip,
    audioBufferId: correctedAssetId,
    audioWaveform: computeStretchWaveformPeaks(processedChannels),
    audioUnavailable: undefined,
    // lengthBars, startBar, offsetSteps, fades, take group, pitchShiftSemitones
    // and timeStretchRate are deliberately untouched: the correction preserves
    // duration EXACTLY, so every existing clip-geometry and Repitch meaning
    // stays precisely valid.
  };

  return { clip: correctedClip, sourceAssetId, correctedAssetId, correctedBuffer: corrected, analysis, summary, settings: correctionSettings };
};

/** Root-key name for plan copy (0 = C … 11 = B). */
const ROOT_KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Human-readable correction plan, shown BEFORE committing. Every number in it
 * comes from the real analysis: note names and cents, never Hz readouts or
 * fabricated measurements.
 */
export const describeVocalCorrectionPlan = (result: VocalCorrectionAnalysisResult): string => {
  const { summary, settings } = result;
  const key = `${ROOT_KEY_NAMES[settings.rootKey]} ${settings.scale.replace(/_/g, ' ')}`;
  const notes = summary.measuredNoteName && summary.targetNoteName
    ? `${summary.measuredNoteName} → ${summary.targetNoteName}`
    : 'no confident pitch';
  const retune = settings.retuneSpeedMs === 0 ? 'hard snap' : `${settings.retuneSpeedMs} ms glide`;
  return `${key} · ${notes} · mean ${summary.meanCentsApplied.toFixed(0)}¢ / max ${summary.maxCentsApplied.toFixed(0)}¢ applied · `
    + `${(summary.voicedRatio * 100).toFixed(0)} % confidently voiced (${summary.voicedSeconds.toFixed(2)} s) · `
    + `${summary.correctedSeconds.toFixed(2)} s corrected · retune ${retune}`;
};
