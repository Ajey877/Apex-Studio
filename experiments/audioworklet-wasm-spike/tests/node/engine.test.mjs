// Node-level tests of the SINGLE-ENGINE kernel (dsp/gain_biquad_engine.wat, ABI v2).
// Scope: numerical parity, slot isolation and ABI/error behaviour. Proves nothing
// about AudioWorklet or browser behaviour (see tests/browser/investigation.spec.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TEST_VECTOR as TV, biquadLowpass, compareBuffers, engineProcessDirect, generateTestSignal,
  referenceProcess, sha256OfChannels, RENDER_QUANTUM,
} from '../../web/reference.mjs';
import { wasmBytes as engineBytes } from '../../web/wasm-engine-bytes.mjs';
import { REFERENCE_SHA256 } from '../../web/golden.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmFile = readFileSync(join(root, 'dsp', 'gain_biquad_engine.wasm'));
const instantiate = async () => (await WebAssembly.instantiate(wasmFile, {})).instance.exports;

test('engine: embedded bytes equal the committed .wasm', () => {
  assert.deepEqual(Buffer.from(engineBytes()), wasmFile);
});

test('engine: ABI v2, fixed 2-page memory, no imports, 1024 slots', async () => {
  const mod = new WebAssembly.Module(wasmFile);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const ex = await instantiate();
  assert.equal(ex.abi_version(), 2);
  assert.equal(ex.max_slots(), 1024);
  assert.equal(ex.max_frames(), 4096);
  assert.equal(ex.max_channels(), 2);
  assert.equal(ex.memory.buffer.byteLength, 131072);
  assert.throws(() => ex.memory.grow(1), RangeError, 'memory maximum is fixed');
  // Slot table must fit in memory: 32768 + 1024 * 80 = 114688 <= 131072.
  assert.ok(32768 + ex.max_slots() * 80 <= ex.memory.buffer.byteLength);
});

test('engine: first and last slot are bit-exact with the reference and the golden hash', async () => {
  const ex = await instantiate();
  const input = generateTestSignal();
  for (const slot of [0, 1023]) {
    const out = engineProcessDirect(ex, input, TV.gain, TV.coefficients, slot);
    for (let ch = 0; ch < input.length; ch++) {
      const cmp = compareBuffers(out[ch], referenceProcess(input[ch], TV.gain, TV.coefficients));
      assert.equal(cmp.maxAbsDiff, 0, `slot ${slot} ch${ch}`);
    }
    assert.equal(await sha256OfChannels(out), REFERENCE_SHA256, `slot ${slot} golden hash`);
  }
});

test('engine: 64 interleaved slots with different parameters keep independent state', async () => {
  const ex = await instantiate();
  const input = generateTestSignal();
  const units = Array.from({ length: 64 }, (_, i) => ({
    slot: i * 16, gain: 0.25 + i / 64, c: biquadLowpass(200 + i * 150, Math.SQRT1_2, TV.sampleRate),
  }));
  for (const u of units) { ex.configure_slot(u.slot, u.gain, u.c.b0, u.c.b1, u.c.b2, u.c.a1, u.c.a2); ex.reset_slot(u.slot); }
  const inView = new Float32Array(ex.memory.buffer, ex.input_ptr(), ex.max_frames());
  const outView = new Float32Array(ex.memory.buffer, ex.output_ptr(), ex.max_frames());
  const outs = units.map(() => input.map(ch => new Float32Array(ch.length)));
  // Interleave units block by block, as a shared audio thread would.
  for (let start = 0; start < TV.frames; start += RENDER_QUANTUM) {
    const n = Math.min(RENDER_QUANTUM, TV.frames - start);
    units.forEach((u, k) => {
      for (let ch = 0; ch < input.length; ch++) {
        inView.set(input[ch].subarray(start, start + n));
        assert.equal(ex.process_slot(u.slot, ch, n), 0);
        outs[k][ch].set(outView.subarray(0, n), start);
      }
    });
  }
  units.forEach((u, k) => {
    for (let ch = 0; ch < input.length; ch++) {
      assert.equal(compareBuffers(outs[k][ch], referenceProcess(input[ch], u.gain, u.c)).maxAbsDiff, 0, `unit ${k} ch${ch}`);
    }
  });
});

test('engine: invalid slot/channel/frames/parameters are rejected without touching state', async () => {
  const ex = await instantiate();
  const c = TV.coefficients;
  assert.equal(ex.configure_slot(-1, 1, c.b0, c.b1, c.b2, c.a1, c.a2), -2);
  assert.equal(ex.configure_slot(1024, 1, c.b0, c.b1, c.b2, c.a1, c.a2), -2);
  assert.equal(ex.configure_slot(0, NaN, c.b0, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.configure_slot(0, 1, Infinity, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.configure_slot(0, 17, c.b0, c.b1, c.b2, c.a1, c.a2), -3);
  assert.equal(ex.reset_slot(1024), -2);
  assert.equal(ex.process_slot(1024, 0, 128), -2);
  assert.equal(ex.process_slot(0, 2, 128), -2);
  assert.equal(ex.process_slot(0, 0, 4097), -1);
  assert.equal(ex.process_slot(0, 0, -1), -1);
  // Slot 5 configured; a rejected configure on slot 5 must leave it intact.
  assert.equal(ex.configure_slot(5, TV.gain, c.b0, c.b1, c.b2, c.a1, c.a2), 0);
  assert.equal(ex.configure_slot(5, NaN, c.b0, c.b1, c.b2, c.a1, c.a2), -3);
  const out = engineProcessDirect({ ...ex, configure_slot: () => 0, reset_slot: s => ex.reset_slot(s) }, generateTestSignal(), TV.gain, c, 5);
  assert.equal(await sha256OfChannels(out), REFERENCE_SHA256);
});
