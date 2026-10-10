// Node-level checks for the follow-up investigation helpers: CSP variant routing
// (server/csp.mjs) and the hand-assembled probe modules (web/repro.mjs).
// Browser behaviour itself is tested in tests/browser/investigation.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSP_MODES, PRODUCTION_CSP, PRODUCTION_CSP_DIRECTIVES, PRODUCTION_CSP_WITH_WASM,
  PRODUCTION_CSP_WASM_IN_DEFAULT_SRC_ONLY, PRODUCTION_CSP_WITH_UNSAFE_EVAL, cspFor,
} from '../../server/csp.mjs';
import { MODULE_IMPORTS_MEMORY, MODULE_NO_MEMORY, MODULE_OWN_MEMORY, validateProbeModules } from '../../web/repro.mjs';

test('CSP variants differ from production in exactly one directive each', () => {
  const diff = s => s.split('; ').filter((d, i) => d !== PRODUCTION_CSP_DIRECTIVES[i]);
  assert.deepEqual(diff(PRODUCTION_CSP_WITH_WASM), ["script-src 'self' 'wasm-unsafe-eval'"]);
  assert.deepEqual(diff(PRODUCTION_CSP_WASM_IN_DEFAULT_SRC_ONLY), ["default-src 'self' 'wasm-unsafe-eval'"]);
  assert.deepEqual(diff(PRODUCTION_CSP_WITH_UNSAFE_EVAL), ["script-src 'self' 'unsafe-eval'"]);
  assert.equal(CSP_MODES['csp-production'], PRODUCTION_CSP);
});

test('split CSP modes route worklet/worker scripts and documents to different policies', () => {
  assert.equal(cspFor('csp-split-docwasm-scriptprod', '/x/web/index.html'), PRODUCTION_CSP_WITH_WASM);
  assert.equal(cspFor('csp-split-docwasm-scriptprod', '/x/web/engine-processor.js'), PRODUCTION_CSP);
  assert.equal(cspFor('csp-split-docwasm-scriptprod', '/x/web/wasm-probe-worker.js'), PRODUCTION_CSP);
  assert.equal(cspFor('csp-split-docwasm-scriptprod', '/x/web/investigation.mjs'), PRODUCTION_CSP_WITH_WASM);
  assert.equal(cspFor('csp-split-docprod-scriptwasm', '/x/web/gain-filter-processor.js'), PRODUCTION_CSP_WITH_WASM);
  assert.equal(cspFor('csp-split-docprod-scriptwasm', '/x/web/index.html'), PRODUCTION_CSP);
  assert.equal(cspFor('csp-none', '/x/web/index.html'), null);
});

test('hand-assembled probe modules are valid and have the intended memory shape', () => {
  assert.deepEqual(validateProbeModules(), { noMemory: true, ownMemory: true, importsMemory: true });
  const desc = bytes => {
    const m = new WebAssembly.Module(bytes);
    return { imports: WebAssembly.Module.imports(m).map(i => `${i.module}.${i.name}:${i.kind}`), exports: WebAssembly.Module.exports(m).length };
  };
  assert.deepEqual(desc(MODULE_NO_MEMORY), { imports: [], exports: 0 });
  assert.deepEqual(desc(MODULE_OWN_MEMORY), { imports: [], exports: 0 });
  assert.deepEqual(desc(MODULE_IMPORTS_MEMORY), { imports: ['env.memory:memory'], exports: 0 });
  // MODULE_OWN_MEMORY defines a memory: each instance owns a distinct buffer.
  const m = new WebAssembly.Module(MODULE_OWN_MEMORY);
  assert.notEqual(new WebAssembly.Instance(m, {}), new WebAssembly.Instance(m, {}));
});
