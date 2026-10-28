const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// Explicit operations only; never accept raw host commands or executable paths
// from renderer content. The Electron renderer remains sandboxed/isolated.
function registerVst3({ app, ipcMain, dialog, getWindow }) {
  const smokeTimingEnabled = process.env.APEX_SMOKE_TEST === '1';
  const smokeProcessAudioTimings = smokeTimingEnabled ? [] : null;
  let activeProcessAudioCalls = 0;
  let maximumConcurrentProcessAudioCalls = 0;
  const activeCallsByEffect = new Map();
  let maximumConcurrentCallsPerEffect = 0;
  const pcmRms = value => {
    if (!value || typeof value.length !== 'number' || value.length === 0) return null;
    let square = 0;
    for (let index = 0; index < value.length; index++) {
      const sample = Number(value[index]);
      if (!Number.isFinite(sample)) return null;
      square += sample * sample;
    }
    return Math.sqrt(square / value.length);
  };
  const readProfile = value => {
    if (!smokeTimingEnabled || !value || typeof value !== 'object' ||
      typeof value.requestId !== 'string' || value.requestId.length > 180 ||
      !Number.isInteger(value.trackId) || typeof value.slotId !== 'string' || value.slotId.length > 128 ||
      !Number.isInteger(value.sequence) || value.sequence < 0 ||
      !Number.isFinite(value.inputBlockStartContextFrame) || !Number.isFinite(value.submittedContextFrame) ||
      !Number.isFinite(value.submittedOutputFrame) || !Number.isFinite(value.dueOutputFrame) ||
      !Number.isFinite(value.sampleRate)) return null;
    return value;
  };
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
    const ipcReceivedAtMainMs = performance.now();
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) throw new Error('VST3 IPC denied for untrusted frame');
    const context = await ready;
    if (getWindow() !== win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame || !isTrustedUrl(event.senderFrame.url)) throw new Error('VST3 renderer closed during request');
    return operation === 'processAudio'
      ? fn(context, String(event.sender.id), ...args, { ipcReceivedAtMainMs })
      : fn(context, String(event.sender.id), ...args);
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
  handle('inspectEffect', (context, owner, plugin, state) => context.service.inspectEffect(plugin, state, owner));
  handle('open', (context, owner, instrument, rate, mode, kind) => context.service.open(instrument, rate, mode, owner, kind));
  handle('describe', (context, owner, instrument) => context.service.describe(instrument, owner));
  handle('describeEffect', (context, owner, effect) => context.service.describeEffect(effect, owner));
  handle('parameters', (context, owner, id, changes) => context.service.parameters(id, changes, owner));
  handle('process', (context, owner, id, frames, events, bpm, parameters) => context.service.process(id, frames, events, bpm, owner, parameters));
  handle('processAudio', async (context, owner, id, frames, audio, bpm, parameters, rawProfile, ipcTiming) => {
    const profile = readProfile(rawProfile);
    if (!profile) return context.service.processAudio(id, frames, audio, bpm, owner, parameters);
    const serviceStartAtMainMs = performance.now();
    const effectKey = `${profile.trackId}:${profile.slotId}`;
    const activeAtStart = ++activeProcessAudioCalls;
    const activeForEffectAtStart = (activeCallsByEffect.get(effectKey) ?? 0) + 1;
    activeCallsByEffect.set(effectKey, activeForEffectAtStart);
    maximumConcurrentProcessAudioCalls = Math.max(maximumConcurrentProcessAudioCalls, activeAtStart);
    maximumConcurrentCallsPerEffect = Math.max(maximumConcurrentCallsPerEffect, activeForEffectAtStart);
    try {
      const pcm = await context.service.processAudio(id, frames, audio, bpm, owner, parameters);
      const serviceCompletedAtMainMs = performance.now();
      if (smokeProcessAudioTimings.length < 8192) smokeProcessAudioTimings.push({
        ...profile, frames, ipcReceivedAtMainMs: ipcTiming?.ipcReceivedAtMainMs ?? serviceStartAtMainMs,
        serviceStartAtMainMs, serviceCompletedAtMainMs, nativeServiceCallMs: serviceCompletedAtMainMs - serviceStartAtMainMs,
        nativeInputRms: pcmRms(audio), nativeOutputRms: pcmRms(pcm),
        activeProcessAudioCallsAtStart: activeAtStart, activeCallsForEffectAtStart: activeForEffectAtStart, error: null,
      });
      return pcm;
    } catch (error) {
      const serviceCompletedAtMainMs = performance.now();
      if (smokeProcessAudioTimings.length < 8192) smokeProcessAudioTimings.push({
        ...profile, frames, ipcReceivedAtMainMs: ipcTiming?.ipcReceivedAtMainMs ?? serviceStartAtMainMs,
        serviceStartAtMainMs, serviceCompletedAtMainMs, nativeServiceCallMs: serviceCompletedAtMainMs - serviceStartAtMainMs,
        nativeInputRms: pcmRms(audio), nativeOutputRms: null,
        activeProcessAudioCallsAtStart: activeAtStart, activeCallsForEffectAtStart: activeForEffectAtStart,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      activeProcessAudioCalls = Math.max(0, activeProcessAudioCalls - 1);
      const remaining = Math.max(0, (activeCallsByEffect.get(effectKey) ?? 1) - 1);
      if (remaining === 0) activeCallsByEffect.delete(effectKey); else activeCallsByEffect.set(effectKey, remaining);
    }
  });
  if (smokeTimingEnabled) handle('smokeTimingSnapshot', context => ({
    processAudio: smokeProcessAudioTimings.slice(), maximumConcurrentProcessAudioCalls,
    maximumConcurrentCallsPerEffect, activeProcessAudioCalls, nativeServiceSessionCount: context.service.sessionCount,
  }));
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
