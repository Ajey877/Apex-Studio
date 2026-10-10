// Regression tests for the prototype-only long-lived offline Worker engine.
// These validate reusable PCM processing and fixed memory in the core; the browser
// and Electron suites separately exercise the real Worker transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_VECTOR as TV, biquadLowpass, compareBuffers, generateTestSignal, referenceProcess,
} from '../../web/reference.mjs';
import { createOfflineEngine } from '../../web/offline-engine-core.mjs';
import { wasmBytes as engineBytes } from '../../web/wasm-engine-bytes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const committedBytes = readFileSync(join(root, 'dsp', 'gain_biquad_engine.wasm'));
const alternate = { gain: 0.53, coefficients: biquadLowpass(2300, 0.82, TV.sampleRate) };

function assertMatches(output, input, params, label) {
  for (let ch = 0; ch < 2; ch++) {
    const expected = referenceProcess(input[ch], params.gain, params.coefficients);
    const result = compareBuffers(output[ch], expected);
    assert.equal(result.maxAbsDiff, 0, `${label} channel ${ch}`);
    assert.equal(result.nonFinite, 0, `${label} channel ${ch} has finite output`);
  }
}

test('offline core reuses one fixed engine/memory for 200 independent, bit-exact render jobs', () => {
  assert.deepEqual(Buffer.from(engineBytes()), committedBytes);
  const engine = createOfflineEngine(engineBytes());
  const input = generateTestSignal(4800, 2);
  const initial = engine.snapshot();
  assert.deepEqual(initial, {
    engineInstances: 1,
    memoryBytes: 131072,
    memoryBytesAtStart: 131072,
    maxSlots: 1024,
    renderJobs: 0,
    disposed: false,
  });

  for (let i = 0; i < 200; i++) {
    const params = i % 2 === 0 ? TV : alternate;
    const output = engine.render(input, params);
    assertMatches(output, input, params, `render ${i}`);
    const state = engine.snapshot();
    assert.equal(state.engineInstances, 1, `one engine after render ${i}`);
    assert.equal(state.memoryBytes, 131072, `fixed memory after render ${i}`);
    assert.equal(state.renderJobs, i + 1);
  }

  const disposed = engine.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(disposed.engineInstances, 1, 'memory stays owned by the Worker until it is terminated');
  assert.equal(disposed.memoryBytes, 131072);
  assert.throws(() => engine.render(input, TV), /disposed/);
  assert.equal(engine.dispose().disposed, true, 'dispose is idempotent');
});

test('offline core rejects malformed jobs without incrementing the render count', () => {
  const engine = createOfflineEngine(engineBytes());
  const input = generateTestSignal(128, 2);
  assert.throws(() => engine.render([input[0]], TV), /exactly two/);
  assert.throws(() => engine.render([input[0], new Float32Array(127)], TV), /same non-zero/);
  assert.throws(() => engine.render(input, {}), /coefficients/);
  assert.equal(engine.snapshot().renderJobs, 0);
  assert.equal(engine.snapshot().memoryBytes, 131072);
});
