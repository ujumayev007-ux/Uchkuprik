'use strict';
// The small status pill ("Ulandi" / "Ulanmoqda" / "Aloqa yo‘q") may only receive the
// state and ask the application to open its own "Avtomatik ulanish" page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanStatus', {
  onState: (callback) =>
    ipcRenderer.on('lan:state', (_event, value) => callback(value)),
  open: () => ipcRenderer.invoke('lan:open'),
});
