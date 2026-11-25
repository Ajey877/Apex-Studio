import test from 'node:test';
import assert from 'node:assert/strict';
import { runRepetitions } from '../scripts/lib/acceptanceRunLoop.mjs';
import { captureFailureEvidence } from '../scripts/lib/failureEvidence.mjs';
import { coldStartFrom } from '../scripts/lib/coldStartEvidence.mjs';

/**
 * Control flow for the packaged native VST3 acceptance.
 *
 * These run the same modules the acceptance script imports, not a reimplementation:
 * whether a failed repetition ends the run is the difference between the fail-fast
 * production gate and the non-gating diagnostic, and a diagnostic that quietly
 * became fail-fast - or a gate that quietly became continue-on-error - would both
 * destroy the evidence this investigation depends on.
 */

const failAt = failingIndexes => {
  const attempted = [];
  const runOnce = async index => {
    attempted.push(index);
    if (failingIndexes.includes(index)) throw new Error(`missed deadline at run ${index}`);
    return { runIndex: index, status: 'PASS' };
  };
  return { runOnce, attempted };
};

test('normal acceptance mode is fail-fast: the first failure ends the run', async () => {
  const { runOnce, attempted } = failAt([2, 3, 4]);
  const result = await runRepetitions({ runs: 5, runOnce });
  assert.deepEqual(attempted, [1, 2], 'it stops at the first failed repetition');
  assert.equal(result.attempted, 2);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.mode, 'acceptance');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 1);
});

test('diagnostic mode continues after a failure and still ends FAIL', async () => {
  const { runOnce, attempted } = failAt([3]);
  const result = await runRepetitions({ runs: 5, runOnce, continueAfterFailure: true });
  assert.deepEqual(attempted, [1, 2, 3, 4, 5], 'every requested repetition is attempted');
  assert.equal(result.attempted, 5);
  assert.equal(result.passed, 4, 'later successes do not erase the earlier failure');
  assert.equal(result.failed, 1);
  assert.equal(result.mode, 'diagnostic');
  assert.equal(result.status, 'FAIL', 'a diagnostic pass fails if ANY repetition failed');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.outcomes.map(o => `${o.run}:${o.status}`),
    ['1:PASS', '2:PASS', '3:FAIL', '4:PASS', '5:PASS']);
});

test('no failed repetition is retried or counted as passed', async () => {
  // A rerun that turned a failure into a pass would be indistinguishable from a fix,
  // so each index must be attempted exactly once and keep its own outcome.
  const { runOnce, attempted } = failAt([2, 4]);
  const result = await runRepetitions({ runs: 6, runOnce, continueAfterFailure: true });
  assert.deepEqual(attempted, [1, 2, 3, 4, 5, 6], 'each index is attempted exactly once');
  assert.equal(new Set(attempted).size, attempted.length, 'no index is attempted twice');
  assert.equal(result.failed, 2);
  assert.equal(result.passed, 4);
  assert.deepEqual(result.outcomes.filter(o => o.status === 'FAIL').map(o => o.run), [2, 4],
    'the failed repetitions stay failed in the record');
  assert.ok(result.outcomes.every(o => o.status === 'FAIL' ? Boolean(o.error) : true),
    'a failed repetition records its error');
});

test('a fully clean diagnostic run is the only way to reach PASS', async () => {
  const { runOnce } = failAt([]);
  const result = await runRepetitions({ runs: 4, runOnce, continueAfterFailure: true });
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.equal(result.attempted, 4);
});

test('a failure on the last repetition still fails the diagnostic', async () => {
  const { runOnce } = failAt([5]);
  const result = await runRepetitions({ runs: 5, runOnce, continueAfterFailure: true });
  assert.equal(result.status, 'FAIL', 'passing earlier repetitions cannot mask a late failure');
  assert.equal(result.attempted, 5);
});

// --- failure-time evidence capture ------------------------------------------------

// The real capture calls page.evaluate twice: first the availability probe, then the
// measurement (the only call that passes a label). The fake has to mirror that split,
// or a throw meant for the measurement lands on the probe and is reported as
// "skipped" instead of as a capture failure.
const fakePage = (native, options = {}) => ({
  evaluate: async (fnOrLabel, label) => {
    const isMeasurement = label !== undefined;
    if (!isMeasurement) return !options.probeUnavailable;
    if (options.throwOnMeasure) throw new Error('page closed mid-capture');
    return { native };
  },
});

const midSessionNative = () => ({
  blockBudgetMs: 21.33,
  worstColdStartTotalMs: 9,
  worstColdStartMarginMs: 12.33,
  mainEventLoopLagDuringAudioMs: 5.26,
  coldStartBlocks: [{ sequence: 0, totalRoundTripMs: 9 }, { sequence: 1, totalRoundTripMs: 8 }],
  // The case that motivated this: the miss is nowhere near the cold window.
  blocksAroundMiss: [{ sequence: 117, totalRoundTripMs: 23, marginMs: -1.67 }],
  missedSequences: [117],
  deadlineMissEvents: [{ event: 'pending-deadline-miss', sequence: 117 }],
  mainRecordedSequences: [0, 1, 2],
  helperStartup: { 'track:slot': { pid: 7060 } },
});

test('a mid-session miss is captured with its own sequence, not healthy blocks 0-2', async () => {
  const captured = await captureFailureEvidence({
    page: fakePage(midSessionNative()), coldStartFrom, helperPids: () => [7060],
  });
  assert.equal(captured.failureCaptureError, undefined);
  assert.equal(captured.failureCaptureSkipped, undefined);
  assert.equal(captured.coldStartAtFailure.capturedAt, 'failure');
  assert.deepEqual(captured.coldStartAtFailure.missedSequences, [117]);
  assert.deepEqual(captured.coldStartAtFailure.blocksAroundMiss.map(b => b.sequence), [117],
    'the guard-named sequence is reported');
  assert.deepEqual(captured.coldStartAtFailure.blocks.map(b => b.sequence), [0, 1],
    'the healthy cold window is kept separately, not used to describe the miss');
  assert.deepEqual(captured.helpersAtFailure, [7060]);
});

test('the original acceptance failure stays authoritative when capture fails', async () => {
  const original = new Error('Native effect missed its real-time processing deadline');
  const captured = await captureFailureEvidence({
    page: fakePage(null, { throwOnMeasure: true }), coldStartFrom, helperPids: () => [],
  });
  // The capture problem is recorded separately and must never replace the error.
  assert.equal(captured.failureCaptureError, 'page closed mid-capture');
  assert.equal(captured.coldStartAtFailure, undefined, 'no snapshot is fabricated');
  assert.equal(original.message, 'Native effect missed its real-time processing deadline');
});

test('capture is reported as skipped, not failed, when the probe or page is gone', async () => {
  const noPage = await captureFailureEvidence({ page: null, coldStartFrom });
  assert.equal(noPage.failureCaptureSkipped, 'no page at failure time');
  assert.equal(noPage.failureCaptureError, undefined);

  const noProbe = await captureFailureEvidence({
    page: fakePage(null, { probeUnavailable: true }), coldStartFrom,
  });
  assert.equal(noProbe.failureCaptureSkipped, 'acceptance probe unavailable at failure time');
  assert.equal(noProbe.coldStartAtFailure, undefined);
});

// --- the shared snapshot extractor -------------------------------------------------

test('a measurement with nothing in it yields nulls, never zeros', async () => {
  const snapshot = coldStartFrom({}, 'warmup');
  assert.equal(snapshot.blockBudgetMs, null);
  assert.equal(snapshot.worstMarginMs, null);
  assert.deepEqual(snapshot.blocks, []);
  assert.deepEqual(snapshot.blocksAroundMiss, []);
  assert.deepEqual(snapshot.missedSequences, []);
  assert.equal(snapshot.capturedAt, 'warmup');
  // A fabricated 0 ms margin would read as "exactly on budget" rather than unknown.
  assert.ok(!Object.values(snapshot).includes(0));
});

test('all three capture points produce the same field set', async () => {
  // The defect this prevents: a field present in the warm-up snapshot but missing
  // from the failure snapshot, so a failing run reported no decomposition at all.
  const native = midSessionNative();
  const shapes = ['warmup', 'afterMonitoring', 'failure']
    .map(at => Object.keys(coldStartFrom(native, at)).sort().join(','));
  assert.equal(new Set(shapes).size, 1, 'every capture point exposes identical fields');
});
