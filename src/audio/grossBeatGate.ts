/**
 * Phase 57 - Gross Beat truth pass: the shared master-gate contract.
 *
 * The Gross Beat surface used to present itself as a time/pitch processor
 * ("TIME FX BUFFER", half-time, buffer speed, octave pitch drops, turntable
 * tape brake). The engine never implemented any of that. What it actually
 * implements is a 16-step amplitude gate on the master bus: on every step the
 * master gain is either restored to unity (step open) or pulled down to
 * `1 - mix * 0.95`, floored at 0.01 (step closed).
 *
 * This module is the single definition of that behaviour. The live transport
 * and the offline/export renderer both resolve their gain through
 * `resolveGrossBeatGateGain`, so playback and export cannot drift apart.
 *
 * There is deliberately no time-stretch, pitch-shift, half-time or tape
 * processing here, because there is none in the engine to expose.
 */

/** Number of steps in the master gate grid. */
export const GROSS_BEAT_STEP_COUNT = 16;

/** The gate never closes below this linear gain. */
export const GROSS_BEAT_MIN_GAIN = 0.01;

/** How much of the `mix` control maps onto gate depth. */
export const GROSS_BEAT_MIX_DEPTH = 0.95;

/** Linear gain applied while a step is open, or while the gate is bypassed. */
export const GROSS_BEAT_OPEN_GAIN = 1.0;

/**
 * The slice of Gross Beat state the gate actually consumes. Declared
 * structurally so both the engine and the offline renderer can hand their own
 * state straight to the resolver without depending on the full DAW type.
 */
export interface GrossBeatGateInput {
  /** When false the gate is bypassed and the master bus stays at unity. */
  readonly enabled: boolean;
  /** Gate depth, 0 = fully open, 1 = deepest. The modal constrains it to 0..1. */
  readonly mix: number;
  /** One open/closed flag per step of the 16-step grid. */
  readonly gateSteps: readonly boolean[];
}

/** Wrap any integer (including negatives) onto the 16-step grid. */
export function wrapGrossBeatStep(step: number): number {
  return ((Math.trunc(step) % GROSS_BEAT_STEP_COUNT) + GROSS_BEAT_STEP_COUNT) % GROSS_BEAT_STEP_COUNT;
}

/** True when the given step is open in the pattern. An empty pattern is open. */
export function isGrossBeatStepOpen(gateSteps: readonly boolean[], step: number): boolean {
  if (gateSteps.length === 0) return true;
  return gateSteps[wrapGrossBeatStep(step)] === true;
}

/**
 * Gain the closed steps sit at. Preserves the pre-Phase-57 maths exactly:
 * `1 - mix * 0.95`, floored at 0.01. The floor is what protects the master bus
 * when `mix` is driven past its documented 0..1 range.
 */
export function resolveGrossBeatClosedGain(mix: number): number {
  return Math.max(GROSS_BEAT_MIN_GAIN, 1.0 - mix * GROSS_BEAT_MIX_DEPTH);
}

/**
 * The single shared gate resolver. Pure and deterministic: the same
 * (state, step) always yields the same gain, which is what keeps the live
 * transport and the offline/export renderer aligned.
 *
 * - gate bypassed  -> unity
 * - step open      -> unity
 * - step closed    -> max(0.01, 1 - mix * 0.95)
 */
export function resolveGrossBeatGateGain(state: GrossBeatGateInput, step: number): number {
  if (!state.enabled) return GROSS_BEAT_OPEN_GAIN;
  if (isGrossBeatStepOpen(state.gateSteps, step)) return GROSS_BEAT_OPEN_GAIN;
  return resolveGrossBeatClosedGain(state.mix);
}

/** All 16 steps open - the gate holds the master bus wide open. */
export function grossBeatAllOpenSteps(): boolean[] {
  return Array.from({ length: GROSS_BEAT_STEP_COUNT }, () => true);
}

/** Alternating open/closed starting open - "alternating 16ths". */
export function grossBeatAlternatingSteps(): boolean[] {
  return Array.from({ length: GROSS_BEAT_STEP_COUNT }, (_, index) => index % 2 === 0);
}

/**
 * Gate-pattern presets. These only ever write `gateSteps`; none of them change
 * tempo, pitch or playback rate, because the engine has no such processing.
 */
export interface GrossBeatGatePreset {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly steps: boolean[];
}

export const GROSS_BEAT_GATE_PRESETS: readonly GrossBeatGatePreset[] = [
  {
    id: 'half_bar_chop',
    name: 'Half-Bar Chop',
    desc: 'Holds the first half of the bar, chops the second',
    steps: [
      true, true, true, true, true, true, true, true,
      false, false, false, false, false, false, false, false,
    ],
  },
  {
    id: 'long_hold',
    name: 'Long Hold',
    desc: 'One closed step per bar',
    steps: [
      false, true, true, true, true, true, true, true,
      true, true, true, true, true, true, true, true,
    ],
  },
  {
    id: 'alternating_16ths',
    name: 'Alternating 16ths',
    desc: 'Open, closed, open, closed across the bar',
    steps: grossBeatAlternatingSteps(),
  },
  {
    id: 'pump_gap',
    name: 'Pump Gap',
    desc: 'A short closed gap on the backbeat',
    steps: [
      true, true, true, true, false, true, true, true,
      true, true, true, true, false, true, true, true,
    ],
  },
  {
    id: 'triplet_chop',
    name: 'Triplet Chop',
    desc: 'Three open steps, one closed',
    steps: [
      true, true, true, false, true, true, true, false,
      true, true, true, false, true, true, true, false,
    ],
  },
  {
    id: 'broken_16ths',
    name: 'Broken 16ths',
    desc: 'Irregular chops across the bar',
    steps: [
      true, false, true, true, false, true, false, false,
      true, false, false, true, true, false, true, false,
    ],
  },
];
