#!/usr/bin/env node
// Runs the spike harness inside Electron in three CSP modes and evaluates them.
//
//   node electron/run-electron.mjs              # unpackaged: repo's electron devDependency
//   node electron/run-electron.mjs --packaged   # packaged spike app (see stage-electron-app.mjs)
//
// Mode expectations:
//   none            — full default suite must pass (functional proof in Electron)
//   production      — CHARACTERISATION: reports whether the production CSP is
//                     applied to file:// pages and whether it blocks WASM.
//                     Fails only if the renderer crashed or the probe did not run.
//   production-wasm — CSP probe + offline worklet parity must pass with WASM allowed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(spikeRoot, '..', '..');
const packaged = process.argv.includes('--packaged');
const resultsDir = join(spikeRoot, 'results');
mkdirSync(resultsDir, { recursive: true });

let exe;
let baseArgs;
if (packaged) {
  const dir = join(resultsDir, 'electron-dist', process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  const name = existsSync(dir) && readdirSync(dir).find(f => /apex.*spike/i.test(f) && (process.platform !== 'win32' || f.endsWith('.exe')));
  if (!name) { console.error(`[spike-electron] packaged app not found in ${dir}; run stage-electron-app.mjs + electron-builder first`); process.exit(1); }
  exe = join(dir, name);
  baseArgs = [];
} else {
  exe = createRequire(join(repoRoot, 'package.json'))('electron');
  baseArgs = [join(spikeRoot, 'electron', 'main.cjs')];
}

const tag = packaged ? 'packaged' : 'unpackaged';
const modes = ['none', 'production', 'production-wasm'];
const summary = { runner: `electron-${tag}`, exe, modes: {} };
let failed = false;

for (const mode of modes) {
  const out = join(resultsDir, `electron-${tag}-${mode}.json`);
  console.log(`\n[spike-electron] === ${tag} csp=${mode} ===`);
  const t0 = Date.now();
  const proc = spawnSync(exe, [...baseArgs, `--csp=${mode}`, `--out=${out}`], {
    stdio: 'inherit',
    timeout: 330_000,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  const h = report && report.harness;
  const probe = h && h.results.find(r => r.name === 'csp-probe');
  let pass;
  let verdict;
  if (!report) {
    pass = false; verdict = `no report written (exit ${proc.status}, signal ${proc.signal}, error ${proc.error && proc.error.message})`;
  } else if (report.renderer.gone) {
    pass = false; verdict = `renderer process gone: ${JSON.stringify(report.renderer.gone)}`;
  } else if (!h) {
    pass = false; verdict = `harness did not run: ${report.error}`;
  } else if (mode === 'none') {
    pass = h.pass; verdict = h.results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}`).join(', ');
  } else if (mode === 'production') {
    pass = !!probe;
    const d = probe ? probe.data : {};
    verdict = `CHARACTERISATION: header hook calls=${report.headerHook.calls} (file:// ${report.headerHook.fileUrlCalls}); `
      + `CSP enforced=${d.cspActive}; main-thread WASM ${d.mainThreadWasm && d.mainThreadWasm.ok ? 'ALLOWED' : 'BLOCKED'}; `
      + `worklet WASM ${d.workletWasm && d.workletWasm.ok ? 'ALLOWED' : 'BLOCKED'}`;
  } else {
    pass = h.pass && probe && probe.data.workletWasm.ok;
    verdict = h.results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}`).join(', ')
      + `; header hook file:// calls=${report.headerHook.fileUrlCalls}; CSP enforced=${probe && probe.data.cspActive}`;
  }
  if (h) {
    for (const r of h.results) {
      for (const c of r.checks) console.log(`   ${c.pass ? 'ok  ' : 'FAIL'} [${r.kind}] ${r.name} :: ${c.name} :: ${JSON.stringify(c.detail)}`);
    }
  }
  console.log(`[spike-electron] ${tag} csp=${mode}: ${pass ? 'PASS' : 'FAIL'} — ${verdict}`);
  summary.modes[mode] = { pass, verdict, seconds: Math.round((Date.now() - t0) / 1000), versions: report && report.versions && { electron: report.versions.electron, chrome: report.versions.chrome, v8: report.versions.v8 }, platform: report && `${report.platform}-${report.arch} ${report.osRelease}`, cpu: report && report.cpus };
  if (!pass) failed = true;
}

writeFileSync(join(resultsDir, `electron-${tag}-summary.json`), JSON.stringify(summary, null, 2));
console.log(`\n[spike-electron] summary: ${JSON.stringify(summary, null, 2)}`);
process.exit(failed ? 1 : 0);
