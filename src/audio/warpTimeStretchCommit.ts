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
 *
 * PHASE 7B — FIT TO PROJECT TEMPO
 * `computeFitToTempoRatio(sourceBpm, projectBpm)` derives the ratio for the
 * same pipeline: r = Bs / Bt, with the source tempo ENTERED BY THE USER (no
 * beat detection, no guessing) and the project tempo read from the
 * authoritative project state by the caller. Ratios outside the supported
 * WSOLA bounds are refused with an actionable typed error, never clamped.
 * The fit commits through `commitWarpTimeStretch` exactly like the manual
 * ratio control — same durability gate, same asset-identity and undo
 * guarantees — so the stretch is baked into the new asset: later project
 * tempo changes do not reprocess it.
 */
import type { PlaylistClip } from '../types/daw';
import {
  beatsPerBar,
  beatsToSeconds,
  resolveProjectTimeSignature,
  type TimeSignature,
} from '../music/musicalTime';
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
  | 'persist-failed'
  | 'invalid-source-bpm'
  | 'invalid-project-bpm'
  | 'invalid-target'
  | 'unsupported-offset'
  | 'unsupported-trim'
  | 'unsupported-pitch'
  | 'unsupported-take';

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
 * Phase 7B: Fit to Project Tempo — the ratio computation, isolated and pure.
 *
 * For a positive source tempo `Bs` (the BPM the audio was recorded at, ENTERED
 * BY THE USER — this tool performs no beat detection and never guesses) and
 * the project's authoritative tempo `Bt`, the WSOLA output/input duration
 * ratio is:
 *
 *     r = Bs / Bt
 *
 * 90 BPM audio fitted to a 120 BPM project → r = 0.75 (the output is
 * shorter); 120 → 90 → r = 4/3 (longer); equal tempos → r = 1 (identity).
 * Pitch is preserved by the WSOLA render that consumes this ratio through the
 * exact same `commitWarpTimeStretch` pipeline as the manual ratio control.
 *
 * The result must land inside the supported WSOLA bounds (0.25×–4.0×); a
 * computed ratio outside them is REFUSED with an actionable typed message —
 * never silently clamped, because a clamped fit would misrepresent the tempo
 * relationship the user asked for.
 *
 * The stretch is baked into the new audio asset: changing the project tempo
 * afterwards does NOT reprocess the committed audio.
 */
export const computeFitToTempoRatio = (sourceBpmInput: string | number, projectBpm: number): number => {
  const trimmed = typeof sourceBpmInput === 'string' ? sourceBpmInput.trim() : sourceBpmInput;
  const sourceBpm = typeof trimmed === 'string' ? Number(trimmed) : trimmed;
  if (trimmed === '' || typeof sourceBpm !== 'number' || !Number.isFinite(sourceBpm) || sourceBpm <= 0) {
    throw new WarpTimeStretchError(
      'invalid-source-bpm',
      `Enter the tempo the source audio was recorded at as a positive BPM number — "${String(sourceBpmInput).trim() || '(empty)'}" is not usable. This tool performs no beat detection and never guesses a tempo.`
    );
  }
  if (typeof projectBpm !== 'number' || !Number.isFinite(projectBpm) || projectBpm <= 0) {
    throw new WarpTimeStretchError(
      'invalid-project-bpm',
      `The project tempo (${String(projectBpm)}) is not a usable positive BPM — set a valid project tempo before fitting.`
    );
  }
  const ratio = sourceBpm / projectBpm;
  if (ratio < WSOLA_MIN_RATIO || ratio > WSOLA_MAX_RATIO) {
    throw new WarpTimeStretchError(
      'ratio-out-of-range',
      `Fitting ${sourceBpm} BPM audio to a ${projectBpm} BPM project needs ${ratio.toFixed(3)}× — outside the supported ${WSOLA_MIN_RATIO}×–${WSOLA_MAX_RATIO}× WSOLA range. Nothing was committed; the ratio is never silently clamped.`
    );
  }
  return ratio;
};

/**
 * Phase 7C: Fit to Exact Musical Length — make the selected clip occupy an
 * exact bars(+beats) destination under the project's AUTHORITATIVE tempo and
 * meter, by baking a WSOLA stretch into a new asset.
 *
 * DURATION MATHEMATICS (identical to the engine's playback semantics)
 * - The meter is resolved through `resolveProjectTimeSignature` — the same
 *   single authority the transport, scheduler and offline render use, so an
 *   unsupported stored meter fits against the exact [4,4] grid the project
 *   actually plays on. One beat is always a quarter note;
 *   `secondsPerBar = beatsPerBar(meter) × 60 / bpm`.
 * - targetWindowSeconds = targetLengthBars × secondsPerBar — the timeline
 *   window the committed clip must occupy.
 * - The clip's `timeStretchRate` (Repitch playback rate) is honored exactly:
 *   a window of W seconds consumes W × rate seconds of buffer, so the
 *   processed audio must last W × rate, giving the WSOLA ratio
 *       r = (targetWindowSeconds × rate) / sourceBufferDuration.
 *   After the commit, bufferDuration = sourceDuration × r = W × rate, i.e.
 *   the processed audio fills the target window exactly (within one output
 *   frame from WSOLA's ceil-to-whole-frames length policy).
 *
 * SAFETY REFUSALS (explicit, never silent shifts or truncation)
 * - Clips with a timeline offset/trim (`offsetSteps ≠ 0`) are REFUSED: a
 *   whole-buffer stretch cannot preserve an absolute timeline offset without
 *   shifting which content the offset lands on.
 * - Clips whose window plays only PART of their buffer (window × rate shorter
 *   than the buffer beyond a documented 1 ms epsilon) are REFUSED: fitting
 *   the whole source would expose audio past the clip end; fitting only the
 *   heard part would bake in a trim. Window-longer-than-buffer clips (the
 *   common whole-bar-rounded take with dead space) ARE supported: the dead
 *   space disappears because the audio is stretched to fill the target
 *   exactly — that is the requested operation, and no content is truncated.
 * - Clips with `pitchShiftSemitones ≠ 0` are REFUSED: detune changes how fast
 *   a browser consumes the buffer, so the fitted audio would no longer end
 *   exactly on the target bar line. (The fit itself preserves pitch.)
 * - Clips inside a take-comping group are REFUSED: resizing one take would
 *   break the lane's aligned geometry.
 * - Fades (`fadeInBars`/`fadeOutBars`) are PRESERVED numerically: they are
 *   bar quantities at the unchanged project tempo, so their absolute duration
 *   is unchanged; the engine already clamps fades that together exceed the
 *   (possibly shorter) new window, exactly as for any short clip.
 *
 * BAKED-IN SEMANTICS: like every WSOLA commit, the result is a new asset.
 * Changing the project tempo later does NOT reinterpret the rendered PCM —
 * the clip would simply occupy a different musical length at the new tempo.
 */

/** Tolerance for the "clip window covers its whole buffer" check. */
export const FIT_LENGTH_WINDOW_EPSILON_SECONDS = 1e-3;

/** The musical destination: whole bars plus quarter-note beats. */
export interface FitToLengthTarget {
  bars: number;
  beats: number;
}

/** Authoritative project timing, passed through from project state. */
export interface FitToLengthContext {
  bpm: number;
  /** The stored `meta.timeSignature` (possibly unsupported); resolved inside. */
  timeSignature: unknown;
}

export interface FitToLengthPlan {
  /** The WSOLA ratio to render: (targetWindowSeconds × rate) / sourceDuration. */
  ratio: number;
  /** Exact committed `lengthBars`: bars + beats / beatsPerBar(meter). */
  targetLengthBars: number;
  /** Timeline seconds the committed clip will occupy at the project tempo. */
  targetWindowSeconds: number;
  /** Predicted processed-audio duration: sourceDuration × ratio = window × rate. */
  processedAudioSeconds: number;
  /** The meter the runtime (and this plan) actually uses. */
  resolvedMeter: TimeSignature;
  secondsPerBar: number;
  /** The clip's preserved Repitch playback rate folded into the math. */
  playbackRate: number;
}

const assertUsableProjectBpm = (bpm: number): void => {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) {
    throw new WarpTimeStretchError(
      'invalid-project-bpm',
      `The project tempo (${String(bpm)}) is not a usable positive BPM — set a valid project tempo before fitting.`
    );
  }
};

/**
 * Pure musical half of the plan: validates the target and the authoritative
 * context, and converts bars+beats into the exact target length and window
 * duration. Throws typed `WarpTimeStretchError`s ('invalid-target',
 * 'invalid-project-bpm') — it never guesses a destination.
 */
export const resolveFitToLengthTarget = (
  target: FitToLengthTarget,
  ctx: FitToLengthContext
): { targetLengthBars: number; targetWindowSeconds: number; resolvedMeter: TimeSignature; secondsPerBar: number } => {
  assertUsableProjectBpm(ctx.bpm);
  const resolvedMeter = resolveProjectTimeSignature({ timeSignature: ctx.timeSignature });
  const meterBeats = beatsPerBar(resolvedMeter);
  if (!target || typeof target !== 'object') {
    throw new WarpTimeStretchError('invalid-target', 'Enter a target musical length in bars and beats.');
  }
  const { bars, beats } = target;
  if (typeof bars !== 'number' || !Number.isSafeInteger(bars) || bars < 0) {
    throw new WarpTimeStretchError(
      'invalid-target',
      `Target bars must be a whole number of bars (got ${String(bars)}). Use the beats field for fractional lengths.`
    );
  }
  if (typeof beats !== 'number' || !Number.isFinite(beats) || beats < 0 || beats >= meterBeats) {
    throw new WarpTimeStretchError(
      'invalid-target',
      `Target beats must be at least 0 and fewer than ${meterBeats} (one bar of ${resolvedMeter[0]}/${resolvedMeter[1]}) — got ${String(beats)}.`
    );
  }
  const targetLengthBars = bars + beats / meterBeats;
  if (!(targetLengthBars > 0)) {
    throw new WarpTimeStretchError('invalid-target', 'The target length must be more than zero bars.');
  }
  const secondsPerBar = beatsToSeconds(meterBeats, ctx.bpm);
  const targetWindowSeconds = targetLengthBars * secondsPerBar;
  if (!Number.isFinite(targetWindowSeconds) || targetWindowSeconds <= 0) {
    throw new WarpTimeStretchError('invalid-target', 'The target length does not resolve to a usable duration.');
  }
  return { targetLengthBars, targetWindowSeconds, resolvedMeter, secondsPerBar };
};

/**
 * Full pre-commit plan for fitting `clip` to the target musical length, given
 * the REAL source buffer duration. Validates the clip's fitness (offset,
 * trim, pitch, take group), derives the exact WSOLA ratio and refuses — with
 * actionable typed messages — anything that could not land exactly on the
 * requested destination. Never clamps, never renders.
 */
export const computeFitToLengthPlan = (
  clip: PlaylistClip,
  target: FitToLengthTarget,
  ctx: FitToLengthContext,
  sourceDurationSeconds: number
): FitToLengthPlan => {
  if (!clip || clip.type !== 'audio') {
    throw new WarpTimeStretchError('unsupported-clip', 'Pitch-preserving stretch works on audio clips only.');
  }
  const musical = resolveFitToLengthTarget(target, ctx);

  const offsetSteps = clip.offsetSteps ?? 0;
  if (offsetSteps !== 0) {
    throw new WarpTimeStretchError(
      'unsupported-offset',
      `This clip starts ${offsetSteps} step${offsetSteps === 1 ? '' : 's'} into its audio. A whole-buffer stretch cannot preserve a timeline offset without shifting the content — clear the clip offset (or bounce the clip) first, then fit.`
    );
  }
  const pitchShift = clip.pitchShiftSemitones ?? 0;
  if (pitchShift !== 0) {
    throw new WarpTimeStretchError(
      'unsupported-pitch',
      `This clip has a ${pitchShift > 0 ? '+' : ''}${pitchShift} st pitch offset. Detune changes how fast the audio is consumed, so the fit could not end exactly on the target bar line. Set the pitch offset to 0 first — the length fit itself preserves pitch.`
    );
  }
  if (clip.takeGroupId) {
    throw new WarpTimeStretchError(
      'unsupported-take',
      'This clip belongs to a take-comping group; resizing one take would break the lane alignment. Render/flatten the take first, then fit.'
    );
  }
  if (!(clip.lengthBars > 0)) {
    throw new WarpTimeStretchError('unsupported-clip', 'This clip has no usable length — the fit was not attempted.');
  }
  if (typeof sourceDurationSeconds !== 'number' || !Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new WarpTimeStretchError(
      'no-source-audio',
      'The source audio duration is not usable — there is nothing to fit to a musical length.'
    );
  }

  const playbackRate = Number.isFinite(clip.timeStretchRate) && (clip.timeStretchRate ?? 1) > 0
    ? (clip.timeStretchRate ?? 1)
    : 1;
  const clipWindowSeconds = clip.lengthBars * musical.secondsPerBar;
  const consumedBufferSeconds = clipWindowSeconds * playbackRate;
  if (consumedBufferSeconds + FIT_LENGTH_WINDOW_EPSILON_SECONDS < sourceDurationSeconds) {
    throw new WarpTimeStretchError(
      'unsupported-trim',
      `This clip's window plays ${consumedBufferSeconds.toFixed(2)} s of a ${sourceDurationSeconds.toFixed(2)} s audio asset. Fitting the whole source would expose audio past the clip end, and fitting only the heard part would bake in a trim — extend the clip to cover its audio (or use the manual ratio), then fit.`
    );
  }

  const ratio = (musical.targetWindowSeconds * playbackRate) / sourceDurationSeconds;
  if (!Number.isFinite(ratio) || ratio < WSOLA_MIN_RATIO || ratio > WSOLA_MAX_RATIO) {
    throw new WarpTimeStretchError(
      'ratio-out-of-range',
      `Fitting ${sourceDurationSeconds.toFixed(2)} s of audio into ${formatBars(musical.targetLengthBars)} bars (${musical.targetWindowSeconds.toFixed(2)} s at ${ctx.bpm} BPM ${musical.resolvedMeter[0]}/${musical.resolvedMeter[1]}) needs ${ratio.toFixed(3)}× — outside the supported ${WSOLA_MIN_RATIO}×–${WSOLA_MAX_RATIO}× WSOLA range. Nothing was committed; the ratio is never silently clamped.`
    );
  }

  return {
    ratio,
    targetLengthBars: musical.targetLengthBars,
    targetWindowSeconds: musical.targetWindowSeconds,
    processedAudioSeconds: sourceDurationSeconds * ratio,
    resolvedMeter: musical.resolvedMeter,
    secondsPerBar: musical.secondsPerBar,
    playbackRate,
  };
};

/** Musical-only preview line (source audio not needed): the exact destination. */
export const describeFitToLengthTarget = (target: FitToLengthTarget, ctx: FitToLengthContext): string => {
  const musical = resolveFitToLengthTarget(target, ctx);
  return `${formatBars(musical.targetLengthBars)} bars = ${musical.targetWindowSeconds.toFixed(2)} s at ${ctx.bpm.toFixed(2)} BPM ${musical.resolvedMeter[0]}/${musical.resolvedMeter[1]}`;
};

/** Full preview line once the real source duration is known (adds ratio + support). */
export const describeFitToLengthPlan = (
  clip: PlaylistClip,
  target: FitToLengthTarget,
  ctx: FitToLengthContext,
  sourceDurationSeconds: number
): string => {
  const plan = computeFitToLengthPlan(clip, target, ctx, sourceDurationSeconds);
  return `${describeFitToLengthTarget(target, ctx)} · needs ${plan.ratio.toFixed(3)}× · output audio ${plan.processedAudioSeconds.toFixed(2)} s · SUPPORTED`;
};

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

  const source = await resolveStretchSource(clip.audioBufferId, deps);
  // Relative-ratio semantics (Phase 7A/7B): the clip keeps consuming the same
  // fraction of its audio, so its window scales with the ratio.
  return renderAndCommitStretchedClip(clip, source, ratio, clip.lengthBars * ratio, deps);
};

/**
 * Shared internals: the real source PCM — engine memory first, persisted
 * store second. Typed, honest failure when neither has it; nothing fabricated.
 */
const resolveStretchSource = async (sourceAssetId: string, deps: WarpTimeStretchDeps): Promise<AudioBuffer> => {
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
  return source;
};

/**
 * Shared internals: WSOLA render → NEW unique asset id → durable registration
 * (persistence awaited BEFORE the caller may publish) → updated clip with the
 * given committed `lengthBars`. The original asset is never touched.
 */
const renderAndCommitStretchedClip = async (
  clip: PlaylistClip,
  source: AudioBuffer,
  ratio: number,
  committedLengthBars: number,
  deps: WarpTimeStretchDeps
): Promise<WarpTimeStretchCommit> => {
  const sourceAssetId = clip.audioBufferId as string;

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
    lengthBars: committedLengthBars,
    audioWaveform: computeStretchWaveformPeaks(processedChannels),
    // The buffer is real and resident: a previous unavailable flag no longer applies.
    audioUnavailable: undefined,
    // pitchShiftSemitones, timeStretchRate, warpMode, startBar and fades are
    // deliberately untouched — Repitch keeps its existing meaning.
  };

  return { clip: stretchedClip, sourceAssetId, stretchedAssetId, stretchedBuffer: stretched, ratio };
};

export interface WarpTimeStretchToLengthCommit extends WarpTimeStretchCommit {
  /** The exact plan the commit was rendered from (preview agreement proof). */
  plan: FitToLengthPlan;
}

/**
 * Phase 7C: commit the selected clip fitted to an EXACT musical length
 * (bars + quarter-note beats) under the project's authoritative tempo and
 * meter. Same pipeline guarantees as the ratio commit — new unique durable
 * asset, original untouched, publish only after persistence — plus the exact
 * destination semantics documented on `computeFitToLengthPlan`. Every refusal
 * is typed and actionable; a refused or failed fit mutates nothing.
 */
export const commitWarpTimeStretchToLength = async (
  clip: PlaylistClip,
  target: FitToLengthTarget,
  ctx: FitToLengthContext,
  deps: WarpTimeStretchDeps
): Promise<WarpTimeStretchToLengthCommit> => {
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

  const source = await resolveStretchSource(sourceAssetId, deps);
  // The plan validates the target, the authoritative context and the clip's
  // fitness (offset/trim/pitch/take) against the REAL source duration, and
  // derives the exact ratio — all before anything is rendered or registered.
  const plan = computeFitToLengthPlan(clip, target, ctx, source.duration);
  const commit = await renderAndCommitStretchedClip(clip, source, plan.ratio, plan.targetLengthBars, deps);
  return { ...commit, plan };
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

/**
 * Bar read-out at micro-bar precision (6 decimals). Phase 7B raised this from
 * 3 decimals so the preview can never disagree with the committed
 * `lengthBars`: the plan displays the exact same product the commit stores
 * (e.g. 0.375 × 0.75 = 0.28125 bars), with float noise rounded away.
 */
export const formatBars = (bars: number): string => {
  const rounded = Math.round(bars * 1e6) / 1e6;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
};
