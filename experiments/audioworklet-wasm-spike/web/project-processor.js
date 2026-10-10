// Prototype-only multitrack AudioWorklet mixer. One shared WASM instance/memory
// owns one gain+biquad slot per track. Source buffers are scheduled by the test
// harness; this processor performs track DSP, automation, pan, routing, buses,
// master mix and live control updates. Not used by production Apex Studio.
import { compileProject, automationAtFrame, softClip } from './project-model.mjs';
import { biquadLowpass, RENDER_QUANTUM } from './reference.mjs';

const ABI_VERSION = 2;
const clockHasPrecision = typeof globalThis.performance === 'object' && typeof globalThis.performance.now === 'function';
const now = clockHasPrecision ? () => globalThis.performance.now() : () => Date.now();
const CLOCK = clockHasPrecision ? 'performance.now' : 'Date.now';

class ProjectEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.state = 'initializing';
    this.engine = null;
    this.slots = [];
    this.port.onmessage = event => this.onMessage(event.data);
    const opts = options?.processorOptions || {};
    try {
      this.project = compileProject(opts.project);
      if (this.project.sampleRate !== sampleRate) throw new Error(`project sample rate ${this.project.sampleRate} != AudioContext ${sampleRate}`);
      if (!opts.wasmBytes) throw new Error('processorOptions.wasmBytes missing');
      const module = new WebAssembly.Module(opts.wasmBytes);
      const instance = new WebAssembly.Instance(module, {});
      const ex = instance.exports;
      if (typeof ex.abi_version !== 'function' || ex.abi_version() !== ABI_VERSION) throw new Error(`WASM ABI mismatch: expected ${ABI_VERSION}`);
      this.engine = {
        ex,
        memoryBytes: ex.memory.buffer.byteLength,
        maxSlots: ex.max_slots(),
        input: new Float32Array(ex.memory.buffer, ex.input_ptr(), ex.max_frames()),
        output: new Float32Array(ex.memory.buffer, ex.output_ptr(), ex.max_frames()),
      };
      if (this.project.tracks.length > this.engine.maxSlots) throw new Error('not enough shared-engine slots for project tracks');
      for (let index = 0; index < this.project.tracks.length; index++) {
        const track = this.project.tracks[index];
        const rc = ex.configure_slot(index, track.preGain, track.coefficients.b0, track.coefficients.b1,
          track.coefficients.b2, track.coefficients.a1, track.coefficients.a2);
        if (rc !== 0) throw new Error(`WASM rejected controls for ${track.id} (code ${rc})`);
        ex.reset_slot(index);
        this.slots.push(index);
      }
      this.controls = this.project.tracks.map(track => ({ fader: track.fader, preGain: track.preGain, cutoffHz: track.cutoffHz, q: track.q }));
      this.busIndex = new Map(this.project.buses.map((bus, index) => [bus.id, index]));
      this.routeIndices = this.project.tracks.map(track => track.routes.map(route => ({ index: this.busIndex.get(route.busId), gain: route.gain })));
      this.trackBlockLeft = this.project.tracks.map(() => new Float32Array(RENDER_QUANTUM));
      this.trackBlockRight = this.project.tracks.map(() => new Float32Array(RENDER_QUANTUM));
      this.busBlockLeft = this.project.buses.map(() => new Float32Array(RENDER_QUANTUM));
      this.busBlockRight = this.project.buses.map(() => new Float32Array(RENDER_QUANTUM));
      this.startFrame = Math.max(0, Math.trunc(opts.startFrame || 0));
      this.captureFrames = Math.max(0, Math.trunc(opts.captureFrames || 0));
      this.capturedFrames = 0;
      this.captureSent = false;
      this.capture = opts.captureStems === true && this.captureFrames > 0 ? makeCapture(this.project, this.captureFrames) : null;
      this.budgetMs = (RENDER_QUANTUM / sampleRate) * 1000;
      this.blockTimes = new Float32Array(20000);
      this.resetStats();
      this.state = 'ready';
      this.port.postMessage({ type: 'ready', info: this.publicStats() });
    } catch (error) {
      this.releaseSlots();
      this.state = 'failed';
      this.port.postMessage({ type: 'init-error', name: error?.name || 'Error', message: String(error?.message || error), info: this.publicStats() });
    }
  }

  resetStats() {
    this.blocks = 0;
    this.frames = 0;
    this.firstCurrentFrame = -1;
    this.lastCurrentFrame = -1;
    this.frameDiscontinuities = 0;
    this.startupFrameDiscontinuities = 0;
    this.frameDiscontinuityEvents = [];
    this.overBudgetBlocks = 0;
    this.procTotalMs = 0;
    this.procMaxMs = 0;
    this.nonFiniteOutput = 0;
    this.kernelErrors = 0;
    this.capturedFrames = 0;
    this.startedWallMs = Date.now();
  }

  publicStats() {
    const values = Array.from(this.blockTimes.subarray(0, Math.min(this.blocks, this.blockTimes.length))).sort((a, b) => a - b);
    const percentile = p => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : 0;
    return {
      state: this.state,
      sampleRate: typeof sampleRate === 'number' ? sampleRate : 0,
      quantumFrames: RENDER_QUANTUM,
      budgetMs: this.budgetMs || 0,
      clock: CLOCK,
      engineInstances: this.engine ? 1 : 0,
      wasmMemoryBytes: this.engine?.ex.memory.buffer.byteLength || 0,
      wasmMemoryBytesAtStart: this.engine?.memoryBytes || 0,
      slotsInUse: this.slots.length,
      slotIds: this.slots.slice(),
      blocks: this.blocks,
      frames: this.frames,
      frameDiscontinuities: this.frameDiscontinuities,
      startupFrameDiscontinuities: this.startupFrameDiscontinuities,
      frameDiscontinuityEvents: this.frameDiscontinuityEvents.slice(),
      missedDeadlines: this.overBudgetBlocks,
      overBudgetBlocks: this.overBudgetBlocks,
      procMeanMs: this.blocks ? this.procTotalMs / this.blocks : 0,
      procP50Ms: percentile(0.50),
      procP95Ms: percentile(0.95),
      procP99Ms: percentile(0.99),
      procMaxMs: this.procMaxMs,
      nonFiniteOutput: this.nonFiniteOutput,
      kernelErrors: this.kernelErrors,
      captureFrames: this.captureFrames,
      capturedFrames: this.capturedFrames,
      wallElapsedMs: Date.now() - (this.startedWallMs || Date.now()),
    };
  }

  releaseSlots() {
    if (this.engine) for (const slot of this.slots) this.engine.ex.reset_slot(slot);
    this.slots = [];
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'get-stats') {
      this.port.postMessage({ type: 'stats', info: this.publicStats() });
      return;
    }
    if (message.type === 'set-controls') {
      if (this.state !== 'ready') {
        this.port.postMessage({ type: 'controls-error', trackId: message.trackId, message: `processor state is ${this.state}` });
        return;
      }
      const index = this.project.tracks.findIndex(track => track.id === message.trackId);
      if (index < 0) {
        this.port.postMessage({ type: 'controls-error', trackId: message.trackId, message: 'unknown track id' });
        return;
      }
      try {
        const track = this.project.tracks[index];
        const old = { ...this.controls[index] };
        const patch = message.patch || {};
        const next = { ...old };
        for (const key of ['fader', 'preGain', 'cutoffHz', 'q']) if (Object.hasOwn(patch, key)) next[key] = Number(patch[key]);
        if (![next.fader, next.preGain, next.cutoffHz, next.q].every(Number.isFinite)
          || next.fader < 0 || next.fader > 4 || Math.abs(next.preGain) > 16
          || next.cutoffHz <= 0 || next.cutoffHz >= sampleRate / 2 || next.q <= 0) throw new RangeError('control value out of range');
        const coefficients = biquadLowpass(next.cutoffHz, next.q, sampleRate);
        const rc = this.engine.ex.configure_slot(index, next.preGain, coefficients.b0, coefficients.b1,
          coefficients.b2, coefficients.a1, coefficients.a2);
        if (rc !== 0) throw new RangeError(`WASM configure_slot returned ${rc}`);
        this.controls[index] = next;
        this.port.postMessage({ type: 'controls-applied', trackId: message.trackId, old, controls: next, frame: currentFrame });
      } catch (error) {
        this.port.postMessage({ type: 'controls-error', trackId: message.trackId, message: String(error?.message || error) });
      }
      return;
    }
    if (message.type === 'dispose') {
      const before = this.publicStats();
      this.releaseSlots();
      this.state = 'disposed';
      this.port.postMessage({ type: 'disposed', before, after: this.publicStats() });
    }
  }

  process(inputs, outputs) {
    if (this.state !== 'ready') return this.state !== 'disposed';
    const output = outputs[0] || [];
    const frames = output[0]?.length || RENDER_QUANTUM;
    for (const channel of output) channel.fill(0);
    const t0 = now();
    if (this.firstCurrentFrame < 0) this.firstCurrentFrame = currentFrame;
    else if (currentFrame !== this.lastCurrentFrame + frames) {
      const expectedFrame = this.lastCurrentFrame + frames;
      const overlapsProject = expectedFrame < this.startFrame + this.captureFrames && currentFrame + frames > this.startFrame;
      if (overlapsProject) {
        this.frameDiscontinuities++;
        if (this.frameDiscontinuityEvents.length < 16) this.frameDiscontinuityEvents.push({ expectedFrame, actualFrame: currentFrame, deltaFrames: currentFrame - expectedFrame, overlapsProject: true });
      } else {
        this.startupFrameDiscontinuities++;
      }
    }
    for (let bus = 0; bus < this.project.buses.length; bus++) {
      this.busBlockLeft[bus].fill(0, 0, frames);
      this.busBlockRight[bus].fill(0, 0, frames);
    }

    for (let trackIndex = 0; trackIndex < this.project.tracks.length; trackIndex++) {
      const track = this.project.tracks[trackIndex];
      const inputChannels = inputs[trackIndex] || [];
      const source = inputChannels[0] || null; // fixture sources are mono buffers
      const post = [this.trackBlockLeft[trackIndex], this.trackBlockRight[trackIndex]];
      const pan = [track.panLeft, track.panRight];
      for (let channel = 0; channel < 2; channel++) {
        if (source) this.engine.input.set(source.subarray(0, frames), 0);
        else this.engine.input.fill(0, 0, frames);
        const rc = this.engine.ex.process_slot(this.slots[trackIndex], channel, frames);
        if (rc !== 0) { this.kernelErrors++; post[channel].fill(0, 0, frames); continue; }
        const filtered = this.engine.output;
        const busBlocks = channel === 0 ? this.busBlockLeft : this.busBlockRight;
        for (let i = 0; i < frames; i++) {
          const projectFrame = Math.max(0, currentFrame + i - this.startFrame);
          const automated = automationAtFrame(track.automation, projectFrame);
          const sample = filtered[i] * this.controls[trackIndex].fader * automated * pan[channel];
          post[channel][i] = sample;
          const routes = this.routeIndices[trackIndex];
          for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
            const route = routes[routeIndex];
            busBlocks[route.index][i] += sample * route.gain;
          }
        }
      }
    }

    for (let busIndex = 0; busIndex < this.project.buses.length; busIndex++) {
      const bus = this.project.buses[busIndex];
      const left = this.busBlockLeft[busIndex];
      const right = this.busBlockRight[busIndex];
      for (let i = 0; i < frames; i++) {
        left[i] = softClip(left[i] * bus.gain, bus.drive);
        right[i] = softClip(right[i] * bus.gain, bus.drive);
      }
    }
    if (output.length >= 2) {
      for (let i = 0; i < frames; i++) {
        let left = 0;
        let right = 0;
        for (let bus = 0; bus < this.project.buses.length; bus++) {
          left += this.busBlockLeft[bus][i];
          right += this.busBlockRight[bus][i];
        }
        output[0][i] = left * this.project.masterGain;
        output[1][i] = right * this.project.masterGain;
      }
    }

    const relativeStart = currentFrame - this.startFrame;
    if (this.capture && !this.captureSent && relativeStart < this.captureFrames && relativeStart + frames > 0) {
      const begin = Math.max(0, -relativeStart);
      const end = Math.min(frames, this.captureFrames - relativeStart);
      for (let i = begin; i < end; i++) {
        const relativeFrame = relativeStart + i;
        for (let track = 0; track < this.project.tracks.length; track++) {
          this.capture.tracks[track].left[relativeFrame] = this.trackBlockLeft[track][i];
          this.capture.tracks[track].right[relativeFrame] = this.trackBlockRight[track][i];
        }
        for (let bus = 0; bus < this.project.buses.length; bus++) {
          this.capture.buses[bus].left[relativeFrame] = this.busBlockLeft[bus][i];
          this.capture.buses[bus].right[relativeFrame] = this.busBlockRight[bus][i];
        }
        this.capture.master.left[relativeFrame] = output[0]?.[i] || 0;
        this.capture.master.right[relativeFrame] = output[1]?.[i] || 0;
        this.capturedFrames++;
      }
      if (this.capturedFrames >= this.captureFrames) this.sendCapture();
    }

    for (const channel of output) {
      for (let i = 0; i < frames; i++) if (!Number.isFinite(channel[i])) this.nonFiniteOutput++;
    }
    const elapsed = Math.max(0, now() - t0);
    if (this.blocks < this.blockTimes.length) this.blockTimes[this.blocks] = elapsed;
    this.blocks++;
    this.frames += frames;
    this.lastCurrentFrame = currentFrame;
    this.procTotalMs += elapsed;
    if (elapsed > this.procMaxMs) this.procMaxMs = elapsed;
    if (elapsed > this.budgetMs) this.overBudgetBlocks++;
    return true;
  }

  sendCapture() {
    if (!this.capture || this.captureSent) return;
    this.captureSent = true;
    const info = this.publicStats();
    const transfer = [];
    const addStereo = stereo => { transfer.push(stereo.left.buffer, stereo.right.buffer); };
    for (const track of this.capture.tracks) addStereo(track);
    for (const bus of this.capture.buses) addStereo(bus);
    addStereo(this.capture.master);
    this.port.postMessage({ type: 'capture-complete', capture: this.capture, info }, transfer);
  }
}

function makeCapture(project, frames) {
  return {
    tracks: project.tracks.map(track => ({ id: track.id, left: new Float32Array(frames), right: new Float32Array(frames) })),
    buses: project.buses.map(bus => ({ id: bus.id, left: new Float32Array(frames), right: new Float32Array(frames) })),
    master: { left: new Float32Array(frames), right: new Float32Array(frames) },
  };
}

registerProcessor('apex-spike-project-engine', ProjectEngineProcessor);
