// Prototype-only long-lived multi-track export Worker.
// Scheduling, synthetic sample/instrument sources, per-track WASM inserts,
// fader automation, routing, bus processing, cancellation and PCM-WAV writing
// are implemented. This is not the production Apex project exporter.
import { createProjectRenderer, encodeWav16Bit, hashBytes32, interleaveFloat32Stereo, ProjectRenderCancelledError } from './project-render-core.mjs';
import { wasmBytes } from './wasm-engine-bytes.mjs';
import { REPRESENTATIVE_PROJECT } from '../fixtures/representative-project.mjs';

let renderer = null;
let activeJobId = null;
const cancelRequests = new Set();

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelRequests.add(message.jobId);
    self.postMessage({ type: 'cancel-accepted', jobId: message.jobId });
    return;
  }
  if (message.type === 'init') {
    try {
      if (renderer) throw new Error('project export Worker is already initialized');
      renderer = createProjectRenderer(wasmBytes());
      self.postMessage({ type: 'ready', info: renderer.snapshot() });
    } catch (error) {
      self.postMessage({ type: 'error', jobId: message.jobId ?? null, name: error?.name || 'Error', message: String(error?.message || error) });
    }
    return;
  }
  if (message.type === 'render-project') {
    void renderProjectJob(message);
    return;
  }
  if (message.type === 'stats') {
    self.postMessage({ type: 'stats', id: message.id, info: renderer ? renderer.snapshot() : null });
    return;
  }
  if (message.type === 'dispose') {
    const info = renderer ? renderer.dispose() : null;
    renderer = null;
    self.postMessage({ type: 'disposed', id: message.id, info });
    return;
  }
  self.postMessage({ type: 'error', jobId: message.jobId ?? null, name: 'TypeError', message: `unknown Worker message type: ${message.type}` });
});

async function renderProjectJob(message) {
  const jobId = message.jobId ?? `job-${Date.now()}`;
  if (!renderer) {
    self.postMessage({ type: 'error', jobId, name: 'Error', message: 'project export Worker is not initialized' });
    return;
  }
  if (activeJobId !== null) {
    self.postMessage({ type: 'error', jobId, name: 'Error', message: `Worker is busy with ${activeJobId}` });
    return;
  }
  activeJobId = jobId;
  const exportStartedAt = performance.now();
  try {
    const project = message.project || REPRESENTATIVE_PROJECT;
    const result = await renderer.renderProject(project, {
      jobId,
      yieldEveryBlocks: message.yieldEveryBlocks ?? 512,
      captureStems: message.captureStems === true,
      shouldCancel: () => cancelRequests.has(jobId),
      onProgress: progress => self.postMessage({ type: 'progress', ...progress }),
    });
    const wavStartedAt = performance.now();
    const wav = encodeWav16Bit(result.master, result.info.sampleRate);
    const wavEncodeMs = performance.now() - wavStartedAt;
    const floatPcm = message.includeFloatPcm === true ? interleaveFloat32Stereo(result.master) : null;
    const outputHash32 = hashBytes32(wav);
    const exportElapsedMs = performance.now() - exportStartedAt;
    const info = renderer.snapshot();
    const response = {
      type: 'exported',
      jobId,
      output: {
        format: 'WAV/PCM16/stereo',
        sampleRate: result.info.sampleRate,
        frames: result.info.durationFrames,
        bytes: wav.byteLength,
        hash32: outputHash32,
        peak: Math.max(peak(result.master.left), peak(result.master.right)),
        nonFinite: countNonFinite(result.master.left) + countNonFinite(result.master.right),
        floatPcmBytes: floatPcm ? floatPcm.byteLength : 0,
        wavBytes: message.includeWav === true ? wav.buffer : undefined,
        floatPcm: floatPcm ? floatPcm.buffer : undefined,
      },
      metrics: { ...result.metrics, coreRenderMs: result.metrics.elapsedMs, wavEncodeMs, exportElapsedMs },
      memory: info,
    };
    const transfer = [];
    if (message.includeWav === true) transfer.push(wav.buffer);
    if (floatPcm) transfer.push(floatPcm.buffer);
    self.postMessage(response, transfer);
  } catch (error) {
    if (error instanceof ProjectRenderCancelledError || error?.name === 'ProjectRenderCancelledError') {
      self.postMessage({ type: 'cancelled', jobId, memory: renderer.snapshot() });
    } else {
      self.postMessage({ type: 'error', jobId, name: error?.name || 'Error', message: String(error?.message || error), memory: renderer.snapshot() });
    }
  } finally {
    cancelRequests.delete(jobId);
    activeJobId = null;
  }
}

function peak(buffer) {
  let maximum = 0;
  for (let i = 0; i < buffer.length; i++) if (Number.isFinite(buffer[i])) maximum = Math.max(maximum, Math.abs(buffer[i]));
  return maximum;
}

function countNonFinite(buffer) {
  let total = 0;
  for (let i = 0; i < buffer.length; i++) if (!Number.isFinite(buffer[i])) total++;
  return total;
}
