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
  // Sequence supplied so this asserts what the test is about - that no accepted
  // measurement exists for a rejected block - rather than tripping the record
  // validation, which has its own test below.
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 }), null);
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

test('4e. a main-process record must carry a usable sequence to borrow a measurement', () => {
  // The incomplete half of the invariant. The check used to read
  // `if (recordSequence !== null && recordSequence !== parsed.sequence)`, so a record
  // carrying NO sequence was accepted on its request id alone - and so was any
  // non-finite or fractional one, because `int` maps all three to null. Such a
  // record says nothing about which block it describes, so letting it take a
  // measurement would report some other block's round trip as this one's.
  const correlation = correlateWorkletResults([acceptedEvent(GEN_A, 2, { roundTripMs: 12 })]);
  const id = reqId(GEN_A, 2);
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 2 })?.roundTripMs, 12,
    'baseline: a complete record agreeing with its request id is accepted');

  // Missing.
  assert.equal(acceptedResultFor(correlation, { requestId: id }), null, 'absent sequence');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: null }), null, 'null sequence');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: undefined }), null, 'undefined sequence');

  // Invalid: present but not a finite integer.
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: Number.NaN }), null, 'NaN');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: Number.POSITIVE_INFINITY }), null, 'Infinity');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: Number.NEGATIVE_INFINITY }), null, '-Infinity');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: '2' as unknown as number }), null, 'numeric string');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: {} as unknown as number }), null, 'non-number');

  // Fractional.
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 2.5 }), null, 'fractional');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 1.999999 }), null, 'fractional just below');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 2.000001 }), null, 'fractional just above');

  // Mismatched with the sequence its own request id encodes.
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 3 }), null, 'off by one');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 1 }), null, 'off by one below');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: -1 }), null, 'negative');
  assert.equal(acceptedResultFor(correlation, { requestId: id, sequence: 0 }), null, 'a different block');
});

test('4f. a record refused for its sequence still keeps its rejection evidence', () => {
  // Tightening acceptance must not cost evidence: the rejection is the more
  // important half of the record for a block that failed.
  const correlation = correlateWorkletResults([rejectedEvent(GEN_A, 2, 'after-failure')]);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2) }), null,
    'a record with no sequence gets no measurement');
  const rejections = rejectedResultsFor(correlation, { requestId: reqId(GEN_A, 2) });
  assert.equal(rejections.length, 1, 'and its rejection is still reported');
  assert.equal(rejections[0].reason, 'after-failure');
});

test('4g. acceptance needs an accepted result for that exact request id', () => {
  // Conditions 1-3 can all hold while condition 4 fails: a well-formed record for a
  // block the worklet never accepted.
  const correlation = correlateWorkletResults([acceptedEvent(GEN_A, 2)]);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 3), sequence: 3 }), null,
    'no accepted result exists for block 3');
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_B, 2), sequence: 2 }), null,
    'and another generation\'s block 2 does not stand in for it');
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
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 2), sequence: 2 })?.roundTripMs, 10);
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_B, 2), sequence: 2 })?.roundTripMs, 99,
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
  assert.equal(acceptedResultFor(correlation, { requestId: reqId(GEN_A, 1), sequence: 1 })?.roundTripMs, 8);
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
  const found = acceptedResultFor(correlation, { requestId: reqId(GEN_A, 1), sequence: 1 });
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

test('6d. the pending guard reports which sample it was evaluated on', () => {
  // The field set added because `currentOutputFrame` alone could not say whether the
  // guard was evaluated at the quantum's start or at the sample that tripped it.
  const described = describeDeadlineMiss({
    event: 'pending-deadline-miss', sequence: 1, pendingSequence: 1, nextSequence: 2,
    inputContextFrame: 3071, outputFrameAtQuantumStart: 2944, inputSampleIndex: 127,
    inputQuantumFrames: 128, currentOutputFrame: 3071, nextQuantumOutputFrame: 3072,
    dueOutputFrame: 3072, readySequences: [0], drySequences: [0, 1],
  });
  assert.ok(described);
  assert.equal(described.outputFrameAtQuantumStart, 2944, 'the old value, preserved');
  assert.equal(described.inputSampleIndex, 127, 'the last sample of the quantum');
  assert.equal(described.inputQuantumFrames, 128);
  assert.equal(described.currentOutputFrame, 3071, 'the frame actually being evaluated');
  assert.equal(described.nextQuantumOutputFrame, 3072, 'where the pending block is needed');
  assert.equal(described.framesBeforeDue, 1, 'it fired one frame before the block was due');
});

test('6e. the output guard fires AT the due frame, so it is never early', () => {
  const described = describeDeadlineMiss({
    event: 'deadline-miss', sequence: 1, dueOutputFrame: 3072, currentOutputFrame: 3072,
    outputFrameAtQuantumStart: 3072, outputSampleIndex: 0, outputQuantumFrames: 128,
    nextQuantumOutputFrame: 3200,
  });
  assert.ok(described);
  assert.equal(described.outputSampleIndex, 0);
  assert.equal(described.outputQuantumFrames, 128);
  assert.equal(described.inputSampleIndex, null, 'the pending guard\'s index stays null here');
  assert.equal(described.framesBeforeDue, 0, 'never early: it fires on the sample that needs the block');
});

test('6f. historical events without the new fields stay readable', () => {
  // Evidence captured before this change has no outputFrameAtQuantumStart and friends.
  // Nothing may be invented for them, but the derived distance still follows from the
  // two frames such an event does carry.
  const described = describeDeadlineMiss({
    event: 'pending-deadline-miss', sequence: 1, currentOutputFrame: 2944, dueOutputFrame: 3072,
  });
  assert.ok(described);
  assert.equal(described.outputFrameAtQuantumStart, null);
  assert.equal(described.inputSampleIndex, null);
  assert.equal(described.nextQuantumOutputFrame, null);
  assert.equal(described.framesBeforeDue, 128,
    'the old quantum-start value reads as 128 frames early, which is exactly the '
    + 'overstatement this change corrects');
});

test('6g. framesBeforeDue is null when either frame is unknown', () => {
  const described = describeDeadlineMiss({ event: 'deadline-miss', sequence: 1, currentOutputFrame: 3072 });
  assert.ok(described);
  assert.equal(described.framesBeforeDue, null, 'never inferred from a missing frame');
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
