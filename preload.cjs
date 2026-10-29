const { contextBridge, ipcRenderer } = require('electron');

// Expose safe desktop platform APIs to the renderer.
const smokeTest = process.argv.includes('--apex-smoke-test');
const smokeIpcMeasurements = smokeTest ? [] : null;
const desktopApi = {
  isDesktop: true,
  smokeTest,
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
    open: (instrument, rate, mode, kind = 'instrument', captureFailureEvidence = false) =>
      ipcRenderer.invoke('vst3:open', instrument, rate, mode, kind, smokeTest && captureFailureEvidence),
    describe: (instrument) => ipcRenderer.invoke('vst3:describe', instrument),
    describeEffect: (effect) => ipcRenderer.invoke('vst3:describeEffect', effect),
    parameters: (id, changes) => ipcRenderer.invoke('vst3:parameters', id, changes),
    process: (id, frames, events, bpm, parameters) => ipcRenderer.invoke('vst3:process', id, frames, events, bpm, parameters),
    processAudio: async (id, frames, audio, bpm, parameters, profile) => {
      if (!smokeTest || !profile) return ipcRenderer.invoke('vst3:processAudio', id, frames, audio, bpm, parameters);
      const invokeStartedAt = performance.now();
      try {
        const pcm = await ipcRenderer.invoke('vst3:processAudio', id, frames, audio, bpm, parameters, profile);
        const responseReceivedAt = performance.now();
        if (smokeIpcMeasurements.length < 8192) smokeIpcMeasurements.push({
          ...profile, invokeStartedAt, responseReceivedAt, rendererIpcRttMs: responseReceivedAt - invokeStartedAt,
          outcome: 'resolved', error: null,
        });
        return pcm;
      } catch (error) {
        const responseReceivedAt = performance.now();
        if (smokeIpcMeasurements.length < 8192) smokeIpcMeasurements.push({
          ...profile, invokeStartedAt, responseReceivedAt, rendererIpcRttMs: responseReceivedAt - invokeStartedAt,
          outcome: 'rejected', error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    bindLiveAudioPort: (sessionId, trackId, slotId, runtimeId, sampleRate) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) throw new Error('Invalid live audio session');
      if (!Number.isInteger(trackId) || typeof slotId !== 'string' || slotId.length === 0 || slotId.length > 128) throw new Error('Invalid live audio identity');
      if (typeof runtimeId !== 'string' || runtimeId.length === 0 || runtimeId.length > 128) throw new Error('Invalid live audio runtime');
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid live audio sample rate');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ipcRenderer.removeListener('vst3:liveAudioPort', handler);
          reject(new Error('Live audio port bind timed out.'));
        }, 2000);
        const handler = (event, payload) => {
          if (payload?.sessionId !== sessionId) return;
          clearTimeout(timer);
          ipcRenderer.removeListener('vst3:liveAudioPort', handler);
          const port = event.ports?.[0];
          if (!port) { reject(new Error('Live audio port missing')); return; }
          window.postMessage({ type: 'vst3:liveAudioPort', sessionId, trackId, slotId }, '*', [port]);
          resolve();
        };
        ipcRenderer.on('vst3:liveAudioPort', handler);
        ipcRenderer.invoke('vst3:bindLiveAudioPort', sessionId, trackId, slotId, runtimeId, sampleRate).catch(error => {
          clearTimeout(timer);
          ipcRenderer.removeListener('vst3:liveAudioPort', handler);
          reject(error);
        });
      });
    },
    unbindLiveAudioPort: (id) => ipcRenderer.invoke('vst3:unbindLiveAudioPort', id),
    close: (id) => ipcRenderer.invoke('vst3:close', id),
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
  desktopApi.vst3.smokeClockPing = async () => {
    const preloadSentAtMs = performance.now();
    const reply = await ipcRenderer.invoke('vst3:smokeClockPing');
    const preloadReceivedAtMs = performance.now();
    return {
      preloadSentAtMs, preloadReceivedAtMs,
      mainReceivedAtMs: reply?.mainReceivedAtMs ?? null, mainReplyAtMs: reply?.mainReplyAtMs ?? null,
    };
  };
}
contextBridge.exposeInMainWorld('desktopApp', desktopApi);
