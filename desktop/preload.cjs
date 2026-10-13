// Minimal bridge for the app pages: only these calls are exposed to the web page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fastfoodDesktop', {
  openAnyDesk: () => ipcRenderer.invoke('anydesk:open'),
});

// Vendor licence panel (only works on the vendor's computer, which holds the private key).
contextBridge.exposeInMainWorld('fastfoodVendor', {
  sign: (payload) => ipcRenderer.invoke('vendor:sign', payload),
  history: () => ipcRenderer.invoke('vendor:history'),
});
