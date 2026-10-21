export function analyzeCapture(run: any) {
  const source = new Float32Array(run.sourceFrames);
  let seed = 0x7135ace1;
  for (let i = 0; i < source.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    source[i] = ((seed >>> 0) / 0x100000000 - 0.5) * 0.5;
  }
  let sequenceErrors = 0, frameErrors = 0, processorDeltaErrors = 0;
  let duplicatedSamples = 0, conflictingSamples = 0, missingSamples = 0;
  let preWindowFrameErrors = 0, inWindowFrameErrors = 0;
  let maxAbsError = 0, sq = 0, compared = 0;
  let firstPcmError: any = null;
  const reconstructed = new Float32Array(run.endFrame - run.startFrame);
  const seen = new Uint8Array(reconstructed.length);
  let firstFailure: any = null;
  const fail = (detail: any) => { firstFailure ??= detail; };
  for (let i = 0; i < run.records.length; i++) {
    const r = run.records[i], prev = run.records[i - 1];
    if (r.sequence !== i) { sequenceErrors++; fail({ kind: 'sequence', index: i, record: r.sequence }); }
    if (prev && r.frame !== prev.frame + prev.quantum) {
      frameErrors++;
      if (r.frame < run.startFrame && prev.frame + prev.quantum <= run.startFrame) preWindowFrameErrors++;
      else inWindowFrameErrors++;
      fail({ kind: 'frame-progression', previous: { ...prev, pcm: undefined, pcmBase64: undefined }, current: { ...r, pcm: undefined, pcmBase64: undefined } });
    }
    if (prev && r.deltaInProcessor !== prev.quantum) processorDeltaErrors++;
    for (let j = 0; j < r.quantum; j++) {
      const frame = r.frame + j, offset = frame - run.startFrame;
      if (offset < 0 || offset >= reconstructed.length) continue;
      const sample = r.pcm[j];
      if (seen[offset]) {
        duplicatedSamples++;
        if (reconstructed[offset] !== sample) conflictingSamples++;
      }
      seen[offset] = 1;
      reconstructed[offset] = sample;
      const expected = source[frame - run.sourceStartFrame] ?? 0;
      const error = Math.abs(sample - expected);
      if (error > 0) firstPcmError ??= { frame, sourceIndex: frame - run.sourceStartFrame, actual: sample, expected, error };
      maxAbsError = Math.max(maxAbsError, error);
      sq += error * error; compared++;
    }
  }
  for (const value of seen) if (!value) missingSamples++;
  const end = run.messages.find((m: any) => m.kind === 'end');
  const first = run.records[0];
  const last = run.records.at(-1);
  // Expected count from observed actual quantum (reject varying sizes for this
  // count formula rather than silently presuming 128).
  const quanta = [...new Set(run.records.map((r: any) => r.quantum))];
  const expectedBlocks = quanta.length === 1 ? Math.ceil((run.endFrame - first.frame) / first.quantum) : null;
  const countMatches = end?.sequence === run.records.length && (expectedBlocks === null || expectedBlocks === run.records.length);
  const pcmLengthErrors = run.records.filter((r: any) => r.pcm.length !== r.quantum || r.inputLengths.some((n: number) => n !== r.quantum)).length;
  const result = { sequenceErrors, frameErrors, preWindowFrameErrors, inWindowFrameErrors, processorDeltaErrors, missingSamples, duplicatedSamples, conflictingSamples,
    maxAbsError, rmsError: Math.sqrt(sq / Math.max(1, compared)), comparedSamples: compared,
    expectedWindowSamples: reconstructed.length, receivedBlocks: run.records.length, expectedBlocks,
    firstFrame: first?.frame, lastFrame: last?.frame, quantumSizes: quanta, countMatches, pcmLengthErrors,
    aliasCount: run.aliasCount, changedBlocks: run.changedBlocks, checksumFailures: run.checksumFailures,
    firstFailure, firstPcmError, endMarker: end };
  return { ...result, passed: sequenceErrors === 0 && frameErrors === 0 && processorDeltaErrors === 0 &&
    missingSamples === 0 && duplicatedSamples === 0 && maxAbsError === 0 && countMatches && pcmLengthErrors === 0 &&
    run.aliasCount === 0 && run.changedBlocks === 0 && run.checksumFailures === 0 && end?.reason === 'frame-end' };
}
