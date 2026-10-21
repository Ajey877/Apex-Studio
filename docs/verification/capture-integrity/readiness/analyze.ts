export function analyzeReady(run: any) {
  const records = run.records;
  const ready = run.markers.find((m: any) => m.kind === 'ready');
  const armed = run.markers.find((m: any) => m.kind === 'armed');
  const end = run.markers.find((m: any) => m.kind === 'end');
  const anomalies: any[] = [];
  let sequenceErrors = 0, layoutErrors = 0, runIdErrors = run.wrongRunIds;
  let conflictingTimestampBlocks = 0;
  const byFrame = new Map<number, any>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i], prev = records[i - 1];
    if (r.runId !== run.runId) runIdErrors++;
    if (r.sequence !== i) sequenceErrors++;
    if (r.quantum <= 0 || r.outputChannels !== 1 || r.outputLengths.length !== 1 || r.outputLengths[0] !== r.quantum ||
        r.pcm.length !== r.quantum || r.sampleRate !== run.sampleRate || r.inputChannels !== r.inputLengths.length ||
        r.inputLengths.some((n: number) => n !== r.quantum) || r.frame !== r.frameAfterCopy || r.mainContextState !== 'running') layoutErrors++;
    if (prev && r.frame !== prev.frame + prev.quantum) anomalies.push({
      sequence: r.sequence, previousSequence: prev.sequence, previousFrame: prev.frame,
      expectedFrame: prev.frame + prev.quantum, actualFrame: r.frame,
      phase: ready && r.sequence > ready.sequence ? 'post-ready' : 'startup',
    });
    const prior = byFrame.get(r.frame);
    if (prior && (prior.pcm.length !== r.pcm.length || prior.pcm.some((value: number, j: number) => value !== r.pcm[j]))) conflictingTimestampBlocks++;
    byFrame.set(r.frame, r);
  }
  for (const m of run.markers) if (m.runId !== run.runId) runIdErrors++;
  const proof = ready ? records.slice(ready.sequence + 1 - run.requiredQuanta, ready.sequence + 1) : [];
  const readiness = !!ready && ready.mainContextState === 'running' && ready.sampleRate === run.sampleRate &&
    ready.required === run.requiredQuanta && ready.streak >= run.requiredQuanta && proof.length === run.requiredQuanta &&
    proof.every((r: any, i: number) => i === 0 || r.frame === proof[i - 1].frame + proof[i - 1].quantum) &&
    ready.endFrame === proof.at(-1)?.frame + proof.at(-1)?.quantum;
  const w = run.window;
  const source = new Float32Array(run.sourceFrames);
  let seed = 0x7135ace1;
  for (let i = 0; i < source.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    source[i] = ((seed >>> 0) / 0x100000000 - 0.5) * 0.5;
  }
  const samples = new Float32Array(w ? w.endFrame - w.startFrame : 0);
  const seen = new Uint8Array(samples.length);
  let duplicates = 0, conflicts = 0, compared = 0, sq = 0, maxAbsError = 0, silenceMax = 0, activeChannelErrors = 0;
  let firstPcmError: any = null;
  const selectionSequences: number[] = [];
  for (const r of records) {
    if (!w) continue;
    if (r.frame < w.endFrame && r.frame + r.quantum > w.startFrame) selectionSequences.push(r.sequence);
    if (r.frame < w.sourceStartFrame + run.sourceFrames && r.frame + r.quantum > w.sourceStartFrame && r.inputChannels !== 1) activeChannelErrors++;
    for (let i = 0; i < r.quantum; i++) {
      const frame = r.frame + i, index = frame - w.startFrame;
      if (index < 0 || index >= samples.length) continue;
      const sample = r.pcm[i];
      if (seen[index]) { duplicates++; if (samples[index] !== sample) conflicts++; }
      seen[index] = 1; samples[index] = sample;
      const sourceIndex = frame - w.sourceStartFrame;
      const expected = source[sourceIndex] ?? 0;
      const error = Math.abs(sample - expected);
      if (error > 0 && !firstPcmError) firstPcmError = { sequence: r.sequence, frame, sourceIndex, sample, expected, error };
      if (!Number.isFinite(error)) { maxAbsError = Infinity; }
      else maxAbsError = Math.max(maxAbsError, error);
      if (sourceIndex < 0 || sourceIndex >= source.length) silenceMax = Math.max(silenceMax, Math.abs(sample));
      sq += error * error; compared++;
    }
  }
  let missing = 0;
  for (const s of seen) if (!s) missing++;
  const startupAnomalies = anomalies.filter(a => a.phase === 'startup');
  const postReadyAnomalies = anomalies.filter(a => a.phase === 'post-ready');
  const endValid = !!end && end.blocks === records.length && end.frame + end.quantum >= w?.endFrame &&
    end.frame === records.at(-1)?.frame && end.endFrame === w?.endFrame;
  const schedulingValid = !!w && !!armed && !armed.tooLate && armed.frame < w.startFrame &&
    w.scheduledAtFrame >= ready?.endFrame && w.sourceStartFrame > w.startFrame && w.startFrame > ready?.endFrame;
  const measurementIntegrity = !!w && missing === 0 && duplicates === 0 && conflicts === 0 && compared === samples.length &&
    postReadyAnomalies.length === 0 && sequenceErrors === 0 && layoutErrors === 0 && activeChannelErrors === 0 &&
    runIdErrors === 0 && run.aliasCount === 0 && run.changedBlocks === 0 && run.checksumFailures === 0 && endValid && schedulingValid;
  // No unproven floating tolerance: nonzero errors are retained and fail fidelity.
  const fidelity = samples.length > 0 && maxAbsError === 0 && silenceMax === 0;
  return { runId: run.runId, readiness, startupContinuous: startupAnomalies.length === 0,
    startupAnomalies, postReadyAnomalies, sequenceErrors, layoutErrors, activeChannelErrors, runIdErrors,
    conflictingTimestampBlocks, measurementIntegrity, fidelity, endValid, schedulingValid,
    missing, duplicates, conflicts, expectedSamples: samples.length, compared, maxAbsError,
    rmsError: Math.sqrt(sq / Math.max(1, compared)), silenceMax, firstPcmError,
    receivedBlocks: records.length, selectedBlocks: selectionSequences.length,
    quantumSizes: [...new Set(records.map((r: any) => r.quantum))],
    aliasCount: run.aliasCount, changedBlocks: run.changedBlocks, checksumFailures: run.checksumFailures,
    ready, armed, end, error: run.error,
    passed: !run.error && readiness && measurementIntegrity && fidelity && !run.markers.some((m: any) => m.kind === 'protocol-error') };
}
