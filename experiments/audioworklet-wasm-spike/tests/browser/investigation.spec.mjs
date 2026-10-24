// Follow-up investigation of the "Cannot allocate Wasm memory" failure and the
// single-engine layouts. Every case runs in a FRESH browser context (= fresh
// renderer process; the WebAssembly memory budget is per renderer process).
//
// Assertions are of two kinds, labelled in each test name:
//   [must]  — behaviour the design relies on (parity, CSP requirement, engine init)
//   [char]  — characterisation of the current browser: documents observed limits
//             so a future browser change shows up as a test failure, not silently.
// Raw results are written to results/<project>-investigation-*.json.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultsDir = join(spikeRoot, 'results');
mkdirSync(resultsDir, { recursive: true });
const compareSeconds = Number(process.env.SPIKE_COMPARE_SECONDS || 15);
const COUNTS = (process.env.SPIKE_COMPARE_COUNTS || '16,64,128,256,512').split(',').map(Number);

function save(testInfo, name, payload) {
  const file = join(resultsDir, `${testInfo.project.name}-investigation-${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return testInfo.attach(name, { path: file, contentType: 'application/json' });
}

// Compact key results, emitted as GitHub Actions ::notice annotations at the end
// of the file so they are readable via the check-runs API even when artifacts and
// logs are not (max 10 notices per step; we emit at most 9 per browser).
const NOTES = { probes: {}, compare: [], csp: {}, churn: {} };
function note(key, value) { NOTES[key] = value; }
test.afterAll(async ({}, testInfo) => {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const esc = v => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const p = testInfo.project.name;
  const emit = (topic, obj) => console.log(`::notice title=spike-investigation ${p} ${topic}::${esc(typeof obj === 'string' ? obj : JSON.stringify(obj))}`);
  emit('env', { browser: NOTES.browserVersion, platform: process.platform, arch: process.arch });
  emit('probes', NOTES.probes);
  if (NOTES.flags) emit('flags', NOTES.flags);
  emit('lifecycle', { reclaim: NOTES.reclaim, crossIsolate: NOTES.crossIsolate, escape: NOTES.escape, churn: NOTES.churn });
  if (NOTES.offline) emit('offline-renders', NOTES.offline);
  if (NOTES.parity) emit('engine-parity', NOTES.parity);
  emit('compare', NOTES.compare.join(' | '));
  emit('csp', NOTES.csp);
});

async function open(page, mode = 'csp-none') {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('crash', () => errors.push('PAGE CRASHED'));
  await page.goto(`/${mode}/web/index.html`);
  return errors;
}
const inv = (page, fn, arg) => page.evaluate(async ({ fn, arg }) => (await import(new URL('./investigation.mjs', location.href).href))[fn](arg), { fn, arg });
const rep = (page, fn, ...args) => page.evaluate(async ({ fn, args }) => (await import(new URL('./repro.mjs', location.href).href))[fn](...args), { fn, args });

/** Launch a separate browser of the same project with extra --js-flags. */
async function launchWithJsFlags(playwright, testInfo, jsFlags) {
  const use = testInfo.project.use;
  const base = use.launchOptions || {};
  return playwright.chromium.launch({ ...base, channel: use.channel, headless: true, args: [...(base.args || []), `--js-flags=${jsFlags}`] });
}

/** Sum of VmRSS over renderer processes (Linux /proc only; null elsewhere). */
async function rendererRssMB(browser) {
  if (process.platform !== 'linux') return null;
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach();
    let kb = 0;
    for (const p of processInfo.filter(x => x.type === 'renderer')) {
      const f = `/proc/${p.id}/status`;
      if (!existsSync(f)) continue;
      const m = readFileSync(f, 'utf8').match(/VmRSS:\s+(\d+) kB/);
      if (m) kb += Number(m[1]);
    }
    return Math.round(kb / 102.4) / 10;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
test.describe('1. minimal reproduction (main thread, no audio)', () => {
  for (const kind of ['memory-1page', 'memory-1page-max1', 'memory-shared-max1', 'memory64-1page', 'instance-own-memory', 'instance-no-memory', 'instance-imports-one-shared-memory', 'arraybuffer-64k']) {
    test(`[char] probe ${kind}`, async ({ page }, testInfo) => {
      const errors = await open(page);
      expect(await rep(page, 'validateProbeModules')).toEqual({ noMemory: true, ownMemory: true, importsMemory: true });
      const r = await rep(page, 'probe', kind, 1000);
      await save(testInfo, `probe-${kind}`, r);
      NOTES.probes[kind] = r.created;
      NOTES.browserVersion = NOTES.browserVersion || page.context().browser().version();
      console.log(`[${testInfo.project.name}] probe ${kind}: created=${r.created} error=${r.error}`);
      expect(errors).toEqual([]);
      if (kind === 'memory64-1page') { expect(r.created).toBeGreaterThan(40); expect(r.created).toBeLessThan(80); }
      else if (['instance-no-memory', 'instance-imports-one-shared-memory', 'arraybuffer-64k'].includes(kind)) expect(r.created).toBe(1000);
      else { expect(r.created).toBeGreaterThanOrEqual(100); expect(r.created).toBeLessThan(140); }
    });
  }

  test('[char] --js-flags reach V8 (expose-gc canary); --wasm-enforce-bounds-checks does not change the cap; GC reclaims unreferenced memories', async ({ playwright }, testInfo) => {
    const out = {};
    for (const [label, flags] of [['expose-gc', '--expose-gc'], ['expose-gc+enforce-bounds', '--expose-gc --wasm-enforce-bounds-checks']]) {
      const b = await launchWithJsFlags(playwright, testInfo, flags);
      const page = await (await b.newContext({ baseURL: testInfo.project.use.baseURL })).newPage();
      await open(page);
      const gcAvailable = await page.evaluate(() => typeof globalThis.gc === 'function');
      const first = await rep(page, 'probe', 'memory-1page', 1000);
      const release = await rep(page, 'releaseAll', { forceGc: true });
      const second = await rep(page, 'probe', 'memory-1page', 1000);
      out[label] = { gcAvailable, first: first.created, release, afterReleaseAndGc: second.created };
      await b.close();
    }
    await save(testInfo, 'flags', out);
    note('flags', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { gc: v.gcAvailable, cap: v.first, afterGc: v.afterReleaseAndGc }])));
    console.log(`[${testInfo.project.name}] flags: ${JSON.stringify(out)}`);
    expect(out['expose-gc'].gcAvailable).toBe(true);
    expect(Math.abs(out['expose-gc+enforce-bounds'].first - out['expose-gc'].first)).toBeLessThanOrEqual(2);
    expect(out['expose-gc'].afterReleaseAndGc).toBeGreaterThanOrEqual(out['expose-gc'].first - 2);
  });
});

// ---------------------------------------------------------------------------
test.describe('2. worklet lifecycle: when are per-node memories reclaimed?', () => {
  test('[char] reclaim scenarios (100 per-node instances each)', async ({ playwright }, testInfo) => {
    const b = await launchWithJsFlags(playwright, testInfo, '--expose-gc');
    const out = [];
    for (const scenario of ['offline-unrendered', 'offline-unrendered-forced-gc', 'offline-rendered', 'realtime-close']) {
      const ctx = await b.newContext({ baseURL: testInfo.project.use.baseURL });
      const page = await ctx.newPage();
      await open(page);
      out.push(await inv(page, 'reclaimScenario', { scenario }));
      await ctx.close();
    }
    await b.close();
    await save(testInfo, 'reclaim', out);
    note('reclaim', Object.fromEntries(out.map(r => [r.scenario, r.mainThreadMemoriesCreatableAfter])));
    for (const r of out) console.log(`[${testInfo.project.name}] reclaim ${r.scenario}: created=${r.created} main-thread memories creatable afterwards=${r.mainThreadMemoriesCreatableAfter}`);
    const by = Object.fromEntries(out.map(r => [r.scenario, r.mainThreadMemoriesCreatableAfter]));
    expect(by['offline-unrendered']).toBeLessThan(40);
    expect(by['offline-unrendered-forced-gc']).toBeLessThan(40);
    expect(by['offline-rendered']).toBeLessThan(40);
    expect(by['realtime-close']).toBeGreaterThanOrEqual(110);
  });

  for (const design of ['per-node', 'engine-nodes', 'engine-bank']) {
    test(`[char] churn in one live context, 10 x 100 create/dispose: ${design}`, async ({ page }, testInfo) => {
      const errors = await open(page);
      const r = await inv(page, 'churn', { design, rounds: 10, perRound: 100 });
      await save(testInfo, `churn-${design}`, r);
      NOTES.churn[design] = `${r.totalReady}/${r.totalAttempted}`;
      console.log(`[${testInfo.project.name}] churn ${design}: ${r.totalReady}/${r.totalAttempted} ready; per round ${JSON.stringify(r.perRoundResults.map(x => x.unitsReady))}`);
      expect(errors).toEqual([]);
      expect(r.allOk).toBe(true);
      if (design !== 'per-node') expect(r.perRoundResults.every(x => x.engineLiveSlotsAfterDispose === 0)).toBe(true);
    });
  }

  test('[char] repeated OfflineAudioContext renders exhaust the budget for EVERY layout (one memory per offline worklet scope is retained)', async ({ page }, testInfo) => {
    const errors = await open(page);
    const out = {};
    out['per-node'] = await inv(page, 'offlineRenders', { design: 'per-node', renders: 40, units: 16 });
    await page.reload();
    out['engine-nodes'] = await inv(page, 'offlineRenders', { design: 'engine-nodes', renders: 200, units: 16 });
    const afterExhaustion = await rep(page, 'probe', 'memory-1page', 200); // creates 0 when exhausted, so leaves no garbage
    // A new document in the same renderer frees the retained offline worklet scopes.
    // (No main-thread probe before the next worklet run: main-thread garbage is not
    // reclaimable by a worklet allocation; see the cross-isolate test.)
    await page.reload();
    out['engine-bank'] = await inv(page, 'offlineRenders', { design: 'engine-bank', renders: 200, units: 16 });
    await page.reload();
    out.afterReload = await rep(page, 'probe', 'memory-1page', 200);
    out.mainThreadMemoriesAfterEngineExhaustion = afterExhaustion.created;
    await save(testInfo, 'offline-renders', out);
    note('offline', { perNode: out['per-node'].completed, engineNodes: out['engine-nodes'].completed, engineBank: out['engine-bank'].completed, afterExhaustion: out.mainThreadMemoriesAfterEngineExhaustion, afterReload: out.afterReload.created });
    console.log(`[${testInfo.project.name}] offline renders: per-node ${out['per-node'].completed}/40, engine-nodes ${out['engine-nodes'].completed}/200, engine-bank ${out['engine-bank'].completed}/200; main-thread memories after exhaustion ${afterExhaustion.created}, after reload ${out.afterReload.created}`);
    expect(errors).toEqual([]);
    expect(out['per-node'].completed).toBeLessThan(10);
    expect(out['engine-nodes'].completed).toBeGreaterThanOrEqual(100);
    expect(out['engine-nodes'].completed).toBeLessThan(140);
    expect(out['engine-bank'].completed).toBeGreaterThanOrEqual(100);
    expect(out['engine-bank'].completed).toBeLessThan(140);
    expect(afterExhaustion.created).toBe(0);
    expect(out.afterReload.created).toBeGreaterThanOrEqual(110);
  });

  test('[char] cross-isolate: unreferenced main-thread memories block worklet allocation until a MAIN-thread GC runs', async ({ playwright }, testInfo) => {
    const b = await launchWithJsFlags(playwright, testInfo, '--expose-gc');
    const page = await (await b.newContext({ baseURL: testInfo.project.use.baseURL })).newPage();
    await open(page);
    const r = await page.evaluate(async () => {
      const I = await import(new URL('./investigation.mjs', location.href).href);
      const P = await import(new URL('./repro.mjs', location.href).href);
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const tryWorklet = async () => {
        const ctx = new AudioContext();
        const u = await I.createUnits(ctx, 'engine-nodes', 1);
        for (const h of u.handles) await h.dispose();
        await ctx.close();
        return u.unitsReady === 1 ? 'ok' : `fail: ${u.failure.error && u.failure.error.message}`;
      };
      const held = P.probe('memory-1page', 200).created;
      const whileHeld = await tryWorklet();
      await P.releaseAll({ forceGc: false });
      const afterDropNoGc = await tryWorklet();
      await sleep(3000);
      const afterDrop3sIdle = await tryWorklet();
      globalThis.gc(); globalThis.gc();
      const afterMainThreadGc = await tryWorklet();
      return { held, whileHeld, afterDropNoGc, afterDrop3sIdle, afterMainThreadGc };
    });
    await b.close();
    await save(testInfo, 'cross-isolate', r);
    note('crossIsolate', { whileHeld: r.whileHeld.slice(0, 4), afterDropNoGc: r.afterDropNoGc.slice(0, 4), afterDrop3sIdle: r.afterDrop3sIdle.slice(0, 4), afterMainThreadGc: r.afterMainThreadGc.slice(0, 4) });
    console.log(`[${testInfo.project.name}] cross-isolate: ${JSON.stringify(r)}`);
    expect(r.whileHeld).toMatch(/^fail/);
    expect(r.afterDropNoGc).toMatch(/^fail/);
    expect(r.afterMainThreadGc).toBe('ok');
  });

  test('[char] escape routes: terminated Workers and closed realtime contexts release their memories', async ({ page }, testInfo) => {
    const errors = await open(page);
    const r = await page.evaluate(async () => {
      const I = await import(new URL('./investigation.mjs', location.href).href);
      const P = await import(new URL('./repro.mjs', location.href).href);
      const src = URL.createObjectURL(new Blob(["try { self.m = new WebAssembly.Memory({ initial: 2, maximum: 2 }); postMessage('ok'); } catch (e) { postMessage('fail: ' + e.message); }"], { type: 'text/javascript' }));
      let workers = 0;
      for (let i = 0; i < 200; i++) {
        const w = new Worker(src);
        const msg = await new Promise(res => { w.onmessage = e => res(e.data); w.onerror = e => res(`error ${e.message}`); });
        w.terminate();
        if (msg !== 'ok') break;
        workers++;
      }
      let realtime = 0;
      for (let i = 0; i < 150; i++) {
        const ctx = new AudioContext();
        const u = await I.createUnits(ctx, 'engine-nodes', 4);
        for (const h of u.handles) await h.dispose();
        await ctx.close();
        if (u.unitsReady !== 4) break;
        realtime++;
      }
      return { workersSequential: workers, realtimeOpenCloseCycles: realtime, mainThreadMemoriesAfter: P.probe('memory-1page', 200).created };
    });
    await save(testInfo, 'escape-routes', r);
    note('escape', r);
    console.log(`[${testInfo.project.name}] escape routes: ${JSON.stringify(r)}`);
    expect(errors).toEqual([]);
    expect(r.workersSequential).toBe(200);
    expect(r.realtimeOpenCloseCycles).toBe(150);
    expect(r.mainThreadMemoriesAfter).toBeGreaterThanOrEqual(110);
  });
});

// ---------------------------------------------------------------------------
test.describe('3. single-engine layouts', () => {
  test('[must] engine parity in a real AudioWorklet: shared slots bit-exact, bank bit-exact, slots released on dispose', async ({ page }, testInfo) => {
    const errors = await open(page);
    const r = await inv(page, 'engineParity');
    await save(testInfo, 'engine-parity', r);
    note('parity', r.checks);
    console.log(`[${testInfo.project.name}] engine parity: ${JSON.stringify(r.checks)}`);
    expect(errors).toEqual([]);
    expect(r.checks).toEqual({ sharedEngine: true, distinctSlots: true, unit0Golden: true, unit1MatchesItsOwnReference: true, unit2Golden: true, slotsReleasedOnDispose: true, bankGolden: true });
  });

  for (const design of ['per-node', 'engine-nodes', 'engine-bank']) {
    for (const count of COUNTS) {
      test(`[char] compare ${design} x ${count} units (${compareSeconds}s live)`, async ({ page, browser }, testInfo) => {
        const errors = await open(page);
        const rssBaseline = await rendererRssMB(browser);
        let rssPeak = rssBaseline;
        const sampler = setInterval(async () => { const v = await rendererRssMB(browser); if (v !== null && (rssPeak === null || v > rssPeak)) rssPeak = v; }, 500);
        let r;
        try { r = await inv(page, 'designCompare', { design, count, seconds: compareSeconds }); }
        finally { clearInterval(sampler); }
        r.memory.rendererRssMB = { baseline: rssBaseline, peak: rssPeak, note: 'sum of VmRSS over renderer processes (Linux /proc), sampled every 500 ms' };
        await save(testInfo, `compare-${design}-${count}`, r);
        const s = r.sustained;
        NOTES.compare.push(`${design}x${count}: init ${r.init.ok ? 'OK' : `FAIL@${r.init.unitsReady}`} mem ${r.memory.wasmMemories} head ${r.memory.headroomMemoriesWhileLive}`
          + (s ? ` cpu ${(s.cpuFractionOfQuantum * 100).toFixed(1)}% rend ${(s.renderedFraction * 100).toFixed(0)}% ovr ${s.overBudgetBlocks} lag ${s.lagExceedances} und ${s.playbackStats ? s.playbackStats.underrunEvents : 'na'}` : ''));
        console.log(`[${testInfo.project.name}] ${design} x${count}: init ${r.init.ok ? 'OK' : 'FAIL'} ${r.init.unitsReady}/${count} in ${r.init.totalMs} ms${r.init.failure ? ` (${r.init.failure.error && r.init.failure.error.message})` : ''}; memories ${r.memory.wasmMemories}, headroom ${r.memory.headroomMemoriesWhileLive}; RSS ${rssBaseline}->${rssPeak} MB; `
          + (s ? `live cpu ${(s.cpuFractionOfQuantum * 100).toFixed(2)}% rendered ${(s.renderedFraction * 100).toFixed(1)}% overruns ${s.overBudgetBlocks} lag>50ms ${s.lagExceedances} underruns ${s.playbackStats && s.playbackStats.underrunEvents} healthy ${s.healthy}` : 'live NOT RUN (init failed)'));
        expect(errors).toEqual([]);
        if (design === 'per-node') {
          // Characterisation of the original layout: init succeeds below the ~125 memory budget only.
          expect(r.init.ok).toBe(count < 120);
        } else {
          // [must] for the engine layouts: initialization succeeds at every tested count with ONE memory.
          expect(r.init.ok).toBe(true);
          expect(r.memory.wasmMemories).toBe(1);
          expect(r.memory.engineAfterDispose.liveSlots).toBe(0);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
test.describe('4. CSP: exact requirement (production policy copied from electron.cjs)', () => {
  // Expected outcome per mode: [eval, mainThread, worklet per-node, worklet engine, dedicated Worker]
  const EXPECT = {
    'csp-none': [true, true, true, true, true],
    'csp-production': [false, false, false, false, false],
    'csp-production-wasm': [false, true, true, true, true],
    'csp-production-wasm-default-src-only': [false, false, false, false, false],
    'csp-production-unsafe-eval': [true, true, true, true, true],
    // Worklets follow the DOCUMENT's policy; dedicated Workers follow their script response's policy.
    'csp-split-docwasm-scriptprod': [false, true, true, true, false],
    'csp-split-docprod-scriptwasm': [false, false, false, false, true],
  };
  for (const [mode, expected] of Object.entries(EXPECT)) {
    test(`[must] ${mode}`, async ({ page }, testInfo) => {
      const errors = await open(page, mode);
      const r = await inv(page, 'cspMatrix');
      await save(testInfo, `csp-${mode}`, r);
      const got = [!r.evalBlocked, r.mainThread.ok, r.workletPerNode.ok, r.workletEngine.ok, r.worker.ok];
      NOTES.csp[mode.replace(/^csp-/, '')] = got.map(Number).join('');
      console.log(`[${testInfo.project.name}] ${mode}: eval=${got[0]} main=${got[1]} worklet=${got[2]} engine=${got[3]} worker=${got[4]} violations=${JSON.stringify([...new Set(r.violations.map(v => v.directive))])}`);
      expect(errors).toEqual([]);
      expect(got).toEqual(expected);
    });
  }
});
