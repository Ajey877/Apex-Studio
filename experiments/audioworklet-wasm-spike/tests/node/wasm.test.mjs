// Node-level tests of the WASM kernel itself (no browser, no AudioWorklet).
// Scope: numerical parity + ABI/error behaviour. This proves nothing about
// real-time behaviour or browser support; those are covered by the browser
// and Electron harness runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TEST_VECTOR as TV, biquadLowpass, compareBuffers, generateTestSignal, referenceProcess,
  sha256OfChannels, wasmProcessDirect,
} from '../../web/reference.mjs';
import { WASM_SHA256, wasmBytes } from '../../web/wasm-bytes.mjs';
import { REFERENCE_SHA256 } from '../../web/golden.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmFile = readFileSync(join(root, 'dsp', 'gain_biquad.wasm'));

async function instantiate() {
  const { instance } = await WebAssembly.instantiate(wasmFile, {});
  return instance.exports;
}

test('committed .wasm and embedded bytes are a reproducible build of the .wat source', () => {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'build-wasm.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(out, /reproducible/);
  assert.deepEqual(Buffer.from(wasmBytes()), wasmFile, 'web/wasm-bytes.mjs embeds the same bytes as dsp/gain_biquad.wasm');
});

test('module exposes ABI v1 with fixed, non-growing memory and no imports', async () => {
  const mod = new WebAssembly.Module(wasmFile);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const ex = await instantiate();
  assert.equal(ex.abi_version(), 1);
  assert.equal(ex.max_frames(), 4096);
  assert.equal(ex.max_channels(), 2);
  assert.equal(ex.memory.buffer.byteLength, 65536);
  assert.ok(ex.output_ptr() >= ex.input_ptr() + 4096 * 4, 'scratch regions do not overlap');
  assert.match(WASM_SHA256, /^[0-9a-f]{64}$/);
});

test('golden reference hash is stable (pure-JS reference)', async () => {
  const ref = generateTestSignal().map(ch => referenceProcess(ch, TV.gain, TV.coefficients));
  assert.equal(await sha256OfChannels(ref), REFERENCE_SHA256);
});

test('pinned test-vector coefficients agree with RBJ formula within 1e-12', () => {
  const c = biquadLowpass(1200, Math.SQRT1_2, TV.sampleRate);
  for (const k of Object.keys(c)) assert.ok(Math.abs(c[k] - TV.coefficients[k]) <= 1e-12, k);
});

test('WASM output matches independent JS reference within tolerance (expected bit-exact)', async () => {
  const ex = await instantiate();
  const input = generateTestSignal();
  const out = wasmProcessDirect(ex, input, TV.gain, TV.coefficients);
  for (let ch = 0; ch < input.length; ch++) {
    const cmp = compareBuffers(out[ch], referenceProcess(input[ch], TV.gain, TV.coefficients));
    assert.ok(cmp.maxAbsDiff <= TV.tolerance, `ch${ch} maxAbsDiff ${cmp.maxAbsDiff}`);
    assert.equal(cmp.nonFinite, 0);
    console.log(`  ch${ch}: maxAbsDiff=${cmp.maxAbsDiff} mismatches=${cmp.mismatches}/${out[ch].length} bitExact=${cmp.bitExact}`);
  }
  assert.equal(await sha256OfChannels(out), REFERENCE_SHA256, 'WASM output is bit-identical to the reference');
});

test('block size does not change the result (state carried across blocks)', async () => {
  const ex = await instantiate();
  const input = generateTestSignal();
  const a = wasmProcessDirect(ex, input, TV.gain, TV.coefficients, 128);
  const b = wasmProcessDirect(ex, input, TV.gain, TV.coefficients, 4096);
  const c = wasmProcessDirect(ex, input, TV.gain, TV.coefficients, 37);
  assert.equal(await sha256OfChannels(a), await sha256OfChannels(b));
  assert.equal(await sha256OfChannels(a), await sha256OfChannels(c));
});

test('filter behaves like a low-pass: DC passes at gain, Nyquist is rejected', async () => {
  const ex = await instantiate();
  const dc = [new Float32Array(8192).fill(1)];
  const nyq = [Float32Array.from({ length: 8192 }, (_, i) => (i % 2 ? -1 : 1))];
  const dcOut = wasmProcessDirect(ex, dc, TV.gain, TV.coefficients)[0];
  const nyOut = wasmProcessDirect(ex, nyq, TV.gain, TV.coefficients)[0];
  assert.ok(Math.abs(dcOut[8191] - TV.gain) < 1e-5, `DC settles at gain: ${dcOut[8191]}`);
  assert.ok(Math.abs(nyOut[8191]) < 1e-5, `Nyquist rejected: ${nyOut[8191]}`);
});

test('denormal guard: state flushes to exact zero during silence', async () => {
  const ex = await instantiate();
  const sig = new Float32Array(48000);
  sig[0] = 1;
  const out = wasmProcessDirect(ex, [sig], TV.gain, TV.coefficients)[0];
  assert.equal(out[47999], 0);
  const view = new Float64Array(ex.memory.buffer, 32768, 2);
  assert.deepEqual(Array.from(view), [0, 0]);
});

test('error codes: bad frames, bad channel, non-finite / absurd parameters', async () => {
  const ex = await instantiate();
  assert.equal(ex.process(0, 4097), -1);
  assert.equal(ex.process(0, -1), -1);
  assert.equal(ex.process(2, 128), -2);
  assert.equal(ex.process(-1, 128), -2);
  const c = TV.coefficients;
  assert.equal(ex.configure(NaN, c.b0, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.configure(1, Infinity, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.configure(100, c.b0, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.configure(1, c.b0, c.b1, c.b2, c.a1, c.a2), 0);
  assert.equal(ex.process(1, 0), 0);
});

test('corrupt bytes fail with WebAssembly.CompileError (caller can catch it)', () => {
  const bad = new Uint8Array(wasmFile); bad[0] = 0xff;
  assert.throws(() => new WebAssembly.Module(bad), WebAssembly.CompileError);
  assert.throws(() => new WebAssembly.Module(new Uint8Array(wasmFile).subarray(0, 100)), WebAssembly.CompileError);
});
