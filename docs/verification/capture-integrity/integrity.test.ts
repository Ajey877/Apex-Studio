import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCapture } from './analyze';

function fixture() {
  return { sourceFrames: 0, sourceStartFrame: 0, startFrame: 0, endFrame: 384,
    aliasCount: 0, changedBlocks: 0, checksumFailures: 0,
    messages: [{ kind: 'end', sequence: 3, frame: 256, quantum: 128, reason: 'frame-end' }],
    records: [0, 1, 2].map(sequence => ({ sequence, frame: sequence * 128,
      quantum: 128, deltaInProcessor: sequence ? 128 : null, inputLengths: [128], pcm: Array(128).fill(0) })) };
}
test('accepts a contiguous capture including silent source intervals', () => {
  assert.equal(analyzeCapture(fixture()).passed, true);
});
test('rejects duplicate identical frames that old overwrite reconstruction conceals', () => {
  const run = fixture();
  run.records[1].frame = 0; run.records[1].deltaInProcessor = 0;
  const metrics = analyzeCapture(run);
  assert.equal(metrics.maxAbsError, 0); // energy or sample error alone cannot detect this
  assert.equal(metrics.duplicatedSamples, 128);
  assert.equal(metrics.missingSamples, 128);
  assert.equal(metrics.passed, false);
});
test('rejects conflicting PCM with duplicated metadata', () => {
  const run = fixture();
  run.records[1].frame = 0; run.records[1].pcm[0] = 0.2;
  assert.equal(analyzeCapture(run).conflictingSamples, 1);
  assert.equal(analyzeCapture(run).passed, false);
});
test('rejects a lost port message', () => {
  const run = fixture(); run.records.splice(1, 1);
  assert.equal(analyzeCapture(run).sequenceErrors, 1);
  assert.equal(analyzeCapture(run).passed, false);
});
test('rejects reordered messages rather than sorting away the evidence', () => {
  const run = fixture(); [run.records[0], run.records[1]] = [run.records[1], run.records[0]];
  assert.equal(analyzeCapture(run).passed, false);
});
test('rejects aliased storage and modified received data', () => {
  for (const key of ['aliasCount', 'changedBlocks', 'checksumFailures'] as const) {
    const run = fixture(); run[key] = 1;
    assert.equal(analyzeCapture(run).passed, false);
  }
});
test('rejects trailing blocks discarded by an early main-thread stop flag', () => {
  const run = fixture(); run.records.pop();
  assert.equal(analyzeCapture(run).countMatches, false);
  assert.equal(analyzeCapture(run).missingSamples, 128);
  assert.equal(analyzeCapture(run).passed, false);
});
