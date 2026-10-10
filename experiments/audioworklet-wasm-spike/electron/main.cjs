// Apex Studio — AudioWorklet + WASM spike: Electron runner (EXPERIMENTAL).
//
// Loads web/index.html over file:// (as the packaged app loads dist/index.html)
// with the SAME command-line switches, sandboxing, webPreferences and CSP
// mechanism as the production electron.cjs, runs the in-page harness, writes a
// JSON report and exits. It does not load or touch the production app.
//
//   electron electron/main.cjs --csp=none|production|production-wasm --suite=default|csp|investigation --out=<file>
//
// Env: SPIKE_INSTANCES, SPIKE_SECONDS (sustained load), SPIKE_ELECTRON_HIDDEN=1,
//      SPIKE_COMPARE_SECONDS, SPIKE_ELECTRON_COMPARE (investigation suite)
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const cspMode = arg('csp', 'none');
const suite = arg('suite', cspMode === 'none' ? 'default' : 'csp');
const outFile = arg('out', path.join(process.cwd(), `electron-${cspMode}.json`));
const instances = Number(process.env.SPIKE_INSTANCES || 16);
const seconds = Number(process.env.SPIKE_SECONDS || 20);

// Same Chromium audio switches as electron.cjs (registered before ready).
app.commandLine.appendSwitch('enable-exclusive-audio');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-wave-audio');
app.enableSandbox();

// Locate the web harness both unpackaged (../web) and packaged (inside app.asar).
const webIndex = [path.join(__dirname, 'web', 'index.html'), path.join(__dirname, '..', 'web', 'index.html')]
  .find(p => fs.existsSync(p));

const PRODUCTION_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self' https:", "worker-src 'self' blob:", "object-src 'none'",
  "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
];
const CSP = {
  none: null,
  production: PRODUCTION_CSP.join('; '),
  'production-wasm': PRODUCTION_CSP.map(d => (d === "script-src 'self'" ? "script-src 'self' 'wasm-unsafe-eval'" : d)).join('; '),
}[cspMode];

const report = {
  runner: 'electron',
  cspMode,
  suite,
  packaged: app.isPackaged,
  versions: { ...process.versions },
  platform: process.platform,
  arch: process.arch,
  osRelease: require('os').release(),
  cpus: require('os').cpus().map(c => c.model)[0],
  cpuCount: require('os').cpus().length,
  webIndex,
  headerHook: { installed: !!CSP, calls: 0, fileUrlCalls: 0, sampleUrls: [] },
  renderer: { consoleErrors: [], gone: null, loadFailure: null },
  harness: null,
  error: null,
};

function finish(code) {
  report.exitCode = code;
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  } catch (err) {
    console.error('[spike-electron] could not write report:', err);
  }
  console.log(`[spike-electron] csp=${cspMode} suite=${suite} packaged=${app.isPackaged} exit=${code} -> ${outFile}`);
  setTimeout(() => app.exit(code), 50);
}

const WATCHDOG_MS = suite === 'investigation' ? 900_000 : 300_000;
const watchdog = setTimeout(() => {
  report.error = `watchdog timeout (${WATCHDOG_MS / 1000} s)`;
  finish(3);
}, WATCHDOG_MS);

// Follow-up investigation inside Electron. Every step starts from a FRESH
// document (loadFile) because offline worklet scopes keep their WASM memory until
// the document goes away, and main-thread probe garbage blocks worklet
// allocations (REPORT §12.2). Steps run in order; results are characterisation.
const { investigationSteps } = require('./investigation-steps.cjs');

async function runInvestigation(win) {
  // Main-thread garbage from a previous document (same renderer isolate) blocks
  // new WASM memories until a full GC runs, so every fresh step is preceded by a
  // DevTools-protocol GC (no V8 flags, so the runtime config stays as production).
  const dbg = win.webContents.debugger;
  let gcAvailable = false;
  try { dbg.attach('1.3'); gcAvailable = true; } catch (err) { console.log(`[spike-electron] debugger attach failed: ${err && err.message}`); }
  const collectGarbage = async () => { if (!gcAvailable) return false; try { await dbg.sendCommand('HeapProfiler.collectGarbage'); return true; } catch { return false; } };
  const out = { startedAt: new Date().toISOString(), gcBetweenSteps: gcAvailable ? 'CDP HeapProfiler.collectGarbage after each fresh load' : 'unavailable', steps: {} };
  report.investigation = out;
  for (const step of investigationSteps({ instances, env: process.env })) {
    const t0 = Date.now();
    try {
      if (step.fresh) { await win.loadFile(webIndex); await collectGarbage(); }
      const value = await win.webContents.executeJavaScript(step.js, true);
      out.steps[step.id] = { ok: true, ms: Date.now() - t0, value };
    } catch (err) {
      out.steps[step.id] = { ok: false, ms: Date.now() - t0, error: `${err && err.name}: ${err && err.message}` };
    }
    console.log(`[spike-electron] investigation ${step.id}: ${out.steps[step.id].ok ? 'ran' : 'ERROR ' + out.steps[step.id].error} (${out.steps[step.id].ms} ms)`);
    if (report.renderer.gone) break;
  }
  out.finishedAt = new Date().toISOString();
}

app.whenReady().then(async () => {
  if (CSP) {
    // Exactly the production mechanism (electron.cjs applies it when packaged).
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      report.headerHook.calls++;
      if (details.url.startsWith('file:')) report.headerHook.fileUrlCalls++;
      if (report.headerHook.sampleUrls.length < 5) report.headerHook.sampleUrls.push(details.url);
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: process.env.SPIKE_ELECTRON_HIDDEN !== '1',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
      audioWorklet: true,
      allowRunningInsecureContent: false,
    },
  });

  win.webContents.on('console-message', (...args) => {
    // Electron >= 35 passes a single details object; older versions positional args.
    const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
    if (d.level === 'error' || d.level === 3 || /error|uncaught/i.test(String(d.message))) {
      if (report.renderer.consoleErrors.length < 50) report.renderer.consoleErrors.push(String(d.message));
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    report.renderer.gone = details;
    clearTimeout(watchdog);
    finish(4);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    report.renderer.loadFailure = { code, desc, url };
  });

  if (suite === 'investigation') {
    try { await runInvestigation(win); } catch (err) { report.error = `${err && err.name}: ${err && err.message}`; }
    clearTimeout(watchdog);
    finish(report.investigation ? 0 : 2);
    return;
  }

  try {
    await win.loadFile(webIndex);
    const options = {
      suite,
      ...(suite === 'csp' && cspMode === 'production-wasm' ? { tests: ['cspProbe', 'parityWorkletOffline'] } : {}),
      sustainedLive: { instances, seconds },
      offlineThroughput: { instances, seconds: 30 },
    };
    report.harness = await win.webContents.executeJavaScript(
      `import(new URL('./harness.mjs', location.href).href).then(m => m.runAll(${JSON.stringify(options)}))`,
      true,
    );
  } catch (err) {
    report.error = `${err && err.name}: ${err && err.message}`;
  }
  clearTimeout(watchdog);
  // The runner decides pass/fail per mode; see run-electron.mjs.
  finish(report.harness ? 0 : 2);
});
