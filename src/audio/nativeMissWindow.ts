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
