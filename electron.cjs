const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Chromium audio switches must be registered before app readiness.
app.commandLine.appendSwitch('enable-exclusive-audio');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-wave-audio');

let mainWindow = null;

function createWindow() {
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
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      webSecurity: true,
      audioWorklet: true
    }
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const startUrl = isDev
    ? (process.env.ELECTRON_START_URL || 'http://localhost:3000')
    : `file://${path.join(__dirname, 'dist/index.html')}`;

  mainWindow.loadURL(startUrl);

  // Only allow normal web URLs to open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
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
