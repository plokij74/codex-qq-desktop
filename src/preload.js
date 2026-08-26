const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
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
  getMcpOAuthStatus: () => ipcRenderer.invoke('mcp:oauth:status'),
  startMcpOAuth: (payload) => ipcRenderer.invoke('mcp:oauth:authorize', {
    name: String(payload?.name || ''),
  }),
  cancelMcpOAuth: (payload) => ipcRenderer.invoke('mcp:oauth:cancel', {
    flowId: String(payload?.flowId || ''),
  }),
  logoutMcpOAuth: (payload) => ipcRenderer.invoke('mcp:oauth:logout', {
    name: String(payload?.name || ''),
  }),
  onMcpOAuthEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('mcp:oauth:event', listener);
    return () => ipcRenderer.removeListener('mcp:oauth:event', listener);
  },
  listMcpPrompts: (payload = {}) => ipcRenderer.invoke('mcp:prompts:list', {
    server: payload?.server ? String(payload.server) : '',
  }),
  getMcpPrompt: (payload = {}) => ipcRenderer.invoke('mcp:prompts:get', {
    server: String(payload?.server || ''),
    name: String(payload?.name || ''),
    arguments: payload?.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments) ? payload.arguments : {},
  }),
  chooseMcpRoot: (payload = {}) => ipcRenderer.invoke('mcp:roots:choose', { name: String(payload?.name || '') }),
  removeMcpRoot: (payload = {}) => ipcRenderer.invoke('mcp:roots:remove', { name: String(payload?.name || ''), rootId: String(payload?.rootId || '') }),
  getMcpSessionStatus: (payload = {}) => ipcRenderer.invoke('mcp:session:status', { name: payload?.name ? String(payload.name) : '' }),
  resetMcpSession: (payload = {}) => ipcRenderer.invoke('mcp:session:reset', { name: payload?.name ? String(payload.name) : '' }),
  onMcpSessionEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('mcp:session:event', listener);
    return () => ipcRenderer.removeListener('mcp:session:event', listener);
  },
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
  bindWorktreeProject: (payload) => ipcRenderer.invoke('worktree:bind', payload || {}),
  unbindWorktreeProject: (payload) => ipcRenderer.invoke('worktree:unbind', payload || {}),
  listWorktreeResults: (payload) => ipcRenderer.invoke('worktree:list', payload || {}),
  getWorktreeResult: (payload) => ipcRenderer.invoke('worktree:get', payload || {}),
  applyWorktreeResult: (payload) => ipcRenderer.invoke('worktree:apply', payload || {}),
  discardWorktreeResult: (payload) => ipcRenderer.invoke('worktree:discard', payload || {}),
  retryCollectWorktreeResult: (payload) => ipcRenderer.invoke('worktree:retryCollect', payload || {}),
  cleanupWorktreeResult: (payload) => ipcRenderer.invoke('worktree:cleanup', payload || {}),
  openWorktreeResult: (payload) => ipcRenderer.invoke('worktree:open', payload || {}),
  preflightWorktreePr: (payload) => ipcRenderer.invoke('worktree:pr:preflight', payload || {}),
  createWorktreePr: (payload) => ipcRenderer.invoke('worktree:pr:create', payload || {}),
  retryWorktreePr: (payload) => ipcRenderer.invoke('worktree:pr:retry', payload || {}),
  cleanupWorktreePr: (payload) => ipcRenderer.invoke('worktree:pr:cleanup', payload || {}),
  listPullRequests: (payload) => ipcRenderer.invoke('worktree:pr:list', payload || {}),
  getPullRequest: (payload) => ipcRenderer.invoke('worktree:pr:get', payload || {}),
  editPullRequest: (payload) => ipcRenderer.invoke('worktree:pr:edit', payload || {}),
  commentPullRequest: (payload) => ipcRenderer.invoke('worktree:pr:comment', payload || {}),
  closePullRequest: (payload) => ipcRenderer.invoke('worktree:pr:close', payload || {}),
  reopenPullRequest: (payload) => ipcRenderer.invoke('worktree:pr:reopen', payload || {}),
  readyPullRequest: (payload) => ipcRenderer.invoke('worktree:pr:ready', payload || {}),
  mergePullRequest: (payload) => ipcRenderer.invoke('worktree:pr:merge', payload || {}),
  openWorktreePr: (payload) => ipcRenderer.invoke('worktree:pr:open', payload || {}),
});
