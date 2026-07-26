const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSettings, saveSettings, clampInt, clampMemorySettings } = require('./ai/settings');
const { generateLocalReply } = require('./ai/local-mock');
const { chatCompletion } = require('./ai/openai-compatible');
const { runAgentLoop, applyWriteFencesWithGate } = require('./ai/agent');
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
} = require('./ai/agent-mode');
const { discoverSkills, loadSkillBody } = require('./ai/skills-loader');
const { loadHooks } = require('./ai/hooks-loader');
const { sanitizeMcpServers } = require('./ai/mcp-config');
const {
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  generateCompactSummary,
} = require('./ai/session-compact');
const {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
} = require('./ai/session-export');
const { memoryList, memoryAdd, memoryDelete } = require('./ai/memory-ipc');

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

function userDataPath() {
  return app.getPath('userData');
}

function bundledSkillsDir() {
  return path.join(__dirname, 'skills');
}

function toPublicSettings(s) {
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
    mcpServers: sanitizeMcpServers(s.mcpServers),
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', async () => toPublicSettings(loadSettings(userDataPath())));

ipcMain.handle('settings:save', async (_e, partial = {}) => {
  const nextPartial = { ...partial };
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
  if ('mcpServers' in nextPartial) {
    nextPartial.mcpServers = sanitizeMcpServers(nextPartial.mcpServers);
  }
  return toPublicSettings(saveSettings(userDataPath(), nextPartial));
});

ipcMain.handle('mcp:testServer', async (_e, rawCfg) => {
  const list = sanitizeMcpServers([rawCfg]);
  if (!list.length) return { ok: false, error: '无效配置' };
  const cfg = list[0];
  const { createMcpClient } = require('./ai/mcp-client');
  const client = createMcpClient({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs || 15000, 15000) });
  try {
    await client.start();
    const tools = await client.listTools();
    let resourcesCount = 0;
    try {
      const res = await client.listResources();
      resourcesCount = Array.isArray(res) ? res.length : 0;
    } catch { /* ignore */ }
    await client.close();
    return { ok: true, toolsCount: tools.length, resourcesCount, transport: cfg.transport };
  } catch (err) {
    try { await client.close(); } catch { /* */ }
    return { ok: false, error: err.message || String(err), transport: cfg.transport };
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
      return { ok: true, needed: false, approxTokens: plan.approxTokens };
    }
    const transcript = serializeOlderTranscript(plan.older);
    const summary = await generateCompactSummary({ transcript, settings });
    return {
      ok: true,
      needed: true,
      messages: applyCompact(messages, plan, summary),
      compactedCount: plan.older.length,
      approxTokens: plan.approxTokens,
      olderApproxTokens: plan.olderApproxTokens,
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

ipcMain.handle('chat:approve', async (_e, payload = {}) => {
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
  ].filter(Boolean);

  if (!candidates.length) {
    return { ok: false, error: 'no-active-approval' };
  }

  for (const c of candidates) {
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
    agentMode,
    onApprovalNeeded: async (approvalPayload) => {
      safeSend(sender, 'chat:event', {
        type: AGENT_EVENTS.APPROVAL_NEEDED,
        runId,
        ...approvalPayload,
      });
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
    const useAgent = settings.mode === 'api'
      && settings.agentEnabled !== false
      && project?.path
      && settings.apiKey;

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
        extensions: {
          userDataPath: userDataPath(),
        },
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
      content = await chatCompletion({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [
          { role: 'system', content: systemParts.join('\n\n') },
          ...modelMessages,
        ],
        signal,
      });
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
