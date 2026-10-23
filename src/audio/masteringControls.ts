import type { MasteringSuiteState, MultibandBandSettings } from '../types/daw';
import { MASTERING_NORMALIZATION_BOUNDS } from './masteringState';

/**
 * Phase 90 — Mastering Suite control surface.
 *
 * Phase 89 verified that `MasteringProcessor.setState` already drives real
 * `BiquadFilterNode` / `DynamicsCompressorNode` parameters for the crossover
 * frequencies, per-band attack/release/knee/solo/mute and the maximizer
 * release, but that the UI had no way to reach five of them. This module is the
 * missing half: it is the single description of *what the controls are*
 * (range, step, unit, label) and *how a control writes state*, so the modal and
 * the tests read the same definition instead of restating it.
 *
 * Nothing here touches DSP. It only produces `MasteringSuiteState` values that
 * the existing engine bridge (`audioEngine.setMasteringState` →
 * `MasteringProcessor.setState`) already consumes, so live playback and offline
 * export pick the settings up unchanged.
 */

export type MasteringBandKey = 'lowBand' | 'midBand' | 'highBand';

/** Per-band fields Phase 90 exposes. `threshold`/`ratio`/`gain` already had UI. */
export type MasteringBandField = 'attack' | 'release' | 'knee';

export type MasteringControlUnit = 'Hz' | 'ms' | 'dB';

export interface MasteringControlRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: MasteringControlUnit;
}

/**
 * Slider ranges for the controls added in Phase 90.
 *
 * Each range is a deliberate subset of the corresponding
 * `MASTERING_NORMALIZATION_BOUNDS` entry: the UI is allowed to be narrower than
 * the document format, never wider. `masteringControls.test.ts` asserts that
 * containment against the real normalization table rather than a copy of it.
 */
export const MASTERING_CONTROL_RANGES = {
  /** Low/mid split. Default 150 Hz. */
  lowCrossFreq: { min: 80, max: 500, step: 5, unit: 'Hz' },
  /** Mid/high split. Default 3,500 Hz. */
  highCrossFreq: { min: 1800, max: 16000, step: 50, unit: 'Hz' },
  /** Compressor attack, per band. Stored in ms, handed to the node in seconds. */
  bandAttack: { min: 1, max: 100, step: 1, unit: 'ms' },
  /** Compressor release, per band. Stored in ms, handed to the node in seconds. */
  bandRelease: { min: 20, max: 500, step: 5, unit: 'ms' },
  /** Compressor knee, per band. Stored and handed to the node in dB. */
  bandKnee: { min: 0, max: 12, step: 0.5, unit: 'dB' },
  /** Maximizer release. Stored in ms, handed to the node in seconds. */
  maximizerRelease: { min: 20, max: 300, step: 5, unit: 'ms' },
  /**
   * Phase 9B — lookahead delay of the true-peak limiter, in ms.
   *
   * 0 means *direct* (causal: the limiter only reacts to peaks it has already
   * seen). Every other value is a real delay buffer: the limiter inspects that
   * many milliseconds of upcoming audio before it emits anything, so it can be
   * fully ducked when a transient arrives. The same value is the master chain's
   * added latency while mastering is enabled.
   */
  maximizerLookaheadMs: { min: 0, max: 20, step: 1, unit: 'ms' },
} as const satisfies Record<string, MasteringControlRange>;

export type MasteringControlId = keyof typeof MASTERING_CONTROL_RANGES;

/** Control id as it appears in the DOM, e.g. `lowBand.attack`. */
export type MasteringControlTarget =
  | MasteringControlId
  | `${MasteringBandKey}.${MasteringBandField}`;

const BAND_KEYS: readonly MasteringBandKey[] = ['lowBand', 'midBand', 'highBand'];
const BAND_FIELDS: readonly MasteringBandField[] = ['attack', 'release', 'knee'];

const FIELD_TO_RANGE: Record<MasteringBandField, MasteringControlId> = {
  attack: 'bandAttack',
  release: 'bandRelease',
  knee: 'bandKnee',
};

/** Parse a control target into the band + field it addresses, or a global id. */
export function parseMasteringControlTarget(
  target: MasteringControlTarget
): { kind: 'global'; control: MasteringControlId } | { kind: 'band'; band: MasteringBandKey; field: MasteringBandField } {
  const dot = target.indexOf('.');
  if (dot === -1) return { kind: 'global', control: target as MasteringControlId };
  const band = target.slice(0, dot) as MasteringBandKey;
  const field = target.slice(dot + 1) as MasteringBandField;
  if (!BAND_KEYS.includes(band) || !BAND_FIELDS.includes(field)) {
    throw new RangeError(`parseMasteringControlTarget: unknown control "${target}"`);
  }
  return { kind: 'band', band, field };
}

/** The range that governs a control target, global or per-band. */
export function getMasteringControlRange(target: MasteringControlTarget): MasteringControlRange {
  const parsed = parseMasteringControlTarget(target);
  return MASTERING_CONTROL_RANGES[parsed.kind === 'global' ? parsed.control : FIELD_TO_RANGE[parsed.field]];
}

export const MASTERING_CONTROL_TARGETS: readonly MasteringControlTarget[] = [
  'lowCrossFreq',
  'highCrossFreq',
  ...BAND_KEYS.flatMap((band) => BAND_FIELDS.map((field) => `${band}.${field}` as MasteringControlTarget)),
  'maximizerRelease',
  'maximizerLookaheadMs',
];

/**
 * Snap a raw control value onto its range.
 *
 * Non-finite input is rejected rather than coerced: a slider that somehow
 * yields `NaN` must leave the saved setting alone instead of writing `NaN`
 * into the project, where it would be silently replaced by a default on the
 * next normalize and quietly undo the user's other edits.
 */
export function clampMasteringControlValue(
  target: MasteringControlTarget,
  rawValue: string | number
): number | null {
  // `Number('')` is 0, so an empty string has to be rejected before the numeric
  // conversion — otherwise a cleared control would silently write its minimum
  // into the project instead of leaving the setting alone.
  if (typeof rawValue === 'string' && rawValue.trim() === '') return null;
  const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  const range = getMasteringControlRange(target);
  const clamped = Math.max(range.min, Math.min(range.max, parsed));
  // Quantize onto the slider step so a value read back from the DOM matches
  // what the control can actually display (avoids 149.99999 style drift).
  const steps = Math.round((clamped - range.min) / range.step);
  const snapped = range.min + steps * range.step;
  const decimals = String(range.step).includes('.') ? String(range.step).split('.')[1].length : 0;
  return Number(snapped.toFixed(decimals));
}

/**
 * Apply one control change, returning a new state.
 *
 * Returns the *same* object reference when the value is unusable, so callers can
 * skip a history commit instead of recording a no-op edit.
 */
export function applyMasteringControlChange(
  state: MasteringSuiteState,
  target: MasteringControlTarget,
  rawValue: string | number
): MasteringSuiteState {
  const value = clampMasteringControlValue(target, rawValue);
  if (value === null) return state;

  const parsed = parseMasteringControlTarget(target);
  if (parsed.kind === 'global') {
    if (parsed.control === 'maximizerLookaheadMs') {
      // The ms value *is* the mode; the legacy boolean is kept in sync so a
      // project written here still means the same thing to an older reader
      // (true = 5 ms lookahead, false = direct).
      if (state.maximizerLookaheadMs === value && state.maximizerLookahead === value > 0) return state;
      return { ...state, maximizerLookaheadMs: value, maximizerLookahead: value > 0 };
    }
    const control = parsed.control as 'lowCrossFreq' | 'highCrossFreq' | 'maximizerRelease';
    if (state[control] === value) return state;
    return { ...state, [control]: value };
  }

  const current = state[parsed.band];
  if (current[parsed.field] === value) return state;
  const nextBand: MultibandBandSettings = { ...current, [parsed.field]: value };
  return { ...state, [parsed.band]: nextBand };
}

/**
 * Toggle band solo.
 *
 * Solos are independent rather than exclusive: `MasteringProcessor` computes
 * `anySolo` across all three bands and lets every soloed band through, so two
 * soloed bands is a real, meaningful audition state. Mutually clearing them here
 * would hide that behaviour behind the UI.
 */
export function toggleBandSolo(state: MasteringSuiteState, band: MasteringBandKey): MasteringSuiteState {
  const current = state[band];
  return { ...state, [band]: { ...current, solo: !current.solo } };
}

/** Toggle band mute. Mute wins over solo in the processor's audible test. */
export function toggleBandMute(state: MasteringSuiteState, band: MasteringBandKey): MasteringSuiteState {
  const current = state[band];
  return { ...state, [band]: { ...current, mute: !current.mute } };
}

/**
 * The crossover frequencies the processor will actually use.
 *
 * This mirrors `MasteringProcessor.setState` exactly — including its guard that
 * keeps the low split at least 100 Hz below the high split and its Nyquist cap —
 * so the labels in the UI describe the filters that are really configured rather
 * than the raw stored numbers. `masteringControls.test.ts` pins the two together
 * by comparing this against the values the real processor writes to its nodes.
 */
export function resolveCrossoverFrequencies(
  state: Pick<MasteringSuiteState, 'lowCrossFreq' | 'highCrossFreq'>,
  sampleRate = 48000
): { lowCrossHz: number; highCrossHz: number } {
  const lowCross = Math.min(state.lowCrossFreq, state.highCrossFreq - 100);
  const highCross = Math.max(state.highCrossFreq, lowCross + 100);
  return {
    lowCrossHz: Math.max(20, lowCross),
    highCrossHz: Math.min(sampleRate * 0.49, highCross),
  };
}

/** Render a frequency the way the suite labels it: Hz below 1 kHz, kHz above. */
export function formatFrequencyHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  const khz = hz / 1000;
  return `${khz.toFixed(khz < 10 ? 2 : 1)} kHz`;
}

/**
 * The frequency span a band actually covers, derived from the live crossover
 * values. Used for the band headers, which must move when the crossovers move.
 */
export function bandRangeLabel(
  state: Pick<MasteringSuiteState, 'lowCrossFreq' | 'highCrossFreq'>,
  band: MasteringBandKey,
  sampleRate = 48000
): string {
  const { lowCrossHz, highCrossHz } = resolveCrossoverFrequencies(state, sampleRate);
  if (band === 'lowBand') return `20 Hz – ${formatFrequencyHz(lowCrossHz)}`;
  if (band === 'midBand') return `${formatFrequencyHz(lowCrossHz)} – ${formatFrequencyHz(highCrossHz)}`;
  return `${formatFrequencyHz(highCrossHz)} – ${formatFrequencyHz(sampleRate / 2)}`;
}

/**
 * Whether a band is audible, using the same rule as `MasteringProcessor`.
 * Kept here so the solo/mute buttons can show the state that will be heard.
 */
export function isBandAudible(state: MasteringSuiteState, band: MasteringBandKey): boolean {
  const anySolo = state.lowBand.solo || state.midBand.solo || state.highBand.solo;
  const target = state[band];
  return !target.mute && (!anySolo || target.solo);
}

/** Human label for a control, unit included, for `aria-label` and the row title. */
export function masteringControlLabel(target: MasteringControlTarget): string {
  const parsed = parseMasteringControlTarget(target);
  if (parsed.kind === 'global') {
    if (parsed.control === 'lowCrossFreq') return 'Low Crossover';
    if (parsed.control === 'highCrossFreq') return 'High Crossover';
    if (parsed.control === 'maximizerLookaheadMs') return 'Lookahead';
    return 'Release';
  }
  const field = parsed.field === 'attack' ? 'Attack' : parsed.field === 'release' ? 'Release' : 'Knee';
  return field;
}

/** Unit suffix shown next to a control's current value. */
export function masteringControlUnit(target: MasteringControlTarget): MasteringControlUnit {
  return getMasteringControlRange(target).unit;
}

export { MASTERING_NORMALIZATION_BOUNDS };
