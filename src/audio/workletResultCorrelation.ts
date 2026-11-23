/**
 * Correlation between native block results and the AudioWorklet's acceptance of
 * them.
 *
 * THE DEFECT THIS REPLACES. The earlier extractor stored a timestamp for every
 * `worklet-result` event keyed by sequence number alone, and never looked at the
 * `accepted` flag the worklet already reports. Two things followed, and both
 * produced evidence that looked like a measurement:
 *
 *   1. A result the worklet REJECTED still carried `acceptedAtEpochMs`, because the
 *      worklet stamps the clock before it computes `valid`. A late result arriving
 *      after the fail-closed guard had fired was therefore recorded as though the
 *      block had completed in time - which is how three "misses" acquired positive
 *      deadline margins they had not earned.
 *   2. Sequence numbers restart at zero whenever the worklet is recreated, so
 *      keying by sequence alone could join a result from one runtime generation to
 *      a block from another.
 *
 * Both are corrected here. Acceptance is taken only from the worklet's own
 * `accepted === true`, never inferred from the presence of a timestamp, and the
 * join key is `requestId` (`${runtimeId}:${sequence}`), which cannot collide across
 * generations. Rejected results are preserved as diagnostic evidence in their own
 * right - a late response is still worth knowing about - but they can never yield
 * an accepted round trip or a deadline margin.
 */

export interface WorkletResultEventLike {
  event?: string | null;
  requestId?: string | null;
  sequence?: number | null;
  accepted?: boolean | null;
  pendingSequence?: number | null;
  receivedOutputFrame?: number | null;
  dueOutputFrame?: number | null;
  acceptedAtEpochMs?: number | null;
  submittedAtEpochMs?: number | null;
  roundTripMs?: number | null;
  reason?: string | null;
}

export interface AcceptedWorkletResult {
  requestId: string;
  sequence: number | null;
  acceptedAtEpochMs: number | null;
  roundTripMs: number | null;
}

export interface RejectedWorkletResult {
  requestId: string | null;
  sequence: number | null;
  reason: string | null;
  pendingSequence: number | null;
  receivedOutputFrame: number | null;
  dueOutputFrame: number | null;
  /** Retained as evidence of lateness. Never used to compute an accepted margin. */
  acceptedAtEpochMs: number | null;
  roundTripMs: number | null;
  /** Set when the event could not be attributed to a runtime generation at all. */
  unattributable: boolean;
}

export interface WorkletResultCorrelation {
  acceptedByRequestId: Map<string, AcceptedWorkletResult>;
  rejected: RejectedWorkletResult[];
  /** Accepted results for the same requestId after the first: protocol violations. */
  duplicateAccepted: RejectedWorkletResult[];
  acceptedCount: number;
  rejectedCount: number;
  unattributableCount: number;
}

const num = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null);

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null);

const toRejected = (event: WorkletResultEventLike, requestId: string | null,
  unattributable: boolean): RejectedWorkletResult => ({
  requestId,
  sequence: num(event.sequence),
  reason: text(event.reason),
  pendingSequence: num(event.pendingSequence),
  receivedOutputFrame: num(event.receivedOutputFrame),
  dueOutputFrame: num(event.dueOutputFrame),
  acceptedAtEpochMs: num(event.acceptedAtEpochMs),
  roundTripMs: num(event.roundTripMs),
  unattributable,
});

export function correlateWorkletResults(
  events: readonly WorkletResultEventLike[],
): WorkletResultCorrelation {
  const acceptedByRequestId = new Map<string, AcceptedWorkletResult>();
  const rejected: RejectedWorkletResult[] = [];
  const duplicateAccepted: RejectedWorkletResult[] = [];

  for (const event of events) {
    if (event?.event !== 'worklet-result') continue;
    const requestId = text(event.requestId);
    // Without a requestId the event cannot be tied to a runtime generation, so it
    // can never count as an accepted measurement - even if it says accepted.
    if (requestId === null) {
      rejected.push(toRejected(event, null, true));
      continue;
    }
    if (event.accepted === true) {
      if (acceptedByRequestId.has(requestId)) {
        // A second accepted result for one block is itself evidence of a protocol
        // problem; the first measurement is the one that was acted on.
        duplicateAccepted.push(toRejected(event, requestId, false));
        continue;
      }
      acceptedByRequestId.set(requestId, {
        requestId,
        sequence: num(event.sequence),
        acceptedAtEpochMs: num(event.acceptedAtEpochMs),
        roundTripMs: num(event.roundTripMs),
      });
      continue;
    }
    rejected.push(toRejected(event, requestId, false));
  }

  return {
    acceptedByRequestId,
    rejected,
    duplicateAccepted,
    acceptedCount: acceptedByRequestId.size,
    rejectedCount: rejected.length,
    unattributableCount: rejected.filter(entry => entry.unattributable).length,
  };
}

/**
 * The accepted measurement for one main-process block record, or null when the
 * worklet never accepted a result for that exact request.
 *
 * A null here is meaningful: it means "the AudioWorklet did not accept this block",
 * which is precisely the case that must not be reported as a positive margin.
 */
export function acceptedResultFor(
  correlation: WorkletResultCorrelation,
  record: { requestId?: string | null; sequence?: number | null },
): AcceptedWorkletResult | null {
  const requestId = text(record.requestId);
  if (requestId === null) return null;
  return correlation.acceptedByRequestId.get(requestId) ?? null;
}

/** Rejections recorded for one request, in arrival order. */
export function rejectedResultsFor(
  correlation: WorkletResultCorrelation,
  record: { requestId?: string | null },
): RejectedWorkletResult[] {
  const requestId = text(record.requestId);
  if (requestId === null) return [];
  return correlation.rejected.filter(entry => entry.requestId === requestId);
}

/**
 * The runtime generation a request belongs to, or null. Used to prove that two
 * blocks were not joined across different worklet generations.
 */
export function runtimeGenerationOf(requestId: unknown): string | null {
  const value = text(requestId);
  if (value === null) return null;
  const separator = value.lastIndexOf(':');
  return separator > 0 ? value.slice(0, separator) : null;
}
