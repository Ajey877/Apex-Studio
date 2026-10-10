// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// Independent JavaScript reference for the WASM kernel, plus the deterministic
// test vector. Used unchanged by Node tests, the browser harness and Electron.
//
// Determinism rules:
//  * The test input uses only integer/float arithmetic (LCG noise, saw, square,
//    impulses, silence). It never calls Math.sin/cos, whose results are not
//    guaranteed identical across JS engines.
//  * Test-vector filter coefficients are pinned as exact doubles (TEST_VECTOR)
//    instead of being recomputed with Math.cos/sin on each platform.

export const ABI_VERSION = 1;
export const RENDER_QUANTUM = 128;

/** Pinned configuration for the golden test vector (48 kHz, 1 s, stereo). */
export const TEST_VECTOR = Object.freeze({
  sampleRate: 48000,
  frames: 48000,
  channels: 2,
  gain: 0.7071067811865476, // -3.01 dB
  // RBJ low-pass, fc = 1200 Hz, Q = 0.7071067811865476, fs = 48000 Hz.
  // Pinned literally; `biquadLowpass(1200, Math.SQRT1_2, 48000)` must agree
  // within 1e-12 on every platform (checked by tests, not assumed).
  coefficients: Object.freeze({
    b0: 0.0055427172102806635,
    b1: 0.011085434420561327,
    b2: 0.0055427172102806635,
    a1: -1.778631777824585,
    a2: 0.8008026466657077,
  }),
  // Numerical tolerance for WASM-vs-reference comparison (max |difference|).
  // Both sides perform the same IEEE-754 f64 operations in the same order and
  // round once to f32, so the expected difference is exactly 0. The tolerance
  // (1e-6 ~ -120 dBFS) only exists to give a meaningful failure message.
  tolerance: 1e-6,
});

/** RBJ Audio EQ Cookbook low-pass coefficients, normalised by a0. */
export function biquadLowpass(cutoffHz, q, sampleRate) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Deterministic stereo test signal as Float32Arrays. Sections:
 *  0.00–0.25 s  LCG white noise (different seed per channel)
 *  0.25–0.50 s  naive saw (ch0 220 Hz-ish, ch1 330 Hz-ish) via integer phase
 *  0.50–0.70 s  square wave with ±0.9 amplitude (clipping-adjacent levels)
 *  0.70–0.75 s  impulse train every 480 samples
 *  0.75–1.00 s  digital silence (exercises the filter tail + denormal flush)
 */
export function generateTestSignal(frames = TEST_VECTOR.frames, channels = TEST_VECTOR.channels) {
  const out = [];
  for (let ch = 0; ch < channels; ch++) {
    const data = new Float32Array(frames);
    let seed = (0x1234567 + ch * 0x9e3779b) >>> 0;
    const sawPeriod = ch === 0 ? 218 : 145;
    const sqPeriod = ch === 0 ? 96 : 120;
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      let v;
      if (t < 0.25) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        v = (seed / 4294967296) * 2 - 1;
      } else if (t < 0.5) {
        v = ((i % sawPeriod) / sawPeriod) * 2 - 1;
      } else if (t < 0.7) {
        v = (i % sqPeriod) < sqPeriod / 2 ? 0.9 : -0.9;
      } else if (t < 0.75) {
        v = i % 480 === 0 ? 1 : 0;
      } else {
        v = 0;
      }
      data[i] = v;
    }
    out.push(data);
  }
  return out;
}

/** Independent float64 reference of the WASM kernel (same op order, same flush). */
export function referenceProcess(input, gain, c) {
  const out = new Float32Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] * gain; // input[i] is an f32 value read as f64 (exact promotion)
    const y = c.b0 * x + z1;
    z1 = (c.b1 * x - c.a1 * y) + z2;
    z2 = c.b2 * x - c.a2 * y;
    if (Math.abs(z1) < 1e-30) z1 = 0;
    if (Math.abs(z2) < 1e-30) z2 = 0;
    out[i] = y; // Float32Array store == round-to-nearest-even demotion
  }
  return out;
}

export function compareBuffers(actual, expected) {
  if (actual.length !== expected.length) {
    return { lengthMatch: false, maxAbsDiff: Infinity, maxAbsDiffIndex: -1, mismatches: actual.length, bitExact: false };
  }
  let maxAbsDiff = 0;
  let maxAbsDiffIndex = -1;
  let mismatches = 0;
  let nonFinite = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!Number.isFinite(actual[i])) nonFinite++;
    const d = Math.abs(actual[i] - expected[i]);
    if (actual[i] !== expected[i]) mismatches++;
    if (d > maxAbsDiff || Number.isNaN(d)) {
      maxAbsDiff = Number.isNaN(d) ? Infinity : d;
      maxAbsDiffIndex = i;
    }
  }
  return { lengthMatch: true, maxAbsDiff, maxAbsDiffIndex, mismatches, nonFinite, bitExact: mismatches === 0 };
}

export function signalStats(data) {
  let peak = 0;
  let sumSq = 0;
  let nonFinite = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, data.length)), nonFinite };
}

/** SHA-256 over the little-endian f32 bytes of all channels (ch0 then ch1 ...). */
export async function sha256OfChannels(channels) {
  const total = channels.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of channels) {
    bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off);
    off += c.byteLength;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run the WASM kernel directly (no AudioWorklet) in render-quantum-sized
 * blocks, exactly as the processor does. Works in Node and on a page's main thread.
 */
export function wasmProcessDirect(exportsObj, input, gain, c, blockSize = RENDER_QUANTUM) {
  const ex = exportsObj;
  if (ex.configure(gain, c.b0, c.b1, c.b2, c.a1, c.a2) !== 0) throw new Error('configure rejected parameters');
  ex.reset();
  const max = ex.max_frames();
  const inView = new Float32Array(ex.memory.buffer, ex.input_ptr(), max);
  const outView = new Float32Array(ex.memory.buffer, ex.output_ptr(), max);
  const out = input.map(ch => new Float32Array(ch.length));
  const frames = input[0].length;
  for (let start = 0; start < frames; start += blockSize) {
    const n = Math.min(blockSize, frames - start);
    for (let ch = 0; ch < input.length; ch++) {
      inView.set(input[ch].subarray(start, start + n));
      const rc = ex.process(ch, n);
      if (rc !== 0) throw new Error(`process returned ${rc}`);
      out[ch].set(outView.subarray(0, n), start);
    }
  }
  return out;
}

/**
 * Run ONE slot of the single-engine kernel (dsp/gain_biquad_engine.wat, ABI v2)
 * directly, in render-quantum-sized blocks. Works in Node and on a page's main thread.
 */
export function engineProcessDirect(ex, input, gain, c, slot = 0, blockSize = RENDER_QUANTUM) {
  if (ex.configure_slot(slot, gain, c.b0, c.b1, c.b2, c.a1, c.a2) !== 0) throw new Error('configure_slot rejected parameters');
  if (ex.reset_slot(slot) !== 0) throw new Error('reset_slot rejected slot');
  const max = ex.max_frames();
  const inView = new Float32Array(ex.memory.buffer, ex.input_ptr(), max);
  const outView = new Float32Array(ex.memory.buffer, ex.output_ptr(), max);
  const out = input.map(ch => new Float32Array(ch.length));
  const frames = input[0].length;
  for (let start = 0; start < frames; start += blockSize) {
    const n = Math.min(blockSize, frames - start);
    for (let ch = 0; ch < input.length; ch++) {
      inView.set(input[ch].subarray(start, start + n));
      const rc = ex.process_slot(slot, ch, n);
      if (rc !== 0) throw new Error(`process_slot returned ${rc}`);
      out[ch].set(outView.subarray(0, n), start);
    }
  }
  return out;
}
