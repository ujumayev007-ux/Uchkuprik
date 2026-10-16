'use strict';
// The web page learns only which application shell it runs in. The connection calls
// work only from the application's own local "connect" page (checked in main.cjs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fastfoodShell', { kind: 'admin' });
contextBridge.exposeInMainWorld('adminConn', {
  state: () => ipcRenderer.invoke('admin:state'),
  retry: () => ipcRenderer.invoke('admin:retry'),
  save: (url) => ipcRenderer.invoke('admin:save', url),
  reset: () => ipcRenderer.invoke('admin:reset'),
});
