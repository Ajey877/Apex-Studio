// Experimental offline-kernel core. One long-lived Worker owns one shared-engine
// instance and reuses it for serial PCM jobs. This deliberately avoids creating an
// AudioWorklet/WASM memory for every OfflineAudioContext. It is NOT a complete
// offline-export pipeline and is not imported by production code.
import { engineProcessDirect } from './reference.mjs';

const ABI_VERSION = 2;
const SLOT = 0;

export function createOfflineEngine(wasmBytes) {
  if (!(wasmBytes instanceof Uint8Array) && !(wasmBytes instanceof ArrayBuffer)) {
    throw new TypeError('wasmBytes must be a Uint8Array or ArrayBuffer');
  }
  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, {});
  const ex = instance.exports;
  if (typeof ex.abi_version !== 'function' || ex.abi_version() !== ABI_VERSION) {
    throw new Error(`WASM ABI mismatch: expected ${ABI_VERSION}`);
  }
  if (!ex.memory || typeof ex.process_slot !== 'function' || ex.max_slots() < 1) {
    throw new Error('WASM engine exports are incomplete');
  }

  const memoryBytesAtStart = ex.memory.buffer.byteLength;
  let renderJobs = 0;
  let disposed = false;

  function snapshot() {
    return {
      engineInstances: 1,
      memoryBytes: ex.memory.buffer.byteLength,
      memoryBytesAtStart,
      maxSlots: ex.max_slots(),
      renderJobs,
      disposed,
    };
  }

  function render(channels, params) {
    if (disposed) throw new Error('offline engine is disposed');
    if (!Array.isArray(channels) || channels.length !== 2
      || channels.some(channel => !(channel instanceof Float32Array))) {
      throw new TypeError('render expects exactly two Float32Array channels');
    }
    if (channels[0].length === 0 || channels[0].length !== channels[1].length) {
      throw new RangeError('render channels must have the same non-zero frame count');
    }
    if (!params || !params.coefficients) throw new TypeError('render params.coefficients is required');

    // engineProcessDirect reconfigures and resets the slot on each job, so state
    // cannot bleed from one independent offline render into the next.
    const output = engineProcessDirect(ex, channels, params.gain, params.coefficients, SLOT);
    renderJobs++;
    return output;
  }

  function dispose() {
    if (disposed) return snapshot();
    ex.reset_slot(SLOT);
    disposed = true;
    return snapshot();
  }

  return { render, snapshot, dispose };
}
