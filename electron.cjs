const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

// Chromium audio switches must be registered before app readiness.
app.commandLine.appendSwitch('enable-exclusive-audio');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-wave-audio');

// Enforce Chromium renderer sandboxing application-wide.
app.enableSandbox();

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

let mainWindow = null;

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // This application does not need arbitrary browser permissions. Microphone
  // access is the only permission currently required by the recorder.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = webContents.getURL();
    const isAppContent = requestingUrl.startsWith('file://') || requestingUrl.startsWith(DEV_URL);
    callback(isAppContent && permission === 'media');
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
