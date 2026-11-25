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

// A 60-repetition run list halved to 30 once left an annotation that looked like a
// complete per-repetition record and was not. The reduction has to be visible.
test('halving a keepCounts field records the reduction instead of hiding it', async () => {
  const { buildCiAnnotation } = await import('../scripts/lib/ciAnnotation.mjs');
  const runs = Array.from({ length: 60 }, (_, i) => ({
    r: i + 1, st: i === 21 ? 'FAIL' : 'PASS', worst: 11.5, margin: 10.25,
    lagAudio: 2.6, lagMax: 49.0, load: 37.6,
  }));
  const payload = {
    label: 'coldstart-diagnostic', repetitions: 60,
    // Compact full record: survives any halving because it is a string.
    perRepetitionVerdicts: runs.map(row => (row.st === 'PASS' ? 'P' : 'F')).join(''),
    runs,
  };
  const { text, truncated } = buildCiAnnotation('aggregate', payload,
    { cap: 3900, preserve: 'blocksAroundMiss', keepCounts: ['runs'] });
  assert.equal(truncated, false, 'the message must stay a whole parseable object');
  const body = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(body.perRepetitionVerdicts.length, 60,
    'all sixty verdicts survive even though the verbose list cannot');
  assert.equal(body.perRepetitionVerdicts[21], 'F');
  assert.ok(body.runs.length < 60, 'the verbose list is reduced to fit');
  assert.equal(body.runsReducedFrom, 60, 'and says how many it started from');
  assert.equal(body.runsKept, body.runs.length, 'and how many it kept');
});

test('a payload that fits is not marked as reduced', async () => {
  const { buildCiAnnotation } = await import('../scripts/lib/ciAnnotation.mjs');
  const runs = [{ r: 1, st: 'PASS' }, { r: 2, st: 'PASS' }];
  const { text } = buildCiAnnotation('aggregate', { runs },
    { cap: 3900, keepCounts: ['runs'] });
  const body = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(body.runs.length, 2);
  assert.equal(body.runsReducedFrom, undefined, 'nothing was given up, so nothing is claimed');
  assert.equal(body.runsKept, undefined);
});

test('a failure list is never halved, because its length is the result', async () => {
  // Regression for the 60-repetition diagnostic at `3c3817d` (job 138406885418),
  // which reported `failed: 4` alongside `failingRepetitions: [4]`. The reducer's
  // secondary pass halves every array that is not `preserve`, so a four-entry list
  // became [4, 29] and then [4] - and a one-entry list still reads as "one
  // repetition failed". keepCounts records a reduction; it does not prevent one, so
  // a list that IS the result has to be held out of the halving pass.
  const { buildCiAnnotation } = await import('../scripts/lib/ciAnnotation.mjs');
  const failing = [4, 14, 29, 60];
  const runs = Array.from({ length: 60 }, (_, i) => ({
    r: i + 1, st: failing.includes(i + 1) ? 'FAIL' : 'PASS',
    worst: 16, margin: 5.33, lagAudio: 2.82, lagMax: 77.35, load: 53.79,
  }));
  const { text, truncated } = buildCiAnnotation('aggregate', {
    label: 'coldstart-diagnostic', repetitions: 60,
    perRepetitionVerdicts: runs.map(row => (row.st === 'PASS' ? 'P' : 'F')).join(''),
    failingRepetitions: failing, passed: 56, failed: 4, tightestMarginMs: 3.33, runs,
  }, { cap: 1400, keepCounts: ['runs'], exact: ['failingRepetitions'] });
  assert.equal(truncated, false);
  const body = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(body.failed, 4);
  assert.deepEqual(body.failingRepetitions, failing,
    'every failing repetition must be named, not just the first');
  assert.ok(body.runs.length < 60, 'the verbose list is still reduced to fit the cap');
  assert.equal(body.runsReducedFrom, 60);
});

test('without the exact option the old halving is what a reader would have got', async () => {
  // Pins the defect itself, so the regression test above cannot pass by accident if
  // `exact` ever stops being honoured: the same payload, unreduced list protected,
  // loses three of its four entries.
  const { buildCiAnnotation } = await import('../scripts/lib/ciAnnotation.mjs');
  const runs = Array.from({ length: 60 }, (_, i) => ({
    r: i + 1, st: [4, 14, 29, 60].includes(i + 1) ? 'FAIL' : 'PASS',
    worst: 16, margin: 5.33, lagAudio: 2.82, lagMax: 77.35, load: 53.79,
  }));
  const { text } = buildCiAnnotation('aggregate', {
    label: 'coldstart-diagnostic', repetitions: 60, failingRepetitions: [4, 14, 29, 60],
    failed: 4, runs,
  }, { cap: 1400, keepCounts: ['runs'] });
  const body = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(body.failingRepetitions.length, 1,
    'this is the behaviour `exact` exists to prevent');
});
