'use strict';
// The web page learns only which application shell it runs in. The connection calls
// work only from the application's own local "connect" page (checked in main.cjs).
const { contextBridge, ipcRenderer } = require('electron');

// The page learns which of the three applications hosts it (answered by main.cjs; the
// sandboxed preload can not read files itself).
const kind = ipcRenderer.sendSync('shell:kind');
contextBridge.exposeInMainWorld('fastfoodShell', {
  kind: ['admin', 'cashier', 'waiter', 'kitchen', 'tv'].includes(kind)
    ? kind
    : 'admin',
});
contextBridge.exposeInMainWorld('adminConn', {
  state: () => ipcRenderer.invoke('admin:state'),
  retry: () => ipcRenderer.invoke('admin:retry'),
  save: (url) => ipcRenderer.invoke('admin:save', url),
  reset: () => ipcRenderer.invoke('admin:reset'),
  auto: () => ipcRenderer.invoke('admin:auto'),
  pick: (id) => ipcRenderer.invoke('admin:pick', id),
});
