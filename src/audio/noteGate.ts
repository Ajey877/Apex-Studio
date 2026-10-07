/**
 * Phase 1B — canonical note-duration → audible-gate conversion.
 *
 * ## The contract (unchanged by Phase 1B, and deliberately NOT migrated)
 *
 *   Note.start    = sixteenth-note steps (fractional values allowed)
 *   Note.duration = sixteenth-note steps (fractional values allowed)
 *
 * This module is the ONE place in the codebase where a musical duration becomes
 * seconds. Before Phase 1B every instrument renderer performed that conversion
 * itself with a hardcoded constant:
 *
 *     const duration = (note.duration || 2) * 0.4;   // seconds
 *
 * Those constants never read BPM, so the audible gate was completely
 * tempo-invariant: a one-step note lasted 0.4 s whether the project ran at 20
 * BPM or 300 BPM. The constants were also doing two unrelated jobs at once —
 * the step→second conversion *and* the instrument's sustain character — which
 * is why they ranged from 0.2 to 0.45.
 *
 * Phase 1B separates them:
 *
 *   gateSeconds = canonicalMusicalGateSeconds(duration, bpm) * CHARACTER
 *
 * where `canonicalMusicalGateSeconds` is pure tempo arithmetic built on the
 * Phase 1A helpers, and `CHARACTER` is a documented, unitless per-instrument
 * constant.
 *
 * ## Calibration (Option A — preserve the 60 BPM sound)
 *
 * One sixteenth step lasts `60 / 60 / 4 = 0.25` s at 60 BPM, so
 *
 *     CHARACTER = legacyMultiplier / 0.25
 *
 * reproduces the pre-Phase-1B gate exactly at 60 BPM for every instrument,
 * while making it correctly tempo-relative everywhere else. At 60 BPM nothing
 * sounds different; at any other tempo the gate finally follows the tempo.
 *
 * ## Input policy
 *
 * Matching Phase 1A's `musicalTime`, this module does NOT validate or clamp
 * BPM: tempo validation remains with the caller (the engine clamps to 20–300,
 * the standalone transport to 20–999). A non-finite BPM therefore propagates
 * rather than being silently repaired into a plausible tempo.
 *
 * A duration that is not a positive finite number falls back to the caller's
 * declared `fallbackSteps`, preserving each instrument's historic
 * `(note.duration || N)` default and preventing the negative gate that
 * previously produced a Web Audio `RangeError`.
 *
 * No project, audio, browser or UI imports — this module is pure arithmetic.
 */
import type { ArpSettings } from '../types/daw';
import { beatsToSeconds, stepsToBeats } from '../music/musicalTime';

/** Seconds one sixteenth-note step lasts at 60 BPM: (60 / 60) / 4. */
export const GATE_SECONDS_PER_STEP_AT_60BPM = 0.25;

/**
 * Unitless sustain character per instrument family.
 *
 * `1` means "the voice sounds exactly as long as the note is notated". Values
 * above 1 ring longer (piano, pads); below 1 are more percussive (chiptune,
 * pluck). Derived from the legacy multipliers, documented so the character is
 * an explicit product decision rather than an accident of a magic number.
 *
 * Deliberately NOT flattened to 1: these differences are a large part of what
 * makes the 26 instruments distinguishable.
 */
export const GATE_CHARACTER = Object.freeze({
  /** Legacy 0.20 — chiptune_8bit, independent_pluck. */
  percussive: 0.2 / GATE_SECONDS_PER_STEP_AT_60BPM,
  /** Legacy 0.25 — minisynth, wavetable, acid_303. Gate equals notated length. */
  neutral: 0.25 / GATE_SECONDS_PER_STEP_AT_60BPM,
  /** Legacy 0.30 — reese_bass, slap_bass, supersaw_lead. */
  firm: 0.3 / GATE_SECONDS_PER_STEP_AT_60BPM,
  /** Legacy 0.35 — hammond_organ, rhodes_epiano, vox_choir, cinematic_brass. */
  sustained: 0.35 / GATE_SECONDS_PER_STEP_AT_60BPM,
  /** Legacy 0.40 — grand_piano, nylon_guitar, harpsichord, strings_ensemble, sub_808. */
  broad: 0.4 / GATE_SECONDS_PER_STEP_AT_60BPM,
  /** Legacy 0.45 — ambient_pad. */
  pad: 0.45 / GATE_SECONDS_PER_STEP_AT_60BPM,
} as const);

export type GateCharacter = (typeof GATE_CHARACTER)[keyof typeof GATE_CHARACTER];

/** Steps assumed when a note carries no usable duration (historic `|| 1`). */
export const DEFAULT_GATE_FALLBACK_STEPS = 1;

/** The Arpeggiator's unset-gate default, preserved from `(arp.gate || 0.8)`. */
export const DEFAULT_ARP_GATE = 0.8;

export interface GateOptions {
  /** Unitless sustain character; defaults to `GATE_CHARACTER.neutral` (1). */
  characterFactor?: number;
  /** Steps used when `durationSteps` is not a positive finite number. */
  fallbackSteps?: number;
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Converts a musical duration in sixteenth-note steps into the instrument's
 * audible gate in seconds.
 *
 * The only sanctioned duration→seconds conversion in the codebase; every
 * instrument renderer must route through it rather than multiplying by its own
 * constant.
 */
export const resolveGateSeconds = (
  durationSteps: unknown,
  bpm: number,
  options: GateOptions = {},
): number => {
  const characterFactor = isPositiveFinite(options.characterFactor)
    ? options.characterFactor
    : GATE_CHARACTER.neutral;
  const fallbackSteps = isPositiveFinite(options.fallbackSteps)
    ? options.fallbackSteps
    : DEFAULT_GATE_FALLBACK_STEPS;
  const steps = isPositiveFinite(durationSteps) ? durationSteps : fallbackSteps;
  return beatsToSeconds(stepsToBeats(steps), bpm) * characterFactor;
};

/**
 * Length of one arpeggiator step for each `ArpSettings['rate']`, in sixteenth
 * steps: 4 steps to a beat, triplets scaled by 2/3.
 *
 * Deriving BOTH the arp onset spacing and the arp note duration from this one
 * table is what keeps Phase 70's onsets byte-identical while the gate is fixed.
 */
export const ARP_RATE_STEPS: Readonly<Record<ArpSettings['rate'], number>> = Object.freeze({
  '1/4': 4,
  '1/8': 2,
  '1/16': 1,
  '1/32': 0.5,
  '1/8t': 2 * (2 / 3),
  '1/16t': 1 * (2 / 3),
});

/** Steps for a rate, falling back to 1/16 for an unknown or legacy value. */
export const resolveArpRateSteps = (rate: unknown): number =>
  typeof rate === 'string' && isPositiveFinite(ARP_RATE_STEPS[rate as ArpSettings['rate']])
    ? ARP_RATE_STEPS[rate as ArpSettings['rate']]
    : ARP_RATE_STEPS['1/16'];

/** Seconds one arpeggiator step lasts — the arp ONSET spacing (Phase 70). */
export const arpStepSeconds = (rate: unknown, bpm: number): number =>
  beatsToSeconds(stepsToBeats(resolveArpRateSteps(rate)), bpm);

/**
 * The arpeggiated note's duration, in SIXTEENTH-NOTE STEPS.
 *
 * Before Phase 1B this returned `stepSeconds * gate` — seconds — and that
 * value was written straight into `Note.duration`, violating the step contract
 * and then being multiplied by a renderer constant a second time. The gate is
 * a *proportion of the arp step*, so it is tempo-independent by construction.
 */
export const resolveArpNoteDurationSteps = (rateSteps: number, gate: unknown): number =>
  (isPositiveFinite(rateSteps) ? rateSteps : ARP_RATE_STEPS['1/16'])
  * (isPositiveFinite(gate) ? gate : DEFAULT_ARP_GATE);

/** A gate length in seconds — the unit every instrument renderer schedules in. */
export type GateSeconds = number;
