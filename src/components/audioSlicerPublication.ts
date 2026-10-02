import type { DrumPad, Note } from '../types/daw';
import type { AudioSlice } from '../utils/audioSlicer';
import {
  isSlicerSourceReady,
  slicerSourceMessage,
  type SlicerAudioSource,
} from './audioSlicerSource';

/**
 * Phase 55 — Slicer chop publication integrity.
 *
 * Chop detection itself was already real: `AudioSlicer` measures short-time
 * energy flux over a decoded `AudioBuffer` and returns genuine regions. What
 * left the slicer was not. Both publication actions rebuilt their payload from
 * the slice *count* alone:
 *
 *   notes  = { pitch: 60 + idx, start: idx * 1, duration: 1, velocity: 0.85 }
 *   steps  = [true, true, ...] for the first sixteen indices
 *
 * No sample region, source id or chop length survived that mapping, so the
 * "N chops mapped" toast described sixteen identical piano-roll pitches against
 * a channel that had no way to play any of the detected chops.
 *
 * Publication now carries the chops themselves: every published chop keeps the
 * region the detector found (ratios and seconds), the id of the real sample it
 * belongs to, and the pad note that addresses it. Nothing is published at all
 * when the regions are stale, inverted, out of range or out of order, because a
 * stale region is worse than no publication — it silently rewrites the user's
 * pattern against audio that is no longer on the channel.
 */

/** A drum-pad bank holds sixteen chops, and the step sequencer arms sixteen. */
export const MAX_SLICER_CHOPS = 16;

/**
 * Chops are published from C2, the root the engine already uses for drum-pad
 * channels and the pitch its step sequencer addresses. Publishing from any
 * other root would leave the sequencer's single pitch pointing at nothing,
 * which is the fallback that plays a synthesized drum voice instead of the
 * real chop.
 */
export const SLICER_CHOP_ROOT_NOTE = 36;

/** Float slack when comparing a detected region against the buffer duration. */
const REGION_TOLERANCE_SEC = 1e-4;

/** Velocity the published chop notes are armed with. */
const CHOP_NOTE_VELOCITY = 0.85;

export interface SlicerChop {
  id: string;
  /** Index of the detected slice this chop was published from. */
  sliceId: number;
  /** Zero-based chop position, also the pad/note offset. */
  index: number;
  note: number;
  sampleId: string;
  startRatio: number;
  endRatio: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export type SlicerChopRefusalCode =
  | 'no-source'
  | 'no-slices'
  | 'inverted-region'
  | 'region-out-of-range'
  | 'slices-out-of-order';

export interface SlicerChopRefusal {
  ok: false;
  code: SlicerChopRefusalCode;
  message: string;
}

export interface SlicerChopPublication {
  ok: true;
  chops: SlicerChop[];
  pads: DrumPad[];
  notes: Note[];
  steps: boolean[];
  publishedCount: number;
  droppedCount: number;
}

export type SlicerChopPublicationResult = SlicerChopPublication | SlicerChopRefusal;

/**
 * Type guards, mirroring `isSlicerSourceReady`: the project is compiled without
 * `strictNullChecks`, so a bare `result.ok` check does not discriminate the
 * union and callers would lose the payload/refusal typing.
 */
export const isSlicerChopPublished = (
  result: SlicerChopPublicationResult
): result is SlicerChopPublication => result.ok === true;

export const isSlicerChopRefused = (
  result: SlicerChopPublicationResult
): result is SlicerChopRefusal => result.ok !== true;

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Returns the first integrity problem with `slices`, or `null` when every region
 * is a real, ordered, in-bounds region of a buffer that is `bufferDurationSec`
 * long.
 */
export const slicerChopRegionIssue = (
  slices: readonly AudioSlice[],
  bufferDurationSec: number
): SlicerChopRefusalCode | null => {
  if (slices.length === 0) return 'no-slices';

  let previousEndSec = 0;
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    const startRatio = slice.startRatio;
    const endRatio = slice.endRatio;
    const startSec = slice.startSec;
    const endSec = slice.endSec;

    if (endSec <= startSec || endRatio <= startRatio) return 'inverted-region';

    if (
      startRatio < 0 ||
      endRatio > 1 ||
      startSec < 0 ||
      endSec > bufferDurationSec + REGION_TOLERANCE_SEC
    ) {
      return 'region-out-of-range';
    }

    if (index > 0 && startSec < previousEndSec - REGION_TOLERANCE_SEC) {
      return 'slices-out-of-order';
    }

    previousEndSec = endSec;
  }

  return null;
};

/**
 * Builds the chop records for already-validated slices. Extra slices beyond the
 * sixteen-chop bank are dropped here and reported by `publishSlicerChops`, so
 * the cap is never a silent truncation.
 */
export const buildSlicerChops = (
  slices: readonly AudioSlice[],
  sampleId: string
): SlicerChop[] =>
  slices.slice(0, MAX_SLICER_CHOPS).map((slice, index) => ({
    id: `slicer-chop-${index + 1}`,
    sliceId: slice.id,
    index,
    note: SLICER_CHOP_ROOT_NOTE + index,
    sampleId,
    startRatio: slice.startRatio,
    endRatio: slice.endRatio,
    startSec: slice.startSec,
    endSec: slice.endSec,
    durationSec: Math.max(0, slice.endSec - slice.startSec),
  }));

/** The real, playable chops: one drum pad per chop, trimmed to its region. */
export const slicerChopPads = (chops: readonly SlicerChop[]): DrumPad[] =>
  chops.map(chop => ({
    id: chop.id,
    note: chop.note,
    name: `Chop ${chop.index + 1}`,
    sampleId: chop.sampleId,
    volume: 1,
    pan: 0,
    tuneSemitones: 0,
    trimStart: chop.startRatio,
    trimEnd: chop.endRatio,
    reverse: false,
    loop: false,
    chokeGroup: 0,
  }));

/**
 * One piano-roll note per chop, pitched at the chop's pad so the note triggers
 * that chop's region instead of a default voice.
 *
 * Step placement is deliberately one step per chop in chop order: it is the
 * arrangement the user can edit, and the chop lengths it triggers are the real
 * detected regions carried by the pads. Inventing step durations here would need
 * a tempo the slicer does not own.
 */
export const slicerChopNotes = (chops: readonly SlicerChop[]): Note[] =>
  chops.map(chop => ({
    id: `${chop.id}-note`,
    pitch: chop.note,
    start: chop.index,
    duration: 1,
    velocity: CHOP_NOTE_VELOCITY,
  }));

/**
 * Arms one step per chop on a step array that keeps the channel's existing
 * length, so publishing never silently shortens a longer pattern.
 */
export const slicerChopSteps = (
  chops: readonly SlicerChop[],
  stepCount: number = MAX_SLICER_CHOPS
): boolean[] => {
  const length = Math.max(MAX_SLICER_CHOPS, Math.floor(stepCount) || 0);
  const steps = new Array<boolean>(length).fill(false);
  for (let index = 0; index < Math.min(chops.length, length); index += 1) {
    steps[index] = true;
  }
  return steps;
};

const refusal = (
  code: SlicerChopRefusalCode,
  message: string
): SlicerChopRefusal => ({ ok: false, code, message });

/**
 * Resolves a chop publication for `slices` against the slicer's real source.
 *
 * Returns the pads, notes and steps to publish, or a refusal the modal must show
 * instead of publishing. Nothing here falls back to generated audio, to a
 * default voice, or to a slice count without its regions.
 */
export const publishSlicerChops = (
  slices: readonly AudioSlice[],
  source: SlicerAudioSource,
  options: { stepCount?: number } = {}
): SlicerChopPublicationResult => {
  if (!isSlicerSourceReady(source)) {
    return refusal(
      'no-source',
      slicerSourceMessage(source) ||
        'There is no loaded sample to publish chops from.'
    );
  }

  const issue = slicerChopRegionIssue(slices, source.buffer.duration);
  if (issue === 'no-slices') {
    return refusal(
      'no-slices',
      'Nothing to publish yet — detect chops on the loaded sample first.'
    );
  }
  if (issue === 'inverted-region') {
    return refusal(
      'inverted-region',
      'These chop regions end before they start, so they no longer match the loaded sample. Detect chops again, then publish.'
    );
  }
  if (issue === 'region-out-of-range') {
    return refusal(
      'region-out-of-range',
      'These chop regions fall outside the loaded sample, so they no longer match it. Detect chops again, then publish.'
    );
  }
  if (issue === 'slices-out-of-order') {
    return refusal(
      'slices-out-of-order',
      'These chop regions overlap or start before the previous chop ends. Detect chops again, then publish.'
    );
  }

  const chops = buildSlicerChops(slices, source.sampleId);
  return {
    ok: true,
    chops,
    pads: slicerChopPads(chops),
    notes: slicerChopNotes(chops),
    steps: slicerChopSteps(chops, options.stepCount),
    publishedCount: chops.length,
    droppedCount: Math.max(0, slices.length - chops.length),
  };
};

/** User-facing summary for the piano-roll publication. */
export const slicerChopPianoRollMessage = (
  result: SlicerChopPublicationResult
): string => {
  if (isSlicerChopRefused(result)) return result.message;
  const dropped = result.droppedCount
    ? ` ${plural(result.droppedCount, 'chop')} past the 16-chop bank were not published.`
    : '';
  return `${plural(result.publishedCount, 'chop')} published with their real regions — one chop per step in chop order.${dropped}`;
};

/**
 * User-facing summary for the step-sequencer publication.
 *
 * The step sequencer addresses one pitch per channel, so arming N steps arms the
 * same chop N times. The message says so rather than claiming N distinct chops
 * were mapped; per-step chop selection is out of scope for this phase.
 */
export const slicerChopStepSequencerMessage = (
  result: SlicerChopPublicationResult
): string => {
  if (isSlicerChopRefused(result)) return result.message;
  const armed = result.steps.filter(Boolean).length;
  const dropped = result.droppedCount
    ? ` ${plural(result.droppedCount, 'chop')} past the 16-chop bank were not published.`
    : '';
  return `${plural(result.publishedCount, 'chop')} published and ${plural(armed, 'step')} armed. Every armed step triggers the channel's single sequencer pitch, so all of them play chop 1 until per-step chop selection exists.${dropped}`;
};
