// Minimal bridge for the app pages: only these calls are exposed to the web page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fastfoodDesktop', {
  openAnyDesk: () => ipcRenderer.invoke('anydesk:open'),
  checkUpdate: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
});

// Vendor tools: present (and working) only on the vendor's computer, which holds the
// private signing key. Customers' installs report isVendor = false.
const isVendor = ipcRenderer.sendSync('vendor:isVendor') === true;
contextBridge.exposeInMainWorld('fastfoodVendor', {
  isVendor,
  state: () => ipcRenderer.invoke('vendor:state'),
  connect: (token) => ipcRenderer.invoke('vendor:connect', token),
  sign: (payload) => ipcRenderer.invoke('vendor:sign', payload),
  extend: (installId, months) =>
    ipcRenderer.invoke('vendor:extend', installId, months),
  update: (installId, changes) =>
    ipcRenderer.invoke('vendor:update', installId, changes),
  block: (installId, blocked) =>
    ipcRenderer.invoke('vendor:block', installId, blocked),
  history: () => ipcRenderer.invoke('vendor:history'),
  bulkUpdate: (installIds, changes) =>
    ipcRenderer.invoke('vendor:bulkUpdate', installIds, changes),
  templates: () => ipcRenderer.invoke('vendor:templates'),
  saveTemplate: (name, config) =>
    ipcRenderer.invoke('vendor:saveTemplate', name, config),
  deleteTemplate: (name) => ipcRenderer.invoke('vendor:deleteTemplate', name),
  customerHistory: (installId) =>
    ipcRenderer.invoke('vendor:customerHistory', installId),
  rollback: (installId, issuedAt) =>
    ipcRenderer.invoke('vendor:rollback', installId, issuedAt),
  publishUpdate: (notes) => ipcRenderer.invoke('vendor:publishUpdate', notes),
  blockInstall: (installId, blocked) =>
    ipcRenderer.invoke('vendor:blockInstall', installId, blocked),
  telegram: (token) => ipcRenderer.invoke('vendor:telegram', token),
  telegramOff: () => ipcRenderer.invoke('vendor:telegramOff'),
  installs: () => ipcRenderer.invoke('vendor:installs'),
  checkReports: () => ipcRenderer.invoke('vendor:checkReports'),
});
