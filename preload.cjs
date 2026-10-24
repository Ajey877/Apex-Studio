const { contextBridge, ipcRenderer } = require('electron');

// Expose safe desktop platform APIs to the renderer
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  smokeTest: process.argv.includes('--apex-smoke-test'),
  smokeReopen: process.argv.includes('--apex-smoke-reopen'),
  platform: process.platform,
  arch: process.arch,
  version: '2.4.0',
  vst3: {
    paths: () => ipcRenderer.invoke('vst3:paths'),
    choosePath: () => ipcRenderer.invoke('vst3:choosePath'),
    discover: () => ipcRenderer.invoke('vst3:discover'),
    inspect: (plugin, state) => ipcRenderer.invoke('vst3:inspect', plugin, state),
    open: (instrument, rate, mode) => ipcRenderer.invoke('vst3:open', instrument, rate, mode),
    describe: (instrument) => ipcRenderer.invoke('vst3:describe', instrument),
    parameters: (id, changes) => ipcRenderer.invoke('vst3:parameters', id, changes),
    process: (id, frames, events, bpm, parameters) => ipcRenderer.invoke('vst3:process', id, frames, events, bpm, parameters),
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
});
