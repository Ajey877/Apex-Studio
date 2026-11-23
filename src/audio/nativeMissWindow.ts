// Pure selection logic for the blocks that matter when the native real-time guard
// gives up on a block.
//
// Why this exists separately: a miss is not always a cold-start event. One was
// measured at sequence 117, about 2.5 s into playback, around where live-input
// monitoring is enabled. The first blocks of the session looked perfectly healthy
// in that run, so reporting only the cold window showed a passing picture for a
// run that had actually failed. The guard names the sequences it abandoned, and
// this selects those blocks and their neighbours.
//
// The ordering is by importance rather than by time, which is deliberate: CI
// annotations are size-limited and are reduced by halving from the front, so the
// rows that must survive have to be at the front.

export interface SequenceBearing {
  sequence?: number | null;
}

export interface DeadlineMissEventLike {
  event?: string | null;
  sequence?: number | null;
  pendingSequence?: number | null;
}

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value));

/** Every block sequence the real-time guard reported giving up on, ascending. */
export function collectMissedSequences(events: readonly DeadlineMissEventLike[]): number[] {
  const missed = new Set<number>();
  for (const event of events) {
    if (event.event !== 'pending-deadline-miss' && event.event !== 'deadline-miss') continue;
    for (const candidate of [event.sequence, event.pendingSequence]) {
      if (isFiniteNumber(candidate)) missed.add(candidate);
    }
  }
  return [...missed].sort((a, b) => a - b);
}

/** Distance from a sequence to the nearest missed sequence. */
export function missDistance(sequence: number, missedSequences: readonly number[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const missed of missedSequences) best = Math.min(best, Math.abs(sequence - missed));
  return best;
}

/**
 * The records within `radius` blocks of a miss, named sequences first, then their
 * nearest neighbours, ties broken by ascending sequence.
 */
export function orderBlocksAroundMiss<T extends SequenceBearing>(
  records: readonly T[],
  missedSequences: readonly number[],
  options: { radius?: number; limit?: number } = {},
): T[] {
  const radius = options.radius ?? 2;
  const limit = options.limit ?? 12;
  if (missedSequences.length === 0) return [];
  return records
    .filter(record => isFiniteNumber(record.sequence) && missDistance(record.sequence as number, missedSequences) <= radius)
    .sort((a, b) => {
      const left = a.sequence as number;
      const right = b.sequence as number;
      return missDistance(left, missedSequences) - missDistance(right, missedSequences) || left - right;
    })
    .slice(0, limit);
}

/**
 * The last block sequence counted as part of the cold window.
 *
 * Chosen from measurement, not preference: across the captured evidence the helper
 * round-trip tail sits in blocks 0-2 (peaks of 4.42, 5.58 and 23.08 ms) while blocks
 * 3 onward stay under 2.81 ms. Block 3 is included so a miss on the boundary is
 * reported as cold rather than silently reclassified.
 */
export const COLD_WINDOW_LAST_SEQUENCE = 3;

export type MissPhase = 'cold' | 'mid-session';

/** Whether a missed block sequence falls in the cold window or later in the session. */
export function classifyMissSequence(
  sequence: number,
  coldWindowLastSequence: number = COLD_WINDOW_LAST_SEQUENCE,
): MissPhase {
  return sequence <= coldWindowLastSequence ? 'cold' : 'mid-session';
}

/**
 * The frame positions of one guard event, normalised across both failure paths.
 *
 * The two guards are independent and fire for different reasons: `pending-deadline-miss`
 * means the next input block filled while the previous result was still outstanding,
 * while `deadline-miss` means a result was absent at the output frame that needed it.
 * Conflating them would hide which boundary was actually crossed, so both keep their
 * own event name and every frame position either one reported. Nothing is inferred
 * for a field an event did not carry - it stays null.
 */
export function describeDeadlineMiss(event: {
  event?: string | null;
  sequence?: number | null;
  pendingSequence?: number | null;
  nextSequence?: number | null;
  sourceFrame?: number | null;
  inputContextFrame?: number | null;
  currentOutputFrame?: number | null;
  receivedOutputFrame?: number | null;
  dueOutputFrame?: number | null;
  readySequences?: readonly number[] | null;
  drySequences?: readonly number[] | null;
}): {
  guard: 'pending-deadline-miss' | 'deadline-miss' | null;
  sequence: number | null;
  phase: MissPhase | null;
  pendingSequence: number | null;
  nextSequence: number | null;
  sourceFrame: number | null;
  inputContextFrame: number | null;
  currentOutputFrame: number | null;
  receivedOutputFrame: number | null;
  dueOutputFrame: number | null;
  readySequences: number[] | null;
  drySequences: number[] | null;
} | null {
  const guard = event.event === 'pending-deadline-miss' || event.event === 'deadline-miss'
    ? event.event : null;
  if (guard === null) return null;
  const sequence = isFiniteNumber(event.sequence) ? event.sequence : null;
  const list = (value: readonly number[] | null | undefined): number[] | null => (
    Array.isArray(value) ? value.filter(isFiniteNumber) : null);
  return {
    guard,
    sequence,
    phase: sequence === null ? null : classifyMissSequence(sequence),
    // The pending guard reports its block in `sequence`; keep both names populated so
    // a reader does not have to know which guard emitted the event.
    pendingSequence: isFiniteNumber(event.pendingSequence) ? event.pendingSequence : sequence,
    nextSequence: isFiniteNumber(event.nextSequence) ? event.nextSequence : null,
    sourceFrame: isFiniteNumber(event.sourceFrame) ? event.sourceFrame : null,
    inputContextFrame: isFiniteNumber(event.inputContextFrame) ? event.inputContextFrame : null,
    currentOutputFrame: isFiniteNumber(event.currentOutputFrame) ? event.currentOutputFrame : null,
    receivedOutputFrame: isFiniteNumber(event.receivedOutputFrame) ? event.receivedOutputFrame : null,
    dueOutputFrame: isFiniteNumber(event.dueOutputFrame) ? event.dueOutputFrame : null,
    readySequences: list(event.readySequences),
    drySequences: list(event.drySequences),
  };
}
