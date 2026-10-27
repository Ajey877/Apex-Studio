const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// Explicit operations only; never accept raw host commands or executable paths
// from renderer content. The Electron renderer remains sandboxed/isolated.
function registerVst3({ app, ipcMain, dialog, getWindow }) {
  const ready = (async () => {
    const { Vst3Service } = await import(pathToFileURL(path.join(__dirname, 'native/vst3/service.mjs')).href);
    const preferences = path.join(app.getPath('userData'), 'vst3-paths.json');
    const defaults = process.platform === 'win32'
      ? [path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'VST3')] : [];
    let roots = defaults;
    try {
      const stored = JSON.parse(await fs.readFile(preferences, 'utf8'));
      if (Array.isArray(stored) && stored.length <= 32 && stored.every(p => typeof p === 'string' && path.isAbsolute(p))) roots = stored;
    } catch { /* first launch / invalid preferences: keep known defaults */ }
    // Test-only root is accepted from the launching process, never web content.
    if (process.env.APEX_SMOKE_TEST === '1' && process.env.APEX_VST3_SMOKE_PLUGIN) roots = [...roots, path.dirname(process.env.APEX_VST3_SMOKE_PLUGIN)];
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, 'vst3', 'apex-vst3-host.exe')
      : path.join(__dirname, 'build/native-vst3/bin', process.platform === 'win32' ? 'Release/apex-vst3-host.exe' : 'apex-vst3-host');
    const service = new Vst3Service(executable, roots);
    return { service, preferences, roots };
  })();
  const isTrustedUrl = value => {
    try {
      const url = new URL(value);
      if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        return url.origin === new URL(process.env.ELECTRON_START_URL || 'http://localhost:3000').origin;
      }
      url.hash = ''; url.search = '';
      const expected = pathToFileURL(path.join(__dirname, 'dist/index.html')).href;
      return process.platform === 'win32' ? url.href.toLowerCase() === expected.toLowerCase() : url.href === expected;
    } catch { return false; }
  };
  const handle = (operation, fn) => ipcMain.handle(`vst3:${operation}`, async (event, ...args) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) throw new Error('VST3 IPC denied for untrusted frame');
    const context = await ready;
    if (getWindow() !== win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame || !isTrustedUrl(event.senderFrame.url)) throw new Error('VST3 renderer closed during request');
    return fn(context, String(event.sender.id), ...args);
  });
  handle('paths', context => [...context.roots]);
  handle('choosePath', async context => {
    const result = await dialog.showOpenDialog(getWindow(), { title: 'Add VST3 plugin folder', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const roots = [...new Set([...context.roots, ...result.filePaths])];
    if (roots.length > 32) throw new Error('At most 32 VST3 locations are supported');
    await fs.mkdir(path.dirname(context.preferences), { recursive: true });
    await fs.writeFile(`${context.preferences}.tmp`, JSON.stringify(roots));
    await fs.rename(`${context.preferences}.tmp`, context.preferences);
    context.roots = roots;
    context.service.setRoots(roots);
    return roots;
  });
  handle('discover', (context, owner) => context.service.discover(owner));
  handle('discoverEffects', (context, owner) => context.service.discover(owner, 'effect'));
  handle('inspect', (context, owner, plugin, state) => context.service.inspect(plugin, state, owner));
  handle('open', (context, owner, instrument, rate, mode, kind) => context.service.open(instrument, rate, mode, owner, kind));
  handle('describe', (context, owner, instrument) => context.service.describe(instrument, owner));
  handle('parameters', (context, owner, id, changes) => context.service.parameters(id, changes, owner));
  handle('process', (context, owner, id, frames, events, bpm, parameters) => context.service.process(id, frames, events, bpm, owner, parameters));
  handle('processAudio', (context, owner, id, frames, audio, bpm, parameters) => context.service.processAudio(id, frames, audio, bpm, owner, parameters));
  handle('close', (context, owner, id) => context.service.close(id, owner));
  app.on('web-contents-created', (_event, contents) => {
    const close = () => { void ready.then(({ service }) => service.closeOwner(String(contents.id))).catch(() => {}); };
    contents.on('render-process-gone', close);
    contents.on('destroyed', close);
    contents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  });
  app.on('will-quit', () => { void ready.then(({ service }) => service.dispose()).catch(() => {}); });
  // A missing native build should be an actionable plugin error, not prevent
  // existing built-in projects from opening. Import/initialization errors are
  // observed here and still reject any plugin request.
  ready.catch(error => console.error('[VST3]', error.message));
}
module.exports = { registerVst3 };
