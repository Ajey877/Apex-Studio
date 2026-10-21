import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReady } from './analyze';
function fixture(startupGap = false) {
  const id = 'fixture';
  const frames = startupGap ? [0, 8, 12, 16, 20, 24] : [4, 8, 12, 16, 20, 24];
  const records = frames.map((frame, sequence) => ({ runId: id, frame, sequence,
    frameAfterCopy: frame, quantum: 4, sampleRate: 40, outputChannels: 1, outputLengths: [4],
    inputChannels: 1, inputLengths: [4], mainContextState: 'running', pcm: [0, 0, 0, 0] }));
  return { runId: id, requiredQuanta: 2, sampleRate: 40, sourceFrames: 0, wrongRunIds: 0,
    aliasCount: 0, changedBlocks: 0, checksumFailures: 0, error: null,
    records, window: { startFrame: 17, sourceStartFrame: 20, sourceFrames: 0, endFrame: 28, scheduledAtFrame: 13 },
    markers: [ { kind: 'ready', runId: id, sequence: 2, endFrame: 16, required: 2, streak: 2, sampleRate: 40, mainContextState: 'running' },
      { kind: 'armed', runId: id, frame: 16, tooLate: false },
      { kind: 'end', runId: id, blocks: 6, frame: 24, quantum: 4, endFrame: 28 } ] };
}
test('readiness permits a valid later window but retains startup discontinuity', () => {
  const result = analyzeReady(fixture(true));
  assert.equal(result.startupContinuous, false); assert.equal(result.startupAnomalies.length, 1);
  assert.equal(result.readiness, true); assert.equal(result.measurementIntegrity, true);
  assert.equal(result.passed, true);
});
test('duplicates after readiness fail, even when PCM is identical', () => {
  const run = fixture(); run.records[4].frame = 16; run.records[4].frameAfterCopy = 16;
  assert.equal(analyzeReady(run).passed, false); assert.equal(analyzeReady(run).duplicates, 3);
});
test('contradictory PCM is retained and rejected', () => {
  const run = fixture(); run.records[4].frame = 16; run.records[4].frameAfterCopy = 16; run.records[4].pcm[1] = 0.2;
  const result = analyzeReady(run); assert.equal(result.conflictingTimestampBlocks, 1); assert.equal(result.passed, false);
});
test('invalid readiness proof, late arm, missing end and wrong ID fail', () => {
  for (const mutate of [
    (r: any) => r.markers[0].required++, (r: any) => r.markers[1].tooLate = true,
    (r: any) => r.markers.pop(), (r: any) => r.records[5].runId = 'stale-capture',
  ]) { const run = fixture(); mutate(run); assert.equal(analyzeReady(run).passed, false); }
});
test('main-thread premature stop cannot pass via zero-padding', () => {
  const run = fixture(); run.records.pop();
  assert.equal(analyzeReady(run).passed, false); assert.equal(analyzeReady(run).missing, 4);
});
