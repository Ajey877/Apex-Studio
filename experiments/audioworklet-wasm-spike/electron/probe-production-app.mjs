#!/usr/bin/env node
// Probes the CSP of the ACTUAL packaged production Apex Studio app (EXPERIMENTAL).
//
// It does not modify any production file or setting. It:
//   1. builds the production web bundle (`vite build`, the same as `npm run build`),
//   2. packages the unmodified production app with the repo-root electron-builder
//      config (`--dir`, asar), writing ONLY into this spike's results/prod-app,
//   3. launches the packaged exe with Chromium's --remote-debugging-port and a
//      throwaway --user-data-dir, and
//   4. evaluates read-only probes in the production renderer over the DevTools
//      protocol: is CSP enforced (DOM-injected inline script), is WebAssembly compilation
//      blocked, how many WebAssembly.Memory objects fit, and related capabilities.
//
// Probes run as DevTools-evaluated scripts. The probe expression is validated
// against Chromium pages with known CSPs by
// tests/browser/production-probe-method.spec.mjs.
//
//   node electron/probe-production-app.mjs            # build + package + probe (Windows CI)
//   node electron/probe-production-app.mjs --no-build # reuse results/prod-app
//
// Never throws to the caller; always returns/prints a result object.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(spikeRoot, '..', '..');
const resultsDir = join(spikeRoot, 'results');
const outDir = join(resultsDir, 'prod-app');

// Read-only probe evaluated in the renderer. Returns a JSON-serialisable object.
export const PROBE_EXPRESSION = `(async () => {
  const r = { href: location.href, title: document.title, readyState: document.readyState,
    metaCsp: !!document.querySelector('meta[http-equiv="Content-Security-Policy" i]') };
  const violations = [];
  const onViolation = e => { if (violations.length < 8) violations.push(e.violatedDirective + ' ' + (e.blockedURI || '')); };
  document.addEventListener('securitypolicyviolation', onViolation);
  const t = (fn) => { try { fn(); return 'allowed'; } catch (e) { return 'blocked: ' + e.name; } };
  // NOTE: DevTools-evaluated code is exempt from CSP for eval/new Function (verified by
  // tests/browser/production-probe-method.spec.mjs), so these are recorded but are NOT
  // CSP indicators. The indicator is a DOM-injected inline <script>, which CSP checks
  // when the element is prepared regardless of who inserted it.
  r.evalFromDevtools = t(() => eval('1'));
  r.newFunctionFromDevtools = t(() => new Function('return 1')());
  globalThis.__apexProbeInline = false;
  const s = document.createElement('script');
  s.textContent = 'globalThis.__apexProbeInline = true;';
  document.head.appendChild(s); s.remove();
  r.inlineScript = globalThis.__apexProbeInline ? 'allowed' : 'blocked';
  delete globalThis.__apexProbeInline;
  const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  try { await WebAssembly.compile(empty); r.wasmCompile = 'allowed'; }
  catch (e) { r.wasmCompile = 'blocked: ' + e.name + ': ' + String(e.message).slice(0, 180); }
  try { new WebAssembly.Module(empty); r.wasmModuleSync = 'allowed'; } catch (e) { r.wasmModuleSync = 'blocked: ' + e.name; }
  try { await WebAssembly.instantiate(empty); r.wasmInstantiate = 'allowed'; } catch (e) { r.wasmInstantiate = 'blocked: ' + e.name; }
  // CSP does not govern WebAssembly.Memory; this measures the renderer's memory budget.
  const mems = []; let memErr = null;
  try { for (let i = 0; i < 400; i++) mems.push(new WebAssembly.Memory({ initial: 1 })); } catch (e) { memErr = String(e.message).slice(0, 120); }
  r.memoryCap = mems.length; r.memoryCapError = memErr; mems.length = 0;
  r.audioWorkletNode = typeof AudioWorkletNode !== 'undefined';
  r.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  r.crossOriginIsolated = globalThis.crossOriginIsolated === true;
  r.userAgent = navigator.userAgent;
  await new Promise(res => setTimeout(res, 200));
  document.removeEventListener('securitypolicyviolation', onViolation);
  r.violations = violations;
  return r;
})()`;

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Minimal CDP client over Node's global WebSocket (Node >= 22). */
async function cdpEvaluate(wsUrl, expression, timeoutMs = 60_000) {
  if (typeof WebSocket === 'undefined') throw new Error('global WebSocket unavailable (needs Node >= 22)');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket error')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    pending.set(myId, msg => { clearTimeout(timer); msg.error ? rej(new Error(`CDP ${method}: ${msg.error.message}`)) : res(msg.result); });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  try {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`probe threw: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    return result.result.value;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

/**
 * Wait for a page target whose URL matches `match`, wait until it has loaded,
 * then evaluate PROBE_EXPRESSION in it. Exported for the method-validation test.
 */
export async function probeViaCdp({ port, match = url => url.startsWith('file:'), timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find(t => t.type === 'page' && match(t.url));
      if (target) {
        const state = await cdpEvaluate(target.webSocketDebuggerUrl, 'document.readyState', 10_000);
        if (state === 'complete') break;
      }
    } catch (err) { lastErr = err; }
    target = null;
    await sleep(1000);
  }
  if (!target) throw new Error(`no loaded page target matched within ${timeoutMs} ms${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
  await sleep(1500); // let the app's own startup scripts settle
  let version = null;
  try { version = await getJson(`http://127.0.0.1:${port}/json/version`); } catch { /* optional */ }
  const value = await cdpEvaluate(target.webSocketDebuggerUrl, PROBE_EXPRESSION);
  return { targetUrl: target.url, browser: version && version.Browser, ...value };
}

function run(cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return { status: r.status, signal: r.signal, error: r.error && r.error.message, ms: Date.now() - t0 };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

export async function probeProductionApp({ build = true, port = 9339 } = {}) {
  const result = { what: 'actual packaged production Apex Studio app (unmodified), CSP probe', platform: process.platform, steps: {} };
  try {
    if (build) {
      // 1. Production web bundle -> repo-root dist/ (as `npm run build`).
      const vite = join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
      result.steps.viteBuild = run(process.execPath, [vite, 'build'], { cwd: repoRoot });
      if (result.steps.viteBuild.status !== 0) throw new Error('vite build failed');
      // 2. Package with the repo-root electron-builder config; output redirected into the spike.
      rmSync(outDir, { recursive: true, force: true });
      const builder = join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
      const platformFlag = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
      result.steps.package = run(process.execPath, [builder, platformFlag, '--x64', '--dir', '--publish', 'never', '--projectDir', repoRoot, `--config.directories.output=${outDir}`], { cwd: repoRoot });
      if (result.steps.package.status !== 0) throw new Error('electron-builder failed');
    }
    // 3. Locate and launch the packaged exe.
    const unpacked = existsSync(outDir) && readdirSync(outDir).find(d => /-unpacked$/.test(d));
    const dir = unpacked && join(outDir, unpacked);
    const exeName = dir && readdirSync(dir).find(f => (process.platform === 'win32' ? /^Apex Studio.*\.exe$/i.test(f) : /^apex/i.test(f)));
    if (!exeName) throw new Error(`packaged production exe not found under ${outDir}`);
    result.exe = join(dir, exeName);
    const userData = mkdtempSync(join(tmpdir(), 'apex-prod-probe-'));
    const t0 = Date.now();
    const child = spawn(result.exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
      stdio: 'ignore', detached: process.platform !== 'win32', env: { ...process.env, NODE_ENV: 'production', ELECTRON_START_URL: '' },
    });
    result.steps.launch = { pid: child.pid };
    try {
      // 4. Probe the production renderer.
      result.probe = await probeViaCdp({ port });
      result.steps.probe = { ok: true, ms: Date.now() - t0 };
    } finally {
      killTree(child);
      await sleep(500);
      try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    result.error = `${err && err.name}: ${err && err.message}`;
  }
  const p = result.probe;
  result.verdict = p
    ? `production app ${p.href}: CSP enforced=${p.inlineScript === 'blocked'} (inline <script> ${p.inlineScript}; violations ${JSON.stringify(p.violations)}); `
      + `WebAssembly.compile ${p.wasmCompile.split(':')[0]}; Module ${p.wasmModuleSync}; instantiate ${p.wasmInstantiate.split(':')[0]}; `
      + `meta CSP tag=${p.metaCsp}; WebAssembly.Memory cap=${p.memoryCap}`
    : `NOT RUN / FAILED: ${result.error}`;
  try { mkdirSync(resultsDir, { recursive: true }); writeFileSync(join(resultsDir, 'production-app-probe.json'), JSON.stringify(result, null, 2)); } catch { /* ignore */ }
  console.log(`[spike-prod-probe] ${result.verdict}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  probeProductionApp({ build: !process.argv.includes('--no-build') }).then(r => { process.exitCode = r.probe ? 0 : 1; });
}
