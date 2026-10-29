const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sshkm', {
  paths: () => ipcRenderer.invoke('paths'),
  generate: form => ipcRenderer.invoke('generate', form),
  reveal: p => ipcRenderer.invoke('reveal', p),
  copy: text => ipcRenderer.invoke('copy', text),
  openRepo: () => ipcRenderer.invoke('openRepo'),
  onLog: fn => ipcRenderer.on('log', (_e, line) => fn(line)),
  onKey: fn => ipcRenderer.on('key', (_e, data) => fn(data)),
})
