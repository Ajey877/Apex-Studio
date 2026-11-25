import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMissedSequences, missDistance, orderBlocksAroundMiss } from './nativeMissWindow';

const block = (sequence: number) => ({ sequence, totalRoundTripMs: 3 });

test('collects every sequence the guard named, from either event shape', () => {
  const events = [
    { event: 'worklet-submit', sequence: 10 },
    { event: 'pending-deadline-miss', sequence: 117, pendingSequence: null },
    { event: 'deadline-miss', sequence: null, pendingSequence: 41 },
    { event: 'pending-deadline-miss', sequence: 117 },
  ];
  assert.deepEqual(collectMissedSequences(events), [41, 117],
    'unrelated events are ignored, duplicates collapse, output is ascending');
});

test('ignores non-finite sequence values rather than treating them as block zero', () => {
  const events = [{ event: 'pending-deadline-miss', sequence: null, pendingSequence: Number.NaN }];
  assert.deepEqual(collectMissedSequences(events), []);
});

test('measures distance to the nearest miss', () => {
  assert.equal(missDistance(117, [117]), 0);
  assert.equal(missDistance(115, [117]), 2);
  assert.equal(missDistance(110, [41, 117]), 7);
  assert.equal(missDistance(5, []), Number.POSITIVE_INFINITY);
});

test('puts the named sequence first so annotation truncation cannot lose it', () => {
  // This is the regression the CI evidence actually needed: the annotation builder
  // halves this list from the front, so if the window were in time order the guard's
  // own sequence (117) was the third row and got cut, leaving only neighbours.
  const records = [114, 115, 116, 117, 118, 119].map(block);
  const ordered = orderBlocksAroundMiss(records, [117], { radius: 2 });
  // Distance order, not time order: the closest neighbours come first, so a
  // truncated window is still the tightest one around the miss.
  assert.deepEqual(ordered.map(entry => entry.sequence), [117, 116, 118, 115, 119]);
  assert.equal(ordered[0].sequence, 117, 'the named sequence must be the first row');
});

test('keeps only the radius window and nothing further away', () => {
  const records = [100, 113, 114, 115, 116, 117, 118, 119, 120, 200].map(block);
  const ordered = orderBlocksAroundMiss(records, [117], { radius: 2 });
  assert.deepEqual(ordered.map(entry => entry.sequence), [117, 116, 118, 115, 119]);
  assert.ok(!ordered.some(entry => entry.sequence === 100 || entry.sequence === 200));
});

test('returns nothing when no sequence was named', () => {
  // An empty window must read as "nothing to report", never as the cold-start
  // blocks relabelled - a healthy window in a failed run is exactly the confusion
  // that delayed this investigation.
  assert.deepEqual(orderBlocksAroundMiss([115, 116, 117].map(block), []), []);
});

test('handles two separate misses without merging their windows', () => {
  const records = [0, 1, 2, 3, 4, 115, 116, 117, 118, 119].map(block);
  const ordered = orderBlocksAroundMiss(records, [2, 117], { radius: 2 });
  const sequences = ordered.map(entry => entry.sequence);
  assert.equal(sequences[0], 2, 'both named sequences rank ahead of their neighbours');
  assert.ok(sequences.indexOf(117) < sequences.indexOf(115),
    'the second named sequence still precedes its neighbours');
  assert.deepEqual(sequences.filter(sequence => sequence === 2 || sequence === 117), [2, 117]);
});

test('drops records whose sequence is missing instead of ranking them as block zero', () => {
  const records = [{ sequence: null, totalRoundTripMs: 99 }, block(117),
    { sequence: undefined, totalRoundTripMs: 99 }];
  const ordered = orderBlocksAroundMiss(records, [117]);
  assert.deepEqual(ordered.map(entry => entry.sequence), [117]);
});

test('honours the row limit from the front', () => {
  const records = [113, 114, 115, 116, 117, 118, 119, 120, 121].map(block);
  const ordered = orderBlocksAroundMiss(records, [117], { radius: 4, limit: 3 });
  assert.deepEqual(ordered.map(entry => entry.sequence), [117, 116, 118],
    'the limit keeps the named sequence and the closest neighbours');
});
