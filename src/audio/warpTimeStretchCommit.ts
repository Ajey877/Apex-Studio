/**
 * Phase 7A: the render/commit pipeline behind the Warp processor's
 * pitch-preserving time stretch (WSOLA).
 *
 * WHAT A COMMIT DOES
 * 1. Resolves the SELECTED clip's real source PCM — engine memory first, then
 *    the persisted-asset store via the existing hydration path. If neither has
 *    it, the commit fails with a typed, honest error. Nothing is fabricated.
 * 2. Runs the pure WSOLA stretch (`wsolaTimeStretch.ts`) to produce REAL
 *    processed PCM at exactly `ceil(sourceFrames × ratio)` frames.
 * 3. Registers the result under a NEW unique asset id through the same
 *    `setSampleBuffer` seam every audio drop/bounce uses — which the sample
 *    buffer persistence installer wraps, so the processed audio is encoded
 *    losslessly and stored in the project's audio-asset store — and waits for
 *    that write to settle BEFORE any project state is published (the same
 *    durability invariant the recording and bounce commit paths enforce).
 * 4. Returns the updated clip: `audioBufferId` points at the new asset,
 *    `lengthBars` scales by the ratio (arrangement alignment preserved: the
 *    clip keeps its `startBar`, and the buffer now actually fills the scaled
 *    window), and `audioWaveform` is recomputed from the processed PCM.
 *
 * WHAT A COMMIT NEVER DOES
 * - It never mutates, reuses, or overwrites the ORIGINAL source asset: the
 *   pre-stretch buffer stays registered and persisted under its own id, so
 *   undo (which restores the previous clip state and therefore the previous
 *   `audioBufferId`) immediately plays/exports the original audio again.
 * - It never touches `pitchShiftSemitones` or `timeStretchRate`: existing
 *   Repitch behavior and old projects keep their exact meaning. The stretch
 *   is baked into the PCM instead of expressed as playback metadata.
 * - It never reports success without a committed, persisted asset: failures
 *   throw `WarpTimeStretchError` with a typed reason and the caller must not
 *   publish state.
 *
 * LENGTH SEMANTICS (explicit, by design)
 * newLengthBars = oldLengthBars × ratio; new buffer duration = old buffer
 * duration × ratio. The clip therefore consumes exactly the same FRACTION of
 * its audio as before the stretch (a clip trimmed to half its source stays
 * trimmed to half), and its position in the arrangement never moves.
 */
import type { PlaylistClip } from '../types/daw';
import {
  WSOLA_MAX_RATIO,
  WSOLA_MIN_RATIO,
  WsolaTimeStretchError,
  computeStretchWaveformPeaks,
  wsolaStretchAudioBuffer,
} from './wsolaTimeStretch';

export { WSOLA_MAX_RATIO, WSOLA_MIN_RATIO };

export type WarpStretchFailure =
  | 'unsupported-clip'
  | 'no-source-audio'
  | 'source-unavailable'
  | 'ratio-out-of-range'
  | 'stretch-failed'
  | 'persist-failed';

/** Typed commit failure so the UI can surface honest, specific messages. */
export class WarpTimeStretchError extends Error {
  public readonly failure: WarpStretchFailure;
  constructor(failure: WarpStretchFailure, message: string) {
    super(message);
    this.name = 'WarpTimeStretchError';
    this.failure = failure;
  }
}

/**
 * Everything the pipeline touches about the running app, injected so the
 * commit path is testable in Node against real PCM and a fake asset store.
 */
export interface WarpTimeStretchDeps {
  /** In-memory lookup (audioEngine.getSampleBuffer). */
  getSourceBuffer: (id: string) => AudioBuffer | undefined;
  /** Persisted-asset fallback (audioPersistence.hydrateAudioClip); true when the asset is now in memory. */
  hydrateSource: (id: string) => Promise<boolean>;
  /** Registration + persistence seam (audioEngine.setSampleBuffer, wrapped by the persistence installer). */
  registerAsset: (id: string, buffer: AudioBuffer) => void;
  /** Durability gate (waitForSampleBufferPersistence) — resolves once the asset write has settled. */
  waitForAsset: (id: string) => Promise<void>;
  /** Backend buffer factory (audioEngine.getContext().createBuffer). */
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer;
  /** Injectable clock for unique asset ids. */
  now: () => number;
}

export interface WarpTimeStretchCommit {
  /** The clip to publish through the caller's existing update path (undo/redo included). */
  clip: PlaylistClip;
  /** The untouched original asset id — still registered, still persisted. */
  sourceAssetId: string;
  /** The new processed asset id the committed clip now references. */
  stretchedAssetId: string;
  /** The processed PCM, for callers that want to audition or verify it. */
  stretchedBuffer: AudioBuffer;
  ratio: number;
}

const STRETCH_ASSET_PREFIX = 'wsola-stretch';

/**
 * Unique, collision-guarded id for the processed asset. The original id is
 * never reused: overwriting the source would destroy undo and the "never
 * overwrite the original asset" guarantee.
 */
export const buildWarpStretchAssetId = (
  clipId: string,
  now: number,
  isTaken: (id: string) => boolean
): string => {
  const base = `${STRETCH_ASSET_PREFIX}-${clipId}-${now}`;
  if (!isTaken(base)) return base;
  // A same-millisecond recommit must not clobber an existing asset.
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new WarpTimeStretchError(
    'persist-failed',
    'Could not allocate a unique asset id for the stretched audio. Nothing was committed.'
  );
};

/**
 * Renders the selected clip's audio through WSOLA and commits the result as a
 * new persisted asset. Throws `WarpTimeStretchError` with a typed failure on
 * every refusal path; on success the returned clip is ready for the caller's
 * ordinary update/history path.
 */
export const commitWarpTimeStretch = async (
  clip: PlaylistClip,
  ratio: number,
  deps: WarpTimeStretchDeps
): Promise<WarpTimeStretchCommit> => {
  if (!clip || clip.type !== 'audio') {
    throw new WarpTimeStretchError(
      'unsupported-clip',
      'Pitch-preserving stretch works on audio clips only.'
    );
  }
  const sourceAssetId = clip.audioBufferId;
  if (!sourceAssetId) {
    throw new WarpTimeStretchError(
      'no-source-audio',
      'This audio clip has no source audio asset — there is nothing to stretch.'
    );
  }
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < WSOLA_MIN_RATIO || ratio > WSOLA_MAX_RATIO) {
    throw new WarpTimeStretchError(
      'ratio-out-of-range',
      `Stretch ratio must be between ${WSOLA_MIN_RATIO}× and ${WSOLA_MAX_RATIO}× — ${String(ratio)}× was requested.`
    );
  }
  if (!(clip.lengthBars > 0)) {
    throw new WarpTimeStretchError(
      'unsupported-clip',
      'This clip has no usable length — stretch was not attempted.'
    );
  }

  // Resolve the real source PCM: engine memory first, persisted store second.
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
    throw new WarpTimeStretchError(
      'source-unavailable',
      'The source audio for this clip is not available (it was not found in memory or in the project audio store), so nothing was stretched or committed.'
    );
  }

  // Render the processed PCM. WSOLA typed errors are re-wrapped with the
  // commit-level failure but keep their honest message.
  let stretched: AudioBuffer;
  try {
    stretched = wsolaStretchAudioBuffer(source, ratio, deps.createBuffer);
  } catch (error) {
    if (error instanceof WsolaTimeStretchError) {
      throw new WarpTimeStretchError('stretch-failed', error.message);
    }
    throw error;
  }

  // Register under a NEW id and wait for persistence before publishing state:
  // the same durability gate the recording/bounce commit paths enforce.
  const stretchedAssetId = buildWarpStretchAssetId(clip.id, deps.now(), id => Boolean(deps.getSourceBuffer(id)));
  try {
    deps.registerAsset(stretchedAssetId, stretched);
    await deps.waitForAsset(stretchedAssetId);
  } catch (error) {
    throw new WarpTimeStretchError(
      'persist-failed',
      `The stretched audio could not be registered and persisted (${error instanceof Error ? error.message : String(error)}). The clip was not changed.`
    );
  }

  const processedChannels: Float32Array[] = [];
  for (let ch = 0; ch < stretched.numberOfChannels; ch += 1) processedChannels.push(stretched.getChannelData(ch));

  const stretchedClip: PlaylistClip = {
    ...clip,
    audioBufferId: stretchedAssetId,
    lengthBars: clip.lengthBars * ratio,
    audioWaveform: computeStretchWaveformPeaks(processedChannels),
    // The buffer is real and resident: a previous unavailable flag no longer applies.
    audioUnavailable: undefined,
    // pitchShiftSemitones, timeStretchRate, warpMode, startBar and fades are
    // deliberately untouched — Repitch keeps its existing meaning.
  };

  return { clip: stretchedClip, sourceAssetId, stretchedAssetId, stretchedBuffer: stretched, ratio };
};

/** Human-readable readout of what a commit will do, shown BEFORE committing. */
export const describeWarpStretchPlan = (
  clip: PlaylistClip,
  ratio: number,
  sourceBuffer: AudioBuffer | undefined
): string => {
  const targetBars = clip.lengthBars * ratio;
  const bars = `${formatBars(clip.lengthBars)} → ${formatBars(targetBars)} bars`;
  if (sourceBuffer && sourceBuffer.duration > 0) {
    return `${ratio.toFixed(2)}× · ${bars} · audio ${sourceBuffer.duration.toFixed(2)} s → ${(sourceBuffer.duration * ratio).toFixed(2)} s`;
  }
  return `${ratio.toFixed(2)}× · ${bars}`;
};

const formatBars = (bars: number): string => {
  const rounded = Math.round(bars * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};
