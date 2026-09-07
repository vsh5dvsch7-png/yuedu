const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('app', {
  openUrl: url => ipcRenderer.send('open-url', url),
  importDialog: () => ipcRenderer.invoke('import:dialog'),
  importBuffer: (name, data) => ipcRenderer.invoke('import:buffer', { name, data }),
  donateImages: () => ipcRenderer.invoke('donate:images')
});
