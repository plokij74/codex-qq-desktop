const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSettings, saveSettings } = require('./ai/settings');
const { generateLocalReply } = require('./ai/local-mock');
const { chatCompletion } = require('./ai/openai-compatible');
const { runAgentLoop, applyWriteFencesWithGate } = require('./ai/agent');
const { AGENT_EVENTS } = require('./ai/agent-events');
const { createPermissionGate } = require('./ai/permission');
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

const PERMISSION_MODES = new Set(['read-only', 'confirm-writes', 'full-auto']);

/**
 * Active chat run state.
 * @type {{ abort: AbortController, gate: ReturnType<typeof createPermissionGate>, runId: string, sender: Electron.WebContents } | null}
 */
let activeRun = null;

function userDataPath() {
  return app.getPath('userData');
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
  for (const k of ['agentEnabled', 'terminalEnabled', 'terminalRequireConfirm']) {
    if (k in nextPartial) nextPartial[k] = Boolean(nextPartial[k]);
  }
  if ('maxAgentTurns' in nextPartial) {
    const n = Number(nextPartial.maxAgentTurns);
    if (n === 0) nextPartial.maxAgentTurns = 0;
    else nextPartial.maxAgentTurns = Math.max(1, Math.min(50, Number.isFinite(n) && n > 0 ? n : 8));
  }
  if ('permissionMode' in nextPartial) {
    if (!PERMISSION_MODES.has(nextPartial.permissionMode)) {
      delete nextPartial.permissionMode;
    }
  }
  return toPublicSettings(saveSettings(userDataPath(), nextPartial));
});

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

ipcMain.handle('chat:stop', async () => {
  // Abort run; PermissionGate waitForApproval rejects pending entries on signal abort.
  abortActiveRun();
  return { ok: true };
});

ipcMain.handle('chat:approve', async (_e, payload = {}) => {
  const approvalId = payload?.approvalId;
  const decision = payload?.decision;
  if (!activeRun?.gate || !approvalId) {
    return { ok: false, error: 'no-active-approval' };
  }
  const normalized =
    decision === 'allow' || decision === 'allow_session' ? decision : 'deny';
  const resolved = activeRun.gate.resolveApproval(approvalId, normalized);
  if (!resolved) {
    return { ok: false, error: '无待审批项' };
  }
  safeSend(activeRun.sender, 'chat:event', {
    type: AGENT_EVENTS.APPROVAL_RESOLVED,
    runId: activeRun.runId,
    approvalId,
    decision: normalized,
  });
  return { ok: true };
});

ipcMain.handle('chat:send', async (event, payload = {}) => {
  // Stop any previous run before starting a new one.
  abortActiveRun();

  const runId = makeRunId();
  const abort = new AbortController();
  const signal = abort.signal;
  const sender = event.sender;

  const settings = loadSettings(userDataPath());
  const gate = createPermissionGate({
    permissionMode: PERMISSION_MODES.has(settings.permissionMode)
      ? settings.permissionMode
      : 'confirm-writes',
    terminalEnabled: Boolean(settings.terminalEnabled),
    terminalRequireConfirm: settings.terminalRequireConfirm !== false,
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
    safeSend(sender, 'chat:event', { runId, ...e });
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

    // Fast path: host list/structure (always real scan)
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
        const wantSave = isStructureIntent(userText) || /保存|写入|生成\s*\.md|PROJECT_STRUCTURE/i.test(userText);
        if (wantSave && reply.structureMarkdown) {
          const outName = /保存为\s*([^\s]+)/i.test(userText)
            ? userText.match(/保存为\s*([^\s]+)/i)[1].replace(/[\\/]/g, '')
            : 'PROJECT_STRUCTURE.md';
          try {
            // Honor permissionMode / allow_session for host structure-save
            const auth = await gate.authorize({
              tool: 'write_file',
              risk: 'write',
              summary: `写入 ${outName}`,
              detail: String(reply.structureMarkdown).slice(0, 2000),
              path: outName,
              sessionKey: payload.sessionId,
              signal,
            });
            if (!auth.allowed) {
              const reason = auth.reason || '用户拒绝';
              applied.push({ path: outName, ok: false, error: reason });
              content += `\n\n未写入（${reason}）：\`${outName}\``;
            } else {
              const w = writeFile(project.path, outName, reply.structureMarkdown);
              applied.push({ path: w.path, ok: true, bytes: w.bytes });
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
        const result = { content, applied, hostTool: 'listTree', runId, mode: 'host' };
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
        messages: messages.map((m) => ({ role: m.role, content: String(m.content || '') })),
        gate,
        onEvent: emit,
        sessionKey: payload.sessionId,
        signal,
      });
      const out = {
        content: result.content,
        applied: result.applied,
        agentLog: result.agentLog,
        turns: result.turns,
        mode: 'agent',
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
          ...messages.map((m) => ({ role: m.role, content: String(m.content || '') })),
        ],
        signal,
      });
    } else {
      content = generateLocalReply(userText, { project });
    }

    if (signal.aborted) throwAborted();

    let applied = [];
    let displayContent = content;
    // Single-shot write fences must go through the same PermissionGate
    if (project?.path) {
      const result = await applyWriteFencesWithGate(project.path, content, {
        gate,
        settings,
        sessionKey: payload.sessionId,
        signal,
        onEvent: emit,
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
    const out = { content: displayContent, applied, mode: settings.mode, runId };
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
});
