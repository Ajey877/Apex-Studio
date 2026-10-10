#!/usr/bin/env node
// Summarises results/*.json (Playwright + Electron harness reports) as Markdown.
//   node scripts/summarize-results.mjs [resultsDir] >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] || join(spikeRoot, 'results');
if (!existsSync(dir)) { console.log('_No results directory._'); process.exit(0); }

const rows = [];
const perf = [];
const csp = [];
const envs = new Map();
const fmt = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : n);

for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('summary') && f !== 'playwright-report.json').sort()) {
  let j;
  try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  const isElectron = j.runner === 'electron';
  const harness = isElectron ? j.harness : j;
  const source = isElectron ? `electron ${j.packaged ? 'packaged' : 'unpackaged'} (csp=${j.cspMode})` : f.replace(/\.json$/, '');
  if (!harness || !harness.results) {
    rows.push(`| ${source} | — | — | **NO RESULTS** ${isElectron ? (j.error || '') : ''} |`);
    continue;
  }
  const e = harness.environment || {};
  const envLabel = isElectron
    ? `Electron ${j.versions.electron} / Chromium ${j.versions.chrome} / ${j.platform}-${j.arch} ${j.osRelease}`
    : `${(e.brands || [e.userAgent]).join(', ')} / ${e.platformName || e.platform} ${e.platformVersion || ''} ${e.architecture || ''}`;
  envs.set(isElectron ? source : f.split('-')[0], envLabel);
  for (const r of harness.results) {
    const failed = r.checks.filter(c => !c.pass).map(c => c.name);
    rows.push(`| ${source} | ${r.name} | ${r.kind} | ${r.pass ? 'PASS' : `**FAIL**: ${failed.join('; ')}`} |`);
    if (r.name === 'sustained-live' && r.data && r.data.aggregate) {
      const a = r.data.aggregate;
      perf.push(`| ${source} | sustained-live ${r.data.instances} inst × ${r.data.seconds}s | cpu ${fmt(a.cpuFractionOfQuantum * 100, 2)}% of quantum; worst block ${a.worstProcMaxMs} ms (${a.clock}); overruns ${a.overBudgetBlocks}; dropouts ${a.lagExceedances} (max lag ${fmt(a.maxLagMs, 1)} ms); blocks ${a.blocksPerInstance}/${a.expectedBlocks}; baseLatency ${fmt(r.data.context.baseLatency, 4)} s, outputLatency ${fmt(r.data.context.outputLatency, 4)} s |`);
    }
    if (r.name === 'kernel-benchmark' && r.data && r.data.worklet && r.data.worklet.ok) {
      const w = r.data.worklet;
      perf.push(`| ${source} | kernel-benchmark | audio thread ${fmt(w.perBlockUs, 2)} µs/stereo block (${fmt(w.budgetFraction * 100, 3)}% of quantum, ${w.clock}); main thread WASM ${fmt(r.data.mainThread.wasmPerBlockUs, 2)} µs vs JS ref ${fmt(r.data.mainThread.jsReferencePerBlockUs, 2)} µs |`);
    }
    if (r.name === 'offline-throughput' && r.data && r.data.worklet) {
      perf.push(`| ${source} | offline-throughput ${r.data.instances} inst | worklet ${fmt(r.data.worklet.realtimeFactor, 1)}× realtime vs native Gain+Biquad ${fmt(r.data.nativeGainBiquad.realtimeFactor, 1)}× |`);
    }
    if (r.name === 'csp-probe') {
      const d = r.data;
      csp.push(`| ${source} | CSP enforced: ${d.cspActive} | main-thread WASM: ${d.mainThreadWasm.ok ? 'allowed' : 'BLOCKED'} | worklet WASM: ${d.workletWasm.ok ? 'allowed' : 'BLOCKED'} |${isElectron ? ` header hook calls ${j.headerHook.calls} (file:// ${j.headerHook.fileUrlCalls})` : ''} |`);
    }
    if (r.name === 'parity-worklet-offline' || r.name === 'parity-wasm-direct') {
      // included in rows; sha shown in detail table below
    }
  }
}

console.log('## AudioWorklet + WASM spike results\n');
console.log('### Environments\n\n| source | environment |\n|---|---|');
for (const [k, v] of envs) console.log(`| ${k} | ${v} |`);
console.log('\n### Tests\n\n| source | test | kind | result |\n|---|---|---|---|');
console.log(rows.join('\n'));
if (perf.length) console.log('\n### Performance (measurements, not proofs of correctness)\n\n| source | measurement | values |\n|---|---|---|\n' + perf.join('\n'));
if (csp.length) console.log('\n### CSP characterisation\n\n| source | | | | |\n|---|---|---|---|---|\n' + csp.join('\n'));
