/**
 * Phase 1J — meter selection, pulse grouping and accent resolution.
 *
 * Pure musical policy shared by the Project Settings selector, the playlist
 * ruler and the metronome scheduler. It owns no timing authority of its own:
 * every bar size comes from `stepsPerBar()` of a meter accepted by
 * `isRuntimeSupportedMeter()` (musicalTime.ts), and every caller passes the
 * meter it resolved through `resolveProjectTimeSignature()`.
 *
 * Pulse policy (what a musician hears from the metronome and sees on the ruler):
 *
 *   4/4  four quarter-note pulses   (steps 0, 4, 8, 12)        accent: 1
 *   3/4  three quarter-note pulses  (steps 0, 4, 8)            accent: 1
 *   6/8  six eighth-note pulses     (steps 0, 2, 4, 6, 8, 10)  accents: 1, 4  (3+3)
 *   7/8  seven eighth-note pulses   (steps 0, 2, … 12)         accents from the
 *        configurable grouping: 2+2+3 (default), 3+2+2 or 2+3+2.
 *
 * 6/8 keeps its mechanical runtime grid (12 sixteenth steps per bar); the 3+3
 * grouping is a metronome/ruler accent only and does not move any note.
 */
import { isRuntimeSupportedMeter, LEGACY_TIME_SIGNATURE, stepsPerBar, type TimeSignature } from './musicalTime';

/** The four meters the runtime executes truthfully, in selector order. */
export const SUPPORTED_TIME_SIGNATURES: readonly TimeSignature[] = Object.freeze([
  Object.freeze([4, 4] as const),
  Object.freeze([3, 4] as const),
  Object.freeze([6, 8] as const),
  Object.freeze([7, 8] as const),
]);

export type SupportedTimeSignatureLabel = '4/4' | '3/4' | '6/8' | '7/8';

export const formatTimeSignature = (meter: TimeSignature): string => `${meter[0]}/${meter[1]}`;

/**
 * Parses a selector value ("7/8") into a supported meter. Anything else —
 * "5/4", "7/4", "abc", "7/8/1" — returns null so callers can reject it instead
 * of storing a meter the runtime would silently play as 4/4.
 */
export function parseSupportedTimeSignature(value: unknown): TimeSignature | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(value);
  if (!match) return null;
  const candidate = [Number(match[1]), Number(match[2])];
  return isRuntimeSupportedMeter(candidate) ? Object.freeze([candidate[0], candidate[1]] as const) : null;
}

export const isSameTimeSignature = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && a[0] === b[0] && a[1] === b[1];

/**
 * Describes the stored meter for display. A stored meter outside the supported
 * set (an older/hand-edited project) is reported honestly together with the
 * grid the runtime actually plays (the legacy 4/4 fallback).
 */
export function describeStoredTimeSignature(stored: unknown): {
  label: string;
  supported: boolean;
  runtime: TimeSignature;
} {
  if (isRuntimeSupportedMeter(stored)) {
    return { label: formatTimeSignature(stored), supported: true, runtime: stored };
  }
  const label = Array.isArray(stored) && stored.length === 2 && stored.every(v => typeof v === 'number' && Number.isFinite(v))
    ? `${stored[0]}/${stored[1]}`
    : 'missing';
  return { label, supported: false, runtime: LEGACY_TIME_SIGNATURE };
}

// --- 7/8 accent grouping ----------------------------------------------------

export const SEVEN_EIGHT_GROUPINGS = Object.freeze(['2+2+3', '3+2+2', '2+3+2'] as const);
export type SevenEightGrouping = (typeof SEVEN_EIGHT_GROUPINGS)[number];
export const DEFAULT_SEVEN_EIGHT_GROUPING: SevenEightGrouping = '2+2+3';

export const isSevenEightGrouping = (value: unknown): value is SevenEightGrouping =>
  typeof value === 'string' && (SEVEN_EIGHT_GROUPINGS as readonly string[]).includes(value);

/**
 * Resolves the stored 7/8 grouping. Missing (every project saved before
 * Phase 1J) or unrecognised values resolve to the 2+2+3 default without
 * rewriting the document.
 */
export const resolveSevenEightGrouping = (
  meta: { sevenEightGrouping?: unknown } | null | undefined
): SevenEightGrouping => {
  const candidate = meta && typeof meta === 'object' ? meta.sevenEightGrouping : undefined;
  return isSevenEightGrouping(candidate) ? candidate : DEFAULT_SEVEN_EIGHT_GROUPING;
};

// --- pulses -----------------------------------------------------------------

export type PulseLevel = 'downbeat' | 'accent' | 'pulse';

export interface MeterPulse {
  /** Pulse index inside the bar (0-based). */
  readonly index: number;
  /** Sixteenth-note step inside the bar at which the pulse sounds. */
  readonly step: number;
  readonly level: PulseLevel;
}

export interface MeterPulseLayout {
  readonly meter: TimeSignature;
  /** Sixteenth steps between pulses: 4 (quarter) or 2 (eighth). */
  readonly stepsPerPulse: number;
  readonly stepsPerBar: number;
  /** Group sizes in pulses; their sum is the pulse count of the bar. */
  readonly groups: readonly number[];
  readonly pulses: readonly MeterPulse[];
}

const groupsFor = (meter: TimeSignature, grouping: SevenEightGrouping): number[] => {
  if (meter[0] === 7 && meter[1] === 8) return grouping.split('+').map(Number);
  if (meter[0] === 6 && meter[1] === 8) return [3, 3];
  return [meter[0]];
};

/**
 * The pulse layout of one bar. Unsupported meters resolve to the legacy 4/4
 * layout, matching the runtime fallback, so the metronome can never click a
 * grid that playback is not using.
 */
export function resolveMeterPulseLayout(
  meter: TimeSignature,
  grouping: SevenEightGrouping = DEFAULT_SEVEN_EIGHT_GROUPING
): MeterPulseLayout {
  const resolved = isRuntimeSupportedMeter(meter) ? meter : LEGACY_TIME_SIGNATURE;
  const safeGrouping = isSevenEightGrouping(grouping) ? grouping : DEFAULT_SEVEN_EIGHT_GROUPING;
  const stepsPerPulse = resolved[1] === 8 ? 2 : 4;
  const groups = groupsFor(resolved, safeGrouping);
  const pulses: MeterPulse[] = [];
  let index = 0;
  for (const size of groups) {
    for (let inGroup = 0; inGroup < size; inGroup++) {
      pulses.push({
        index,
        step: index * stepsPerPulse,
        level: index === 0 ? 'downbeat' : inGroup === 0 ? 'accent' : 'pulse',
      });
      index++;
    }
  }
  const barSteps = stepsPerBar(resolved);
  if (index * stepsPerPulse !== barSteps) {
    // Defensive: a layout must tile the runtime bar exactly.
    throw new RangeError(`Pulse layout for ${formatTimeSignature(resolved)} does not tile its ${barSteps}-step bar`);
  }
  return Object.freeze({ meter: resolved, stepsPerPulse, stepsPerBar: barSteps, groups: Object.freeze(groups), pulses: Object.freeze(pulses) });
}

/**
 * The metronome decision for one scheduled sixteenth step.
 *
 * `stepInLoop` is the step the transport reported (bar-relative in Song Mode,
 * pattern-loop-relative in Pattern Mode). It is folded onto the bar grid so a
 * pattern longer than one bar still clicks a downbeat on every bar line, and a
 * pattern loop restart always lands on a downbeat. Returns null when no click
 * belongs on this step. Non-integer or negative steps never click.
 */
export function resolveMetronomeClickLevel(
  layout: MeterPulseLayout,
  stepInLoop: number
): PulseLevel | null {
  if (!Number.isSafeInteger(stepInLoop) || stepInLoop < 0) return null;
  const stepInBar = stepInLoop % layout.stepsPerBar;
  if (stepInBar % layout.stepsPerPulse !== 0) return null;
  return layout.pulses[stepInBar / layout.stepsPerPulse]?.level ?? null;
}

/** Ruler tick marks inside one bar, as fractions of the bar width (0 excluded). */
export function resolveRulerTicks(layout: MeterPulseLayout): Array<{ fraction: number; level: PulseLevel }> {
  return layout.pulses
    .filter(pulse => pulse.index > 0)
    .map(pulse => ({ fraction: pulse.step / layout.stepsPerBar, level: pulse.level }));
}

/** Compact human description, e.g. "7/8 · 2+2+3 eighths". */
export function describePulseLayout(layout: MeterPulseLayout): string {
  const unit = layout.stepsPerPulse === 2 ? 'eighths' : 'quarters';
  return `${formatTimeSignature(layout.meter)} · ${layout.groups.join('+')} ${unit}`;
}
