import { analyzeReady } from '../readiness/analyze';

export function analyzeIsolation(run: any) {
  // The original contract remains reported even when a deliberate control does
  // not satisfy its scheduling geometry (no-ready/immediate/generated).
  const baseline = analyzeReady(run);
  const records = run.records;
  const w = run.window;
  let maxError = 0, sq = 0, n = 0, identityErrors = 0, ownershipErrors = 0;
  let firstError: any = null;
  for (const r of records) {
    if (r.instanceId !== run.runId + ':processor-0' || r.callbackCount !== r.sequence + 1 || r.frameAtExit !== r.frame || r.frameAfterCopy !== r.frame) identityErrors++;
    if (r.sequence > 0 && r.previousTransferBytes !== 0) ownershipErrors++;
    if (run.mode !== 'generated') continue;
    for (let i = 0; i < r.quantum; i++) {
      const frame = r.frame + i;
      if (!w || frame < w.startFrame || frame >= w.endFrame) continue;
      let x = (frame ^ 0x7135ace1) >>> 0;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      const expected = Math.fround(((x >>> 0) / 0x100000000 - 0.5) * 0.5);
      const error = Math.abs(r.pcm[i] - expected);
      if (error && !firstError) firstError = { frame, expected, actual: r.pcm[i] };
      maxError = Math.max(maxError, error); sq += error * error; n++;
    }
  }
  const anomalies = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1], r = records[i];
    if (r.frame !== prev.frame + prev.quantum) {
      const clean = (record: any) => { const { pcm, ...metadata } = record; return metadata; };
      anomalies.push({ sequence: r.sequence, expected: prev.frame + prev.quantum, actual: r.frame,
        phase: baseline.ready && r.sequence > baseline.ready.sequence ? 'post-ready' : 'startup',
        neighbors: records.slice(Math.max(0,i-2),i+3).map(clean),
        matchingFrameSequences: records.filter((v: any) => v.frame === r.frame).map((v: any) => v.sequence),
        lifecycle: run.lifecycle });
    }
  }
  const generated = run.mode === 'generated';
  const fidelity = generated ? n > 0 && maxError === 0 : baseline.fidelity;
  const sourceCoverage = !!w && baseline.missing === 0 && baseline.duplicates === 0 && baseline.conflicts === 0 && baseline.compared === baseline.expectedSamples;
  const postReadyContinuous = baseline.postReadyAnomalies.length === 0;
  // This does not substitute a control pass for the baseline contract.
  const integrity = !run.error && baseline.readiness && sourceCoverage && postReadyContinuous && baseline.sequenceErrors === 0 && baseline.layoutErrors === 0 && baseline.runIdErrors === 0 &&
    baseline.aliasCount === 0 && baseline.changedBlocks === 0 && baseline.checksumFailures === 0 && baseline.endValid && identityErrors === 0 && ownershipErrors === 0;
  return { runId: run.runId, mode: run.mode, window: w, contextId: run.contextId,
    readiness: baseline.readiness, startupContinuous: baseline.startupContinuous,
    postReadyContinuous, sourceCoverage, fidelity, maxAbsError: generated ? maxError : baseline.maxAbsError,
    rmsError: generated ? Math.sqrt(sq / Math.max(1,n)) : baseline.rmsError,
    baselineContractPass: baseline.passed, integrity, identityErrors, ownershipErrors,
    missing: baseline.missing, duplicates: baseline.duplicates, conflicts: baseline.conflicts,
    conflictingTimestampBlocks: baseline.conflictingTimestampBlocks,
    sequenceErrors: baseline.sequenceErrors, checksumFailures: baseline.checksumFailures,
    aliasCount: baseline.aliasCount, changedBlocks: baseline.changedBlocks,
    actualQuanta: baseline.quantumSizes, ready: baseline.ready, armed: baseline.armed,
    error: run.error, anomalies, lifecycle: run.lifecycle };
}
