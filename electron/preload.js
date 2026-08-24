// 恶魔连结 存档编辑器 - Electron 预加载脚本
// 通过 contextBridge 暴露 window.electronAPI，由 dist/api.js 统一映射为 window.api
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  listDir: dir => ipcRenderer.invoke('fs:listDir', dir),
  readText: p => ipcRenderer.invoke('fs:readText', p),
  writeText: (p, text) => ipcRenderer.invoke('fs:writeText', p, text),
  readResource: relPath => ipcRenderer.invoke('res:read', relPath),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('fs:saveImage', dataUrl, name),
  pickDir: () => ipcRenderer.invoke('fs:pickDir'),
  defaultStorage: () => ipcRenderer.invoke('fs:defaultStorage'),
  resourceRoots: () => ipcRenderer.invoke('res:roots'),
  addResourceRoot: dir => ipcRenderer.invoke('res:addRoot', dir),
})
