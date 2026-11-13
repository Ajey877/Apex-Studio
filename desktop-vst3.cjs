const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { MessageChannelMain } = require('electron');

function validateEditorRecoveryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 ||
      typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
      typeof value.projectId !== 'string' || !value.projectId.length || value.projectId.length > 256 ||
      !Number.isSafeInteger(value.trackId) || value.trackId < 0 || value.trackId > 1_000_000 ||
      typeof value.slotId !== 'string' || !value.slotId.length || value.slotId.length > 128 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 2048))) {
    throw new Error('The pending VST3 editor recovery record is invalid; it was not discarded.');
  }
  const validateEffect = effect => {
    if (!effect || typeof effect !== 'object' || typeof effect.path !== 'string' || effect.path.length > 4096 ||
        !path.isAbsolute(effect.path) || typeof effect.classId !== 'string' || !/^[A-F0-9]{32}$/.test(effect.classId) ||
        !effect.state || effect.state.schema !== 1 || effect.state.classId !== effect.classId ||
        !Array.isArray(effect.state.parameters) || effect.state.parameters.length > 4096) {
      throw new Error('The pending VST3 editor recovery identity/state is invalid; it was not discarded.');
    }
    for (const key of ['component', 'controller']) {
      const state = effect.state[key];
      if (state !== undefined && (typeof state !== 'string' || state.length > 2 * 1024 * 1024 || !/^(?:[A-Fa-f0-9]{2})*$/.test(state))) {
        throw new Error(`The pending VST3 editor ${key} recovery state is invalid; it was not discarded.`);
      }
    }
    const seen = new Set();
    for (const item of effect.state.parameters) {
      if (!item || !Number.isInteger(item.id) || item.id < 0 || item.id > 0xffffffff ||
          !Number.isFinite(item.value) || item.value < 0 || item.value > 1 || seen.has(item.id)) {
        throw new Error('The pending VST3 editor parameter recovery state is invalid; it was not discarded.');
      }
      seen.add(item.id);
    }
    return effect;
  };
  validateEffect(value.originalEffect);
  if (value.effect !== undefined) validateEffect(value.effect);
  if (!value.effect && !value.error) throw new Error('The pending VST3 editor recovery record has no state or diagnostic.');
  const normalized = {
    schema: 1, id: value.id, projectId: value.projectId, trackId: value.trackId, slotId: value.slotId,
    originalEffect: value.originalEffect, ...(value.effect ? { effect: value.effect } : {}),
    ...(value.error ? { error: value.error } : {}), createdAt: value.createdAt,
  };
  if (JSON.stringify(normalized).length > 10 * 1024 * 1024) throw new Error('VST3 editor recovery record exceeds its 10 MiB limit.');
  return normalized;
}

// Explicit operations only; never accept raw host commands or executable paths
// from renderer content. The Electron renderer remains sandboxed/isolated.
function registerVst3({ app, ipcMain, dialog, getWindow }) {
  const smokeTimingEnabled = process.env.APEX_SMOKE_TEST === '1';
  const smokeProcessAudioTimings = smokeTimingEnabled ? [] : null;
  let activeProcessAudioCalls = 0;
  let maximumConcurrentProcessAudioCalls = 0;
  const activeCallsByEffect = new Map();
  let maximumConcurrentCallsPerEffect = 0;
  const livePorts = new Map();
  let editorRecoveryPath = null;
  let editorRecoveryRecord = null;
  let editorRecoveryLoadError = null;
  let editorRecoveryWriteTail = Promise.resolve();
  let activeEditorSessionId = null;
  let activeEditorOwner = null;
  let appQuitAfterEditorRecovery = false;
  let quitRecoveryPending = false;
  const EDITOR_CLOSE_TIMEOUT_MS = 15000;

  const persistEditorRecovery = (record, source = 'captured') => {
    editorRecoveryRecord = record;
    if (source === 'captured') editorRecoveryLoadError = null;
    if (!editorRecoveryPath) return editorRecoveryWriteTail;
    const write = (async () => {
      await fs.mkdir(path.dirname(editorRecoveryPath), { recursive: true });
      const temporary = `${editorRecoveryPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, editorRecoveryPath);
    })();
    editorRecoveryWriteTail = editorRecoveryWriteTail
      .then(() => write)
      .catch(error => { console.error('[VST3]', `Could not persist editor recovery data: ${error.message}`); });
    return editorRecoveryWriteTail;
  };
  const dismissEditorRecovery = async id => {
    if (!editorRecoveryRecord || editorRecoveryRecord.id !== id) throw new Error('The pending VST3 editor recovery record does not match; nothing was discarded.');
    editorRecoveryRecord = null;
    await editorRecoveryWriteTail.catch(() => {});
    if (editorRecoveryPath) await fs.rm(editorRecoveryPath, { force: true }).catch(() => {});
  };
  const clearActiveEditor = id => {
    if (id !== undefined && activeEditorSessionId !== id) return;
    activeEditorSessionId = null;
    activeEditorOwner = null;
  };
  // Stop is non-blocking so close/abort can proceed while a native call is
  // wedged; dispose finishes port teardown once the in-flight promise settles.
  const disposeLivePort = (sessionId, owner) => {
    const live = livePorts.get(sessionId);
    if (!live) return;
    if (owner !== undefined && live.owner !== owner) throw new Error('VST3 session is closed or belongs to another renderer');
    livePorts.delete(sessionId);
    live.stop();
    void live.dispose();
  };
  const disposeLivePortsForOwner = owner => {
    for (const [sessionId, live] of [...livePorts]) {
      if (live.owner !== owner) continue;
      livePorts.delete(sessionId);
      live.stop();
      void live.dispose();
    }
  };
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
    const [{ Vst3Service }, { createLiveAudioPortSession }] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, 'native/vst3/service.mjs')).href),
      import(pathToFileURL(path.join(__dirname, 'native/vst3/liveAudioPort.mjs')).href),
    ]);
    const preferences = path.join(app.getPath('userData'), 'vst3-paths.json');
    editorRecoveryPath = path.join(app.getPath('userData'), 'vst3-editor-recovery.json');
    try {
      const raw = await fs.readFile(editorRecoveryPath, 'utf8');
      try { editorRecoveryRecord = validateEditorRecoveryRecord(JSON.parse(raw)); }
      catch (error) { editorRecoveryLoadError = error instanceof Error ? error.message : String(error); }
    } catch (error) {
      if (error?.code !== 'ENOENT') editorRecoveryLoadError = `Could not read pending VST3 editor recovery data: ${error.message}`;
    }
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
    return { service, preferences, roots, createLiveAudioPortSession };
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
  // Packaged-acceptance only: quit through the shipped path (window close ->
  // window-all-closed -> app.quit -> before-quit), never through a bypass.
  if (process.env.APEX_ACCEPTANCE === '1') {
    ipcMain.handle('app:closeWindowForAcceptance', event => {
      const win = getWindow();
      if (!win || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted acceptance close request');
      win.close();
      return { closing: true };
    });
  }
  // A native editor is a real OS window owned by the helper process. Only one
  // may exist, it belongs to the renderer that requested it, and quitting the
  // app must first capture the plug-in's final state.
  const editorOwner = (owner, id) => {
    if (activeEditorSessionId === null) throw new Error('No native VST3 editor window is open.');
    if (activeEditorOwner !== owner) throw new Error('The native VST3 editor belongs to another renderer session.');
    if (typeof id !== 'string' || id !== activeEditorSessionId) throw new Error('Native VST3 editor session does not match the open window.');
  };
  handle('openEditor', async (context, owner, effect, editorContext) => {
    if (activeEditorSessionId !== null) throw new Error('Close the open native VST3 editor window before opening another.');
    const opened = await context.service.openEditor(effect, editorContext, owner);
    activeEditorSessionId = opened.id;
    activeEditorOwner = owner;
    return opened;
  });
  handle('pollEditor', async (context, owner, id) => {
    editorOwner(owner, id);
    return context.service.pollEditor(id, owner);
  });
  handle('closeEditor', async (context, owner, id) => {
    editorOwner(owner, id);
    let timer;
    try {
      const result = await Promise.race([
        context.service.closeEditor(id, owner),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('The native VST3 editor did not finish closing in time.')), EDITOR_CLOSE_TIMEOUT_MS);
        }),
      ]);
      return result;
    } finally { clearTimeout(timer); }
  });
  handle('finishEditor', async (context, owner, id, committed) => {
    editorOwner(owner, id);
    // `committed === true` means the renderer already applied the captured
    // state to the project. Otherwise the captured state (or the last observed
    // parameter values) is written to the recovery file before the helper is
    // released, so a failed commit can never destroy the user's edits.
    if (committed !== true) {
      const recovery = context.service.getEditorRecovery(id, owner);
      await persistEditorRecovery(validateEditorRecoveryRecord(recovery));
    }
    await context.service.finishEditor(id, owner);
    clearActiveEditor(id);
  });
  handle('editorRecovery', () => ({
    recovery: editorRecoveryRecord, loadError: editorRecoveryLoadError,
  }));
  handle('dismissEditorRecovery', async (_context, _owner, id) => {
    await dismissEditorRecovery(id);
    editorRecoveryLoadError = null;
  });
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
  const runProcessAudio = async (context, owner, id, frames, audio, bpm, parameters, rawProfile, ipcTiming) => {
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
  };
  handle('processAudio', (context, owner, id, frames, audio, bpm, parameters, rawProfile, ipcTiming) =>
    runProcessAudio(context, owner, id, frames, audio, bpm, parameters, rawProfile, ipcTiming));
  if (smokeTimingEnabled) {
    handle('smokeTimingSnapshot', context => ({
      processAudio: smokeProcessAudioTimings.slice(), maximumConcurrentProcessAudioCalls,
      maximumConcurrentCallsPerEffect, activeProcessAudioCalls, nativeServiceSessionCount: context.service.sessionCount,
    }));
    handle('smokeTimingReset', () => {
      smokeProcessAudioTimings.length = 0;
      maximumConcurrentProcessAudioCalls = activeProcessAudioCalls;
      maximumConcurrentCallsPerEffect = Math.max(0, ...activeCallsByEffect.values());
    });
  }
  handle('unbindLiveAudioPort', (context, owner, id) => {
    context.service.assertSession(id, owner);
    disposeLivePort(id, owner);
  });
  handle('bindLiveAudioPort', (context, owner, sessionId, trackId, slotId, runtimeId, sampleRate) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) throw new Error('Invalid live audio session');
    if (!Number.isInteger(trackId) || typeof slotId !== 'string' || slotId.length === 0 || slotId.length > 128) throw new Error('Invalid live audio identity');
    if (typeof runtimeId !== 'string' || runtimeId.length === 0 || runtimeId.length > 128) throw new Error('Invalid live audio runtime');
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid live audio sample rate');
    context.service.assertSession(sessionId, owner);
    if (livePorts.has(sessionId)) throw new Error('Live audio port already bound');
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('VST3 renderer closed during request');
    const { port1, port2 } = new MessageChannelMain();
    const live = context.createLiveAudioPortSession({
      sessionId, owner, trackId, slotId,
      processAudio: ({ sequence, samples, timing }) => {
        const profile = {
          requestId: `${runtimeId}:${sequence}`,
          trackId, slotId, sequence, sampleRate,
          inputBlockStartContextFrame: timing?.inputBlockStartContextFrame,
          submittedContextFrame: timing?.submittedContextFrame,
          submittedOutputFrame: timing?.submittedOutputFrame,
          dueOutputFrame: timing?.dueOutputFrame,
          dueContextFrame: timing?.dueContextFrame,
        };
        return runProcessAudio(context, owner, sessionId, 1024, samples, 120, [], profile, { ipcReceivedAtMainMs: performance.now() });
      },
    });
    try {
      live.attach(port1);
      livePorts.set(sessionId, live);
      win.webContents.postMessage('vst3:liveAudioPort', { sessionId, trackId, slotId }, [port2]);
    } catch (error) {
      livePorts.delete(sessionId);
      void live.dispose();
      try { port1.close(); } catch { /* already closed */ }
      try { port2.close(); } catch { /* already closed */ }
      throw error;
    }
  });
  handle('close', async (context, owner, id) => {
    disposeLivePort(id, owner);
    return context.service.close(id, owner);
  });
  app.on('web-contents-created', (_event, contents) => {
    const close = () => {
      const owner = String(contents.id);
      disposeLivePortsForOwner(owner);
      const editorId = activeEditorSessionId;
      const ownedEditor = editorId !== null && activeEditorOwner === owner;
      if (ownedEditor) clearActiveEditor(editorId);
      void ready.then(async ({ service }) => {
        const recovery = await service.closeOwner(owner);
        if (ownedEditor && recovery) await persistEditorRecovery(validateEditorRecoveryRecord(recovery), 'teardown');
      }).catch(error => {
        console.error('[VST3]', `Renderer teardown failed: ${error.message}`);
      });
    };
    contents.on('render-process-gone', close);
    contents.on('destroyed', close);
    contents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  });
  // Quitting must not silently discard an open editor. The helper captures and
  // persists the plug-in's final state; the window close is then allowed to
  // proceed. The helper is still destroyed on the real `will-quit` below.
  app.on('before-quit', event => {
    if (activeEditorSessionId === null || appQuitAfterEditorRecovery) return;
    const editorId = activeEditorSessionId;
    const owner = activeEditorOwner;
    event.preventDefault();
    if (quitRecoveryPending) return;
    quitRecoveryPending = true;
    // If initialization itself failed there is no helper to capture from; never
    // leave the app unable to quit.
    ready.catch(() => {}).then(async resolved => {
      const service = resolved?.service;
      if (!service) return;
      let recovery = null;
      try {
        if (editorId !== null && owner !== null) {
          const result = await Promise.race([
            service.closeEditor(editorId, owner),
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('The native VST3 editor did not finish closing in time.')), EDITOR_CLOSE_TIMEOUT_MS);
            }),
          ]);
          recovery = { id: editorId, ...result };
        }
      } catch (error) {
        console.error('[VST3]', `Editor state could not be captured while quitting: ${error.message}`);
      }
      try {
        if (recovery) await persistEditorRecovery(validateEditorRecoveryRecord(recovery), 'captured');
      } catch (error) {
        console.error('[VST3]', `Could not persist editor recovery data while quitting: ${error.message}`);
      }
      return service.dispose();
    }).catch(error => {
      console.error('[VST3]', `Editor teardown while quitting failed: ${error.message}`);
    }).finally(() => {
      appQuitAfterEditorRecovery = true;
      quitRecoveryPending = false;
      clearActiveEditor();
      app.quit();
    });
  });
  app.on('will-quit', () => {
    for (const [sessionId, live] of [...livePorts]) {
      livePorts.delete(sessionId);
      live.stop();
      void live.dispose();
    }
    void ready.then(({ service }) => service.dispose()).catch(() => {});
  });
  // A missing native build should be an actionable plugin error, not prevent
  // existing built-in projects from opening. Import/initialization errors are
  // observed here and still reject any plugin request.
  ready.catch(error => console.error('[VST3]', error.message));
}
module.exports = { registerVst3 };
