import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedResultFor, correlateWorkletResults, rejectedResultsFor, runtimeGenerationOf,
} from './workletResultCorrelation';
import { classifyMissSequence, describeDeadlineMiss } from './nativeMissWindow';

/**
 * Acceptance correlation for native block results.
 *
 * These tests exist because the previous extractor produced evidence that looked
 * measured and was not: it recorded a timestamp for every `worklet-result` event,
 * keyed by sequence alone, without checking the `accepted` flag. A result the
 * worklet had rejected therefore supplied a round trip and a positive deadline
 * margin for a block that never completed in time.
 */

const GEN_A = 'runtime-aaaa';
const GEN_B = 'runtime-bbbb';
const reqId = (gen: string, sequence: number) => `${gen}:${sequence}`;

const acceptedEvent = (gen: string, sequence: number, extra = {}) => ({
  event: 'worklet-result', requestId: reqId(gen, sequence), sequence, accepted: true,
  pendingSequence: sequence, receivedOutputFrame: 2048 + sequence * 1024,
  dueOutputFrame: 2048 + sequence * 1024, acceptedAtEpochMs: 1000 + sequence,
  submittedAtEpochMs: 990 + sequence, roundTripMs: 10, ...extra,
});

const rejectedEvent = (gen: string, sequence: number, reason: string, extra = {}) => ({
  event: 'worklet-result', requestId: reqId(gen, sequence), sequence, accepted: false,
  reason, pendingSequence: -1, receivedOutputFrame: 4096, dueOutputFrame: 2048 + sequence * 1024,
  acceptedAtEpochMs: 1500, roundTripMs: 40, ...extra,
});

test('1. an accepted result produces an accepted round-trip measurement', () => {
  const correlation = correlateWorkletResults([acceptedEvent(GEN_A, 2)]);
  assert.equal(correlation.acceptedCount, 1);
  assert.equal(correlation.rejectedCount, 0);
  const found = acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 });
  assert.ok(found, 'the accepted block is findable by its request id');
  assert.equal(found.roundTripMs, 10);
  assert.equal(found.acceptedAtEpochMs, 1002);
});

test('2. a rejected result cannot produce an accepted round-trip measurement', () => {
  // This is the exact defect: the rejected event carries both acceptedAtEpochMs and
  // roundTripMs, so an extractor that ignores `accepted` would report a 40 ms round
  // trip and a margin for a block the worklet refused.
  const correlation = correlateWorkletResults([
    rejectedEvent(GEN_A, 2, 'after-failure'),
  ]);
  assert.equal(correlation.acceptedCount, 0);
  assert.equal(correlation.rejectedCount, 1);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 }), null,
    'no accepted measurement may be derived from a rejected result');
  const rejections = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 2) });
  assert.equal(rejections.length, 1, 'but the rejection is still available as evidence');
  assert.equal(rejections[0].reason, 'after-failure');
});

test('3. a late result after the fail-closed event stays visible as rejected evidence', () => {
  const correlation = correlateWorkletResults([
    rejectedEvent(GEN_A, 2, 'stale-duplicate-or-malformed', {
      pendingSequence: -1, receivedOutputFrame: 5120, dueOutputFrame: 4096,
    }),
  ]);
  const [late] = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 2) });
  assert.equal(late.receivedOutputFrame, 5120);
  assert.equal(late.dueOutputFrame, 4096);
  assert.ok((late.receivedOutputFrame as number) > (late.dueOutputFrame as number),
    'the evidence shows the response arrived after the frame that needed it');
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2) }), null);
});

test('4. accepted=true with a mismatched pendingSequence is refused', () => {
  // The previous version of this test supplied an event ALREADY marked
  // accepted: false, so it never exercised the mismatch - it only re-tested that a
  // rejection is a rejection. Here the event claims acceptance while contradicting
  // itself, which is the case that actually has to be caught.
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 2, { pendingSequence: 7 }),
  ]);
  assert.equal(correlation.acceptedCount, 0, 'a self-contradictory event is not an accepted measurement');
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 }), null);
  const [refused] = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 2) });
  assert.equal(refused.correlationReason, 'pending-sequence-mismatch');
  assert.equal(refused.roundTripMs, 10, 'its timing is preserved as evidence, not discarded');
});

test('4b. an accepted event whose sequence disagrees with its requestId is refused', () => {
  // requestId says block 2, the event claims block 5. Joining either way would put a
  // measurement against the wrong block.
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 5, { requestId: reqId(GEN_A, 2) }),
  ]);
  assert.equal(correlation.acceptedCount, 0);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 }), null);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 5), sequence: 5 }), null);
  const [refused] = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 2) });
  assert.equal(refused.correlationReason, 'sequence-disagrees-with-request-id');
});

test('4c. a main-process record whose sequence disagrees with its requestId borrows nothing', () => {
  const correlation = correlateWorkletResults([acceptedEvent(GEN_A, 2)]);
  assert.ok(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 }),
    'the agreeing record gets the measurement');
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 9 }), null,
    'a record disagreeing with its own request id must not take it');
});

test('4d. malformed and absent request identities are named, not silently dropped', () => {
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 0, { requestId: 'no-separator-here' }),
    acceptedEvent(GEN_A, 1, { requestId: 'runtime-x:' }),
    acceptedEvent(GEN_A, 2, { requestId: ':7' }),
    acceptedEvent(GEN_A, 3, { requestId: 'runtime-x:not-a-number' }),
    acceptedEvent(GEN_A, 4, { requestId: null }),
  ]);
  assert.equal(correlation.acceptedCount, 0, 'no malformed identity can produce a measurement');
  assert.equal(correlation.unattributableCount, 5);
  assert.deepEqual(
    correlation.rejected.map(entry => entry.correlationReason).sort(),
    ['request-id-malformed', 'request-id-malformed', 'request-id-malformed',
      'request-id-malformed', 'request-id-missing'].sort());
});

test('4e. a valid accepted event is accepted, and rejection reasons are counted', () => {
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 2),
    acceptedEvent(GEN_A, 3, { pendingSequence: 9 }),
    rejectedEvent(GEN_A, 4, 'after-failure'),
  ]);
  assert.equal(correlation.acceptedCount, 1);
  assert.equal(correlation.rejectedCount, 2);
  assert.deepEqual(correlation.rejectionReasons,
    { 'pending-sequence-mismatch': 1, 'not-accepted': 1 });
  const found = acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 });
  assert.equal(found?.roundTripMs, 10);
});

test('5. different runtime generations cannot be mixed by sequence-number matching', () => {
  // Sequence counters restart at zero when the worklet is recreated, so two
  // generations both have a sequence 2. Joining on requestId keeps them apart.
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 2, { roundTripMs: 10 }),
    acceptedEvent(GEN_B, 2, { roundTripMs: 99 }),
  ]);
  assert.equal(correlation.acceptedCount, 2);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2) })?.roundTripMs, 10);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_B, 2) })?.roundTripMs, 99,
    'each generation keeps its own measurement');
  assert.equal(runtimeGenerationOf(reqId(GEN_A, 2)), GEN_A);
  assert.equal(runtimeGenerationOf(reqId(GEN_B, 2)), GEN_B);
  assert.equal(runtimeGenerationOf(null), null);
  assert.equal(runtimeGenerationOf(''), null);
});

test('an event with no request id can never count as accepted', () => {
  const correlation = correlateWorkletResults([
    { ...acceptedEvent(GEN_A, 0), requestId: undefined },
  ]);
  assert.equal(correlation.acceptedCount, 0, 'unattributable even though it claims accepted');
  assert.equal(correlation.unattributableCount, 1);
  assert.equal(correlation.rejected[0].unattributable, true);
  assert.equal(correlation.rejected[0].correlationReason, 'request-id-missing');
});

test('a second accepted result for one block is flagged, not silently merged', () => {
  const correlation = correlateWorkletResults([
    acceptedEvent(GEN_A, 1, { roundTripMs: 8 }),
    acceptedEvent(GEN_A, 1, { roundTripMs: 50 }),
  ]);
  assert.equal(correlation.acceptedCount, 1, 'the first measurement is the one acted on');
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 1) })?.roundTripMs, 8);
  const [duplicate] = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 1) });
  assert.equal(duplicate.correlationReason, 'duplicate-accepted',
    'the duplicate is retained as evidence and named as such');
});

test('non-result events and missing fields are ignored or left null', () => {
  const correlation = correlateWorkletResults([
    { event: 'worklet-submit', requestId: reqId(GEN_A, 0), accepted: true, pendingSequence: 0 },
    // pendingSequence is supplied: under the completed invariant an accepted event
    // that omits it is refused, so leaving it out here would test the wrong thing.
    { event: 'worklet-result', requestId: reqId(GEN_A, 1), sequence: 1, accepted: true,
      pendingSequence: 1 },
  ]);
  assert.equal(correlation.acceptedCount, 1, 'a submit event is not a result');
  const found = acceptedResultFor(correlation, { requestId: reqId(GEN_A, 1) });
  assert.equal(found?.roundTripMs, null, 'an absent round trip stays null, not zero');
  assert.equal(found?.acceptedAtEpochMs, null);
});

// --- both worklet failure paths keep their own frame positions ----------------------

test('6a. the pending guard keeps every frame position it reported', () => {
  const described = describeDeadlineMiss({
    event: 'pending-deadline-miss', sequence: 2, pendingSequence: 2, nextSequence: 3,
    inputContextFrame: 1744895, currentOutputFrame: 3968, dueOutputFrame: 4096,
    readySequences: [0, 1], drySequences: [0, 1, 2],
  });
  assert.ok(described);
  assert.equal(described.guard, 'pending-deadline-miss');
  assert.equal(described.sequence, 2);
  assert.equal(described.nextSequence, 3);
  assert.equal(described.inputContextFrame, 1744895);
  assert.equal(described.currentOutputFrame, 3968);
  assert.equal(described.dueOutputFrame, 4096);
  assert.deepEqual(described.readySequences, [0, 1]);
  assert.deepEqual(described.drySequences, [0, 1, 2]);
  assert.equal(described.phase, 'cold');
});

test('6b. the output guard keeps its own distinct frame positions', () => {
  const described = describeDeadlineMiss({
    event: 'deadline-miss', sequence: 149, sourceFrame: 152576, dueOutputFrame: 154624,
    currentOutputFrame: 154496, pendingSequence: 150, readySequences: [147, 148],
    drySequences: [147, 148, 149],
  });
  assert.ok(described);
  assert.equal(described.guard, 'deadline-miss', 'the two guards are not conflated');
  assert.equal(described.sourceFrame, 152576);
  assert.equal(described.pendingSequence, 150);
  assert.equal(described.nextSequence, null, 'a field this guard does not emit stays null');
  assert.equal(described.inputContextFrame, null);
  assert.equal(described.phase, 'mid-session');
});

test('6c. an unrelated event is not described as a deadline miss', () => {
  assert.equal(describeDeadlineMiss({ event: 'worklet-result', sequence: 1 }), null);
  assert.equal(describeDeadlineMiss({ event: null, sequence: 1 }), null);
});

test('cold and mid-session misses are classified from the measured cold window', () => {
  assert.equal(classifyMissSequence(0), 'cold');
  assert.equal(classifyMissSequence(3), 'cold', 'the boundary block counts as cold');
  assert.equal(classifyMissSequence(4), 'mid-session');
  assert.equal(classifyMissSequence(57), 'mid-session');
  assert.equal(classifyMissSequence(149), 'mid-session');
});
