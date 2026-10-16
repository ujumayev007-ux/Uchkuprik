// Bridge for the Owner console page. The private device key never leaves the main
// process: the page can only ask it to sign a value (login challenge).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fastfoodOwner', {
  deviceKey: () => ipcRenderer.invoke('owner:deviceKey'),
  sign: (value) => ipcRenderer.invoke('owner:sign', value),
});

// Only the "cannot reach the server" page (a local file) may use these two calls; the
// main process refuses them from any other page.
contextBridge.exposeInMainWorld('ownerConn', {
  retry: () => ipcRenderer.invoke('conn:retry'),
  settings: () => ipcRenderer.invoke('conn:settings'),
});

// Same local vendor tools as the customer app's vendor panel (present and working
// only when this computer holds the vendor's private signing key).
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
