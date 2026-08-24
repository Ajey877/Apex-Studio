const { contextBridge, ipcRenderer } = require('electron');

// Expose safe desktop platform APIs to the renderer
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
  arch: process.arch,
  version: '2.4.0',
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
