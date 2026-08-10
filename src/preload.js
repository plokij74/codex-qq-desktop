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
  approvePlan: (payload) => ipcRenderer.invoke('chat:approvePlan', payload),
  rejectPlan: (payload) => ipcRenderer.invoke('chat:rejectPlan', payload),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  listTree: (projectPath) => ipcRenderer.invoke('project:listTree', projectPath),
  readFile: (projectPath, rel) => ipcRenderer.invoke('project:readFile', projectPath, rel),
  writeFile: (projectPath, rel, content) => ipcRenderer.invoke('project:writeFile', projectPath, rel, content),
  deletePath: (projectPath, rel) => ipcRenderer.invoke('project:deletePath', projectPath, rel),
  gitStatus: (projectPath) => ipcRenderer.invoke('git:status', { projectPath }),
  gitDiff: (projectPath, opts) => ipcRenderer.invoke('git:diff', { projectPath, ...opts }),
  runTerminal: (payload) => ipcRenderer.invoke('terminal:run', payload),
  stopTerminal: (payload) => ipcRenderer.invoke('terminal:stop', payload || {}),
  clearTerminal: () => ipcRenderer.invoke('terminal:clear'),
  atRefComplete: (payload) => ipcRenderer.invoke('atRef:complete', payload || {}),
  atRefExpand: (payload) => ipcRenderer.invoke('atRef:expand', payload || {}),
  listSkills: (payload) => ipcRenderer.invoke('skills:list', payload || {}),
  getSkill: (payload) => ipcRenderer.invoke('skills:get', payload || {}),
  hooksSummary: (payload) => ipcRenderer.invoke('hooks:summary', payload || {}),
  testMcpServer: (cfg) => ipcRenderer.invoke('mcp:testServer', cfg),
  compactSession: (payload) => ipcRenderer.invoke('session:compact', payload || {}),
  exportSession: (payload) => ipcRenderer.invoke('session:export', payload || {}),
  listMemory: (payload) => ipcRenderer.invoke('memory:list', payload || {}),
  addMemory: (payload) => ipcRenderer.invoke('memory:add', payload || {}),
  deleteMemory: (payload) => ipcRenderer.invoke('memory:delete', payload || {}),
  acceptMemory: (payload) => ipcRenderer.invoke('memory:accept', payload || {}),
  updateMemory: (payload) => ipcRenderer.invoke('memory:update', payload || {}),
  webFetch: (payload) => ipcRenderer.invoke('web:fetch', payload || {}),
  usageSummary: (payload) => ipcRenderer.invoke('usage:summary', payload || {}),
  usageClear: () => ipcRenderer.invoke('usage:clear'),
});
