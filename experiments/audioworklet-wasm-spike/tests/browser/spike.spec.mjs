// Real-browser execution of the spike harness. One Playwright test per harness
// test, each in a fresh page, so results are reported separately by kind.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultsDir = join(spikeRoot, 'results');
mkdirSync(resultsDir, { recursive: true });

const instances = Number(process.env.SPIKE_INSTANCES || 16);
const seconds = Number(process.env.SPIKE_SECONDS || 20);

async function runHarness(page, cspMode, tests, options = {}) {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(String(err)));
  page.on('crash', () => pageErrors.push('PAGE CRASHED'));
  await page.goto(`/${cspMode}/web/index.html`);
  const out = await page.evaluate(async ({ tests, options }) => {
    const mod = await import(new URL('./harness.mjs', location.href).href);
    return mod.runAll({ ...options, tests });
  }, { tests, options });
  return { out, pageErrors };
}

function save(testInfo, name, payload) {
  const file = join(resultsDir, `${testInfo.project.name}-${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return testInfo.attach(name, { path: file, contentType: 'application/json' });
}

const cases = [
  ['capabilities', 'capabilities', {}],
  ['parity-wasm-direct', 'parityWasmDirect', {}],
  ['parity-worklet-offline', 'parityWorkletOffline', {}],
  ['live-lifecycle', 'liveLifecycle', {}],
  ['failure-modes', 'failureModes', {}],
  ['kernel-benchmark', 'kernelBenchmark', {}],
  ['offline-throughput', 'offlineThroughput', { offlineThroughput: { instances, seconds: 30 } }],
  ['sustained-live', 'sustainedLive', { sustainedLive: { instances, seconds } }],
];

for (const [label, harnessName, options] of cases) {
  test(`${label} (csp-none)`, async ({ page }, testInfo) => {
    const { out, pageErrors } = await runHarness(page, 'csp-none', [harnessName], options);
    await save(testInfo, label, out);
    const r = out.results[0];
    console.log(`[${testInfo.project.name}] ${label}: ${r.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(out.environment.brands || out.environment.userAgent)}`);
    for (const c of r.checks) console.log(`   ${c.pass ? 'ok  ' : 'FAIL'} ${c.name} :: ${JSON.stringify(c.detail)}`);
    expect(pageErrors, 'no uncaught page errors / crashes').toEqual([]);
    expect(r.pass, JSON.stringify(r.checks.filter(c => !c.pass), null, 2)).toBe(true);
  });
}

test('production Electron CSP (copied from electron.cjs) blocks WebAssembly compilation', async ({ page }, testInfo) => {
  const { out, pageErrors } = await runHarness(page, 'csp-production', ['cspProbe']);
  await save(testInfo, 'csp-production', out);
  const d = out.results[0].data;
  console.log(`[${testInfo.project.name}] csp-production: ${JSON.stringify(d)}`);
  expect(pageErrors).toEqual([]);
  expect(d.cspActive, 'CSP header is enforced (eval blocked)').toBe(true);
  expect(d.mainThreadWasm.ok, 'main-thread WebAssembly.instantiate blocked').toBe(false);
  expect(d.workletWasm.ok, 'worklet WebAssembly compilation blocked').toBe(false);
  expect(d.workletWasm.stage, 'failure is reported, not thrown').toBe('wasm-init');
});

test("production CSP + 'wasm-unsafe-eval' allows WebAssembly (eval still blocked)", async ({ page }, testInfo) => {
  const { out, pageErrors } = await runHarness(page, 'csp-production-wasm', ['cspProbe', 'parityWorkletOffline']);
  await save(testInfo, 'csp-production-wasm', out);
  const d = out.results[0].data;
  console.log(`[${testInfo.project.name}] csp-production-wasm: ${JSON.stringify(d)}`);
  expect(pageErrors).toEqual([]);
  expect(d.cspActive).toBe(true);
  expect(d.mainThreadWasm.ok).toBe(true);
  expect(d.workletWasm.ok).toBe(true);
  expect(out.results[1].pass, 'bit-exact worklet parity under the amended CSP').toBe(true);
});
