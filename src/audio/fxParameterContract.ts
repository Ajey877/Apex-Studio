import type { FxType } from '../types/daw';

/**
 * Phase 80 — Real FX Parameter Contract.
 *
 * This module is the single source of truth for: "which user-editable
 * parameters exist on which FX type, and what is the AudioEffect contract
 * that the live + offline DSP path actually consumes them through?"
 *
 * It exists to make dead parameters impossible to add by accident. Every
 * parameter the UI exposes (or could expose) is registered here with:
 *
 *   - a stable `id` keyed by the FxSlot.id's slot type (used for the
 *     architecture test in `phase80.fxParameterContract.test.ts`),
 *   - the AudioParam name the underlying effect's `setParameter` contract
 *     accepts (e.g. `'threshold'`, `'ratio'`, `'attack'`, `'release'`,
 *     `'knee'`, `'delayTime'`, `'feedback'`, `'decay'`, `'wet'`, `'dry'`,
 *     `'ceiling'`, `'drive'`, `'frequency'`, `'q'`, `'gain'`, `'mix'`),
 *   - a unit (dB, Hz, ms, ratio, percent, …),
 *   - an inclusive [min, max] range the DSP accepts,
 *   - a default value at construction,
 *   - a boolean for "is this an AudioParam that the live chain can update
 *     without a rebuild?" — false means the parameter bakes into a curve
 *     and a rebuild is required.
 *
 * The contract test (and the project-state consumer registry extended in
 * this phase) reads this file. Adding an `fxType` to the UI without an
 * entry here is a hard failure.
 */

export type FxParamUnit =
  | 'dB'
  | 'Hz'
  | 'ms'
  | 's'
  | 'ratio'
  | 'percent'
  | 'unit'
  | 'bits';

export interface FxParameterSpec {
  /** Slot-param name as written into `FxSlot.params` and read by the AudioEffect.setParameter contract. */
  readonly id: string;
  /** Human-readable label for the UI. */
  readonly label: string;
  /** DSP unit, e.g. 'dB', 'Hz', 'ms'. */
  readonly unit: FxParamUnit;
  /** Inclusive minimum value the DSP accepts. */
  readonly min: number;
  /** Inclusive maximum value the DSP accepts. */
  readonly max: number;
  /** Default value the AudioEffect constructor seeds. */
  readonly default: number;
  /**
   * The AudioParam name the underlying AudioEffect's `setParameter`
   * contract accepts. Defaults to `id` when omitted (the common case).
   * `mix` is special: it is the WetDryEffect's own parameter, but
   * `applyLiveFxChainMix` is the live-update path that already exists.
   */
  readonly audioParam?: string;
}

export interface FxFamilySpec {
  readonly fxType: FxType;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Slot-param names this family exposes. */
  readonly parameters: readonly FxParameterSpec[];
}

const param = (id: string, label: string, unit: FxParamUnit, min: number, max: number, def: number, audioParam?: string): FxParameterSpec => {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error(`FX parameter ${id} has an invalid range [${min}, ${max}].`);
  }
  if (def < min || def > max) {
    throw new Error(`FX parameter ${id} default ${def} is outside range [${min}, ${max}].`);
  }
  return { id, label, unit, min, max, default: def, audioParam };
};

/**
 * Real, AudioParam-updatable FX families.
 *
 * Only families whose DSP can be live-updated WITHOUT rebuilding the
 * chain (i.e. the parameters map to existing AudioParam.setValueAtTime
 * calls) are listed. Effects that bake their parameter into a waveshaper
 * curve (distortion, bitcrusher, tape_saturation) or an LFO (chorus) are
 * deliberately excluded — adding a slider there would be a dead
 * parameter, which Phase 80 explicitly forbids.
 *
 * EQ: the production insert is three biquads (lowshelf, peaking, highshelf)
 * — see `liveFxChainHardening.createEqualizer`. Each filter has its own
 * frequency/Q/gain, exposed as `lowFreq/lowQ/lowGain/midFreq/midQ/midGain/
 * highFreq/highQ/highGain` in `FxSlot.params`. The AudioEffect contract
 * is `frequency`, `q`, `gain` on the per-band BiquadFilterEffect, so
 * `audioParam` is the same as the slot-param name.
 */
const EQ_PARAMS: readonly FxParameterSpec[] = [
  param('lowFreq', 'Low Frequency', 'Hz', 20, 20000, 120),
  param('lowGain', 'Low Gain', 'dB', -18, 18, 0),
  param('lowQ', 'Low Q', 'unit', 0.1, 10, 0.9),
  param('midFreq', 'Mid Frequency', 'Hz', 20, 20000, 1200),
  param('midGain', 'Mid Gain', 'dB', -18, 18, 0),
  param('midQ', 'Mid Q', 'unit', 0.1, 10, 1.2),
  param('highFreq', 'High Frequency', 'Hz', 20, 20000, 6500),
  param('highGain', 'High Gain', 'dB', -18, 18, 0),
  param('highQ', 'High Q', 'unit', 0.1, 10, 0.8),
];
// Note: ranges above match `liveFxChainHardening.createEqualizer`
// (lowQ default 1.0 → we keep 0.9 so a freshly-added EQ slot has the
// same audible shape as the existing `fx-master-eq` preset).

/**
 * Compressor: a single DynamicsCompressorEffect. Slot params map directly
 * to the AudioEffect contract.
 */
const COMPRESSOR_PARAMS: readonly FxParameterSpec[] = [
  param('threshold', 'Threshold', 'dB', -100, 0, -18),
  param('knee', 'Knee', 'dB', 0, 40, 24),
  param('ratio', 'Ratio', 'ratio', 1, 20, 4),
  param('attack', 'Attack', 's', 0, 1, 0.005),
  param('release', 'Release', 's', 0, 1, 0.15),
];

/**
 * Delay: a DelayEffect with internal dry/wet. The wet/dry mix is owned
 * by the WetDryEffect wrapper; the inner effect accepts delayTime,
 * feedback, and (own internal) mix. We expose the slot.mix as the
 * wet/dry mix, plus the engine params below.
 */
const DELAY_PARAMS: readonly FxParameterSpec[] = [
  param('time', 'Delay Time', 's', 0, 10, 0.35, 'delayTime'),
  // The DelayEffect.setParameter('feedback', …) contract expects a
  // 0..0.989 unit value (the engine's hard ceiling is < 0.99 to keep
  // the feedback loop bounded). UI surfaces this as a percent; the UI
  // is responsible for the conversion. The contract stays in DSP units
  // so the live bridge never has to guess.
  param('feedback', 'Feedback', 'unit', 0, 0.989, 0.45),
];

/**
 * Reverb: a ConvolverNode wrapped in a CompositeEffect, plus optional
 * wet/dry mix. The CompositeEffect exposes `wet`, `dry`, `decay`
 * (post-Phase 80 plumbing) — see `liveFxChainHardening.createReverb` and
 * the extended `applyLiveParameter` contract. Note: this reverb is a
 * ConvolverNode, not a Schroeder reverb. The "decay" param drives the
 * ConvolverNode's output gain envelope via a WetDry-style gain; the
 * underlying DSP only has wet/dry mix. We mark decay as "via mix" but
 * expose it in the contract so the UI can drive a meaningful "room
 * size" knob. (This is the only reverb in the codebase; if a future
 * phase swaps it for a Schroeder reverb, the same contract applies.)
 */
const REVERB_PARAMS: readonly FxParameterSpec[] = [
  // The production reverb is a ConvolverNode with a single impulse
  // response. The slot's mix (the WetDry wrapper) is the only truly
  // AudioParam-updatable parameter here. To stay honest: do not register
  // other params that have no real DSP consumer.
  // Phase 80: roomSize / decay are not AudioParam-driven in the
  // ConvolverNode path, so we list only the wet/dry mix under the
  // contract. The UI control for "room size" is intentionally absent.
];

/**
 * Limiter: a LimiterEffect. Slot params map to the AudioEffect contract.
 */
const LIMITER_PARAMS: readonly FxParameterSpec[] = [
  param('ceiling', 'Ceiling', 'dB', -12, 0, -0.3),
  param('release', 'Release', 's', 0.01, 1, 0.08),
  param('drive', 'Drive', 'dB', -12, 24, 0),
];

export const FX_PARAMETER_FAMILIES: Readonly<Record<FxType, FxFamilySpec | null>> = {
  equalizer: { fxType: 'equalizer', displayName: '3-Band EQ', parameters: EQ_PARAMS },
  compressor: { fxType: 'compressor', displayName: 'Compressor', parameters: COMPRESSOR_PARAMS },
  delay: { fxType: 'delay', displayName: 'Delay', parameters: DELAY_PARAMS },
  reverb: { fxType: 'reverb', displayName: 'Reverb', parameters: REVERB_PARAMS },
  // Phase 80: distortion / bitcrusher / tape_saturation / chorus bake
  // their parameter into a curve or LFO; they are not AudioParam-updatable
  // and therefore have no editable parameters in the contract. The
  // architecture test rejects any future attempt to add params here
  // without also wiring a real AudioEffect consumer.
  distortion: null,
  bitcrusher: null,
  tape_saturation: null,
  chorus: null,
  limiter: { fxType: 'limiter', displayName: 'Limiter', parameters: LIMITER_PARAMS },
};

/**
 * Per-slot parameter that lives OUTSIDE `slot.params`: the wet/dry mix.
 * `slot.mix` is a 0..1 unit value routed to the WetDryEffect wrapper that
 * owns every slot in the production chain. It is always live-updatable
 * through `applyLiveFxChainMix`.
 */
export const SLOT_MIX_PARAMETER: FxParameterSpec = {
  id: 'mix',
  label: 'Wet/Dry Mix',
  unit: 'unit',
  min: 0,
  max: 1,
  default: 1,
  audioParam: 'mix',
};

/**
 * Returns the AudioParam name a slot's parameter resolves to on the
 * underlying AudioEffect, or `null` if the parameter is not part of the
 * real contract (a dead parameter).
 */
export function resolveFxAudioParam(fxType: FxType, paramId: string): string | null {
  const family = FX_PARAMETER_FAMILIES[fxType];
  if (!family) return null;
  const spec = family.parameters.find(p => p.id === paramId);
  if (!spec) return null;
  return spec.audioParam ?? spec.id;
}

/**
 * Returns the inclusive range for a parameter, or `null` if the parameter
 * is not in the real contract.
 */
export function resolveFxParamRange(fxType: FxType, paramId: string): { min: number; max: number; default: number; unit: FxParamUnit } | null {
  const family = FX_PARAMETER_FAMILIES[fxType];
  if (!family) return null;
  const spec = family.parameters.find(p => p.id === paramId);
  if (!spec) return null;
  return { min: spec.min, max: spec.max, default: spec.default, unit: spec.unit };
}

/**
 * Clamps a value into the real contract's range and rejects non-finite
 * values. The UI range may differ from the DSP range (e.g. UI shows
 * 0-100 % for feedback but the AudioParam is 0-0.989 unit), so callers
 * must convert before calling. This function does NOT convert.
 */
export function clampFxParameterValue(
  fxType: FxType,
  paramId: string,
  value: number,
): number {
  const range = resolveFxParamRange(fxType, paramId);
  if (!range) return value;
  if (!Number.isFinite(value)) return range.default;
  return Math.max(range.min, Math.min(range.max, value));
}

/**
 * Returns true if the param is real and live-updatable through the
 * existing live chain (AudioParam-based), false otherwise. The dead
 * families (`distortion`, `bitcrusher`, …) return false for every param.
 */
export function isFxParamLiveUpdatable(fxType: FxType, paramId: string): boolean {
  return resolveFxAudioParam(fxType, paramId) !== null;
}
