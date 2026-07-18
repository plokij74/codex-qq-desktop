const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopChat: () => ipcRenderer.invoke('chat:stop'),
  onChatEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  approveChat: (payload) => ipcRenderer.invoke('chat:approve', payload),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  listTree: (projectPath) => ipcRenderer.invoke('project:listTree', projectPath),
  readFile: (projectPath, rel) => ipcRenderer.invoke('project:readFile', projectPath, rel),
  writeFile: (projectPath, rel, content) => ipcRenderer.invoke('project:writeFile', projectPath, rel, content),
  deletePath: (projectPath, rel) => ipcRenderer.invoke('project:deletePath', projectPath, rel),
});
