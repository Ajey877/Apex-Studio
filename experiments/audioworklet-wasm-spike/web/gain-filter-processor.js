// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// AudioWorkletProcessor that runs the gain -> biquad WASM kernel on the audio
// rendering thread. Self-contained on purpose (no imports).
//
// Lifecycle
//   constructor  : compile + instantiate the WASM bytes from processorOptions
//                  synchronously (module is < 1 KB), validate the ABI,
//                  configure parameters, post {type:'ready'} or
//                  {type:'init-error'}. Never throws: a failed processor
//                  outputs silence and stays inert.
//   process()    : copy each input channel into WASM scratch memory, run the
//                  kernel, copy the result out; record timing/overrun stats.
//   'dispose'    : stop processing; process() returns false so the node can
//                  be garbage-collected once the host disconnects it.
//
// No allocation happens in process() (views are created once; the WASM memory
// never grows, so the views never detach).

const PROCESSOR_NAME = 'apex-spike-gain-filter';
const ABI_VERSION = 1;

const hasPerfNow = typeof globalThis.performance === 'object' && typeof globalThis.performance.now === 'function';
const now = hasPerfNow ? () => globalThis.performance.now() : () => Date.now();
const CLOCK = hasPerfNow ? 'performance.now' : 'Date.now';

class ApexSpikeGainFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.state = 'initializing';
    this.throwNextBlock = false;
    this.lagThresholdMs = Number.isFinite(opts.lagThresholdMs) ? opts.lagThresholdMs : 50;
    this.budgetMs = (128 / sampleRate) * 1000;
    this.resetStats();
    this.port.onmessage = event => this.onMessage(event.data);

    try {
      if (typeof WebAssembly !== 'object') {
        throw new Error('WebAssembly is not available in AudioWorkletGlobalScope');
      }
      if (!opts.wasmBytes) throw new Error('processorOptions.wasmBytes missing');
      const module = new WebAssembly.Module(opts.wasmBytes);
      const instance = new WebAssembly.Instance(module, {});
      const ex = instance.exports;
      if (typeof ex.abi_version !== 'function' || ex.abi_version() !== ABI_VERSION) {
        throw new Error(`WASM ABI mismatch: expected ${ABI_VERSION}`);
      }
      this.ex = ex;
      this.maxFrames = ex.max_frames();
      this.maxChannels = ex.max_channels();
      this.inView = new Float32Array(ex.memory.buffer, ex.input_ptr(), this.maxFrames);
      this.outView = new Float32Array(ex.memory.buffer, ex.output_ptr(), this.maxFrames);
      this.applyParams(opts.params);
      ex.reset();
      this.state = 'ready';
      this.port.postMessage({
        type: 'ready',
        abi: ABI_VERSION,
        sampleRate,
        clock: CLOCK,
        budgetMs: this.budgetMs,
      });
    } catch (err) {
      this.state = 'failed';
      this.port.postMessage({
        type: 'init-error',
        name: (err && err.name) || 'Error',
        message: String((err && err.message) || err),
      });
    }
  }

  applyParams(p) {
    if (!p || !p.coefficients) throw new Error('params.coefficients missing');
    const c = p.coefficients;
    const rc = this.ex.configure(p.gain, c.b0, c.b1, c.b2, c.a1, c.a2);
    if (rc !== 0) throw new Error(`WASM configure rejected parameters (code ${rc})`);
  }

  resetStats() {
    this.stats = {
      blocks: 0,
      frames: 0,
      firstCurrentFrame: -1,
      lastCurrentFrame: -1,
      frameDiscontinuities: 0,
      procTotalMs: 0,
      procMaxMs: 0,
      overBudgetBlocks: 0,
      refWallMs: 0,
      refFrames: 0,
      maxLagMs: 0,
      lagExceedances: 0,
      lostMs: 0,
      outPeak: 0,
      nonFiniteOut: 0,
      kernelErrors: 0,
    };
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'set-params':
        if (this.state !== 'ready') return;
        try { this.applyParams(msg.params); this.port.postMessage({ type: 'params-applied' }); }
        catch (err) { this.port.postMessage({ type: 'params-error', message: String(err && err.message) }); }
        break;
      case 'reset-stats':
        this.resetStats();
        this.port.postMessage({ type: 'stats-reset' });
        break;
      case 'get-stats':
        this.port.postMessage({ type: 'stats', state: this.state, clock: CLOCK, budgetMs: this.budgetMs, ...this.publicStats() });
        break;
      case 'inject-fault':
        // Test hook: make the next process() call throw, to exercise the host's
        // 'processorerror' handling. Spike-only; never present in production code.
        this.throwNextBlock = true;
        break;
      case 'benchmark':
        this.port.postMessage({ type: 'benchmark-result', ...this.benchmark(msg.blocks | 0 || 10000) });
        break;
      case 'dispose':
        this.state = 'disposed';
        this.port.postMessage({ type: 'disposed', ...this.publicStats() });
        break;
      default:
        break;
    }
  }

  publicStats() {
    const { refWallMs, refFrames, ...rest } = this.stats;
    return { ...rest, procMeanMs: rest.blocks ? rest.procTotalMs / rest.blocks : 0 };
  }

  /** Pure kernel cost on the audio thread: `blocks` x 2 channels x 128 frames. */
  benchmark(blocks) {
    if (this.state !== 'ready') return { ok: false, reason: `state=${this.state}` };
    let seed = 12345;
    for (let i = 0; i < 128; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      this.inView[i] = (seed / 4294967296) * 2 - 1;
    }
    const t0 = now();
    for (let b = 0; b < blocks; b++) {
      this.ex.process(0, 128);
      this.ex.process(1, 128);
    }
    const elapsedMs = now() - t0;
    this.ex.reset();
    const perBlockMs = elapsedMs / blocks;
    return {
      ok: true,
      clock: CLOCK,
      blocks,
      elapsedMs,
      perBlockUs: perBlockMs * 1000,
      nsPerSample: (perBlockMs * 1e6) / (128 * 2),
      budgetFraction: perBlockMs / this.budgetMs,
    };
  }

  process(inputs, outputs) {
    if (this.state !== 'ready') {
      // Outputs are zero-filled by the engine; stay alive until disposed.
      return this.state !== 'disposed';
    }
    if (this.throwNextBlock) {
      this.throwNextBlock = false;
      throw new Error('Injected processor fault (spike test hook)');
    }

    const t0 = now();
    const s = this.stats;
    if (s.blocks === 0) {
      s.firstCurrentFrame = currentFrame;
      s.refWallMs = Date.now();
      s.refFrames = 0;
    } else if (currentFrame !== s.lastCurrentFrame + 128) {
      s.frameDiscontinuities++;
    }

    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const channels = Math.min(output.length, this.maxChannels);
    for (let ch = 0; ch < channels; ch++) {
      const dst = output[ch];
      const n = dst.length;
      const src = input[ch] || input[0];
      if (src) this.inView.set(src); else this.inView.fill(0, 0, n);
      const rc = this.ex.process(ch, n);
      if (rc !== 0) { s.kernelErrors++; continue; }
      dst.set(this.outView.subarray(0, n));
      for (let i = 0; i < n; i++) {
        const v = dst[i];
        if (v !== v || v === Infinity || v === -Infinity) s.nonFiniteOut++;
        else if (v > s.outPeak) s.outPeak = v;
        else if (-v > s.outPeak) s.outPeak = -v;
      }
    }

    const procMs = now() - t0;
    s.blocks++;
    s.frames += 128;
    s.lastCurrentFrame = currentFrame;
    s.procTotalMs += procMs;
    if (procMs > s.procMaxMs) s.procMaxMs = procMs;
    if (procMs > this.budgetMs) s.overBudgetBlocks++;

    // Render-progress lag: wall time elapsed since the reference point minus
    // audio time rendered since then. Healthy rendering keeps this bounded (it
    // oscillates within the device buffer size). If the audio thread stalls,
    // rendered time falls behind wall time and the lag grows. Each excursion
    // above the threshold counts as one detected dropout/underrun event; the
    // reference is then re-based so later stalls are detected independently.
    const nowWall = Date.now();
    const lagMs = (nowWall - s.refWallMs) - ((s.frames - 128 - s.refFrames) / sampleRate) * 1000;
    if (lagMs > s.maxLagMs) s.maxLagMs = lagMs;
    if (lagMs > this.lagThresholdMs) {
      s.lagExceedances++;
      s.lostMs += lagMs;
      s.refWallMs = nowWall;
      s.refFrames = s.frames - 128;
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, ApexSpikeGainFilterProcessor);
