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

const allJson = readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('summary') && f !== 'playwright-report.json').sort();
const isInvestigation = f => f.includes('-investigation-');
for (const f of allJson.filter(f => !isInvestigation(f))) {
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
      perf.push(`| ${source} | sustained-live ${r.data.instances} inst × ${r.data.seconds}s | cpu ${fmt(a.cpuFractionOfQuantum * 100, 2)}% of quantum; worst block ${a.worstProcMaxMs} ms (${a.clock}); overruns ${a.overBudgetBlocks}; dropouts ${a.lagExceedances} (max lag ${fmt(a.maxLagMs, 1)} ms); blocks ${a.blocksPerInstance}/${a.expectedBlocks}; baseLatency ${fmt(r.data.context.baseLatency, 4)} s, outputLatency ${fmt(r.data.context.outputLatency, 4)} s; browser playbackStats underruns: ${r.data.context.playbackStats ? r.data.context.playbackStats.underrunEvents : 'API not exposed'} |`);
    }
    if (r.name === 'kernel-benchmark' && r.data && r.data.worklet && r.data.worklet.ok) {
      const w = r.data.worklet;
      perf.push(`| ${source} | kernel-benchmark | audio thread ${fmt(w.perBlockUs, 2)} µs/stereo block (${fmt(w.budgetFraction * 100, 3)}% of quantum, ${w.clock}); main thread WASM ${fmt(r.data.mainThread.wasmPerBlockUs, 2)} µs vs JS ref ${fmt(r.data.mainThread.jsReferencePerBlockUs, 2)} µs |`);
    }
    if (r.name === 'offline-throughput' && r.data && r.data.worklet) {
      perf.push(`| ${source} | offline-throughput ${r.data.instances} inst | worklet ${fmt(r.data.worklet.realtimeFactor, 1)}× realtime vs native Gain+Biquad ${fmt(r.data.nativeGainBiquad.realtimeFactor, 1)}× |`);
    }
    if (r.name === 'instance-capacity' && r.data) {
      const d = r.data;
      perf.push(`| ${source} | instance-capacity | first round: ${d.firstRound.created} instances${d.firstRound.failure ? ` then ${d.firstRound.failure.error && d.firstRound.failure.error.name}: ${d.firstRound.failure.error && d.firstRound.failure.error.message}` : ' (no failure up to ' + d.maxAttempted + ')'}; after dispose + 2 s: ${d.secondRoundAfterDispose.created} |`);
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

// ---- follow-up investigation (tests/browser/investigation.spec.mjs) ----------
const inv = allJson.filter(isInvestigation).map(f => {
  try { return { f, project: f.split('-investigation-')[0], name: f.split('-investigation-')[1].replace(/\.json$/, ''), j: JSON.parse(readFileSync(join(dir, f), 'utf8')) }; }
  catch { return null; }
}).filter(Boolean);
if (inv.length) {
  console.log('\n### Investigation: WASM memory budget and single-engine layouts\n');
  const probes = inv.filter(x => x.name.startsWith('probe-'));
  if (probes.length) {
    console.log('| source | probe (main thread, fresh renderer) | created (limit 1000) | error |\n|---|---|---|---|');
    for (const x of probes) console.log(`| ${x.project} | ${x.j.kind} | ${x.j.created} | ${x.j.error || '—'} |`);
  }
  const cmp = inv.filter(x => x.name.startsWith('compare-')).sort((a, b) => a.j.design.localeCompare(b.j.design) || a.j.count - b.j.count);
  if (cmp.length) {
    console.log('\n| source | design | units | init | WASM memories | headroom | renderer RSS MB (base→peak) | DSP % quantum | rendered % | overruns | lag>50ms | underruns |\n|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { project, j } of cmp) {
      const s = j.sustained;
      const rss = j.memory.rendererRssMB ? `${j.memory.rendererRssMB.baseline}→${j.memory.rendererRssMB.peak}` : 'n/a';
      const init = j.init.ok ? `OK (${fmt(j.init.totalMs, 0)} ms)` : `**FAIL at #${j.init.unitsReady}**`;
      console.log(`| ${project} | ${j.design} | ${j.count} | ${init} | ${j.memory.wasmMemories} | ${j.memory.headroomMemoriesWhileLive} | ${rss} | `
        + (s ? `${fmt(s.cpuFractionOfQuantum * 100, 1)} | ${fmt(s.renderedFraction * 100, 1)} | ${s.overBudgetBlocks} | ${s.lagExceedances} | ${s.playbackStats ? s.playbackStats.underrunEvents : 'n/a'} |` : 'NOT RUN | | | | |'));
    }
  }
  const one = n => inv.filter(x => x.name === n);
  for (const { project, j } of one('offline-renders')) {
    console.log(`\n- ${project} repeated OfflineAudioContext renders: per-node ${j['per-node'].completed}/${j['per-node'].renders}, engine-nodes ${j['engine-nodes'].completed}/${j['engine-nodes'].renders}, engine-bank ${j['engine-bank'].completed}/${j['engine-bank'].renders}; main-thread memories after exhaustion ${j.mainThreadMemoriesAfterEngineExhaustion}, after reload ${j.afterReload.created}`);
  }
  for (const { project, j } of one('reclaim')) console.log(`- ${project} reclaim (100 per-node instances): ${j.map(r => `${r.scenario} → ${r.mainThreadMemoriesCreatableAfter} creatable`).join('; ')}`);
  for (const { project, j } of one('cross-isolate')) console.log(`- ${project} cross-isolate: ${JSON.stringify(j)}`);
  for (const { project, j } of one('escape-routes')) console.log(`- ${project} escape routes: ${JSON.stringify(j)}`);
  for (const { project, j } of one('flags')) console.log(`- ${project} js-flags: ${JSON.stringify(j)}`);
  for (const { project, j } of one('engine-parity')) console.log(`- ${project} engine parity: ${JSON.stringify(j.checks)}`);
  for (const x of inv.filter(x => x.name.startsWith('churn-'))) console.log(`- ${x.project} churn ${x.j.design}: ${x.j.totalReady}/${x.j.totalAttempted}`);
  const cspRows = inv.filter(x => x.name.startsWith('csp-'));
  if (cspRows.length) {
    const ok = v => (v ? 'allowed' : 'BLOCKED');
    console.log('\n| source | policy | eval | main thread | worklet per-node | worklet engine | dedicated Worker |\n|---|---|---|---|---|---|---|');
    for (const { project, name, j } of cspRows) console.log(`| ${project} | ${name.replace(/^csp-/, '')} | ${ok(!j.evalBlocked)} | ${ok(j.mainThread.ok)} | ${ok(j.workletPerNode.ok)} | ${ok(j.workletEngine.ok)} | ${ok(j.worker.ok)} |`);
  }
}
