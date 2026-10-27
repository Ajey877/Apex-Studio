const { app, BrowserWindow, shell, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('node:fs');
const { registerVst3 } = require('./desktop-vst3.cjs');
const { canRequestPermission, canCheckPermission } = require('./desktop-permissions.cjs');

// Chromium audio switches must be registered before app readiness.
app.commandLine.appendSwitch('enable-exclusive-audio');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-wave-audio');

// Enforce Chromium renderer sandboxing application-wide.
app.enableSandbox();
if (process.env.APEX_SMOKE_TEST === '1') app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEV_URL = 'http://localhost:3000';
const isAllowedNavigation = (url, isDev) => {
  if (isDev) return url === DEV_URL || url.startsWith(`${DEV_URL}/`);
  return url.startsWith('file://');
};

const openExternalUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
};

if (process.env.APEX_SMOKE_TEST === '1' && process.env.APEX_SMOKE_USER_DATA) app.setPath('userData', process.env.APEX_SMOKE_USER_DATA);

let mainWindow = null;

registerVst3({ app, ipcMain, dialog, getWindow: () => mainWindow });

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Apex Studio DAW - Professional Music Workstation',
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    webPreferences: {
      additionalArguments: process.env.APEX_SMOKE_TEST === '1' ? ['--apex-smoke-test', ...(process.env.APEX_SMOKE_REOPEN === '1' ? ['--apex-smoke-reopen'] : [])] : [],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      webSecurity: true,
      audioWorklet: true,
      allowRunningInsecureContent: false
    }
  });

  const startUrl = isDev
    ? (process.env.ELECTRON_START_URL || DEV_URL)
    : `file://${path.join(__dirname, 'dist/index.html')}`;

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, isDev)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url !== startUrl) {
      openExternalUrl(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.loadURL(startUrl);

  if (process.env.APEX_SMOKE_TEST === '1') {
    let smokeFinished = false;
    const describeSmokeError = error => {
      if (!error || typeof error !== 'object') return String(error);
      const name = typeof error.name === 'string' ? error.name : 'Error';
      const message = typeof error.message === 'string' ? error.message : '';
      const stack = typeof error.stack === 'string' ? error.stack : '';
      if (message || stack) return `${name}: ${message}${stack ? `\n${stack}` : ''}`;
      try { return JSON.stringify(error, Object.getOwnPropertyNames(error)); }
      catch { return Object.prototype.toString.call(error); }
    };
    const finishSmoke = (exitCode, reason) => {
      if (smokeFinished) return;
      smokeFinished = true;
      if (reason) console.log('[Apex Studio smoke]', reason);
      if (exitCode !== 0 && process.env.GITHUB_ACTIONS) console.log(`::error title=Packaged runtime smoke failed::${String(reason).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
      setTimeout(() => app.exit(exitCode), 50);
    };

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      finishSmoke(1, `renderer failed to load: ${errorCode} ${errorDescription}`);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      finishSmoke(1, `renderer process ended: ${details.reason}`);
    });

    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      if (/error|uncaught|exception/i.test(message)) {
        console.error('[Apex Studio smoke] renderer console:', message);
      }
    });

    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const bodyReady = document.readyState === 'complete' && !!document.body;
            const indexedDbReady = typeof indexedDB !== 'undefined';
            const audioReady = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
            const deadline = Date.now() + 10000;
            while (!window.__apexVst3Smoke && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            if (!window.__apexVst3Smoke) throw new Error('Production native smoke entry did not initialize');
            const vst3 = await window.__apexVst3Smoke;
            return { bodyReady, indexedDbReady, audioReady, vst3, title: document.title };
          })()
        `);
        const vst3LogSummary = result.vst3?.mixerEffects
          ? { ...result.vst3, mixerEffects: { ...result.vst3.mixerEffects, timingSamples: undefined } }
          : result.vst3;
        console.log('[Apex Studio smoke] runtime checks:', JSON.stringify({ ...result, vst3: vst3LogSummary }));
        if (!result.bodyReady || !result.indexedDbReady || !result.audioReady) {
          finishSmoke(1, 'required packaged runtime capabilities are unavailable');
          return;
        }
        if (process.env.APEX_SMOKE_EVIDENCE) {
          fs.mkdirSync(path.dirname(process.env.APEX_SMOKE_EVIDENCE), { recursive: true });
          fs.writeFileSync(process.env.APEX_SMOKE_EVIDENCE, JSON.stringify(result, null, 2));
        }
        if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Packaged VST3 live and production export proof::${JSON.stringify(vst3LogSummary)}`);
        finishSmoke(0, `packaged renderer loaded successfully: ${result.title}`);
      } catch (error) {
        finishSmoke(1, `runtime check failed: ${describeSmokeError(error)}`);
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Grant only the permissions required by app content; external origins stay denied.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(canRequestPermission(webContents.getURL(), permission));
  });

  // Electron's permission checks also gate APIs that do not trigger a request
  // callback. Keep the app's existing fullscreen/clipboard capabilities intact.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return canCheckPermission(requestingOrigin, permission);
  });

  // Apply a restrictive production CSP. Development keeps Vite's HMR environment intact.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "media-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' https:",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'"
            ].join('; ')
          ]
        }
      });
    });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
