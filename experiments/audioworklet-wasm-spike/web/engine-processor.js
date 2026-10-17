// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// "Single engine" layout: ONE WebAssembly instance (ONE linear memory) per
// AudioWorkletGlobalScope, created lazily at module scope on first use, hosting
// up to 1024 gain->biquad units in a slot table (dsp/gain_biquad_engine.wat).
//
// Why: each WebAssembly.Memory reserves 8 GiB of virtual address space inside
// V8's 1 TiB per-process sandbox, so a renderer can only hold ~125 memories at
// once (REPORT.md §8.3). The per-node layout (gain-filter-processor.js) spends
// one memory per node; this layout spends one per AudioContext.
//
// Two processors are registered so both variants can be measured:
//   'apex-spike-engine-unit' — one AudioWorkletNode per unit; each node owns
//                              one slot in the shared engine (design B).
//   'apex-spike-engine-bank' — one AudioWorkletNode running N units internally
//                              (processorOptions.units), output = mean of units (variant C).
//
// Lifecycle (same message contract as gain-filter-processor.js):
//   constructor : get-or-create the engine, allocate slot(s), configure, post
//                 'ready' or 'init-error' (never throws; a failed processor
//                 outputs silence and holds no slot).
//   'dispose'   : slots are returned to the free list IMMEDIATELY (deterministic;
//                 does not depend on garbage collection of the node).
//   fault       : if process() throws, slots are released before rethrowing.
// Slots are NOT released if a node is dropped without dispose(); the host
// contract requires dispose(). (The engine memory itself lives as long as the
// AudioWorkletGlobalScope, i.e. until the AudioContext is closed/collected.)

const ABI_VERSION = 2;

const hasPerfNow = typeof globalThis.performance === 'object' && typeof globalThis.performance.now === 'function';
const now = hasPerfNow ? () => globalThis.performance.now() : () => Date.now();
const CLOCK = hasPerfNow ? 'performance.now' : 'Date.now';

// ---- module-scope engine (one per AudioWorkletGlobalScope) -----------------
let ENGINE = null;
let engineCreateAttempts = 0;

function getEngine(bytes) {
  if (ENGINE) return ENGINE;
  engineCreateAttempts++;
  if (typeof WebAssembly !== 'object') throw new Error('WebAssembly is not available in AudioWorkletGlobalScope');
  if (!bytes) throw new Error('processorOptions.wasmBytes missing');
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {}); // the ONLY memory in this scope
  const ex = instance.exports;
  if (typeof ex.abi_version !== 'function' || ex.abi_version() !== ABI_VERSION) {
    throw new Error(`WASM ABI mismatch: expected ${ABI_VERSION}`);
  }
  const maxSlots = ex.max_slots();
  const free = [];
  for (let s = maxSlots - 1; s >= 0; s--) free.push(s); // pop() yields 0,1,2,...
  ENGINE = {
    ex,
    maxFrames: ex.max_frames(),
    maxChannels: ex.max_channels(),
    maxSlots,
    inView: new Float32Array(ex.memory.buffer, ex.input_ptr(), ex.max_frames()),
    outView: new Float32Array(ex.memory.buffer, ex.output_ptr(), ex.max_frames()),
    free,
    live: 0,
    peakLive: 0,
  };
  return ENGINE;
}

function allocSlot(e) {
  if (e.free.length === 0) throw new RangeError(`engine slots exhausted (${e.maxSlots} in use)`);
  const s = e.free.pop();
  e.live++;
  if (e.live > e.peakLive) e.peakLive = e.live;
  return s;
}

function freeSlot(e, s) {
  e.ex.reset_slot(s);
  e.free.push(s);
  e.live--;
}

function engineInfo() {
  const e = ENGINE;
  return {
    engineInstancesInScope: e ? 1 : 0,
    engineCreateAttempts,
    liveSlots: e ? e.live : 0,
    peakLiveSlots: e ? e.peakLive : 0,
    maxSlots: e ? e.maxSlots : 0,
    wasmMemoryBytes: e ? e.ex.memory.buffer.byteLength : 0,
  };
}

// ---- shared processor base (stats + message contract) ----------------------
class EngineProcessorBase extends AudioWorkletProcessor {
  constructor(options, unitCount) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.state = 'initializing';
    this.slots = [];
    this.throwNextBlock = false;
    this.lagThresholdMs = Number.isFinite(opts.lagThresholdMs) ? opts.lagThresholdMs : 50;
    this.budgetMs = (128 / sampleRate) * 1000;
    this.resetStats();
    this.port.onmessage = event => this.onMessage(event.data);
    try {
      const n = unitCount(opts);
      if (!(Number.isInteger(n) && n >= 1)) throw new RangeError(`invalid unit count ${n}`);
      const e = getEngine(opts.wasmBytes);
      this.e = e;
      try {
        for (let i = 0; i < n; i++) this.slots.push(allocSlot(e));
        this.applyParams(opts.params);
        for (const s of this.slots) e.ex.reset_slot(s);
      } catch (err) {
        this.releaseSlots(); // all-or-nothing
        throw err;
      }
      this.state = 'ready';
      this.port.postMessage({ type: 'ready', abi: ABI_VERSION, sampleRate, clock: CLOCK, budgetMs: this.budgetMs, units: n, slots: this.slots.slice(0, 4), ...engineInfo() });
    } catch (err) {
      this.state = 'failed';
      this.port.postMessage({ type: 'init-error', name: (err && err.name) || 'Error', message: String((err && err.message) || err), ...engineInfo() });
    }
  }

  releaseSlots() {
    if (this.e) for (const s of this.slots) freeSlot(this.e, s);
    this.slots = [];
  }

  applyParams(p) {
    if (!p || !p.coefficients) throw new Error('params.coefficients missing');
    const c = p.coefficients;
    for (const s of this.slots) {
      const rc = this.e.ex.configure_slot(s, p.gain, c.b0, c.b1, c.b2, c.a1, c.a2);
      if (rc !== 0) throw new Error(`WASM configure_slot rejected parameters (code ${rc})`);
    }
  }

  resetStats() {
    this.stats = {
      blocks: 0, frames: 0, firstCurrentFrame: -1, lastCurrentFrame: -1, frameDiscontinuities: 0,
      procTotalMs: 0, procMaxMs: 0, overBudgetBlocks: 0, refWallMs: 0, refFrames: 0,
      maxLagMs: 0, lagExceedances: 0, lostMs: 0, outPeak: 0, nonFiniteOut: 0, kernelErrors: 0,
    };
  }

  publicStats() {
    const { refWallMs, refFrames, ...rest } = this.stats;
    return { ...rest, procMeanMs: rest.blocks ? rest.procTotalMs / rest.blocks : 0, units: this.slots.length, ...engineInfo() };
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-params':
        if (this.state !== 'ready') return;
        try { this.applyParams(msg.params); this.port.postMessage({ type: 'params-applied' }); }
        catch (err) { this.port.postMessage({ type: 'params-error', message: String(err && err.message) }); }
        break;
      case 'reset-stats': this.resetStats(); this.port.postMessage({ type: 'stats-reset' }); break;
      case 'get-stats': this.port.postMessage({ type: 'stats', state: this.state, clock: CLOCK, budgetMs: this.budgetMs, ...this.publicStats() }); break;
      case 'engine-info': this.port.postMessage({ type: 'engine-info', ...engineInfo() }); break;
      case 'inject-fault': this.throwNextBlock = true; break; // spike-only test hook
      case 'dispose': {
        const final = this.publicStats();
        this.releaseSlots();
        this.state = 'disposed';
        this.port.postMessage({ type: 'disposed', ...final, afterRelease: engineInfo() });
        break;
      }
      default: break;
    }
  }

  // Subclasses implement renderChannel(src, dst, n, s) -> kernel error count.
  process(inputs, outputs) {
    if (this.state !== 'ready') return this.state !== 'disposed';
    try {
      if (this.throwNextBlock) { this.throwNextBlock = false; throw new Error('Injected processor fault (spike test hook)'); }
      const t0 = now();
      const s = this.stats;
      if (s.blocks === 0) { s.firstCurrentFrame = currentFrame; s.refWallMs = Date.now(); s.refFrames = 0; }
      else if (currentFrame !== s.lastCurrentFrame + 128) s.frameDiscontinuities++;
      const input = inputs[0] || [];
      const output = outputs[0] || [];
      const channels = Math.min(output.length, this.e.maxChannels);
      for (let ch = 0; ch < channels; ch++) {
        const dst = output[ch];
        const n = dst.length;
        this.renderChannel(input[ch] || input[0], dst, ch, n, s);
        for (let i = 0; i < n; i++) {
          const v = dst[i];
          if (v !== v || v === Infinity || v === -Infinity) s.nonFiniteOut++;
          else if (v > s.outPeak) s.outPeak = v;
          else if (-v > s.outPeak) s.outPeak = -v;
        }
      }
      const procMs = now() - t0;
      s.blocks++; s.frames += 128; s.lastCurrentFrame = currentFrame;
      s.procTotalMs += procMs;
      if (procMs > s.procMaxMs) s.procMaxMs = procMs;
      if (procMs > this.budgetMs) s.overBudgetBlocks++;
      const nowWall = Date.now();
      const lagMs = (nowWall - s.refWallMs) - ((s.frames - 128 - s.refFrames) / sampleRate) * 1000;
      if (lagMs > s.maxLagMs) s.maxLagMs = lagMs;
      if (lagMs > this.lagThresholdMs) { s.lagExceedances++; s.lostMs += lagMs; s.refWallMs = nowWall; s.refFrames = s.frames - 128; }
      return true;
    } catch (err) {
      // A thrown process() permanently kills this processor ('processorerror').
      // Give its slots back first so the shared engine does not leak capacity.
      this.releaseSlots();
      this.state = 'failed';
      throw err;
    }
  }
}

class EngineUnitProcessor extends EngineProcessorBase {
  constructor(options) { super(options, () => 1); }
  renderChannel(src, dst, ch, n, s) {
    const e = this.e;
    if (src) e.inView.set(src); else e.inView.fill(0, 0, n);
    const rc = e.ex.process_slot(this.slots[0], ch, n);
    if (rc !== 0) { s.kernelErrors++; return; }
    dst.set(e.outView.subarray(0, n));
  }
}

class EngineBankProcessor extends EngineProcessorBase {
  constructor(options) {
    super(options, opts => (opts.units === undefined ? 1 : opts.units));
    this.scale = this.slots.length ? 1 / this.slots.length : 1;
  }
  renderChannel(src, dst, ch, n, s) {
    const e = this.e;
    const inView = e.inView;
    const outView = e.outView;
    dst.fill(0);
    for (let k = 0; k < this.slots.length; k++) {
      // Every unit reads the same input here; a real mixer would feed each its own track.
      if (src) inView.set(src); else inView.fill(0, 0, n);
      const rc = e.ex.process_slot(this.slots[k], ch, n);
      if (rc !== 0) { s.kernelErrors++; continue; }
      for (let i = 0; i < n; i++) dst[i] += outView[i];
    }
    if (this.scale !== 1) for (let i = 0; i < n; i++) dst[i] *= this.scale;
  }
}

registerProcessor('apex-spike-engine-unit', EngineUnitProcessor);
registerProcessor('apex-spike-engine-bank', EngineBankProcessor);
