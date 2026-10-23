import type { MasteringSuiteState, MultibandBandSettings } from '../types/daw';
import {
  MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS,
  MASTERING_LIMITER_MAX_LOOKAHEAD_MS,
} from './masteringLimiter';

export const DEFAULT_MASTERING_SUITE_STATE: MasteringSuiteState = {
  enabled: true,
  lufsTarget: -14,
  lowCrossFreq: 150,
  highCrossFreq: 3500,
  lowBand: { enabled: true, threshold: -18, ratio: 3, attack: 20, release: 100, gain: 1, knee: 6, solo: false, mute: false },
  midBand: { enabled: true, threshold: -22, ratio: 2.5, attack: 15, release: 80, gain: 0, knee: 4, solo: false, mute: false },
  highBand: { enabled: true, threshold: -20, ratio: 2, attack: 10, release: 60, gain: 1.5, knee: 3, solo: false, mute: false },
  stereoSpread: 1.15,
  monoSubFreq: 120,
  maximizerThreshold: -3.5,
  maximizerCeiling: -0.2,
  maximizerRelease: 80,
  maximizerLookahead: true,
  // Phase 9B: the migrated default. 5 ms is long enough for the detector to
  // duck a transient before it is emitted at every supported sample rate, and
  // short enough that live monitoring latency stays imperceptible.
  maximizerLookaheadMs: MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS,
};

/**
 * Clamp bounds applied to every mastering value at the document boundary.
 *
 * These are deliberately *wider* than the ranges the Mastering Suite UI offers:
 * a project file may legally hold a value outside what a slider can reach
 * (an older build, a hand-edited document, a future control), and normalizing
 * must not silently rewrite it. Exposed as data so the UI layer can prove its
 * own ranges sit inside these bounds instead of restating the numbers.
 */
export const MASTERING_NORMALIZATION_BOUNDS = {
  lufsTarget: { min: -24, max: -6 },
  lowCrossFreq: { min: 40, max: 1000 },
  highCrossFreq: { min: 500, max: 18000 },
  band: {
    threshold: { min: -48, max: 0 },
    ratio: { min: 1, max: 20 },
    attack: { min: 0.1, max: 500 },
    release: { min: 1, max: 2000 },
    gain: { min: -12, max: 12 },
    knee: { min: 0, max: 40 },
  },
  stereoSpread: { min: 0, max: 2 },
  monoSubFreq: { min: 20, max: 500 },
  maximizerThreshold: { min: -12, max: 0 },
  maximizerCeiling: { min: -1, max: 0 },
  maximizerRelease: { min: 10, max: 500 },
  maximizerLookaheadMs: { min: 0, max: MASTERING_LIMITER_MAX_LOOKAHEAD_MS },
} as const;

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Clamp against a named bound so the call sites cannot drift from the table. */
const bounded = (value: unknown, fallback: number, bound: { min: number; max: number }): number =>
  finite(value, fallback, bound.min, bound.max);

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

function normalizeBand(value: unknown, fallback: MultibandBandSettings): MultibandBandSettings {
  const candidate = value && typeof value === 'object' ? value as Partial<MultibandBandSettings> : {};
  const bounds = MASTERING_NORMALIZATION_BOUNDS.band;
  return {
    enabled: bool(candidate.enabled, fallback.enabled),
    threshold: bounded(candidate.threshold, fallback.threshold, bounds.threshold),
    ratio: bounded(candidate.ratio, fallback.ratio, bounds.ratio),
    attack: bounded(candidate.attack, fallback.attack, bounds.attack),
    release: bounded(candidate.release, fallback.release, bounds.release),
    gain: bounded(candidate.gain, fallback.gain, bounds.gain),
    knee: bounded(candidate.knee, fallback.knee, bounds.knee),
    solo: bool(candidate.solo, fallback.solo),
    mute: bool(candidate.mute, fallback.mute),
  };
}

/** Migrate old projects and clamp malformed mastering values at the document boundary. */
export function normalizeMasteringSuiteState(value: unknown): MasteringSuiteState {
  const candidate = value && typeof value === 'object' ? value as Partial<MasteringSuiteState> : {};
  const fallback = DEFAULT_MASTERING_SUITE_STATE;
  const bounds = MASTERING_NORMALIZATION_BOUNDS;
  return {
    enabled: bool(candidate.enabled, fallback.enabled),
    lufsTarget: bounded(candidate.lufsTarget, fallback.lufsTarget, bounds.lufsTarget),
    lowCrossFreq: bounded(candidate.lowCrossFreq, fallback.lowCrossFreq, bounds.lowCrossFreq),
    highCrossFreq: bounded(candidate.highCrossFreq, fallback.highCrossFreq, bounds.highCrossFreq),
    lowBand: normalizeBand(candidate.lowBand, fallback.lowBand),
    midBand: normalizeBand(candidate.midBand, fallback.midBand),
    highBand: normalizeBand(candidate.highBand, fallback.highBand),
    stereoSpread: bounded(candidate.stereoSpread, fallback.stereoSpread, bounds.stereoSpread),
    monoSubFreq: bounded(candidate.monoSubFreq, fallback.monoSubFreq, bounds.monoSubFreq),
    maximizerThreshold: bounded(candidate.maximizerThreshold, fallback.maximizerThreshold, bounds.maximizerThreshold),
    maximizerCeiling: bounded(candidate.maximizerCeiling, fallback.maximizerCeiling, bounds.maximizerCeiling),
    maximizerRelease: bounded(candidate.maximizerRelease, fallback.maximizerRelease, bounds.maximizerRelease),
    maximizerLookahead: bool(candidate.maximizerLookahead, fallback.maximizerLookahead),
    // Phase 9B migration: a document written before this field existed keeps the
    // boolean's meaning (true → documented 5 ms lookahead, false → 0 ms direct)
    // and is then written out explicitly, so the choice is stable from here on.
    maximizerLookaheadMs: bounded(
      candidate.maximizerLookaheadMs,
      typeof candidate.maximizerLookaheadMs === 'number' || candidate.maximizerLookahead === undefined
        ? fallback.maximizerLookaheadMs
        : (bool(candidate.maximizerLookahead, true) ? MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS : 0),
      bounds.maximizerLookaheadMs,
    ),
  };
}
