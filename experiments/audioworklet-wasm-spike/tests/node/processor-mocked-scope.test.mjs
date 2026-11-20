// MOCKED-SCOPE logic test of the AudioWorklet processor in Node.
//
// The real AudioWorkletGlobalScope is replaced by a tiny shim (registerProcessor,
// AudioWorkletProcessor, sampleRate, currentFrame, a MessagePort). This checks
// the processor's own state machine quickly and deterministically. It is NOT
// evidence that AudioWorklet works in any browser — that is what the
// Playwright and Electron harness runs are for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { TEST_VECTOR as TV, generateTestSignal, referenceProcess, compareBuffers } from '../../web/reference.mjs';
import { wasmBytes } from '../../web/wasm-bytes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(root, 'web', 'gain-filter-processor.js'), 'utf8');

function loadProcessorClass() {
  const registry = {};
  class AudioWorkletProcessor {
    constructor() {
      const sent = [];
      this.port = { onmessage: null, sent, postMessage: m => sent.push(m) };
    }
  }
  const scope = {
    AudioWorkletProcessor,
    registerProcessor: (name, cls) => { registry[name] = cls; },
    sampleRate: TV.sampleRate,
    currentFrame: 0,
    WebAssembly, Float32Array, Date, Math, Number, String, Error, globalThis: null,
  };
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(source, scope);
  return { Cls: registry['apex-spike-gain-filter'], scope };
}

const params = { gain: TV.gain, coefficients: TV.coefficients };

test('registers under the expected name and reports ready', () => {
  const { Cls } = loadProcessorClass();
  assert.ok(Cls);
  const p = new Cls({ processorOptions: { wasmBytes: wasmBytes(), params } });
  assert.equal(p.state, 'ready');
  assert.equal(p.port.sent[0].type, 'ready');
});

test('process() output equals the reference across render quanta', () => {
  const { Cls, scope } = loadProcessorClass();
  const p = new Cls({ processorOptions: { wasmBytes: wasmBytes(), params } });
  const input = generateTestSignal(128 * 50, 2);
  const out = [new Float32Array(input[0].length), new Float32Array(input[0].length)];
  for (let b = 0; b < 50; b++) {
    scope.currentFrame = b * 128;
    const ins = [[input[0].subarray(b * 128, b * 128 + 128), input[1].subarray(b * 128, b * 128 + 128)]];
    const outs = [[new Float32Array(128), new Float32Array(128)]];
    assert.equal(p.process(ins, outs), true);
    out[0].set(outs[0][0], b * 128); out[1].set(outs[0][1], b * 128);
  }
  for (let ch = 0; ch < 2; ch++) {
    assert.equal(compareBuffers(out[ch], referenceProcess(input[ch], TV.gain, TV.coefficients)).maxAbsDiff, 0);
  }
  assert.equal(p.stats.blocks, 50);
  assert.equal(p.stats.frameDiscontinuities, 0);
});

test('init failures never throw; processor is inert and reports init-error', () => {
  const { Cls } = loadProcessorClass();
  const bad = wasmBytes(); bad[0] = 0xff; // magic is "\0asm"; 0x00 would be a no-op
  for (const opts of [{ wasmBytes: bad, params }, { params }, { wasmBytes: wasmBytes(), params: { gain: NaN, coefficients: TV.coefficients } }]) {
    const p = new Cls({ processorOptions: opts });
    assert.equal(p.state, 'failed');
    assert.equal(p.port.sent[0].type, 'init-error');
    const outs = [[new Float32Array(128), new Float32Array(128)]];
    assert.equal(p.process([[]], outs), true, 'failed processor stays alive (silent) until disposed');
    assert.ok(outs[0][0].every(v => v === 0));
  }
});

test('dispose makes process() return false; fault hook throws exactly once', () => {
  const { Cls } = loadProcessorClass();
  const p = new Cls({ processorOptions: { wasmBytes: wasmBytes(), params } });
  const io = () => [[[new Float32Array(128), new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]]];
  p.port.onmessage({ data: { type: 'inject-fault' } });
  assert.throws(() => p.process(...io()), /Injected processor fault/);
  assert.equal(p.process(...io()), true);
  p.port.onmessage({ data: { type: 'dispose' } });
  assert.equal(p.process(...io()), false);
  assert.equal(p.port.sent.at(-1).type, 'disposed');
});

test('unconnected input produces processed silence, not garbage', () => {
  const { Cls } = loadProcessorClass();
  const p = new Cls({ processorOptions: { wasmBytes: wasmBytes(), params } });
  const outs = [[new Float32Array(128).fill(9), new Float32Array(128).fill(9)]];
  p.process([[]], outs);
  assert.ok(outs[0][0].every(v => v === 0) && outs[0][1].every(v => v === 0));
});
