// Apex Studio — AudioWorklet + WASM spike (EXPERIMENTAL, NOT PRODUCTION)
//
// In-page test suite. The SAME code runs under Playwright (Chromium, Chrome,
// Edge) and inside Electron, so every environment executes identical checks.
// Each test reports a `kind` so results stay separated:
//   parity      — numerical correctness only (says nothing about real-time)
//   live        — real-time AudioContext behaviour and lifecycle
//   performance — CPU cost / overrun measurements
//   failure     — error handling and isolation
//   csp         — Content-Security-Policy characterisation

import { createGainFilter, detectSupport } from './host.mjs';
import {
  TEST_VECTOR, biquadLowpass, compareBuffers, generateTestSignal, referenceProcess,
  sha256OfChannels, signalStats, wasmProcessDirect,
} from './reference.mjs';
import { WASM_SHA256, wasmBytes } from './wasm-bytes.mjs';
import { REFERENCE_SHA256 } from './golden.mjs';

const WORKLET_URL = new URL('./gain-filter-processor.js', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TV = TEST_VECTOR;
const PARAMS = { gain: TV.gain, coefficients: TV.coefficients };

function check(name, pass, detail) { return { name, pass: !!pass, detail }; }
function result(name, kind, checks, data = {}) {
  return { name, kind, pass: checks.length > 0 && checks.every(c => c.pass), checks, data };
}

async function newLiveContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new AudioCtx({ latencyHint: 'interactive', sampleRate: TV.sampleRate });
  if (ctx.state !== 'running') {
    try { await Promise.race([ctx.resume(), sleep(3000)]); } catch { /* reported below */ }
  }
  return ctx;
}

function contextInfo(ctx) {
  const info = {
    state: ctx.state,
    sampleRate: ctx.sampleRate,
    baseLatency: ctx.baseLatency,
    outputLatency: ctx.outputLatency,
    sinkId: typeof ctx.sinkId === 'string' ? ctx.sinkId : (ctx.sinkId ? 'non-default' : undefined),
  };
  // Chrome's experimental playback statistics, when exposed. Copied verbatim.
  const ps = ctx.playbackStats;
  if (ps) {
    info.playbackStats = {};
    for (const k in ps) { const v = ps[k]; if (typeof v !== 'function') info.playbackStats[k] = v; }
  }
  return info;
}

function makeLoopingSource(ctx, seconds = 2) {
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

// ---------------------------------------------------------------------------

export async function environment() {
  const env = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    location: location.protocol,
  };
  const uad = navigator.userAgentData;
  if (uad && uad.getHighEntropyValues) {
    try {
      const he = await uad.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness']);
      env.brands = (he.fullVersionList || []).map(b => `${b.brand} ${b.version}`).filter(b => !/Not.?A.?Brand/i.test(b));
      env.platformName = uad.platform;
      env.platformVersion = he.platformVersion;
      env.architecture = `${he.architecture || '?'}-${he.bitness || '?'}`;
    } catch { /* not available */ }
  }
  const m = navigator.userAgent.match(/Electron\/([\d.]+)/);
  if (m) env.electron = m[1];
  return env;
}

export async function capabilities() {
  const support = detectSupport();
  let evalBlocked = false;
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  let fetchWasm;
  try {
    const res = await fetch(new URL('../dsp/gain_biquad.wasm', import.meta.url));
    const bytes = new Uint8Array(await res.arrayBuffer());
    fetchWasm = { ok: res.ok, bytes: bytes.length };
  } catch (err) {
    fetchWasm = { ok: false, error: String(err && err.message) };
  }
  const AC = globalThis.AudioContext;
  const data = {
    support,
    wasmSha256: WASM_SHA256,
    cspEvalBlocked: evalBlocked,
    fetchWasmFromPage: fetchWasm,
    playbackStatsApi: !!(AC && 'playbackStats' in AC.prototype),
    renderCapacityApi: !!(AC && 'renderCapacity' in AC.prototype),
    setSinkIdApi: !!(AC && 'setSinkId' in AC.prototype),
  };
  return result('capabilities', 'capability', [
    check('AudioWorklet + WebAssembly available', support.supported, support.reason || 'supported'),
  ], data);
}

/** Parity #1: the WASM module run directly on the page main thread (no worklet). */
export async function parityWasmDirect() {
  const { instance } = await WebAssembly.instantiate(wasmBytes(), {});
  const input = generateTestSignal();
  const out = wasmProcessDirect(instance.exports, input, TV.gain, TV.coefficients);
  const ref = input.map(ch => referenceProcess(ch, TV.gain, TV.coefficients));
  const cmp = out.map((ch, i) => compareBuffers(ch, ref[i]));
  const sha = await sha256OfChannels(out);
  const coeff = biquadLowpass(1200, Math.SQRT1_2, TV.sampleRate);
  const coeffDiff = Math.max(...Object.keys(coeff).map(k => Math.abs(coeff[k] - TV.coefficients[k])));
  return result('parity-wasm-direct', 'parity', [
    check('max |wasm - reference| <= tolerance', cmp.every(c => c.maxAbsDiff <= TV.tolerance), cmp.map(c => c.maxAbsDiff)),
    check('output sha256 == golden reference sha256', sha === REFERENCE_SHA256, sha),
    check('no non-finite samples', cmp.every(c => c.nonFinite === 0), cmp.map(c => c.nonFinite)),
  ], { comparison: cmp, sha256: sha, tolerance: TV.tolerance, coefficientRecomputeMaxDiff: coeffDiff, abiVersion: instance.exports.abi_version() });
}

/** Parity #2: the same WASM inside an AudioWorklet, rendered by OfflineAudioContext. */
export async function parityWorkletOffline() {
  const ctx = new OfflineAudioContext(TV.channels, TV.frames, TV.sampleRate);
  const input = generateTestSignal();
  const buf = ctx.createBuffer(TV.channels, TV.frames, TV.sampleRate);
  input.forEach((ch, i) => buf.copyToChannel(ch, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  if (!gf.ok) return result('parity-worklet-offline', 'parity', [check('processor initialised', false, gf)]);
  src.connect(gf.node).connect(ctx.destination);
  src.start(0);
  const t0 = performance.now();
  const rendered = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  const out = [rendered.getChannelData(0), rendered.getChannelData(1)];
  const ref = input.map(ch => referenceProcess(ch, TV.gain, TV.coefficients));
  const cmp = out.map((ch, i) => compareBuffers(ch, ref[i]));
  const sha = await sha256OfChannels(out.map(c => new Float32Array(c)));
  await gf.dispose();
  return result('parity-worklet-offline', 'parity', [
    check('processor reported ready (WASM instantiated in AudioWorkletGlobalScope)', gf.ready.type === 'ready', gf.ready),
    check('max |worklet - reference| <= tolerance', cmp.every(c => c.maxAbsDiff <= TV.tolerance), cmp.map(c => c.maxAbsDiff)),
    check('output sha256 == golden reference sha256', sha === REFERENCE_SHA256, sha),
    check('output is not silent', signalStats(out[0]).peak > 0.05, signalStats(out[0])),
  ], { comparison: cmp, sha256: sha, tolerance: TV.tolerance, renderMs, workletClock: gf.ready.clock });
}

/** Live: real-time AudioContext, initialisation -> processing -> dispose -> close. */
export async function liveLifecycle({ seconds = 2 } = {}) {
  const ctx = await newLiveContext();
  const checks = [check('AudioContext running', ctx.state === 'running', ctx.state)];
  const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  checks.push(check('processor ready', gf.ok, gf.ok ? gf.ready : gf));
  let data = { context: contextInfo(ctx) };
  if (gf.ok) {
    const src = makeLoopingSource(ctx);
    const out = ctx.createGain();
    out.gain.value = 0.05; // keep local runs quiet
    src.connect(gf.node).connect(out).connect(ctx.destination);
    src.start();
    await sleep(300); // let rendering settle
    await gf.resetStats();
    const w0 = performance.now();
    await sleep(seconds * 1000);
    const stats = await gf.getStats();
    const wallMs = performance.now() - w0;
    const expectedBlocks = (wallMs / 1000) * ctx.sampleRate / 128;
    checks.push(check('rendered >= 90% of wall-clock blocks', stats.blocks >= 0.9 * expectedBlocks, { blocks: stats.blocks, expectedBlocks: Math.round(expectedBlocks) }));
    checks.push(check('output non-silent', stats.outPeak > 0.01, stats.outPeak));
    checks.push(check('no non-finite output / kernel errors', stats.nonFiniteOut === 0 && stats.kernelErrors === 0, { nonFinite: stats.nonFiniteOut, kernelErrors: stats.kernelErrors }));
    checks.push(check('no currentFrame discontinuities', stats.frameDiscontinuities === 0, stats.frameDiscontinuities));

    // Shutdown: ask processor to stop, verify it went quiescent, then tear down.
    const port = gf.node.port;
    const hostHandler = port.onmessage;
    const disposedMsg = await new Promise(resolve => {
      const prev = port.onmessage;
      port.onmessage = ev => { if (ev.data && ev.data.type === 'disposed') { port.onmessage = prev; resolve(ev.data); } else if (prev) prev(ev); };
      port.postMessage({ type: 'dispose' });
    });
    const s1 = await new Promise(r => { port.onmessage = ev => r(ev.data); port.postMessage({ type: 'get-stats' }); });
    await sleep(250);
    const s2 = await new Promise(r => { port.onmessage = ev => r(ev.data); port.postMessage({ type: 'get-stats' }); });
    checks.push(check('processor quiescent after dispose (no further blocks)', s1.state === 'disposed' && s2.blocks === s1.blocks, { state: s1.state, before: s1.blocks, after: s2.blocks }));
    port.onmessage = hostHandler;
    const again = await gf.dispose();
    checks.push(check('host dispose idempotent / port released', again && again.type === 'disposed' && gf.disposed, again && again.type));
    try { src.stop(); } catch { /* ignore */ }
    data = { ...data, stats, wallMs, disposedMsg };
  }
  await ctx.close();
  checks.push(check('AudioContext closed', ctx.state === 'closed', ctx.state));
  const afterClose = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS, initTimeoutMs: 1500 });
  checks.push(check('creating a node on a closed context fails gracefully (no throw)', afterClose.ok === false, afterClose.stage));
  return result('live-lifecycle', 'live', checks, data);
}

/** Failure handling and isolation, including a bystander graph in the SAME context. */
export async function failureModes() {
  const ctx = await newLiveContext();
  const checks = [];
  const details = {};

  // Bystander graph standing in for "the rest of the engine" in this context.
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  osc.connect(analyser).connect(mute).connect(ctx.destination);
  osc.start();
  const bystanderAlive = async () => {
    const t0 = ctx.currentTime;
    await sleep(300);
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    return { advancing: ctx.currentTime > t0, peak: signalStats(buf).peak, state: ctx.state };
  };

  // (a) Unsupported environment (no AudioWorkletNode / no WebAssembly).
  const fakeEnv = { AudioContext: globalThis.AudioContext, BaseAudioContext: function Fake() {}, WebAssembly: undefined };
  const a = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS, env: fakeEnv });
  checks.push(check('unsupported environment -> {ok:false, stage:"unsupported"}', !a.ok && a.stage === 'unsupported', a.reason));

  // (b) Worklet module fails to load (404). Uses a fresh context so the
  // module cache of the main context is not involved.
  const ctxB = new OfflineAudioContext(2, 128, TV.sampleRate);
  const b = await createGainFilter(ctxB, { workletUrl: new URL('./does-not-exist-processor.js', import.meta.url), wasmBytes: wasmBytes(), params: PARAMS });
  checks.push(check('missing worklet module -> stage "worklet-module-load"', !b.ok && b.stage === 'worklet-module-load', b.error));

  // (c) Corrupt WASM bytes.
  const bad = wasmBytes(); bad[0] = 0xff;
  const c = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: bad, params: PARAMS });
  checks.push(check('corrupt WASM -> stage "wasm-init" (CompileError)', !c.ok && c.stage === 'wasm-init' && /CompileError/.test(c.error && c.error.name), c.error));

  // (d) Invalid parameters rejected by the kernel.
  const d = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: { gain: NaN, coefficients: TV.coefficients } });
  checks.push(check('non-finite parameter -> stage "wasm-init" (configure rejected)', !d.ok && d.stage === 'wasm-init', d.error));

  details.bystanderAfterInitFailures = await bystanderAlive();

  // (e) Runtime exception inside process() of a running processor.
  const e = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  let faultInfo = null;
  if (e.ok) {
    const src = makeLoopingSource(ctx);
    src.connect(e.node).connect(mute);
    src.start();
    await sleep(200);
    const faultSeen = new Promise(r => e.onFault(f => r(f)));
    e.injectFault();
    faultInfo = await Promise.race([faultSeen, sleep(3000).then(() => null)]);
    try { src.stop(); } catch { /* ignore */ }
    await e.dispose();
  }
  checks.push(check('process() exception -> processorerror caught, node isolated', !!faultInfo, faultInfo));

  details.bystanderAfterRuntimeFault = await bystanderAlive();
  const by = details.bystanderAfterRuntimeFault;
  checks.push(check('bystander graph in same context still rendering after all failures', by.advancing && by.peak > 0.5 && by.state === 'running', by));

  // (f) Recovery: a fresh processor in the same context works.
  const f = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  let fStats = null;
  if (f.ok) {
    f.node.connect(mute);
    await sleep(300);
    fStats = await f.getStats();
    await f.dispose();
  }
  checks.push(check('new processor in same context initialises and runs after failures', f.ok && fStats && fStats.blocks > 0, fStats && { blocks: fStats.blocks }));

  osc.stop();
  await ctx.close();
  return result('failure-modes', 'failure', checks, details);
}

/** CSP characterisation: does the page CSP allow WASM compilation (main thread + worklet)? */
export async function cspProbe() {
  let evalBlocked = false;
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  const violations = [];
  const onViolation = ev => violations.push({ directive: ev.effectiveDirective, blockedURI: ev.blockedURI, sample: ev.sample });
  document.addEventListener('securitypolicyviolation', onViolation);
  let mainThread;
  try { await WebAssembly.instantiate(wasmBytes(), {}); mainThread = { ok: true }; }
  catch (err) { mainThread = { ok: false, name: err.name, message: String(err.message) }; }
  const ctx = new OfflineAudioContext(2, 128, TV.sampleRate);
  const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  const worklet = gf.ok ? { ok: true } : { ok: false, stage: gf.stage, error: gf.error };
  if (gf.ok) await gf.dispose();
  await sleep(100);
  document.removeEventListener('securitypolicyviolation', onViolation);
  // Characterisation only: the caller asserts the expectation for its CSP mode.
  return result('csp-probe', 'csp', [check('probe completed without crashing the page', true)], {
    cspActive: evalBlocked, mainThreadWasm: mainThread, workletWasm: worklet, violations,
  });
}

/** Performance: kernel cost on the audio thread and on the main thread (WASM vs JS reference). */
export async function kernelBenchmark({ blocks = 20000 } = {}) {
  const ctx = new OfflineAudioContext(2, 128, TV.sampleRate);
  const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
  if (!gf.ok) return result('kernel-benchmark', 'performance', [check('processor ready', false, gf)]);
  const worklet = await gf.benchmark(blocks);
  await gf.dispose();

  const { instance } = await WebAssembly.instantiate(wasmBytes(), {});
  const ex = instance.exports;
  ex.configure(TV.gain, ...['b0', 'b1', 'b2', 'a1', 'a2'].map(k => TV.coefficients[k]));
  const inView = new Float32Array(ex.memory.buffer, ex.input_ptr(), 128);
  const noise = generateTestSignal(128, 1)[0];
  inView.set(noise);
  let t0 = performance.now();
  for (let i = 0; i < blocks; i++) { ex.process(0, 128); ex.process(1, 128); }
  const wasmMainMs = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < blocks; i++) { referenceProcess(noise, TV.gain, TV.coefficients); referenceProcess(noise, TV.gain, TV.coefficients); }
  const jsMainMs = performance.now() - t0;
  const budgetMs = (128 / TV.sampleRate) * 1000;
  const data = {
    blocks, budgetMsPerBlock: budgetMs,
    worklet,
    mainThread: {
      wasmPerBlockUs: (wasmMainMs / blocks) * 1000,
      jsReferencePerBlockUs: (jsMainMs / blocks) * 1000,
      note: 'JS reference allocates a Float32Array per call; indicative only.',
    },
  };
  return result('kernel-benchmark', 'performance', [
    check('worklet benchmark ran', worklet && worklet.ok, worklet),
    check('single-instance kernel cost < 5% of render-quantum budget (audio thread)', worklet && worklet.ok && worklet.budgetFraction < 0.05, worklet && worklet.budgetFraction),
  ], data);
}

/** Performance: offline render throughput of N worklet instances vs native nodes. */
export async function offlineThroughput({ instances = 16, seconds = 30 } = {}) {
  const sr = TV.sampleRate;
  const run = async useWorklet => {
    const ctx = new OfflineAudioContext(2, sr * seconds, sr);
    const src = makeLoopingSource(ctx);
    const handles = [];
    for (let i = 0; i < instances; i++) {
      if (useWorklet) {
        const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS });
        if (!gf.ok) throw new Error(`instance ${i}: ${gf.stage}`);
        src.connect(gf.node).connect(ctx.destination);
        handles.push(gf);
      } else {
        const g = ctx.createGain(); g.gain.value = TV.gain;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200; f.Q.value = -3.0103; // Web Audio lowpass Q is in dB: 20*log10(0.7071)
        src.connect(g).connect(f).connect(ctx.destination);
      }
    }
    src.start();
    const t0 = performance.now();
    await ctx.startRendering();
    const ms = performance.now() - t0;
    for (const h of handles) await h.dispose();
    return { wallMs: ms, realtimeFactor: (seconds * 1000) / ms };
  };
  const worklet = await run(true);
  const native = await run(false);
  return result('offline-throughput', 'performance', [
    check(`${instances} worklet instances render faster than real time offline`, worklet.realtimeFactor > 1, worklet.realtimeFactor),
  ], { instances, audioSeconds: seconds, worklet, nativeGainBiquad: native, note: 'Offline throughput includes Web Audio graph overhead; it is NOT a real-time dropout measurement.' });
}

/** Performance + live: sustained real-time processing with N instances. */
export async function sustainedLive({ instances = 16, seconds = 20, lagThresholdMs = 50, cpuBudgetFraction = 0.5 } = {}) {
  const ctx = await newLiveContext();
  const checks = [check('AudioContext running', ctx.state === 'running', ctx.state)];
  const src = makeLoopingSource(ctx);
  const sum = ctx.createGain();
  sum.gain.value = 0.02 / instances;
  sum.connect(ctx.destination);
  const handles = [];
  for (let i = 0; i < instances; i++) {
    const gf = await createGainFilter(ctx, { workletUrl: WORKLET_URL, wasmBytes: wasmBytes(), params: PARAMS, lagThresholdMs });
    if (!gf.ok) { checks.push(check(`instance ${i} ready`, false, gf)); break; }
    src.connect(gf.node).connect(sum);
    handles.push(gf);
  }
  checks.push(check(`${instances} instances ready`, handles.length === instances, handles.length));
  src.start();
  await sleep(1000); // warm-up excluded from measurement
  await Promise.all(handles.map(h => h.resetStats()));
  const ct0 = ctx.currentTime;
  const w0 = performance.now();
  // Light main-thread activity during the run, like a UI would generate.
  let mainTicks = 0;
  const ticker = setInterval(() => { mainTicks++; }, 16);
  await sleep(seconds * 1000);
  clearInterval(ticker);
  const stats = await Promise.all(handles.map(h => h.getStats()));
  const wallMs = performance.now() - w0;
  const audioMs = (ctx.currentTime - ct0) * 1000;
  const info = contextInfo(ctx);
  for (const h of handles) await h.dispose();
  try { src.stop(); } catch { /* ignore */ }
  await ctx.close();

  const budgetMs = (128 / TV.sampleRate) * 1000;
  const agg = {
    clock: stats[0] && stats[0].clock,
    blocksPerInstance: stats[0] && stats[0].blocks,
    expectedBlocks: Math.round((wallMs / 1000) * TV.sampleRate / 128),
    totalProcMeanMsPerQuantum: stats.reduce((n, s) => n + (s.procMeanMs || 0), 0),
    worstProcMaxMs: Math.max(...stats.map(s => s.procMaxMs || 0)),
    overBudgetBlocks: stats.reduce((n, s) => n + (s.overBudgetBlocks || 0), 0),
    lagExceedances: Math.max(...stats.map(s => s.lagExceedances || 0)),
    maxLagMs: Math.max(...stats.map(s => s.maxLagMs || 0)),
    lostMs: Math.max(...stats.map(s => s.lostMs || 0)),
    frameDiscontinuities: stats.reduce((n, s) => n + (s.frameDiscontinuities || 0), 0),
    nonFiniteOut: stats.reduce((n, s) => n + (s.nonFiniteOut || 0), 0),
    kernelErrors: stats.reduce((n, s) => n + (s.kernelErrors || 0), 0),
  };
  agg.cpuFractionOfQuantum = agg.totalProcMeanMsPerQuantum / budgetMs;
  agg.audioClockVsWall = audioMs / wallMs;
  checks.push(check('rendered >= 95% of wall-clock blocks', agg.blocksPerInstance >= 0.95 * agg.expectedBlocks, { blocks: agg.blocksPerInstance, expected: agg.expectedBlocks }));
  checks.push(check(`no detected dropouts (render lag never > ${lagThresholdMs} ms)`, agg.lagExceedances === 0, { lagExceedances: agg.lagExceedances, maxLagMs: agg.maxLagMs }));
  checks.push(check('no processing overruns (no block exceeded the quantum budget)', agg.overBudgetBlocks === 0, { overBudgetBlocks: agg.overBudgetBlocks, worstProcMaxMs: agg.worstProcMaxMs, clock: agg.clock }));
  checks.push(check(`total worklet DSP time <= ${cpuBudgetFraction * 100}% of quantum budget`, agg.cpuFractionOfQuantum <= cpuBudgetFraction, agg.cpuFractionOfQuantum));
  checks.push(check('no non-finite output, kernel errors or frame discontinuities', agg.nonFiniteOut === 0 && agg.kernelErrors === 0 && agg.frameDiscontinuities === 0, { nonFinite: agg.nonFiniteOut, kernelErrors: agg.kernelErrors, discontinuities: agg.frameDiscontinuities }));
  return result('sustained-live', 'performance', checks, {
    instances, seconds, lagThresholdMs, cpuBudgetFraction, budgetMsPerQuantum: budgetMs, wallMs, audioMs, mainTicks, context: info, aggregate: agg,
  });
}

const SUITES = {
  default: ['capabilities', 'parityWasmDirect', 'parityWorkletOffline', 'liveLifecycle', 'failureModes', 'kernelBenchmark', 'offlineThroughput', 'sustainedLive'],
  csp: ['capabilities', 'cspProbe'],
};
const TESTS = { capabilities, parityWasmDirect, parityWorkletOffline, liveLifecycle, failureModes, cspProbe, kernelBenchmark, offlineThroughput, sustainedLive };

/** Run a named suite (or explicit list). Never throws; failures are reported per test. */
export async function runAll(options = {}) {
  const names = options.tests || SUITES[options.suite || 'default'];
  const out = { environment: await environment(), startedAt: new Date().toISOString(), options, results: [] };
  for (const name of names) {
    const t0 = performance.now();
    let r;
    try {
      r = await TESTS[name](options[name] || {});
    } catch (err) {
      r = result(name, 'error', [check('test executed without throwing', false, `${err && err.name}: ${err && err.message}`)]);
    }
    r.durationMs = Math.round(performance.now() - t0);
    out.results.push(r);
    if (options.onProgress) options.onProgress(r);
  }
  out.pass = out.results.every(r => r.pass);
  out.finishedAt = new Date().toISOString();
  return out;
}

globalThis.apexSpike = { runAll, environment, ...TESTS };
