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
 * WHAT AN ACCEPTED MEASUREMENT NOW REQUIRES. All of these, not any subset:
 *   - the event is `worklet-result`;
 *   - `accepted === true`;
 *   - `requestId` is present and well formed, naming a runtime generation and an
 *     integer sequence;
 *   - `event.sequence` agrees with the sequence encoded in `requestId`;
 *   - `event.pendingSequence === event.sequence`, the worklet's own invariant for
 *     accepting a result;
 *   - the main-process record being decomposed carries the same `requestId` and a
 *     sequence agreeing with it.
 *
 * Anything failing those checks is preserved as rejected or unattributable evidence
 * with a specific `correlationReason`, and can never produce a round trip or a
 * deadline margin. Acceptance is never inferred from the presence of a timestamp.
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

/** Why correlation refused to treat an event as an accepted measurement. */
export type CorrelationRejectionReason =
  | 'request-id-missing'
  | 'request-id-malformed'
  | 'not-accepted'
  | 'sequence-missing'
  | 'sequence-disagrees-with-request-id'
  | 'pending-sequence-mismatch'
  | 'duplicate-accepted';

export interface RejectedWorkletResult {
  requestId: string | null;
  sequence: number | null;
  /** The worklet's own reason, when it supplied one. */
  reason: string | null;
  /** Why correlation refused it. Always present. */
  correlationReason: CorrelationRejectionReason;
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
  acceptedCount: number;
  rejectedCount: number;
  unattributableCount: number;
  /** Counts per correlationReason, so a systematic problem is visible in aggregate. */
  rejectionReasons: Record<string, number>;
}

const num = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null);

const int = (value: unknown): number | null => {
  const value0 = num(value);
  return value0 !== null && Number.isInteger(value0) ? value0 : null;
};

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Split `${runtimeId}:${sequence}`. The runtime id is a UUID and may itself contain
 * no colon, but the split is taken at the LAST colon so a malformed id is reported
 * rather than silently truncated.
 */
export function parseRequestId(requestId: unknown):
  { generation: string; sequence: number } | null {
  const value = text(requestId);
  if (value === null) return null;
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const generation = value.slice(0, separator);
  const sequenceText = value.slice(separator + 1);
  if (!/^-?\d+$/.test(sequenceText)) return null;
  const sequence = Number(sequenceText);
  if (!Number.isFinite(sequence)) return null;
  return { generation, sequence };
}

/** The runtime generation a request belongs to, or null. */
export function runtimeGenerationOf(requestId: unknown): string | null {
  return parseRequestId(requestId)?.generation ?? null;
}

interface CandidateOk {
  ok: true;
  requestId: string;
  sequence: number;
  unattributable: false;
}
interface CandidateRefused {
  ok: false;
  correlationReason: CorrelationRejectionReason;
  requestId: string | null;
  unattributable: boolean;
}

/**
 * The full acceptance test for one `worklet-result` event. Returns the specific
 * reason on refusal, because "rejected" alone does not distinguish a late response
 * from a malformed identity - and only the first is evidence about the audio path.
 */
export function validateAcceptedCandidate(
  event: WorkletResultEventLike,
): CandidateOk | CandidateRefused {
  const requestId = text(event.requestId);
  // Without a requestId the event cannot be tied to a runtime generation, so it can
  // never count as an accepted measurement - even if it says accepted.
  if (requestId === null) {
    return { ok: false, correlationReason: 'request-id-missing', requestId: null, unattributable: true };
  }
  const parsed = parseRequestId(requestId);
  if (parsed === null) {
    return { ok: false, correlationReason: 'request-id-malformed', requestId, unattributable: true };
  }
  if (event.accepted !== true) {
    return { ok: false, correlationReason: 'not-accepted', requestId, unattributable: false };
  }
  const sequence = int(event.sequence);
  if (sequence === null) {
    return { ok: false, correlationReason: 'sequence-missing', requestId, unattributable: false };
  }
  if (sequence !== parsed.sequence) {
    return {
      ok: false, correlationReason: 'sequence-disagrees-with-request-id',
      requestId, unattributable: false,
    };
  }
  // The worklet accepts a result only when its sequence equals the pending one. An
  // event claiming acceptance while disagreeing with itself is not evidence.
  if (int(event.pendingSequence) !== sequence) {
    return {
      ok: false, correlationReason: 'pending-sequence-mismatch',
      requestId, unattributable: false,
    };
  }
  return { ok: true, requestId, sequence, unattributable: false };
}

/**
 * Explicit predicate rather than `if (!verdict.ok)`. This project does not enable
 * `strictNullChecks`, so a `true`/`false` discriminant widens to `boolean` and the
 * compiler will not narrow the union on its own.
 */
function isRefused(verdict: CandidateOk | CandidateRefused): verdict is CandidateRefused {
  return verdict.ok !== true;
}

const toRejected = (event: WorkletResultEventLike, requestId: string | null,
  correlationReason: CorrelationRejectionReason, unattributable: boolean): RejectedWorkletResult => ({
  requestId,
  sequence: num(event.sequence),
  reason: text(event.reason),
  correlationReason,
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

  for (const event of events) {
    if (event?.event !== 'worklet-result') continue;
    const verdict = validateAcceptedCandidate(event);
    if (isRefused(verdict)) {
      rejected.push(toRejected(event, verdict.requestId, verdict.correlationReason, verdict.unattributable));
      continue;
    }
    if (acceptedByRequestId.has(verdict.requestId)) {
      // A second accepted result for one block is itself evidence of a protocol
      // problem; the first measurement is the one that was acted on.
      rejected.push(toRejected(event, verdict.requestId, 'duplicate-accepted', false));
      continue;
    }
    acceptedByRequestId.set(verdict.requestId, {
      requestId: verdict.requestId,
      sequence: verdict.sequence,
      acceptedAtEpochMs: num(event.acceptedAtEpochMs),
      roundTripMs: num(event.roundTripMs),
    });
  }

  const rejectionReasons: Record<string, number> = {};
  for (const entry of rejected) {
    rejectionReasons[entry.correlationReason] = (rejectionReasons[entry.correlationReason] ?? 0) + 1;
  }

  return {
    acceptedByRequestId,
    rejected,
    acceptedCount: acceptedByRequestId.size,
    rejectedCount: rejected.length,
    unattributableCount: rejected.filter(entry => entry.unattributable).length,
    rejectionReasons,
  };
}

/**
 * The accepted measurement for one main-process block record, or null when the
 * worklet never accepted a result for that exact request.
 *
 * The record is validated too: a main-process record whose own sequence disagrees
 * with its request id must not borrow another block's measurement.
 *
 * A null here is meaningful: it means "the AudioWorklet did not accept this block",
 * which is precisely the case that must not be reported as a positive margin.
 */
export function acceptedResultFor(
  correlation: WorkletResultCorrelation,
  record: { requestId?: string | null; sequence?: number | null },
): AcceptedWorkletResult | null {
  const parsed = parseRequestId(record.requestId);
  if (parsed === null) return null;
  const recordSequence = int(record.sequence);
  if (recordSequence !== null && recordSequence !== parsed.sequence) return null;
  return correlation.acceptedByRequestId.get(parsed.generation + ':' + parsed.sequence) ?? null;
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
