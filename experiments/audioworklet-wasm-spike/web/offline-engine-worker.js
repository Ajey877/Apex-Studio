// Prototype-only long-lived Worker for serial offline PCM kernel jobs.
// One Worker owns one ABI-v2 WebAssembly engine and one fixed 128 KiB memory;
// repeated render messages reuse slot 0 rather than allocating a memory per job.
// The caller must terminate this Worker when its offline-render batch is complete.
import { createOfflineEngine } from './offline-engine-core.mjs';

let engine = null;

self.onmessage = event => {
  const message = event.data || {};
  const id = message.id;
  try {
    if (message.type === 'init') {
      if (engine) throw new Error('worker engine is already initialized');
      const bytes = message.wasmBytes instanceof Uint8Array
        ? message.wasmBytes
        : new Uint8Array(message.wasmBytes);
      engine = createOfflineEngine(bytes);
      self.postMessage({ id, type: 'ready', info: engine.snapshot() });
      return;
    }
    if (!engine) throw new Error('worker engine is not initialized');
    if (message.type === 'render') {
      const channels = message.channels.map(channel => channel instanceof Float32Array
        ? channel
        : new Float32Array(channel));
      const output = engine.render(channels, message.params);
      self.postMessage({ id, type: 'rendered', channels: output, info: engine.snapshot() }, output.map(c => c.buffer));
      return;
    }
    if (message.type === 'stats') {
      self.postMessage({ id, type: 'stats', info: engine.snapshot() });
      return;
    }
    if (message.type === 'dispose') {
      const info = engine.dispose();
      engine = null;
      self.postMessage({ id, type: 'disposed', info });
      return;
    }
    throw new Error(`unknown worker message type: ${message.type}`);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      name: error && error.name ? error.name : 'Error',
      message: String(error && error.message ? error.message : error),
    });
  }
};
