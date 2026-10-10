// Prototype-only multitrack offline renderer. One WASM engine/linear memory is
// reused across all tracks and export jobs. It is a miniature graph, not the
// Apex Studio production exporter or full instrument/effect graph.
import { compileProject, projectInfo, renderTrackSourceChunk, softClip, trackGainAtFrame } from './project-model.mjs';
import { RENDER_QUANTUM } from './reference.mjs';

const WASM_ABI = 2;
const MAX_TRACKS = 64;
const YIELD = () => new Promise(resolve => setTimeout(resolve, 0));

export class ProjectRenderCancelledError extends Error {
  constructor(jobId = null) {
    super(`project export ${jobId ?? ''} cancelled`.trim());
    this.name = 'ProjectRenderCancelledError';
    this.jobId = jobId;
  }
}

export function createProjectRenderer(wasmBytes) {
  if (!(wasmBytes instanceof Uint8Array) && !(wasmBytes instanceof ArrayBuffer)) throw new TypeError('wasmBytes must be a Uint8Array or ArrayBuffer');
  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, {});
  const ex = instance.exports;
  if (typeof ex.abi_version !== 'function' || ex.abi_version() !== WASM_ABI || typeof ex.process_slot !== 'function') {
    throw new Error('project renderer requires the ABI-v2 shared-engine module');
  }
  const memoryBytesAtStart = ex.memory.buffer.byteLength;
  const maxSlots = ex.max_slots();
  if (maxSlots < MAX_TRACKS) throw new Error(`engine exposes ${maxSlots} slots; ${MAX_TRACKS} required`);

  // All scratch memory is lifetime-bounded by the one Worker engine.
  const inputView = new Float32Array(ex.memory.buffer, ex.input_ptr(), ex.max_frames());
  const outputView = new Float32Array(ex.memory.buffer, ex.output_ptr(), ex.max_frames());
  const sourceBlock = new Float32Array(RENDER_QUANTUM);
  const blockBusLeft = [];
  const blockBusRight = [];
  let disposed = false;
  let jobsStarted = 0;
  let jobsCompleted = 0;
  let jobsCancelled = 0;
  let jobsFailed = 0;
  let renderedFrames = 0;
  let lastProjectInfo = null;

  function snapshot() {
    return {
      engineInstances: 1,
      memoryBytes: ex.memory.buffer.byteLength,
      memoryBytesAtStart,
      memoryPages: ex.memory.buffer.byteLength / 65536,
      maxSlots,
      slotsReserved: MAX_TRACKS,
      jobsStarted,
      jobsCompleted,
      jobsCancelled,
      jobsFailed,
      renderedFrames,
      disposed,
      lastProject: lastProjectInfo,
    };
  }

  function prepare(project, { captureStems = false } = {}) {
    if (disposed) throw new Error('project renderer is disposed');
    const compiled = compileProject(project);
    if (compiled.tracks.length > MAX_TRACKS) throw new RangeError(`project has more than ${MAX_TRACKS} tracks`);
    jobsStarted++;
    lastProjectInfo = projectInfo(compiled);
    for (let slot = 0; slot < compiled.tracks.length; slot++) {
      ex.reset_slot(slot);
      const track = compiled.tracks[slot];
      const rc = ex.configure_slot(slot, track.preGain, track.coefficients.b0, track.coefficients.b1,
        track.coefficients.b2, track.coefficients.a1, track.coefficients.a2);
      if (rc !== 0) throw new RangeError(`WASM rejected DSP parameters for track ${track.id} (code ${rc})`);
    }
    while (blockBusLeft.length < compiled.buses.length) {
      blockBusLeft.push(new Float32Array(RENDER_QUANTUM));
      blockBusRight.push(new Float32Array(RENDER_QUANTUM));
    }
    const output = {
      left: new Float32Array(compiled.totalFrames),
      right: new Float32Array(compiled.totalFrames),
    };
    const tracks = captureStems ? compiled.tracks.map(track => ({
      id: track.id,
      left: new Float32Array(compiled.totalFrames),
      right: new Float32Array(compiled.totalFrames),
    })) : [];
    const buses = captureStems ? compiled.buses.map(bus => ({
      id: bus.id,
      left: new Float32Array(compiled.totalFrames),
      right: new Float32Array(compiled.totalFrames),
    })) : [];
    return { compiled, output, tracks, buses, captureStems, startedAt: clockNow(), blocks: 0 };
  }

  function processBlock(state, startFrame, frameCount) {
    const { compiled } = state;
    for (let bus = 0; bus < compiled.buses.length; bus++) {
      blockBusLeft[bus].fill(0, 0, frameCount);
      blockBusRight[bus].fill(0, 0, frameCount);
    }

    for (let trackIndex = 0; trackIndex < compiled.tracks.length; trackIndex++) {
      const track = compiled.tracks[trackIndex];
      renderTrackSourceChunk(track, startFrame, frameCount, compiled.sampleRate, sourceBlock);
      for (let channel = 0; channel < 2; channel++) {
        inputView.set(sourceBlock.subarray(0, frameCount), 0);
        const rc = ex.process_slot(trackIndex, channel, frameCount);
        if (rc !== 0) throw new Error(`WASM process_slot returned ${rc} for ${track.id}/${channel}`);
        const pan = channel === 0 ? track.panLeft : track.panRight;
        const blockBus = channel === 0 ? blockBusLeft : blockBusRight;
        const trackOutput = state.captureStems ? (channel === 0 ? state.tracks[trackIndex].left : state.tracks[trackIndex].right) : null;
        for (let i = 0; i < frameCount; i++) {
          const absoluteFrame = startFrame + i;
          const postFader = outputView[i] * trackGainAtFrame(track, absoluteFrame) * pan;
          if (trackOutput) trackOutput[absoluteFrame] = postFader;
          for (const route of track.routes) {
            blockBus[route.busIndex][i] += postFader * route.gain;
          }
        }
      }
    }

    for (let busIndex = 0; busIndex < compiled.buses.length; busIndex++) {
      const bus = compiled.buses[busIndex];
      const busLeft = blockBusLeft[busIndex];
      const busRight = blockBusRight[busIndex];
      const capturedBus = state.captureStems ? state.buses[busIndex] : null;
      for (let i = 0; i < frameCount; i++) {
        const absoluteFrame = startFrame + i;
        const left = softClip(busLeft[i] * bus.gain, bus.drive);
        const right = softClip(busRight[i] * bus.gain, bus.drive);
        if (capturedBus) {
          capturedBus.left[absoluteFrame] = left;
          capturedBus.right[absoluteFrame] = right;
        }
        state.output.left[absoluteFrame] += left;
        state.output.right[absoluteFrame] += right;
      }
    }
    for (let i = 0; i < frameCount; i++) {
      const absoluteFrame = startFrame + i;
      state.output.left[absoluteFrame] *= compiled.masterGain;
      state.output.right[absoluteFrame] *= compiled.masterGain;
    }
    state.blocks++;
  }

  function resetActiveSlots(trackCount) {
    for (let slot = 0; slot < trackCount; slot++) ex.reset_slot(slot);
  }

  function finish(state) {
    const elapsedMs = Math.max(0, clockNow() - state.startedAt);
    jobsCompleted++;
    renderedFrames += state.compiled.totalFrames;
    resetActiveSlots(state.compiled.tracks.length);
    return {
      info: projectInfo(state.compiled),
      master: state.output,
      tracks: state.tracks,
      buses: state.buses,
      metrics: {
        elapsedMs,
        blocks: state.blocks,
        blockFrames: RENDER_QUANTUM,
        renderedFrames: state.compiled.totalFrames,
        outputBytesFloat32: state.output.left.byteLength + state.output.right.byteLength,
        stageOrder: ['WASM gain+biquad insert', 'sample-accurate fader automation', 'pan', 'track-to-bus routing', 'bus gain+soft clip', 'master sum+gain'],
      },
      memory: snapshot(),
    };
  }

  function fail(state, cancelled) {
    if (state) resetActiveSlots(state.compiled.tracks.length);
    if (cancelled) jobsCancelled++;
    else jobsFailed++;
  }

  function renderProjectSync(project, options = {}) {
    let state = null;
    try {
      state = prepare(project, options);
      for (let start = 0; start < state.compiled.totalFrames; start += RENDER_QUANTUM) {
        processBlock(state, start, Math.min(RENDER_QUANTUM, state.compiled.totalFrames - start));
      }
      return finish(state);
    } catch (error) {
      fail(state, error instanceof ProjectRenderCancelledError);
      throw error;
    }
  }

  async function renderProject(project, options = {}) {
    const { shouldCancel = () => false, onProgress = null, yieldEveryBlocks = 64, jobId = null, captureStems = false } = options;
    let state = null;
    try {
      state = prepare(project, { captureStems });
      let nextProgress = Math.max(1, Math.trunc(yieldEveryBlocks));
      for (let start = 0; start < state.compiled.totalFrames; start += RENDER_QUANTUM) {
        if (shouldCancel()) throw new ProjectRenderCancelledError(jobId);
        processBlock(state, start, Math.min(RENDER_QUANTUM, state.compiled.totalFrames - start));
        if (state.blocks % nextProgress === 0) {
          if (onProgress) onProgress({ jobId, completedFrames: Math.min(start + RENDER_QUANTUM, state.compiled.totalFrames), totalFrames: state.compiled.totalFrames });
          await YIELD(); // let the Worker receive a cooperative cancellation message
          if (shouldCancel()) throw new ProjectRenderCancelledError(jobId);
        }
      }
      return finish(state);
    } catch (error) {
      fail(state, error instanceof ProjectRenderCancelledError);
      throw error;
    }
  }

  function dispose() {
    if (disposed) return snapshot();
    resetActiveSlots(MAX_TRACKS);
    disposed = true;
    return snapshot();
  }

  return { renderProject, renderProjectSync, snapshot, dispose };
}

export function encodeWav16Bit(stereo, sampleRate) {
  const frames = stereo.left.length;
  if (!frames || stereo.right.length !== frames) throw new RangeError('WAV output requires matching non-empty stereo channels');
  const dataBytes = frames * 2 * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, floatToPcm16(stereo.left[i]), true); offset += 2;
    view.setInt16(offset, floatToPcm16(stereo.right[i]), true); offset += 2;
  }
  return bytes;
}

export function decodeWav16Bit(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE' || readAscii(view, 36, 4) !== 'data') {
    throw new TypeError('invalid PCM WAV header');
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  if (channels !== 2 || bitsPerSample !== 16 || dataBytes !== bytes.byteLength - 44 || dataBytes % 4 !== 0) throw new TypeError('unsupported PCM WAV layout');
  const frames = dataBytes / 4;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    left[i] = pcm16ToFloat(view.getInt16(offset, true)); offset += 2;
    right[i] = pcm16ToFloat(view.getInt16(offset, true)); offset += 2;
  }
  return { sampleRate, frames, left, right, dataBytes };
}

export function hashBytes32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function floatToPcm16(value) {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

function pcm16ToFloat(value) { return value < 0 ? value / 32768 : value / 32767; }
function writeAscii(view, offset, text) { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); }
function readAscii(view, offset, length) { let text = ''; for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i)); return text; }
function clockNow() { return globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now(); }
