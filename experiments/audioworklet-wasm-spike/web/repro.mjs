// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// Minimal reproduction probes for the "Cannot allocate Wasm memory" failure.
// No AudioWorklet, no audio, no spike kernel: only WebAssembly.Memory objects
// and hand-assembled modules, so each variable can be isolated.

// --- hand-assembled modules (validated by tests before use) ----------------
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/** (module) — no memory at all */
export const MODULE_NO_MEMORY = new Uint8Array(HEADER);
/** (module (memory 1)) — defines its own 1-page memory */
export const MODULE_OWN_MEMORY = new Uint8Array([...HEADER, 0x05, 0x03, 0x01, 0x00, 0x01]);
/** (module (import "env" "memory" (memory 1))) — imports a memory */
export const MODULE_IMPORTS_MEMORY = new Uint8Array([
  ...HEADER, 0x02, 0x0f, 0x01,
  0x03, 0x65, 0x6e, 0x76, // "env"
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, // "memory"
  0x02, 0x00, 0x01, // memory, no maximum, initial 1
]);

const errText = e => `${e && e.name}: ${e && e.message}`;

/** Create objects with `make()` until failure or `limit`. Keeps them alive in `keep`. */
function countUntilFailure(make, limit, keep) {
  let error = null;
  for (let i = 0; i < limit; i++) {
    try { keep.push(make(i)); } catch (e) { error = errText(e); break; }
  }
  return { created: keep.length, error };
}

globalThis.__reproKeep = [];

/** Probe one configuration. Objects stay alive until releaseAll(). */
export function probe(kind, limit = 2000) {
  const keep = [];
  globalThis.__reproKeep.push(keep);
  switch (kind) {
    case 'memory-1page':
      return { kind, ...countUntilFailure(() => new WebAssembly.Memory({ initial: 1 }), limit, keep) };
    case 'memory-1page-max1':
      return { kind, ...countUntilFailure(() => new WebAssembly.Memory({ initial: 1, maximum: 1 }), limit, keep) };
    case 'memory-shared-max1': {
      try { new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); }
      catch (e) { return { kind, created: 0, error: `shared memory unavailable: ${errText(e)}` }; }
      return { kind, ...countUntilFailure(() => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), limit, keep) };
    }
    case 'memory64-1page': {
      try { new WebAssembly.Memory({ initial: 1n, address: 'i64' }); }
      catch (e) { return { kind, created: 0, error: `memory64 unavailable: ${errText(e)}` }; }
      return { kind, ...countUntilFailure(() => new WebAssembly.Memory({ initial: 1n, address: 'i64' }), limit, keep) };
    }
    case 'instance-no-memory': {
      const m = new WebAssembly.Module(MODULE_NO_MEMORY);
      return { kind, ...countUntilFailure(() => new WebAssembly.Instance(m, {}), limit, keep) };
    }
    case 'instance-own-memory': {
      const m = new WebAssembly.Module(MODULE_OWN_MEMORY);
      return { kind, ...countUntilFailure(() => new WebAssembly.Instance(m, {}), limit, keep) };
    }
    case 'instance-imports-one-shared-memory': {
      const m = new WebAssembly.Module(MODULE_IMPORTS_MEMORY);
      const memory = new WebAssembly.Memory({ initial: 1 });
      keep.push(memory);
      const r = countUntilFailure(() => new WebAssembly.Instance(m, { env: { memory } }), limit, keep);
      return { kind, created: r.created - 1, error: r.error, memories: 1 };
    }
    case 'arraybuffer-64k':
      return { kind, ...countUntilFailure(() => new ArrayBuffer(65536), limit, keep) };
    default:
      throw new Error(`unknown probe ${kind}`);
  }
}

/** Drop every reference created by earlier probes; optionally force a full GC. */
export async function releaseAll({ forceGc = false } = {}) {
  const dropped = globalThis.__reproKeep.reduce((n, k) => n + k.length, 0);
  globalThis.__reproKeep = [];
  let gcRan = false;
  if (forceGc && typeof globalThis.gc === 'function') {
    globalThis.gc(); globalThis.gc(); gcRan = true;
  }
  await new Promise(r => setTimeout(r, 200));
  return { dropped, gcAvailable: typeof globalThis.gc === 'function', gcRan };
}

export function validateProbeModules() {
  return {
    noMemory: WebAssembly.validate(MODULE_NO_MEMORY),
    ownMemory: WebAssembly.validate(MODULE_OWN_MEMORY),
    importsMemory: WebAssembly.validate(MODULE_IMPORTS_MEMORY),
  };
}
