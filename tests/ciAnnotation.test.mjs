import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCiAnnotation, ANNOTATION_MESSAGE_LIMIT } from '../scripts/lib/ciAnnotation.mjs';

// Shape taken from the real cold-start detail annotation emitted on commit 7850c3a
// (job 137584706432), including the block rows with their helper-side spans.
const blockRow = sequence => ({
  seq: sequence, rToMain: 0.95, svc: 4.6, qWait: 0.12, ser: 0.07, hRtt: 3.55,
  parse: 1.02, pipe: 0.42, decode: 0.1, plugin: 1.46, mainToR: 2.02, total: 8,
  margin: 13.33, lagInBlock: null, err: null,
});
const payload = () => ({
  runIndex: 4, status: 'FAIL', capturedAt: 'afterMonitoring', blockBudgetMs: 21.33,
  worstTotalRoundTripMs: 17, worstMarginMs: 4.33, mainEventLoopLagMaxMs: 57.48,
  mainEventLoopLagDuringAudioMs: 5.26,
  mainEventLoopWorstStalls: Array.from({ length: 6 }, (_, i) => ({ atMs: 121.27 + i, lagMs: 57.48 - i })),
  helperPid: 7232, helperSpawnToProtocolBoundMs: 0.05,
  helperFirstRequestRoundTripMs: 31.06, helperConstructedToOpenCompletedMs: 34.36,
  helperStartup: { 'track:slot': { pid: 7232, constructedAtMs: 1, spawnedAtMs: 2, protocolBoundAtMs: 3,
    firstRequestWrittenAtMs: 4, firstResponseAtMs: 5, openCompletedAtMs: 6, spawnToProtocolBoundMs: 0.05,
    protocolBoundToFirstWriteMs: 0.07, firstRequestRoundTripMs: 31.06, constructedToOpenCompletedMs: 34.36 } },
  deadlineMissEvents: [{ event: 'pending-deadline-miss', sequence: 117, nextSequence: 118,
    pendingSequence: null, inputContextFrame: 1862527, currentOutputFrame: 121728,
    dueOutputFrame: 121856, sourceFrame: null }],
  missedSequences: [117],
  mainRecordedSequences: Array.from({ length: 24 }, (_, i) => i),
  // Distance order, exactly as nativeMissWindow.ts emits it: the guard's named
  // sequence first, so halving from the front cannot lose it.
  blocksAroundMiss: [117, 116, 118, 115, 119].map(blockRow),
  blocks: Array.from({ length: 8 }, (_, i) => blockRow(i)),
});

// The message follows the LAST '::' - the first one is the '::notice' prefix, and
// splitting on that was the reason an early version of this test failed to parse
// its own output.
const messageOf = text => text.slice(text.lastIndexOf('::') + 2);

test('a normal payload is emitted intact and parses as JSON', () => {
  const small = { runIndex: 1, status: 'PASS', worstMarginMs: 12.33, blocks: [blockRow(0)] };
  const { text, truncated } = buildCiAnnotation('detail', small, { cap: 3900 });
  assert.equal(truncated, false);
  assert.deepEqual(JSON.parse(messageOf(text)), small);
});

test('an oversized payload is reduced to a whole, parseable JSON object', () => {
  // This is the assertion that would have caught the two lost decompositions: the
  // old code sliced the string at 3900 and produced unparseable text.
  const { text, truncated } = buildCiAnnotation('detail', payload(), { cap: 3900 });
  assert.ok(messageOf(text).length <= 3900, `message must fit the cap, got ${messageOf(text).length}`);
  assert.doesNotThrow(() => JSON.parse(messageOf(text)), 'the message must still be valid JSON');
  assert.equal(truncated, false, 'shedding fields should make cutting the string unnecessary');
});

test('the guard window survives reduction ahead of the cold-start window', () => {
  const { text } = buildCiAnnotation('detail', payload(), { cap: 1400, preserve: 'blocksAroundMiss' });
  const parsed = JSON.parse(messageOf(text));
  assert.ok(Array.isArray(parsed.blocksAroundMiss) && parsed.blocksAroundMiss.length >= 1,
    'the blocks around the miss are the evidence that must survive');
  assert.ok(parsed.blocksAroundMiss.some(block => block.seq === 117),
    'the sequence the guard named must still be present');
  assert.equal(parsed.deadlineMissEvents, undefined, 'lower-value fields are shed first');
});

test('an unshrinkable payload is cut and says so rather than lying about it', () => {
  const huge = { blocksAroundMiss: [blockRow(0)], noise: 'x'.repeat(9000) };
  const { text, truncated } = buildCiAnnotation('detail', huge, { cap: 300 });
  assert.equal(truncated, true);
  assert.ok(messageOf(text).length <= 300);
});

test('percent and newline characters are escaped for the GitHub annotation format', () => {
  const { text } = buildCiAnnotation('title with % and\nbreaks', { error: '50%\r\nfailed' }, { cap: 3900 });
  assert.ok(!text.includes('%\n'), 'a raw newline would terminate the annotation early');
  assert.ok(text.includes('%25') && text.includes('%0A'));
});

test('the default cap stays under the documented GitHub limit', () => {
  const { text } = buildCiAnnotation('t', { noise: 'x'.repeat(9000) });
  assert.ok(ANNOTATION_MESSAGE_LIMIT === 4096);
  assert.ok(text.length <= ANNOTATION_MESSAGE_LIMIT + 64,
    'title plus the reserved slack must still fit what GitHub accepts');
});
