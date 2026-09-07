const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('app', {
  setGhost: on => ipcRenderer.send('set-ghost', on),
  setOnTop: on => ipcRenderer.send('set-on-top', on),
  setBlur: on => ipcRenderer.send('set-blur', on),
  minimize: () => ipcRenderer.send('win-cmd', 'min'),
  close: () => ipcRenderer.send('win-cmd', 'close'),
  openUrl: url => ipcRenderer.send('open-url', url),
  // 老板键
  setBossKey: acc => ipcRenderer.invoke('boss-key', acc),
  getBossKey: () => ipcRenderer.invoke('boss-key-get'),
  // 授权
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  activate: code => ipcRenderer.invoke('license:activate', code),
  deactivate: () => ipcRenderer.invoke('license:deactivate'),
  // 导入
  importDialog: () => ipcRenderer.invoke('import:dialog'),
  importBuffer: (name, data) => ipcRenderer.invoke('import:buffer', { name, data }),
  // 书源
  rulesList: () => ipcRenderer.invoke('rules:list'),
  rulesFiles: () => ipcRenderer.invoke('rules:files'),
  rulesImport: () => ipcRenderer.invoke('rules:import'),
  rulesDelete: f => ipcRenderer.invoke('rules:delete', f),
  rulesOpenDir: () => ipcRenderer.send('rules:open-dir'),
  // 搜书
  search: keyword => ipcRenderer.invoke('novel:search', keyword),
  onSourceStatus: cb => { ipcRenderer.removeAllListeners('novel:source-status'); ipcRenderer.on('novel:source-status', (e, s) => cb(s)); },
  download: (sourceId, url) => ipcRenderer.invoke('novel:download', { sourceId, url }),
  onProgress: cb => { ipcRenderer.removeAllListeners('novel:progress'); ipcRenderer.on('novel:progress', (e, p) => cb(p)); },
  cancelDownload: () => ipcRenderer.send('novel:cancel'),
  // 打赏
  donateImages: () => ipcRenderer.invoke('donate:images')
});
