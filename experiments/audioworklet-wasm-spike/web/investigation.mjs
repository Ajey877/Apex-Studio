// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// Follow-up investigation of the "Cannot allocate Wasm memory" failure at
// instance #125, and comparison of three DSP layouts:
//   per-node     — original: one WebAssembly instance + memory per AudioWorkletNode
//                  (gain-filter-processor.js, ABI v1)
//   engine-nodes — design B: one AudioWorkletNode per unit, all units share ONE
//                  engine instance/memory per AudioWorkletGlobalScope (engine-processor.js)
//   engine-bank  — variant C: ONE AudioWorkletNode running N units internally
//
// Each function returns a plain JSON result. Callers (tests/browser/
// investigation.spec.mjs) run each case in a FRESH browser context, because the
// memory budget is per renderer process.

import { createGainFilter } from './host.mjs';
import {
  TEST_VECTOR, biquadLowpass, compareBuffers, generateTestSignal, referenceProcess, sha256OfChannels,
} from './reference.mjs';
import { wasmBytes } from './wasm-bytes.mjs';
import { wasmBytes as engineBytes } from './wasm-engine-bytes.mjs';
import { REFERENCE_SHA256 } from './golden.mjs';
import { probe, releaseAll } from './repro.mjs';

const TV = TEST_VECTOR;
const PARAMS = { gain: TV.gain, coefficients: TV.coefficients };
const PER_NODE_URL = new URL('./gain-filter-processor.js', import.meta.url);
const ENGINE_URL = new URL('./engine-processor.js', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GiB = 1024 ** 3;
/** V8 reservation per wasm32 memory with guard regions (kFullGuardSize32, src/objects/backing-store.cc). */
const RESERVATION_PER_MEMORY = 8 * GiB;

export const DESIGNS = ['per-node', 'engine-nodes', 'engine-bank'];

/** Create `count` DSP units in `ctx` with the given layout. Never throws. */
export async function createUnits(ctx, design, count, { lagThresholdMs = 50, params = PARAMS } = {}) {
  const handles = [];
  let failure = null;
  const t0 = performance.now();
  if (design === 'engine-bank') {
    const h = await createGainFilter(ctx, {
      workletUrl: ENGINE_URL, wasmBytes: engineBytes(), params, lagThresholdMs,
      processorName: 'apex-spike-engine-bank', processorOptions: { units: count },
    });
    if (h.ok) handles.push(h); else failure = { at: 0, stage: h.stage, error: h.error };
  } else {
    const opts = design === 'per-node'
      ? { workletUrl: PER_NODE_URL, wasmBytes: wasmBytes(), params, lagThresholdMs }
      : { workletUrl: ENGINE_URL, wasmBytes: engineBytes(), params, lagThresholdMs, processorName: 'apex-spike-engine-unit' };
    for (let i = 0; i < count; i++) {
      const h = await createGainFilter(ctx, opts);
      if (!h.ok) { failure = { at: i, stage: h.stage, error: h.error }; break; }
      handles.push(h);
    }
  }
  const initMs = performance.now() - t0;
  const unitsReady = design === 'engine-bank' ? (handles.length ? count : 0) : handles.length;
  // Linear memories created by THIS layout (logical count, derived from the design).
  const wasmMemories = design === 'per-node' ? handles.length : (handles.length ? 1 : 0);
  const linearBytesPerMemory = design === 'per-node' ? 65536 : 131072;
  return {
    handles, failure, initMs, unitsReady,
    wasmMemories,
    wasmLinearBytes: wasmMemories * linearBytesPerMemory,
    wasmReservedAddressSpaceGiB: (wasmMemories * RESERVATION_PER_MEMORY) / GiB,
  };
}

async function newLiveContext() {
  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: TV.sampleRate });
  if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), sleep(3000)]); } catch { /* reported */ } }
  return ctx;
}

function loopingSource(ctx, seconds = 2) {
  const frames = Math.round(ctx.sampleRate * seconds);
  const sig = generateTestSignal(frames, 2);
  const buf = ctx.createBuffer(2, frames, ctx.sampleRate);
  buf.copyToChannel(sig[0], 0);
  buf.copyToChannel(sig[1], 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

function playbackStats(ctx) {
  const ps = ctx.playbackStats;
  if (!ps) return undefined;
  const o = {};
  for (const k in ps) { const v = ps[k]; if (typeof v !== 'function') o[k] = v; }
  return o;
}

// ---------------------------------------------------------------------------
// Parity of the engine layouts inside a real AudioWorklet (OfflineAudioContext)

export async function engineParity() {
  const input = generateTestSignal();
  const altC = biquadLowpass(3000, 0.9, TV.sampleRate);
  const alt = { gain: 0.5, coefficients: altC };
  // Three engine-unit nodes in ONE context (one shared engine), each routed to
  // its own output pair through a splitter/merger, so per-slot output is captured.
  const ctx = new OfflineAudioContext(6, TV.frames, TV.sampleRate);
  const buf = ctx.createBuffer(2, TV.frames, TV.sampleRate);
  input.forEach((ch, i) => buf.copyToChannel(ch, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const merger = ctx.createChannelMerger(6);
  merger.connect(ctx.destination);
  const unitParams = [PARAMS, alt, PARAMS];
  const handles = [];
  for (let k = 0; k < 3; k++) {
    const h = await createGainFilter(ctx, {
      workletUrl: ENGINE_URL, wasmBytes: engineBytes(), params: unitParams[k], processorName: 'apex-spike-engine-unit',
    });
    if (!h.ok) return { pass: false, error: h };
    const split = ctx.createChannelSplitter(2);
    src.connect(h.node).connect(split);
    split.connect(merger, 0, 2 * k);
    split.connect(merger, 1, 2 * k + 1);
    handles.push(h);
  }
  const info = await handles[0].engineInfo();
  src.start(0);
  const rendered = await ctx.startRendering();
  const units = [];
  for (let k = 0; k < 3; k++) {
    const out = [new Float32Array(rendered.getChannelData(2 * k)), new Float32Array(rendered.getChannelData(2 * k + 1))];
    const p = unitParams[k];
    const ref = input.map(ch => referenceProcess(ch, p.gain, p.coefficients));
    units.push({
      slot: handles[k].ready.slots[0],
      maxAbsDiff: Math.max(...out.map((ch, i) => compareBuffers(ch, ref[i]).maxAbsDiff)),
      sha256: await sha256OfChannels(out),
    });
  }
  const finals = [];
  for (const h of handles) finals.push(await h.dispose());

  // Bank processor with a single unit must also reproduce the golden output.
  const ctx2 = new OfflineAudioContext(2, TV.frames, TV.sampleRate);
  const buf2 = ctx2.createBuffer(2, TV.frames, TV.sampleRate);
  input.forEach((ch, i) => buf2.copyToChannel(ch, i));
  const src2 = ctx2.createBufferSource();
  src2.buffer = buf2;
  const bank = await createGainFilter(ctx2, {
    workletUrl: ENGINE_URL, wasmBytes: engineBytes(), params: PARAMS, processorName: 'apex-spike-engine-bank', processorOptions: { units: 1 },
  });
  if (!bank.ok) return { pass: false, error: bank };
  src2.connect(bank.node).connect(ctx2.destination);
  src2.start(0);
  const r2 = await ctx2.startRendering();
  const bankSha = await sha256OfChannels([new Float32Array(r2.getChannelData(0)), new Float32Array(r2.getChannelData(1))]);
  await bank.dispose();

  const checks = {
    sharedEngine: info.engineInstancesInScope === 1 && info.liveSlots === 3,
    distinctSlots: new Set(units.map(u => u.slot)).size === 3,
    unit0Golden: units[0].sha256 === REFERENCE_SHA256 && units[0].maxAbsDiff === 0,
    unit1MatchesItsOwnReference: units[1].maxAbsDiff === 0,
    unit2Golden: units[2].sha256 === REFERENCE_SHA256 && units[2].maxAbsDiff === 0,
    slotsReleasedOnDispose: finals[2].afterRelease && finals[2].afterRelease.liveSlots === 0,
    bankGolden: bankSha === REFERENCE_SHA256,
  };
  return { pass: Object.values(checks).every(Boolean), checks, engineInfo: info, units, bankSha, golden: REFERENCE_SHA256 };
}

// ---------------------------------------------------------------------------
// Design comparison: init success, memory, sustained live processing

export async function designCompare({ design, count, seconds = 15, lagThresholdMs = 50, headroomLimit = 400 } = {}) {
  const ctx = await newLiveContext();
  const src = loopingSource(ctx);
  const sum = ctx.createGain();
  sum.gain.value = 0.02 / count;
  sum.connect(ctx.destination);
  const u = await createUnits(ctx, design, count, { lagThresholdMs });
  for (const h of u.handles) src.connect(h.node).connect(sum);
  const engine = design === 'per-node' ? null : (u.handles[0] ? await u.handles[0].engineInfo() : null);
  const out = {
    design, count, contextState: ctx.state,
    init: {
      ok: u.unitsReady === count, unitsReady: u.unitsReady, failure: u.failure,
      totalMs: Math.round(u.initMs * 10) / 10, perUnitMs: u.unitsReady ? u.initMs / u.unitsReady : null,
    },
    memory: {
      wasmMemories: u.wasmMemories, wasmLinearBytes: u.wasmLinearBytes,
      wasmReservedAddressSpaceGiB_derived: u.wasmReservedAddressSpaceGiB,
      engine,
    },
    sustained: null,
  };
  if (out.init.ok) {
    src.start();
    await sleep(1000); // warm-up, excluded
    await Promise.all(u.handles.map(h => h.resetStats()));
    const ct0 = ctx.currentTime;
    const w0 = performance.now();
    await sleep(seconds * 1000);
    const stats = await Promise.all(u.handles.map(h => h.getStats()));
    const wallMs = performance.now() - w0;
    const budgetMs = (128 / TV.sampleRate) * 1000;
    const agg = {
      seconds, wallMs: Math.round(wallMs), audioClockVsWall: ((ctx.currentTime - ct0) * 1000) / wallMs,
      blocks: stats[0].blocks, expectedBlocks: Math.round((wallMs / 1000) * TV.sampleRate / 128),
      totalProcMeanMsPerQuantum: stats.reduce((n, s) => n + (s.procMeanMs || 0), 0),
      worstProcMaxMs: Math.max(...stats.map(s => s.procMaxMs || 0)),
      overBudgetBlocks: stats.reduce((n, s) => n + (s.overBudgetBlocks || 0), 0),
      lagExceedances: Math.max(...stats.map(s => s.lagExceedances || 0)),
      maxLagMs: Math.max(...stats.map(s => s.maxLagMs || 0)),
      nonFiniteOut: stats.reduce((n, s) => n + (s.nonFiniteOut || 0), 0),
      kernelErrors: stats.reduce((n, s) => n + (s.kernelErrors || 0), 0),
      frameDiscontinuities: stats.reduce((n, s) => n + (s.frameDiscontinuities || 0), 0),
      playbackStats: playbackStats(ctx),
    };
    agg.cpuFractionOfQuantum = agg.totalProcMeanMsPerQuantum / budgetMs;
    agg.renderedFraction = agg.blocks / agg.expectedBlocks;
    agg.healthy = agg.renderedFraction >= 0.95 && agg.lagExceedances === 0 && agg.overBudgetBlocks === 0
      && agg.nonFiniteOut === 0 && agg.kernelErrors === 0 && agg.frameDiscontinuities === 0
      && (!agg.playbackStats || typeof agg.playbackStats.underrunEvents !== 'number' || agg.playbackStats.underrunEvents === 0);
    out.sustained = agg;
  }
  // Remaining WebAssembly.Memory budget for the rest of the app while these units are alive.
  out.memory.headroomMemoriesWhileLive = probe('memory-1page', headroomLimit).created;
  await releaseAll();
  const finals = [];
  for (const h of u.handles) finals.push(await h.dispose());
  if (design !== 'per-node' && finals.length) out.memory.engineAfterDispose = finals[finals.length - 1].afterRelease;
  try { src.stop(); } catch { /* not started */ }
  await ctx.close();
  return out;
}

// ---------------------------------------------------------------------------
// Churn inside ONE live context (add/remove effects during a session)

export async function churn({ design, rounds = 10, perRound = 100 } = {}) {
  const ctx = await newLiveContext();
  const perRoundResults = [];
  for (let r = 0; r < rounds; r++) {
    const u = await createUnits(ctx, design, perRound);
    const finals = [];
    for (const h of u.handles) finals.push(await h.dispose());
    perRoundResults.push({
      unitsReady: u.unitsReady, failure: u.failure, initMs: Math.round(u.initMs),
      engineLiveSlotsAfterDispose: design === 'per-node' ? undefined : (finals.length ? finals[finals.length - 1].afterRelease.liveSlots : null),
    });
    await sleep(50);
  }
  await ctx.close();
  const totalReady = perRoundResults.reduce((n, x) => n + x.unitsReady, 0);
  return { design, rounds, perRound, totalAttempted: rounds * perRound, totalReady, allOk: totalReady === rounds * perRound, perRoundResults };
}

// ---------------------------------------------------------------------------
// Repeated offline renders (e.g. repeated exports / bounces in one session)

export async function offlineRenders({ design, renders = 40, units = 16, frames = 4800, gcBetween = false, pauseMs = 0 } = {}) {
  const results = [];
  let firstFailure = null;
  for (let i = 0; i < renders; i++) {
    const ctx = new OfflineAudioContext(2, frames, TV.sampleRate);
    const u = await createUnits(ctx, design, units);
    if (u.unitsReady !== units) { firstFailure = { render: i, ...u.failure }; for (const h of u.handles) await h.dispose(); break; }
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(2, frames, TV.sampleRate);
    for (const h of u.handles) src.connect(h.node).connect(ctx.destination);
    src.start(0);
    await ctx.startRendering();
    for (const h of u.handles) await h.dispose();
    results.push(i);
    if (gcBetween && typeof globalThis.gc === 'function') globalThis.gc();
    if (pauseMs) await sleep(pauseMs);
  }
  return {
    design, renders, units, gcBetween, gcAvailable: typeof globalThis.gc === 'function', pauseMs,
    completed: results.length, allOk: results.length === renders, firstFailure,
  };
}

// ---------------------------------------------------------------------------
// Worklet-lifecycle reclamation scenarios (per-node layout, 100 instances)

export async function reclaimScenario({ scenario, count = 100 } = {}) {
  let ctx = scenario.startsWith('offline') ? new OfflineAudioContext(2, 128, TV.sampleRate) : await newLiveContext();
  let u = await createUnits(ctx, 'per-node', count);
  const created = u.unitsReady;
  for (const h of u.handles) await h.dispose();
  u = null;
  if (scenario === 'offline-unrendered-forced-gc' && typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
  if (scenario === 'offline-rendered') await ctx.startRendering();
  if (scenario === 'realtime-close') await ctx.close();
  ctx = null;
  if (scenario.endsWith('forced-gc') && typeof globalThis.gc === 'function') { await sleep(500); globalThis.gc(); }
  await sleep(1000);
  const after = probe('memory-1page', 400);
  await releaseAll();
  return { scenario, created, gcAvailable: typeof globalThis.gc === 'function', mainThreadMemoriesCreatableAfter: after.created, error: after.error };
}



// ---------------------------------------------------------------------------
// CSP matrix: under the page's current policy, where does WebAssembly compile?

export async function cspMatrix() {
  let evalBlocked = false;
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  let newFunctionBlocked = false;
  try { new Function('return 1')(); } catch { newFunctionBlocked = true; }
  const violations = [];
  const onViolation = ev => violations.push({ directive: ev.effectiveDirective, blockedURI: ev.blockedURI, disposition: ev.disposition });
  document.addEventListener('securitypolicyviolation', onViolation);
  const tryIt = async fn => { try { return { ok: true, ...(await fn()) }; } catch (err) { return { ok: false, name: err && err.name, message: String(err && err.message) }; } };

  const mainThread = await tryIt(async () => { await WebAssembly.instantiate(engineBytes(), {}); return {}; });
  const workletOutcome = async design => {
    const ctx = new OfflineAudioContext(2, 128, TV.sampleRate);
    const u = await createUnits(ctx, design, 1);
    for (const h of u.handles) await h.dispose();
    return u.unitsReady === 1 ? { ok: true } : { ok: false, ...u.failure };
  };
  const workletPerNode = await workletOutcome('per-node');
  const workletEngine = await workletOutcome('engine-nodes');
  const worker = await new Promise(resolve => {
    let w;
    try { w = new Worker(new URL('./wasm-probe-worker.js', import.meta.url)); }
    catch (err) { resolve({ ok: false, stage: 'worker-construct', message: String(err && err.message) }); return; }
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, stage: 'timeout' }); }, 5000);
    w.onmessage = e => { clearTimeout(timer); w.terminate(); resolve(e.data); };
    w.onerror = e => { clearTimeout(timer); w.terminate(); resolve({ ok: false, stage: 'worker-error', message: e.message }); };
    w.postMessage(engineBytes());
  });
  await sleep(100);
  document.removeEventListener('securitypolicyviolation', onViolation);
  return { evalBlocked, newFunctionBlocked, mainThread, workletPerNode, workletEngine, worker, violations };
}
globalThis.apexInvestigation = { createUnits, engineParity, designCompare, churn, offlineRenders, reclaimScenario, cspMatrix };
