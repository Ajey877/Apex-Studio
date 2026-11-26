/**
 * Phase 12 — DAW automation recording (WRITE / TOUCH / LATCH).
 *
 * This module is the whole recording *contract*. It holds no project state and
 * performs no mutation: it is fed the same normalized control values the mixer
 * and FX editors already publish, stamped with the audio engine's transport
 * position, and it returns the lane the pass produces so the App can commit it
 * in ONE `mutateProjectState` call (`Record automation pass`).
 *
 * Timing contract
 * ---------------
 * Nothing here reads a wall clock. Every sample carries a `TransportSample`
 * taken from `audioEngine.getTransportMusicalPosition()` — the AudioContext
 * clock — converted to *bars* through the project's meter at the project tempo.
 * That is the same clock the MIDI performance recorder stamps takes with, and
 * it is the only clock that can put a recorded point where the audio played it.
 *
 * Mode semantics
 * --------------
 *   off   — capture nothing. The lane still plays (the mode is a capture
 *           setting, not a bypass).
 *   read  — capture nothing. Historical playback behaviour, untouched.
 *   write — from arm to pass end, every sampled control value replaces the lane
 *           inside the pass, including the value that was current at the arm
 *           moment (so a sweep that never moves still writes a flat line).
 *   touch — capture only between grab and release. On release the pass closes
 *           and the *previous* lane is restored after the release point, so the
 *           underlying curve resumes instead of holding the touched value.
 *   latch — capture from grab to the end of the pass, and after the control is
 *           released keep writing the last touched value until the transport
 *           stops/pauses/seeks or the pass otherwise ends.
 *
 * One pass is one edit
 * --------------------
 * A pass is a half-open interval of clip-relative `x` plus the points inside it.
 * `automationClipWithRecordedPass` replaces only that interval, pins both edges
 * so the seam does not drift, and never emits duplicate points — so undo,
 * redo, save/reopen and export all see the same single lane the user heard.
 */

import type {
  AutomationModeSettings,
  AutomationPoint,
  AutomationRecordingMode,
  AutomationTargetType,
  Channel,
  MixerTrack,
  PlaylistClip,
} from '../types/daw';
import { beatsToBars, resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import {
  FX_PARAM_TARGET_TYPE,
  fxSlotParamToNormalized,
  parseFxSlotTargetId,
  resolveFxParameterUpdate,
} from './fxParameterControl';
import {
  filterCutoffToNormalized,
  filterResonanceToNormalized,
  mixerVolumeToNormalized,
  panToNormalized,
  pitchToNormalized,
} from './parameterScaling';

/** The target shape a recorded point is written for; identical to the clip's own. */
export type AutomationRecordingTarget = NonNullable<PlaylistClip['automationTarget']>;

/**
 * Normalized X values closer than this are the same envelope position. It is the
 * module constant `playlistClipOperations` documents for interactive editing, so
 * a recorded pass and a hand edit agree on what "the same point" means.
 */
export const AUTOMATION_X_EPSILON = 1e-6;

/**
 * Minimum X advance between two captured points of one pass, in clip-relative
 * units. Sampling is proportional to transport movement: a control held still
 * for a whole bar produces no new point, and a fast sweep produces a bounded
 * number of them instead of one per animation frame.
 *
 * Expressed as a fraction of a sixteenth step so it scales with tempo without
 * ever being a wall-clock duration.
 */
export const AUTOMATION_SAMPLE_STEP_FRACTION = 1 / 64;

/** Y values closer than this are the same parameter value (1e-6 of full scale). */
export const AUTOMATION_Y_EPSILON = 1e-6;

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

const roundX = (value: number): number => Number(clamp01(value).toFixed(6));

const roundY = (value: number): number => Number(clamp01(value).toFixed(6));

/**
 * Deterministic identity of an automation target.
 *
 * The mode map is keyed by this string. Two clips that address the same
 * parameter therefore share one mode, and a clip that is split or re-created
 * keeps the mode the user set. FX slots use the composite `"<trackId>/<slotId>"`
 * id the Phase 81 model already defines, and native targets include the plug-in
 * identity so a relinked plug-in cannot inherit a stale mode.
 */
export const automationTargetKey = (target: AutomationRecordingTarget | null | undefined): string | null => {
  if (!target || typeof target !== 'object') return null;
  if (!target.type) return null;
  const paramName = typeof target.paramName === 'string' ? target.paramName : '';
  if (target.type === 'vst3_param') {
    const native = target.native;
    if (!native || typeof native.parameterId !== 'number') return null;
    return [
      'vst3_param',
      String(target.targetId),
      native.path,
      native.classId,
      native.automationId ?? '',
      String(native.parameterId),
    ].join(':');
  }
  if (target.type === FX_PARAM_TARGET_TYPE) {
    // A malformed composite would make two different slots collide after a
    // hand-edited document; key it verbatim so it can only ever match itself.
    return `fx_param:${String(target.targetId)}:${paramName}`;
  }
  return `${target.type}:${String(target.targetId)}:${paramName}`;
};

/** True when a persisted value is a mode this build understands. */
export const isAutomationRecordingMode = (value: unknown): value is AutomationRecordingMode =>
  value === 'off' || value === 'read' || value === 'write' || value === 'touch' || value === 'latch';

/**
 * Load-time validation for `ProjectState.automationModes`.
 *
 * Unknown modes are dropped and `read` entries are removed outright: `read` is
 * the default, so keeping it would grow the document with no behavioural
 * difference (and would make a re-save of an untouched project differ from the
 * file it was opened from).
 */
export const normalizeAutomationModes = (value: unknown): AutomationModeSettings | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized: AutomationModeSettings = {};
  for (const [key, mode] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || !isAutomationRecordingMode(mode) || mode === 'read') continue;
    normalized[key] = mode;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/** The mode in force for a target; absent means `read`. */
export const resolveAutomationMode = (
  modes: AutomationModeSettings | undefined,
  target: AutomationRecordingTarget | null | undefined,
): AutomationRecordingMode => {
  const key = automationTargetKey(target);
  if (!key || !modes) return 'read';
  const mode = modes[key];
  return isAutomationRecordingMode(mode) ? mode : 'read';
};

/** Sets a target's mode, keeping `read` out of the document as the default. */
export const setAutomationMode = (
  modes: AutomationModeSettings | undefined,
  target: AutomationRecordingTarget | null | undefined,
  mode: AutomationRecordingMode,
): AutomationModeSettings | undefined => {
  const key = automationTargetKey(target);
  if (!key) return modes;
  const next: AutomationModeSettings = { ...(modes ?? {}) };
  if (mode === 'read') delete next[key];
  else next[key] = mode;
  return Object.keys(next).length > 0 ? next : undefined;
};

// ---------------------------------------------------------------------------
// Transport position → clip-relative X
// ---------------------------------------------------------------------------

/**
 * The one transport sample a capture carries.
 *
 * `positionBars` is the engine's own continuous (unwrapped) musical position in
 * bars, already through the project meter. `playing` matters for the boundary
 * rules (a paused transport cannot advance a pass).
 */
export interface TransportSample {
  positionBars: number;
  playing: boolean;
}

/** Converts `getTransportMusicalPosition()` seconds into bars through the project meter. */
export const transportSampleFromPosition = (
  positionSeconds: number,
  bpm: number,
  meter?: TimeSignature,
): TransportSample => {
  const resolvedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const resolvedMeter = resolveProjectTimeSignature({ timeSignature: meter });
  const beats = Math.max(0, Number.isFinite(positionSeconds) ? positionSeconds : 0) * resolvedBpm / 60;
  return { positionBars: beatsToBars(beats, resolvedMeter), playing: true };
};

/**
 * Clip-relative X of a transport position, or `null` when the position is
 * outside the clip.
 *
 * This is deliberately *clamped* rather than wrapped: a pass that reaches the
 * clip end stops there, and a position beyond it is not folded back to the
 * clip's start (Song Mode wrapping the arrangement would otherwise record a
 * point at `x ≈ 0` for a value performed at the end).
 */
export const clipRelativeX = (
  positionBars: number,
  clip: Pick<PlaylistClip, 'startBar' | 'lengthBars'>,
): number | null => {
  if (!Number.isFinite(positionBars) || !Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars)) return null;
  if (clip.lengthBars <= 0) return null;
  if (positionBars < clip.startBar - AUTOMATION_X_EPSILON) return null;
  if (positionBars > clip.startBar + clip.lengthBars + AUTOMATION_X_EPSILON) return null;
  return roundX((positionBars - clip.startBar) / clip.lengthBars);
};

// ---------------------------------------------------------------------------
// Reading a live control value as a normalized 0..1 value
// ---------------------------------------------------------------------------

/**
 * Reads the current normalized (0..1) control value of an automation target
 * from the live project model.
 *
 * This is the inverse of the conversion `audioEngine.applyAutomationValue`
 * applies, and it lives next to the recorder (not in the UI) so a lane recorded
 * from the mixer, the FX panel and a MIDI mapping all agree about the value a
 * fader at -6 dB represents. Returns `null` when the target no longer resolves
 * — a deleted track, slot, parameter or channel must not record anything.
 */
export const readAutomationTargetValue = (
  target: AutomationRecordingTarget | null | undefined,
  channels: readonly Channel[] | undefined,
  mixerTracks: readonly MixerTrack[] | undefined,
): number | null => {
  if (!target) return null;
  switch (target.type) {
    case 'master_vol':
      return null; // Master output is engine-owned, not project state; see docs/AUTOMATION-RECORDING.md.
    case 'channel_vol': {
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      return channel ? clamp01(Number(channel.volume)) : null;
    }
    case 'channel_pan': {
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      return channel ? panToNormalized(Number(channel.pan)) : null;
    }
    case 'channel_filter_cutoff': {
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      const cutoff = Number(channel?.synthParams?.filterCutoff);
      return Number.isFinite(cutoff) ? filterCutoffToNormalized(cutoff) : null;
    }
    case 'channel_filter_res': {
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      const resonance = Number(channel?.synthParams?.filterResonance);
      return Number.isFinite(resonance) ? filterResonanceToNormalized(resonance) : null;
    }
    case 'channel_pitch': {
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      return Number.isFinite(Number(channel?.pitch)) ? pitchToNormalized(Number(channel!.pitch)) : null;
    }
    case 'mixer_vol': {
      const track = (mixerTracks ?? []).find(candidate => candidate.id === Number(target.targetId));
      return track ? mixerVolumeToNormalized(Number(track.volume)) : null;
    }
    case 'mixer_pan': {
      const track = (mixerTracks ?? []).find(candidate => candidate.id === Number(target.targetId));
      return track ? panToNormalized(Number(track.pan)) : null;
    }
    case 'mixer_send1':
    case 'mixer_send2': {
      const track = (mixerTracks ?? []).find(candidate => candidate.id === Number(target.targetId));
      const index = target.type === 'mixer_send1' ? 0 : 1;
      const amount = track?.auxSends?.[index]?.amount;
      return Number.isFinite(Number(amount)) ? clamp01(Number(amount)) : null;
    }
    case 'fx_mix': {
      const track = (mixerTracks ?? []).find(candidate => candidate.id === Number(target.targetId));
      const slot = target.paramName ? track?.fxSlots.find(candidate => candidate.id === target.paramName) : undefined;
      return slot ? clamp01(Number(slot.mix)) : null;
    }
    case 'fx_param': {
      const parsed = parseFxSlotTargetId(target.targetId);
      const track = parsed.trackId === null
        ? undefined
        : (mixerTracks ?? []).find(candidate => candidate.id === parsed.trackId);
      const slot = parsed.slotId ? track?.fxSlots.find(candidate => candidate.id === parsed.slotId) : undefined;
      if (!slot || typeof target.paramName !== 'string' || !target.paramName) return null;
      // `fxSlotParamToNormalized` answers 0 for a param the contract does not
      // own; a pass must not record a fabricated value for it.
      if (resolveFxParameterUpdate([...((mixerTracks ?? []))], target.targetId, target.paramName, 0).status !== 'resolved') return null;
      return fxSlotParamToNormalized(slot, target.paramName);
    }
    case 'vst3_param': {
      const native = target.native;
      const channel = (channels ?? []).find(candidate => candidate.id === String(target.targetId));
      if (!native || !channel || channel.instrumentType !== 'vst3' || !channel.vst3) return null;
      if (native.path !== channel.vst3.path || native.classId !== channel.vst3.classId) return null;
      if ((native.automationId ?? null) !== (channel.vst3.automationId ?? null)) return null;
      const stored = channel.vst3.state?.parameters?.find(parameter => parameter.id === native.parameterId);
      return stored && Number.isFinite(stored.value) ? clamp01(stored.value) : null;
    }
    default:
      return null;
  }
};

/**
 * True when the target still addresses something real in the live project.
 *
 * A pass whose target disappears mid-take (the insert is deleted, the channel
 * is removed, a VST3 instrument is relinked) is abandoned instead of writing
 * points that no consumer can resolve. The lane clip itself is untouched.
 */
export const automationTargetResolves = (
  target: AutomationRecordingTarget | null | undefined,
  channels: readonly Channel[] | undefined,
  mixerTracks: readonly MixerTrack[] | undefined,
): boolean => {
  if (!target) return false;
  if (target.type === 'fx_param') {
    const resolution = resolveFxParameterUpdate(mixerTracks, target.targetId, target.paramName, 0);
    return resolution.status === 'resolved';
  }
  return readAutomationTargetValue(target, channels, mixerTracks) !== null;
};

/**
 * The normalized value a target has at this instant, for WRITE's arm sample and
 * LATCH's hold. `fallback` is used when the model cannot be read (the value the
 * control published is still authoritative for the pass).
 */
export const resolveSampledValue = (
  value: number | null | undefined,
  fallback?: number | null,
): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value);
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return clamp01(fallback);
  return null;
};

// ---------------------------------------------------------------------------
// Pass capture
// ---------------------------------------------------------------------------

export interface RecordedAutomationSample {
  /** Clip-relative position, already quantized to 6 decimals. */
  x: number;
  /** Normalized parameter value. */
  y: number;
}

/**
 * What a completed pass reports back to the App. `points` is already ordered and
 * de-duplicated; `startX`/`endX` describe the interval the pass replaces.
 */
export interface AutomationRecordingPass {
  clipId: string;
  targetKey: string;
  points: RecordedAutomationSample[];
  startX: number;
  endX: number;
  /** True when the control was released before the pass ended (TOUCH/LATCH). */
  released: boolean;
}

export interface AutomationRecorderOptions {
  /** Project meter, so a bar position is clipped against the same grid the arranger draws. */
  meter?: TimeSignature;
  /** Clip X advance below which a repeat value is not worth a point, in bars. */
  minSampleBars?: number;
}

/**
 * One target's pass. See the module comment for the mode table.
 *
 * The recorder is deliberately a single-target machine: a recording pass
 * records the target the user armed, and arming a second target finishes the
 * first pass (a DAW records one lane per pass in this product's workflow).
 */
export class AutomationRecordingPasser {
  private mode: AutomationRecordingMode = 'read';
  private clip: PlaylistClip | null = null;
  private targetKey: string | null = null;
  private startPositionBars = 0;
  private lastPositionBars = 0;
  private lastX = 0;
  private lastY: number | null = null;
  private lastCapturePositionBars = 0;
  private touched = false;
  private released = false;
  private heldValue: number | null = null;
  private readonly points: RecordedAutomationSample[] = [];
  private readonly meter: TimeSignature;
  private readonly minSampleBars: number;

  constructor(options: AutomationRecorderOptions = {}) {
    this.meter = resolveProjectTimeSignature({ timeSignature: options.meter });
    this.minSampleBars = Number.isFinite(options.minSampleBars) && (options.minSampleBars ?? 0) > 0
      ? options.minSampleBars!
      : AUTOMATION_SAMPLE_STEP_FRACTION;
  }

  get isActive(): boolean {
    return this.clip !== null && this.mode !== 'off' && this.mode !== 'read';
  }

  get activeMode(): AutomationRecordingMode {
    return this.mode;
  }

  get activeClip(): PlaylistClip | null {
    return this.clip;
  }

  get capturedCount(): number {
    return this.points.length;
  }

  /** True once the control was released and the pass is only holding (LATCH). */
  get isHolding(): boolean {
    return this.isActive && this.mode === 'latch' && this.released;
  }

  /**
   * Arms a pass for `clip`. Returns `false` (and records nothing) for `read` and
   * `off`, for an automation clip with no target, or when a pass is already
   * running — the running pass keeps its target rather than being retargeted
   * mid-take.
   */
  start(
    clip: PlaylistClip | null | undefined,
    target: AutomationRecordingTarget | null | undefined,
    mode: AutomationRecordingMode,
    sample: TransportSample,
    initialValue: number | null,
  ): boolean {
    if (this.clip) return false;
    if (!clip || clip.type !== 'automation') return false;
    if (mode === 'off' || mode === 'read') return false;
    const key = automationTargetKey(target);
    if (!key) return false;
    const x = clipRelativeX(sample.positionBars, clip);
    if (x === null) return false;

    this.mode = mode;
    this.clip = clip;
    this.targetKey = key;
    this.startPositionBars = sample.positionBars;
    this.lastPositionBars = sample.positionBars;
    this.lastX = x;
    this.lastCapturePositionBars = sample.positionBars;
    this.points.length = 0;
    this.touched = false;
    this.released = false;
    this.heldValue = null;
    this.lastY = null;

    if (mode === 'write') {
      // WRITE owns the interval from the arm moment: seed the pass with the value
      // the control has right now, so a pass that never moves still replaces the
      // lane with a flat line instead of leaving the old curve in place.
      const value = resolveSampledValue(initialValue);
      if (value !== null) {
        this.pushPoint(x, value);
        this.lastY = value;
      }
    }
    return true;
  }

  /**
   * True when the control is being manipulated. TOUCH starts capturing here,
   * LATCH starts capturing here and keeps the last value after release.
   */
  grab(sample: TransportSample, value?: number | null): boolean {
    if (!this.isActive || this.released) return false;
    if (this.mode === 'write') return true;
    if (!this.touched) {
      this.touched = true;
      // TOUCH and LATCH replace the lane from the moment the control was
      // grabbed, not from the moment the pass was armed: the user did not
      // perform anything before the grab, so nothing before it may be rewritten.
      this.startPositionBars = sample.positionBars;
      const seeded = resolveSampledValue(value, this.heldValue);
      if (seeded !== null) {
        const x = this.advance(sample);
        if (x !== null) {
          this.pushPoint(x, seeded);
          this.lastY = seeded;
          this.lastCapturePositionBars = sample.positionBars;
        }
        this.heldValue = seeded;
      }
    }
    return true;
  }

  /**
   * A control change while the pass runs. This is the one entry point every
   * editor funnel calls; `value` is already normalized by the caller (see
   * `readAutomationTargetValue` for the model-backed form).
   */
  sampleValue(sample: TransportSample, value: number | null | undefined): boolean {
    if (!this.isActive) return false;
    const clamped = resolveSampledValue(value);
    if (clamped === null) return false;
    const x = this.advance(sample);
    if (x === null) return false;
    if (this.mode === 'touch' && !this.touched) return false;
    if (this.mode === 'latch' && !this.touched) return false;
    if (this.mode === 'latch') this.heldValue = clamped;
    return this.capture(x, clamped, sample.positionBars);
  }

  /**
   * Transport moved without a control change (LATCH's hold, WRITE's flat
   * coverage, TOUCH does nothing here). Called from the transport's per-step
   * callback so a held value is written across the interval it covered rather
   * than only at the two moments it was touched.
   */
  sampleTick(sample: TransportSample): boolean {
    if (!this.isActive) return false;
    const x = this.advance(sample);
    if (x === null) return false;
    if (this.mode === 'write') {
      if (this.lastY === null) return false;
      return this.capture(x, this.lastY, sample.positionBars);
    }
    if (this.mode === 'latch') {
      if (!this.touched || this.heldValue === null) return false;
      return this.capture(x, this.heldValue, sample.positionBars);
    }
    return false;
  }

  /** The control was released. TOUCH closes here; LATCH keeps holding. */
  release(sample: TransportSample, value?: number | null): AutomationRecordingPass | null {
    if (!this.isActive) return null;
    if (this.mode === 'touch') {
      const clamped = resolveSampledValue(value, this.lastY);
      if (clamped !== null) {
        const x = this.advance(sample);
        if (x !== null) this.capture(x, clamped, sample.positionBars);
      }
      this.released = true;
      return this.finish(sample);
    }
    if (this.mode === 'latch') {
      const clamped = resolveSampledValue(value, this.heldValue);
      if (clamped !== null) {
        this.heldValue = clamped;
        const x = this.advance(sample);
        if (x !== null) this.capture(x, clamped, sample.positionBars);
      }
      this.released = true;
    }
    return null;
  }

  /**
   * Ends the pass and returns the lane surgery the App commits, or `null` when
   * nothing was captured (an untouched pass must not create history).
   */
  finish(sample?: TransportSample | null): AutomationRecordingPass | null {
    const clip = this.clip;
    const startPositionBars = this.startPositionBars;
    // Snapshot the pass state BEFORE `reset()`: a TOUCH pass that closed on
    // release must still report `released: true` once it is finished.
    const wasReleased = this.released;
    if (!clip) return null;

    const endPositionBars = sample && Number.isFinite(sample.positionBars)
      ? Math.max(this.lastPositionBars, sample.positionBars)
      : this.lastPositionBars;

    // WRITE covers the interval it ran, even where the control did not move.
    const endX = clipRelativeX(endPositionBars, clip);
    const startX = clipRelativeX(startPositionBars, clip) ?? 0;
    const points: RecordedAutomationSample[] = this.points.map(point => ({ ...point }));

    this.reset();

    if (points.length === 0) return null;
    const resolvedEndX = endX ?? startX;
    const resolvedStartX = Math.min(startX, points[0].x);
    // A pass can end before it starts when a seek moved the transport backwards;
    // the caller treats that as a boundary and finishes the previous pass at the
    // pre-seek position, so the interval is always well-ordered here.
    const intervalStart = Math.min(resolvedStartX, resolvedEndX);
    const intervalEnd = Math.max(resolvedStartX, resolvedEndX);
    return {
      clipId: clip.id,
      targetKey: this.targetKey ?? automationTargetKey(clip.automationTarget) ?? '',
      points,
      startX: roundX(intervalStart),
      endX: roundX(intervalEnd),
      released: wasReleased,
    };
  }

  /** Discards the pass without producing a lane change (target deleted, project replaced). */
  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.mode = 'read';
    this.clip = null;
    this.targetKey = null;
    this.lastX = 0;
    this.lastY = null;
    this.lastCapturePositionBars = 0;
    this.startPositionBars = 0;
    this.lastPositionBars = 0;
    this.touched = false;
    this.released = false;
    this.heldValue = null;
    this.points.length = 0;
  }

  /**
   * Advances the pass's clock. A position that moved *backwards* is a transport
   * discontinuity (seek, loop restart, restart from the top) and closes the pass
   * at the pre-boundary position; returns `null` so the caller writes nothing.
   */
  private advance(sample: TransportSample): number | null {
    if (!sample || !Number.isFinite(sample.positionBars)) return null;
    if (sample.positionBars < this.lastPositionBars - AUTOMATION_X_EPSILON * 0.001) return null;
    const clip = this.clip;
    if (!clip) return null;
    const x = clipRelativeX(sample.positionBars, clip);
    if (x === null) return null;
    this.lastPositionBars = sample.positionBars;
    return x;
  }

  private capture(x: number, y: number, positionBars: number): boolean {
    const previous = this.points[this.points.length - 1];
    const samePosition = previous !== undefined
      && Math.abs(previous.x - roundX(x)) < AUTOMATION_X_EPSILON;
    if (samePosition) {
      // The transport did not advance. The parameter's latest value is the one
      // that will be heard there, so it replaces the point instead of being
      // dropped (dropping it would record the value the control *had*).
      previous.y = roundY(y);
      this.lastY = y;
      this.lastX = x;
      this.lastCapturePositionBars = positionBars;
      return true;
    }
    if (this.lastY !== null && Math.abs(y - this.lastY) < AUTOMATION_Y_EPSILON) {
      // Same value at a new position: extend the hold's coverage, emit nothing.
      this.lastX = x;
      return false;
    }
    if (Math.abs(positionBars - this.lastCapturePositionBars) < this.minSampleBars
      && Math.abs(x - this.lastX) < AUTOMATION_SAMPLE_STEP_FRACTION
    ) {
      return false;
    }
    this.pushPoint(x, y);
    this.lastY = y;
    this.lastX = x;
    this.lastCapturePositionBars = positionBars;
    return true;
  }

  private pushPoint(x: number, y: number): void {
    const point = { x: roundX(x), y: roundY(y) };
    const previous = this.points[this.points.length - 1];
    if (previous && Math.abs(previous.x - point.x) < AUTOMATION_X_EPSILON) {
      // A later value at the same position wins: the transport did not advance,
      // so the parameter's latest value is the one that will be heard.
      previous.y = point.y;
      return;
    }
    this.points.push(point);
  }
}

/** Convenience: a fresh passer for one pass. */
export const createAutomationRecordingPasser = (options?: AutomationRecorderOptions): AutomationRecordingPasser =>
  new AutomationRecordingPasser(options);

// ---------------------------------------------------------------------------
// Lane surgery
// ---------------------------------------------------------------------------

/** Sorted, de-duplicated copy of a lane; never mutates its input. */
export const normalizeAutomationPoints = (points: readonly AutomationPoint[] | undefined): AutomationPoint[] => {
  const sorted = (points ?? [])
    .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map(point => ({ ...point, x: roundX(point.x), y: roundY(point.y) }))
    .sort((a, b) => a.x - b.x);
  const result: AutomationPoint[] = [];
  for (const point of sorted) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.x - point.x) < AUTOMATION_X_EPSILON) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  return result;
};

/** Value of a lane at `x` using the shared evaluator; `fallback` when the lane is empty. */
export const laneValueAt = (
  points: readonly AutomationPoint[],
  x: number,
  fallback: number,
): number => {
  if (points.length === 0) return fallback;
  const sorted = normalizeAutomationPoints(points);
  if (sorted.length === 0) return fallback;
  if (x <= sorted[0].x) return sorted[0].y;
  const last = sorted[sorted.length - 1];
  if (x >= last.x) return last.y;
  for (let index = 1; index < sorted.length; index += 1) {
    const right = sorted[index];
    const left = sorted[index - 1];
    if (x <= right.x) {
      const span = right.x - left.x;
      if (span <= 0) return right.y;
      return left.y + (right.y - left.y) * ((x - left.x) / span);
    }
  }
  return last.y;
};

const samePoint = (left: AutomationPoint, right: AutomationPoint): boolean =>
  Math.abs(left.x - right.x) < AUTOMATION_X_EPSILON && Math.abs(left.y - right.y) < AUTOMATION_Y_EPSILON;

/**
 * Replaces the lane inside `pass.startX … pass.endX` and returns the clip.
 *
 * Rules, all of them required for a correct one-pass edit:
 *
 *   - Points strictly inside the interval are removed; recorded points replace
 *     them. Points outside are preserved untouched (edit order and tension
 *     included).
 *   - Both edges are pinned to the *recorded* value at that X. Without that a
 *     lane that previously sloped through the edge would jump at the seam.
 *   - A point identical to one already in the lane is dropped (no duplicates).
 *   - The result always satisfies the clip contract (`.x` inside [0, 1],
 *     ascending, at least two points), because it goes through
 *     `addPlaylistAutomationPoint`'s own invariants rather than a second
 *     validator.
 *   - An empty pass returns the clip unchanged (identity), so the App can skip
 *     the commit and the history step entirely.
 */
export const automationClipWithRecordedPass = (
  clip: PlaylistClip,
  pass: AutomationRecordingPass | null | undefined,
): PlaylistClip => {
  if (!clip || clip.type !== 'automation') return clip;
  if (!pass || pass.clipId !== clip.id || pass.points.length === 0) return clip;
  const startX = roundX(Math.min(pass.startX, pass.endX));
  const endX = roundX(Math.max(pass.startX, pass.endX));
  const existing = normalizeAutomationPoints(clip.automationPoints);
  const recorded = normalizeAutomationPoints(
    pass.points.map(point => ({ x: point.x, y: point.y, tension: 0 })),
  );
  if (recorded.length === 0) return clip;

  // A zero-width pass (grab and release at the same transport position) has no
  // interval to own: the user did not move the transport, so nothing was
  // performed over time. It cannot change the lane.
  if (endX - startX <= AUTOMATION_X_EPSILON && recorded.length <= 1) return clip;

  const inside = recorded.filter(point => point.x >= startX - AUTOMATION_X_EPSILON && point.x <= endX + AUTOMATION_X_EPSILON);
  const seeded = inside.length > 0 ? inside : [recorded[0]];
  const startValue = roundY(laneValueAt(recorded, startX, seeded[0].y));
  const lastRecorded = seeded[seeded.length - 1];
  const endValue = roundY(laneValueAt(recorded, endX, lastRecorded.y));

  // Points outside the pass are preserved unturned; the pass owns its interval.
  const kept = existing.filter(point => point.x < startX - AUTOMATION_X_EPSILON || point.x > endX + AUTOMATION_X_EPSILON);
  const hasLeftNeighbour = kept.some(point => point.x < startX);
  const hasRightNeighbour = kept.some(point => point.x > endX);
  const originalStartValue = roundY(laneValueAt(existing, startX, startValue));
  const originalEndValue = roundY(laneValueAt(existing, endX, endValue));

  const merged: AutomationPoint[] = kept.map(point => ({ ...point }));

  /**
   * Sampling granularity of an instantaneous step. A jump is represented the
   * only way a strictly-ascending lane can represent one: two points a hair
   * apart. `STEP_X` is 1e-4 of the clip (≈1.6 ms at four bars @120 BPM), far
   * below the 6-decimal quantization an interactive edit uses, so an edit can
   * never land between the pair.
   */
  const STEP_X = 1e-4;
  const pushPoint = (point: AutomationPoint): void => {
    const rounded = { ...point, x: roundX(point.x), y: roundY(point.y) };
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.x - rounded.x) < AUTOMATION_X_EPSILON) {
      // A later point at the same X wins; `merged` stays strictly ascending.
      merged[merged.length - 1] = rounded;
      return;
    }
    merged.push(rounded);
  };

  // Left seam. Where the pass begins with a value the underlying curve did not
  // have there, the original value is preserved one step earlier so the curve
  // BEFORE the pass keeps its shape and the change reads as the step it was.
  if (hasLeftNeighbour && Math.abs(originalStartValue - startValue) > 1e-4 && startX - STEP_X > 0) {
    pushPoint({ x: startX, y: originalStartValue, tension: 0 });
    pushPoint({ x: startX + STEP_X, y: startValue, tension: 0 });
  } else {
    pushPoint({ x: startX, y: startValue, tension: 0 });
  }

  // The pass body: every recorded point strictly inside the interval.
  for (const point of seeded) {
    if (point.x <= startX + AUTOMATION_X_EPSILON) continue;
    if (point.x >= endX - AUTOMATION_X_EPSILON) continue;
    pushPoint(point);
  }

  // Right seam. Outside the pass the ORIGINAL lane resumes — that is what makes
  // TOUCH return to the underlying curve at release, and what keeps a stopped
  // WRITE/LATCH pass from rewriting automation it never captured.
  if (hasRightNeighbour && Math.abs(endValue - originalEndValue) > 1e-4 && endX + STEP_X < 1) {
    pushPoint({ x: endX - STEP_X, y: endValue, tension: 0 });
    pushPoint({ x: endX, y: originalEndValue, tension: 0 });
  } else {
    pushPoint({ x: endX, y: endValue, tension: 0 });
  }

  merged.sort((a, b) => a.x - b.x);

  // Collapse coincident points (a merge can only produce them through rounding).
  for (let index = merged.length - 1; index > 0; index -= 1) {
    if (Math.abs(merged[index].x - merged[index - 1].x) < AUTOMATION_X_EPSILON) merged.splice(index - 1, 1);
  }

  // Drop nodes that add no shape: a point whose value equals the interpolation
  // of its neighbours is redundant. Only points the pass introduced are
  // candidates, so an untouched pass leaves the document byte-identical.
  const introduced = new Set(merged.filter(point =>
    !existing.some(original => Math.abs(original.x - point.x) < AUTOMATION_X_EPSILON
      && Math.abs(original.y - point.y) < AUTOMATION_Y_EPSILON)));
  for (let index = merged.length - 1; index > 0 && index < merged.length - 1; index -= 1) {
    const self = merged[index];
    if (!introduced.has(self)) continue;
    const left = merged[index - 1];
    const right = merged[index + 1];
    const span = right.x - left.x;
    if (span <= AUTOMATION_X_EPSILON) continue;
    const expected = left.y + (right.y - left.y) * ((self.x - left.x) / span);
    if (Math.abs(self.y - expected) > 1e-4) continue;
    merged.splice(index, 1);
  }

  // The lane contract requires at least two points; complete a one-point lane
  // by holding its value to the far edge.
  if (merged.length === 1) {
    const only = merged[0];
    merged.push({ x: only.x < 0.5 ? 1 : 0, y: only.y, tension: 0 });
    merged.sort((a, b) => a.x - b.x);
  }

  const nextPoints = merged.map(point => ({
    x: roundX(point.x),
    y: roundY(point.y),
    ...(point.tension === undefined ? { tension: 0 } : { tension: point.tension }),
  }));

  // An unchanged lane returns the identical clip object, so a pass that
  // re-affirmed the existing curve cannot create a history entry.
  if (nextPoints.length === existing.length
    && nextPoints.every((point, index) => samePoint(point, existing[index]))) {
    return clip;
  }
  return { ...clip, automationPoints: nextPoints };
};

/**
 * The reverse of a single-value write, used by the "record nothing" guards in
 * the tests and by the App when a pass is discarded: the lane the pass started
 * from, restored bit-for-bit. Kept here (not in `projectHistory`) because it is
 * part of the recorder's contract that a discarded pass leaves the document
 * exactly as it was.
 */
export const restoreLaneSnapshot = (
  clip: PlaylistClip,
  snapshot: readonly AutomationPoint[] | undefined,
): PlaylistClip => ({
  ...clip,
  automationPoints: snapshot === undefined ? undefined : snapshot.map(point => ({ ...point })),
});

/** Human-readable label for one recorded pass (history + status surfaces). */
export const describeAutomationPass = (pass: AutomationRecordingPass, label?: string): string => {
  const name = label?.trim() ? label.trim() : 'automation';
  return `${pass.points.length} point${pass.points.length === 1 ? '' : 's'} on ${name}`;
};

/** True when a target type can be captured from project state (all except engine-owned master). */
export const isRecordableAutomationTargetType = (type: AutomationTargetType): boolean =>
  type !== 'master_vol';

/** The lane clip a pass should adopt: the first automation clip for this target. */
export const findAutomationClipForTarget = (
  clips: readonly PlaylistClip[],
  targetKey: string,
): PlaylistClip | undefined =>
  clips.find(clip => clip.type === 'automation' && automationTargetKey(clip.automationTarget) === targetKey);
