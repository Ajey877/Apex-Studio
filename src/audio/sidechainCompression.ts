import type { MixerTrack, SidechainMode, SidechainSettings } from '../types/daw';

/**
 * Phase 9A — sidechain model, parameter ranges and trade-off math.
 *
 * Two modes share one settings object:
 *
 *  - `note-trigger` (legacy, default for documents written before Phase 9A):
 *    each note on the source track schedules a fixed duck envelope
 *    (`triggerSidechainDucking`). No audio analysis happens in this mode.
 *  - `level-detected`: a real peak detector reads the source track's post-fader
 *    output on the audio thread and drives the destination's `duckingGain`
 *    AudioParam. Threshold / ratio are only meaningful in this mode.
 *
 * The `amount` field keeps a single meaning in both modes: the maximum duck
 * depth, expressed as a fraction of full scale. `amountToMaxReductionDb()`
 * converts it to the detector's `maxReductionDb` parameter using the same
 * `max(0.02, 1 - amount)` floor the legacy envelope used, so amount 0.75 is a
 * 12 dB maximum duck in either mode.
 */

export const SIDECHAIN_MODE_NOTE_TRIGGER: SidechainMode = 'note-trigger';
export const SIDECHAIN_MODE_LEVEL_DETECTED: SidechainMode = 'level-detected';

export const SIDECHAIN_LIMITS = {
  amount: { min: 0, max: 1 },
  attackMs: { min: 1, max: 50 },
  releaseMs: { min: 20, max: 500 },
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
} as const;

export const DEFAULT_SIDECHAIN_SETTINGS = {
  enabled: false,
  sourceTrackId: 1,
  amount: 0.75,
  attackMs: 5,
  releaseMs: 140,
  mode: SIDECHAIN_MODE_NOTE_TRIGGER as SidechainMode,
  thresholdDb: -18,
  ratio: 4,
} as const;

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

/** Resolves the stored mode. Anything unknown is the legacy note-triggered mode. */
export const resolveSidechainMode = (settings: Pick<SidechainSettings, 'mode'> | undefined | null): SidechainMode =>
  settings?.mode === SIDECHAIN_MODE_LEVEL_DETECTED ? SIDECHAIN_MODE_LEVEL_DETECTED : SIDECHAIN_MODE_NOTE_TRIGGER;

export const isLevelDetectedSidechain = (settings: SidechainSettings | undefined | null): boolean =>
  !!settings && settings.enabled && resolveSidechainMode(settings) === SIDECHAIN_MODE_LEVEL_DETECTED;

/**
 * Maximum duck depth in dB for a stored `amount`.
 *
 * Matches the legacy note-triggered floor `max(0.02, 1 - amount)` exactly, so a
 * project that switches to level detection keeps the same depth ceiling.
 */
export const amountToMaxReductionDb = (amount: unknown): number => {
  const clamped = clamp(amount, SIDECHAIN_LIMITS.amount.min, SIDECHAIN_LIMITS.amount.max, DEFAULT_SIDECHAIN_SETTINGS.amount);
  const minGain = Math.max(0.02, 1 - clamped);
  return Math.min(48, Math.max(0, -20 * Math.log10(minGain)));
};

/** The legacy note-triggered envelope's floor gain, kept for the shared depth semantics. */
export const noteTriggeredMinGain = (amount: unknown): number =>
  Math.max(0.02, 1 - clamp(amount, SIDECHAIN_LIMITS.amount.min, SIDECHAIN_LIMITS.amount.max, DEFAULT_SIDECHAIN_SETTINGS.amount));

/**
 * Normalizes a persisted sidechain object.
 *
 * Used by `normalizeProjectState()` on load and by the engine before any value
 * reaches an AudioParam, so a hand-edited document can never push an
 * out-of-range parameter into the detector. The returned object always carries
 * an explicit `mode`, which is what makes the Phase 9A migration observable:
 * documents written before this phase resolve to `note-trigger` instead of
 * silently becoming level-detected and changing their audio.
 */
export const normalizeSidechainSettings = (
  raw: unknown,
): SidechainSettings | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;

  const rawSource = candidate.sourceTrackId;
  const sourceTrackId =
    typeof rawSource === 'number' && Number.isFinite(rawSource) && Number.isInteger(rawSource)
      ? rawSource
      : DEFAULT_SIDECHAIN_SETTINGS.sourceTrackId;

  const mode = resolveSidechainMode(candidate as Pick<SidechainSettings, 'mode'>);
  // A self-referencing source is preserved rather than silently rewritten to a
  // different track: the engine refuses that route (no detector, unity gain),
  // which is audible as "not ducked" instead of "ducked by an unrelated track".
  const normalized: SidechainSettings = {
    enabled: candidate.enabled === true,
    sourceTrackId,
    amount: clamp(candidate.amount, SIDECHAIN_LIMITS.amount.min, SIDECHAIN_LIMITS.amount.max, DEFAULT_SIDECHAIN_SETTINGS.amount),
    attackMs: clamp(candidate.attackMs, SIDECHAIN_LIMITS.attackMs.min, SIDECHAIN_LIMITS.attackMs.max, DEFAULT_SIDECHAIN_SETTINGS.attackMs),
    releaseMs: clamp(candidate.releaseMs, SIDECHAIN_LIMITS.releaseMs.min, SIDECHAIN_LIMITS.releaseMs.max, DEFAULT_SIDECHAIN_SETTINGS.releaseMs),
    mode,
    thresholdDb: clamp(candidate.thresholdDb, SIDECHAIN_LIMITS.thresholdDb.min, SIDECHAIN_LIMITS.thresholdDb.max, DEFAULT_SIDECHAIN_SETTINGS.thresholdDb),
    ratio: clamp(candidate.ratio, SIDECHAIN_LIMITS.ratio.min, SIDECHAIN_LIMITS.ratio.max, DEFAULT_SIDECHAIN_SETTINGS.ratio),
  };
  return normalized;
};

/**
 * Would attaching a detector to `destinationTrackId` that listens to
 * `sourceTrackId` close a feedback loop?
 *
 * The detector edge is `sourceChannel.output -> worklet -> destination.gain`.
 * If the destination's own audio already reaches the source (directly, through
 * intermediate mixer tracks, or through a post-fader aux send), that edge
 * completes a cycle — Web Audio would mute or reject it. Such a route is
 * refused: the destination keeps unity gain and no detector is attached,
 * instead of producing an unstable or silent graph.
 *
 * The reverse direction (source feeding the destination) is safe and is the
 * normal case: the tap reads the source before it enters the destination.
 */
export const hasSidechainFeedbackCycle = (
  edges: ReadonlyArray<{ trackId: number; targetId: number }>,
  sourceTrackId: number,
  destinationTrackId: number,
): boolean => {
  if (sourceTrackId === destinationTrackId) return true;
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.trackId);
    if (targets) targets.push(edge.targetId);
    else adjacency.set(edge.trackId, [edge.targetId]);
  }
  const seen = new Set<number>();
  const queue: number[] = [destinationTrackId];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of adjacency.get(current) ?? []) {
      if (target === sourceTrackId) return true;
      if (!seen.has(target)) queue.push(target);
    }
  }
  return false;
};

/** Human-readable detector description used by the modal and the docs. */
export const SIDECHAIN_DETECTOR_DESCRIPTION =
  'audio-thread peak detector on the source track post-fader output (threshold + ratio, attack/release smoothing)';

/** Turns a stored track into the settings the engine may safely consume. */
export const resolveTrackSidechain = (track: Pick<MixerTrack, 'id' | 'sidechain'> | undefined): SidechainSettings | undefined =>
  track ? normalizeSidechainSettings(track.sidechain) : undefined;
