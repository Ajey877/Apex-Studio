// Single-WASM-engine allocator prototype (isolated; not production).
// The WAT module provides one memory and a fixed table of logical DSP slots;
// tests exercise slot count, reuse, parameter/state isolation, and JS parity.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import wabtInit from 'wabt';
import { biquadLowpass, generateTestSignal, referenceProcess } from '../../web/reference.mjs';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const watPath = join(spikeRoot, 'dsp', 'shared_engine.wat');

async function instantiateSharedEngine() {
  const source = (await readFile(watPath, 'utf8')).replace(/\r\n/g, '\n');
  const wabt = await wabtInit();
  const parsed = wabt.parseWat('shared_engine.wat', source, {});
  parsed.resolveNames();
  parsed.validate();
  const { buffer } = parsed.toBinary({ log: false, write_debug_names: false });
  parsed.destroy();
  const module = new WebAssembly.Module(buffer);
  // Deliberately exactly one WASM instance for the engine; logical slots do not
  // construct WebAssembly.Instance or WebAssembly.Memory objects.
  const instance = new WebAssembly.Instance(module, {});
  return { module, instance, exports: instance.exports };
}

const COEFFICIENTS = c => [c.b0, c.b1, c.b2, c.a1, c.a2];

test('one WASM engine processes 256 independent DSP slots with bit-exact state and output', async () => {
  const { module, instance, exports: ex } = await instantiateSharedEngine();
  assert.equal(WebAssembly.Module.imports(module).length, 0);
  assert.equal(ex.abi_version(), 1);
  assert.equal(ex.slot_capacity(), 512);
  assert.equal(ex.max_frames(), 128);
  assert.equal(ex.memory.buffer.byteLength, 64 * 1024, 'fixed one-page memory; no growth');

  const slots = Array.from({ length: 256 }, () => ex.slot_create());
  assert.deepEqual(slots, Array.from({ length: 256 }, (_, i) => i));
  assert.equal(ex.live_slots(), 256);

  const maxFrames = ex.max_frames();
  const inputView = new Float32Array(ex.memory.buffer, ex.input_ptr(), maxFrames);
  const outputView = new Float32Array(ex.memory.buffer, ex.output_ptr(), maxFrames);
  const input = generateTestSignal(maxFrames * 2, 2);
  const sampleRate = 48_000;

  // Different gains and filter coefficients verify parameter isolation. Two
  // blocks/channel verify that each slot retains its own biquad state.
  for (const slot of slots) {
    const cutoff = 400 + (slot % 100) * 55;
    const gain = 0.5 + (slot % 5) * 0.1;
    const coefficients = biquadLowpass(cutoff, Math.SQRT1_2, sampleRate);
    assert.equal(ex.slot_configure(slot, gain, ...COEFFICIENTS(coefficients)), 0);

    for (let channel = 0; channel < 2; channel++) {
      assert.equal(ex.slot_reset(slot), 0);
      const output = new Float32Array(input[channel].length);
      for (let start = 0; start < input[channel].length; start += maxFrames) {
        const count = Math.min(maxFrames, input[channel].length - start);
        inputView.set(input[channel].subarray(start, start + count));
        assert.equal(ex.process(slot, channel, count), 0);
        output.set(outputView.subarray(0, count), start);
      }
      assert.deepEqual(output, referenceProcess(input[channel], gain, coefficients), `slot ${slot}, channel ${channel}`);
    }
  }
  assert.equal(ex.live_slots(), 256);
  assert.equal(ex.memory.buffer.byteLength, 64 * 1024);
  assert.strictEqual(instance.exports.memory, ex.memory);
});

test('fixed 512-slot table fails explicitly when full and reuses slots without new memories', async () => {
  const { instance, exports: ex } = await instantiateSharedEngine();
  const originalMemory = ex.memory.buffer;
  const first = Array.from({ length: ex.slot_capacity() }, () => ex.slot_create());
  assert.deepEqual(first, Array.from({ length: 512 }, (_, i) => i));
  assert.equal(ex.live_slots(), 512);
  assert.equal(ex.slot_create(), -1, 'the 513th logical slot is rejected by the fixed table');
  assert.equal(ex.live_slots(), 512);

  for (const slot of first) assert.equal(ex.slot_destroy(slot), 0);
  assert.equal(ex.live_slots(), 0);
  assert.equal(ex.slot_destroy(0), -2, 'destroy is guarded against a stale/double-freed slot');

  const reused = Array.from({ length: 512 }, () => ex.slot_create());
  assert.deepEqual(reused, first, 'freed slots are immediately reusable');
  assert.strictEqual(ex.memory.buffer, originalMemory, 'no memory growth or replacement occurred');
  assert.strictEqual(instance.exports.memory, ex.memory);
  assert.equal(ex.live_slots(), 512);
  assert.equal(ex.slot_create(), -1);
});
