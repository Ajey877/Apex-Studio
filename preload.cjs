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
  desktopApi.vst3.smokeWriteEvidence = payload => ipcRenderer.invoke('vst3:smokeWriteEvidence', payload);
}
contextBridge.exposeInMainWorld('desktopApp', desktopApi);
