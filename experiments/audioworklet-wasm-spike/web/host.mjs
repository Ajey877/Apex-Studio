// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// Main-thread lifecycle for the spike processor. Everything that is not
// sample processing stays here: capability detection, module loading,
// parameter calculation, error handling and cleanup.
//
// Contract: createGainFilter() NEVER throws and NEVER leaves a half-built node
// connected. It resolves to either
//   { ok: true,  node, ready, dispose(), getStats(), benchmark(), onFault(cb), setParams() }
//   { ok: false, stage, reason, error? }
// where stage is one of: 'unsupported' | 'worklet-module-load' |
// 'node-construct' | 'wasm-init' | 'timeout'.

export const PROCESSOR_NAME = 'apex-spike-gain-filter';

/** Capability probe. `env` is injectable so unsupported environments can be tested. */
export function detectSupport(env = globalThis) {
  const AudioCtx = env.AudioContext || env.webkitAudioContext;
  const BaseCtx = env.BaseAudioContext;
  const result = {
    audioContext: typeof AudioCtx === 'function',
    offlineAudioContext: typeof env.OfflineAudioContext === 'function',
    audioWorkletNode: typeof env.AudioWorkletNode === 'function',
    audioWorkletOnContext: !!(BaseCtx && BaseCtx.prototype && 'audioWorklet' in BaseCtx.prototype),
    webAssembly: typeof env.WebAssembly === 'object' && env.WebAssembly !== null,
    secureContext: env.isSecureContext !== false,
  };
  result.supported = result.audioWorkletNode && result.audioWorkletOnContext && result.webAssembly;
  if (!result.supported) {
    const missing = [];
    if (!result.audioWorkletNode || !result.audioWorkletOnContext) missing.push('AudioWorklet');
    if (!result.webAssembly) missing.push('WebAssembly');
    result.reason = `Unsupported environment: missing ${missing.join(' and ')}`;
  }
  return result;
}

const moduleLoads = new WeakMap(); // BaseAudioContext -> Map<url, Promise<void>>

function loadWorkletModule(ctx, url) {
  let perCtx = moduleLoads.get(ctx);
  if (!perCtx) { perCtx = new Map(); moduleLoads.set(ctx, perCtx); }
  let p = perCtx.get(url);
  if (!p) {
    p = ctx.audioWorklet.addModule(url);
    perCtx.set(url, p);
    // Allow a retry after failure instead of caching the rejection forever.
    p.catch(() => perCtx.delete(url));
  }
  return p;
}

function errorInfo(err) {
  if (!err) return { name: 'Error', message: 'unknown error' };
  return { name: err.name || 'Error', message: String(err.message || err) };
}

/**
 * @param {BaseAudioContext} ctx
 * @param {{ workletUrl: string|URL, wasmBytes: Uint8Array, params: {gain:number, coefficients:object},
 *           initTimeoutMs?: number, lagThresholdMs?: number, env?: object,
 *           processorName?: string, processorOptions?: object }} options
 *   processorName / processorOptions are spike-investigation hooks for the
 *   single-engine variants (web/engine-processor.js). Defaults keep the
 *   original per-node processor and options unchanged.
 */
export async function createGainFilter(ctx, options) {
  const { workletUrl, wasmBytes, params, initTimeoutMs = 5000, lagThresholdMs = 50, env = globalThis, processorName = PROCESSOR_NAME, processorOptions = {} } = options;
  const support = detectSupport(env);
  if (!support.supported) return { ok: false, stage: 'unsupported', reason: support.reason, support };

  try {
    await loadWorkletModule(ctx, String(workletUrl));
  } catch (err) {
    return { ok: false, stage: 'worklet-module-load', reason: 'AudioWorklet module failed to load', error: errorInfo(err) };
  }

  let node;
  try {
    node = new env.AudioWorkletNode(ctx, processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { ...processorOptions, wasmBytes: wasmBytes.slice(), params, lagThresholdMs },
    });
  } catch (err) {
    return { ok: false, stage: 'node-construct', reason: 'AudioWorkletNode construction failed', error: errorInfo(err) };
  }

  const faultListeners = new Set();
  const pending = new Map(); // reply type -> resolve
  let disposed = false;
  let faulted = null;

  const teardown = () => {
    try { node.disconnect(); } catch { /* already disconnected */ }
    node.port.onmessage = null;
    node.onprocessorerror = null;
    try { node.port.close(); } catch { /* ignore */ }
  };

  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ type: 'timeout' }), initTimeoutMs);
    node.port.onmessage = ev => {
      const msg = ev.data || {};
      if (msg.type === 'ready' || msg.type === 'init-error') {
        clearTimeout(timer);
        resolve(msg);
        return;
      }
      const waiter = pending.get(msg.type);
      if (waiter) { pending.delete(msg.type); waiter(msg); }
    };
    node.onprocessorerror = ev => {
      clearTimeout(timer);
      resolve({ type: 'processorerror', message: (ev && ev.message) || 'processorerror during construction' });
    };
  });

  if (ready.type !== 'ready') {
    teardown();
    if (ready.type === 'timeout') {
      return { ok: false, stage: 'timeout', reason: `Processor did not report ready within ${initTimeoutMs} ms (context state: ${ctx.state})` };
    }
    return {
      ok: false,
      stage: 'wasm-init',
      reason: 'Processor failed to initialise WebAssembly',
      error: { name: ready.name || 'Error', message: ready.message || ready.type },
      detail: ready,
    };
  }

  // Runtime faults: an exception thrown from process() fires 'processorerror'
  // on the node and the engine permanently silences that processor. The host
  // isolates it: disconnect, release the port, notify listeners. Other nodes
  // in the same context keep running.
  node.onprocessorerror = ev => {
    if (faulted) return;
    faulted = { at: ctx.currentTime, message: (ev && ev.message) || 'processorerror' };
    teardown();
    for (const cb of faultListeners) { try { cb(faulted); } catch { /* listener errors are not ours */ } }
  };

  const request = (message, replyType, timeoutMs = 3000) => new Promise(resolve => {
    if (disposed || faulted) { resolve({ type: 'unavailable', reason: disposed ? 'disposed' : 'faulted' }); return; }
    const timer = setTimeout(() => { pending.delete(replyType); resolve({ type: 'timeout' }); }, timeoutMs);
    pending.set(replyType, msg => { clearTimeout(timer); resolve(msg); });
    node.port.postMessage(message);
  });

  return {
    ok: true,
    node,
    ready,
    get faulted() { return faulted; },
    get disposed() { return disposed; },
    onFault(cb) { faultListeners.add(cb); return () => faultListeners.delete(cb); },
    getStats: () => request({ type: 'get-stats' }, 'stats'),
    /** Single-engine processors only; per-node processors never reply (resolves {type:'timeout'}). */
    engineInfo: () => request({ type: 'engine-info' }, 'engine-info', 1000),
    resetStats: () => request({ type: 'reset-stats' }, 'stats-reset'),
    benchmark: blocks => request({ type: 'benchmark', blocks }, 'benchmark-result', 30000),
    setParams: p => request({ type: 'set-params', params: p }, 'params-applied'),
    injectFault: () => { if (!disposed && !faulted) node.port.postMessage({ type: 'inject-fault' }); },
    /** Idempotent. Returns the processor's final stats when it is still reachable. */
    async dispose() {
      if (disposed) return { type: 'already-disposed' };
      let finalStats = { type: 'unavailable' };
      if (!faulted) finalStats = await request({ type: 'dispose' }, 'disposed', 2000);
      disposed = true;
      teardown();
      faultListeners.clear();
      pending.clear();
      return finalStats;
    },
  };
}
