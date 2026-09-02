const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  loadSettings,
  saveSettings,
  clampInt,
  clampMemorySettings,
  normalizeDomainList,
  sanitizePricing,
} = require('./ai/settings');
const { generateLocalReply } = require('./ai/local-mock');
const { chatCompletionMessage } = require('./ai/openai-compatible');
const {
  runAgentLoop,
  applyWriteFencesWithGate,
  buildUsageEvent,
} = require('./ai/agent');
const { createMemoryOnlyRegistry } = require('./ai/providers');
const { AGENT_EVENTS } = require('./ai/agent-events');
const { createPermissionGate } = require('./ai/permission');
const { runTerminal } = require('./ai/terminal');
const {
  listTree,
  readFile,
  writeFile,
  deletePath,
  buildProjectSystemPrompt,
  isListIntent,
  isStructureIntent,
  buildTreeReply,
} = require('./ai/project-fs');
const { gitStatus, gitDiff } = require('./ai/git');
const { expandAtRefs, completeAtPath } = require('./ai/at-ref');
const { computeUnifiedDiff, truncateDiff } = require('./ai/diff');
const {
  normalizeAgentMode,
  buildApproveExecutionMessage,
  shouldUseAgent,
} = require('./ai/agent-mode');
const { discoverSkills, loadSkillBody } = require('./ai/skills-loader');
const { loadHooks } = require('./ai/hooks-loader');
const { sanitizeMcpServers } = require('./ai/mcp-config');
const { createMcpOAuthManager } = require('./ai/mcp-oauth');
const { createMcpSessionManager } = require('./ai/mcp-session-manager');
const { createMcpHub } = require('./ai/mcp-hub');
const { createMcpSamplingController } = require('./ai/mcp-sampling');
const { createMcpTaskManager } = require('./ai/mcp-task-manager');
const { createMcpElicitationController } = require('./ai/mcp-elicitation');
const { configFingerprint } = require('./ai/mcp-session-manager');
const {
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  generateCompactArtifacts,
} = require('./ai/session-compact');
const {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
} = require('./ai/session-export');
const {
  memoryList,
  memoryAdd,
  memoryDelete,
  memoryAccept,
  memoryUpdate,
} = require('./ai/memory-ipc');
const { fetchUrl } = require('./ai/web-fetch');
const { aggregate } = require('./ai/usage');
const { createWorktreeManager } = require('./ai/worktree');
const { createWorktreeIpcHandlers } = require('./ai/worktree-ipc');
const { createEngineeringIpcHandlers } = require('./ai/engineering-ipc');
const { projectKey } = require('./ai/project-index');
const {
  usageFilePath,
  appendRecord,
  readRecords,
  pruneRecords,
  clearRecords,
} = require('./ai/usage-store');

const PERMISSION_MODES = new Set(['read-only', 'confirm-writes', 'full-auto']);
const AGENT_MODES = new Set(['plan', 'agent']);

/**
 * Clone messages for the model; expand @refs on the last user message only.
 * Renderer history keeps the original text (not this expanded copy).
 */
function messagesForModel(messages, projectPath) {
  const out = (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m.role,
    content: String(m.content || ''),
  }));
  if (!projectPath) return out;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role !== 'user') continue;
    const userText = out[i].content;
    try {
      const expanded = expandAtRefs(projectPath, userText);
      if (expanded.contextBlock) {
        out[i] = {
          role: 'user',
          content: `${userText}\n\n${expanded.contextBlock}`,
        };
      }
    } catch {
      // leave original text if expand fails
    }
    break;
  }
  return out;
}

/**
 * Active chat run state.
 * @type {{ abort: AbortController, gate: ReturnType<typeof createPermissionGate>, runId: string, sender: Electron.WebContents } | null}
 */
let activeRun = null;

/**
 * Pending plan per session (from submit_plan / plan-ready).
 * @type {Map<string, { planId: string, title?: string, markdown: string, steps?: string[], sessionId: string }>}
 */
const pendingPlansBySession = new Map();

/**
 * Manual terminal run (panel). Independent from activeRun / chat:stop.
 * @type {{ abort: AbortController, gate: ReturnType<typeof createPermissionGate>, sessionId: string, sender: Electron.WebContents, termId: string } | null}
 */
let manualTerm = null;
let worktreeMutation = false;
let mcpOAuthManager = null;
let mcpSessionManager = null;
let mcpTaskManager = null;
let mcpElicitationController = null;
let mcpTaskRecoveryHub = null;
let engineeringIpc = null;
let quitting = false;
const oauthFlowOwners = new Map();
const oauthPendingOwnersByName = new Map();
const rootTokensBySender = new Map();
const rootTokenRecords = new Map();
const mcpProjectBySender = new Map();

const worktreeManager = createWorktreeManager();
const worktreeIpc = createWorktreeIpcHandlers({
  manager: worktreeManager,
  isBusy: () => Boolean(activeRun || manualTerm || worktreeMutation),
  withMutation: async (fn) => {
    if (activeRun || manualTerm || worktreeMutation) return { ok: false, code: 'BUSY', error: '有对话或终端正在进行，请稍后重试' };
    worktreeMutation = true;
    try { return await fn(); } finally { worktreeMutation = false; }
  },
  openPath: async (target) => {
    if (!target || !fs.existsSync(target)) return '路径不存在';
    return shell.openPath(target);
  },
  openExternal: async (url) => shell.openExternal(url),
});

function getEngineeringIpc() {
  if (engineeringIpc) return engineeringIpc;
  engineeringIpc = createEngineeringIpcHandlers({
    resolveBinding: (event, payload) => worktreeIpc.resolveBinding(event, payload),
    userDataPath: userDataPath(),
    safeStorage,
    runTerminal,
    indexStorePathFor: (projectPath) => path.join(userDataPath(), `engineering-index-${crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16)}.json`),
    isIndexEnabled: () => loadSettings(userDataPath()).codeIndexEnabled !== false,
    getProfiles: (projectPath) => {
      const key = projectKey(projectPath);
      return (loadSettings(userDataPath()).verificationProfiles || [])
        .filter((profile) => profile.projectKey === key);
    },
    setProfiles: (projectPath, profiles) => {
      const settings = loadSettings(userDataPath());
      const key = projectKey(projectPath);
      const retained = (settings.verificationProfiles || [])
        .filter((profile) => profile.projectKey !== key);
      saveSettings(userDataPath(), {
        verificationProfiles: [
          ...retained,
          ...profiles.map((profile) => ({ ...profile, projectKey: key })),
        ],
      });
    },
    getSettings: () => loadSettings(userDataPath()),
    createPermissionGate: (event, settings) => createPermissionGate({
      permissionMode: PERMISSION_MODES.has(settings.permissionMode) ? settings.permissionMode : 'confirm-writes',
      terminalEnabled: settings.terminalEnabled === true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (approval) => {
        safeSend(event.sender, 'chat:event', { type: AGENT_EVENTS.APPROVAL_NEEDED, source: 'verification', runId: null, ...approval });
      },
    }),
    onEvent: (event, ownerIds = []) => {
      const owners = new Set(ownerIds);
      for (const win of BrowserWindow.getAllWindows()) {
        if (owners.has(win.webContents.id)) safeSend(win.webContents, 'engineering:event', event);
      }
    },
  });
  return engineeringIpc;
}

function userDataPath() {
  return app.getPath('userData');
}

function getMcpOAuthManager() {
  if (mcpOAuthManager) return mcpOAuthManager;
  mcpOAuthManager = createMcpOAuthManager({
    userDataPath: userDataPath(),
    openExternal: (url) => shell.openExternal(url),
  });
  mcpOAuthManager.onEvent((event) => {
    const pendingSenderId = oauthPendingOwnersByName.get(event.name);
    if (event.flowId && pendingSenderId != null && event.state === 'starting') {
      oauthFlowOwners.set(event.flowId, pendingSenderId);
    }
    if (event.state === 'success' || event.state === 'error' || event.state === 'cancelled') {
      if (event.flowId) oauthFlowOwners.delete(event.flowId);
      oauthPendingOwnersByName.delete(event.name);
    }
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win.webContents, 'mcp:oauth:event', event);
    }
  });
  return mcpOAuthManager;
}

function getMcpSessionManager() {
  if (mcpSessionManager) return mcpSessionManager;
  mcpSessionManager = createMcpSessionManager({
    onStatus: (status) => {
      // Session summaries are intentionally identifier-free; broadcast only
      // state/reconnect changes to windows that can render them.
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:session:event', status);
    },
  });
  return mcpSessionManager;
}

function getMcpTaskManager() {
  if (mcpTaskManager) return mcpTaskManager;
  mcpTaskManager = createMcpTaskManager({
    userDataPath: userDataPath(),
    onEvent: (event) => {
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:task:event', event);
    },
  });
  return mcpTaskManager;
}

function getMcpElicitationController() {
  if (mcpElicitationController) return mcpElicitationController;
  mcpElicitationController = createMcpElicitationController({
    onEvent: (event) => {
      for (const win of BrowserWindow.getAllWindows()) safeSend(win.webContents, 'mcp:elicitation:event', event);
    },
    openExternal: (url) => shell.openExternal(url),
    allowPrivateUrlForServer: (name) => loadSettings(userDataPath()).mcpServers
      .some((server) => server.name === String(name || '') && server.elicitation?.allowPrivateUrl === true),
  });
  return mcpElicitationController;
}

async function restoreMcpTasksAtStartup() {
  const taskManager = getMcpTaskManager();
  const active = taskManager.list().filter((task) => task.needsRecovery === true);
  if (!active.length) return;
  const settings = loadSettings(userDataPath());
  const enabledByName = new Map(settings.mcpServers
    .filter((server) => server.enabled !== false)
    .map((server) => [server.name, server]));
  const currentFingerprint = (serverName) => {
    const server = enabledByName.get(serverName);
    return server ? configFingerprint(server) : '';
  };
  const serverNames = new Set(taskManager.recoveryServerNames(currentFingerprint));
  const servers = [...enabledByName.values()].filter((server) => serverNames.has(server.name));
  if (!servers.length) {
    await taskManager.restore({ getClient: () => null, getConfigFingerprint: currentFingerprint });
    return;
  }
  const hub = createMcpHub({
    sessionManager: getMcpSessionManager(),
    taskManager,
  });
  try {
    await hub.startAll(servers, {
      taskRecovery: true,
      // Startup recovery only monitors persisted tool tasks. It deliberately
      // has no Agent, roots, sampling, or elicitation callback context.
    });
    mcpTaskRecoveryHub = hub;
  } catch {
    await hub.close().catch(() => {});
  }
}

function cancelOAuthFlowsForSender(senderId) {
  const manager = mcpOAuthManager;
  if (!manager) return;
  for (const [flowId, ownerId] of oauthFlowOwners) {
    if (ownerId !== senderId) continue;
    manager.cancel(flowId);
    oauthFlowOwners.delete(flowId);
  }
  for (const [name, ownerId] of oauthPendingOwnersByName) {
    if (ownerId === senderId) oauthPendingOwnersByName.delete(name);
  }
}

function persistUsageEvent(settings, sessionId, event) {
  if (!event || settings?.usageEnabled === false) return false;
  try {
    const file = usageFilePath(userDataPath());
    appendRecord(file, {
      ts: Date.now(),
      session: String(sessionId || ''),
      model: String(event.model || ''),
      kind: String(event.kind || 'main'),
      in: Number(event.inputTokens) || 0,
      out: Number(event.outputTokens) || 0,
      cached: Number(event.cachedInputTokens) || 0,
      est: event.estimated === true,
      cost: typeof event.cost === 'number' && Number.isFinite(event.cost)
        ? event.cost
        : null,
      cur: String(event.currency || '$'),
    });
    pruneRecords(file, settings.usageMaxRecords);
    return true;
  } catch {
    // Usage metering is best-effort and must never interrupt a chat or compact.
    return false;
  }
}

function bundledSkillsDir() {
  return path.join(__dirname, 'skills');
}

function makePublicRootToken(senderId, name, rootId) {
  if (senderId == null) return String(rootId || '');
  const ownerId = Number(senderId);
  let tokens = rootTokensBySender.get(ownerId);
  if (!tokens) {
    tokens = new Map();
    rootTokensBySender.set(ownerId, tokens);
  }
  const key = `${String(name || '')}:${String(rootId || '')}`;
  const existing = tokens.get(key);
  if (existing) return existing;
  const token = `rt_${crypto.randomBytes(18).toString('base64url')}`;
  tokens.set(key, token);
  rootTokenRecords.set(token, { senderId: ownerId, name: String(name || ''), rootId: String(rootId || '') });
  return token;
}

function resolvePublicRootId(senderId, name, token) {
  const record = rootTokenRecords.get(String(token || ''));
  if (!record || record.senderId !== Number(senderId) || record.name !== String(name || '')) return '';
  return record.rootId;
}

function dropMcpRootTokens(senderId) {
  const ownerId = Number(senderId);
  const tokens = rootTokensBySender.get(ownerId);
  if (!tokens) return;
  for (const token of tokens.values()) rootTokenRecords.delete(token);
  rootTokensBySender.delete(ownerId);
}

function publicMcpServer(server, status, senderId) {
  const out = {
    name: String(server?.name || ''),
    transport: String(server?.transport || 'stdio'),
    enabled: server?.enabled !== false,
    sessionRecovery: server?.sessionRecovery === true,
    sampling: { enabled: server?.sampling?.enabled === true },
    tasks: {
      enabled: server?.tasks?.enabled === true,
      defaultTtlMs: Number(server?.tasks?.defaultTtlMs) || 60 * 60 * 1000,
    },
    elicitation: {
      enabled: server?.elicitation?.enabled !== false,
      allowPrivateUrl: server?.elicitation?.allowPrivateUrl === true,
    },
    roots: Array.isArray(server?.roots) ? server.roots.map((root) => ({
      rootId: makePublicRootToken(senderId, server.name, root.rootId),
      label: root.label,
    })) : [],
    session: status
      ? publicSessionStatus(status)
      : {
        state: server?.sessionRecovery ? 'idle' : 'disabled',
        reusable: server?.sessionRecovery === true,
        lastErrorCode: null,
      },
  };
  // These fields are needed to edit the server row. Do not spread the
  // persisted object: stdio env and remote headers may contain credentials.
  if (server?.command) out.command = String(server.command);
  if (server?.url) out.url = String(server.url);
  if (server?.timeoutMs != null) out.timeoutMs = Number(server.timeoutMs);
  if (server?.allowPrivate === true) out.allowPrivate = true;
  if (server?.auth === 'oauth') {
    out.auth = 'oauth';
    const oauth = server.oauth && typeof server.oauth === 'object' ? server.oauth : {};
    out.oauth = {};
    for (const key of [
      'clientId',
      'resource',
      'authorizationServer',
      'authorizationEndpoint',
      'tokenEndpoint',
      'registrationEndpoint',
      'revocationEndpoint',
    ]) {
      if (oauth[key]) out.oauth[key] = String(oauth[key]);
    }
    if (Array.isArray(oauth.scopes)) out.oauth.scopes = oauth.scopes.map(String).slice(0, 32);
  } else {
    out.auth = 'none';
  }
  return out;
}

function toPublicSettings(s, senderId) {
  const servers = sanitizeMcpServers(s.mcpServers);
  const statuses = new Map(getMcpSessionManager().status().map((status) => [status.server, status]));
  return {
    mode: s.mode,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKeySet: Boolean(s.apiKey),
    apiKey: '',
    agentEnabled: s.agentEnabled !== false,
    maxAgentTurns: s.maxAgentTurns ?? 8,
    permissionMode: PERMISSION_MODES.has(s.permissionMode) ? s.permissionMode : 'confirm-writes',
    terminalEnabled: Boolean(s.terminalEnabled),
    terminalRequireConfirm: s.terminalRequireConfirm !== false,
    terminalTimeoutMs: s.terminalTimeoutMs ?? 60000,
    defaultAgentMode: AGENT_MODES.has(s.defaultAgentMode) ? s.defaultAgentMode : 'agent',
    verifyCommand: s.verifyCommand != null ? String(s.verifyCommand) : '',
    verifyBeforeDone: s.verifyBeforeDone !== false,
    skillsEnabled: s.skillsEnabled !== false,
    subagentEnabled: s.subagentEnabled !== false,
    mcpEnabled: Boolean(s.mcpEnabled),
    mcpServers: servers.map((server) => publicMcpServer(server, statuses.get(server.name), senderId)),
    mcpTasksPersistence: getMcpTaskManager().persistence(),
    hooksEnabled: s.hooksEnabled !== false,
    exploreMaxParallel: (() => {
      const n = Number(s.exploreMaxParallel);
      if (!Number.isFinite(n)) return 2;
      return Math.max(1, Math.min(3, Math.floor(n)));
    })(),
    autoCompact: s.autoCompact === true,
    compactKeepMessages: clampInt(s.compactKeepMessages, 6, 80, 24),
    compactMaxMessages: clampInt(s.compactMaxMessages, 20, 200, 40),
    compactMaxApproxTokens: clampInt(s.compactMaxApproxTokens, 4000, 200000, 24000),
    memoryEnabled: s.memoryEnabled !== false,
    memoryMaxEntries: clampInt(s.memoryMaxEntries, 20, 2000, 200),
    memoryInjectTopN: clampInt(s.memoryInjectTopN, 0, 30, 8),
    memoryInjectMaxTokens: clampInt(s.memoryInjectMaxTokens, 200, 8000, 1200),
    memoryCandidateEnabled: s.memoryCandidateEnabled !== false,
    webEnabled: s.webEnabled === true,
    webRequireConfirm: s.webRequireConfirm !== false,
    webAllowDomains: normalizeDomainList(s.webAllowDomains),
    webDenyDomains: normalizeDomainList(s.webDenyDomains),
    webTimeoutMs: clampInt(s.webTimeoutMs, 3000, 60000, 15000),
    webMaxBytes: clampInt(s.webMaxBytes, 32768, 4194304, 524288),
    webMaxChars: clampInt(s.webMaxChars, 1000, 50000, 15000),
    usageEnabled: s.usageEnabled !== false,
    usageMaxRecords: clampInt(s.usageMaxRecords, 500, 50000, 5000),
    usagePricing: sanitizePricing(s.usagePricing),
    usageCurrency: String(s.usageCurrency ?? '$').slice(0, 4) || '$',
    codeIndexEnabled: s.codeIndexEnabled !== false,
    // Generic settings expose only bounded summaries. Commands are available
    // solely through a sender-owned project binding in engineering IPC.
    verificationProfiles: (Array.isArray(s.verificationProfiles) ? s.verificationProfiles : []).slice(0, 100).map((p) => ({
      id: String(p.id || ''), name: String(p.name || ''), kind: String(p.kind || 'custom'),
      enabled: p.enabled !== false,
    })),
  };
}

function isAbortError(err, signal) {
  if (!err && !signal) return false;
  if (signal?.aborted) return true;
  if (err?.code === 'ABORTED' || err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '');
  return /已停止|The user aborted a request|AbortError/i.test(msg);
}

function throwAborted() {
  const e = new Error('已停止');
  e.code = 'ABORTED';
  throw e;
}

function makeRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function safeSend(sender, channel, data) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, data);
    }
  } catch {
    /* ignore destroyed sender */
  }
}

function abortActiveRun() {
  if (!activeRun) return;
  try {
    activeRun.abort.abort();
  } catch {
    /* ignore */
  }
}

function abortManualTerm() {
  if (!manualTerm) return;
  try {
    manualTerm.abort.abort();
  } catch {
    /* ignore */
  }
}

function makeTermId() {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#c3d9f1',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const worktreeSenderId = win.webContents.id;
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame !== false) {
      worktreeIpc.dropSender(worktreeSenderId);
      engineeringIpc?.dropSender?.(worktreeSenderId);
    }
  });
  win.webContents.once('destroyed', () => worktreeIpc.dropSender(worktreeSenderId));
  win.webContents.once('destroyed', () => engineeringIpc?.dropSender?.(worktreeSenderId));
  win.webContents.once('destroyed', () => cancelOAuthFlowsForSender(worktreeSenderId));
  win.webContents.once('destroyed', () => mcpElicitationController?.cancelOwner?.(worktreeSenderId));
  win.webContents.once('destroyed', () => {
    dropMcpRootTokens(worktreeSenderId);
    mcpProjectBySender.delete(worktreeSenderId);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    Menu?.setApplicationMenu(null);
    getMcpOAuthManager();
    // Decrypt the verification stores now so an interrupted job is recorded as
    // such before any window asks for it. This never re-runs a command.
    try { getEngineeringIpc().restoreAtStartup(); } catch {}
    createWindow();
    restoreMcpTasksAtStartup().catch(() => {});
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.all([
    Promise.resolve().then(() => mcpOAuthManager?.closeAll?.()),
    Promise.resolve().then(() => mcpSessionManager?.closeAll?.()),
    Promise.resolve().then(() => mcpTaskManager?.close?.()),
    Promise.resolve().then(() => mcpElicitationController?.cancelAll?.()),
    Promise.resolve().then(() => engineeringIpc?.close?.()),
  ]).catch(() => {}).finally(() => app.quit());
});

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents?.(event?.sender)
    || BrowserWindow.getFocusedWindow?.()
    || null;
}

ipcMain.handle('window:minimize', (event) => {
  const win = windowFromEvent(event);
  if (win && !win.isDestroyed?.()) win.minimize();
  return { ok: Boolean(win) };
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = windowFromEvent(event);
  if (!win || win.isDestroyed?.()) return { ok: false, maximized: false };
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return { ok: true, maximized: win.isMaximized() };
});

ipcMain.handle('window:close', (event) => {
  const win = windowFromEvent(event);
  if (win && !win.isDestroyed?.()) win.close();
  return { ok: Boolean(win) };
});

ipcMain.handle('settings:get', async (event) => toPublicSettings(loadSettings(userDataPath()), event.sender.id));

ipcMain.handle('settings:save', async (event, partial = {}) => {
  const nextPartial = { ...partial };
  const currentSettings = loadSettings(userDataPath());
  if (!nextPartial.apiKey) delete nextPartial.apiKey;
  for (const k of [
    'agentEnabled',
    'terminalEnabled',
    'terminalRequireConfirm',
    'verifyBeforeDone',
    'skillsEnabled',
    'subagentEnabled',
    'mcpEnabled',
    'hooksEnabled',
    'autoCompact',
    'memoryEnabled',
    'memoryCandidateEnabled',
    'webEnabled',
    'usageEnabled',
    'codeIndexEnabled',
  ]) {
    if (k in nextPartial) nextPartial[k] = Boolean(nextPartial[k]);
  }
  for (const [k, min, max, fallback] of [
    ['compactKeepMessages', 6, 80, 24],
    ['compactMaxMessages', 20, 200, 40],
    ['compactMaxApproxTokens', 4000, 200000, 24000],
    ['memoryMaxEntries', 20, 2000, 200],
    ['memoryInjectTopN', 0, 30, 8],
    ['memoryInjectMaxTokens', 200, 8000, 1200],
    ['webTimeoutMs', 3000, 60000, 15000],
    ['webMaxBytes', 32768, 4194304, 524288],
    ['webMaxChars', 1000, 50000, 15000],
    ['usageMaxRecords', 500, 50000, 5000],
  ]) {
    if (k in nextPartial) nextPartial[k] = clampInt(nextPartial[k], min, max, fallback);
  }
  if ('maxAgentTurns' in nextPartial) {
    const n = Number(nextPartial.maxAgentTurns);
    if (n === 0) nextPartial.maxAgentTurns = 0;
    else nextPartial.maxAgentTurns = Math.max(1, Math.min(50, Number.isFinite(n) && n > 0 ? n : 8));
  }
  if ('exploreMaxParallel' in nextPartial) {
    const n = Number(nextPartial.exploreMaxParallel);
    if (!Number.isFinite(n)) nextPartial.exploreMaxParallel = 2;
    else nextPartial.exploreMaxParallel = Math.max(1, Math.min(3, Math.floor(n)));
  }
  if ('permissionMode' in nextPartial) {
    if (!PERMISSION_MODES.has(nextPartial.permissionMode)) {
      delete nextPartial.permissionMode;
    }
  }
  if ('defaultAgentMode' in nextPartial) {
    nextPartial.defaultAgentMode = normalizeAgentMode(nextPartial.defaultAgentMode);
  }
  if ('verifyCommand' in nextPartial) {
    nextPartial.verifyCommand = String(nextPartial.verifyCommand ?? '');
  }
  if ('verificationProfiles' in nextPartial) {
    // Commands can be saved only after resolving a sender-owned project
    // binding through engineering:verification:profile:*.
    delete nextPartial.verificationProfiles;
  }
  if ('mcpServers' in nextPartial) {
    const incoming = sanitizeMcpServers(nextPartial.mcpServers);
    // Keep paths for roots that were already authorized by main. A renderer
    // payload may carry only rootId/label; arbitrary submitted paths never
    // enter settings through this handler.
    const currentByServer = new Map((currentSettings.mcpServers || []).map((server) => [server.name, server]));
    nextPartial.mcpServers = incoming.map((server) => {
      const previous = currentByServer.get(server.name);
      const previousRoots = new Map((previous?.roots || []).map((root) => [root.rootId, root]));
      const sameTransport = previous && previous.transport === server.transport;
      const preserved = sameTransport
        ? {
          ...(server.transport === 'stdio' && server.args === undefined && Array.isArray(previous.args) ? { args: previous.args } : {}),
          ...(server.transport === 'stdio' && server.cwd === undefined && previous.cwd ? { cwd: previous.cwd } : {}),
          ...(server.transport === 'stdio' && server.env === undefined && previous.env ? { env: previous.env } : {}),
          ...(server.transport !== 'stdio' && server.headers === undefined && previous.headers ? { headers: previous.headers } : {}),
        }
        : {};
      return {
        ...server,
        ...preserved,
        roots: (server.roots || []).map((root) => {
          const persistedRootId = resolvePublicRootId(event.sender.id, server.name, root.rootId) || root.rootId;
          const authorized = previousRoots.get(persistedRootId);
          return authorized ? { ...root, rootId: authorized.rootId, label: authorized.label, path: authorized.path } : null;
        }).filter(Boolean),
      };
    });
    const incomingByName = new Map(nextPartial.mcpServers.map((server) => [server.name, server]));
    const locked = [];
    for (const current of currentSettings.mcpServers || []) {
      if (getMcpTaskManager().canChangeServer(current.name)) continue;
      const incoming = incomingByName.get(current.name);
      if (!incoming || configFingerprint(current) !== configFingerprint(incoming)) {
        locked.push({
          server: current.name,
          tasks: getMcpTaskManager().list({ server: current.name })
            .filter((task) => task.canCancel || task.canAbandon),
        });
      }
    }
    if (locked.length) {
      return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用', locked };
    }
  }
  const saved = saveSettings(userDataPath(), nextPartial);
  if ('mcpServers' in nextPartial) {
    await getMcpSessionManager().invalidate(
      (entry) => getMcpTaskManager().canChangeServer(entry.serverName),
      'config-changed',
    );
  }
  return toPublicSettings(saved, event.sender.id);
});

ipcMain.handle('mcp:testServer', async (_e, rawCfg) => {
  const list = sanitizeMcpServers([rawCfg]);
  if (!list.length) return { ok: false, error: '无效配置' };
  let cfg = list[0];
  const saved = loadSettings(userDataPath()).mcpServers.find((server) => server.name === cfg.name);
  if (saved && rawCfg && typeof rawCfg === 'object') {
    const sameTransport = saved.transport === cfg.transport;
    const preserved = sameTransport
      ? {
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'args') && Array.isArray(saved.args) ? { args: saved.args } : {}),
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'cwd') && saved.cwd ? { cwd: saved.cwd } : {}),
        ...(cfg.transport === 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'env') && saved.env ? { env: saved.env } : {}),
        ...(cfg.transport !== 'stdio' && !Object.prototype.hasOwnProperty.call(rawCfg, 'headers') && saved.headers ? { headers: saved.headers } : {}),
      }
      : {};
    cfg = { ...saved, ...cfg, ...preserved };
  }
  const { createMcpClient } = require('./ai/mcp-client');
  const manager = cfg.auth === 'oauth' ? getMcpOAuthManager() : null;
  const client = createMcpClient({
    ...cfg,
    timeoutMs: Math.min(cfg.timeoutMs || 15000, 15000),
    allowPrivate: cfg.allowPrivate === true,
    authProvider: manager?.getAuthProvider?.(cfg.name, cfg),
  });
  try {
    await client.start();
    const tools = await client.listTools();
    let resourcesCount = 0;
    try {
      const res = await client.listResources();
      resourcesCount = Array.isArray(res) ? res.length : 0;
    } catch { /* ignore */ }
    let promptsCount = 0;
    try {
      const prompts = await client.listPrompts?.();
      promptsCount = Array.isArray(prompts) ? prompts.length : 0;
    } catch { /* ignore */ }
    await client.close();
    return { ok: true, toolsCount: tools.length, resourcesCount, promptsCount, transport: cfg.transport };
  } catch (err) {
    try { await client.close(); } catch { /* */ }
    return { ok: false, error: err.message || String(err), transport: cfg.transport };
  }
});

function publicSessionStatus(status) {
  return {
    state: ['disabled', 'idle', 'connected', 'reconnecting', 'error'].includes(status?.state) ? status.state : 'idle',
    reusable: status?.reusable === true,
    lastErrorCode: status?.lastErrorCode ? String(status.lastErrorCode).slice(0, 64) : null,
  };
}

function savedMcpServer(name) {
  const settings = loadSettings(userDataPath());
  const server = settings.mcpServers.find((item) => item.name === String(name || '').trim());
  return { settings, server };
}

function canonicalDirectory(rawPath) {
  const candidate = String(rawPath || '').trim();
  if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) return '';
  try {
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isDirectory()) return '';
    return canonical;
  } catch { return ''; }
}

function makeRootId() {
  return `root_${crypto.randomBytes(18).toString('base64url')}`;
}

ipcMain.handle('mcp:roots:choose', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const { settings, server } = savedMcpServer(name);
  if (!server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  const currentRoots = Array.isArray(server.roots) ? server.roots : [];
  if (currentRoots.length >= 8) return { ok: false, code: 'MCP_ROOT_LIMIT', error: '每个 MCP 服务器最多授权 8 个目录' };
  const win = windowFromEvent(event);
  const result = await dialog.showOpenDialog(win || undefined, {
    title: `为 ${name} 授权 MCP 目录`,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  const canonical = canonicalDirectory(result.filePaths[0]);
  if (!canonical) return { ok: false, code: 'MCP_ROOT_INVALID', error: '所选路径不是有效目录' };
  const existing = currentRoots.find((item) => item?.path && canonicalDirectory(item.path) === canonical);
  if (existing) {
    return {
      ok: true,
      root: { rootId: makePublicRootToken(event.sender.id, name, existing.rootId), label: existing.label },
      settings: toPublicSettings(settings, event.sender.id),
    };
  }
  const root = {
    rootId: makeRootId(),
    label: path.basename(canonical) || canonical,
    path: canonical,
  };
  const nextServers = settings.mcpServers.map((item) => item.name === name
    ? { ...item, roots: [...currentRoots, root].slice(0, 8) }
    : item);
  const saved = saveSettings(userDataPath(), { mcpServers: nextServers });
  await getMcpSessionManager().notifyRootsChanged?.(name);
  await getMcpSessionManager().invalidate(name, 'roots-changed');
  return { ok: true, root: { rootId: makePublicRootToken(event.sender.id, name, root.rootId), label: root.label }, settings: toPublicSettings(saved, event.sender.id) };
});

ipcMain.handle('mcp:roots:remove', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const rootId = String(payload?.rootId || '').trim();
  if (!name || !rootId) return { ok: false, code: 'MCP_ROOT_INVALID', error: 'name/rootId 必填' };
  const persistedRootId = resolvePublicRootId(event.sender.id, name, rootId);
  if (!persistedRootId) return { ok: false, code: 'MCP_ROOT_OWNER', error: '无权操作此目录授权' };
  const { settings, server } = savedMcpServer(name);
  if (!server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  const roots = (server.roots || []).filter((root) => root.rootId !== persistedRootId);
  if (roots.length === (server.roots || []).length) return { ok: false, code: 'MCP_ROOT_NOT_FOUND', error: '目录授权不存在' };
  const saved = saveSettings(userDataPath(), { mcpServers: settings.mcpServers.map((item) => item.name === name ? { ...item, roots } : item) });
  await getMcpSessionManager().notifyRootsChanged?.(name);
  await getMcpSessionManager().invalidate(name, 'roots-changed');
  return { ok: true, settings: toPublicSettings(saved, event.sender.id) };
});

ipcMain.handle('mcp:session:status', async (_event, payload = {}) => {
  const name = payload?.name ? String(payload.name).trim() : '';
  const statuses = getMcpSessionManager().status(name).map((status) => ({ name: status.server, session: publicSessionStatus(status) }));
  const settings = loadSettings(userDataPath());
  if (name) return { ok: true, name, session: statuses[0]?.session || { state: 'disabled', reusable: false, lastErrorCode: null } };
  return {
    ok: true,
    sessions: settings.mcpServers.map((server) => ({ name: server.name, session: statuses.find((item) => item.name === server.name)?.session || { state: server.sessionRecovery ? 'idle' : 'disabled', reusable: server.sessionRecovery === true, lastErrorCode: null } })),
  };
});

ipcMain.handle('mcp:session:reset', async (_event, payload = {}) => {
  const name = payload?.name ? String(payload.name).trim() : null;
  if (!getMcpTaskManager().canChangeServer(name || undefined)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  await getMcpSessionManager().invalidate(name, 'manual-reset');
  return { ok: true };
});

function taskRefFromPayload(payload) {
  const ref = String(payload?.taskRef || '').trim();
  if (!/^mcp_task_[a-f0-9]{16,64}$/.test(ref)) {
    const error = new Error('任务引用无效');
    error.code = 'MCP_TASK_INVALID';
    throw error;
  }
  return ref;
}

ipcMain.handle('mcp:tasks:list', async (_event, payload = {}) => {
  const server = payload?.server ? String(payload.server).trim().slice(0, 96) : '';
  const limit = Number(payload?.limit);
  return { ok: true, persistence: getMcpTaskManager().persistence(), tasks: getMcpTaskManager().list({ server, limit }) };
});

ipcMain.handle('mcp:tasks:get', async (_event, payload = {}) => {
  try { return { ok: true, task: getMcpTaskManager().get(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_NOT_FOUND', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result', async (_event, payload = {}) => {
  try {
    const result = await getMcpTaskManager().result(taskRefFromPayload(payload));
    return { ok: true, result };
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_RESULT_UNAVAILABLE', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result:prepare', async (_event, payload = {}) => {
  try {
    const targetSessionId = String(payload?.targetSessionId || '').trim().slice(0, 160);
    if (!targetSessionId) return { ok: false, code: 'MCP_TASK_CLAIM_INVALID', error: '目标会话不能为空' };
    return await getMcpTaskManager().prepareResultClaim(taskRefFromPayload(payload), targetSessionId);
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CLAIM_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:tasks:result:commit', async (_event, payload = {}) => {
  try {
    const claimId = String(payload?.claimId || '').trim();
    if (!/^mcp_claim_[a-f0-9]{16,64}$/.test(claimId)) return { ok: false, code: 'MCP_TASK_CLAIM_INVALID', error: '认领凭证无效' };
    return await getMcpTaskManager().commitResultClaim(claimId, String(payload?.targetSessionId || '').trim().slice(0, 160));
  } catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CLAIM_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:tasks:cancel', async (_event, payload = {}) => {
  try { return { ok: true, task: await getMcpTaskManager().cancel(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_CANCEL_FAILED', error: error.message }; }
});

ipcMain.handle('mcp:tasks:abandon', async (_event, payload = {}) => {
  try { return { ok: true, task: getMcpTaskManager().abandon(taskRefFromPayload(payload)) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_TASK_NOT_FOUND', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:respond', async (event, payload = {}) => {
  try {
    const id = String(payload?.elicitationId || '').trim();
    const action = String(payload?.action || '').trim();
    const content = payload?.content && typeof payload.content === 'object' && !Array.isArray(payload.content) ? payload.content : undefined;
    return { ok: true, response: getMcpElicitationController().respond(id, action, content, event.sender.id) };
  } catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_SCHEMA_INVALID', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:cancel', async (event, payload = {}) => {
  try { return { ok: true, cancelled: getMcpElicitationController().cancel(String(payload?.elicitationId || ''), event.sender.id) }; }
  catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_CANCELLED', error: error.message }; }
});

ipcMain.handle('mcp:elicitation:open-url', async (event, payload = {}) => {
  try { return await getMcpElicitationController().openUrl(String(payload?.elicitationId || ''), event.sender.id); }
  catch (error) { return { ok: false, code: error.code || 'MCP_ELICITATION_OPEN_FAILED', error: error.message }; }
});

async function withPromptHub(senderId, payload, callback) {
  const settings = loadSettings(userDataPath());
  const projectPath = mcpProjectBySender.get(Number(senderId)) || '';
  const requestedServer = payload?.server ? String(payload.server).trim() : '';
  const serverConfigs = requestedServer
    ? settings.mcpServers.filter((server) => server.name === requestedServer)
    : settings.mcpServers;
  const hub = createMcpHub({ sessionManager: getMcpSessionManager() });
  try {
    await hub.startAll(serverConfigs, {
      cwd: projectPath || undefined,
      project: projectPath ? { path: projectPath, name: path.basename(projectPath) } : null,
      oauthManager: getMcpOAuthManager(),
    });
    return await callback(hub, settings);
  } finally {
    await hub.stopAll();
  }
}

ipcMain.handle('mcp:prompts:list', async (event, payload = {}) => {
  const name = payload?.server ? String(payload.server).trim() : '';
  const { server } = name ? savedMcpServer(name) : { server: true };
  if (name && !server) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  try { return await withPromptHub(event.sender.id, payload, (hub) => hub.listPrompts(name)); } catch (error) { return { ok: false, code: error?.code || 'MCP_PROMPT_FAILED', error: error?.message || String(error) }; }
});

ipcMain.handle('mcp:prompts:get', async (event, payload = {}) => {
  const server = String(payload?.server || '').trim();
  const name = String(payload?.name || '').trim();
  const saved = savedMcpServer(server).server;
  if (!saved) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'MCP 服务器未保存' };
  if (!name) return { ok: false, code: 'MCP_PROMPT_ARGUMENTS_INVALID', error: 'prompt name 必填' };
  try { return await withPromptHub(event.sender.id, payload, (hub) => hub.getPrompt(server, name, payload.arguments)); } catch (error) { return { ok: false, code: error?.code || 'MCP_PROMPT_FAILED', error: error?.message || String(error) }; }
});

ipcMain.handle('mcp:oauth:status', async () => {
  const settings = loadSettings(userDataPath());
  return {
    ok: true,
    statuses: getMcpOAuthManager().statuses(settings.mcpServers),
  };
});

ipcMain.handle('mcp:oauth:authorize', async (event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const settings = loadSettings(userDataPath());
  const cfg = settings.mcpServers.find((item) => item.name === name);
  if (!cfg || cfg.auth !== 'oauth') return { ok: false, code: 'MCP_OAUTH_METADATA_INVALID', error: '请先保存有效的 OAuth MCP 配置' };
  if (oauthPendingOwnersByName.has(name)) return { ok: false, code: 'MCP_OAUTH_CALLBACK_TIMEOUT', error: '该服务器已有授权流程正在进行' };
  const manager = getMcpOAuthManager();
  oauthPendingOwnersByName.set(name, event.sender.id);
  try {
    const status = await manager.authorize(name, cfg);
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'MCP_OAUTH_TOKEN_FAILED',
      error: error?.message || 'OAuth 授权失败',
    };
  } finally {
    oauthPendingOwnersByName.delete(name);
  }
});

ipcMain.handle('mcp:oauth:cancel', async (event, payload = {}) => {
  const flowId = String(payload?.flowId || '').trim();
  if (!flowId || oauthFlowOwners.get(flowId) !== event.sender.id) {
    return { ok: false, code: 'MCP_OAUTH_STATE_MISMATCH', error: '无权取消此授权流程' };
  }
  const ok = getMcpOAuthManager().cancel(flowId);
  return ok ? { ok: true } : { ok: false, code: 'MCP_OAUTH_STATE_MISMATCH', error: '授权流程不存在' };
});

ipcMain.handle('mcp:oauth:logout', async (_event, payload = {}) => {
  const name = String(payload?.name || '').trim();
  const settings = loadSettings(userDataPath());
  const cfg = settings.mcpServers.find((item) => item.name === name);
  if (!cfg || cfg.auth !== 'oauth') return { ok: false, code: 'MCP_OAUTH_METADATA_INVALID', error: 'OAuth MCP 配置不存在' };
  if (!getMcpTaskManager().canChangeServer(name)) {
    return { ok: false, code: 'MCP_TASKS_CONFIG_LOCKED', error: '该 MCP 服务器仍有后台任务，请先取消或遗弃任务引用' };
  }
  try {
    const result = await getMcpOAuthManager().logout(name, cfg);
    await getMcpSessionManager().invalidate(name, 'oauth-logout');
    return result;
  } catch (error) {
    return { ok: false, code: error?.code || 'MCP_OAUTH_STORE_UNAVAILABLE', error: error?.message || '退出授权失败' };
  }
});

ipcMain.handle('skills:list', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  return {
    ok: true,
    skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
  };
});

ipcMain.handle('skills:get', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  const name = String(payload.name || '').trim().toLowerCase();
  const meta = skills.find((s) => s.name === name);
  if (!meta) return { ok: false, error: '未找到 skill: ' + name };
  return loadSkillBody(meta);
});

ipcMain.handle('hooks:summary', async (_e, payload = {}) => {
  const settings = loadSettings(userDataPath());
  const projectPath = payload.projectPath ? String(payload.projectPath) : null;
  const resolved = loadHooks({
    userDataPath: userDataPath(),
    projectPath,
  });
  return {
    enabled: settings.hooksEnabled !== false,
    userPath: resolved.userPath,
    projectPath: resolved.projectPath,
    countsByEvent: resolved.countsByEvent,
    errors: resolved.errors,
  };
});

/**
 * Phase D.1 compact. The preload is sandboxed and cannot require local modules,
 * so plan → summarize → apply all happen here in one round trip; the renderer
 * just swaps in the returned messages array.
 */
ipcMain.handle('session:compact', async (_e, payload = {}) => {
  try {
    if (activeRun) return { ok: false, error: '有对话正在进行，请先停止再压缩' };
    const settings = loadSettings(userDataPath());
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const plan = planCompact(messages, {
      keepMessages: settings.compactKeepMessages,
      maxMessages: settings.compactMaxMessages,
      maxApproxTokens: settings.compactMaxApproxTokens,
      force: payload.force === true,
    });
    if (!plan.needed) {
      return { ok: true, needed: false, approxTokens: plan.approxTokens, candidates: [] };
    }
    const transcript = serializeOlderTranscript(plan.older);
    let compactUsage = null;
    const onUsage = ({ rawUsage, messages: sentMessages, content }) => {
      const usageEvent = buildUsageEvent({
        settings,
        messages: sentMessages,
        msg: { content, usage: rawUsage },
      });
      if (usageEvent) {
        compactUsage = {
          ...usageEvent,
          kind: 'compact',
        };
        persistUsageEvent(settings, payload.sessionId, compactUsage);
      }
    };
    const candidateLimit = clampInt(payload.candidateLimit, 0, 5, 0);
    const artifacts = await generateCompactArtifacts({
      transcript,
      settings,
      chatFn: chatCompletionMessage,
      candidateLimit,
      onUsage,
    });
    return {
      ok: true,
      needed: true,
      messages: applyCompact(messages, plan, artifacts.summary),
      compactedCount: plan.older.length,
      approxTokens: plan.approxTokens,
      olderApproxTokens: plan.olderApproxTokens,
      usage: compactUsage,
      candidates: artifacts.candidates,
      candidateWarning: artifacts.candidateWarning,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/** Phase D.1 export: serialize here, then write wherever the user picks. */
ipcMain.handle('session:export', async (_e, payload = {}) => {
  try {
    const format = payload.format === 'json' ? 'json' : 'md';
    const session = payload.session && typeof payload.session === 'object' ? payload.session : {};
    const content = format === 'json' ? exportSessionJson(session) : exportSessionMarkdown(session);
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win || undefined, {
      title: '导出会话',
      defaultPath: defaultExportFilename(session, format),
      filters: format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/**
 * Phase D.2 memory channels — UI-driven, so no PermissionGate (the tiers gate
 * the model, not the user). All the logic lives in the pure handlers.
 */
ipcMain.handle('memory:list', async (_e, payload = {}) => memoryList({
  settings: loadSettings(userDataPath()), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:add', async (_e, payload = {}) => memoryAdd({
  settings: loadSettings(userDataPath()), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:delete', async (_e, payload = {}) => memoryDelete({
  settings: loadSettings(userDataPath()), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:accept', async (_e, payload = {}) => memoryAccept({
  settings: loadSettings(userDataPath()), userDataPath: userDataPath(), payload,
}));

ipcMain.handle('memory:update', async (_e, payload = {}) => memoryUpdate({
  settings: loadSettings(userDataPath()), userDataPath: userDataPath(), payload,
}));

// Phase D.5 worktree results. Only bind accepts a project path; every later
// call routes through the sender-scoped opaque binding token.
ipcMain.handle('worktree:bind', async (event, payload = {}) => worktreeIpc.bind(event, payload));
ipcMain.handle('worktree:unbind', async (event, payload = {}) => {
  const binding = worktreeIpc.resolveBinding(event, payload);
  const result = worktreeIpc.unbind(event, payload);
  if (result?.ok && binding?.projectPath && !worktreeIpc.hasProjectBinding(event, binding.projectPath)) {
    engineeringIpc?.dropProject(event, binding.projectPath);
  }
  return result;
});
ipcMain.handle('worktree:list', async (event, payload = {}) => worktreeIpc.list(event, payload));
ipcMain.handle('worktree:get', async (event, payload = {}) => worktreeIpc.get(event, payload));
ipcMain.handle('worktree:apply', async (event, payload = {}) => worktreeIpc.apply(event, payload));
ipcMain.handle('worktree:discard', async (event, payload = {}) => worktreeIpc.discard(event, payload));
ipcMain.handle('worktree:retryCollect', async (event, payload = {}) => worktreeIpc.retryCollect(event, payload));
ipcMain.handle('worktree:cleanup', async (event, payload = {}) => worktreeIpc.cleanup(event, payload));
ipcMain.handle('worktree:open', async (event, payload = {}) => worktreeIpc.open(event, payload));
ipcMain.handle('worktree:pr:preflight', async (event, payload = {}) => worktreeIpc.preflight(event, payload));
ipcMain.handle('worktree:pr:create', async (event, payload = {}) => worktreeIpc.createPr(event, payload));
ipcMain.handle('worktree:pr:retry', async (event, payload = {}) => worktreeIpc.retryPr(event, payload));
ipcMain.handle('worktree:pr:cleanup', async (event, payload = {}) => worktreeIpc.cleanupPr(event, payload));
ipcMain.handle('worktree:pr:list', async (event, payload = {}) => worktreeIpc.listPrs(event, payload));
ipcMain.handle('worktree:pr:get', async (event, payload = {}) => worktreeIpc.getPr(event, payload));
ipcMain.handle('worktree:pr:edit', async (event, payload = {}) => worktreeIpc.editPr(event, payload));
ipcMain.handle('worktree:pr:comment', async (event, payload = {}) => worktreeIpc.commentPr(event, payload));
ipcMain.handle('worktree:pr:close', async (event, payload = {}) => worktreeIpc.closeLifecyclePr(event, payload));
ipcMain.handle('worktree:pr:reopen', async (event, payload = {}) => worktreeIpc.reopenPr(event, payload));
ipcMain.handle('worktree:pr:ready', async (event, payload = {}) => worktreeIpc.readyPr(event, payload));
ipcMain.handle('worktree:pr:merge', async (event, payload = {}) => worktreeIpc.mergePr(event, payload));
ipcMain.handle('worktree:pr:open', async (event, payload = {}) => worktreeIpc.openPr(event, payload));

// Phase D.11 engineering center. All project access is resolved through the
// sender-owned worktree binding; renderer payloads never carry a path/command.
ipcMain.handle('engineering:index:ensure', async (event, payload = {}) => getEngineeringIpc().ensure(event, payload));
ipcMain.handle('engineering:index:status', async (event, payload = {}) => getEngineeringIpc().status(event, payload));
ipcMain.handle('engineering:index:rebuild', async (event, payload = {}) => getEngineeringIpc().rebuild(event, payload));
ipcMain.handle('engineering:index:clear', async (event, payload = {}) => getEngineeringIpc().clear(event, payload));
ipcMain.handle('engineering:index:search', async (event, payload = {}) => getEngineeringIpc().search(event, payload));
ipcMain.handle('engineering:index:location', async (event, payload = {}) => getEngineeringIpc().location(event, payload));
ipcMain.handle('engineering:verification:profiles', async (event, payload = {}) => getEngineeringIpc().profiles(event, payload));
ipcMain.handle('engineering:verification:profile:save', async (event, payload = {}) => getEngineeringIpc().saveProfile(event, payload));
ipcMain.handle('engineering:verification:profile:delete', async (event, payload = {}) => getEngineeringIpc().deleteProfile(event, payload));
ipcMain.handle('engineering:verification:run', async (event, payload = {}) => getEngineeringIpc().run(event, payload));
ipcMain.handle('engineering:verification:list', async (event, payload = {}) => getEngineeringIpc().list(event, payload));
ipcMain.handle('engineering:verification:get', async (event, payload = {}) => getEngineeringIpc().get(event, payload));
ipcMain.handle('engineering:verification:result', async (event, payload = {}) => getEngineeringIpc().result(event, payload));
ipcMain.handle('engineering:verification:cancel', async (event, payload = {}) => getEngineeringIpc().cancel(event, payload));
ipcMain.handle('engineering:verification:rerun', async (event, payload = {}) => getEngineeringIpc().rerun(event, payload));
ipcMain.handle('engineering:verification:revoke-grant', async (event, payload = {}) => getEngineeringIpc().revokeGrant(event, payload));

ipcMain.handle('dialog:selectDirectory', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win || undefined, {
    title: '选择项目目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths?.[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_e, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) throw new Error('路径不存在');
  const err = await shell.openPath(targetPath);
  if (err) throw new Error(err);
  return true;
});

ipcMain.handle('project:listTree', async (_e, projectPath, opts) => listTree(projectPath, opts || {}));
ipcMain.handle('project:readFile', async (_e, projectPath, relPath) => readFile(projectPath, relPath));
ipcMain.handle('project:writeFile', async (_e, projectPath, relPath, content) => writeFile(projectPath, relPath, content));
ipcMain.handle('project:deletePath', async (_e, projectPath, relPath) => deletePath(projectPath, relPath));

// Read-only git IPC (no commit — commit only via agent tool)
ipcMain.handle('git:status', async (_e, payload = {}) => {
  const projectPath = payload?.projectPath;
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return { ok: false, branch: '', entries: [], summary: '', error: 'projectPath 无效' };
  }
  return gitStatus(projectPath);
});

ipcMain.handle('git:diff', async (_e, payload = {}) => {
  const projectPath = payload?.projectPath;
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return {
      ok: false,
      text: '',
      truncated: false,
      staged: !!payload?.staged,
      error: 'projectPath 无效',
    };
  }
  return gitDiff(projectPath, {
    path: payload.path,
    staged: payload.staged,
    maxBytes: payload.maxBytes,
  });
});

ipcMain.handle('chat:stop', async () => {
  // Abort chat/agent run only — does NOT stop manual terminal panel runs.
  // PermissionGate waitForApproval rejects pending entries on signal abort.
  abortActiveRun();
  return { ok: true };
});

ipcMain.handle('chat:approve', async (event, payload = {}) => {
  const approvalId = payload?.approvalId;
  const decision = payload?.decision;
  if (!approvalId) {
    return { ok: false, error: 'no-active-approval' };
  }
  const normalized =
    decision === 'allow' || decision === 'allow_session' ? decision : 'deny';
  // Try active chat gate first, then manual terminal gate.
  const candidates = [
    activeRun ? { gate: activeRun.gate, sender: activeRun.sender, runId: activeRun.runId } : null,
    manualTerm ? { gate: manualTerm.gate, sender: manualTerm.sender, runId: activeRun?.runId ?? null } : null,
    // Background D11 verification approvals are owned by the invoking
    // renderer sender and are resolved without attaching them to chat history.
    getEngineeringIpc() ? { gate: { resolveApproval: (id, d) => getEngineeringIpc().resolveApproval(event, id, d) }, sender: event.sender, runId: null } : null,
  ].filter(Boolean);

  if (!candidates.length) {
    return { ok: false, error: 'no-active-approval' };
  }

  for (const c of candidates) {
    if (c.sender && c.sender !== event.sender) continue;
    if (payload?.runId && c.runId && String(payload.runId) !== String(c.runId)) continue;
    if (c.gate.resolveApproval(approvalId, normalized)) {
      safeSend(c.sender, 'chat:event', {
        type: AGENT_EVENTS.APPROVAL_RESOLVED,
        runId: c.runId,
        approvalId,
        decision: normalized,
      });
      return { ok: true };
    }
  }
  return { ok: false, error: '无待审批项' };
});

// --- Manual terminal panel IPC (one run at a time; independent of chat:stop) ---

ipcMain.handle('terminal:run', async (event, payload = {}) => {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const projectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : '';
  const command = String(payload.command || '').trim();
  const cwdOpt = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined;
  const sender = event.sender;

  if (worktreeMutation) {
    return { ok: false, code: 'BUSY', error: '隔离改动正在应用或清理，请稍后重试' };
  }

  if (!sessionId || !projectPath || !command) {
    return { ok: false, error: '参数无效：需要 sessionId、projectPath、command' };
  }
  if (manualTerm) {
    return { ok: false, error: '已有命令在运行，请先停止或等待结束' };
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, error: '项目路径无效' };
  }

  const settings = loadSettings(userDataPath());
  if (!settings.terminalEnabled) {
    return { ok: false, error: '终端未启用。请在设置中打开「允许终端」。' };
  }

  const abort = new AbortController();
  const signal = abort.signal;
  const termId = makeTermId();

  const gate = createPermissionGate({
    permissionMode: PERMISSION_MODES.has(settings.permissionMode)
      ? settings.permissionMode
      : 'confirm-writes',
    terminalEnabled: Boolean(settings.terminalEnabled),
    terminalRequireConfirm: settings.terminalRequireConfirm !== false,
    onApprovalNeeded: async (approvalPayload) => {
      safeSend(sender, 'chat:event', {
        type: AGENT_EVENTS.APPROVAL_NEEDED,
        runId: activeRun?.runId ?? null,
        source: 'user',
        ...approvalPayload,
      });
    },
  });

  manualTerm = { abort, gate, sessionId, sender, termId };

  const emit = (e) => {
    safeSend(sender, 'chat:event', { runId: null, source: 'user', ...e });
  };

  try {
    const auth = await gate.authorize({
      tool: 'run_terminal',
      risk: 'terminal',
      summary: `手动执行: ${command.slice(0, 120)}`,
      detail: command,
      path: '.',
      sessionKey: sessionId,
      signal,
    });
    if (!auth.allowed) {
      return { ok: false, error: auth.reason || '用户拒绝' };
    }
    if (signal.aborted) {
      return { ok: false, error: '已停止', aborted: true };
    }

    const cwdDisplay = cwdOpt || projectPath;
    emit({
      type: AGENT_EVENTS.TERMINAL_START,
      termId,
      command,
      cwd: cwdDisplay,
      source: 'user',
    });

    let result;
    try {
      result = await runTerminal(projectPath, command, {
        cwd: cwdOpt,
        timeoutMs: settings.terminalTimeoutMs || 60000,
        signal,
        onStdout: (chunk) => emit({
          type: AGENT_EVENTS.TERMINAL_OUTPUT,
          termId,
          stream: 'stdout',
          chunk: String(chunk),
        }),
        onStderr: (chunk) => emit({
          type: AGENT_EVENTS.TERMINAL_OUTPUT,
          termId,
          stream: 'stderr',
          chunk: String(chunk),
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = isAbortError(err, signal);
      emit({
        type: AGENT_EVENTS.TERMINAL_END,
        termId,
        code: -1,
        ok: false,
        timedOut: false,
        aborted,
        summary: msg,
      });
      return { ok: false, error: msg, aborted, termId };
    }

    emit({
      type: AGENT_EVENTS.TERMINAL_END,
      termId,
      code: result.code,
      ok: result.ok,
      timedOut: result.timedOut,
      aborted: result.aborted,
      summary: `exit=${result.code}`,
    });
    return { ok: true, termId, ...result };
  } catch (err) {
    if (isAbortError(err, signal)) {
      return { ok: false, error: '已停止', aborted: true, termId };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), termId };
  } finally {
    if (manualTerm && manualTerm.termId === termId) {
      manualTerm = null;
    }
  }
});

ipcMain.handle('terminal:stop', async (_e, payload = {}) => {
  if (!manualTerm) return { ok: true, stopped: false };
  if (payload?.sessionId && manualTerm.sessionId !== payload.sessionId) {
    return { ok: false, error: '会话不匹配' };
  }
  abortManualTerm();
  return { ok: true, stopped: true };
});

ipcMain.handle('terminal:clear', async () => {
  // Clear is UI-local; main acknowledges for symmetry / future history wipe.
  return { ok: true };
});

ipcMain.handle('atRef:complete', async (_e, payload = {}) => {
  const projectPath = payload.projectPath || payload.project?.path || null;
  const prefix = payload.prefix != null ? String(payload.prefix) : '';
  if (!projectPath) return { items: [] };
  try {
    const items = completeAtPath(projectPath, prefix, {
      limit: payload.limit != null ? Number(payload.limit) : undefined,
    });
    return { items };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('atRef:expand', async (_e, payload = {}) => {
  const projectPath = payload.projectPath || payload.project?.path || null;
  const text = payload.text != null ? String(payload.text) : '';
  try {
    return expandAtRefs(projectPath, text);
  } catch (err) {
    return {
      contextBlock: null,
      refs: [],
      warnings: [err instanceof Error ? err.message : String(err)],
    };
  }
});

/**
 * Shared chat run entry for chat:send and chat:approvePlan.
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {object} payload
 * @param {{ stopPrevious?: boolean }} [opts]
 */
async function startChatRun(event, payload = {}, opts = {}) {
  if (worktreeMutation) return { ok: false, code: 'BUSY', error: '隔离改动正在应用或清理，请稍后重试' };
  const stopPrevious = opts.stopPrevious !== false;
  if (stopPrevious) {
    abortActiveRun();
  }

  const runId = makeRunId();
  const abort = new AbortController();
  const signal = abort.signal;
  const sender = event.sender;
  const agentMode = normalizeAgentMode(payload.agentMode);
  const sessionId = payload.sessionId || '';

  const settings = loadSettings(userDataPath());
  const gate = createPermissionGate({
    permissionMode: PERMISSION_MODES.has(settings.permissionMode)
      ? settings.permissionMode
      : 'confirm-writes',
    terminalEnabled: Boolean(settings.terminalEnabled),
    terminalRequireConfirm: settings.terminalRequireConfirm !== false,
    webEnabled: settings.webEnabled === true,
    webRequireConfirm: settings.webRequireConfirm !== false,
    agentMode,
    onApprovalNeeded: async (approvalPayload) => {
      const approvalEvent = {
        type: AGENT_EVENTS.APPROVAL_NEEDED,
        runId,
        ...approvalPayload,
      };
      // Agent verification_start shares the chat gate for authorization,
      // but its approval belongs to the ephemeral engineering panel. Keep
      // ordinary chat approvals source-less so they remain on chatRun.
      if (approvalPayload.tool === 'verification_start') approvalEvent.source = 'verification';
      else if (approvalPayload.source) approvalEvent.source = approvalPayload.source;
      safeSend(sender, 'chat:event', approvalEvent);
    },
  });

  activeRun = { abort, gate, runId, sender };

  const emit = (e) => {
    if (e && e.type === AGENT_EVENTS.PLAN_READY && sessionId) {
      pendingPlansBySession.set(sessionId, {
        planId: e.planId,
        title: e.title,
        markdown: e.markdown,
        steps: e.steps,
        sessionId,
      });
    }
    if (e && e.type === AGENT_EVENTS.USAGE) {
      persistUsageEvent(settings, sessionId, e);
    }
    safeSend(sender, 'chat:event', { runId, sessionId, ...e });
  };

  try {
    if (signal.aborted) throwAborted();

    emit({ type: AGENT_EVENTS.RUN_START });

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser?.content || '';
    const project = payload.project && payload.project.path
      ? { name: payload.project.name || path.basename(payload.project.path), path: payload.project.path }
      : null;
    const senderBinding = payload.projectBindingId
      ? worktreeIpc.resolveBinding(event, { projectBindingId: String(payload.projectBindingId) })
      : null;
    const engineeringRoot = senderBinding?.projectPath
      && canonicalDirectory(project?.path) === senderBinding.projectPath
      ? senderBinding.projectPath
      : '';
    mcpProjectBySender.set(sender.id, project ? (canonicalDirectory(project.path) || '') : '');
    // A retained MCP session is scoped to the bound project. Drop sessions
    // from older project bindings before a new run can serve roots or
    // sampling requests through them.
    await getMcpSessionManager().invalidateOtherProjects(project?.path || '', 'project-changed');
    const samplingController = createMcpSamplingController({
      settings,
      gate,
      sessionKey: sessionId,
      signal,
      serverConfig: (name) => settings.mcpServers.find((server) => server.name === String(name || '').trim()),
      getServerSummary: (name) => {
        const server = settings.mcpServers.find((item) => item.name === String(name || '').trim());
        if (!server) return '';
        return JSON.stringify({
          name: server.name,
          transport: server.transport,
          capabilities: ['tools', 'resources', 'prompts'],
        }).slice(0, 4096);
      },
      onEvent: emit,
    });
    const taskManager = getMcpTaskManager();
    const elicitation = getMcpElicitationController();
    const taskHandler = (server, method, params, requestSignal) => taskManager.handleTaskRequest(server, method, params, requestSignal);
    const elicitationHandler = (server, params, requestSignal, releaseConnection) => {
      const cfg = settings.mcpServers.find((item) => item.name === String(server || '').trim());
      if (!cfg || cfg.elicitation?.enabled === false) {
        const error = new Error('MCP elicitation disabled');
        error.code = 'MCP_ELICITATION_DISABLED';
        throw error;
      }
      const response = elicitation.create(server, params, sender.id);
      const elicitationId = response?.elicitationId;
      const cancelOnAbort = () => {
        try { if (elicitationId) elicitation.cancel(elicitationId, sender.id); } catch { /* request may already be complete */ }
      };
      requestSignal?.addEventListener?.('abort', cancelOnAbort, { once: true });
      const taskEnabled = cfg.tasks?.enabled === true && params?.task;
      if (taskEnabled) {
        const created = taskManager.receiverResult({
          serverName: server,
          transport: cfg.transport,
          kind: 'elicitation',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          sourceSessionId: sessionId,
          sourceProjectPath: project?.path,
          status: 'input_required',
          execute: () => response,
          cancelExecution: async () => cancelOnAbort(),
          releaseConnection,
        });
        return created.task;
      }
      return response;
    };
    const samplingHandler = (server, params, requestSignal, releaseConnection) => {
      const cfg = settings.mcpServers.find((item) => item.name === String(server || '').trim());
      const taskEnabled = cfg?.tasks?.enabled === true && params?.task;
      const response = samplingController.createMessage(server, params, requestSignal, { detached: taskEnabled });
      if (taskEnabled) {
        const created = taskManager.receiverResult({
          serverName: server,
          transport: cfg.transport,
          kind: 'sampling',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          sourceSessionId: sessionId,
          sourceProjectPath: project?.path,
          execute: () => response,
          releaseConnection,
        });
        return created.task;
      }
      return response;
    };
    const runExtensions = {
      userDataPath: userDataPath(),
      worktreeManager,
      mcpOAuthManager: getMcpOAuthManager(),
      mcpSessionManager: getMcpSessionManager(),
      mcpTaskManager: taskManager,
      mcpTaskHandler: taskHandler,
      mcpElicitation: elicitationHandler,
      mcpElicitationComplete: (server, params) => {
        const id = String(params?.elicitationId || '').trim();
        if (!id) return false;
        try { return elicitation.complete(id); } catch { return false; }
      },
      mcpSampling: (server, params, _ctx, requestSignal, releaseConnection) => samplingHandler(server, params, requestSignal, releaseConnection),
      engineering: {
        indexStatus: (root) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().indexStatus(engineeringRoot)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        indexSearch: (root, query) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().indexSearch(engineeringRoot, query)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationProfiles: (root) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationProfiles(engineeringRoot)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationStart: (root, profileId, ctx) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationStart(engineeringRoot, profileId, {
          ...ctx,
          ownerId: event.sender.id,
        })
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationGet: (root, jobRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationGet(engineeringRoot, jobRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
        verificationResult: (root, jobRef) => engineeringRoot && canonicalDirectory(root) === engineeringRoot
          ? getEngineeringIpc().verificationResult(engineeringRoot, jobRef)
          : { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定已失效' },
      },
    };
    // Expand @refs only on the copy fed to the model (history keeps original).
    const modelMessages = messagesForModel(messages, project?.path || null);

    // Fast path: host list/structure (always real scan) — skip in plan mode for structure-save writes
    if (project?.path && (isListIntent(userText) || isStructureIntent(userText))) {
      emit({
        type: AGENT_EVENTS.TOOL_START,
        tool: 'host:listTree',
        args: { path: project.path },
      });
      let toolEndEmitted = false;
      try {
        const reply = buildTreeReply(project, userText);
        let content = reply.content;
        const applied = [];
        const fileChanges = [];
        const wantSave = isStructureIntent(userText) || /保存|写入|生成\s*\.md|PROJECT_STRUCTURE/i.test(userText);
        if (wantSave && reply.structureMarkdown) {
          const outName = /保存为\s*([^\s]+)/i.test(userText)
            ? userText.match(/保存为\s*([^\s]+)/i)[1].replace(/[\\/]/g, '')
            : 'PROJECT_STRUCTURE.md';
          try {
            // Honor permissionMode / allow_session for host structure-save;
            // pass unified diff like agent writes so confirm-writes can show changes.
            let before = '';
            try {
              const existingFull = path.join(project.path, outName);
              if (fs.existsSync(existingFull) && fs.statSync(existingFull).isFile()) {
                before = fs.readFileSync(existingFull, 'utf8');
              }
            } catch {
              before = '';
            }
            const after = String(reply.structureMarkdown);
            const computed = computeUnifiedDiff(outName, before, after);
            const truncated = truncateDiff(computed.text);
            const diffPayload = {
              path: outName,
              text: truncated.text,
              stats: computed.stats,
              isBinary: computed.isBinary,
              truncated: truncated.truncated,
            };
            const detailForGate = computed.isBinary
              ? '(binary or non-text content)'
              : truncated.text.slice(0, 2000) || String(after).slice(0, 2000);

            const auth = await gate.authorize({
              tool: 'write_file',
              risk: 'write',
              summary: `写入 ${outName}`,
              detail: detailForGate,
              path: outName,
              sessionKey: sessionId,
              signal,
              diff: diffPayload,
              agentMode,
            });
            if (!auth.allowed) {
              const reason = auth.reason || '用户拒绝';
              applied.push({ path: outName, ok: false, error: reason });
              content += `\n\n未写入（${reason}）：\`${outName}\``;
            } else {
              const w = writeFile(project.path, outName, reply.structureMarkdown);
              applied.push({ path: w.path, ok: true, bytes: w.bytes });
              fileChanges.push({
                path: w.path,
                op: before ? 'write' : 'create',
                stats: computed.stats,
              });
              content += `\n\n---\n📁 已写入真实文件：\`${w.path}\`（${w.bytes} bytes）`;
            }
          } catch (e) {
            if (isAbortError(e, signal)) throw e;
            applied.push({ path: outName, ok: false, error: e.message });
            content += `\n\n写入失败：${e.message}`;
          }
        }
        if (signal.aborted) throwAborted();
        emit({
          type: AGENT_EVENTS.TOOL_END,
          tool: 'host:listTree',
          ok: true,
          summary: applied.length ? `listTree + ${applied.length} write(s)` : 'listTree',
        });
        toolEndEmitted = true;
        const result = {
          content,
          applied,
          fileChanges,
          hostTool: 'listTree',
          runId,
          mode: 'host',
          agentMode,
        };
        emit({ type: AGENT_EVENTS.DONE, ...result });
        return result;
      } catch (err) {
        if (!toolEndEmitted) {
          const aborted = isAbortError(err, signal);
          emit({
            type: AGENT_EVENTS.TOOL_END,
            tool: 'host:listTree',
            ok: false,
            summary: aborted ? '已停止' : (err.message || String(err)),
          });
        }
        if (isAbortError(err, signal)) throwAborted();
        throw new Error(`本机扫盘失败: ${err.message || err}`);
      }
    }

    // Multi-turn Agent (API + project + agentEnabled)
    const useAgent = shouldUseAgent({ settings, project });

    if (useAgent) {
      const result = await runAgentLoop({
        project,
        settings,
        messages: modelMessages,
        gate,
        onEvent: emit,
        sessionKey: sessionId,
        signal,
        agentMode,
        registry: project?.path ? undefined : createMemoryOnlyRegistry(),
        extensions: runExtensions,
      });
      const out = {
        content: result.content,
        applied: result.applied,
        fileChanges: result.fileChanges || [],
        agentLog: result.agentLog,
        turns: result.turns,
        mode: 'agent',
        agentMode,
        runId,
      };
      emit({ type: AGENT_EVENTS.DONE, ...out });
      return out;
    }

    // Fallback single-shot
    const systemParts = [
      '你是 Codex 编程助手，回答简洁、可执行，必要时给出命令与代码块。使用简体中文。',
      '涉及目录结构时，必须以系统提供的真实扫描结果为准，禁止编造路径。',
    ];
    if (project) systemParts.push(buildProjectSystemPrompt(project));

    let content;
    if (settings.mode === 'api') {
      if (!settings.apiKey) {
        throw new Error('未配置 API Key，请先在设置中填写，或切换到本地模拟模式');
      }
      const sentMessages = [
        { role: 'system', content: systemParts.join('\n\n') },
        ...modelMessages,
      ];
      const msg = await chatCompletionMessage({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: sentMessages,
        signal,
      });
      content = String(msg?.content || '');
      const usageEvent = buildUsageEvent({ settings, messages: sentMessages, msg });
      if (usageEvent) emit(usageEvent);
      if (!content) throw new Error('API 返回空内容');
    } else {
      content = generateLocalReply(userText, { project });
    }

    if (signal.aborted) throwAborted();

    let applied = [];
    const fileChanges = [];
    let displayContent = content;
    // Single-shot write fences must go through the same PermissionGate
    if (project?.path) {
      const result = await applyWriteFencesWithGate(project.path, content, {
        gate,
        settings,
        sessionKey: sessionId,
        signal,
        onEvent: emit,
        fileChanges,
        agentMode,
      });
      applied = result.applied;
      displayContent = result.displayContent;
      if (applied.length) {
        const ok = applied.filter((a) => a.ok).length;
        const fail = applied.length - ok;
        displayContent += `\n\n---\n📁 文件变更：成功 ${ok}，失败 ${fail}`;
        for (const a of applied) {
          displayContent += a.ok
            ? `\n- ✅ ${a.path} (${a.bytes} bytes)`
            : `\n- ❌ ${a.path}: ${a.error}`;
        }
      }
    }

    emit({ type: AGENT_EVENTS.TEXT_DELTA, text: displayContent });
    const out = {
      content: displayContent,
      applied,
      fileChanges,
      mode: settings.mode,
      agentMode,
      runId,
    };
    emit({ type: AGENT_EVENTS.DONE, ...out });
    return out;
  } catch (err) {
    if (isAbortError(err, signal)) {
      emit({ type: AGENT_EVENTS.ABORTED });
      throwAborted();
    }
    emit({
      type: AGENT_EVENTS.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    if (activeRun && activeRun.runId === runId) {
      activeRun = null;
    }
  }
}

ipcMain.handle('chat:send', async (event, payload = {}) => startChatRun(event, payload));

ipcMain.handle('chat:approvePlan', async (event, payload = {}) => {
  const sessionId = payload.sessionId;
  const planId = payload.planId;
  if (!sessionId || !planId) {
    return { ok: false, error: '缺少 sessionId 或 planId' };
  }
  if (worktreeMutation) {
    return { ok: false, code: 'BUSY', error: '隔离改动正在应用或清理，请稍后重试' };
  }
  const pending = pendingPlansBySession.get(sessionId);
  if (!pending || pending.planId !== planId) {
    return { ok: false, error: '计划不存在或已更新' };
  }
  if (activeRun) {
    return { ok: false, error: '请先停止当前生成再批准执行' };
  }

  const content = buildApproveExecutionMessage({
    title: pending.title,
    markdown: pending.markdown,
  });
  const userMessage = { role: 'user', content };

  safeSend(event.sender, 'chat:event', {
    type: AGENT_EVENTS.PLAN_APPROVED,
    planId,
    sessionId,
  });

  // Clear pending so stale approve cannot re-run the same plan card.
  pendingPlansBySession.delete(sessionId);

  const baseMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = [...baseMessages, userMessage];

  try {
    const result = await startChatRun(event, {
      ...payload,
      agentMode: 'agent',
      messages,
      sessionId,
    }, { stopPrevious: false });
    return {
      ok: true,
      agentMode: 'agent',
      userMessage,
      result,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        aborted: true,
        error: '已停止',
        agentMode: 'agent',
        userMessage,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      agentMode: 'agent',
      userMessage,
    };
  }
});

ipcMain.handle('chat:rejectPlan', async (event, payload = {}) => {
  const sessionId = payload.sessionId;
  const planId = payload.planId;
  if (!sessionId) {
    return { ok: false, error: '缺少 sessionId' };
  }
  const pending = pendingPlansBySession.get(sessionId);
  if (pending && planId && pending.planId !== planId) {
    return { ok: false, error: '计划不存在或已更新' };
  }
  if (pending) {
    pendingPlansBySession.delete(sessionId);
    safeSend(event.sender, 'chat:event', {
      type: AGENT_EVENTS.PLAN_REJECTED,
      planId: pending.planId,
      sessionId,
    });
  }
  return { ok: true };
});

ipcMain.handle('web:fetch', async (_event, payload = {}) => {
  const settings = loadSettings(userDataPath());
  if (settings.webEnabled !== true) {
    return { ok: false, error: '网页访问未启用' };
  }
  try {
    return await fetchUrl(String(payload.url || ''), {
      allowDomains: settings.webAllowDomains,
      denyDomains: settings.webDenyDomains,
      maxBytes: settings.webMaxBytes,
      timeoutMs: settings.webTimeoutMs,
      maxChars: settings.webMaxChars,
    });
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: err?.message || String(err) };
  }
});

ipcMain.handle('usage:summary', async (_event, payload = {}) => {
  const settings = loadSettings(userDataPath());
  if (settings.usageEnabled === false) {
    return { ok: false, error: '用量统计未启用' };
  }
  try {
    const { records, skipped } = readRecords(usageFilePath(userDataPath()));
    const from = Number(payload.from) || 0;
    const to = Number(payload.to) || Infinity;
    const currency = String(settings.usageCurrency || '$');
    const recordsInRange = records.filter((record) => record.ts >= from && record.ts <= to);
    const filtered = recordsInRange
      .map((record) => record.cur === currency ? record : { ...record, cost: null });
    const currencies = [...new Set(recordsInRange.map((record) => record.cur).filter(Boolean))];
    const { totals, groups } = aggregate(filtered, { groupBy: payload.groupBy });
    return {
      ok: true,
      totals,
      groups,
      skipped,
      currency,
      mixedCurrencies: currencies.filter((value) => value !== currency),
    };
  } catch {
    return { ok: false, error: '读取用量记录失败' };
  }
});

ipcMain.handle('usage:clear', async () => {
  const settings = loadSettings(userDataPath());
  if (settings.usageEnabled === false) {
    return { ok: false, error: '用量统计未启用' };
  }
  try {
    clearRecords(usageFilePath(userDataPath()));
    return { ok: true };
  } catch {
    return { ok: false, error: '清空用量记录失败' };
  }
});
