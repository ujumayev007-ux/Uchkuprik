// Minimal bridge for the app pages: only these calls are exposed to the web page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fastfoodDesktop', {
  openAnyDesk: () => ipcRenderer.invoke('anydesk:open'),
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
  block: (installId, blocked) =>
    ipcRenderer.invoke('vendor:block', installId, blocked),
  history: () => ipcRenderer.invoke('vendor:history'),
});
