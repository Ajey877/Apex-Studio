/**
 * Phase 1L — punch-in / punch-out recording policy (pure musical arithmetic).
 *
 * A punch take records a fixed musical window: capture starts exactly at the
 * punch-in position and stops exactly at punch-out, and the recorded clip is
 * placed at the punch-in bar. This module owns the musical policy only — no
 * timers, no audio nodes, no React. The runtime split is exactly the Phase 1K
 * one:
 *
 *   src/music/punchRecording.ts       what the window MEANS (this file)
 *   src/audio/countInScheduler.ts     the pre-roll/count-in clicks before it
 *   src/audio/punchCaptureWindow.ts   the punch-out stop moment
 *   src/audio/recordingEngine.ts      the one and only microphone capture path
 *
 * Position conventions (the transport's own):
 *   - a punch position is `{ bar, beat }` in the transport readout's notation:
 *     1-based bar, 1-based beat, where "beat" is the METRONOME PULSE of the
 *     active meter (`resolveMeterPulseLayout`) — quarter pulses in 4/4 and 3/4,
 *     eighth pulses in 6/8 and 7/8, exactly like the transport's bar.beat.step
 *     display. That is why the setting is stored as bar/beat rather than as
 *     absolute beats: it follows the project's documented bar-anchored clip
 *     policy, so a meter change keeps "bar 9 beat 1" on bar 9 beat 1 (only its
 *     length in seconds changes), never a mid-bar position.
 *   - runtime arithmetic happens in absolute quarter-note beats
 *     (`MusicalBeats`), the same unit the count-in scheduler plans in.
 *
 * Defined take behaviour at the end of the project:
 *   - a punch-out beyond the arrangement end (`totalBars`) is TRUNCATED at the
 *     end: the take stops there and the clip is shortened, so a punch take can
 *     never extend the timeline or record past the arrangement;
 *   - a punch-in at or beyond the arrangement end is rejected outright.
 */
import {
  beatsPerBar,
  beatsToSeconds,
  SIXTEENTH_STEPS_PER_BEAT,
  type MusicalBeats,
  type Seconds,
  type TimeSignature,
} from './musicalTime';
import { resolveMeterPulseLayout, type SevenEightGrouping } from './meterPulse';
import { isCountInBars, type CountInBars } from './countIn';

/** A punch position in the transport's bar.beat notation (both 1-based). */
export interface PunchPosition {
  /** 1-based transport bar (bar 1 is the first bar of the arrangement). */
  readonly bar: number;
  /** 1-based metronome pulse inside the bar (4/4: 1..4, 7/8: 1..7). */
  readonly beat: number;
}

/** The persisted punch setting (`ProjectMetadata.punchRecording`). */
export interface PunchRecordingSettings {
  /** When false the recorder behaves exactly like an ordinary take. */
  readonly enabled: boolean;
  readonly inBar: number;
  readonly inBeat: number;
  readonly outBar: number;
  readonly outBeat: number;
}

/** Punch window length offered as a default for a fresh project. */
export const DEFAULT_PUNCH_LENGTH_BARS = 4;

export const DEFAULT_PUNCH_RECORDING: PunchRecordingSettings = Object.freeze({
  enabled: false,
  inBar: 1,
  inBeat: 1,
  outBar: 1 + DEFAULT_PUNCH_LENGTH_BARS,
  outBeat: 1,
});

export function isPunchPosition(value: unknown): value is PunchPosition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { bar?: unknown; beat?: unknown };
  const { bar, beat } = candidate;
  return typeof bar === 'number' && Number.isSafeInteger(bar) && bar >= 1
    && typeof beat === 'number' && Number.isFinite(beat) && beat >= 1;
}

/**
 * Recognises a stored punch setting. Deliberately structural: an older project
 * has no `punchRecording` field at all, and a hand-edited document may hold
 * anything, so every caller resolves through `resolvePunchRecording`.
 */
export function isPunchRecordingSettings(value: unknown): value is PunchRecordingSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === 'boolean'
    && isPunchPosition({ bar: candidate.inBar, beat: candidate.inBeat })
    && isPunchPosition({ bar: candidate.outBar, beat: candidate.outBeat });
}

/**
 * Resolves the stored `ProjectMetadata.punchRecording`. Missing or malformed
 * values resolve to the disabled default WITHOUT rewriting the document, so a
 * project saved before Phase 1L keeps recording ordinary takes.
 */
export function resolvePunchRecording(
  meta: { punchRecording?: unknown } | null | undefined
): PunchRecordingSettings {
  const candidate = meta && typeof meta === 'object' ? meta.punchRecording : undefined;
  return isPunchRecordingSettings(candidate)
    ? Object.freeze({
        enabled: candidate.enabled,
        inBar: candidate.inBar,
        inBeat: candidate.inBeat,
        outBar: candidate.outBar,
        outBeat: candidate.outBeat,
      })
    : DEFAULT_PUNCH_RECORDING;
}

/** The meter context every punch calculation needs. */
export interface PunchMeterContext {
  readonly meter: TimeSignature;
  readonly grouping?: SevenEightGrouping;
}

/** Quarter-note beats of one displayed beat (1 in 4/4 and 3/4, 0.5 in 6/8 and 7/8). */
export function beatsPerDisplayedBeat(context: PunchMeterContext): MusicalBeats {
  return resolveMeterPulseLayout(context.meter, context.grouping).stepsPerPulse / SIXTEENTH_STEPS_PER_BEAT;
}

/** How many pulses the transport counts inside one bar of this meter. */
export function displayedBeatsPerBar(context: PunchMeterContext): number {
  return resolveMeterPulseLayout(context.meter, context.grouping).pulses.length;
}

/** Snaps a beat position onto the meter's pulse grid (the grid the UI edits). */
export function snapBeatsToPulseGrid(beats: MusicalBeats, context: PunchMeterContext): MusicalBeats {
  if (!Number.isFinite(beats) || beats <= 0) return 0;
  const pulseBeats = beatsPerDisplayedBeat(context);
  return Math.round(beats / pulseBeats) * pulseBeats;
}

/** Absolute quarter-note beats of a bar.beat position (bar 1 beat 1 = 0). */
export function barBeatToBeats(position: PunchPosition, context: PunchMeterContext): MusicalBeats {
  const barBeats = beatsPerBar(context.meter);
  const bar = Math.max(1, Math.floor(position.bar));
  const pulseBeats = beatsPerDisplayedBeat(context);
  const beatsPerBarPulses = Math.max(1, Math.round(barBeats / pulseBeats));
  // A beat past the end of the bar rolls into the next bar rather than being
  // silently clamped, so "bar 5 beat 5" in 4/4 means bar 6 beat 1.
  const barOverflow = Math.floor((position.beat - 1) / beatsPerBarPulses);
  const beatInBar = position.beat - 1 - barOverflow * beatsPerBarPulses;
  return (bar - 1 + barOverflow) * barBeats + beatInBar * pulseBeats;
}

/** The bar.beat position of an absolute beat, on the meter's pulse grid. */
export function beatsToBarBeat(beats: MusicalBeats, context: PunchMeterContext): PunchPosition {
  const barBeats = beatsPerBar(context.meter);
  const safe = Number.isFinite(beats) && beats > 0 ? snapBeatsToPulseGrid(beats, context) : 0;
  const bar = Math.floor(safe / barBeats + 1e-9) + 1;
  const pulseBeats = beatsPerDisplayedBeat(context);
  const beat = Math.floor((safe - (bar - 1) * barBeats) / pulseBeats + 1e-9) + 1;
  return Object.freeze({ bar, beat });
}

/** Display string matching the transport readout, e.g. "05.3". */
export function formatPunchPosition(position: PunchPosition): string {
  return `${String(Math.max(1, Math.floor(position.bar))).padStart(2, '0')}.${Math.max(1, Math.floor(position.beat))}`;
}

/** Absolute beats of the two stored endpoints. */
export function punchRangeBeats(
  settings: PunchRecordingSettings,
  context: PunchMeterContext
): { inBeats: MusicalBeats; outBeats: MusicalBeats } {
  return {
    inBeats: barBeatToBeats({ bar: settings.inBar, beat: settings.inBeat }, context),
    outBeats: barBeatToBeats({ bar: settings.outBar, beat: settings.outBeat }, context),
  };
}

export interface PunchValidationContext extends PunchMeterContext {
  /** Arrangement length in bars (`ProjectState.totalBars`, resolved). */
  readonly totalBars: number;
}

export type PunchValidationIssue = { readonly field: 'in' | 'out' | 'range'; readonly message: string };

export interface PunchRangeBeats {
  readonly inBeats: MusicalBeats;
  readonly outBeats: MusicalBeats;
}

export interface PunchValidationResult {
  /** True when the window can be recorded as-is. */
  readonly valid: boolean;
  /** Blocking problems: the take cannot be armed. */
  readonly issues: readonly PunchValidationIssue[];
  /** Non-blocking notes: the take can be armed, with the stated adjustment. */
  readonly warnings: readonly PunchValidationIssue[];
  /** Present whenever both endpoints are well-formed positions. */
  readonly range: PunchRangeBeats | null;
}

/**
 * Validates the stored endpoints against the active meter and the arrangement
 * length. Endpoint sanity is reported separately from the ordering rule so the
 * UI can point at the field the user has to fix.
 *
 * A punch-out beyond the arrangement end is a WARNING, not an error: the
 * defined take behaviour is that capture stops at the end of the project and
 * the take is shortened (see `planPunchCapture`). A punch-in beyond the end is
 * an error — there is nothing there to record.
 */
export function validatePunchRecording(
  settings: PunchRecordingSettings,
  context: PunchValidationContext
): PunchValidationResult {
  const issues: PunchValidationIssue[] = [];
  const warnings: PunchValidationIssue[] = [];
  const totalBars = Number.isFinite(context.totalBars) && context.totalBars > 0
    ? Math.floor(context.totalBars)
    : 0;
  const maxBeat = displayedBeatsPerBar(context);

  const checkEndpoint = (field: 'in' | 'out', bar: number, beat: number): void => {
    const label = field === 'in' ? 'Punch-in' : 'Punch-out';
    if (!Number.isSafeInteger(bar) || bar < 1) {
      issues.push({ field, message: `${label} bar must be a whole bar number of 1 or more.` });
    } else if (totalBars > 0 && bar > totalBars) {
      if (field === 'in') {
        issues.push({ field, message: `${label} bar ${bar} is past the end of the arrangement (${totalBars} bars).` });
      } else {
        warnings.push({ field, message: `${label} bar ${bar} is past the end of the arrangement — the take will stop at bar ${totalBars}.` });
      }
    }
    if (!Number.isFinite(beat) || beat < 1) {
      issues.push({ field, message: `${label} beat must be 1 or more.` });
    } else if (beat > maxBeat) {
      issues.push({ field, message: `${label} beat ${beat} is past the end of a ${context.meter[0]}/${context.meter[1]} bar (${maxBeat} beats).` });
    }
  };

  checkEndpoint('in', settings.inBar, settings.inBeat);
  checkEndpoint('out', settings.outBar, settings.outBeat);

  const range = issues.length === 0
    ? { inBeats: barBeatToBeats({ bar: settings.inBar, beat: settings.inBeat }, context),
        outBeats: barBeatToBeats({ bar: settings.outBar, beat: settings.outBeat }, context) }
    : null;

  if (range && !(range.outBeats > range.inBeats)) {
    issues.push({ field: 'range', message: 'Punch-out must come after punch-in.' });
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
    warnings: Object.freeze(warnings),
    range: range ? Object.freeze(range) : null,
  });
}

/** True when two punch settings describe the same window and the same mode. */
export function isSamePunchRecording(a: PunchRecordingSettings, b: PunchRecordingSettings): boolean {
  return a.enabled === b.enabled
    && a.inBar === b.inBar && a.inBeat === b.inBeat
    && a.outBar === b.outBar && a.outBeat === b.outBeat;
}

/** The full capture plan the runtime executes for one punch take. */
export interface PunchCapturePlan {
  /** Requested punch-in, absolute quarter beats. */
  readonly inBeats: MusicalBeats;
  /** Requested punch-out, absolute quarter beats. */
  readonly outBeats: MusicalBeats;
  /** Punch-out after the project-end rule: `min(outBeats, projectEndBeats)`. */
  readonly effectiveOutBeats: MusicalBeats;
  /** True when the project end shortened the take. */
  readonly truncatedAtProjectEnd: boolean;
  /** Count-in length actually used (bars) and its musical length (beats). */
  readonly countInBars: CountInBars;
  readonly countInBeats: MusicalBeats;
  /**
   * Musical position the count-in starts at. It is `inBeats - countInBeats`,
   * which is negative when the punch-in sits closer to bar 1 than the count-in
   * is long: pre-roll then runs from a virtual position before the arrangement
   * and capture still begins exactly at punch-in.
   */
  readonly countInStartBeat: MusicalBeats;
  readonly preRollBeforeTimeline: boolean;
  /** Length of the audio that will actually be captured. */
  readonly captureDurationBeats: MusicalBeats;
  readonly captureDurationSeconds: Seconds;
  /** Pre-roll length in seconds at the planning tempo. */
  readonly preRollSeconds: Seconds;
  /** 0-based fractional playlist `startBar` for the recorded clip. */
  readonly clipStartBar: number;
  /** Clip length in bars (fractional — a punch window is rarely whole bars). */
  readonly clipLengthBars: number;
  /** 1-based transport bars, for display. */
  readonly inBar: number;
  readonly effectiveOutBar: number;
}

export interface PunchCapturePlanParams extends PunchValidationContext {
  readonly settings: PunchRecordingSettings;
  /** Project count-in setting (`meta.countInBars`): 0 = Off, 1 or 2 bars. */
  readonly countInBars?: unknown;
  readonly bpm: number;
}

/**
 * Plans one punch take: where the pre-roll starts, where capture begins and
 * ends, and where the recorded clip lands.
 *
 * Throws when the endpoints are invalid (`validatePunchRecording`), because a
 * plan for an invalid window would be a plan to record the wrong music. The
 * count-in is the existing Phase 1K count-in: `bars` full bars of the meter's
 * pulse layout placed immediately BEFORE the punch-in, so capture begins
 * exactly at punch-in and no pre-roll audio can enter the take.
 */
export function planPunchCapture(params: PunchCapturePlanParams): PunchCapturePlan {
  const { settings, bpm } = params;
  const validation = validatePunchRecording(settings, params);
  if (!validation.valid || !validation.range) {
    throw new RangeError(validation.issues.map(issue => issue.message).join(' ') || 'Invalid punch recording range');
  }
  const countInBars: CountInBars = isCountInBars(params.countInBars) ? params.countInBars : 0;
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const barBeats = beatsPerBar(params.meter);
  const projectEndBeats = (Number.isFinite(params.totalBars) && params.totalBars > 0
    ? Math.floor(params.totalBars)
    : 0) * barBeats;

  const { inBeats, outBeats } = validation.range;
  if (projectEndBeats > 0 && inBeats >= projectEndBeats) {
    throw new RangeError(`Punch-in is at or past the end of the arrangement (${Math.floor(params.totalBars)} bars).`);
  }
  const truncatedAtProjectEnd = projectEndBeats > 0 && outBeats > projectEndBeats;
  const effectiveOutBeats = truncatedAtProjectEnd ? projectEndBeats : outBeats;

  const countInBeats = countInBars * barBeats;
  const countInStartBeat = inBeats - countInBeats;
  const captureDurationBeats = effectiveOutBeats - inBeats;

  return Object.freeze({
    inBeats,
    outBeats,
    effectiveOutBeats,
    truncatedAtProjectEnd,
    countInBars,
    countInBeats,
    countInStartBeat,
    preRollBeforeTimeline: countInStartBeat < -1e-9,
    captureDurationBeats,
    captureDurationSeconds: beatsToSeconds(captureDurationBeats, safeBpm),
    preRollSeconds: beatsToSeconds(countInBeats, safeBpm),
    clipStartBar: inBeats / barBeats,
    clipLengthBars: captureDurationBeats / barBeats,
    inBar: beatsToBarBeat(inBeats, params).bar,
    effectiveOutBar: beatsToBarBeat(effectiveOutBeats, params).bar,
  });
}

/** Human summary of a planned take, e.g. "Bars 5.1 – 9.1 · 4 bars · 8.00 s". */
export function describePunchWindow(plan: PunchCapturePlan): string {
  const bars = Math.round(plan.clipLengthBars * 100) / 100;
  return `Bars ${plan.inBar} – ${plan.effectiveOutBar} · ${bars} bars · ${plan.captureDurationSeconds.toFixed(2)} s`;
}

/** One bar of the ruler overlay: the part of that bar inside the punch window. */
export interface PunchRulerSegment {
  /** 0-based playlist bar index. */
  readonly barIndex: number;
  /** Fraction of the bar where the window starts (0 when the bar is fully inside). */
  readonly startFraction: number;
  /** Fraction of the bar where the window ends (1 when the bar is fully inside). */
  readonly endFraction: number;
  readonly containsIn: boolean;
  readonly containsOut: boolean;
}

/**
 * Bar-by-bar overlay geometry for the playlist ruler, so the selected range is
 * visible on the timeline. Pure presentation math over the same beats the
 * capture plan uses: a bar fully inside the window spans 0..1.
 */
export function punchRulerSegments(
  range: PunchRangeBeats,
  context: PunchValidationContext
): PunchRulerSegment[] {
  const barBeats = beatsPerBar(context.meter);
  const totalBars = Number.isFinite(context.totalBars) && context.totalBars > 0 ? Math.floor(context.totalBars) : 0;
  const segments: PunchRulerSegment[] = [];
  if (!range || !(range.outBeats > range.inBeats) || barBeats <= 0) return segments;
  const firstBar = Math.floor(range.inBeats / barBeats + 1e-9);
  const lastBar = Math.max(firstBar, Math.ceil(range.outBeats / barBeats - 1e-9) - 1);
  for (let barIndex = firstBar; barIndex <= lastBar; barIndex++) {
    if (totalBars > 0 && barIndex >= totalBars) break;
    const barStart = barIndex * barBeats;
    const barEnd = barStart + barBeats;
    const startFraction = Math.min(1, Math.max(0, (range.inBeats - barStart) / barBeats));
    const endFraction = Math.min(1, Math.max(0, (Math.min(range.outBeats, barEnd) - barStart) / barBeats));
    if (endFraction <= startFraction) continue;
    segments.push({
      barIndex,
      startFraction,
      endFraction,
      containsIn: Math.abs(range.inBeats - barStart) < 1e-9 || (range.inBeats > barStart && range.inBeats < barEnd),
      containsOut: Math.abs(range.outBeats - barEnd) < 1e-9 || (range.outBeats > barStart && range.outBeats < barEnd),
    });
  }
  return segments;
}

/**
 * Punch position for the transport's current bar/step, i.e. "at the playhead".
 * `currentStep` is the transport's step inside the bar (sixteenth-note grid),
 * the same value the transport beat readout formats.
 */
export function punchPositionFromTransport(
  currentBar: number,
  currentStep: number,
  context: PunchMeterContext
): PunchPosition {
  const bar = Number.isSafeInteger(currentBar) && currentBar >= 1 ? currentBar : 1;
  const step = Number.isFinite(currentStep) && currentStep >= 0 ? Math.floor(currentStep) : 0;
  const stepsPerPulse = resolveMeterPulseLayout(context.meter, context.grouping).stepsPerPulse;
  const pulsesPerBar = displayedBeatsPerBar(context);
  const stepsPerBar = stepsPerPulse * pulsesPerBar;
  const wrapped = stepsPerBar > 0 ? step % stepsPerBar : 0;
  return Object.freeze({ bar, beat: Math.floor(wrapped / stepsPerPulse) + 1 });
}
