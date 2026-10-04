/**
 * Phase 46 — canonical normalized-value (0..1) -> DAW parameter conversions.
 *
 * Three runtime consumers drive the same project parameters from a normalized
 * control value: automation lanes (`audioEngine.applyAutomationValue`), the
 * runtime MIDI CC mapping bridge (`midiMappingRuntime`) and the mixer/channel UI
 * faders (direct model edits). Keeping the range math in one module means a
 * hardware knob, an automation lane and a UI fader can never disagree about
 * what a parameter's range is.
 *
 * These functions intentionally do not clamp their input: they mirror the
 * conversions that already shipped in `applyAutomationValue`, so moving the
 * math here is behaviour-preserving. Callers that receive untrusted input (the
 * MIDI bridge receives arbitrary CC bytes) clamp first.
 */

/** Clamps a normalized control value into 0..1; non-finite input becomes 0. */
export const clampNormalized = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Master output gain: normalized full scale is +1.2 linear (master_vol automation range). */
export const MASTER_OUTPUT_GAIN_MAX = 1.2;

export const masterOutputGainFromNormalized = (value: number): number => value * MASTER_OUTPUT_GAIN_MAX;

/** Channel volume: normalized maps 1:1 onto `Channel.volume` (0..1). */
export const channelVolumeFromNormalized = (value: number): number => value;

/** Pan: normalized 0..1 maps onto -1..1, so 0.5 is centered. */
export const panFromNormalized = (value: number): number => (value * 2) - 1;

/** Mixer insert fader: normalized maps onto `MixerTrack.volume` (0..1.25, 1.0 = 0dB). */
export const MIXER_VOLUME_MAX = 1.25;

export const mixerVolumeFromNormalized = (value: number): number => value * MIXER_VOLUME_MAX;

/** Channel filter cutoff: 40Hz..18040Hz, quadratic so the knob feels musical. */
export const FILTER_CUTOFF_MIN_HZ = 40;
export const FILTER_CUTOFF_SPAN_HZ = 18000;

export const filterCutoffFromNormalized = (value: number): number =>
  FILTER_CUTOFF_MIN_HZ + Math.pow(value, 2) * FILTER_CUTOFF_SPAN_HZ;

/** Channel filter resonance: 0.0001..20 (never exactly zero for a usable Q). */
export const FILTER_RESONANCE_MIN = 0.0001;
export const FILTER_RESONANCE_MAX = 20;

export const filterResonanceFromNormalized = (value: number): number =>
  Math.max(FILTER_RESONANCE_MIN, value * FILTER_RESONANCE_MAX);

/**
 * Swing: `ProjectMetadata.swing` is a project-owned fraction.
 *
 * The Channel Rack slider spans 0..0.5 and labels that value "100 %"
 * (`ChannelRack.tsx`), i.e. 0.5 is full scale, and the transport's groove offset
 * is 40 % of a step at full scale. The engine used to divide this fraction by
 * 100 — the range its field used to be documented with — which under-scaled the
 * groove by 100x (0.25 ms instead of 25 ms at 120 BPM) and made the control
 * inaudible. The conversion now lives here, next to the other normalized-value
 * conversions, and is the single source both the live scheduler and the offline
 * renderer use.
 */
export const SWING_PROJECT_FULL_SCALE = 0.5;

/** Portion of a 16th-note step the groove displaces an off-beat at full swing. */
export const SWING_MAX_STEP_FRACTION = 0.4;

/** Clamps a project swing fraction to its declared 0..0.5 range; non-finite input is silent. */
export const clampProjectSwing = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(SWING_PROJECT_FULL_SCALE, value));
};

/**
 * Seconds an off-beat step is delayed for a project swing fraction.
 *
 * Even steps are never displaced (the scheduler only calls this for odd steps),
 * and a value above full scale saturates instead of over-swinging.
 */
export const swingOffsetSecondsForStep = (
  projectSwing: unknown,
  secondsPerStep: number,
): number => {
  if (!Number.isFinite(secondsPerStep) || secondsPerStep <= 0) return 0;
  const normalized = clampProjectSwing(projectSwing) / SWING_PROJECT_FULL_SCALE;
  return normalized * SWING_MAX_STEP_FRACTION * secondsPerStep;
};

/** Channel pitch: normalized 0..1 maps onto the ±12 semitone model range. */
export const PITCH_RANGE_SEMITONES = 12;

export const pitchFromNormalized = (value: number): number =>
  (value * (PITCH_RANGE_SEMITONES * 2)) - PITCH_RANGE_SEMITONES;

/** FX slot wet/dry: 0..1, clamped because slot.mix is a bounded model field. */
export const fxMixFromNormalized = (value: number): number => Math.max(0, Math.min(1, value));
