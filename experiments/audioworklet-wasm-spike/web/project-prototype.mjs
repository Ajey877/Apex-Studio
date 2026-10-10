// Browser/Electron entrypoints for the prototype-only multitrack experiment.
// The fixture is synthetic and does not invoke Apex production project code.
import { REPRESENTATIVE_PROJECT } from '../fixtures/representative-project.mjs';
import { compileProject, renderProjectSources } from './project-model.mjs';
import { renderProjectReference, maxAbsDifference, summarizeStereo } from './project-render-reference.mjs';
import { decodeWav16Bit, encodeWav16Bit, hashBytes32 } from './project-render-core.mjs';
import { wasmBytes } from './wasm-engine-bytes.mjs';

const FLOAT_TOLERANCE = 1e-6;
const PCM16_TOLERANCE = (1 / 32767) + 1e-7;

export async function runLiveProjectParity(project = REPRESENTATIVE_PROJECT) {
  const reference = renderProjectReference(project);
  const live = await runLiveProject(project, { captureFrames: reference.info.durationFrames });
  const comparisons = compareProjectCaptures(live.capture, reference);
  const alternateOrder = renderProjectReference(project, { captureStems: false, automationBeforeInsert: true });
  const wrongOrderDelta = maxAbsDifference(alternateOrder.master.left, reference.master.left).maxAbsDiff;
  const sourceFingerprints = live.sourceFingerprints;
  const distinctSources = new Set(sourceFingerprints).size === sourceFingerprints.length;
  const trackSignalPresent = reference.tracks.map(track => ({ id: track.id, rms: stereoRms(track) }));
  const pass = comparisons.withinTolerance && distinctSources && trackSignalPresent.every(track => track.rms > 1e-5)
    && wrongOrderDelta > FLOAT_TOLERANCE && live.disposed.after.slotsInUse === 0
    && live.disposed.before.engineInstances === 1 && live.disposed.before.wasmMemoryBytes === 131072;
  return {
    pass,
    fixture: reference.info,
    source: {
      fingerprints: sourceFingerprints,
      distinct: distinctSources,
      stats: reference.sourceStats,
    },
    comparisons,
    orderingSensitivity: {
      testedOrder: 'WASM insert -> fader automation -> pan -> route -> bus soft clip -> master',
      alternateOrder: 'fader automation before WASM insert',
      alternateMaxAbsDiff: wrongOrderDelta,
      tolerance: FLOAT_TOLERANCE,
    },
    trackSignals: trackSignalPresent,
    live: live.info,
    audioContext: live.audioContext,
    rendererHeap: live.rendererHeap,
    disposed: live.disposed,
    limitations: projectLimitations(),
  };
}

export async function runLiveParameterChange(project = REPRESENTATIVE_PROJECT) {
  const compiled = compileProject(project);
  const captureFrames = Math.round(compiled.sampleRate * 1.5);
  const live = await runLiveProject(project, {
    captureFrames,
    parameterChange: { trackId: 'bass', atSeconds: 0.70, patch: { fader: 0.12 } },
  });
  const applied = live.controlsApplied;
  const bass = live.capture.tracks.find(track => track.id === 'bass');
  const hat = live.capture.tracks.find(track => track.id === 'hat');
  const baseline = renderProjectReference(project);
  const expectedBass = baseline.tracks.find(track => track.id === 'bass');
  const expectedHat = baseline.tracks.find(track => track.id === 'hat');
  const beforeStart = Math.round(compiled.sampleRate * 0.50);
  const beforeEnd = Math.round(compiled.sampleRate * 0.66);
  const afterStart = Math.round(compiled.sampleRate * 0.80);
  const afterEnd = Math.round(compiled.sampleRate * 0.96);
  const beforeActualRms = stereoRmsRegion(bass, beforeStart, beforeEnd);
  const beforeExpectedRms = stereoRmsRegion(expectedBass, beforeStart, beforeEnd);
  const afterActualRms = stereoRmsRegion(bass, afterStart, afterEnd);
  const afterExpectedRms = stereoRmsRegion(expectedBass, afterStart, afterEnd);
  const hatDiff = maxStereoDiffRegion(hat, expectedHat, afterStart, afterEnd);
  const afterRatio = afterActualRms / Math.max(afterExpectedRms, 1e-12);
  const appliedProjectFrame = applied ? applied.frame - live.startFrame : -1;
  const pass = !!applied && applied.controls.fader === 0.12 && applied.old.fader === 0.78
    && beforeActualRms > 1e-5 && beforeExpectedRms > 1e-5 && afterExpectedRms > 1e-5
    && afterRatio < 0.25 && hatDiff <= FLOAT_TOLERANCE
    && live.disposed.after.slotsInUse === 0;
  return {
    pass,
    fixtureId: compiled.id,
    changedTrack: 'bass',
    appliedAtProjectFrame: appliedProjectFrame,
    requestedAtProjectFrame: Math.round(0.70 * compiled.sampleRate),
    oldControls: applied?.old || null,
    newControls: applied?.controls || null,
    regions: {
      before: { startFrame: beforeStart, endFrame: beforeEnd, actualRms: beforeActualRms, referenceRms: beforeExpectedRms },
      after: { startFrame: afterStart, endFrame: afterEnd, actualRms: afterActualRms, baselineRms: afterExpectedRms, ratioToUnchangedBaseline: afterRatio },
      unaffectedHatMaxAbsDiff: hatDiff,
    },
    audioContext: live.audioContext,
    worklet: live.info,
    disposed: live.disposed,
  };
}

export async function runLiveOfflineConsistency(project = REPRESENTATIVE_PROJECT) {
  const compiled = compileProject(project);
  const reference = renderProjectReference(project, { captureStems: false });
  const live = await runLiveProject(project, { captureFrames: compiled.totalFrames });
  const worker = makeProjectWorker();
  try {
    worker.postMessage({ type: 'init' });
    const ready = await waitWorkerMessage(worker, msg => msg.type === 'ready' || msg.type === 'error');
    if (ready.type !== 'ready') throw new Error(`Worker init failed: ${ready.message}`);
    const jobId = 'live-offline-consistency';
    worker.postMessage({ type: 'render-project', jobId, project, includeWav: true, includeFloatPcm: true, yieldEveryBlocks: 512 });
    const rendered = await waitWorkerMessage(worker, msg => msg.jobId === jobId && ['exported', 'error', 'cancelled'].includes(msg.type), 120_000);
    if (rendered.type !== 'exported' || !(rendered.output.floatPcm instanceof ArrayBuffer)) throw new Error(`Worker float export failed: ${rendered.message || rendered.type}`);
    const interleaved = new Float32Array(rendered.output.floatPcm);
    if (interleaved.length !== compiled.totalFrames * 2 || rendered.output.frames !== compiled.totalFrames) throw new Error('live/offline PCM frame count mismatch');
    const offlineLeft = new Float32Array(compiled.totalFrames);
    const offlineRight = new Float32Array(compiled.totalFrames);
    for (let frame = 0; frame < compiled.totalFrames; frame++) {
      offlineLeft[frame] = interleaved[frame * 2];
      offlineRight[frame] = interleaved[frame * 2 + 1];
    }
    const liveVsOffline = {
      left: maxAbsDifference(live.capture.master.left, offlineLeft),
      right: maxAbsDifference(live.capture.master.right, offlineRight),
    };
    const offlineVsReference = {
      left: maxAbsDifference(offlineLeft, reference.master.left),
      right: maxAbsDifference(offlineRight, reference.master.right),
    };
    const liveVsReference = {
      left: maxAbsDifference(live.capture.master.left, reference.master.left),
      right: maxAbsDifference(live.capture.master.right, reference.master.right),
    };
    const maximum = Math.max(liveVsOffline.left.maxAbsDiff, liveVsOffline.right.maxAbsDiff,
      offlineVsReference.left.maxAbsDiff, offlineVsReference.right.maxAbsDiff,
      liveVsReference.left.maxAbsDiff, liveVsReference.right.maxAbsDiff);
    const pass = maximum <= FLOAT_TOLERANCE && rendered.memory.engineInstances === 1
      && rendered.memory.memoryBytes === 131072 && live.info.wasmMemoryBytes === 131072
      && live.disposed.after.slotsInUse === 0;
    return {
      pass,
      fixture: reference.info,
      tolerance: FLOAT_TOLERANCE,
      maxAbsDiff: maximum,
      liveVsOffline,
      offlineVsReference,
      liveVsReference,
      wasm: { workerInstances: 1, workerEngineInstances: rendered.memory.engineInstances, workerMemoryBytes: rendered.memory.memoryBytes, liveEngineInstances: live.info.engineInstances, liveMemoryBytes: live.info.wasmMemoryBytes },
      worker: { wavBytes: rendered.output.bytes, floatPcmBytes: rendered.output.floatPcmBytes, hash32: rendered.output.hash32, renderMs: rendered.metrics.coreRenderMs },
      live: { worklet: live.info, playbackStats: live.audioContext.playbackStats, wallElapsedMs: live.audioContext.wallElapsedMs, disposedSlots: live.disposed.after.slotsInUse },
    };
  } finally {
    await disposeAndTerminate(worker);
  }
}

export async function runOfflineProjectBatch({ renders = 200, project = REPRESENTATIVE_PROJECT } = {}) {
  if (!Number.isInteger(renders) || renders < 1 || renders > 500) throw new RangeError('renders must be an integer from 1 to 500');
  const compiled = compileProject(project);
  const reference = renderProjectReference(project, { captureStems: false });
  const referenceWav = encodeWav16Bit(reference.master, reference.info.sampleRate);
  const expectedHash = hashBytes32(referenceWav);
  const referenceDecoded = decodeWav16Bit(referenceWav);
  const worker = makeProjectWorker();
  const heapBefore = rendererHeapSnapshot();
  const batchStart = performance.now();
  let ready;
  let firstDecoded = null;
  let stableHash = null;
  let finalMemory = null;
  let maxAbsPcmDiff = 0;
  let wavBytesPerExport = 0;
  const hashes = new Set();
  const coreRenderTimes = [];
  const wavEncodeTimes = [];
  const exportTimes = [];
  try {
    worker.postMessage({ type: 'init' });
    ready = await waitWorkerMessage(worker, msg => msg.type === 'ready' || msg.type === 'error');
    if (ready.type !== 'ready') throw new Error(`Worker init failed: ${ready.message}`);
    for (let index = 0; index < renders; index++) {
      const jobId = `full-export-${index}`;
      const includeWav = index === 0;
      worker.postMessage({ type: 'render-project', jobId, project, includeWav, yieldEveryBlocks: 512 });
      const message = await waitWorkerMessage(worker, msg => msg.jobId === jobId && ['exported', 'error', 'cancelled'].includes(msg.type), 120_000);
      if (message.type !== 'exported') throw new Error(`export ${index} ${message.type}: ${message.message || ''}`);
      const { output, metrics, memory } = message;
      if (output.frames !== compiled.totalFrames || output.bytes !== 44 + compiled.totalFrames * 4
        || output.format !== 'WAV/PCM16/stereo' || output.nonFinite !== 0 || output.peak <= 0) {
        throw new Error(`export ${index} had invalid/empty output metadata`);
      }
      if (memory.engineInstances !== 1 || memory.memoryBytes !== 131072 || memory.memoryBytes !== memory.memoryBytesAtStart
        || memory.jobsCompleted !== index + 1 || memory.jobsCancelled !== 0) {
        throw new Error(`export ${index} changed Worker engine/memory lifecycle: ${JSON.stringify(memory)}`);
      }
      if (stableHash === null) stableHash = output.hash32;
      if (output.hash32 !== stableHash) throw new Error(`export ${index} is not byte-deterministic: ${output.hash32} != ${stableHash}`);
      hashes.add(output.hash32);
      coreRenderTimes.push(metrics.coreRenderMs ?? metrics.elapsedMs);
      wavEncodeTimes.push(metrics.wavEncodeMs ?? 0);
      exportTimes.push(metrics.exportElapsedMs ?? metrics.elapsedMs);
      wavBytesPerExport = output.bytes;
      finalMemory = memory;
      if (includeWav) {
        if (!(output.wavBytes instanceof ArrayBuffer)) throw new Error('first export did not transfer WAV bytes');
        const decoded = decodeWav16Bit(new Uint8Array(output.wavBytes));
        if (decoded.frames !== compiled.totalFrames || decoded.sampleRate !== compiled.sampleRate) throw new Error('WAV header/frame count mismatch');
        const leftDiff = maxAbsDifference(decoded.left, reference.master.left).maxAbsDiff;
        const rightDiff = maxAbsDifference(decoded.right, reference.master.right).maxAbsDiff;
        maxAbsPcmDiff = Math.max(leftDiff, rightDiff);
        if (maxAbsPcmDiff > PCM16_TOLERANCE) throw new Error(`quantized WAV differs from reference by ${maxAbsPcmDiff}`);
        const referencePcmMismatches = countDifferentSamples(decoded, referenceDecoded);
        firstDecoded = {
          frames: decoded.frames,
          sampleRate: decoded.sampleRate,
          dataBytes: decoded.dataBytes,
          differingPcm16SamplesFromReferenceEncoding: referencePcmMismatches,
          hashMatchesReferenceEncoding: output.hash32 === expectedHash,
        };
      }
    }
    const batchMs = performance.now() - batchStart;
    const heapAfter = rendererHeapSnapshot();
    const sortedTimes = exportTimes.slice().sort((a, b) => a - b);
    const sortedCoreTimes = coreRenderTimes.slice().sort((a, b) => a - b);
    const sortedWavTimes = wavEncodeTimes.slice().sort((a, b) => a - b);
    const distribution = sorted => ({ p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), max: sorted.at(-1) || 0 });
    const expectedJobs = renders;
    const pass = hashes.size === 1 && finalMemory?.jobsCompleted === expectedJobs
      && finalMemory?.memoryBytes === 131072 && maxAbsPcmDiff <= PCM16_TOLERANCE;
    const report = {
      pass,
      fixture: { ...reference.info, scheduledEvents: compiled.eventCount },
      jobsRequested: renders,
      jobsCompleted: finalMemory?.jobsCompleted || 0,
      jobsFailed: finalMemory?.jobsFailed || 0,
      workerInstances: 1,
      engineInstances: finalMemory?.engineInstances || 0,
      wasmMemoryBytesAtStart: ready.info.memoryBytes,
      wasmMemoryBytesMin: 131072,
      wasmMemoryBytesMax: finalMemory?.memoryBytes || 0,
      workerOutputBytesTotal: wavBytesPerExport * renders,
      wavBytesPerExport,
      hashes: {
        distinctRepeatedExportHashes: hashes.size,
        value: stableHash,
        referenceWavHash: expectedHash,
        byteExactMatchToReferenceEncoding: stableHash === expectedHash,
        matchesIndependentReferenceWithinPcmTolerance: maxAbsPcmDiff <= PCM16_TOLERANCE,
      },
      decodedFirstExport: firstDecoded,
      numerical: { maxAbsDiffAfterPCM16Quantization: maxAbsPcmDiff, tolerance: PCM16_TOLERANCE, nonFinite: 0 },
      performance: {
        batchMs,
        exportsPerSecond: renders / (batchMs / 1000),
        audioRealtimeFactor: (compiled.totalFrames / compiled.sampleRate * renders) / (batchMs / 1000),
        coreRenderMs: distribution(sortedCoreTimes),
        wavEncodeMs: distribution(sortedWavTimes),
        endToEndWorkerExportMs: distribution(sortedTimes),
      },
      memory: { workerWasmBytesConstant: finalMemory?.memoryBytes === 131072, rendererHeapBefore: heapBefore, rendererHeapAfter: heapAfter },
      finalWorkerState: finalMemory,
      limitations: projectLimitations(),
    };
    return report;
  } finally {
    await disposeAndTerminate(worker);
  }
}

export async function runOfflineCancellationRecovery(project = REPRESENTATIVE_PROJECT) {
  const reference = renderProjectReference(project, { captureStems: false });
  const referenceWav = encodeWav16Bit(reference.master, reference.info.sampleRate);
  const expectedWavHash = hashBytes32(referenceWav);
  const referenceDecoded = decodeWav16Bit(referenceWav);
  const worker = makeProjectWorker();
  try {
    worker.postMessage({ type: 'init' });
    const ready = await waitWorkerMessage(worker, msg => msg.type === 'ready' || msg.type === 'error');
    if (ready.type !== 'ready') throw new Error(`Worker init failed: ${ready.message}`);
    const cancelledJobId = 'cancelled-full-export';
    const completion = waitWorkerMessage(worker, msg => msg.jobId === cancelledJobId && ['cancelled', 'exported', 'error'].includes(msg.type), 30_000);
    const progress = waitWorkerMessage(worker, msg => msg.type === 'progress' && msg.jobId === cancelledJobId, 30_000);
    worker.postMessage({ type: 'render-project', jobId: cancelledJobId, project, includeWav: false, yieldEveryBlocks: 16 });
    const firstProgress = await progress;
    worker.postMessage({ type: 'cancel', jobId: cancelledJobId });
    const cancelled = await completion;
    if (cancelled.type !== 'cancelled') throw new Error(`cancellation did not stop export: ${cancelled.type}`);
    const recoveredId = 'export-after-cancel';
    worker.postMessage({ type: 'render-project', jobId: recoveredId, project, includeWav: true, yieldEveryBlocks: 512 });
    const recovered = await waitWorkerMessage(worker, msg => msg.jobId === recoveredId && ['exported', 'error', 'cancelled'].includes(msg.type), 120_000);
    if (recovered.type !== 'exported') throw new Error(`post-cancel export ${recovered.type}: ${recovered.message || ''}`);
    const decoded = decodeWav16Bit(new Uint8Array(recovered.output.wavBytes));
    const leftDiff = maxAbsDifference(decoded.left, reference.master.left).maxAbsDiff;
    const rightDiff = maxAbsDifference(decoded.right, reference.master.right).maxAbsDiff;
    const maxDiff = Math.max(leftDiff, rightDiff);
    const referencePcmMismatches = countDifferentSamples(decoded, referenceDecoded);
    const memory = recovered.memory;
    const pass = firstProgress.completedFrames > 0 && memory.jobsCancelled === 1 && memory.jobsCompleted === 1
      && memory.engineInstances === 1 && memory.memoryBytes === 131072
      && maxDiff <= PCM16_TOLERANCE && decoded.frames === reference.info.durationFrames;
    return {
      pass,
      cancel: { requested: true, acknowledged: cancelled.type === 'cancelled', progressAtFrames: firstProgress.completedFrames, memoryAfterCancel: cancelled.memory },
      recovery: {
        type: recovered.type,
        frames: decoded.frames,
        bytes: decoded.dataBytes + 44,
        hash32: recovered.output.hash32,
        maxAbsDiffFromReference: maxDiff,
        tolerance: PCM16_TOLERANCE,
        differingPcm16SamplesFromReferenceEncoding: referencePcmMismatches,
        byteExactMatchToReferenceEncoding: recovered.output.hash32 === expectedWavHash,
        matchesReference: maxDiff <= PCM16_TOLERANCE,
      },
      memory: { engineInstances: memory.engineInstances, wasmMemoryBytes: memory.memoryBytes, jobsStarted: memory.jobsStarted, jobsCompleted: memory.jobsCompleted, jobsCancelled: memory.jobsCancelled, jobsFailed: memory.jobsFailed },
    };
  } finally {
    await disposeAndTerminate(worker);
  }
}

export async function runProjectPrototype({ offlineJobs = 200 } = {}) {
  const fixture = await runLiveProjectParity();
  const parameterChange = await runLiveParameterChange();
  const liveOffline = await runLiveOfflineConsistency();
  const offline = await runOfflineProjectBatch({ renders: offlineJobs });
  const cancellation = await runOfflineCancellationRecovery();
  return {
    pass: fixture.pass && parameterChange.pass && liveOffline.pass && offline.pass && cancellation.pass,
    fixture,
    parameterChange,
    liveOffline,
    offline,
    cancellation,
    limitations: projectLimitations(),
  };
}

async function runLiveProject(project, { captureFrames, parameterChange = null }) {
  if (typeof AudioContext !== 'function') throw new Error('AudioContext is unavailable');
  const compiled = compileProject(project);
  const sources = renderProjectSources(compiled);
  const wallStartedAt = performance.now();
  const context = new AudioContext({ sampleRate: compiled.sampleRate, latencyHint: 'interactive' });
  const heapBefore = rendererHeapSnapshot();
  const sourceNodes = [];
  let node = null;
  let timer = null;
  try {
    await context.resume();
    await context.audioWorklet.addModule(new URL('./project-processor.js', import.meta.url));
    const startFrame = Math.ceil((context.currentTime + 0.18) * compiled.sampleRate / 128) * 128;
    const startTime = startFrame / compiled.sampleRate;
    node = new AudioWorkletNode(context, 'apex-spike-project-engine', {
      numberOfInputs: compiled.tracks.length,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        project,
        wasmBytes: wasmBytes(),
        startFrame,
        captureFrames,
        captureStems: true,
      },
    });
    node.connect(context.destination);
    const readyPromise = waitPortMessage(node.port, msg => msg.type === 'ready' || msg.type === 'init-error', 15_000);
    const capturePromise = waitPortMessage(node.port, msg => msg.type === 'capture-complete', Math.max(30_000, captureFrames / compiled.sampleRate * 3000));
    const controlsPromise = parameterChange
      ? waitPortMessage(node.port, msg => msg.type === 'controls-applied' && msg.trackId === parameterChange.trackId, 15_000)
      : Promise.resolve(null);
    const ready = await readyPromise;
    if (ready.type !== 'ready') throw new Error(`project worklet init failed: ${ready.message}`);
    for (let trackIndex = 0; trackIndex < compiled.tracks.length; trackIndex++) {
      const audioBuffer = context.createBuffer(1, sources[trackIndex].length, compiled.sampleRate);
      audioBuffer.copyToChannel(sources[trackIndex], 0);
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(node, 0, trackIndex);
      source.start(startTime);
      sourceNodes.push(source);
    }
    if (parameterChange) {
      const delayMs = Math.max(0, (startTime - context.currentTime + parameterChange.atSeconds) * 1000);
      timer = setTimeout(() => node.port.postMessage({ type: 'set-controls', trackId: parameterChange.trackId, patch: parameterChange.patch }), delayMs);
    }
    const capturedMessage = await capturePromise;
    const statsPromise = waitPortMessage(node.port, msg => msg.type === 'stats', 5000);
    node.port.postMessage({ type: 'get-stats' });
    const statsMessage = await statsPromise;
    const controlsApplied = parameterChange ? await controlsPromise : null;
    await new Promise(resolve => setTimeout(resolve, 75));
    const audioContext = {
      state: context.state,
      currentTime: context.currentTime,
      sampleRate: context.sampleRate,
      playbackStats: readPlaybackStats(context),
      wallElapsedMs: performance.now() - wallStartedAt,
    };
    const disposedPromise = waitPortMessage(node.port, msg => msg.type === 'disposed', 5000);
    node.port.postMessage({ type: 'dispose' });
    const disposed = await disposedPromise;
    const captured = capturedMessage.capture;
    return {
      capture: captured,
      info: statsMessage.info,
      controlsApplied,
      startFrame,
      audioContext,
      rendererHeap: { before: heapBefore, after: rendererHeapSnapshot() },
      disposed: { before: disposed.before, after: disposed.after },
      sourceFingerprints: sources.map(hashFloat32),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const source of sourceNodes) { try { source.stop(); } catch {} }
    if (node) { try { node.disconnect(); node.port.close(); } catch {} }
    if (context.state !== 'closed') await context.close();
  }
}

function compareProjectCaptures(capture, reference) {
  const compareStereo = (actual, expected) => ({
    left: maxAbsDifference(actual.left, expected.left),
    right: maxAbsDifference(actual.right, expected.right),
  });
  const tracks = capture.tracks.map((track, index) => ({ id: track.id, ...compareStereo(track, reference.tracks[index]) }));
  const buses = capture.buses.map((bus, index) => ({ id: bus.id, ...compareStereo(bus, reference.buses[index]) }));
  const master = compareStereo(capture.master, reference.master);
  const max = Math.max(master.left.maxAbsDiff, master.right.maxAbsDiff,
    ...tracks.flatMap(track => [track.left.maxAbsDiff, track.right.maxAbsDiff]),
    ...buses.flatMap(bus => [bus.left.maxAbsDiff, bus.right.maxAbsDiff]));
  const allNonFinite = [master.left.nonFinite, master.right.nonFinite,
    ...tracks.flatMap(track => [track.left.nonFinite, track.right.nonFinite]),
    ...buses.flatMap(bus => [bus.left.nonFinite, bus.right.nonFinite])].reduce((sum, count) => sum + count, 0);
  return { master, tracks, buses, maxAbsDiff: max, tolerance: FLOAT_TOLERANCE, nonFinite: allNonFinite, withinTolerance: max <= FLOAT_TOLERANCE && allNonFinite === 0 };
}

function stereoRms(stereo) { return stereoRmsRegion(stereo, 0, stereo.left.length); }
function stereoRmsRegion(stereo, start, end) {
  let sum = 0;
  let count = 0;
  for (let i = start; i < Math.min(end, stereo.left.length); i++) { sum += stereo.left[i] ** 2 + stereo.right[i] ** 2; count += 2; }
  return Math.sqrt(sum / Math.max(1, count));
}
function maxStereoDiffRegion(actual, expected, start, end) {
  return Math.max(maxAbsDifference(actual.left.subarray(start, end), expected.left.subarray(start, end)).maxAbsDiff,
    maxAbsDifference(actual.right.subarray(start, end), expected.right.subarray(start, end)).maxAbsDiff);
}
function hashFloat32(buffer) { return hashBytes32(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)); }
function countDifferentSamples(a, b) {
  let count = 0;
  for (let i = 0; i < a.left.length; i++) {
    if (a.left[i] !== b.left[i]) count++;
    if (a.right[i] !== b.right[i]) count++;
  }
  return count;
}
function rendererHeapSnapshot() {
  const memory = globalThis.performance?.memory;
  return memory && Number.isFinite(memory.usedJSHeapSize) ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null;
}
function readPlaybackStats(context) {
  try {
    const value = context.playbackStats;
    return value && Number.isFinite(value.underrunEvents) ? { underrunEvents: value.underrunEvents } : 'not-exposed';
  } catch { return 'not-exposed'; }
}
function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0; }
function projectLimitations() {
  return [
    'Fixture is synthetic JSON, not a saved/opened Apex Studio project; project serialization/save/load is not covered.',
    'Instrument/sample sources are deterministic triangle/saw voices and generated one-shot noise samples, not production instrument code, decoded user samples, MIDI/plugin instruments, or audio asset loading.',
    'WASM DSP is one gain+biquad insert per track; routing supports static sends to buses, track pan, linear fader automation, per-bus gain and a simple rational soft clip.',
    'No production effects chain, automation lanes beyond track fader, sidechains, sends with latency compensation, clip warp/resampling, plugin state, mastering chain, or DAW exporter integration.',
    'The live harness schedules pre-rendered fixture buffers into separate AudioWorklet inputs; its arrangement scheduler is modeled, not integrated with the production transport.',
    'No Electron CSP relaxation or production CSP/audio code change is part of this prototype.',
  ];
}

function makeProjectWorker() { return new Worker(new URL('./project-export-worker.js', import.meta.url), { type: 'module', name: 'apex-spike-project-export' }); }
function waitWorkerMessage(worker, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeEventListener('message', onMessage); reject(new Error(`Worker message timed out after ${timeoutMs} ms`)); }, timeoutMs);
    const onMessage = event => {
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    worker.addEventListener('message', onMessage);
  });
}
function waitPortMessage(port, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port.removeEventListener('message', onMessage); reject(new Error(`AudioWorklet message timed out after ${timeoutMs} ms`)); }, timeoutMs);
    const onMessage = event => {
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    port.addEventListener('message', onMessage);
    port.start?.();
  });
}
async function disposeAndTerminate(worker) {
  try {
    const disposed = waitWorkerMessage(worker, message => message.type === 'disposed', 3000);
    worker.postMessage({ type: 'dispose' });
    await disposed;
  } catch {}
  worker.terminate();
}
