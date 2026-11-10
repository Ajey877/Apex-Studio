// Step list for the Electron follow-up investigation (main.cjs --suite=investigation).
// Each step is a JS expression evaluated in the renderer. Kept separate from
// main.cjs so the identical expressions can be executed in Chromium by
// tests/browser/electron-steps.spec.mjs (Electron cannot run in the dev sandbox).
//
// fresh: true  -> load a new document before the step
// fresh: false -> run in the same document as the previous step
'use strict';

const imp = file => `import(new URL('./${file}', location.href).href)`;
const harnessCall = opts => `${imp('harness.mjs')}.then(m => m.runAll(${JSON.stringify(opts)}))`;
const invCall = (fn, arg) => `${imp('investigation.mjs')}.then(m => m.${fn}(${arg === undefined ? '' : JSON.stringify(arg)}))`;
const probeCall = (kind, limit) => `${imp('repro.mjs')}.then(m => m.probe(${JSON.stringify(kind)}, ${limit}))`;

const DEFAULT_COMPARE = 'per-node:16,per-node:128,engine-nodes:128,engine-bank:128,engine-nodes:512,engine-bank:512';

function investigationSteps({ instances = 16, env = {} } = {}) {
  const compareSeconds = Number(env.SPIKE_COMPARE_SECONDS || 10);
  const compare = (env.SPIKE_ELECTRON_COMPARE || DEFAULT_COMPARE)
    .split(',').map(x => x.trim().split(':')).map(([design, count]) => ({ design, count: Number(count) }));
  const steps = [
    { id: 'probe:memory-1page', fresh: true, js: probeCall('memory-1page', 1000) },
    { id: 'probe:instance-own-memory', fresh: true, js: probeCall('instance-own-memory', 1000) },
    { id: 'probe:memory64-1page', fresh: true, js: probeCall('memory64-1page', 1000) },
    { id: 'probe:instance-no-memory', fresh: true, js: probeCall('instance-no-memory', 1000) },
    // Order hypothesis for Electron's 104: capacity in a fresh document vs after the
    // offline-throughput test (16 rendered offline worklet instances).
    { id: 'capacity:fresh', fresh: true, js: harnessCall({ tests: ['instanceCapacity'] }) },
    { id: 'capacity:after-offlineThroughput', fresh: true, js: harnessCall({ tests: ['offlineThroughput', 'instanceCapacity'], offlineThroughput: { instances, seconds: 30 } }) },
    { id: 'engine-parity', fresh: true, js: invCall('engineParity') },
    { id: 'offline:per-node', fresh: true, js: invCall('offlineRenders', { design: 'per-node', renders: 40, units: 16 }) },
    { id: 'offline:engine-nodes', fresh: true, js: invCall('offlineRenders', { design: 'engine-nodes', renders: 200, units: 16 }) },
    { id: 'offline:after-exhaustion', fresh: false, js: probeCall('memory-1page', 200) },
    { id: 'offline:engine-bank', fresh: true, js: invCall('offlineRenders', { design: 'engine-bank', renders: 200, units: 16 }) },
    { id: 'offline:after-reload', fresh: true, js: probeCall('memory-1page', 200) },
    { id: 'churn:per-node', fresh: true, js: invCall('churn', { design: 'per-node', rounds: 10, perRound: 100 }) },
  ];
  for (const c of compare) {
    steps.push({ id: `compare:${c.design}x${c.count}`, fresh: true, js: invCall('designCompare', { design: c.design, count: c.count, seconds: compareSeconds }) });
  }
  return steps;
}

/** Compact facts for a CI annotation (shared by run-electron.mjs and the Chromium check). */
function summarizeInvestigation(inv) {
  const st = (inv && inv.steps) || {};
  const v = id => (st[id] && st[id].ok ? st[id].value : undefined);
  const err = id => (st[id] && !st[id].ok ? st[id].error : undefined);
  const cap = id => { const h = v(id); const r = h && h.results && h.results.find(x => x.name === 'instance-capacity'); return r && r.data ? r.data.firstRound.created : (err(id) || null); };
  const probes = {};
  for (const k of ['memory-1page', 'instance-own-memory', 'memory64-1page', 'instance-no-memory']) probes[k] = v(`probe:${k}`) ? v(`probe:${k}`).created : (err(`probe:${k}`) || null);
  const parity = v('engine-parity');
  const off = id => (v(id) ? v(id).completed : (err(id) || null));
  const churn = v('churn:per-node');
  const compare = Object.keys(st).filter(k => k.startsWith('compare:')).map(k => {
    const r = v(k);
    if (!r) return `${k.slice(8)}: ERROR ${err(k)}`;
    const s = r.sustained;
    return `${k.slice(8)}: init ${r.init.ok ? 'OK' : `FAIL@${r.init.unitsReady}`} mem ${r.memory.wasmMemories} head ${r.memory.headroomMemoriesWhileLive}`
      + (s ? ` cpu ${(s.cpuFractionOfQuantum * 100).toFixed(1)}% rend ${(s.renderedFraction * 100).toFixed(0)}% ovr ${s.overBudgetBlocks} lag ${s.lagExceedances} und ${s.playbackStats ? s.playbackStats.underrunEvents : 'na'}` : '');
  });
  return {
    probes,
    capacity: { fresh: cap('capacity:fresh'), afterOfflineThroughput: cap('capacity:after-offlineThroughput') },
    parity: parity ? { pass: parity.pass, ...(parity.checks || { error: parity.error }) } : (err('engine-parity') || null),
    offline: { perNode: off('offline:per-node'), engineNodes: off('offline:engine-nodes'), afterExhaustion: v('offline:after-exhaustion') ? v('offline:after-exhaustion').created : null, engineBank: off('offline:engine-bank'), afterReload: v('offline:after-reload') ? v('offline:after-reload').created : null },
    churnPerNode: churn ? `${churn.totalReady}/${churn.totalAttempted}` : (err('churn:per-node') || null),
    compare,
    stepsRun: Object.keys(st).length,
    stepErrors: Object.keys(st).filter(k => !st[k].ok),
  };
}

module.exports = { investigationSteps, summarizeInvestigation };
