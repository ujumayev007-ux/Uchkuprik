'use strict';
// Preload of the small "server address" window: three calls, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ownerServer', {
  get: () => ipcRenderer.invoke('server:get'),
  save: (url) => ipcRenderer.invoke('server:save', url),
  reset: () => ipcRenderer.invoke('server:reset'),
});
