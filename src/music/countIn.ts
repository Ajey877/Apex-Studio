/**
 * Phase 1K — recording count-in policy (pure musical arithmetic).
 *
 * The count-in is N bars of metronome clicks played BEFORE audio capture
 * begins. It owns no timers and no audio nodes: `src/audio/countInScheduler.ts`
 * turns a `CountInSchedule` into scheduled clicks, and the recording modal
 * starts `MediaRecorder` only after the schedule's capture moment, so a
 * count-in click can never enter the recorded take.
 *
 * Musical rules:
 *   - The count-in is `bars` full bars of the RESOLVED project meter, clicked
 *     on the meter's pulse layout (`resolveMeterPulseLayout`) so its accents
 *     match the metronome exactly — quarter pulses in 4/4 and 3/4, eighth
 *     pulses in 6/8 (3+3) and 7/8 (the selected 2+2+3 / 3+2+2 / 2+3+2).
 *   - Capture begins exactly one count-in after the start position:
 *     `captureBeat = startBeat + bars * beatsPerBar(meter)`. With `bars = 0`
 *     (Off) capture begins at the current position — the pre-Phase-1K
 *     behaviour.
 *   - The start position is snapped UP to the next bar line of the active
 *     meter (a count-in always begins on a bar line and capture always lands
 *     on one), so the take is recorded at a predictable musical position.
 *   - Count-in clicks are pure audio events. They are never written into
 *     `Note`/`Pattern` data and never scheduled as instrument voices.
 *
 * Temporal behaviour (owned by the scheduler, described here because it is
 * part of the contract):
 *   - A tempo change re-times the remaining clicks in place: the musical plan
 *     (which beats click, and which beat capture starts on) is unchanged.
 *   - A meter or 7/8 grouping change restarts the count-in under the new
 *     layout, because "N bars" no longer describes the same musical length.
 *   - Stop / cancel / seek abort the count-in entirely: every pending click is
 *     silenced and the capture promise rejects with `CountInCancelledError`.
 */
import {
  beatsPerBar,
  beatsToSeconds,
  SIXTEENTH_STEPS_PER_BEAT,
  type MusicalBeats,
} from './musicalTime';
import type { MeterPulseLayout, PulseLevel } from './meterPulse';

/** Count-in length setting: Off, 1 bar or 2 bars. Nothing else is accepted. */
export type CountInBars = 0 | 1 | 2;

export const COUNT_IN_OPTIONS: readonly CountInBars[] = Object.freeze([0, 1, 2] as const);

/** Projects saved before Phase 1K omit the field and keep recording immediate. */
export const DEFAULT_COUNT_IN_BARS: CountInBars = 0;

export function isCountInBars(value: unknown): value is CountInBars {
  return value === 0 || value === 1 || value === 2;
}

/**
 * Resolves the stored `ProjectMetadata.countInBars`. Missing or unrecognised
 * values resolve to Off without rewriting the document.
 */
export function resolveCountInBars(
  meta: { countInBars?: unknown } | null | undefined
): CountInBars {
  const candidate = meta && typeof meta === 'object' ? meta.countInBars : undefined;
  return isCountInBars(candidate) ? candidate : DEFAULT_COUNT_IN_BARS;
}

export function describeCountInBars(bars: CountInBars): string {
  return bars === 0 ? 'Off' : bars === 1 ? '1 bar' : '2 bars';
}

/** One scheduled count-in click, in musical offsets from the count-in start. */
export interface CountInClick {
  /** Count-in bar index, 0-based (0 = the first counted bar). */
  readonly barIndex: number;
  /** Pulse index inside the bar — identical to `MeterPulse.index`. */
  readonly pulseIndex: number;
  /** Click voice: 'downbeat' on every counted bar line, else the pulse level. */
  readonly level: PulseLevel;
  /** Quarter-note beats after the count-in start. */
  readonly beatOffset: MusicalBeats;
  /** Sixteenth-note steps after the count-in start (always an integer). */
  readonly stepOffset: number;
}

export interface CountInSchedule {
  readonly bars: CountInBars;
  readonly layout: MeterPulseLayout;
  readonly bpm: number;
  /** Count-in length in quarter-note beats. */
  readonly durationBeats: MusicalBeats;
  /** Count-in length in seconds at the schedule's tempo. */
  readonly durationSeconds: number;
  /** Exactly `bars * pulsesPerBar` clicks, all strictly before capture. */
  readonly clicks: readonly CountInClick[];
}

/**
 * Builds the complete click list for one count-in. Every click is known up
 * front (a count-in is at most two bars), so the scheduler needs no interval
 * timer and cannot leave stale ones behind.
 */
export function buildCountInSchedule(params: {
  bars: CountInBars;
  layout: MeterPulseLayout;
  bpm: number;
}): CountInSchedule {
  const bars = isCountInBars(params.bars) ? params.bars : DEFAULT_COUNT_IN_BARS;
  const { layout } = params;
  const bpm = Number.isFinite(params.bpm) && params.bpm > 0 ? params.bpm : 120;
  const durationBeats = bars * beatsPerBar(layout.meter);
  const clicks: CountInClick[] = [];
  for (let barIndex = 0; barIndex < bars; barIndex++) {
    for (const pulse of layout.pulses) {
      const stepOffset = barIndex * layout.stepsPerBar + pulse.step;
      clicks.push({
        barIndex,
        pulseIndex: pulse.index,
        // Every counted bar line clicks a downbeat so a 2-bar count-in sounds
        // like "1 … | 1 …" — the same accents the metronome would play there.
        level: pulse.index === 0 ? 'downbeat' : pulse.level,
        stepOffset,
        beatOffset: stepOffset / SIXTEENTH_STEPS_PER_BEAT,
      });
    }
  }
  return Object.freeze({
    bars,
    layout,
    bpm,
    durationBeats,
    durationSeconds: beatsToSeconds(durationBeats, bpm),
    clicks: Object.freeze(clicks),
  });
}

export interface CountInCapturePlan {
  /** Quarter-beat position where the count-in starts (bar line of the meter). */
  readonly startBeat: MusicalBeats;
  /** Quarter-beat position where capture begins (`startBeat + durationBeats`). */
  readonly captureBeat: MusicalBeats;
  /** 1-based transport bar number where capture begins. */
  readonly captureBar: number;
  /** 0-based playlist `startBar` the recorded clip belongs at. */
  readonly clipStartBar: number;
}

/**
 * Bar numbers of a capture position. `captureBar` is the 1-based transport
 * bar the take starts in; `clipStartBar` is the 0-based playlist `startBar`
 * the recorded clip must be placed at so playback lands on the same bar.
 */
export function captureBarNumbers(
  captureBeat: MusicalBeats,
  meter: Parameters<typeof beatsPerBar>[0]
): { captureBar: number; clipStartBar: number } {
  const barBeats = beatsPerBar(meter);
  const barIndex = Math.floor((captureBeat * SIXTEENTH_STEPS_PER_BEAT) / (barBeats * SIXTEENTH_STEPS_PER_BEAT) + 1e-9);
  return { captureBar: barIndex + 1, clipStartBar: barIndex };
}

/**
 * Plans where a count-in starts and where recording begins after it.
 *
 * `positionBeats` is the transport's musical position when recording is
 * requested. The count-in snaps UP to the next bar line of `meter` (a count-in
 * always begins on a bar line). A request already on a bar line counts from
 * that line: bar 5 + a 1-bar count-in captures at bar 6. A request at bar 5
 * beat 3 in 4/4 snaps to bar 6, counts bar 6, and captures at bar 7.
 *
 * With `bars = 0` (Off) the plan is the identity: capture begins at the
 * request position itself, preserving pre-Phase-1K behaviour.
 */
export function planCountInCapturePosition(
  positionBeats: MusicalBeats,
  meter: Parameters<typeof beatsPerBar>[0],
  bars: CountInBars
): CountInCapturePlan {
  const safePosition = Number.isFinite(positionBeats) && positionBeats > 0 ? positionBeats : 0;
  const barBeats = beatsPerBar(meter);
  if (!isCountInBars(bars) || bars === 0) {
    return Object.freeze({
      startBeat: safePosition,
      captureBeat: safePosition,
      ...captureBarNumbers(safePosition, meter),
    });
  }
  // Snap up to the next bar line; already-on-a-line positions stay put.
  const startBeat = Math.ceil(safePosition / barBeats - 1e-9) * barBeats;
  const captureBeat = startBeat + bars * barBeats;
  return Object.freeze({
    startBeat,
    captureBeat,
    ...captureBarNumbers(captureBeat, meter),
  });
}
