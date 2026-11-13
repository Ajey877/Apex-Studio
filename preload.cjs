const { contextBridge, ipcRenderer } = require('electron');

// Expose safe desktop platform APIs to the renderer.
const smokeTest = process.argv.includes('--apex-smoke-test');
const smokeIpcMeasurements = smokeTest ? [] : null;
const pendingLiveAudioPorts = new Map();
ipcRenderer.on('vst3:liveAudioPort', (event, metadata) => {
  const port = event.ports && event.ports[0];
  const sessionId = metadata && typeof metadata.sessionId === 'string' ? metadata.sessionId : '';
  if (!port || !sessionId) {
    if (port) try { port.close(); } catch { /* ignore */ }
    return;
  }
  const waiter = pendingLiveAudioPorts.get(sessionId);
  if (!waiter) {
    try { port.close(); } catch { /* ignore */ }
    return;
  }
  pendingLiveAudioPorts.delete(sessionId);
  clearTimeout(waiter.timer);
  window.postMessage({ type: 'vst3:liveAudioPort', sessionId, trackId: metadata.trackId, slotId: metadata.slotId }, '*', [port]);
  waiter.resolve();
});
const desktopApi = {
  isDesktop: true,
  smokeTest,
  /** Set only by APEX_ACCEPTANCE=1; enables the packaged-acceptance hook. */
  packagedAcceptance: process.argv.includes('--apex-packaged-acceptance'),
  closeWindow: process.argv.includes('--apex-packaged-acceptance')
    ? () => ipcRenderer.invoke('app:closeWindowForAcceptance')
    : undefined,
  smokeReopen: process.argv.includes('--apex-smoke-reopen'),
  platform: process.platform,
  arch: process.arch,
  version: '2.4.0',
  vst3: {
    paths: () => ipcRenderer.invoke('vst3:paths'),
    choosePath: () => ipcRenderer.invoke('vst3:choosePath'),
    discover: () => ipcRenderer.invoke('vst3:discover'),
    discoverEffects: () => ipcRenderer.invoke('vst3:discoverEffects'),
    inspect: (plugin, state) => ipcRenderer.invoke('vst3:inspect', plugin, state),
    inspectEffect: (plugin, state) => ipcRenderer.invoke('vst3:inspectEffect', plugin, state),
    open: (instrument, rate, mode, kind = 'instrument') => ipcRenderer.invoke('vst3:open', instrument, rate, mode, kind),
    describe: (instrument) => ipcRenderer.invoke('vst3:describe', instrument),
    describeEffect: (effect) => ipcRenderer.invoke('vst3:describeEffect', effect),
    parameters: (id, changes) => ipcRenderer.invoke('vst3:parameters', id, changes),
    process: (id, frames, events, bpm, parameters) => ipcRenderer.invoke('vst3:process', id, frames, events, bpm, parameters),
    processAudio: async (id, frames, audio, bpm, parameters, profile) => {
      if (!smokeTest || !profile) return ipcRenderer.invoke('vst3:processAudio', id, frames, audio, bpm, parameters);
      const invokeStartedAt = performance.now();
      const pcm = await ipcRenderer.invoke('vst3:processAudio', id, frames, audio, bpm, parameters, profile);
      const responseReceivedAt = performance.now();
      if (smokeIpcMeasurements.length < 8192) smokeIpcMeasurements.push({ ...profile, invokeStartedAt, responseReceivedAt, rendererIpcRttMs: responseReceivedAt - invokeStartedAt });
      return pcm;
    },
    close: (id) => ipcRenderer.invoke('vst3:close', id),
    openEditor: (effect, context) => ipcRenderer.invoke('vst3:openEditor', effect, context),
    pollEditor: (id) => ipcRenderer.invoke('vst3:pollEditor', id),
    closeEditor: (id) => ipcRenderer.invoke('vst3:closeEditor', id),
    finishEditor: (id, committed) => ipcRenderer.invoke('vst3:finishEditor', id, committed === true),
    editorRecovery: () => ipcRenderer.invoke('vst3:editorRecovery'),
    dismissEditorRecovery: (id) => ipcRenderer.invoke('vst3:dismissEditorRecovery', id),
    bindLiveAudioPort: (sessionId, trackId, slotId, runtimeId, sampleRate) => new Promise((resolve, reject) => {
      const existing = pendingLiveAudioPorts.get(sessionId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('Superseded live audio port bind'));
      }
      const timer = setTimeout(() => {
        pendingLiveAudioPorts.delete(sessionId);
        reject(new Error('Live audio port transfer timed out'));
      }, 2000);
      pendingLiveAudioPorts.set(sessionId, { resolve, reject, timer });
      ipcRenderer.invoke('vst3:bindLiveAudioPort', sessionId, trackId, slotId, runtimeId, sampleRate).catch(error => {
        const current = pendingLiveAudioPorts.get(sessionId);
        if (current && current.timer === timer) {
          pendingLiveAudioPorts.delete(sessionId);
          clearTimeout(timer);
        }
        reject(error);
      });
    }),
    unbindLiveAudioPort: (sessionId) => ipcRenderer.invoke('vst3:unbindLiveAudioPort', sessionId),
  },
  send: (channel, data) => {
    const validChannels = ['toMain', 'audio-stream', 'midi-event'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, func) => {
    const validChannels = ['fromMain', 'audio-buffer', 'midi-device-change'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  }
};
if (smokeTest) {
  desktopApi.vst3.smokeTimingSnapshot = async () => ({
    preload: smokeIpcMeasurements.slice(),
    main: await ipcRenderer.invoke('vst3:smokeTimingSnapshot'),
  });
  desktopApi.vst3.smokeTimingReset = async () => {
    smokeIpcMeasurements.length = 0;
    await ipcRenderer.invoke('vst3:smokeTimingReset');
  };
}
contextBridge.exposeInMainWorld('desktopApp', desktopApi);
