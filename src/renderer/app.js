/* Codex QQ Desktop */
const STORAGE_KEY = 'codex-qq-state-v2';
const TERM_COLLAPSED_KEY = 'codex-qq-term-collapsed';
const SEED_KV = [
  '结构确认没问题：','',
  '- `redeem_codes`、`push_tokens` 与 migration 一致。',
  '- `android_subscriptions` 多了 `free_trial` 字段，这是后续的增量字段，不影响 baseline。',
  '- `d1_migrations` 已存在，但缺少历史记录。','',
  '现在补记录：','',
  '```bash',
  './node_modules/.bin/wrangler d1 execute haiker --remote --command \\',
  '"INSERT OR IGNORE INTO d1_migrations (name) VALUES (\'0001_initial.sql\'), (\'0002_push_notifications.sql\');"',
  '```','','然后：','','```bash',
  './node_modules/.bin/wrangler d1 migrations list haiker --remote','```','',
  '确认只显示 `0003_push_delivery_dedup.sql` 后，再运行：','','```bash',
  './node_modules/.bin/wrangler d1 migrations apply haiker --remote','```','',
  '这不会影响现有业务数据。',
].join('\n');
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','🤔','😎','😢','😡','👍','👎','👏','🙏','🔥','✨','🎉','💯','🚀','🐛','✅','❌','⚠️','💡','📝','🧠','☕','🐧'];
const PLUGINS = [
  { id: 'p1', name: 'Code Review', desc: 'PR 自动审查', enabled: true },
  { id: 'p2', name: 'Doc Search', desc: '文档语义检索', enabled: true },
  { id: 'p3', name: 'KV Insight', desc: '读写成本分析', enabled: false },
  { id: 'p4', name: 'Migrate Guard', desc: '迁移安全检查', enabled: true },
];
const SITES = [
  { id: 's1', name: 'haiker-prod', url: 'https://haiker.example.com', status: 'healthy' },
  { id: 's2', name: 'haiker-staging', url: 'https://staging.haiker.example.com', status: 'degraded' },
  { id: 's3', name: 'docs', url: 'https://docs.example.com', status: 'healthy' },
];
const SCHEDULED = [
  { id: 't1', title: '每晚 02:00 备份 D1', when: '每天 02:00', status: 'active' },
  { id: 't2', title: '周一汇总 KV 成本报告', when: '每周一 09:00', status: 'active' },
  { id: 't3', title: '清理过期 free_trial 标记', when: '已暂停', status: 'paused' },
];
const FRIENDS = [
  { id: 'codex', name: 'Codex 小蓝', avatar: '🤖', status: '在线', kind: 'bot' },
  { id: 'randy', name: 'Randy Lu', avatar: '🧑', status: '在线', kind: 'user' },
  { id: 'maya', name: 'Maya', avatar: '👧', status: '离开', kind: 'user' },
];
let sessions = [];
let projects = [];
const worktreeBindings = new Map();
const worktreePreviews = new Map();
const worktreeActionBusy = new Set();
const worktreeReconcileSeq = new Map();
const worktreePrEditors = new Set();
const workflowGateRunsByProject = new Map();
const workflowGateSelections = new Map();
const workflowGateLoadSeq = new Map();
const pullRequestView = {
  projectId: '', filter: 'open', repo: null, prs: [], truncated: false,
  selectedNumber: 0, resultId: '', detail: null, loading: false, busy: false,
  error: '', seq: 0, detailSeq: 0,
};
let activeSessionId = '';
let currentView = 'chat';
let sending = false;
let currencySymbol = '$';
let usageDisplayEnabled = true;
let appDialogState = null;
/** Seeds agentMode for newly created sessions (from settings.defaultAgentMode). */
let defaultAgentModeSeed = 'agent';

/** Active agent/stream run for the current send (event-driven UI). */
let chatRun = null;

// MCP task and elicitation state is deliberately ephemeral.  It is hydrated
// from main on demand and is never included in saveState/session export.
const mcpTaskState = new Map();
let mcpElicitationModal = null;

/** Manual / agent terminal panel state (shared output; multi-termId aware). */
let termState = {
  /** @type {Map<string, { source: string, command: string }>} */
  runs: new Map(),
  stickBottom: true,
  pendingApproval: null,
};
// Verification approvals arrive on the chat IPC channel for compatibility,
// but remain separate from chatRun so they can never become chat history.
let engineeringPendingApproval = null;
let engineeringWorkflowEditor = null;

function anyTermRunning() {
  return termState.runs.size > 0;
}

function hasManualTermRunning() {
  for (const r of termState.runs.values()) {
    if (r.source === 'user') return true;
  }
  return false;
}

function manualTermId() {
  for (const [id, r] of termState.runs.entries()) {
    if (r.source === 'user') return id;
  }
  return null;
}

function setSending(on) {
  sending = !!on;
  const btn = document.getElementById('btn-send');
  const stop = document.getElementById('btn-stop');
  if (btn) btn.disabled = sending;
  if (stop) stop.classList.toggle('hidden', !sending);
  updateAgentModeToggle();
}

function normalizeSessionAgentMode(value) {
  return value === 'plan' ? 'plan' : 'agent';
}

function sessionAgentMode(session = activeSession()) {
  return normalizeSessionAgentMode(session?.agentMode);
}

function updateAgentModeToggle() {
  const wrap = document.getElementById('agent-mode-toggle');
  if (!wrap) return;
  const mode = sessionAgentMode();
  wrap.querySelectorAll('.mode-btn').forEach((btn) => {
    const m = btn.getAttribute('data-mode');
    btn.classList.toggle('is-active', m === mode);
    btn.disabled = !!sending;
  });
}

function setSessionAgentMode(mode) {
  if (sending) {
    toast('生成中无法切换模式，请先停止');
    return;
  }
  const s = activeSession();
  if (!s) return;
  s.agentMode = normalizeSessionAgentMode(mode);
  saveState();
  updateAgentModeToggle();
}

function isTermCollapsed() {
  try {
    return localStorage.getItem(TERM_COLLAPSED_KEY) !== '0';
  } catch {
    return true;
  }
}

function setTermCollapsed(collapsed) {
  try {
    localStorage.setItem(TERM_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch { /* ignore */ }
  const panel = document.getElementById('terminal-panel');
  if (panel) panel.classList.toggle('collapsed', !!collapsed);
}

function updateTermRunningUi() {
  const anyRunning = anyTermRunning();
  const manualRunning = hasManualTermRunning();
  const stopBtn = document.getElementById('btn-term-stop');
  const runBtn = document.getElementById('btn-term-run');
  const input = document.getElementById('terminal-input');
  const toggle = document.getElementById('btn-term-toggle');
  const status = document.getElementById('term-status');
  // Stop is only for manual (source=user) runs; agent runs use chat 停止.
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !manualRunning);
    stopBtn.textContent = '停止命令';
    stopBtn.disabled = !manualRunning;
  }
  // Allow typing/starting another command only when no manual run is active.
  if (runBtn) runBtn.disabled = manualRunning;
  if (input) input.disabled = manualRunning;
  if (toggle) toggle.classList.toggle('is-running', anyRunning);
  if (status) {
    status.classList.toggle('is-running', anyRunning);
    if (!anyRunning && !termState.pendingApproval) {
      /* leave last status text unless cleared elsewhere */
    } else if (anyRunning) {
      const parts = [];
      for (const r of termState.runs.values()) {
        const src = r.source === 'agent' ? 'Agent' : '手动';
        parts.push(`${src}: ${String(r.command || '').slice(0, 40)}`);
      }
      status.textContent = '运行中：' + parts.join(' | ');
      status.classList.remove('is-error');
    }
  }
}

function clearTermApprovalUi() {
  termState.pendingApproval = null;
  const box = document.getElementById('term-approval');
  if (box) {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function renderTermApprovalCard(ev) {
  const box = document.getElementById('term-approval');
  if (!box) return;
  termState.pendingApproval = ev;
  box.classList.remove('hidden');
  // Expand panel so user sees approval
  setTermCollapsed(false);
  const title = '需要确认：' + (ev.tool || 'run_terminal') + (ev.risk ? '（' + ev.risk + '）' : '');
  box.innerHTML =
    '<div class="appr-title">' + escapeHtml(title) + '</div>' +
    '<div class="appr-summary">' + escapeHtml(ev.summary || ev.detail || '') + '</div>' +
    '<div class="appr-actions">' +
      '<button type="button" class="appr-btn" data-decision="allow">允许</button>' +
      '<button type="button" class="appr-btn appr-deny" data-decision="deny">拒绝</button>' +
      '<button type="button" class="appr-btn appr-session" data-decision="allow_session">本会话始终允许此类</button>' +
    '</div>';
  box.querySelectorAll('.appr-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!termState.pendingApproval) return;
      box.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = true; });
      try {
        const res = await window.codex.approveChat({
          approvalId: ev.approvalId,
          decision: btn.dataset.decision,
        });
        if (!res?.ok) {
          box.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = false; });
          toast(res?.error || '审批失败');
          return;
        }
        // Resolved event also clears; optimistic clear for snappy UI
        clearTermApprovalUi();
      } catch (e) {
        box.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = false; });
        toast(e?.message || String(e));
      }
    });
  });
  const status = document.getElementById('term-status');
  if (status) {
    status.textContent = '等待确认终端命令…';
    status.classList.remove('is-error');
  }
}

function clearEngineeringApprovalUi() {
  engineeringPendingApproval = null;
  const box = document.getElementById('engineering-approval');
  if (box) {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function renderEngineeringApprovalCard(ev) {
  engineeringPendingApproval = ev;
  const box = document.getElementById('engineering-approval');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="appr-title">需要确认：后台验证（terminal）</div>'
    + '<div class="appr-summary">' + escapeHtml(ev.summary || ev.detail || '运行已保存的验证档案') + '</div>'
    + '<div class="appr-actions">'
    + '<button type="button" class="appr-btn" data-engineering-decision="allow">允许</button>'
    + '<button type="button" class="appr-btn appr-deny" data-engineering-decision="deny">拒绝</button>'
    + '<button type="button" class="appr-btn appr-session" data-engineering-decision="allow_session">本档案始终允许</button>'
    + '</div>';
  box.querySelectorAll('[data-engineering-decision]').forEach((button) => button.addEventListener('click', async () => {
    if (!engineeringPendingApproval || String(engineeringPendingApproval.approvalId) !== String(ev.approvalId)) return;
    box.querySelectorAll('[data-engineering-decision]').forEach((item) => { item.disabled = true; });
    try {
      const result = await window.codex.approveChat({ approvalId: ev.approvalId, decision: button.dataset.engineeringDecision });
      if (!result?.ok) {
        box.querySelectorAll('[data-engineering-decision]').forEach((item) => { item.disabled = false; });
        toast(result?.error || '审批失败');
        return;
      }
      clearEngineeringApprovalUi();
    } catch (error) {
      box.querySelectorAll('[data-engineering-decision]').forEach((item) => { item.disabled = false; });
      toast(error?.message || String(error));
    }
  }));
}

function appendTermLine(text, className) {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  const line = document.createElement('div');
  line.className = 'term-line' + (className ? ' ' + className : '');
  line.textContent = text;
  out.appendChild(line);
  // Soft cap ~200k chars of textContent
  while (out.textContent.length > 200000 && out.firstChild) {
    out.removeChild(out.firstChild);
  }
  if (termState.stickBottom) {
    out.scrollTop = out.scrollHeight;
  }
}

function appendTermChunk(stream, chunk) {
  const out = document.getElementById('terminal-output');
  if (!out || chunk == null) return;
  const cls = stream === 'stderr' ? 'term-stderr' : 'term-stdout';
  // Prefer append to last matching span-less line for fewer nodes; simple: new text node block
  let last = out.lastElementChild;
  if (last && last.classList.contains(cls) && last.dataset.open === '1') {
    last.textContent += String(chunk);
  } else {
    last = document.createElement('div');
    last.className = 'term-line ' + cls;
    last.dataset.open = '1';
    last.textContent = String(chunk);
    out.appendChild(last);
  }
  while (out.textContent.length > 200000 && out.firstChild) {
    out.removeChild(out.firstChild);
  }
  if (termState.stickBottom) {
    out.scrollTop = out.scrollHeight;
  }
}

function closeOpenTermChunks() {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  out.querySelectorAll('.term-line[data-open="1"]').forEach((el) => {
    delete el.dataset.open;
  });
}

function handleTerminalPanelEvent(ev) {
  if (!ev || !ev.type) return false;
  const type = ev.type;
  if (type === 'terminal-start') {
    const termId = ev.termId || `anon_${Date.now()}`;
    const source = ev.source === 'agent' ? 'agent' : 'user';
    termState.runs.set(termId, { source, command: String(ev.command || '') });
    termState.stickBottom = true;
    clearTermApprovalUi();
    updateTermRunningUi();
    setTermCollapsed(false);
    const src = source === 'agent' ? 'Agent' : '手动';
    appendTermLine(`$ ${ev.command || ''}`, 'term-meta');
    if (ev.cwd) appendTermLine(`cwd: ${ev.cwd}  [${src}] termId=${termId}`, 'term-meta');
    return true;
  }
  if (type === 'terminal-output') {
    // Multi-term: prefix stream when concurrent runs exist; never drop other termIds.
    const multi = termState.runs.size > 1;
    const prefix = multi && ev.termId ? `[${String(ev.termId).slice(-6)}] ` : '';
    const chunk = prefix ? prefix + String(ev.chunk || '') : ev.chunk;
    appendTermChunk(ev.stream || 'stdout', chunk);
    return true;
  }
  if (type === 'terminal-end') {
    const termId = ev.termId || null;
    if (termId) termState.runs.delete(termId);
    else {
      // Legacy/no-id: clear all user runs as best effort
      for (const [id, r] of [...termState.runs.entries()]) {
        if (r.source === 'user') termState.runs.delete(id);
      }
    }
    closeOpenTermChunks();
    const fail = ev.ok === false || ev.aborted || ev.timedOut;
    let summary = ev.summary || `exit=${ev.code}`;
    if (ev.aborted) summary = '已停止';
    else if (ev.timedOut) summary = '超时 ' + summary;
    if (termId) summary = `[${String(termId).slice(-6)}] ${summary}`;
    appendTermLine(summary, 'term-end' + (fail ? ' is-fail' : ''));
    updateTermRunningUi();
    const status = document.getElementById('term-status');
    if (status && !anyTermRunning()) {
      status.textContent = summary;
      status.classList.toggle('is-error', fail);
      status.classList.remove('is-running');
    }
    return true;
  }
  // Verification approvals use a dedicated ephemeral panel. They must never
  // fall through to renderApprovalCard, which would attach them to chatRun.
  if (type === 'approval-needed' && ev.source === 'verification') {
    renderEngineeringApprovalCard(ev);
    return true;
  }
  if (type === 'approval-resolved' && engineeringPendingApproval
    && String(engineeringPendingApproval.approvalId) === String(ev.approvalId)) {
    clearEngineeringApprovalUi();
    return true;
  }
  // Manual-terminal approval when no chatRun (or source user)
  if (type === 'approval-needed' && (ev.source === 'user' || !chatRun || chatRun.finalized)) {
    // If chatRun is active and this is agent approval, let chat handler take it
    if (chatRun && !chatRun.finalized && ev.source !== 'user') return false;
    renderTermApprovalCard(ev);
    return true;
  }
  if (type === 'approval-resolved' && termState.pendingApproval
    && String(termState.pendingApproval.approvalId) === String(ev.approvalId)) {
    clearTermApprovalUi();
    return true;
  }
  return false;
}

async function runManualTerminal() {
  if (hasManualTermRunning()) {
    toast('已有手动命令在运行');
    return;
  }
  const input = document.getElementById('terminal-input');
  const command = (input?.value || '').trim();
  if (!command) return;

  const session = activeSession();
  const proj = sessionProject(session);
  if (!session || !proj?.path) {
    toast('请先打开已绑定目录的项目会话');
    return;
  }

  let settings;
  try {
    settings = await window.codex.getSettings();
  } catch (e) {
    toast(e?.message || String(e));
    return;
  }
  if (!settings.terminalEnabled) {
    toast('请先在设置中开启「允许终端命令」');
    return;
  }

  if (!window.codex?.runTerminal) {
    toast('终端 API 不可用');
    return;
  }

  setTermCollapsed(false);
  // Optimistic placeholder until terminal-start (deny path has no start).
  const pendingId = `pending_user_${Date.now().toString(36)}`;
  termState.runs.set(pendingId, { source: 'user', command });
  updateTermRunningUi();

  try {
    const res = await window.codex.runTerminal({
      sessionId: session.id,
      projectPath: proj.path,
      command,
    });
    // Drop optimistic pending once real start arrived (or on failure without start).
    termState.runs.delete(pendingId);
    if (res && res.ok === false && !res.aborted) {
      // Events may already have painted end; ensure UI not stuck if no START was emitted (deny)
      if (!hasManualTermRunning()) {
        updateTermRunningUi();
        appendTermLine(res.error || '执行失败', 'term-end is-fail');
        const status = document.getElementById('term-status');
        if (status) {
          status.textContent = res.error || '执行失败';
          status.classList.add('is-error');
        }
        toast(res.error || '执行失败');
      }
    } else if (input) {
      input.value = '';
    }
    updateTermRunningUi();
  } catch (e) {
    termState.runs.delete(pendingId);
    // Clear stuck manual runs without term end
    for (const [id, r] of [...termState.runs.entries()]) {
      if (r.source === 'user' && String(id).startsWith('pending_')) termState.runs.delete(id);
    }
    updateTermRunningUi();
    const msg = (e?.message || String(e)).replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
    appendTermLine(msg, 'term-end is-fail');
    toast(msg);
  } finally {
    termState.runs.delete(pendingId);
    updateTermRunningUi();
  }
}

async function stopManualTerminal() {
  try {
    if (window.codex?.stopTerminal) {
      await window.codex.stopTerminal({ sessionId: activeSession()?.id });
    }
  } catch (e) {
    toast(e?.message || String(e));
  }
}

function clearTerminalOutput() {
  const out = document.getElementById('terminal-output');
  if (out) out.innerHTML = '';
  if (window.codex?.clearTerminal) {
    window.codex.clearTerminal().catch(() => {});
  }
}

function bindTerminalPanel() {
  const panel = document.getElementById('terminal-panel');
  if (!panel) return;
  setTermCollapsed(isTermCollapsed());

  document.getElementById('btn-term-toggle')?.addEventListener('click', () => {
    const collapsed = panel.classList.contains('collapsed');
    setTermCollapsed(!collapsed);
  });
  document.getElementById('btn-term-clear')?.addEventListener('click', () => {
    clearTerminalOutput();
  });
  document.getElementById('btn-term-stop')?.addEventListener('click', () => {
    stopManualTerminal();
  });
  document.getElementById('btn-term-run')?.addEventListener('click', () => {
    runManualTerminal().catch((e) => toast(e?.message || String(e)));
  });
  document.getElementById('terminal-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runManualTerminal().catch((err) => toast(err?.message || String(err)));
    }
  });
  const out = document.getElementById('terminal-output');
  if (out) {
    out.addEventListener('scroll', () => {
      const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      termState.stickBottom = nearBottom;
    });
  }
  updateTermRunningUi();
}

/** Local cancel token for friend mock / short delays */
let localSendToken = null;

function disableApprovalCards(root) {
  const scope = root || document;
  scope.querySelectorAll('.approval-card:not(.resolved)').forEach((card) => {
    card.classList.add('resolved');
    card.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = true; });
    const res = card.querySelector('.appr-result');
    if (res && !res.textContent) res.textContent = '已取消';
  });
}

async function stopGenerating() {
  if (localSendToken) localSendToken.aborted = true;
  if (chatRun?.el) disableApprovalCards(chatRun.el);
  try {
    if (window.codex?.stopChat) await window.codex.stopChat();
    if (sending) toast('正在停止…');
  } catch (e) {
    toast(e?.message || String(e));
  }
}

function bindInlineStop() {
  const inlineStop = document.getElementById('inline-stop');
  if (!inlineStop || inlineStop.dataset.bound === '1') return;
  inlineStop.dataset.bound = '1';
  inlineStop.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopGenerating();
  });
}
let searchQuery = '';
let pendingAttaches = [];
let pluginState = Object.fromEntries(PLUGINS.map((p) => [p.id, p.enabled]));
let ctxMenuEl = null;
let memoryCandidateSessionId = null;
let memoryCandidateSelected = new Set();
let memoryCandidateErrors = new Map();
let memoryCandidateInvalidIds = new Set();
let memoryCandidateBusy = false;
let memoryCandidateMemoryEnabled = true;
let memoryCandidateNotice = '';

function ensureSessionCandidateState(session) {
  if (!session || !window.MemoryCandidateState) return [];
  session.pendingMemoryCandidates = window.MemoryCandidateState.normalizePendingCandidates(
    session.pendingMemoryCandidates,
    { max: window.MemoryCandidateState.PENDING_MAX, allowDrafts: true }
  );
  return session.pendingMemoryCandidates;
}

function ensureSessionWorktreeState(session) {
  if (!session || !window.WorktreeResultState) return [];
  session.pendingWorktreeResults = window.WorktreeResultState.normalizeList(session.pendingWorktreeResults);
  return session.pendingWorktreeResults;
}

function projectWorktreeSession(projectId, sessionId = '') {
  if (sessionId) {
    const exact = sessions.find((item) => item.id === sessionId && item.projectId === projectId);
    if (exact) return exact;
  }
  return sessions.find((item) => item.kind === 'project' && item.projectId === projectId)
    || sessions.find((item) => item.projectId === projectId)
    || null;
}

function attachWorktreeResult(result, projectId, sessionId = '') {
  if (!result || !window.WorktreeResultState) return;
  const session = projectWorktreeSession(projectId, sessionId);
  if (!session) return;
  const next = { ...result, projectId, sessionId: result.sessionId || session.id };
  session.pendingWorktreeResults = window.WorktreeResultState.upsert(
    ensureSessionWorktreeState(session), next
  );
  session.updatedAt = Date.now();
  saveState();
}

function replaceProjectWorktreeResults(projectId, rawResults) {
  if (!window.WorktreeResultState) return;
  const results = window.WorktreeResultState.normalizeList(
    (Array.isArray(rawResults) ? rawResults : []).map((result) => ({ ...result, projectId }))
  );
  for (const session of sessions) {
    if (session.projectId !== projectId) continue;
    session.pendingWorktreeResults = window.WorktreeResultState.replaceAuthoritative(
      ensureSessionWorktreeState(session), [], projectId
    );
  }
  for (const result of results) {
    const session = projectWorktreeSession(projectId, result.sessionId);
    if (!session) continue;
    session.pendingWorktreeResults = window.WorktreeResultState.upsert(
      ensureSessionWorktreeState(session),
      { ...result, projectId, sessionId: result.sessionId || session.id }
    );
    session.updatedAt = Date.now();
  }
  saveState();
}

async function bindWorktreeProject(project, force = false) {
  if (force) worktreeBindings.delete(project.id);
  let token = worktreeBindings.get(project.id);
  if (token) return token;
  const bound = await window.codex.bindWorktreeProject({ projectId: project.id, projectPath: project.path });
  if (!bound?.ok || !bound.projectBindingId) return '';
  token = bound.projectBindingId;
  worktreeBindings.set(project.id, token);
  return token;
}

function workflowGateSelectionKey(project, action, scope) {
  return `${String(project?.id || '')}:${String(action || '')}:${String(scope || '')}`;
}

function workflowGateRuns(project) {
  return workflowGateRunsByProject.get(String(project?.id || '')) || [];
}

function setWorkflowGateRuns(project, rawRuns) {
  const projectId = String(project?.id || '');
  if (!projectId) return [];
  const runs = (Array.isArray(rawRuns) ? rawRuns : [])
    .filter((run) => run?.status === 'passed' && run.workflowRunRef && run.endWorkspaceFingerprint)
    .slice(0, 50);
  workflowGateRunsByProject.set(projectId, runs);
  const valid = new Set(runs.map((run) => run.workflowRunRef));
  for (const [key, ref] of workflowGateSelections) {
    if (key.startsWith(`${projectId}:`) && !valid.has(ref)) workflowGateSelections.delete(key);
  }
  return runs;
}

async function loadWorkflowGateRuns(project, token = '') {
  if (!project?.id || !window.codex?.listEngineeringWorkflowRuns) return [];
  const binding = token || worktreeBindings.get(project.id) || '';
  if (!binding) return [];
  const sequence = (workflowGateLoadSeq.get(project.id) || 0) + 1;
  workflowGateLoadSeq.set(project.id, sequence);
  const response = await window.codex.listEngineeringWorkflowRuns({ projectBindingId: binding, limit: 50 }).catch(() => null);
  if (workflowGateLoadSeq.get(project.id) !== sequence || !response?.ok) return workflowGateRuns(project);
  return setWorkflowGateRuns(project, response.runs);
}

function workflowGatePayload(project, action, scope) {
  const selected = workflowGateSelections.get(workflowGateSelectionKey(project, action, scope));
  const run = workflowGateRuns(project).find((item) => item.workflowRunRef === selected);
  return run ? {
    workflowRunRef: run.workflowRunRef,
    expectedFingerprint: run.endWorkspaceFingerprint,
  } : {};
}

function workflowGateRunLabel(run) {
  const time = run.completedAt || run.finishedAt || '';
  return `${run.workflowName || run.workflowId || '工作流'} · ${run.passedCount || 0}/${run.nodeCount || 0}${time ? ` · ${time}` : ''}`;
}

function appendWorkflowGateSelector(container, project, action, scope, disabled = false) {
  if (!container || !project?.id) return;
  const runs = workflowGateRuns(project);
  const key = workflowGateSelectionKey(project, action, scope);
  const current = workflowGateSelections.get(key) || '';
  const wrap = document.createElement('div');
  wrap.className = 'workflow-gate-control';
  const label = document.createElement('label');
  label.textContent = '本地门禁';
  const select = document.createElement('select');
  select.disabled = disabled;
  select.setAttribute('aria-label', '选择已通过的工作流运行');
  const optional = document.createElement('option');
  optional.value = '';
  optional.textContent = '不使用工作流门禁';
  select.appendChild(optional);
  for (const run of runs) {
    const option = document.createElement('option');
    option.value = run.workflowRunRef;
    option.textContent = workflowGateRunLabel(run);
    option.selected = run.workflowRunRef === current;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    if (select.value) workflowGateSelections.set(key, select.value);
    else workflowGateSelections.delete(key);
  });
  label.appendChild(select);
  wrap.appendChild(label);
  if (!runs.length) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost-btn';
    open.textContent = '前往工程中心';
    open.disabled = disabled;
    open.addEventListener('click', () => setView('scheduled'));
    wrap.appendChild(open);
  }
  container.appendChild(wrap);
}

function workflowGateSelectHtml(project, action, scope, disabled = false) {
  const runs = workflowGateRuns(project);
  const key = workflowGateSelectionKey(project, action, scope);
  const current = workflowGateSelections.get(key) || '';
  const options = [`<option value="">不使用工作流门禁</option>`, ...runs.map((run) => `<option value="${escapeHtml(run.workflowRunRef)}"${run.workflowRunRef === current ? ' selected' : ''}>${escapeHtml(workflowGateRunLabel(run))}</option>`)].join('');
  return `<div class="workflow-gate-control"><label>本地门禁<select data-workflow-gate-select="${escapeHtml(key)}" aria-label="选择已通过的工作流运行" ${disabled ? 'disabled' : ''}>${options}</select></label>${runs.length ? '' : `<button type="button" class="ghost-btn" data-workflow-gate-open ${disabled ? 'disabled' : ''}>前往工程中心</button>`}</div>`;
}

async function reconcileWorktreeResults(project) {
  if (!project?.id || !project.path || !window.codex?.bindWorktreeProject) return;
  const sequence = (worktreeReconcileSeq.get(project.id) || 0) + 1;
  worktreeReconcileSeq.set(project.id, sequence);
  try {
    let token = await bindWorktreeProject(project);
    if (!token) return;
    let listed = await window.codex.listWorktreeResults({ projectBindingId: token });
    if (!listed?.ok && listed?.code === 'RESULT_NOT_FOUND') {
      token = await bindWorktreeProject(project, true);
      if (!token) return;
      listed = await window.codex.listWorktreeResults({ projectBindingId: token });
    }
    if (!listed?.ok) return;
    if (worktreeReconcileSeq.get(project.id) !== sequence) return;
    replaceProjectWorktreeResults(project.id, listed.results);
    await loadWorkflowGateRuns(project, token);
    if (activeSession()?.projectId === project.id) renderMessages();
  } catch {
    // Recovery is best effort; the next project open/event retries reconciliation.
  }
}

function worktreeRefsForSession(session) {
  return window.WorktreeResultState
    ? ensureSessionWorktreeState(session)
    : [];
}

function uid(prefix = 's') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function defaultProjects() {
  return [
    { id: 'proj_hn', name: 'hn', path: '', pinned: true, createdAt: Date.now() - 5000 },
    { id: 'proj_hma', name: 'hma', path: '', pinned: true, createdAt: Date.now() - 4000 },
    { id: 'proj_lingmo', name: 'lingmo', path: '', pinned: true, createdAt: Date.now() - 3000 },
    { id: 'proj_showdex', name: 'showdex', path: '', pinned: false, createdAt: Date.now() - 2000 },
    { id: 'proj_epub', name: 'epubkit-electron', path: '', pinned: false, createdAt: Date.now() - 1000 },
  ];
}
function defaultSessions() {
  return [
    { id: 'task_kv', title: '优化 KV 读写成本', kind: 'task', peer: 'codex', projectId: null, pinned: true, agentMode: 'agent', messages: [{ role: 'assistant', content: SEED_KV }], updatedAt: Date.now() },
    { id: 'task_wechat', title: '微信发送 hello world', kind: 'task', peer: 'codex', projectId: null, pinned: false, agentMode: 'agent', messages: [{ role: 'assistant', content: '这个任务可以拆成：\n\n1. 确认接口\n2. 写最小发送脚本\n3. 配 token\n\n把代码或报错贴过来。' }], updatedAt: Date.now() - 1000 },
    { id: 'chat_randy', title: 'Randy Lu', kind: 'friend', peer: 'randy', projectId: null, pinned: false, agentMode: 'agent', messages: [{ role: 'assistant', content: '（模拟好友）在的，有事直接说。' }], updatedAt: Date.now() - 2000 },
  ];
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('codex-qq-sessions-v1');
    if (!raw) {
      sessions = defaultSessions();
      sessions.forEach(ensureSessionCandidateState);
      sessions.forEach(ensureSessionWorktreeState);
      projects = defaultProjects();
      activeSessionId = sessions[0].id;
      return;
    }
    const data = JSON.parse(raw);
    sessions = Array.isArray(data.sessions) && data.sessions.length
      ? data.sessions.map((s) => {
        const mode = normalizeSessionAgentMode(s.agentMode);
        const session = { pinned: false, projectId: null, ...s, agentMode: mode };
        ensureSessionCandidateState(session);
        ensureSessionWorktreeState(session);
        return session;
      })
      : defaultSessions();
    sessions.forEach(ensureSessionCandidateState);
    sessions.forEach(ensureSessionWorktreeState);
    projects = Array.isArray(data.projects) && data.projects.length ? data.projects : defaultProjects();
    activeSessionId = data.activeSessionId && sessions.some((s) => s.id === data.activeSessionId) ? data.activeSessionId : sessions[0].id;
    if (data.pluginState) pluginState = { ...pluginState, ...data.pluginState };
  } catch {
    sessions = defaultSessions();
    sessions.forEach(ensureSessionCandidateState);
    sessions.forEach(ensureSessionWorktreeState);
    projects = defaultProjects();
    activeSessionId = sessions[0].id;
  }
}
function saveState() {
  sessions.forEach(ensureSessionCandidateState);
  sessions.forEach(ensureSessionWorktreeState);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, projects, activeSessionId, pluginState }));
}
function activeSession() { return sessions.find((s) => s.id === activeSessionId) || sessions[0]; }
function getProject(id) { return projects.find((p) => p.id === id) || null; }
function sessionProject(session = activeSession()) {
  if (!session) return null;
  if (session.projectId) return getProject(session.projectId);
  return null;
}

function candidateSession() {
  return sessions.find((session) => session.id === memoryCandidateSessionId) || null;
}

function currentProjectRef(session = activeSession()) {
  const project = sessionProject(session);
  return window.MemoryCandidateState?.normalizeProjectRef({ id: project?.id, path: project?.path });
}

function updateMemoryCandidateCount() {
  const count = ensureSessionCandidateState(activeSession()).length;
  const badge = document.getElementById('memory-candidate-count');
  const button = document.getElementById('btn-memory-candidates');
  if (badge) badge.textContent = String(count);
  if (button) {
    button.classList.toggle('has-candidates', count > 0);
    button.setAttribute('aria-label', `记忆候选，${count} 条待审核`);
  }
}

function updateCandidateDraft(id, patch) {
  const session = candidateSession();
  const item = ensureSessionCandidateState(session).find((candidate) => candidate.id === id);
  if (!item || memoryCandidateBusy) return;
  const changesText = Object.hasOwn(patch, 'text');
  Object.assign(item, { ...patch, edited: true });
  if (changesText && !String(item.text || '').trim()) {
    memoryCandidateInvalidIds.add(id);
    memoryCandidateErrors.set(id, '记忆内容不能为空');
  } else if (changesText) {
    memoryCandidateInvalidIds.delete(id);
    memoryCandidateErrors.delete(id);
  } else if (!memoryCandidateInvalidIds.has(id)) {
    memoryCandidateErrors.delete(id);
  }
  session.pendingMemoryCandidates = window.MemoryCandidateState.normalizePendingCandidates(
    session.pendingMemoryCandidates,
    { max: window.MemoryCandidateState.PENDING_MAX, allowDrafts: true }
  );
  saveState();
  updateMemoryCandidateCount();
  const row = document.querySelector(`.memory-candidate-row[data-candidate-id="${CSS.escape(String(id))}"]`);
  const error = row?.querySelector('.memory-candidate-error');
  if (error) error.textContent = memoryCandidateErrors.get(id) || '';
}

function updateMemoryCandidateActions() {
  const session = candidateSession();
  const validIds = new Set(ensureSessionCandidateState(session).map((item) => item.id));
  const selectedCount = [...memoryCandidateSelected].filter((id) => validIds.has(id)).length;
  const accept = document.getElementById('btn-memory-candidate-accept');
  const reject = document.getElementById('btn-memory-candidate-reject');
  const later = document.getElementById('btn-memory-candidate-later');
  const close = document.getElementById('btn-memory-candidate-close');
  if (accept) {
    accept.disabled = memoryCandidateBusy || selectedCount === 0 || !memoryCandidateMemoryEnabled;
    accept.title = !memoryCandidateMemoryEnabled ? '请先启用长期记忆' : '';
  }
  if (reject) reject.disabled = memoryCandidateBusy || selectedCount === 0;
  if (later) later.disabled = memoryCandidateBusy;
  if (close) close.disabled = memoryCandidateBusy;
}

function renderMemoryCandidateReview() {
  const root = document.getElementById('memory-candidate-list');
  const session = candidateSession();
  if (!root || !session) return;
  const items = ensureSessionCandidateState(session);
  root.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-candidate-empty';
    empty.textContent = '当前会话没有待审核候选。';
    root.appendChild(empty);
  }
  const projectRef = currentProjectRef(session);
  for (const candidate of items) {
    const row = document.createElement('div');
    row.className = 'memory-candidate-row';
    row.dataset.candidateId = candidate.id;

    const select = document.createElement('input');
    select.type = 'checkbox';
    select.className = 'memory-candidate-select';
    select.checked = memoryCandidateSelected.has(candidate.id);
    select.disabled = memoryCandidateBusy;
    select.setAttribute('aria-label', '选择候选');
    select.addEventListener('change', () => {
      if (select.checked) memoryCandidateSelected.add(candidate.id);
      else memoryCandidateSelected.delete(candidate.id);
      updateMemoryCandidateActions();
    });

    const fields = document.createElement('div');
    fields.className = 'memory-candidate-fields';
    const text = document.createElement('textarea');
    text.className = 'memory-candidate-text';
    text.rows = 2;
    text.maxLength = 1000;
    text.value = candidate.text;
    text.disabled = memoryCandidateBusy;
    text.addEventListener('input', () => updateCandidateDraft(candidate.id, { text: text.value }));

    const tags = document.createElement('input');
    tags.type = 'text';
    tags.className = 'memory-candidate-tags';
    tags.placeholder = '标签，用逗号分隔';
    tags.value = candidate.tags.join(', ');
    tags.disabled = memoryCandidateBusy;
    tags.addEventListener('input', () => updateCandidateDraft(candidate.id, {
      tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
    }));

    const scope = document.createElement('div');
    scope.className = 'memory-candidate-scope';
    scope.setAttribute('role', 'group');
    scope.setAttribute('aria-label', '记忆作用域');
    for (const value of ['project', 'user']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scope-option' + (candidate.scope === value ? ' is-active' : '');
      button.textContent = value === 'project' ? '项目' : '用户';
      button.disabled = memoryCandidateBusy || (value === 'project' && !projectRef);
      button.addEventListener('click', () => {
        if (candidate.scope === value) return;
        updateCandidateDraft(candidate.id, {
          scope: value,
          projectRef: value === 'project' ? projectRef : null,
        });
        renderMemoryCandidateReview();
      });
      scope.appendChild(button);
    }

    const evidence = document.createElement('details');
    evidence.className = 'memory-candidate-evidence';
    const summary = document.createElement('summary');
    summary.textContent = '查看证据';
    const quote = document.createElement('div');
    quote.className = 'memory-candidate-evidence-text';
    quote.textContent = candidate.evidence;
    evidence.append(summary, quote);

    const error = document.createElement('div');
    error.className = 'memory-candidate-error';
    error.textContent = memoryCandidateErrors.get(candidate.id) || '';
    fields.append(text, tags, scope, evidence, error);
    row.append(select, fields);
    root.appendChild(row);
  }
  updateMemoryCandidateActions();
}

async function openMemoryCandidateReview(session = activeSession(), { notice = '' } = {}) {
  if (!session) return;
  ensureSessionCandidateState(session);
  memoryCandidateSessionId = session.id;
  memoryCandidateSelected = new Set();
  memoryCandidateErrors = new Map();
  memoryCandidateInvalidIds = new Set();
  memoryCandidateBusy = false;
  memoryCandidateMemoryEnabled = false;
  memoryCandidateNotice = String(notice || '');
  const summary = document.getElementById('memory-candidate-summary');
  summary.textContent = '正在读取记忆状态…';
  document.getElementById('memory-candidate-modal').classList.remove('hidden');
  renderMemoryCandidateReview();

  try {
    const settings = await window.codex.getSettings();
    memoryCandidateMemoryEnabled = settings?.memoryEnabled !== false;
  } catch {
    memoryCandidateMemoryEnabled = false;
  }

  if (memoryCandidateMemoryEnabled) {
    try {
      const projectPath = sessionProject(session)?.path || null;
      const result = await window.codex.listMemory({ projectPath });
      if (result?.ok) {
        session.pendingMemoryCandidates = window.MemoryCandidateState.filterStoredDuplicates(
          session.pendingMemoryCandidates,
          result.entries,
          currentProjectRef(session)
        );
        saveState();
        updateMemoryCandidateCount();
      }
    } catch {
      // 列表去重只是 best effort；appendEntry 仍会做最终去重。
    }
  }

  summary.textContent = memoryCandidateNotice || (memoryCandidateMemoryEnabled
    ? ''
    : '长期记忆已关闭；仍可编辑或拒绝候选，启用后才能接受。');
  renderMemoryCandidateReview();
}

const openCandidateReview = (...args) => openMemoryCandidateReview(...args);

async function acceptSelectedMemoryCandidates() {
  const session = candidateSession();
  if (!session || memoryCandidateBusy || !memoryCandidateMemoryEnabled) return;
  const selected = ensureSessionCandidateState(session).filter(
    (candidate) => memoryCandidateSelected.has(candidate.id)
  );
  if (!selected.length) return;

  memoryCandidateBusy = true;
  memoryCandidateErrors = new Map();
  for (const candidate of selected) {
    if (memoryCandidateInvalidIds.has(candidate.id)) {
      memoryCandidateErrors.set(candidate.id, '记忆内容不能为空');
    }
  }
  renderMemoryCandidateReview();
  const acceptedIds = [];
  let failed = 0;
  for (const candidate of selected) {
    if (memoryCandidateInvalidIds.has(candidate.id)) {
      failed++;
      continue;
    }
    const built = window.MemoryCandidateState.buildAcceptPayload(candidate, currentProjectRef(session));
    if (!built.ok) {
      memoryCandidateErrors.set(candidate.id, built.error);
      failed++;
      continue;
    }
    try {
      const result = await window.codex.acceptMemory(built.payload);
      if (result?.ok) {
        acceptedIds.push(candidate.id);
      } else {
        memoryCandidateErrors.set(candidate.id, result?.error || '写入记忆失败');
        failed++;
      }
    } catch (error) {
      memoryCandidateErrors.set(candidate.id, error?.message || String(error));
      failed++;
    }
  }

  session.pendingMemoryCandidates = window.MemoryCandidateState.removePendingCandidates(
    session.pendingMemoryCandidates,
    acceptedIds
  );
  for (const id of acceptedIds) memoryCandidateSelected.delete(id);
  for (const id of acceptedIds) memoryCandidateInvalidIds.delete(id);
  saveState();
  updateMemoryCandidateCount();
  memoryCandidateBusy = false;
  document.getElementById('memory-candidate-summary').textContent =
    `已接受 ${acceptedIds.length} 条，失败 ${failed} 条`;
  renderMemoryCandidateReview();
  if (acceptedIds.length && !document.getElementById('settings-modal').classList.contains('hidden')) {
    renderMemoryList().catch(() => {});
  }
}

async function rejectSelectedMemoryCandidates() {
  const session = candidateSession();
  if (!session || memoryCandidateBusy) return;
  const ids = ensureSessionCandidateState(session)
    .filter((candidate) => memoryCandidateSelected.has(candidate.id))
    .map((candidate) => candidate.id);
  if (!ids.length || !(await appConfirm('确定拒绝所选记忆候选？'))) return;
  session.pendingMemoryCandidates = window.MemoryCandidateState.removePendingCandidates(
    session.pendingMemoryCandidates,
    ids
  );
  memoryCandidateSelected = new Set();
  for (const id of ids) {
    memoryCandidateErrors.delete(id);
    memoryCandidateInvalidIds.delete(id);
  }
  saveState();
  updateMemoryCandidateCount();
  document.getElementById('memory-candidate-summary').textContent = `已拒绝 ${ids.length} 条`;
  renderMemoryCandidateReview();
}

function closeMemoryCandidateReview() {
  if (memoryCandidateBusy) return;
  document.getElementById('memory-candidate-modal').classList.add('hidden');
  memoryCandidateSessionId = null;
  memoryCandidateSelected = new Set();
  memoryCandidateErrors = new Map();
  memoryCandidateInvalidIds = new Set();
  memoryCandidateNotice = '';
}

function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function resolveAppDialog(value) {
  const current = appDialogState;
  if (!current) return;
  appDialogState = null;
  current.modal.classList.add('hidden');
  current.resolve(value);
}
function showAppDialog({ kind = 'alert', title = '', message = '', value = '', placeholder = '' } = {}) {
  const modal = document.getElementById('app-dialog');
  const titleEl = document.getElementById('app-dialog-title');
  const messageEl = document.getElementById('app-dialog-message');
  const inputWrap = document.getElementById('app-dialog-input-wrap');
  const input = document.getElementById('app-dialog-input');
  const cancel = document.getElementById('app-dialog-cancel');
  const ok = document.getElementById('app-dialog-ok');
  if (!modal || !titleEl || !messageEl || !inputWrap || !input || !cancel || !ok) {
    return Promise.resolve(kind === 'alert' ? true : null);
  }
  if (appDialogState) resolveAppDialog(null);
  titleEl.textContent = title || (kind === 'alert' ? '提示' : kind === 'prompt' ? '输入' : '确认');
  messageEl.textContent = String(message || '');
  inputWrap.classList.toggle('hidden', kind !== 'prompt');
  input.value = String(value ?? '');
  input.placeholder = String(placeholder || '');
  cancel.classList.toggle('hidden', kind === 'alert');
  ok.textContent = kind === 'alert' ? '知道了' : '确定';
  modal.classList.remove('hidden');
  return new Promise((resolve) => {
    appDialogState = { kind, modal, input, resolve };
    requestAnimationFrame(() => {
      if (kind === 'prompt') {
        input.focus();
        input.select();
      } else {
        ok.focus();
      }
    });
  });
}
function appAlert(message, title = '提示') {
  return showAppDialog({ kind: 'alert', title, message });
}
function appConfirm(message, title = '确认操作') {
  return showAppDialog({ kind: 'confirm', title, message }).then((value) => value === true);
}
function appPrompt(message, value = '', title = '重命名') {
  return showAppDialog({ kind: 'prompt', title, message, value }).then((result) => (
    result == null ? null : String(result)
  ));
}
function bindAppDialog() {
  const modal = document.getElementById('app-dialog');
  if (!modal) return;
  document.getElementById('app-dialog-cancel')?.addEventListener('click', () => resolveAppDialog(null));
  document.getElementById('app-dialog-ok')?.addEventListener('click', () => {
    const current = appDialogState;
    resolveAppDialog(current?.kind === 'prompt' ? current.input.value : true);
  });
  modal.addEventListener('click', (event) => {
    if (event.target !== modal) return;
    resolveAppDialog(appDialogState?.kind === 'alert' ? true : null);
  });
  document.getElementById('app-dialog-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const current = appDialogState;
    resolveAppDialog(current?.input.value || '');
  });
  document.addEventListener('keydown', (event) => {
    if (!appDialogState || event.key !== 'Escape') return;
    event.preventDefault();
    resolveAppDialog(appDialogState.kind === 'alert' ? true : null);
  });
}
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function formatInline(text) { return escapeHtml(text).replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>'); }
function formatListItem(line) { return escapeHtml(line).replace(/`([^`]+)`/g, '<span class="chip">$1</span>'); }
function renderTextBlock(text) {
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const isList = lines.every((l) => !l.trim() || /^[-*]\s+/.test(l.trim()) || /^\d+\.\s+/.test(l.trim()));
    if (isList && lines.some((l) => /^[-*]\s+/.test(l.trim()) || /^\d+\.\s+/.test(l.trim()))) {
      return '<ul>' + lines.filter((l)=>l.trim()).map((l)=>l.trim().replace(/^[-*]\s+/,'').replace(/^\d+\.\s+/,'')).map((l)=>'<li>'+formatListItem(l)+'</li>').join('') + '</ul>';
    }
    return '<p>' + formatInline(lines.join('\n')).replace(/\n/g,'<br>') + '</p>';
  }).join('');
}
function renderMarkdownLite(text) {
  const source = String(text || '');
  const parts = []; const fence = /```(\w+)?\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fence.exec(source)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: source.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', value: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) });
  if (!parts.length) parts.push({ type: 'text', value: source });
  return parts.map((p) => {
    if (p.type === 'code') return '<div class="code-block"><div class="code-lang">'+escapeHtml(p.lang||'code')+'</div><pre><code>'+escapeHtml(p.value)+'</code></pre></div>';
    let html = renderTextBlock(p.value);
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const safe = escapeHtml(src);
      if (safe.startsWith('data:image') || safe.startsWith('blob:')) return '<img class="msg-image" alt="'+escapeHtml(alt)+'" src="'+safe+'" />';
      return '<span class="chip">[图片]</span>';
    });
    return html;
  }).join('');
}
function peerName(peerId) { return FRIENDS.find((f) => f.id === peerId)?.name || 'Codex 小蓝'; }
function fileChangesStripHtml(changes) {
  if (!Array.isArray(changes) || !changes.length) return '';
  const n = changes.length;
  const pathsHtml = changes
    .map((c) => {
      const op = c.op ? '<span class="file-change-op">' + escapeHtml(String(c.op)) + '</span> ' : '';
      return '<li>' + op + escapeHtml(String(c.path || '')) + '</li>';
    })
    .join('');
  return (
    '<div class="file-changes-strip">' +
      '<button type="button" class="file-changes-toggle" aria-expanded="false">本轮改动 (' + n + ')</button>' +
      '<ul class="file-changes-list is-collapsed">' + pathsHtml + '</ul>' +
    '</div>'
  );
}

function worktreeStateLabel(state) {
  return ({
    creating: '创建中', running: '子 Agent 运行中', collecting: '收集中', ready: '待审',
    collect_failed: '收集失败', oversize: '补丁过大', conflict: '与主项目冲突', applying: '应用中',
    apply_uncertain: '应用状态不确定', applied_cleanup_pending: '已应用，待清理',
    discarded_cleanup_pending: '已丢弃，待清理',
    pr_preparing: '检查 GitHub', pr_committing: '创建提交', pr_pushing: '推送分支',
    pr_creating: '创建 Draft PR', pr_failed: 'PR 创建失败',
    pr_cleanup_pending: 'PR 已创建，待清理', pr_created: 'Draft PR 已创建',
  })[state] || state;
}

function defaultWorktreePrTitle(ref) {
  const goal = String(ref?.goal || '').trim().split(/\r?\n/)[0].slice(0, 280);
  return goal || `codex: ${String(ref?.id || 'isolated change')}`;
}

function defaultWorktreePrBody(ref) {
  const stats = ref?.stats || {};
  const head = ref?.baseHead ? ref.baseHead.slice(0, 12) : '-';
  return [
    '## Summary',
    '',
    String(ref?.goal || 'Codex isolated change').slice(0, 2000),
    '',
    '## Change summary',
    '',
    `- Files: ${Number(stats.files) || 0}`,
    `- Additions: ${Number(stats.additions) || 0}`,
    `- Deletions: ${Number(stats.deletions) || 0}`,
    `- Base: ${head}`,
    '',
    '## Verification',
    '',
    '- Not run automatically.',
  ].join('\n');
}

function updateWorktreeRef(session, ref) {
  if (!session || !window.WorktreeResultState) return;
  session.pendingWorktreeResults = window.WorktreeResultState.upsert(
    ensureSessionWorktreeState(session), ref
  );
  saveState();
}

async function worktreeAction(session, ref, action) {
  const project = sessionProject(session);
  const token = project ? worktreeBindings.get(project.id) : null;
  if (!project?.path || !token || worktreeActionBusy.has(ref.id)) {
    toast('项目绑定已失效，请重新打开项目');
    if (project) reconcileWorktreeResults(project);
    return;
  }
  if (action === 'managePr') {
    openPullRequestManager(ref);
    return;
  }
  if (action === 'discard') {
    const remoteNote = ref.pr?.pushed ? '已推送的远端分支不会删除。' : '';
    if (!(await appConfirm(`确定丢弃这批隔离改动？主项目不会被修改。${remoteNote}`))) return;
  }
  const card = document.querySelector(`.worktree-result-card[data-result-id="${ref.id}"]`);
  const prTitle = card?.querySelector('.worktree-pr-title')?.value || ref.prDraftTitle || defaultWorktreePrTitle(ref);
  const prBody = card?.querySelector('.worktree-pr-body')?.value || ref.prDraftBody || defaultWorktreePrBody(ref);
  const gateScope = `worktree:${ref.id}`;
  worktreeActionBusy.add(ref.id);
  renderMessages();
  try {
    let response;
    if (action === 'preview') {
      response = await window.codex.getWorktreeResult({ projectBindingId: token, resultId: ref.id, preview: true });
      if (response?.ok) worktreePreviews.set(ref.id, response.preview || '(没有文本 diff)');
    } else if (action === 'open') {
      response = await window.codex.openWorktreeResult({ projectBindingId: token, resultId: ref.id });
    } else if (action === 'prForm') {
      response = await window.codex.preflightWorktreePr({ projectBindingId: token, resultId: ref.id });
      if (response?.ok) {
        worktreePrEditors.add(ref.id);
        updateWorktreeRef(session, {
          ...ref,
          prDraftTitle: ref.prDraftTitle || defaultWorktreePrTitle(ref),
          prDraftBody: ref.prDraftBody || defaultWorktreePrBody(ref),
        });
      }
    } else if (action === 'createPr') {
      const method = ref.canRetryPr ? window.codex.retryWorktreePr : window.codex.createWorktreePr;
      response = await method({ projectBindingId: token, resultId: ref.id, title: prTitle, body: prBody, draft: true, ...workflowGatePayload(project, 'create_pr', gateScope) });
      if (response?.result) updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId, prDraftTitle: prTitle, prDraftBody: prBody });
      if (response?.ok && response.created) worktreePrEditors.delete(ref.id);
    } else if (action === 'cleanupPr') {
      response = await window.codex.cleanupWorktreePr({ projectBindingId: token, resultId: ref.id });
      if (response?.result) updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId });
    } else if (action === 'openPr') {
      response = await window.codex.openWorktreePr({ projectBindingId: token, resultId: ref.id });
    } else if (action === 'refreshPr') {
      response = await window.codex.getPullRequest({ projectBindingId: token, resultId: ref.id });
      if (response?.result) updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId });
    } else if (action === 'apply') {
      response = await window.codex.applyWorktreeResult({ projectBindingId: token, resultId: ref.id, ...workflowGatePayload(project, 'apply', gateScope) });
      if (response?.ok && response.applied && !response.cleanupWarning) {
        session.pendingWorktreeResults = window.WorktreeResultState.remove(session.pendingWorktreeResults, ref.id);
        worktreePreviews.delete(ref.id);
        saveState();
      } else if (response?.result) {
        updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId });
      }
    } else if (action === 'discard') {
      response = await window.codex.discardWorktreeResult({ projectBindingId: token, resultId: ref.id });
      if (response?.ok && response.cleaned) {
        session.pendingWorktreeResults = window.WorktreeResultState.remove(session.pendingWorktreeResults, ref.id);
        worktreePreviews.delete(ref.id);
        saveState();
      }
    } else if (action === 'retryCollect') {
      response = await window.codex.retryCollectWorktreeResult({ projectBindingId: token, resultId: ref.id });
      if (response?.result) updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId });
    } else if (action === 'cleanup') {
      response = await window.codex.cleanupWorktreeResult({ projectBindingId: token, resultId: ref.id });
      if (response?.ok) {
        session.pendingWorktreeResults = window.WorktreeResultState.remove(session.pendingWorktreeResults, ref.id);
        saveState();
      }
    }
    if (!response?.ok) {
      if (response?.result) updateWorktreeRef(session, { ...response.result, projectId: project.id, sessionId: ref.sessionId });
      toast(response?.error || '隔离改动操作失败');
      reconcileWorktreeResults(project);
    } else if (action === 'preview') {
      renderMessages();
      return;
    } else if (action === 'open') {
      toast('已打开隔离目录');
    } else if (action === 'openPr') {
      toast('已在浏览器打开 PR');
    } else if (action === 'refreshPr') {
      toast('PR 状态已刷新');
    } else if (action === 'createPr' && response.created) {
      toast(response.cleanupWarning ? 'Draft PR 已创建，本地清理待重试' : 'Draft PR 已创建');
    } else if (action === 'apply') {
      toast(response.cleanupWarning ? '已应用，清理待重试' : '隔离改动已应用到主项目');
    }
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    worktreeActionBusy.delete(ref.id);
    renderMessages();
  }
}

function renderWorktreeCards(root, session) {
  if (!root || !session) return;
  for (const ref of worktreeRefsForSession(session)) {
    const card = document.createElement('section');
    card.className = 'worktree-result-card';
    card.dataset.resultId = ref.id;
    const stats = ref.stats || {};
    const fileCount = Number(stats.files) || ref.files.length;
    const head = ref.baseHead ? ref.baseHead.slice(0, 8) : '-';
    const title = document.createElement('div');
    title.className = 'worktree-result-title';
    title.textContent = `${String(ref.state).startsWith('pr_') ? 'GitHub PR' : '隔离改动待审'} · ${worktreeStateLabel(ref.state)}`;
    const goal = document.createElement('div');
    goal.className = 'worktree-result-goal';
    goal.textContent = ref.goal || '未命名子任务';
    const summary = document.createElement('div');
    summary.className = 'worktree-result-summary';
    summary.textContent = `${fileCount} 个文件 · +${stats.additions || 0}/-${stats.deletions || 0}${stats.binaryFiles ? ` · 二进制 ${stats.binaryFiles}` : ''} · 基线 ${head}`;
    card.append(title, goal, summary);

    if (ref.pr?.url) {
      const prSummary = document.createElement('div');
      prSummary.className = 'worktree-pr-summary';
      const repo = [ref.pr.host, ref.pr.owner, ref.pr.repo].filter(Boolean).join('/');
      const remoteState = ref.pr.state ? ` · ${pullRequestStatus({ state: ref.pr.state, isDraft: ref.pr.draft })}` : '';
      const checks = ref.pr.checksSummary || {};
      const checkState = checks.total ? ` · checks ${checks.passed || 0}/${checks.total}` : '';
      prSummary.textContent = `${ref.pr.draft ? 'Draft PR' : 'PR'}${ref.pr.number ? ` #${ref.pr.number}` : ''} · ${repo || 'GitHub'} · ${ref.pr.head || ''}${ref.pr.commit ? ` · ${ref.pr.commit.slice(0, 8)}` : ''}${remoteState}${checkState}`;
      card.appendChild(prSummary);
    }

    if (ref.incomplete) {
      const note = document.createElement('div'); note.className = 'worktree-result-note'; note.textContent = '子 Agent 未完整结束，仍可审阅并应用或丢弃。'; card.appendChild(note);
    }
    if (ref.error) {
      const note = document.createElement('div'); note.className = 'worktree-result-note is-error'; note.textContent = `${ref.errorCode || '错误'}：${ref.error}`; card.appendChild(note);
    }
    const files = document.createElement('details');
    files.className = 'worktree-result-files';
    const fileSummary = document.createElement('summary'); fileSummary.textContent = `查看文件${ref.filesTruncated ? '（前 200 条）' : ''}`; files.appendChild(fileSummary);
    const list = document.createElement('ul');
    for (const file of ref.files) { const li = document.createElement('li'); li.textContent = `${file.status} ${file.path}${file.binary ? ' · binary' : ''}`; list.appendChild(li); }
    files.appendChild(list); card.appendChild(files);

    const preview = worktreePreviews.get(ref.id);
    if (preview) { const pre = document.createElement('pre'); pre.className = 'worktree-result-preview'; pre.textContent = preview; card.appendChild(pre); }

    const busy = worktreeActionBusy.has(ref.id);
    const mutationBlocked = sending || anyTermRunning();
    if (worktreePrEditors.has(ref.id) && ref.canCreatePr) {
      const form = document.createElement('div'); form.className = 'worktree-pr-form';
      const titleInput = document.createElement('input'); titleInput.type = 'text'; titleInput.maxLength = 300; titleInput.className = 'worktree-pr-title'; titleInput.value = ref.prDraftTitle || defaultWorktreePrTitle(ref); titleInput.setAttribute('aria-label', 'PR 标题');
      const bodyInput = document.createElement('textarea'); bodyInput.maxLength = 10000; bodyInput.rows = 7; bodyInput.className = 'worktree-pr-body'; bodyInput.value = ref.prDraftBody || defaultWorktreePrBody(ref); bodyInput.setAttribute('aria-label', 'PR 正文');
      const saveDraft = () => {
        ref.prDraftTitle = titleInput.value.slice(0, 300);
        ref.prDraftBody = bodyInput.value.slice(0, 10000);
        updateWorktreeRef(session, ref);
      };
      titleInput.addEventListener('input', saveDraft); bodyInput.addEventListener('input', saveDraft);
      const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'btn-primary'; submit.textContent = ref.canRetryPr ? '重试创建 Draft PR' : '确认创建 Draft PR'; submit.disabled = busy || mutationBlocked;
      submit.addEventListener('click', () => worktreeAction(session, ref, 'createPr'));
      form.append(titleInput, bodyInput);
      appendWorkflowGateSelector(form, sessionProject(session), 'create_pr', `worktree:${ref.id}`, busy || mutationBlocked);
      form.appendChild(submit); card.appendChild(form);
    }
    if (ref.canApply) appendWorkflowGateSelector(card, sessionProject(session), 'apply', `worktree:${ref.id}`, busy || mutationBlocked);
    const actions = document.createElement('div'); actions.className = 'worktree-result-actions';
    const addButton = (label, action, enabled = true, primary = false, mutation = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = busy || !enabled || (mutation && mutationBlocked); if (primary) button.className = 'btn-primary'; else button.className = 'btn-secondary';
      button.addEventListener('click', () => worktreeAction(session, ref, action)); actions.appendChild(button);
    };
    if (ref.canApply) addButton(`应用全部（${fileCount} 个文件）`, 'apply', true, true, true);
    if (ref.canCreatePr) addButton(ref.canRetryPr ? '重试 PR' : '创建 Draft PR', 'prForm', true, false, true);
    if (ref.canPreview) addButton('查看 diff', 'preview', true);
    if (ref.canDiscard) addButton('丢弃', 'discard', true, false, true);
    if (ref.canRetryCollect) addButton('重试收集', 'retryCollect', true, false, true);
    if (ref.canCleanup) addButton('重试清理', 'cleanup', true, false, true);
    if (ref.canCleanupPr) addButton('重试 PR 清理', 'cleanupPr', true, false, true);
    if (ref.canOpenPr) {
      addButton('管理 PR', 'managePr', true);
      addButton('刷新 PR', 'refreshPr', true);
      addButton('打开 PR', 'openPr', true);
    }
    if (ref.canOpen) addButton('打开隔离目录', 'open', true);
    card.appendChild(actions);
    root.appendChild(card);
  }
}

function bindFileChangesToggles(root) {
  if (!root) return;
  root.querySelectorAll('.file-changes-strip').forEach((strip) => {
    const btn = strip.querySelector('.file-changes-toggle');
    const listEl = strip.querySelector('.file-changes-list');
    if (!btn || !listEl || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const open = listEl.classList.toggle('is-collapsed') === false;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
}

function renderMessages() {
  const list = document.getElementById('message-list'); if (!list) return;
  const session = activeSession(); const msgs = session?.messages || [];
  const botName = peerName(session?.peer || 'codex');
  const liveRun = chatRun && chatRun.sessionId === activeSessionId && !chatRun.finalized;
  const showTyping = sending && !liveRun;
  list.innerHTML = msgs.map((msg) => {
    const roleClass = msg.role === 'user' ? 'msg-user' : 'msg-assistant';
    const errClass = msg.error ? ' msg-error' : '';
    const compactClass = msg.compact ? ' msg-compact' : '';
    const who = msg.role === 'user' ? '我' : (msg.compact ? '会话摘要' : botName);
    const strip = msg.role === 'assistant' ? fileChangesStripHtml(msg.fileChanges) : '';
    return '<div class="msg '+roleClass+errClass+compactClass+'"><div class="bubble"><div class="msg-meta">'+who+'</div>'+strip+renderMarkdownLite(msg.content)+'</div></div>';
  }).join('') + (showTyping ? '<div class="typing">'+botName+' 正在输入… <button type="button" class="linkish" id="inline-stop">停止</button></div>' : '') + renderInlineMcpTasks();
  renderWorktreeCards(list, session);
  bindFileChangesToggles(list);
  if (liveRun && chatRun.el) {
    list.appendChild(chatRun.el);
  }
  scrollToBottom();
  bindInlineStop();
  renderUsageBar();
  renderContextMeter();
}

function toolArgsSummary(tool, args) {
  if (!args || typeof args !== 'object') return '';
  if (args.path) return String(args.path);
  if (args.pattern) return String(args.pattern);
  if (args.command) return String(args.command).slice(0, 80);
  try {
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return '';
  }
}

function createAssistantRunPlaceholder(sessionId) {
  const session = activeSession();
  const botName = peerName(session?.peer || 'codex');
  const el = document.createElement('div');
  el.className = 'msg msg-assistant msg-run';
  el.dataset.runId = 'pending';
  el.innerHTML =
    '<div class="bubble has-run">' +
      '<div class="msg-meta">' + escapeHtml(botName) + '</div>' +
      '<div class="agent-timeline" data-role="timeline"></div>' +
      '<div class="stream-body is-streaming" data-role="stream"></div>' +
      '<div class="stream-status" data-role="status"></div>' +
    '</div>';
  chatRun = {
    runId: null,
    sessionId,
    el,
    timelineEl: el.querySelector('[data-role="timeline"]'),
    streamEl: el.querySelector('[data-role="stream"]'),
    statusEl: el.querySelector('[data-role="status"]'),
    textBuffer: '',
    contentFinal: null,
    applied: null,
    fileChanges: [],
    pendingPlanId: null,
    verifyState: null,
    doneEvent: false,
    invokeDone: false,
    finalized: false,
    error: false,
    aborted: false,
  };
  return chatRun;
}

function renderPlanCard(ev) {
  if (!chatRun?.timelineEl || !ev) return;
  chatRun.pendingPlanId = ev.planId;
  // Invalidate previous unresolved plan cards
  chatRun.el.querySelectorAll('.plan-card:not(.resolved)').forEach((c) => {
    c.classList.add('resolved');
    const actions = c.querySelector('.plan-actions');
    if (actions) actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    let res = c.querySelector('.plan-result');
    if (!res) {
      res = document.createElement('div');
      res.className = 'plan-result';
      c.appendChild(res);
    }
    res.textContent = '已被更新计划替代';
  });

  const card = document.createElement('div');
  card.className = 'plan-card';
  card.dataset.planId = ev.planId || '';
  const title = ev.title || '实施计划';
  let stepsHtml = '';
  if (Array.isArray(ev.steps) && ev.steps.length) {
    stepsHtml = '<ol class="plan-steps">'
      + ev.steps.map((s) => '<li>' + escapeHtml(String(s)) + '</li>').join('')
      + '</ol>';
  }
  card.innerHTML =
    '<div class="plan-title">' + escapeHtml(title) + '</div>'
    + '<div class="plan-body">' + escapeHtml(String(ev.markdown || '')) + '</div>'
    + stepsHtml
    + '<div class="plan-actions">'
    + '<button type="button" class="plan-btn plan-approve">批准执行</button>'
    + '<button type="button" class="plan-btn plan-reject">驳回</button>'
    + '</div>';

  const approveBtn = card.querySelector('.plan-approve');
  const rejectBtn = card.querySelector('.plan-reject');
  approveBtn.addEventListener('click', () => approvePlanFromCard(card, ev));
  rejectBtn.addEventListener('click', async () => {
    if (card.classList.contains('resolved')) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      if (window.codex?.rejectPlan) {
        await window.codex.rejectPlan({
          sessionId: chatRun?.sessionId || activeSessionId,
          planId: ev.planId,
        });
      }
    } catch { /* ignore */ }
    card.classList.add('resolved');
    const res = document.createElement('div');
    res.className = 'plan-result';
    res.textContent = '已驳回';
    card.appendChild(res);
    toast('已驳回计划');
  });

  chatRun.timelineEl.appendChild(card);
  scrollToBottom();
}

async function approvePlanFromCard(card, planEv) {
  if (!chatRun || chatRun.finalized || card.classList.contains('resolved')) return;
  if (sending && chatRun && !chatRun.finalized) {
    // still in same run that produced the plan — wait for finalize first is safer;
    // allow approve after plan-ready while invoke may still be open? Spec: if activeRun, main rejects.
    // After plan submit model often continues to final text; user may click after done.
  }
  const session = sessions.find((s) => s.id === chatRun.sessionId) || activeSession();
  if (!session) return;

  const btns = card.querySelectorAll('button');
  btns.forEach((b) => { b.disabled = true; });

  // If still streaming this plan-producing run, stop first so approve can start new run
  if (sending) {
    try { await window.codex.stopChat(); } catch { /* ignore */ }
    // small yield for main to clear activeRun
    await new Promise((r) => setTimeout(r, 50));
  }

  const history = session.messages
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
  // Include live assistant buffer if not yet finalized into messages
  if (chatRun && !chatRun.finalized) {
    const partial = chatRun.contentFinal || chatRun.textBuffer;
    if (partial) history.push({ role: 'assistant', content: String(partial) });
  }

  const proj = sessionProject(session);
  const projectBindingId = proj?.path ? engineeringBindingToken() : '';
  setSending(true);
  try {
    const res = await window.codex.approvePlan({
      sessionId: session.id,
      planId: planEv.planId,
      messages: history,
      project: proj?.path ? { name: proj.name, path: proj.path } : null,
      projectBindingId,
    });
    if (!res?.ok && !res?.userMessage) {
      btns.forEach((b) => { b.disabled = false; });
      toast(res?.error || '批准失败');
      setSending(false);
      return;
    }

    session.agentMode = 'agent';
    updateAgentModeToggle();
    card.classList.add('resolved');
    let resultEl = card.querySelector('.plan-result');
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'plan-result';
      card.appendChild(resultEl);
    }
    resultEl.textContent = '已批准，正在执行…';

    if (res.userMessage) {
      session.messages.push({
        role: res.userMessage.role || 'user',
        content: res.userMessage.content,
      });
    }
    session.updatedAt = Date.now();
    saveState();

    // Finalize previous plan-run bubble if still open
    if (chatRun && !chatRun.finalized) {
      chatRun.invokeDone = true;
      finalizeChatRun({
        content: chatRun.contentFinal || chatRun.textBuffer || '计划已提交',
        applied: chatRun.applied,
      });
    }

    // New agent run placeholder
    createAssistantRunPlaceholder(session.id);
    renderMessages();
    renderLeftDynamic();

    const invokeResult = res.result;
    if (chatRun && !chatRun.finalized) {
      chatRun.invokeDone = true;
      if (invokeResult) {
        if (chatRun.contentFinal == null && invokeResult.content != null) {
          chatRun.contentFinal = String(invokeResult.content);
        }
        if (!chatRun.applied && invokeResult.applied) chatRun.applied = invokeResult.applied;
        if (!Array.isArray(chatRun.fileChanges)) chatRun.fileChanges = [];
        if (Array.isArray(invokeResult.fileChanges)) {
          for (const fc of invokeResult.fileChanges) mergeFileChangeEntry(chatRun.fileChanges, fc);
        }
        if (chatRun.fileChanges.length) renderFileChangesStrip();
        const content = chatRun.contentFinal != null
          ? chatRun.contentFinal
          : (invokeResult.content || chatRun.textBuffer || '');
        finalizeChatRun({ content, applied: chatRun.applied || invokeResult.applied });
      } else if (res.aborted) {
        finalizeChatRun({ aborted: true, content: chatRun.contentFinal || chatRun.textBuffer || '' });
      } else if (res.error) {
        finalizeChatRun({
          error: true,
          errorMessage: res.error,
          content: chatRun.contentFinal || chatRun.textBuffer || '',
        });
      } else if (chatRun.doneEvent) {
        finalizeChatRun({ content: chatRun.contentFinal || chatRun.textBuffer || '' });
      }
    }
  } catch (err) {
    btns.forEach((b) => { b.disabled = false; });
    toast(err?.message || String(err));
  } finally {
    setSending(false);
    saveState();
    renderMessages();
    renderLeftDynamic();
  }
}

function renderVerifyStrip(ev) {
  if (!chatRun?.el || !ev) return;
  chatRun.verifyState = ev;
  const bubble = chatRun.el.querySelector('.bubble') || chatRun.el;
  let strip = chatRun.el.querySelector('.verify-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'verify-strip';
    if (chatRun.streamEl && chatRun.streamEl.parentNode === bubble) {
      bubble.insertBefore(strip, chatRun.streamEl.nextSibling);
    } else {
      bubble.appendChild(strip);
    }
  }
  strip.classList.remove('is-ok', 'is-fail', 'is-skip');
  const cmd = ev.command ? '（' + String(ev.command) + '）' : '';
  if (ev.skipped) {
    strip.classList.add('is-skip');
    strip.textContent = '⚠ 未验证' + cmd + (ev.summary ? ' — ' + ev.summary : '');
  } else if (ev.ok) {
    strip.classList.add('is-ok');
    strip.textContent = '✅ 验证通过' + cmd;
  } else {
    strip.classList.add('is-fail');
    strip.textContent = '❌ 验证失败' + cmd + (ev.summary ? ' — ' + ev.summary : '');
  }
}

function appendTimelineRow(kind, tool, summary, ok) {
  if (!chatRun?.timelineEl) return;
  const row = document.createElement('div');
  row.className = 'agent-step step-' + kind + (kind === 'end' && ok === false ? ' is-fail' : '') + (kind === 'start' ? ' step-running' : '');
  const icon = kind === 'start' ? '▸' : (ok === false ? '✗' : '✓');
  row.innerHTML =
    '<span class="step-icon">' + icon + '</span>' +
    '<span class="step-body"><span class="step-tool">' + escapeHtml(tool || 'tool') + '</span>' +
    (summary ? '<span class="step-summary">' + escapeHtml(summary) + '</span>' : '') +
    '</span>';
  chatRun.timelineEl.appendChild(row);
  scrollToBottom();
}

function appendTimelineCustom(node) {
  if (!chatRun?.timelineEl || !node) return;
  chatRun.timelineEl.appendChild(node);
  scrollToBottom();
}

function ensureSubagentBlock(ev) {
  if (!chatRun) return null;
  if (!chatRun.subagentBlocks) chatRun.subagentBlocks = new Map();
  const id = ev.subagentId || 'unknown';
  if (chatRun.subagentBlocks.has(id)) return chatRun.subagentBlocks.get(id);
  const root = document.createElement('div');
  root.className = 'subagent-block';
  root.dataset.subagentId = id;
  root.innerHTML =
    '<div class="subagent-block-hd">' +
      '<span class="sa-title"></span>' +
      '<span class="sa-status is-run">进行中…</span>' +
    '</div>' +
    '<div class="subagent-block-body">' +
      '<div class="sa-tools"></div>' +
      '<div class="sa-summary"></div>' +
    '</div>';
  const hd = root.querySelector('.subagent-block-hd');
  hd.addEventListener('click', () => root.classList.toggle('open'));
  const kind = ev.kind || 'explore';
  const goal = String(ev.goal || '').slice(0, 80);
  root.querySelector('.sa-title').textContent = '子 Agent · ' + kind + ' · ' + goal;
  appendTimelineCustom(root);
  const rec = {
    el: root,
    toolsEl: root.querySelector('.sa-tools'),
    summaryEl: root.querySelector('.sa-summary'),
    statusEl: root.querySelector('.sa-status'),
  };
  chatRun.subagentBlocks.set(id, rec);
  return rec;
}

function updateStreamBody() {
  if (!chatRun?.streamEl) return;
  chatRun.streamEl.textContent = chatRun.textBuffer;
  scrollToBottom();
}

function setRunStatus(text, kind) {
  if (!chatRun?.statusEl) return;
  chatRun.statusEl.textContent = text || '';
  chatRun.statusEl.classList.remove('is-error', 'is-aborted');
  if (kind === 'error') chatRun.statusEl.classList.add('is-error');
  if (kind === 'aborted') chatRun.statusEl.classList.add('is-aborted');
}

function decisionLabel(decision) {
  if (decision === 'allow') return '已允许';
  if (decision === 'allow_session') return '本会话始终允许';
  if (decision === 'deny') return '已拒绝';
  return decision || '';
}

function buildApprovalBodyHtml(ev) {
  const diff = ev.diff;
  const detail = ev.detail || '';
  if (diff?.isBinary) {
    return '<div class="appr-diff-note">二进制文件，无文本 diff</div>';
  }
  if (diff?.text) {
    let html = '<pre class="appr-diff">' + escapeHtml(String(diff.text)) + '</pre>';
    if (diff.truncated) {
      const a = diff.stats && diff.stats.additions != null ? diff.stats.additions : 0;
      const d = diff.stats && diff.stats.deletions != null ? diff.stats.deletions : 0;
      html += '<div class="appr-diff-note">（diff 已截断，+' + a + '/-' + d + '）</div>';
    }
    return html;
  }
  if (detail) {
    return '<pre class="appr-detail">' + escapeHtml(detail) + '</pre>';
  }
  return '';
}

function mergeFileChangeEntry(list, entry) {
  if (!entry || !entry.path) return;
  const path = String(entry.path);
  const existing = list.find((c) => c.path === path);
  if (existing) {
    if (entry.op) existing.op = entry.op;
    if (entry.stats) existing.stats = entry.stats;
    return;
  }
  list.push({ path, op: entry.op || 'write', stats: entry.stats || null });
}

function renderFileChangesStrip() {
  if (!chatRun?.el) return;
  const changes = Array.isArray(chatRun.fileChanges) ? chatRun.fileChanges : [];
  if (!changes.length) return;
  const bubble = chatRun.el.querySelector('.bubble') || chatRun.el;
  let strip = chatRun.el.querySelector('.file-changes-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'file-changes-strip';
    // Prefer under timeline (before stream body)
    if (chatRun.timelineEl && chatRun.timelineEl.parentNode === bubble) {
      const after = chatRun.timelineEl.nextSibling;
      bubble.insertBefore(strip, after);
    } else if (chatRun.streamEl && chatRun.streamEl.parentNode === bubble) {
      bubble.insertBefore(strip, chatRun.streamEl);
    } else {
      bubble.appendChild(strip);
    }
  }
  const n = changes.length;
  const pathsHtml = changes
    .map((c) => {
      const op = c.op ? '<span class="file-change-op">' + escapeHtml(String(c.op)) + '</span> ' : '';
      return '<li>' + op + escapeHtml(String(c.path)) + '</li>';
    })
    .join('');
  strip.innerHTML =
    '<button type="button" class="file-changes-toggle" aria-expanded="false">本轮改动 (' + n + ')</button>' +
    '<ul class="file-changes-list is-collapsed">' + pathsHtml + '</ul>';
  bindFileChangesToggles(strip);
  scrollToBottom();
}

function renderApprovalCard(ev) {
  if (!chatRun?.timelineEl) return;
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = ev.approvalId || '';
  const title = '需要确认：' + (ev.tool || '操作') + (ev.risk ? '（' + ev.risk + '）' : '');
  const body = buildApprovalBodyHtml(ev);
  const sessionAllowLabel = ev.risk === 'network' && ev.scope
    ? '本会话始终允许 ' + String(ev.scope)
    : '本会话始终允许此类';
  card.innerHTML =
    '<div class="appr-title">' + escapeHtml(title) + '</div>' +
    '<div class="appr-summary">' + escapeHtml(ev.summary || ev.path || '') + '</div>' +
    body +
    '<div class="appr-actions">' +
      '<button type="button" class="appr-btn" data-decision="allow">允许</button>' +
      '<button type="button" class="appr-btn appr-deny" data-decision="deny">拒绝</button>' +
      '<button type="button" class="appr-btn appr-session" data-decision="allow_session">'
        + escapeHtml(sessionAllowLabel) + '</button>' +
    '</div>' +
    '<div class="appr-result"></div>';
  card.querySelectorAll('.appr-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (card.classList.contains('resolved') || !chatRun || chatRun.finalized) return;
      const decision = btn.dataset.decision;
      card.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = true; });
      try {
        const res = await window.codex.approveChat({ approvalId: ev.approvalId, decision });
        if (!res?.ok) {
          card.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = false; });
          toast(res?.error || '审批失败');
          return;
        }
        // approval-resolved event will mark UI; optimistic label
        const resultEl = card.querySelector('.appr-result');
        if (resultEl) resultEl.textContent = decisionLabel(decision);
        card.classList.add('resolved');
      } catch (e) {
        card.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = false; });
        toast(e?.message || String(e));
      }
    });
  });
  chatRun.timelineEl.appendChild(card);
  scrollToBottom();
}

function markApprovalResolved(approvalId, decision) {
  if (!chatRun?.el) return;
  let target = null;
  chatRun.el.querySelectorAll('.approval-card').forEach((c) => {
    if (String(c.dataset.approvalId) === String(approvalId)) target = c;
  });
  if (!target) return;
  target.classList.add('resolved');
  target.querySelectorAll('.appr-btn').forEach((b) => { b.disabled = true; });
  const resultEl = target.querySelector('.appr-result');
  if (resultEl) resultEl.textContent = decisionLabel(decision);
}

function finalizeChatRun(opts = {}) {
  if (!chatRun || chatRun.finalized) return;
  const session = sessions.find((s) => s.id === chatRun.sessionId) || activeSession();
  if (!session) {
    chatRun.finalized = true;
    chatRun = null;
    return;
  }
  let content = opts.content;
  if (content == null || content === '') content = chatRun.contentFinal;
  if (content == null || content === '') content = chatRun.textBuffer;
  if (content == null) content = '';

  const aborted = opts.aborted || chatRun.aborted;
  const error = opts.error || chatRun.error;
  if (aborted && !String(content).trim()) {
    content = '⏹ 已停止生成。已完成的文件改动会保留，可继续发送新消息。';
  } else if (error && !String(content).trim()) {
    content = '请求失败：\n' + (opts.errorMessage || '未知错误');
  }

  if (chatRun.streamEl) {
    chatRun.streamEl.classList.remove('is-streaming');
    chatRun.streamEl.classList.add('is-final');
    chatRun.streamEl.innerHTML = renderMarkdownLite(content);
  }
  disableApprovalCards(chatRun.el);

  const fileChanges = Array.isArray(chatRun.fileChanges) && chatRun.fileChanges.length
    ? chatRun.fileChanges.slice()
    : undefined;
  session.messages.push({
    role: 'assistant',
    content,
    error: Boolean(error && !aborted),
    ...(fileChanges ? { fileChanges } : {}),
  });
  session.updatedAt = Date.now();
  chatRun.finalized = true;
  const applied = opts.applied || chatRun.applied;
  if (applied?.length) {
    toast('已应用 ' + applied.filter((a) => a.ok).length + '/' + applied.length + ' 个文件变更');
  }
  chatRun = null;
  saveState();
  renderMessages();
}

function mcpTaskStatusText(status) {
  return ({ working: '执行中', input_required: '等待输入', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || String(status || '未知');
}

function mcpTaskDispositionText(disposition) {
  return ({ orphaned: '已孤立', abandoned: '已遗弃', claimed: '已认领' })[disposition] || '';
}

function renderInlineMcpTasks() {
  const items = [...mcpTaskState.values()].slice(0, 6);
  if (!items.length) return '';
  return '<div class="mcp-inline-tasks">' + items.map((task) => '<div class="mcp-inline-task" data-task-ref="' + escapeHtml(task.taskRef) + '"><span class="mcp-inline-task-title">后台任务 · ' + escapeHtml(task.server || '') + (task.tool ? '/' + escapeHtml(task.tool) : '') + '</span><span class="mcp-inline-task-status">' + escapeHtml(mcpTaskStatusText(task.status)) + '</span></div>').join('') + '</div>';
}

function renderMcpTaskCenter() {
  const body = document.getElementById('engineering-mcp-tasks') || document.getElementById('work-body');
  if (!body) return;
  const tasks = [...mcpTaskState.values()].sort((a, b) => String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || '')));
  if (!tasks.length) {
    body.innerHTML = '<div class="work-empty">暂无 MCP 后台任务</div>';
    return;
  }
  body.innerHTML = '<div class="mcp-task-list">' + tasks.map((task) => {
    const ref = escapeHtml(task.taskRef);
    const title = escapeHtml([task.server, task.tool].filter(Boolean).join(' / ') || task.kind || 'MCP 任务');
    const error = task.statusMessage ? '<div class="work-card-error">' + escapeHtml(task.statusMessage) + '</div>' : '';
    const notices = [
      task.localDisposition === 'orphaned'
        ? '<div class="work-card-notice">远端状态可能已变化，确认结果后才能认领。</div>'
        : '',
      task.needsRecovery
        ? '<div class="work-card-notice">正在等待恢复连接，当前状态不确定。</div>'
        : '',
      task.resultTruncated
        ? '<div class="work-card-notice">保存的任务结果已截断。</div>'
        : '',
    ].join('');
    const actions = (task.canCancel ? '<button type="button" class="ghost-btn" data-mcp-task-cancel="' + ref + '">取消</button>' : '')
      + (task.canAbandon ? '<button type="button" class="ghost-btn" data-mcp-task-abandon="' + ref + '">遗弃引用</button>' : '')
      + (task.status === 'completed' && task.canClaim ? '<button type="button" class="ghost-btn" data-mcp-task-view="' + ref + '">查看结果</button><button type="button" class="ghost-btn" data-mcp-task-claim="' + ref + '">认领到当前会话</button>' : '');
    const disposition = mcpTaskDispositionText(task.localDisposition);
    return '<div class="work-card mcp-task-card"><div class="work-card-title">' + title + '</div><div class="work-card-meta"><code>' + ref + '</code> · <span class="badge ' + escapeHtml(task.status || '') + '">' + escapeHtml(mcpTaskStatusText(task.status)) + '</span>' + (disposition ? ' · <span class="badge local-disposition">' + escapeHtml(disposition) + '</span>' : '') + ' · ' + escapeHtml(task.lastUpdatedAt || '') + '</div>' + error + notices + '<div class="work-card-actions">' + actions + '</div></div>';
  }).join('') + '</div>';
  body.querySelectorAll('[data-mcp-task-cancel]').forEach((button) => button.addEventListener('click', async () => {
    if (!(await appConfirm('确定取消这个 MCP 后台任务？'))) return;
    const result = await window.codex.cancelMcpTask({ taskRef: button.dataset.mcpTaskCancel });
    if (!result?.ok) toast(result?.error || '取消失败');
  }));
  body.querySelectorAll('[data-mcp-task-abandon]').forEach((button) => button.addEventListener('click', async () => {
    if (!(await appConfirm('遗弃只会停止本地监控，不会取消远端任务。继续？'))) return;
    const result = await window.codex.abandonMcpTask({ taskRef: button.dataset.mcpTaskAbandon });
    if (!result?.ok) toast(result?.error || '遗弃失败');
  }));
  body.querySelectorAll('[data-mcp-task-view]').forEach((button) => button.addEventListener('click', () => viewMcpTaskResult(button.dataset.mcpTaskView)));
  body.querySelectorAll('[data-mcp-task-claim]').forEach((button) => button.addEventListener('click', () => claimMcpTask(button.dataset.mcpTaskClaim)));
}

function engineeringBindingToken() {
  const project = sessionProject();
  return project?.id ? (worktreeBindings.get(project.id) || '') : '';
}

// 'stale' carries a different meaning per domain: an index needs rebuilding,
// while a job ran against a工作树 that changed underneath it. Keeping one map
// would silently drop the first definition.
const INDEX_STATE_LABELS = {
  idle: '未建立', building: '建立中', ready: '就绪', stale: '需要刷新', error: '错误',
};
const JOB_STATUS_LABELS = {
  queued: '排队中', running: '运行中', passed: '通过', failed: '失败', timed_out: '超时',
  cancelled: '已取消', interrupted: '已中断', stale: '结果过期', configuration_changed: '配置已变化', skipped: '已跳过', error: '错误',
};

function engineeringIndexStateText(state) {
  const key = String(state || '');
  return INDEX_STATE_LABELS[key] || key || '未知';
}

function engineeringStatusText(status) {
  const key = String(status || '');
  return JOB_STATUS_LABELS[key] || key || '未知';
}

async function engineeringLocate(token, item) {
  const response = await window.codex.engineeringIndexLocation({
    projectBindingId: token,
    path: item.path,
    line: item.line,
    column: item.column,
    context: 3,
  }).catch(() => null);
  if (!response?.ok) return toast(response?.error || '无法定位文件');
  await appAlert(response.content || '没有可显示的定位内容', `${response.path}:${response.line}:${response.column}`);
}

async function copyEngineeringSummary(token, jobRef) {
  const response = await window.codex.getVerificationResult({ projectBindingId: token, jobRef }).catch(() => null);
  if (!response?.ok || !response.job) return toast(response?.error || '结果不可用');
  const job = response.job;
  const lines = [
    `验证档案: ${job.profileName || job.profileId || ''}`,
    `状态: ${engineeringStatusText(job.status)}`,
    Number.isFinite(job.exitCode) ? `退出码: ${job.exitCode}` : '',
    `诊断: ${job.diagnostics?.length || 0}`,
    job.statusMessage || '',
  ].filter(Boolean);
  const summary = lines.join('\n').slice(0, 4000);
  try {
    await navigator.clipboard.writeText(summary);
    toast('已复制脱敏摘要');
  } catch {
    await appAlert(summary, '脱敏验证摘要');
  }
}

async function showEngineeringJobResult(token, jobRef, detailId = 'engineering-job-detail') {
  const detail = document.getElementById(detailId);
  if (!detail) return;
  const response = await window.codex.getVerificationResult({ projectBindingId: token, jobRef }).catch(() => null);
  if (!response?.ok || !response.job) {
    detail.innerHTML = `<div class="work-card-error">${escapeHtml(response?.error || '结果不可用')}</div>`;
    return;
  }
  const job = response.job;
  const diagnostics = Array.isArray(job.diagnostics) ? job.diagnostics : [];
  detail.innerHTML = [
    `<div class="engineering-detail-title">${escapeHtml(job.profileName || job.profileId || '验证结果')} · ${escapeHtml(engineeringStatusText(job.status))}</div>`,
    job.statusMessage ? `<div class="work-card-notice">${escapeHtml(job.statusMessage)}</div>` : '',
    job.outputTruncated ? '<div class="work-card-notice">标准输出或错误输出已截断。</div>' : '',
    job.diagnosticsTruncated ? '<div class="work-card-notice">诊断数量已达到上限。</div>' : '',
    `<div class="engineering-detail-actions"><button type="button" class="ghost-btn" id="engineering-copy-summary">复制脱敏摘要</button><button type="button" class="ghost-btn" id="engineering-close-detail">关闭</button></div>`,
    diagnostics.length ? `<div class="engineering-diagnostics">${diagnostics.map((item, index) => `<button type="button" class="engineering-diagnostic" data-engineering-diagnostic="${index}"><code>${escapeHtml(item.path)}:${item.line}:${item.column}</code><span class="badge ${escapeHtml(item.severity || '')}">${escapeHtml(item.severity || 'error')}</span><span>${escapeHtml(item.message || '')}</span></button>`).join('')}</div>` : '<div class="work-empty">没有解析到诊断。</div>',
    job.stdout ? `<details><summary>标准输出</summary><pre>${escapeHtml(job.stdout)}</pre></details>` : '',
    job.stderr ? `<details><summary>错误输出</summary><pre>${escapeHtml(job.stderr)}</pre></details>` : '',
  ].join('');
  detail.classList.remove('hidden');
  document.getElementById('engineering-copy-summary')?.addEventListener('click', () => copyEngineeringSummary(token, jobRef));
  document.getElementById('engineering-close-detail')?.addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
  });
  detail.querySelectorAll('[data-engineering-diagnostic]').forEach((button) => button.addEventListener('click', () => {
    const item = diagnostics[Number(button.dataset.engineeringDiagnostic)];
    if (item) engineeringLocate(token, item);
  }));
}

async function loadEngineeringProfiles(token) {
  const profilesEl = document.getElementById('engineering-profiles');
  if (!profilesEl) return;
  const response = await window.codex.listVerificationProfiles({ projectBindingId: token }).catch(() => null);
  const profiles = response?.profiles || [];
  const candidates = response?.candidates || [];
  const profileRows = profiles.map((profile) => {
    const id = escapeHtml(profile.id);
    const command = profile.command ? `<code>${escapeHtml(profile.command)}</code>` : '<span class="work-card-meta">命令未返回</span>';
    return `<div class="engineering-profile"><div class="engineering-profile-main"><strong>${escapeHtml(profile.name)}</strong><span class="badge">${escapeHtml(profile.kind)}</span><span class="badge ${profile.enabled === false ? 'disabled' : 'ready'}">${profile.enabled === false ? '已禁用' : '已启用'}</span><div class="engineering-profile-meta">${command} · cwd ${escapeHtml(profile.cwd || '.')} · ${Math.round(Number(profile.timeoutMs || 0) / 1000)} 秒</div></div><div class="work-card-actions"><button type="button" class="ghost-btn" data-vfy-run="${id}" ${profile.enabled === false ? 'disabled' : ''}>运行</button><button type="button" class="ghost-btn" data-vfy-toggle="${id}">${profile.enabled === false ? '启用' : '禁用'}</button><button type="button" class="ghost-btn" data-vfy-edit="${id}">编辑</button><button type="button" class="ghost-btn" data-vfy-revoke="${id}">撤销授权</button><button type="button" class="ghost-btn" data-vfy-delete="${id}">删除</button></div></div>`;
  }).join('');
  const candidateRows = candidates.map((candidate, index) => `<div class="engineering-profile engineering-candidate"><div class="engineering-profile-main"><strong>${escapeHtml(candidate.name || candidate.command)}</strong><span class="badge">${escapeHtml(candidate.kind || 'custom')}</span><div class="engineering-profile-meta"><code>${escapeHtml(candidate.command || '')}</code> · cwd ${escapeHtml(candidate.cwd || '.')}</div></div><button type="button" class="ghost-btn" data-vfy-candidate="${index}">保存</button></div>`).join('');
  profilesEl.innerHTML = `<div class="work-card-actions"><button type="button" class="ghost-btn" id="engineering-profile-new">新建档案</button></div>${profileRows || '<div class="work-empty">暂无已保存验证档案</div>'}${candidateRows ? `<div class="work-card-meta engineering-candidate-title">自动探测候选（不会自动执行）</div>${candidateRows}` : ''}`;
  const findProfile = (id) => profiles.find((item) => item.id === id);
  const saveProfile = async (profile) => {
    const result = await window.codex.saveVerificationProfile({ projectBindingId: token, profile }).catch(() => null);
    if (!result?.ok) return toast(result?.error || '保存验证档案失败');
    await loadEngineeringProfiles(token);
  };
  profilesEl.querySelectorAll('[data-vfy-run]').forEach((button) => button.addEventListener('click', async () => {
    const result = await window.codex.runVerification({ projectBindingId: token, profileId: button.dataset.vfyRun, sessionId: activeSessionId });
    if (!result?.ok) return toast(result?.error || '启动验证失败');
    toast('验证已加入后台队列');
    await loadEngineeringJobs(token);
  }));
  profilesEl.querySelectorAll('[data-vfy-toggle]').forEach((button) => button.addEventListener('click', () => {
    const current = findProfile(button.dataset.vfyToggle);
    if (current) saveProfile({ ...current, enabled: current.enabled === false });
  }));
  profilesEl.querySelectorAll('[data-vfy-revoke]').forEach((button) => button.addEventListener('click', async () => {
    const current = findProfile(button.dataset.vfyRevoke);
    if (!current || !(await appConfirm(`撤销「${current.name}」的验证授权？下次运行需要重新审批。`))) return;
    const result = await window.codex.revokeVerificationGrant({ projectBindingId: token, profileId: current.id }).catch(() => null);
    if (!result?.ok) return toast(result?.error || '撤销授权失败');
    toast('已撤销该档案授权');
  }));
  profilesEl.querySelectorAll('[data-vfy-delete]').forEach((button) => button.addEventListener('click', async () => {
    const current = findProfile(button.dataset.vfyDelete);
    if (!current || !(await appConfirm(`确定删除验证档案「${current.name}」？`))) return;
    const result = await window.codex.deleteVerificationProfile({ projectBindingId: token, profileId: current.id });
    if (!result?.ok) return toast(result?.error || '删除验证档案失败');
    await loadEngineeringProfiles(token);
  }));
  profilesEl.querySelectorAll('[data-vfy-edit]').forEach((button) => button.addEventListener('click', async () => {
    const current = findProfile(button.dataset.vfyEdit);
    if (!current) return;
    const name = await appPrompt('档案名称', current.name, '编辑验证档案'); if (name == null) return;
    const command = await appPrompt('验证命令', current.command || '', '编辑验证档案'); if (command == null) return;
    const cwd = await appPrompt('项目内 cwd', current.cwd || '.', '编辑验证档案'); if (cwd == null) return;
    const timeout = await appPrompt('超时毫秒数（5000-900000）', String(current.timeoutMs || 60000), '编辑验证档案'); if (timeout == null) return;
    await saveProfile({ ...current, name, command, cwd, timeoutMs: Number(timeout) });
  }));
  profilesEl.querySelectorAll('[data-vfy-candidate]').forEach((button) => button.addEventListener('click', () => {
    const candidate = candidates[Number(button.dataset.vfyCandidate)];
    if (candidate) saveProfile(candidate);
  }));
  document.getElementById('engineering-profile-new')?.addEventListener('click', async () => {
    const name = await appPrompt('档案名称', '', '新建验证档案'); if (!name) return;
    const command = await appPrompt('验证命令', '', '新建验证档案'); if (!command) return;
    const cwd = await appPrompt('项目内 cwd', '.', '新建验证档案'); if (cwd == null) return;
    await saveProfile({ name, command, cwd, kind: 'custom', timeoutMs: 60000, enabled: true });
  });
}

async function refreshEngineeringIndexStatus(token = engineeringBindingToken()) {
  const statusEl = document.getElementById('engineering-index-status');
  if (!statusEl || !token) return;
  const status = await window.codex.engineeringIndexEnsure({ projectBindingId: token }).catch(() => null);
  if (!status?.ok) {
    statusEl.textContent = status?.error || '索引不可用';
    return;
  }
  const counts = status.counts || {};
  statusEl.textContent = [
    engineeringIndexStateText(status?.state),
    `文件 ${status.files ?? counts.files ?? 0}`,
    `符号 ${status.symbols ?? counts.symbols ?? 0}`,
    `词项 ${status.terms ?? counts.terms ?? 0}`,
    status.truncated ? '已截断' : '',
    status.lastUpdatedAt ? `更新于 ${status.lastUpdatedAt}` : '',
  ].filter(Boolean).join(' · ');
}

async function renderEngineeringCenter() {
  const body = document.getElementById('work-body');
  const token = engineeringBindingToken();
  if (!body) return;
  if (!token) {
    body.innerHTML = '<div class="work-empty">请先绑定项目目录后使用工程中心。</div>';
    return;
  }
  const settings = await window.codex.getSettings().catch(() => null);
  const terminalNotice = settings && !settings.terminalEnabled
    ? '<div class="work-card-notice">验证作业需要在设置中开启「允许终端命令」后才能启动。</div>'
    : '';
  body.innerHTML = '<section class="engineering-section"><div class="work-card-title">代码索引</div><div id="engineering-index-status" class="work-card-meta">读取中…</div><div class="work-card-meta">词法索引只提供近似定位，不做语义解析。</div><div class="work-card-actions"><button type="button" class="ghost-btn" id="engineering-index-rebuild">重建</button><button type="button" class="ghost-btn" id="engineering-index-clear">清除</button></div><div class="engineering-search"><select id="engineering-search-mode"><option value="definitions">定义</option><option value="references">引用</option><option value="text">文本</option></select><input id="engineering-search-query" type="search" maxlength="256" placeholder="搜索符号或文本" /><button type="button" class="ghost-btn" id="engineering-search-run">搜索</button></div><div id="engineering-search-results"></div></section><section class="engineering-section"><div class="work-card-title">验证档案</div>' + terminalNotice + '<div id="engineering-approval" class="engineering-job-detail hidden"></div><div id="engineering-profiles">读取中…</div></section><section class="engineering-section"><div class="work-card-title">工程工作流</div><div id="engineering-workflows">读取中…</div><div id="engineering-workflow-runs">读取中…</div><div id="engineering-workflow-detail" class="engineering-job-detail hidden"></div></section><section class="engineering-section"><div class="work-card-title">验证作业</div><div id="engineering-jobs">读取中…</div><div id="engineering-job-detail" class="engineering-job-detail hidden"></div></section><section class="engineering-section"><div class="work-card-title">MCP Tasks</div><div id="engineering-mcp-tasks"></div></section>';
  if (engineeringPendingApproval) renderEngineeringApprovalCard(engineeringPendingApproval);
  const refresh = () => refreshEngineeringIndexStatus(token);
  document.getElementById('engineering-index-rebuild')?.addEventListener('click', async () => { const result = await window.codex.engineeringIndexRebuild({ projectBindingId: token }); if (!result?.ok) toast(result?.error || '索引重建失败'); await refresh(); });
  document.getElementById('engineering-index-clear')?.addEventListener('click', async () => { const result = await window.codex.engineeringIndexClear({ projectBindingId: token }); if (!result?.ok) toast(result?.error || '索引清除失败'); await refresh(); });
  document.getElementById('engineering-search-run')?.addEventListener('click', async () => {
    const query = document.getElementById('engineering-search-query')?.value || ''; const mode = document.getElementById('engineering-search-mode')?.value || 'text';
    const response = await window.codex.engineeringIndexSearch({ projectBindingId: token, mode, query, maxResults: 100 }).catch(() => null); const resultEl = document.getElementById('engineering-search-results');
    if (!resultEl) return; resultEl.innerHTML = response?.ok ? (response.results || []).map((r, index) => `<button type="button" class="engineering-result" data-engineering-result="${index}"><code>${escapeHtml(r.path)}:${r.line}:${r.column}</code> <span>${escapeHtml(r.name || '')}</span><div>${escapeHtml(r.snippet || '')}</div></button>`).join('') || '<div class="work-empty">无匹配</div>' : `<div class="work-card-error">${escapeHtml(response?.error || '搜索失败')}</div>`;
    resultEl.querySelectorAll('[data-engineering-result]').forEach((button) => button.addEventListener('click', () => {
      const item = response?.results?.[Number(button.dataset.engineeringResult)];
      if (item) engineeringLocate(token, item);
    }));
    if (response?.truncated) resultEl.insertAdjacentHTML('afterbegin', '<div class="work-card-notice">结果已按上限截断。</div>');
  });
  document.getElementById('engineering-search-query')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') document.getElementById('engineering-search-run')?.click(); });
  await refresh();
  await loadEngineeringProfiles(token);
  await loadEngineeringWorkflows(token);
  await loadEngineeringJobs(token);
  renderMcpTaskCenter();
}

async function loadEngineeringJobs(token = engineeringBindingToken()) {
  const el = document.getElementById('engineering-jobs'); if (!el || !token) return; const response = await window.codex.listVerificationJobs({ projectBindingId: token, limit: 50 }).catch(() => null); const jobs = response?.jobs || [];
  el.innerHTML = jobs.length ? jobs.map((j) => {
    const active = j.status === 'running' || j.status === 'queued';
    const notices = [j.status === 'stale' ? '工作区在验证期间发生变化' : '', j.status === 'interrupted' ? '应用退出时未完成' : '', j.outputTruncated ? '输出已截断' : '', j.diagnosticsTruncated ? '诊断已截断' : '', j.diagnosticCount ? `诊断 ${j.diagnosticCount} 条` : ''].filter(Boolean).join(' · ');
    return `<div class="engineering-job"><div class="engineering-profile-main"><strong>${escapeHtml(j.profileName || j.profileId || '验证')}</strong><div class="work-card-meta"><code>${escapeHtml(j.jobRef)}</code> · <span class="badge ${escapeHtml(j.status || '')}">${escapeHtml(engineeringStatusText(j.status))}</span>${Number.isFinite(j.exitCode) ? ` · 退出码 ${j.exitCode}` : ''} · ${escapeHtml(j.finishedAt || j.startedAt || j.createdAt || '')}</div>${notices ? `<div class="work-card-notice">${escapeHtml(notices)}</div>` : ''}</div><div class="work-card-actions">${active ? `<button type="button" class="ghost-btn" data-vfy-cancel="${escapeHtml(j.jobRef)}">取消</button>` : `<button type="button" class="ghost-btn" data-vfy-view="${escapeHtml(j.jobRef)}">查看结果</button><button type="button" class="ghost-btn" data-vfy-copy="${escapeHtml(j.jobRef)}">复制摘要</button><button type="button" class="ghost-btn" data-vfy-rerun="${escapeHtml(j.jobRef)}">重跑</button>`}</div></div>`;
  }).join('') : '<div class="work-empty">暂无验证作业</div>';
  el.querySelectorAll('[data-vfy-cancel]').forEach((button) => button.addEventListener('click', async () => { const result = await window.codex.cancelVerification({ projectBindingId: token, jobRef: button.dataset.vfyCancel }); if (!result?.ok) toast(result?.error || '取消失败'); await loadEngineeringJobs(token); }));
  el.querySelectorAll('[data-vfy-rerun]').forEach((button) => button.addEventListener('click', async () => { const result = await window.codex.rerunVerification({ projectBindingId: token, jobRef: button.dataset.vfyRerun }); if (!result?.ok) toast(result?.error || '重跑失败'); else toast('验证已重新排队'); await loadEngineeringJobs(token); }));
  el.querySelectorAll('[data-vfy-view]').forEach((button) => button.addEventListener('click', () => showEngineeringJobResult(token, button.dataset.vfyView)));
  el.querySelectorAll('[data-vfy-copy]').forEach((button) => button.addEventListener('click', () => copyEngineeringSummary(token, button.dataset.vfyCopy)));
}

async function loadMcpTasks() {
  if (!window.codex?.listMcpTasks) return;
  const response = await window.codex.listMcpTasks({ limit: 500 }).catch(() => null);
  if (response?.ok && Array.isArray(response.tasks)) {
    mcpTaskState.clear();
    response.tasks.forEach((task) => mcpTaskState.set(task.taskRef, task));
  }
  if (currentView === 'scheduled') renderMcpTaskCenter();
  renderMessages();
}

async function viewMcpTaskResult(taskRef) {
  const response = await window.codex.getMcpTaskResult({ taskRef });
  if (!response?.ok) return toast(response?.error || '任务结果不可用');
  let text;
  try { text = typeof response.result === 'string' ? response.result : JSON.stringify(response.result, null, 2); } catch { text = ''; }
  const truncated = mcpTaskState.get(taskRef)?.resultTruncated === true;
  toast((truncated ? '结果已截断：\n' : '') + (text.slice(0, 3000) || '任务没有可显示结果'), 6000);
}

async function claimMcpTask(taskRef) {
  const target = activeSession();
  if (!target?.id) return toast('当前没有可用会话');
  const prepared = await window.codex.prepareMcpTaskResult({ taskRef, targetSessionId: target.id });
  if (!prepared?.ok) return toast(prepared?.error || '无法准备认领');
  let preview;
  try { preview = typeof prepared.preview === 'string' ? prepared.preview : JSON.stringify(prepared.preview, null, 2); } catch { preview = ''; }
  if (!(await appConfirm('确认将任务结果作为新消息发送到当前会话？\n\n' + String(preview || '').slice(0, 1200)))) return;
  const committed = await window.codex.commitMcpTaskResult({ claimId: prepared.claimId, targetSessionId: target.id });
  if (!committed?.ok) return toast(committed?.error || '认领失败');
  let content;
  try { content = typeof committed.result === 'string' ? committed.result : JSON.stringify(committed.result, null, 2); } catch { content = ''; }
  target.messages.push({ role: 'assistant', content: 'MCP 后台任务结果：\n\n' + String(content || '').slice(0, 65536) });
  target.updatedAt = Date.now();
  saveState();
  renderMessages();
  toast('任务结果已发送到当前会话');
}

function closeMcpElicitationModal() {
  if (mcpElicitationModal) mcpElicitationModal.remove();
  mcpElicitationModal = null;
}

function showMcpElicitation(request) {
  closeMcpElicitationModal();
  const modal = document.createElement('div');
  modal.className = 'modal mcp-elicitation-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const fields = request.mode === 'form' ? (request.schema?.fields || []).map((field) => {
    const required = request.schema?.required?.includes(field.name) ? ' required' : '';
    const label = '<span>' + escapeHtml(field.title || field.name) + (required ? ' *' : '') + '</span>';
    if (Array.isArray(field.enum)) return '<label class="field">' + label + '<select data-mcp-field="' + escapeHtml(field.name) + '"' + required + '>' + field.enum.map((value) => '<option value="' + escapeHtml(String(value)) + '"' + (Object.is(value, field.default) ? ' selected' : '') + '>' + escapeHtml(String(value)) + '</option>').join('') + '</select></label>';
    if (field.type === 'boolean') return '<label class="switch-row"><input type="checkbox" data-mcp-field="' + escapeHtml(field.name) + '"' + (field.default === true ? ' checked' : '') + ' /><span>' + escapeHtml(field.title || field.name) + (required ? ' *' : '') + '</span></label>';
    const type = field.type === 'number' || field.type === 'integer' ? 'number' : 'text';
    const constraints = (field.minLength != null ? ' minlength="' + field.minLength + '"' : '') + (field.maxLength != null ? ' maxlength="' + field.maxLength + '"' : '') + (field.minimum != null ? ' min="' + field.minimum + '"' : '') + (field.maximum != null ? ' max="' + field.maximum + '"' : '');
    const defaultValue = field.default === undefined ? '' : ' value="' + escapeHtml(String(field.default)) + '"';
    return '<label class="field">' + label + '<input type="' + type + '" data-mcp-field="' + escapeHtml(field.name) + '"' + required + constraints + defaultValue + ' /><small class="field-hint">' + escapeHtml(field.description || '') + '</small></label>';
  }).join('') : '<div class="mcp-url-box"><div class="field-hint">将使用系统浏览器打开：</div><code>' + escapeHtml(request.url || '') + '</code></div>';
  modal.innerHTML = '<div class="modal-card"><div class="modal-title">' + escapeHtml(request.title || 'MCP 请求输入') + '</div><div class="mcp-elicitation-server">' + escapeHtml(request.server || '') + '</div><p class="mcp-elicitation-message">' + escapeHtml(request.message || '') + '</p>' + fields + '<div class="modal-actions"><button type="button" class="btn-secondary" data-mcp-elicit="cancel">取消</button>' + (request.mode === 'url' ? '<button type="button" class="btn-secondary" data-mcp-elicit="open">打开浏览器</button>' : '') + '<button type="button" class="btn-secondary" data-mcp-elicit="decline">拒绝</button><button type="button" class="btn-primary" data-mcp-elicit="accept">同意</button></div></div>';
  document.body.appendChild(modal);
  mcpElicitationModal = modal;
  const send = async (action) => {
    let content;
    if (action === 'accept' && request.mode === 'form') {
      content = {};
      modal.querySelectorAll('[data-mcp-field]').forEach((input) => {
        if (input.type === 'checkbox') content[input.dataset.mcpField] = input.checked;
        else if (input.value !== '') content[input.dataset.mcpField] = input.type === 'number' ? Number(input.value) : input.value;
      });
    }
    if (action === 'open') {
      const opened = await window.codex.openMcpElicitationUrl({ elicitationId: request.elicitationId });
      if (!opened?.ok) toast(opened?.error || '无法打开浏览器');
      return;
    }
    const response = await window.codex.respondMcpElicitation({ elicitationId: request.elicitationId, action, content });
    if (!response?.ok) return toast(response?.error || '响应失败');
    closeMcpElicitationModal();
  };
  modal.querySelectorAll('[data-mcp-elicit]').forEach((button) => button.addEventListener('click', () => send(button.dataset.mcpElicit).catch((error) => toast(error?.message || '响应失败'))));
}

function handleWorktreeEvent(ev) {
  if (!ev || !ev.result) return;
  const sessionId = String(ev.sessionId || ev.result.sessionId || '');
  const projectId = sessionId
    ? sessions.find((item) => item.id === sessionId)?.projectId
    : sessionProject()?.id;
  if (!projectId) return;
  attachWorktreeResult(ev.result, projectId, sessionId);
  const project = getProject(projectId);
  if (project?.path) reconcileWorktreeResults(project);
  if (activeSession()?.projectId === projectId) renderMessages();
}

function handleChatEvent(ev) {
  if (!ev) return;
  // Terminal panel events (agent + manual) always go to the shared panel.
  // Manual approvals may also land here without an active chatRun.
  if (handleTerminalPanelEvent(ev)) return;

  if (ev.type === 'worktree-ready' || ev.type === 'worktree-state' || ev.type === 'worktree-recovered') {
    handleWorktreeEvent(ev);
    return;
  }

  if (!chatRun || chatRun.finalized) return;
  // Route by active run once runId is known; accept first event to bind runId
  if (chatRun.runId && ev.runId && chatRun.runId !== ev.runId) return;
  if (chatRun.sessionId !== activeSessionId && chatRun.sessionId !== activeSession()?.id) {
    // still process if run belongs to its session; allow background finalize
  }

  const type = ev.type;
  if (type === 'run-start') {
    if (ev.runId) {
      chatRun.runId = ev.runId;
      chatRun.el.dataset.runId = ev.runId;
    }
    setRunStatus('生成中…');
    return;
  }
  if (type === 'text-delta') {
    const piece = ev.text != null ? String(ev.text) : (ev.delta != null ? String(ev.delta) : '');
    chatRun.textBuffer += piece;
    updateStreamBody();
    return;
  }
  if (type === 'tool-start') {
    if (ev.subagent && ev.subagentId && chatRun?.subagentBlocks?.get(ev.subagentId)) {
      return;
    }
    const sum = toolArgsSummary(ev.tool, ev.args);
    appendTimelineRow('start', ev.tool, sum || '运行中…');
    setRunStatus('工具：' + (ev.tool || ''));
    return;
  }
  if (type === 'tool-end') {
    if (ev.subagent && ev.subagentId && chatRun?.subagentBlocks?.get(ev.subagentId)) {
      const rec = chatRun.subagentBlocks.get(ev.subagentId);
      const line = document.createElement('div');
      line.className = 'sa-tool';
      line.textContent = '· ' + (ev.name || ev.tool || '?') + ' ' + (ev.ok === false ? '失败' : 'ok');
      rec.toolsEl.appendChild(line);
      return;
    }
    appendTimelineRow('end', ev.tool, ev.summary || (ev.ok === false ? '失败' : '完成'), ev.ok !== false);
    return;
  }
  if (type === 'approval-needed') {
    renderApprovalCard(ev);
    setRunStatus('等待确认…');
    return;
  }
  if (type === 'approval-resolved') {
    markApprovalResolved(ev.approvalId, ev.decision);
    setRunStatus('生成中…');
    return;
  }
  if (type === 'file-change') {
    if (!Array.isArray(chatRun.fileChanges)) chatRun.fileChanges = [];
    mergeFileChangeEntry(chatRun.fileChanges, {
      path: ev.path,
      op: ev.op,
      stats: ev.stats,
    });
    return;
  }
  if (type === 'plan-ready') {
    renderPlanCard(ev);
    setRunStatus('计划已提交，等待批准…');
    return;
  }
  if (type === 'plan-approved') {
    setRunStatus('计划已批准，执行中…');
    return;
  }
  if (type === 'plan-rejected') {
    setRunStatus('');
    return;
  }
  if (type === 'verify-result') {
    renderVerifyStrip(ev);
    return;
  }
  if (type === 'subagent-start') {
    ensureSubagentBlock(ev);
    setRunStatus('子 Agent (' + (ev.kind || 'explore') + '): ' + String(ev.goal || '').slice(0, 60));
    return;
  }
  if (type === 'subagent-end') {
    const rec = ensureSubagentBlock(ev);
    if (rec) {
      rec.statusEl.className = 'sa-status ' + (ev.ok ? 'is-ok' : 'is-fail');
      const ms = ev.durationMs != null ? ' · ' + (ev.durationMs / 1000).toFixed(1) + 's' : '';
      const writes = ev.fileChangeCount ? ' · 写入 ' + ev.fileChangeCount + ' 个文件' : '';
      rec.statusEl.textContent = (ev.ok ? '成功' : ('失败: ' + (ev.error || ''))) + ms + writes;
      if (ev.summary) rec.summaryEl.textContent = String(ev.summary).slice(0, 4000);
    }
    setRunStatus(ev.ok ? '子 Agent 完成' : ('子 Agent 失败: ' + (ev.error || '')));
    return;
  }
  if (type === 'hook-start') {
    const label = (ev.event || '') + (ev.toolName ? ' · ' + ev.toolName : '');
    appendTimelineRow('start', '🪝 钩子', (label ? label + ' ' : '') + '开始');
    return;
  }
  if (type === 'hook-end') {
    const bit = ev.ok === false
      ? '失败'
      : (ev.decision === 'deny'
        ? '拒绝'
        : (ev.decision === 'skip' || ev.skipped ? '短路' : '完成'));
    const ok = ev.ok !== false && ev.decision !== 'deny';
    appendTimelineRow(
      'end',
      '🪝 钩子',
      (ev.event ? ev.event + ' ' : '') + bit + (ev.reason ? '：' + ev.reason : ''),
      ok
    );
    return;
  }
  if (type === 'usage') {
    const session = sessions.find((item) => item.id === ev.sessionId)
      || sessions.find((item) => item.id === chatRun?.sessionId);
    if (session) {
      applyUsageToSession(session, ev);
      saveState();
      if (session.id === activeSessionId) {
        renderUsageBar();
        renderContextMeter();
      }
    }
    return;
  }
  if (type === 'turn-end') {
    return;
  }
  if (type === 'done') {
    chatRun.doneEvent = true;
    if (ev.content != null) chatRun.contentFinal = String(ev.content);
    if (ev.applied) chatRun.applied = ev.applied;
    if (!Array.isArray(chatRun.fileChanges)) chatRun.fileChanges = [];
    if (Array.isArray(ev.fileChanges) && ev.fileChanges.length) {
      for (const fc of ev.fileChanges) mergeFileChangeEntry(chatRun.fileChanges, fc);
    }
    if (chatRun.fileChanges.length) {
      renderFileChangesStrip();
    }
    if (chatRun.streamEl) {
      chatRun.streamEl.classList.remove('is-streaming');
      if (chatRun.contentFinal != null) {
        chatRun.streamEl.classList.add('is-final');
        chatRun.streamEl.innerHTML = renderMarkdownLite(chatRun.contentFinal);
      }
    }
    setRunStatus('');
    // Finalize when invoke also settled (or if invoke already done)
    if (chatRun.invokeDone) {
      finalizeChatRun({ content: chatRun.contentFinal, applied: chatRun.applied });
      setSending(false);
    }
    return;
  }
  if (type === 'aborted') {
    chatRun.aborted = true;
    chatRun.doneEvent = true;
    disableApprovalCards(chatRun.el);
    setRunStatus('已停止', 'aborted');
    if (chatRun.streamEl) chatRun.streamEl.classList.remove('is-streaming');
    if (chatRun.invokeDone) {
      finalizeChatRun({ aborted: true, content: chatRun.contentFinal || chatRun.textBuffer });
      setSending(false);
    }
    return;
  }
  if (type === 'error') {
    chatRun.error = true;
    chatRun.doneEvent = true;
    const msg = ev.message || '未知错误';
    disableApprovalCards(chatRun.el);
    setRunStatus(msg, 'error');
    if (chatRun.streamEl) chatRun.streamEl.classList.remove('is-streaming');
    if (!chatRun.textBuffer && !chatRun.contentFinal) {
      chatRun.contentFinal = '请求失败：\n' + msg;
      if (chatRun.streamEl) {
        chatRun.streamEl.classList.add('is-final');
        chatRun.streamEl.innerHTML = renderMarkdownLite(chatRun.contentFinal);
      }
    }
    if (chatRun.invokeDone) {
      finalizeChatRun({ error: true, errorMessage: msg, content: chatRun.contentFinal || chatRun.textBuffer });
      setSending(false);
    }
    return;
  }
}
function scrollToBottom() { const list = document.getElementById('message-list'); if (list) list.scrollTop = list.scrollHeight; }
function matchQuery(text) { if (!searchQuery) return true; return String(text).toLowerCase().includes(searchQuery.toLowerCase()); }
function hideContextMenu() { if (ctxMenuEl) { ctxMenuEl.classList.add('hidden'); ctxMenuEl.innerHTML = ''; } }
function showContextMenu(x, y, items) {
  if (!ctxMenuEl) ctxMenuEl = document.getElementById('ctx-menu');
  ctxMenuEl.innerHTML = items.map((it, i) => it.sep ? '<div class="ctx-sep"></div>' : '<button type="button" class="ctx-item '+(it.danger?'danger':'')+'" data-idx="'+i+'">'+escapeHtml(it.label)+'</button>').join('');
  ctxMenuEl.classList.remove('hidden');
  let left = x, top = y;
  if (left + 180 > window.innerWidth - 6) left = window.innerWidth - 186;
  if (top + items.length * 30 > window.innerHeight - 6) top = window.innerHeight - items.length * 30 - 6;
  ctxMenuEl.style.left = Math.max(6, left) + 'px';
  ctxMenuEl.style.top = Math.max(6, top) + 'px';
  ctxMenuEl.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => { const item = items[Number(btn.dataset.idx)]; hideContextMenu(); if (item && item.onClick) item.onClick(); });
  });
}

function renderLeftDynamic() {
  const root = document.getElementById('left-dynamic');
  const pinnedProjects = projects.filter((p) => p.pinned && matchQuery(p.name));
  const normalProjects = projects.filter((p) => !p.pinned && matchQuery(p.name));
  const tasks = sessions.filter((s) => s.kind === 'task' && matchQuery(s.title)).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  const friends = sessions.filter((s) => s.kind === 'friend' && matchQuery(s.title));
  const projItem = (p) => {
    const bound = p.path ? '🔗' : '📁';
    const sel = activeSession()?.projectId === p.id && activeSession()?.kind === 'project' ? 'selected' : '';
    const pin = p.pinned ? '📌 ' : '';
    return '<li class="task-item '+sel+'" data-project-id="'+p.id+'" title="'+escapeHtml(p.path || '未绑定真实目录（右键可绑定）')+'">'+bound+' '+pin+escapeHtml(p.name)+'</li>';
  };
  root.innerHTML =
    '<div class="left-section"><div class="left-header">置顶项目</div><ul class="folder-list">'+(pinnedProjects.map(projItem).join('') || '<li class="muted">暂无置顶（右键项目可置顶）</li>')+'</ul></div>' +
    '<div class="left-section"><div class="left-header">项目 <button type="button" class="mini-btn" id="btn-add-project">+</button></div><ul class="folder-list">'+(normalProjects.map(projItem).join('') || '<li class="muted">暂无项目</li>')+'</ul></div>' +
    '<div class="left-section"><div class="left-header">任务 <button type="button" class="mini-btn" id="btn-left-new-task">+</button></div><ul class="folder-list">'+
    (tasks.map((s) => '<li class="task-item '+(s.id===activeSessionId?'selected':'')+'" data-session="'+s.id+'">💬 '+(s.pinned?'📌 ':'')+escapeHtml(s.title)+'</li>').join('') || '<li class="muted">暂无任务</li>')+
    '</ul></div><div class="left-section"><div class="left-header">最近会话</div><ul class="folder-list">'+
    (friends.map((s) => '<li class="task-item '+(s.id===activeSessionId?'selected':'')+'" data-session="'+s.id+'">👤 '+escapeHtml(s.title)+'</li>').join('') || '<li class="muted">无好友会话</li>')+
    '</ul></div>';

  root.querySelectorAll('[data-session]').forEach((el) => {
    el.addEventListener('click', () => { switchSession(el.getAttribute('data-session')); setView('chat'); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-session');
      const s = sessions.find((x) => x.id === id); if (!s) return;
      const items = [];
      if (s.kind === 'task') {
        items.push({ label: s.pinned ? '取消置顶' : '置顶任务', onClick: () => { s.pinned = !s.pinned; saveState(); renderLeftDynamic(); toast(s.pinned ? '已置顶任务' : '已取消置顶'); } });
        items.push({ sep: true });
        items.push({ label: '删除任务', danger: true, onClick: () => deleteSession(id) });
      } else if (s.kind === 'friend') {
        items.push({ label: '删除会话', danger: true, onClick: () => deleteSession(id) });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
  });
  root.querySelectorAll('[data-project-id]').forEach((el) => {
    el.addEventListener('click', () => openProjectChat(el.getAttribute('data-project-id')));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-project-id');
      const p = getProject(id); if (!p) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: p.pinned ? '取消置顶' : '置顶项目', onClick: () => { p.pinned = !p.pinned; saveState(); renderLeftDynamic(); toast(p.pinned ? '已置顶项目' : '已取消置顶'); } },
        { label: p.path ? '重新绑定目录…' : '绑定真实目录…', onClick: () => bindProjectPath(id) },
        { label: '在资源管理器中打开', onClick: async () => { if (!p.path) return toast('请先绑定真实目录'); try { await window.codex.openPath(p.path); } catch (err) { toast(err.message || String(err)); } } },
        { label: '重命名…', onClick: () => renameProject(id) },
        { sep: true },
        { label: '删除项目', danger: true, onClick: () => deleteProject(id) },
      ]);
    });
  });
  const addP = document.getElementById('btn-add-project');
  if (addP) addP.addEventListener('click', (e) => { e.stopPropagation(); openProjectModal(); });
  const nt = document.getElementById('btn-left-new-task');
  if (nt) nt.addEventListener('click', (e) => { e.stopPropagation(); openTaskModal(); });
}
async function deleteSession(id) {
  if (sessions.length <= 1) return toast('至少保留一个会话');
  const s = sessions.find((x) => x.id === id); if (!s) return;
  if (chatRun && !chatRun.finalized && chatRun.sessionId === id) {
    return toast('生成中无法删除该会话，请先停止');
  }
  if (!(await appConfirm('确定删除「' + s.title + '」？'))) return;
  sessions = sessions.filter((x) => x.id !== id);
  if (activeSessionId === id) activeSessionId = sessions[0].id;
  saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); toast('已删除');
}
async function deleteProject(id) {
  const p = getProject(id); if (!p) return;
  const running = chatRun && !chatRun.finalized
    && sessions.some((session) => session.id === chatRun.sessionId && session.projectId === id);
  if (running) return toast('生成中无法删除该项目，请先停止');
  if (!(await appConfirm('删除项目「' + p.name + '」？\n（不会删除磁盘上的真实文件夹）'))) return;
  const worktreeBindingId = worktreeBindings.get(id);
  if (worktreeBindingId) {
    window.codex.unbindWorktreeProject({ projectBindingId: worktreeBindingId }).catch(() => {});
    worktreeBindings.delete(id);
  }
  projects = projects.filter((x) => x.id !== id);
  sessions = sessions.filter((s) => s.projectId !== id);
  if (!sessions.length) sessions = defaultSessions();
  if (!sessions.some((s) => s.id === activeSessionId)) activeSessionId = sessions[0].id;
  saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); toast('项目已删除（磁盘文件未动）');
}
async function renameProject(id) {
  const p = getProject(id); if (!p) return;
  const name = await appPrompt('请输入项目名称', p.name); if (!name || !name.trim()) return;
  p.name = name.trim();
  sessions.forEach((s) => { if (s.projectId === id && s.kind === 'project') s.title = p.name; });
  saveState(); renderLeftDynamic(); updateHeader(); toast('已重命名');
}
async function bindProjectPath(id) {
  const p = getProject(id); if (!p) return;
  const dir = await window.codex.selectDirectory(); if (!dir) return;
  const previous = p.path;
  p.path = dir;
  const bound = await window.codex.bindWorktreeProject({ projectId: p.id, projectPath: dir });
  if (!bound?.ok) {
    p.path = previous;
    toast(bound?.error || '项目绑定失败');
    return;
  }
  worktreeBindings.set(p.id, bound.projectBindingId);
  saveState(); renderLeftDynamic(); toast('已绑定：' + dir);
  reconcileWorktreeResults(p);
  if (sessionProject()?.id === id) updateHeader();
}
function openProjectModal() {
  document.getElementById('project-name').value = '';
  document.getElementById('project-path').value = '';
  document.getElementById('project-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('project-name').focus(), 40);
}
function closeProjectModal() { document.getElementById('project-modal').classList.add('hidden'); }
async function browseProjectPath() {
  const dir = await window.codex.selectDirectory(); if (!dir) return;
  document.getElementById('project-path').value = dir;
  if (!document.getElementById('project-name').value.trim()) {
    const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    document.getElementById('project-name').value = base || '';
  }
}
async function createProjectFromModal() {
  const name = document.getElementById('project-name').value.trim();
  const pathVal = document.getElementById('project-path').value.trim();
  if (!name) return toast('请填写项目名称');
  if (!pathVal) return toast('请选择真实项目目录');
  const p = { id: uid('proj'), name, path: pathVal, pinned: false, createdAt: Date.now() };
  const bound = await window.codex.bindWorktreeProject({ projectId: p.id, projectPath: pathVal }).catch(() => null);
  if (!bound?.ok || !bound.projectBindingId) {
    toast(bound?.error || '项目绑定失败');
    return;
  }
  projects.unshift(p);
  worktreeBindings.set(p.id, bound.projectBindingId);
  saveState(); closeProjectModal(); openProjectChat(p.id); toast('项目已添加并绑定目录');
}

const WORKFLOW_UNAVAILABLE_LABELS = {
  WORKFLOW_PROFILE_NOT_FOUND: '引用的验证档案已删除',
  WORKFLOW_PROFILE_DISABLED: '引用的验证档案已禁用',
  WORKFLOW_PROFILE_CHANGED: '验证档案配置已变化，请编辑后保存',
  WORKFLOW_INVALID: '工作流配置无效',
};

function workflowUnavailableText(reason) {
  return WORKFLOW_UNAVAILABLE_LABELS[String(reason || '')] || String(reason || '当前不可运行');
}

function workflowPersistenceHtml(status) {
  if (status?.persistence === 'memory') return '<div class="work-card-notice">仅当前进程：工作流定义和运行记录将在退出应用后丢失。</div>';
  if (status?.error === 'WORKFLOW_STORE_CORRUPT') return '<div class="work-card-error">工作流加密存储已损坏，原文件已保留且不会覆盖。</div>';
  if (status?.error) return '<div class="work-card-error">工作流加密存储暂不可用。</div>';
  return '';
}

async function showEngineeringWorkflowResult(token, workflowRunRef) {
  const detail = document.getElementById('engineering-workflow-detail');
  if (!detail) return;
  const result = await window.codex.getEngineeringWorkflowResult({ projectBindingId: token, workflowRunRef }).catch(() => null);
  if (!result?.ok || !result.run) {
    detail.innerHTML = `<div class="work-card-error">${escapeHtml(result?.error || '工作流结果不可用')}</div>`;
    detail.classList.remove('hidden');
    return;
  }
  const run = result.run;
  const notices = [
    run.workspaceChanged ? '工作区指纹已变化' : '',
    run.status === 'configuration_changed' ? '工作流或验证档案配置已变化' : '',
    run.status === 'interrupted' ? '应用退出时运行尚未完成' : '',
    run.statusMessage || '',
  ].filter(Boolean).join(' · ');
  detail.innerHTML = [
    `<div class="engineering-detail-title">${escapeHtml(run.workflowName || run.workflowId || '工作流')} · ${escapeHtml(engineeringStatusText(run.status))}</div>`,
    `<div class="work-card-meta"><code>${escapeHtml(run.workflowRunRef)}</code> · ${run.passedCount || 0}/${run.nodeCount || 0} 节点通过 · ${escapeHtml(run.finishedAt || run.startedAt || run.createdAt || '')}</div>`,
    notices ? `<div class="work-card-notice">${escapeHtml(notices)}</div>` : '',
    `<div class="engineering-workflow-node-results">${(run.nodes || []).map((node) => `<div class="engineering-workflow-node-result"><div><strong>${escapeHtml(node.nodeId)}</strong><span class="badge ${escapeHtml(node.status || '')}">${escapeHtml(engineeringStatusText(node.status))}</span><div class="work-card-meta">依赖：${escapeHtml((node.dependsOn || []).join(', ') || '无')}${node.diagnosticCount ? ` · 诊断 ${node.diagnosticCount} 条` : ''}${Number.isFinite(node.exitCode) ? ` · 退出码 ${node.exitCode}` : ''}</div>${node.statusMessage ? `<div class="work-card-notice">${escapeHtml(node.statusMessage)}</div>` : ''}</div>${node.jobRef ? `<button type="button" class="ghost-btn" data-workflow-job="${escapeHtml(node.jobRef)}">查看节点结果</button>` : ''}</div>`).join('')}</div>`,
    '<div class="engineering-detail-actions"><button type="button" class="ghost-btn" id="engineering-workflow-close-detail">关闭</button></div>',
  ].join('');
  detail.classList.remove('hidden');
  detail.querySelectorAll('[data-workflow-job]').forEach((button) => button.addEventListener('click', () => showEngineeringJobResult(token, button.dataset.workflowJob, 'engineering-workflow-detail')));
  document.getElementById('engineering-workflow-close-detail')?.addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
  });
}

async function loadEngineeringWorkflows(token = engineeringBindingToken()) {
  const el = document.getElementById('engineering-workflows');
  const runsEl = document.getElementById('engineering-workflow-runs');
  if (!el || !token || !window.codex?.listEngineeringWorkflows) return;
  const response = await window.codex.listEngineeringWorkflows({ projectBindingId: token, includeDisabled: true }).catch(() => null);
  if (!response?.ok) {
    el.innerHTML = `<div class="work-card-error">${escapeHtml(response?.error || '工作流读取失败')}</div>`;
    return;
  }
  const workflows = response.workflows || [];
  const workflowRows = workflows.map((workflow) => {
    const runnable = workflow.runnable === true;
    const unavailable = workflow.enabled === false ? '已禁用' : (runnable ? '' : workflowUnavailableText(workflow.unavailableReason));
    return `<div class="engineering-job"><div class="engineering-profile-main"><strong>${escapeHtml(workflow.name)}</strong><span class="badge ${runnable ? 'ready' : 'disabled'}">${runnable ? '可运行' : escapeHtml(unavailable)}</span><div class="work-card-meta"><code>${escapeHtml(workflow.workflowId)}</code> · ${workflow.nodeCount || workflow.nodes?.length || 0} 节点 · 并行 ${workflow.maxParallel || 1} · ${Math.round(Number(workflow.timeoutMs || 0) / 60000)} 分钟 · ${workflow.failFast === false ? '继续独立分支' : '失败即停'}</div></div><div class="work-card-actions"><button type="button" class="ghost-btn" data-workflow-run="${escapeHtml(workflow.workflowId)}" ${runnable ? '' : 'disabled'}>运行</button><button type="button" class="ghost-btn" data-workflow-edit="${escapeHtml(workflow.workflowId)}">编辑</button><button type="button" class="ghost-btn" data-workflow-copy="${escapeHtml(workflow.workflowId)}">复制</button><button type="button" class="ghost-btn" data-workflow-delete="${escapeHtml(workflow.workflowId)}">删除</button></div></div>`;
  }).join('');
  el.innerHTML = `${workflowPersistenceHtml(response.persistence)}<div class="work-card-actions"><button type="button" class="ghost-btn" id="engineering-workflow-new">新建工作流</button></div>${workflowRows || '<div class="work-empty">暂无工程工作流</div>'}`;
  document.getElementById('engineering-workflow-new')?.addEventListener('click', () => editEngineeringWorkflow(token, null));
  el.querySelectorAll('[data-workflow-run]').forEach((button) => button.addEventListener('click', async () => {
    const result = await window.codex.runEngineeringWorkflow({ projectBindingId: token, workflowId: button.dataset.workflowRun });
    if (!result?.ok) toast(result?.error || '工作流启动失败'); else toast('工作流已排队');
    await loadEngineeringWorkflows(token);
  }));
  const openEditor = async (workflowId, copy = false) => {
    const result = await window.codex.getEngineeringWorkflow({ projectBindingId: token, workflowId }).catch(() => null);
    if (!result?.ok) return toast(result?.error || '读取工作流失败');
    await editEngineeringWorkflow(token, result.workflow, { copy });
  };
  el.querySelectorAll('[data-workflow-edit]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.workflowEdit)));
  el.querySelectorAll('[data-workflow-copy]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.workflowCopy, true)));
  el.querySelectorAll('[data-workflow-delete]').forEach((button) => button.addEventListener('click', async () => {
    const workflow = workflows.find((item) => item.workflowId === button.dataset.workflowDelete);
    if (!workflow || !(await appConfirm(`确定删除工作流「${workflow.name}」？`))) return;
    const result = await window.codex.deleteEngineeringWorkflow({ projectBindingId: token, workflowId: workflow.workflowId });
    if (!result?.ok) toast(result?.error || '删除失败');
    await loadEngineeringWorkflows(token);
  }));
  if (runsEl && window.codex.listEngineeringWorkflowRuns) {
    const runsResponse = await window.codex.listEngineeringWorkflowRuns({ projectBindingId: token, limit: 50 }).catch(() => null);
    const runs = runsResponse?.runs || [];
    const project = sessionProject();
    if (project) setWorkflowGateRuns(project, runs);
    runsEl.innerHTML = '<div class="work-card-meta engineering-candidate-title">工作流运行</div>' + (runs.length ? runs.map((run) => {
      const active = ['queued', 'running'].includes(run.status);
      const notice = [run.workspaceChanged ? '工作区已变化' : '', run.status === 'configuration_changed' ? '配置已变化' : '', run.statusMessage || ''].filter(Boolean).join(' · ');
      return `<div class="engineering-job"><div class="engineering-profile-main"><strong>${escapeHtml(run.workflowName || run.workflowId)}</strong><div class="work-card-meta"><code>${escapeHtml(run.workflowRunRef)}</code> · <span class="badge ${escapeHtml(run.status || '')}">${escapeHtml(engineeringStatusText(run.status))}</span> · ${run.passedCount || 0}/${run.nodeCount || 0} 节点通过 · ${escapeHtml(run.finishedAt || run.startedAt || run.createdAt || '')}</div>${notice ? `<div class="work-card-notice">${escapeHtml(notice)}</div>` : ''}</div><div class="work-card-actions"><button type="button" class="ghost-btn" data-workflow-view="${escapeHtml(run.workflowRunRef)}">查看</button>${active ? `<button type="button" class="ghost-btn" data-workflow-cancel="${escapeHtml(run.workflowRunRef)}">取消</button>` : `<button type="button" class="ghost-btn" data-workflow-rerun="${escapeHtml(run.workflowRunRef)}">重跑</button>`}</div></div>`;
    }).join('') : '<div class="work-empty">暂无运行记录</div>');
    runsEl.querySelectorAll('[data-workflow-cancel]').forEach((button) => button.addEventListener('click', async () => { const result = await window.codex.cancelEngineeringWorkflow({ projectBindingId: token, workflowRunRef: button.dataset.workflowCancel }); if (!result?.ok) toast(result?.error || '取消失败'); await loadEngineeringWorkflows(token); }));
    runsEl.querySelectorAll('[data-workflow-rerun]').forEach((button) => button.addEventListener('click', async () => { const result = await window.codex.rerunEngineeringWorkflow({ projectBindingId: token, workflowRunRef: button.dataset.workflowRerun }); if (!result?.ok) toast(result?.error || '重跑失败'); else toast('工作流已重新排队'); await loadEngineeringWorkflows(token); }));
    runsEl.querySelectorAll('[data-workflow-view]').forEach((button) => button.addEventListener('click', () => showEngineeringWorkflowResult(token, button.dataset.workflowView)));
  }
}

function syncWorkflowEditorNodes(modal, nodes) {
  for (const node of nodes) {
    const row = modal.querySelector(`[data-workflow-editor-node="${node.key}"]`);
    if (!row) continue;
    node.nodeId = row.querySelector('[data-workflow-node-id]')?.value.trim() || '';
    node.profileId = row.querySelector('[data-workflow-node-profile]')?.value || '';
    node.continueOnFailure = row.querySelector('[data-workflow-node-continue]')?.checked === true;
    node.dependsOnKeys = [...row.querySelectorAll('[data-workflow-dependency]:checked')].map((input) => input.dataset.workflowDependency);
  }
}

function validateWorkflowEditorNodes(nodes, profiles) {
  const enabledProfiles = new Set(profiles.filter((profile) => profile.enabled !== false).map((profile) => profile.id));
  const ids = new Set();
  for (const node of nodes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(node.nodeId)) return { error: '节点 ID 需为 1-64 位字母、数字、下划线或连字符' };
    if (ids.has(node.nodeId)) return { error: `节点 ID 重复：${node.nodeId}` };
    if (!enabledProfiles.has(node.profileId)) return { error: `节点 ${node.nodeId} 未选择可用验证档案` };
    ids.add(node.nodeId);
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const normalized = nodes.map((node) => ({
    nodeId: node.nodeId,
    profileId: node.profileId,
    dependsOn: [...new Set(node.dependsOnKeys.map((key) => byKey.get(key)?.nodeId).filter(Boolean))].sort(),
    continueOnFailure: node.continueOnFailure === true,
  }));
  const indegree = new Map(normalized.map((node) => [node.nodeId, node.dependsOn.length]));
  const outgoing = new Map(normalized.map((node) => [node.nodeId, []]));
  for (const node of normalized) for (const dep of node.dependsOn) outgoing.get(dep)?.push(node.nodeId);
  const ready = normalized.filter((node) => indegree.get(node.nodeId) === 0).map((node) => node.nodeId);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift();
    visited += 1;
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return visited === normalized.length ? { nodes: normalized } : { error: '节点依赖存在环，请调整依赖关系' };
}

async function editEngineeringWorkflow(token, current, options = {}) {
  const profilesResponse = await window.codex.listVerificationProfiles({ projectBindingId: token }).catch(() => null);
  const profiles = profilesResponse?.profiles || [];
  const enabledProfiles = profiles.filter((profile) => profile.enabled !== false);
  if (!enabledProfiles.length) return toast('请先保存至少一个已启用的验证档案');
  engineeringWorkflowEditor?.remove();
  const copy = options.copy === true;
  const sourceNodes = current?.nodes?.length ? current.nodes : [{ nodeId: 'node_1', profileId: enabledProfiles[0].id, dependsOn: [], continueOnFailure: false }];
  const nodes = sourceNodes.map((node) => ({
    key: uid('wfn'),
    nodeId: node.nodeId,
    profileId: node.profileId,
    dependsOnKeys: [],
    continueOnFailure: node.continueOnFailure === true,
  }));
  const keyByNodeId = new Map(nodes.map((node) => [node.nodeId, node.key]));
  sourceNodes.forEach((node, index) => { nodes[index].dependsOnKeys = (node.dependsOn || []).map((id) => keyByNodeId.get(id)).filter(Boolean); });
  const modal = document.createElement('div');
  modal.className = 'modal workflow-editor-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `<form class="modal-card workflow-editor-card"><div class="modal-title">${copy ? '复制工作流' : (current ? '编辑工作流' : '新建工作流')}</div><div class="workflow-editor-grid"><label class="field workflow-editor-name"><span>名称</span><input data-workflow-name maxlength="80" required value="${escapeHtml(copy ? `${current?.name || ''} 副本` : (current?.name || ''))}" /></label><label class="field"><span>最大并行数</span><input data-workflow-parallel type="number" min="1" max="4" step="1" value="${Number(current?.maxParallel || 4)}" /></label><label class="field"><span>总超时（分钟）</span><input data-workflow-timeout type="number" min="1" max="1440" step="1" value="${Math.max(1, Math.round(Number(current?.timeoutMs || 3600000) / 60000))}" /></label></div><div class="workflow-editor-switches"><label class="switch-row"><input type="checkbox" data-workflow-enabled ${current?.enabled === false ? '' : 'checked'} /><span>启用工作流</span></label><label class="switch-row"><input type="checkbox" data-workflow-fail-fast ${current?.failFast === false ? '' : 'checked'} /><span>节点失败时停止其它分支</span></label></div><div class="workflow-editor-heading"><strong>节点与依赖</strong><button type="button" class="ghost-btn" data-workflow-node-add>添加节点</button></div><div class="workflow-editor-nodes"></div><div class="workflow-editor-error" role="alert"></div><div class="modal-actions"><button type="button" class="btn-secondary" data-workflow-editor-cancel>取消</button><button type="submit" class="btn-primary">保存</button></div></form>`;
  document.body.appendChild(modal);
  engineeringWorkflowEditor = modal;
  const close = () => {
    if (engineeringWorkflowEditor === modal) engineeringWorkflowEditor = null;
    document.removeEventListener('keydown', onKeyDown);
    modal.remove();
  };
  const onKeyDown = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKeyDown);
  modal.addEventListener('mousedown', (event) => { if (event.target === modal) close(); });
  const renderNodes = () => {
    const container = modal.querySelector('.workflow-editor-nodes');
    container.innerHTML = nodes.map((node, index) => {
      const currentProfile = profiles.find((profile) => profile.id === node.profileId);
      const unavailableOption = currentProfile?.enabled === false || !currentProfile
        ? `<option value="${escapeHtml(node.profileId)}" selected disabled>${escapeHtml(currentProfile?.name || node.profileId)}（不可用）</option>` : '';
      const profileOptions = enabledProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === node.profileId ? 'selected' : ''}>${escapeHtml(profile.name)} · ${escapeHtml(profile.kind || 'custom')}</option>`).join('');
      const dependencies = nodes.filter((candidate) => candidate.key !== node.key).map((candidate) => {
        const profile = profiles.find((item) => item.id === candidate.profileId);
        return `<label><input type="checkbox" data-workflow-dependency="${candidate.key}" ${node.dependsOnKeys.includes(candidate.key) ? 'checked' : ''} /><span>${escapeHtml(candidate.nodeId || '未命名节点')} · ${escapeHtml(profile?.name || candidate.profileId)}</span></label>`;
      }).join('');
      return `<fieldset class="workflow-editor-node" data-workflow-editor-node="${node.key}"><legend>节点 ${index + 1}</legend><button type="button" class="workflow-node-remove" data-workflow-node-remove="${node.key}" title="删除节点" aria-label="删除节点" ${nodes.length === 1 ? 'disabled' : ''}>×</button><div class="workflow-node-fields"><label class="field"><span>节点 ID</span><input data-workflow-node-id maxlength="64" value="${escapeHtml(node.nodeId)}" /></label><label class="field"><span>验证档案</span><select data-workflow-node-profile>${unavailableOption}${profileOptions}</select></label></div><fieldset class="workflow-node-dependencies"><legend>依赖</legend>${dependencies || '<span class="work-card-meta">无可选依赖</span>'}</fieldset><label class="switch-row"><input type="checkbox" data-workflow-node-continue ${node.continueOnFailure ? 'checked' : ''} /><span>依赖失败后仍运行此节点</span></label></fieldset>`;
    }).join('');
    container.querySelectorAll('[data-workflow-node-remove]').forEach((button) => button.addEventListener('click', () => {
      syncWorkflowEditorNodes(modal, nodes);
      const index = nodes.findIndex((node) => node.key === button.dataset.workflowNodeRemove);
      if (index < 0 || nodes.length === 1) return;
      const [removed] = nodes.splice(index, 1);
      for (const node of nodes) node.dependsOnKeys = node.dependsOnKeys.filter((key) => key !== removed.key);
      renderNodes();
    }));
  };
  renderNodes();
  modal.querySelector('[data-workflow-node-add]')?.addEventListener('click', () => {
    syncWorkflowEditorNodes(modal, nodes);
    if (nodes.length >= 32) return toast('工作流最多包含 32 个节点');
    let serial = nodes.length + 1;
    const used = new Set(nodes.map((node) => node.nodeId));
    while (used.has(`node_${serial}`)) serial += 1;
    nodes.push({ key: uid('wfn'), nodeId: `node_${serial}`, profileId: enabledProfiles[0].id, dependsOnKeys: [], continueOnFailure: false });
    renderNodes();
  });
  modal.querySelector('[data-workflow-editor-cancel]')?.addEventListener('click', close);
  modal.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    syncWorkflowEditorNodes(modal, nodes);
    const errorEl = modal.querySelector('.workflow-editor-error');
    const name = modal.querySelector('[data-workflow-name]')?.value.trim() || '';
    const maxParallel = Number(modal.querySelector('[data-workflow-parallel]')?.value);
    const timeoutMinutes = Number(modal.querySelector('[data-workflow-timeout]')?.value);
    const validated = validateWorkflowEditorNodes(nodes, profiles);
    let validationError = '';
    if (!name) validationError = '请填写工作流名称';
    else if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) validationError = '最大并行数必须为 1-4';
    else if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) validationError = '总超时必须为 1-1440 分钟';
    else if (validated.error) validationError = validated.error;
    if (validationError) { errorEl.textContent = validationError; return; }
    const submit = modal.querySelector('[type="submit"]');
    submit.disabled = true;
    const workflow = {
      workflowId: copy ? '' : (current?.workflowId || ''),
      name,
      enabled: modal.querySelector('[data-workflow-enabled]')?.checked === true,
      failFast: modal.querySelector('[data-workflow-fail-fast]')?.checked === true,
      maxParallel,
      timeoutMs: timeoutMinutes * 60000,
      nodes: validated.nodes,
    };
    const result = await window.codex.saveEngineeringWorkflow({ projectBindingId: token, workflow }).catch(() => null);
    if (!result?.ok) {
      errorEl.textContent = result?.error || '保存工作流失败';
      submit.disabled = false;
      return;
    }
    close();
    toast(current && !copy ? '工作流已更新' : '工作流已创建');
    await loadEngineeringWorkflows(token);
  });
  modal.querySelector('[data-workflow-name]')?.focus();
}
function openProjectChat(projectId) {
  const p = getProject(projectId); if (!p) return;
  let session = sessions.find((s) => s.kind === 'project' && s.projectId === projectId);
  if (!session) {
    const tip = p.path
      ? ('已连接真实目录：\n`' + p.path + '`\n\n你可以像 Codex 一样让我改代码，例如：\n- 列出文件\n- 读取 package.json\n- 新建 README.md 并写介绍')
      : ('项目「' + p.name + '」尚未绑定真实目录。\n\n请右键 → **绑定真实目录**。');
    session = {
      id: uid('ps'), title: p.name, kind: 'project', peer: 'codex', projectId: p.id, pinned: false,
      agentMode: defaultAgentModeSeed,
      messages: [{ role: 'assistant', content: tip }], updatedAt: Date.now(),
    };
    sessions.unshift(session);
  }
  activeSessionId = session.id; saveState(); setView('chat'); updateAgentModeToggle();
  reconcileWorktreeResults(p);
}
function renderFriends() {
  const ul = document.getElementById('friend-list');
  const online = FRIENDS.filter((f) => f.status === '在线').length;
  document.getElementById('friend-list-head').textContent = '我的好友 (' + online + '/' + FRIENDS.length + ')';
  ul.innerHTML = FRIENDS.map((f) => '<li data-friend="'+f.id+'" class="'+(f.id===activeSession()?.peer?'active-friend':'')+'"><span class="avatar-sm">'+f.avatar+'</span><span><div>'+escapeHtml(f.name)+'</div><div class="contact-status '+(f.status==='在线'?'online':'')+'">'+escapeHtml(f.status)+'</div></span></li>').join('');
  ul.querySelectorAll('[data-friend]').forEach((el) => el.addEventListener('click', () => openFriendChat(el.getAttribute('data-friend'))));
}
function updateHeader() {
  const s = activeSession(); const title = s?.title || 'Codex'; const proj = sessionProject(s);
  document.getElementById('session-title').textContent = title;
  document.getElementById('session-heading').textContent = title;
  let sub = '与 ' + peerName(s?.peer || 'codex') + ' 对话';
  if (proj) sub += proj.path ? (' · 📁 ' + proj.path) : ' · 未绑定目录';
  document.getElementById('session-sub').textContent = sub;
  document.title = 'Codex 2007 - ' + title;
  const bindBtn = document.getElementById('btn-bind-project');
  if (bindBtn) { bindBtn.classList.toggle('hidden', !(s?.kind === 'project')); bindBtn.textContent = proj?.path ? '换目录' : '绑定目录'; }
  updateMemoryCandidateCount();
}
async function updateStatusBar() {
  try {
    const settings = await window.codex.getSettings();
    currencySymbol = settings.usageCurrency || '$';
    usageDisplayEnabled = settings.usageEnabled !== false;
    document.getElementById('status-left').textContent = '安全 · ' + (settings.mode === 'api' ? 'API 模式' : '本地模拟');
    const proj = sessionProject();
    document.getElementById('status-mid').textContent = proj?.path ? ('项目: ' + proj.name) : (settings.mode === 'api' ? (settings.model || '') : 'mock');
    renderUsageBar();
    renderContextMeter();
  } catch { document.getElementById('status-left').textContent = '安全'; }
}

function fmtTok(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 10000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (number >= 1000) return (number / 1000).toFixed(1) + 'k';
  return String(Math.floor(number));
}

function applyUsageToSession(session, event) {
  if (!session || !event) return;
  if (!session.usage) {
    session.usage = { in: 0, out: 0, cost: 0, est: false, byKind: {}, costByCurrency: {} };
  }
  const usage = session.usage;
  if (!usage.byKind || typeof usage.byKind !== 'object') usage.byKind = {};
  if (!usage.costByCurrency || typeof usage.costByCurrency !== 'object') {
    usage.costByCurrency = {};
    if (Number(usage.cost) > 0) {
      usage.costByCurrency[String(usage.currency || currencySymbol)] = Number(usage.cost);
    }
  }
  const inputTokens = Math.max(0, Number(event.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(event.outputTokens) || 0);
  usage.in = Math.max(0, Number(usage.in) || 0) + inputTokens;
  usage.out = Math.max(0, Number(usage.out) || 0) + outputTokens;
  const eventCurrency = String(event.currency || currencySymbol);
  if (typeof event.cost === 'number' && Number.isFinite(event.cost) && event.cost >= 0) {
    usage.costByCurrency[eventCurrency] = Number(usage.costByCurrency[eventCurrency] || 0)
      + event.cost;
  }
  usage.cost = Number(usage.costByCurrency[eventCurrency] || 0);
  if (event.estimated) usage.est = true;
  usage.currency = eventCurrency;
  const kind = String(event.kind || 'main');
  if (!usage.byKind[kind]) usage.byKind[kind] = { in: 0, out: 0 };
  usage.byKind[kind].in += inputTokens;
  usage.byKind[kind].out += outputTokens;
  usage.lastContextTokens = Math.max(0, Number(event.contextTokens) || 0);
  usage.contextLimit = Math.max(1, Number(event.contextLimit) || 24000);
}

function renderUsageBar() {
  const el = document.getElementById('usage-bar');
  if (!el) return;
  const usage = activeSession()?.usage;
  if (!usageDisplayEnabled || !usage || (!usage.in && !usage.out)) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const approximate = usage.est ? '≈' : '';
  let text = `${approximate}↑${fmtTok(usage.in)} ↓${fmtTok(usage.out)}`;
  const cost = Number(usage.costByCurrency?.[currencySymbol]
    ?? (usage.currency === currencySymbol ? usage.cost : 0)) || 0;
  if (cost > 0) {
    text += ` ${currencySymbol}${cost.toFixed(cost < 0.1 ? 4 : 2)}`;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

function renderContextMeter() {
  const el = document.getElementById('context-meter');
  if (!el) return;
  const usage = activeSession()?.usage;
  if (!usageDisplayEnabled || !usage || !usage.lastContextTokens) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const limit = usage.contextLimit || 24000;
  const over = usage.lastContextTokens >= limit;
  el.textContent = `上下文 ≈${fmtTok(usage.lastContextTokens)} / ${fmtTok(limit)}`
    + (over ? ' · 建议 /compact' : '');
  el.classList.toggle('is-over', over);
  el.classList.remove('hidden');
}

function showUsageDetails() {
  const byKind = activeSession()?.usage?.byKind || {};
  const text = Object.entries(byKind)
    .map(([kind, usage]) => `${kind} ↑${fmtTok(usage.in)} ↓${fmtTok(usage.out)}`)
    .join(' / ');
  if (text) toast(text);
}
function updateClock() {
  const el = document.getElementById('clock'); if (!el) return;
  const d = new Date(); el.textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('#main-toolbar .tb-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('#left-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'new-task') {
    openTaskModal();
    document.querySelectorAll('#main-toolbar .tb-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
    document.querySelectorAll('#left-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
    currentView = 'chat'; showChatView(); return;
  }
  if (view === 'chat') { showChatView(); return; }
  showWorkView(view);
}
function showChatView() {
  document.getElementById('view-chat').classList.remove('hidden');
  document.getElementById('view-work').classList.add('hidden');
  updateHeader(); renderMessages(); renderLeftDynamic(); renderFriends(); updateStatusBar(); updateAgentModeToggle();
  const project = sessionProject();
  if (project?.path) reconcileWorktreeResults(project);
}
function switchSession(id) {
  if (!sessions.some((s) => s.id === id)) return;
  activeSessionId = id; saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); renderFriends(); updateStatusBar(); updateAgentModeToggle();
  const project = sessionProject();
  if (project?.path) reconcileWorktreeResults(project);
}
function openFriendChat(friendId) {
  const friend = FRIENDS.find((f) => f.id === friendId); if (!friend) return;
  let session = sessions.find((s) => s.kind === 'friend' && s.peer === friendId);
  if (!session) {
    session = {
      id: uid('friend'), title: friend.name, kind: 'friend', peer: friendId, projectId: null, pinned: false,
      agentMode: defaultAgentModeSeed,
      messages: [{ role: 'assistant', content: friend.kind === 'bot' ? '在呢。直接说需求，或先绑定真实项目再让我改代码。' : ('（模拟）' + friend.name + '：你好。') }], updatedAt: Date.now(),
    };
    sessions.unshift(session);
  }
  activeSessionId = session.id; saveState(); setView('chat'); updateAgentModeToggle(); toast('已打开与 ' + friend.name + ' 的会话');
}
function ensureTaskAndAsk(title, firstUserMessage) {
  const session = {
    id: uid('task'), title, kind: 'task', peer: 'codex', projectId: null, pinned: false,
    agentMode: defaultAgentModeSeed, messages: [], updatedAt: Date.now(),
  };
  sessions.unshift(session); activeSessionId = session.id; saveState(); setView('chat'); updateAgentModeToggle();
  document.getElementById('chat-input').value = firstUserMessage; sendMessage();
}
function openTaskModal() {
  document.getElementById('task-title').value = ''; document.getElementById('task-brief').value = '';
  document.getElementById('task-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('task-title').focus(), 50);
}
function closeTaskModal() { document.getElementById('task-modal').classList.add('hidden'); }
function createTaskFromModal() {
  const title = document.getElementById('task-title').value.trim();
  const brief = document.getElementById('task-brief').value.trim();
  if (!title) return toast('请填写任务标题');
  const session = {
    id: uid('task'), title, kind: 'task', peer: 'codex', projectId: sessionProject()?.id || null, pinned: false,
    agentMode: defaultAgentModeSeed,
    messages: [{ role: 'assistant', content: '新任务「' + title + '」已创建。' + (brief ? ('\n\n说明：' + brief + '\n\n') : '\n\n') + '继续补充细节即可。' }], updatedAt: Date.now(),
  };
  sessions.unshift(session); activeSessionId = session.id; saveState(); closeTaskModal(); setView('chat'); updateAgentModeToggle(); toast('任务已创建');
  if (brief) document.getElementById('chat-input').value = brief;
}

function resetPullRequestView(project) {
  if (pullRequestView.projectId === String(project?.id || '')) return;
  pullRequestView.projectId = String(project?.id || '');
  pullRequestView.repo = null;
  pullRequestView.prs = [];
  pullRequestView.truncated = false;
  pullRequestView.selectedNumber = 0;
  pullRequestView.resultId = '';
  pullRequestView.detail = null;
  pullRequestView.error = '';
}

function pullRequestStatus(pr) {
  if (pr?.state === 'MERGED') return '已合并';
  if (pr?.state === 'CLOSED') return '已关闭';
  if (pr?.isDraft) return 'Draft';
  return pr?.state === 'OPEN' ? 'Open' : '未知';
}

function pullRequestBadgeClass(pr) {
  if (pr?.state === 'MERGED') return 'merged';
  if (pr?.state === 'CLOSED') return 'closed';
  return pr?.isDraft ? 'review' : 'open';
}

function strictMergeReady(pr) {
  const checks = pr?.checksSummary || {};
  return pr?.state === 'OPEN' && !pr?.isDraft && pr?.mergeable === 'MERGEABLE'
    && Number(checks.total) > 0 && !checks.pending && !checks.failed && !checks.unknown
    && Number(checks.passed || 0) + Number(checks.skipped || 0) === Number(checks.total);
}

function pullRequestReference() {
  return pullRequestView.resultId
    ? { resultId: pullRequestView.resultId }
    : { number: pullRequestView.selectedNumber };
}

function renderPullRequestView() {
  if (currentView !== 'prs') return;
  const body = document.getElementById('work-body');
  if (!body) return;
  const project = sessionProject();
  resetPullRequestView(project);
  if (!project?.path) {
    body.innerHTML = '<div class="pr-empty"><strong>需要绑定项目</strong><span>先打开一个已绑定真实目录的项目会话，再查看该项目 origin 的拉取请求。</span></div>';
    return;
  }
  const repo = pullRequestView.repo;
  const filterOptions = ['open', 'closed', 'merged', 'all'].map((value) => {
    const label = ({ open: '打开', closed: '关闭', merged: '已合并', all: '全部' })[value];
    return `<option value="${value}"${pullRequestView.filter === value ? ' selected' : ''}>${label}</option>`;
  }).join('');
  const repoName = repo?.nameWithOwner || `${repo?.owner || ''}/${repo?.repo || ''}`.replace(/^\/$/, '') || project.name;
  const listHtml = pullRequestView.prs.map((pr) => `
    <button type="button" class="pr-list-item${pr.number === pullRequestView.selectedNumber ? ' is-selected' : ''}" data-pr-number="${pr.number}">
      <span class="pr-list-title">#${pr.number} ${escapeHtml(pr.title || '(无标题)')}</span>
      <span class="pr-list-meta">${escapeHtml(pr.author || '未知作者')} · <span class="badge ${pullRequestBadgeClass(pr)}">${pullRequestStatus(pr)}</span></span>
    </button>`).join('');
  let detailHtml = '<div class="pr-detail-empty">选择一个 PR 查看详情</div>';
  const pr = pullRequestView.detail;
  if (pr) {
    const checks = pr.checksSummary || {};
    const checkText = checks.total
      ? `${checks.passed || 0} 通过 · ${checks.skipped || 0} 跳过 · ${checks.pending || 0} 等待 · ${checks.failed || 0} 失败${checks.unknown ? ` · ${checks.unknown} 未知` : ''}`
      : '没有可用 checks';
    const checksHtml = pr.checks.length
      ? pr.checks.map((item) => `<li><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.bucket || item.state || 'UNKNOWN')}</strong></li>`).join('')
      : '<li class="muted">没有 checks</li>';
    const commentsHtml = pr.comments.length
      ? pr.comments.map((item) => `<div class="pr-comment"><div class="pr-comment-meta">${escapeHtml(item.author || '未知用户')} · ${escapeHtml(item.createdAt || '')}</div><div class="pr-comment-body">${escapeHtml(item.body)}</div></div>`).join('')
      : '<div class="muted">暂无评论</div>';
    const filesHtml = pr.files.length
      ? pr.files.map((item) => `<li><span>${escapeHtml(item.path)}</span><span>+${item.additions}/-${item.deletions}</span></li>`).join('')
      : '<li class="muted">未返回文件摘要</li>';
    const blocked = pullRequestView.busy || sending || anyTermRunning();
    detailHtml = `
      <div class="pr-detail-head">
        <div><span class="badge ${pullRequestBadgeClass(pr)}">${pullRequestStatus(pr)}</span> <strong>#${pr.number}</strong> · ${escapeHtml(pr.author || '未知作者')}</div>
        <button type="button" class="ghost-btn" data-pr-action="open">打开 GitHub</button>
      </div>
      <div class="pr-branches">${escapeHtml(pr.headRefName || '-')} → ${escapeHtml(pr.baseRefName || '-')} ${pr.headSha ? `· ${pr.headSha.slice(0, 8)}` : ''}</div>
      <div class="pr-edit-form">
        <label>标题<input class="pr-edit-title" maxlength="300" value="${escapeHtml(pr.title)}" ${blocked ? 'disabled' : ''}></label>
        <label>正文<textarea class="pr-edit-body" maxlength="10000" rows="8" ${blocked ? 'disabled' : ''}>${escapeHtml(pr.body)}</textarea></label>
        <button type="button" class="btn-secondary" data-pr-action="edit" ${blocked || pr.state === 'MERGED' ? 'disabled' : ''}>保存标题与正文</button>
      </div>
      <section class="pr-detail-section">
        <h2>Checks</h2><div class="pr-check-summary">${escapeHtml(checkText)}</div><ul class="pr-check-list">${checksHtml}</ul>
      </section>
      <section class="pr-detail-section"><h2>文件${pr.filesTruncated ? '（前 200 条）' : ''}</h2><ul class="pr-file-list">${filesHtml}</ul></section>
      <section class="pr-detail-section"><h2>评论${pr.commentsTruncated ? '（前 50 条）' : ''}</h2>${commentsHtml}
        <textarea class="pr-comment-input" rows="4" maxlength="10000" placeholder="发表评论" ${blocked ? 'disabled' : ''}></textarea>
        <button type="button" class="btn-secondary" data-pr-action="comment" ${blocked ? 'disabled' : ''}>发布评论</button>
      </section>
      <div class="pr-lifecycle-actions">
        ${pr.state === 'OPEN' && pr.isDraft ? `<button type="button" class="btn-secondary" data-pr-action="ready" ${blocked ? 'disabled' : ''}>转为 Ready</button>` : ''}
        ${pr.state === 'OPEN' ? `<button type="button" class="btn-secondary" data-pr-action="close" ${blocked ? 'disabled' : ''}>关闭 PR</button>` : ''}
        ${pr.state === 'CLOSED' ? `<button type="button" class="btn-secondary" data-pr-action="reopen" ${blocked ? 'disabled' : ''}>重新打开</button>` : ''}
        ${pr.state === 'OPEN' && !pr.isDraft ? `${workflowGateSelectHtml(project, 'merge', `pr:${pr.number}`, blocked)}<select class="pr-merge-method" ${blocked ? 'disabled' : ''}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select><button type="button" class="btn-primary" data-pr-action="merge" ${blocked || !strictMergeReady(pr) ? 'disabled' : ''}>合并 PR</button>` : ''}
      </div>`;
  }
  body.innerHTML = `
    <div class="pr-toolbar">
      <div><strong>${escapeHtml(repoName)}</strong><span>${escapeHtml(repo?.host || '')}</span></div>
      <label>状态 <select id="pr-state-filter">${filterOptions}</select></label>
      <button type="button" class="ghost-btn" id="btn-pr-refresh" ${pullRequestView.loading ? 'disabled' : ''}>${pullRequestView.loading ? '刷新中…' : '刷新'}</button>
    </div>
    ${pullRequestView.error ? `<div class="pr-error">${escapeHtml(pullRequestView.error)}</div>` : ''}
    <div class="pr-workspace">
      <div class="pr-list">${listHtml || `<div class="pr-empty-small">${pullRequestView.loading ? '正在读取 GitHub…' : '没有匹配的 PR'}</div>`}${pullRequestView.truncated ? '<div class="pr-truncated">仅显示前 50 条</div>' : ''}</div>
      <div class="pr-detail">${detailHtml}</div>
    </div>`;
  document.getElementById('pr-state-filter')?.addEventListener('change', (event) => {
    pullRequestView.filter = event.target.value;
    pullRequestView.selectedNumber = 0;
    pullRequestView.resultId = '';
    pullRequestView.detail = null;
    loadPullRequests();
  });
  document.getElementById('btn-pr-refresh')?.addEventListener('click', async () => {
    const number = pullRequestView.selectedNumber;
    const resultId = pullRequestView.resultId;
    await loadPullRequests({ keepDetail: true });
    if (number) loadPullRequestDetail(number, { resultId });
  });
  body.querySelectorAll('[data-pr-number]').forEach((button) => button.addEventListener('click', () => {
    pullRequestView.resultId = '';
    loadPullRequestDetail(Number(button.dataset.prNumber));
  }));
  body.querySelectorAll('[data-pr-action]').forEach((button) => button.addEventListener('click', () => runPullRequestAction(button.dataset.prAction)));
  body.querySelectorAll('[data-workflow-gate-select]').forEach((select) => select.addEventListener('change', () => {
    if (select.value) workflowGateSelections.set(select.dataset.workflowGateSelect, select.value);
    else workflowGateSelections.delete(select.dataset.workflowGateSelect);
  }));
  body.querySelectorAll('[data-workflow-gate-open]').forEach((button) => button.addEventListener('click', () => setView('scheduled')));
}

async function loadPullRequests({ keepDetail = false } = {}) {
  const project = sessionProject();
  resetPullRequestView(project);
  if (!project?.path || !window.codex?.listPullRequests) return renderPullRequestView();
  const sequence = ++pullRequestView.seq;
  pullRequestView.loading = true;
  pullRequestView.error = '';
  renderPullRequestView();
  try {
    const token = await bindWorktreeProject(project);
    if (!token) throw new Error('项目绑定已失效');
    const [response] = await Promise.all([
      window.codex.listPullRequests({ projectBindingId: token, state: pullRequestView.filter }),
      loadWorkflowGateRuns(project, token),
    ]);
    if (sequence !== pullRequestView.seq) return;
    if (!response?.ok) throw new Error(response?.error || '无法读取 PR 列表');
    pullRequestView.repo = response.repo || null;
    pullRequestView.prs = window.PullRequestState?.normalizeList(response.prs) || [];
    pullRequestView.truncated = response.truncated === true;
    if (!keepDetail) {
      pullRequestView.selectedNumber = 0;
      pullRequestView.resultId = '';
      pullRequestView.detail = null;
    }
  } catch (error) {
    if (sequence === pullRequestView.seq) pullRequestView.error = error?.message || String(error);
  } finally {
    if (sequence === pullRequestView.seq) {
      pullRequestView.loading = false;
      renderPullRequestView();
    }
  }
}

async function loadPullRequestDetail(number, { resultId = '' } = {}) {
  const project = sessionProject();
  if (!project?.path || !window.codex?.getPullRequest) return;
  const sequence = ++pullRequestView.detailSeq;
  pullRequestView.selectedNumber = Number(number) || 0;
  pullRequestView.resultId = String(resultId || '');
  pullRequestView.detail = null;
  pullRequestView.error = '';
  renderPullRequestView();
  try {
    const token = await bindWorktreeProject(project);
    if (!token) throw new Error('项目绑定已失效');
    const reference = pullRequestView.resultId ? { resultId: pullRequestView.resultId } : { number: pullRequestView.selectedNumber };
    const response = await window.codex.getPullRequest({ projectBindingId: token, ...reference });
    if (sequence !== pullRequestView.detailSeq) return;
    if (!response?.ok) throw new Error(response?.error || '无法读取 PR 详情');
    pullRequestView.repo = response.repo || pullRequestView.repo;
    pullRequestView.detail = window.PullRequestState?.normalize(response.pr, { detail: true }) || null;
    pullRequestView.selectedNumber = pullRequestView.detail?.number || pullRequestView.selectedNumber;
    if (response.result) attachWorktreeResult(response.result, project.id, response.result.sessionId);
    if (response.checksError) pullRequestView.error = response.checksError;
  } catch (error) {
    if (sequence === pullRequestView.detailSeq) pullRequestView.error = error?.message || String(error);
  } finally {
    if (sequence === pullRequestView.detailSeq) renderPullRequestView();
  }
}

async function runPullRequestAction(action) {
  const project = sessionProject();
  const pr = pullRequestView.detail;
  if (!project?.path || !pr || pullRequestView.busy) return;
  const token = await bindWorktreeProject(project);
  if (!token) return toast('项目绑定已失效');
  const reference = pullRequestReference();
  let invoke;
  let payload = { projectBindingId: token, ...reference };
  let question = '';
  if (action === 'open') {
    const response = await window.codex.openWorktreePr(payload);
    return toast(response?.ok ? '已在浏览器打开 PR' : (response?.error || '无法打开 PR'));
  }
  if (action === 'edit') {
    payload.title = document.querySelector('.pr-edit-title')?.value || '';
    payload.body = document.querySelector('.pr-edit-body')?.value || '';
    question = `确定更新 PR #${pr.number} 的标题和正文？`;
    invoke = window.codex.editPullRequest;
  } else if (action === 'comment') {
    payload.body = document.querySelector('.pr-comment-input')?.value || '';
    if (!payload.body.trim()) return toast('评论不能为空');
    question = `确定向 PR #${pr.number} 发布这条评论？`;
    invoke = window.codex.commentPullRequest;
  } else if (action === 'close') {
    question = `确定关闭 PR #${pr.number}？远端分支不会删除。`;
    invoke = window.codex.closePullRequest;
  } else if (action === 'reopen') {
    question = `确定重新打开 PR #${pr.number}？`;
    invoke = window.codex.reopenPullRequest;
  } else if (action === 'ready') {
    question = `确定把 Draft PR #${pr.number} 转为 Ready？`;
    invoke = window.codex.readyPullRequest;
  } else if (action === 'merge') {
    payload.method = document.querySelector('.pr-merge-method')?.value || 'squash';
    Object.assign(payload, workflowGatePayload(project, 'merge', `pr:${pr.number}`));
    question = `确定使用 ${payload.method.toUpperCase()} 合并 PR #${pr.number}？远端分支不会删除。`;
    invoke = window.codex.mergePullRequest;
  }
  if (typeof invoke !== 'function' || !(await appConfirm(question))) return;
  pullRequestView.busy = true;
  pullRequestView.error = '';
  renderPullRequestView();
  try {
    const response = await invoke(payload);
    if (!response?.ok) throw new Error(response?.error || 'PR 操作失败');
    pullRequestView.detail = window.PullRequestState?.normalize(response.pr, { detail: true }) || pullRequestView.detail;
    if (response.result) attachWorktreeResult(response.result, project.id, response.result.sessionId);
    const index = pullRequestView.prs.findIndex((item) => item.number === pullRequestView.detail?.number);
    if (index >= 0 && pullRequestView.detail) pullRequestView.prs[index] = { ...pullRequestView.prs[index], ...pullRequestView.detail, body: '' };
    toast(action === 'comment' ? '评论已发布' : action === 'merge' ? 'PR 已合并' : 'PR 已更新');
  } catch (error) {
    pullRequestView.error = error?.message || String(error);
    toast(pullRequestView.error);
  } finally {
    pullRequestView.busy = false;
    renderPullRequestView();
  }
}

function openPullRequestManager(ref) {
  const project = sessionProject();
  if (!project?.path || !ref?.pr?.number) return toast('PR 信息不可用');
  resetPullRequestView(project);
  pullRequestView.selectedNumber = Number(ref.pr.number);
  pullRequestView.resultId = String(ref.id || '');
  setView('prs');
  loadPullRequestDetail(ref.pr.number, { resultId: ref.id });
}

function showWorkView(view) {
  document.getElementById('view-chat').classList.add('hidden');
  document.getElementById('view-work').classList.remove('hidden');
  const titleMap = { scheduled: '工程中心', plugins: '插件', sites: '站点', prs: '拉取请求' };
  document.getElementById('work-title').textContent = titleMap[view] || '工作台';
  document.getElementById('work-sub').textContent = '可点击条目执行操作';
  const body = document.getElementById('work-body');
  if (view === 'scheduled') {
    renderEngineeringCenter().catch(() => {});
    loadMcpTasks().catch(() => {});
  }
  if (view === 'plugins') {
    body.innerHTML = '<div class="card-list">' + PLUGINS.map((p) => '<div class="work-card"><div class="work-card-title">🧩 ' + escapeHtml(p.name) + '</div><div class="work-card-meta">' + escapeHtml(p.desc) + '</div><label class="switch-row"><input type="checkbox" data-plugin="' + p.id + '" ' + (pluginState[p.id] ? 'checked' : '') + '/><span>' + (pluginState[p.id] ? '已启用' : '已禁用') + '</span></label></div>').join('') + '</div>';
    body.querySelectorAll('[data-plugin]').forEach((input) => input.addEventListener('change', () => { pluginState[input.dataset.plugin] = input.checked; saveState(); input.parentElement.querySelector('span').textContent = input.checked ? '已启用' : '已禁用'; toast((input.checked ? '启用' : '禁用') + '插件成功'); }));
  }
  if (view === 'sites') {
    body.innerHTML = '<div class="card-list">' + SITES.map((s) => '<div class="work-card"><div class="work-card-title">🌐 ' + escapeHtml(s.name) + '</div><div class="work-card-meta"><span class="badge ' + s.status + '">' + s.status + '</span> · ' + escapeHtml(s.url) + '</div><div class="work-card-actions"><button type="button" class="ghost-btn" data-site-open="' + s.id + '">复制 URL</button><button type="button" class="ghost-btn" data-site-chat="' + s.id + '">问 Codex</button></div></div>').join('') + '</div>';
    body.querySelectorAll('[data-site-open]').forEach((btn) => btn.addEventListener('click', async () => { const s = SITES.find((x) => x.id === btn.dataset.siteOpen); try { await navigator.clipboard.writeText(s.url); toast('已复制 URL'); } catch { toast(s.url, 4000); } }));
    body.querySelectorAll('[data-site-chat]').forEach((btn) => { const s = SITES.find((x) => x.id === btn.dataset.siteChat); btn.addEventListener('click', () => ensureTaskAndAsk('站点 ' + s.name, '站点 ' + s.name + '（' + s.url + '）状态 ' + s.status + '，给出巡检清单。')); });
  }
  if (view === 'prs') {
    renderPullRequestView();
    loadPullRequests({ keepDetail: Boolean(pullRequestView.selectedNumber) });
  }
  renderLeftDynamic();
}
function renderEmojiPanel() {
  const panel = document.getElementById('emoji-panel');
  panel.innerHTML = EMOJIS.map((e) => '<button type="button" class="emoji-item" data-emoji="' + e + '">' + e + '</button>').join('');
  panel.querySelectorAll('[data-emoji]').forEach((btn) => btn.addEventListener('click', () => { insertAtCursor(document.getElementById('chat-input'), btn.dataset.emoji); panel.classList.add('hidden'); document.getElementById('chat-input').focus(); }));
}
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const v = textarea.value; textarea.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length; textarea.selectionStart = textarea.selectionEnd = pos;
}

/* ========== @ 路径补全 ========== */
let atCompleteState = {
  open: false,
  items: [],
  index: 0,
  tokenStart: 0,
  tokenEnd: 0,
  prefix: '',
  reqId: 0,
};
let atCompleteTimer = null;

function ensureAtCompletePopup() {
  let el = document.getElementById('at-complete-popup');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'at-complete-popup';
  el.className = 'at-complete-popup hidden';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', '@ 路径补全');
  const composer = document.querySelector('.composer');
  if (composer) {
    if (getComputedStyle(composer).position === 'static') {
      composer.style.position = 'relative';
    }
    composer.appendChild(el);
  } else {
    document.body.appendChild(el);
  }
  return el;
}

function hideAtComplete() {
  atCompleteState.open = false;
  atCompleteState.items = [];
  atCompleteState.index = 0;
  const el = document.getElementById('at-complete-popup');
  if (el) {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

/**
 * Detect @token at cursor: @ + path chars (no space). Stops at :line-range.
 * @returns {{ start: number, end: number, prefix: string } | null}
 */
function findAtTokenAtCursor(text, cursor) {
  if (cursor == null || cursor < 0) return null;
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (/\s/.test(ch) || ch === '`' || ch === '"' || ch === "'" || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === ',' || ch === ';' || ch === '!' || ch === '?') {
      break;
    }
    i -= 1;
  }
  const start = i + 1;
  if (start >= cursor) return null;
  if (text[start] !== '@') return null;
  // skip email-like: word@path without space — require start-of-text or whitespace before @
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  const body = text.slice(start + 1, cursor);
  // no range complete (foo:1-10)
  if (body.includes(':')) return null;
  // allow empty prefix after @
  if (!/^[\w./\\%-]*$/.test(body)) return null;
  return { start, end: cursor, prefix: body.replace(/\\/g, '/') };
}

function renderAtCompletePopup() {
  const el = ensureAtCompletePopup();
  if (!atCompleteState.open || !atCompleteState.items.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = atCompleteState.items.map((item, i) => {
    const kind = item.type === 'dir' ? '目录' : '文件';
    const active = i === atCompleteState.index ? ' is-active' : '';
    return (
      '<button type="button" class="at-complete-item' + active + '" data-idx="' + i + '" role="option" aria-selected="' +
      (i === atCompleteState.index ? 'true' : 'false') + '">' +
      '<span class="at-complete-path">' + escapeHtml(item.path) + (item.type === 'dir' ? '/' : '') + '</span>' +
      '<span class="at-complete-kind">' + kind + '</span>' +
      '</button>'
    );
  }).join('');
  el.querySelectorAll('.at-complete-item').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.idx);
      applyAtComplete(idx);
    });
  });
  const active = el.querySelector('.at-complete-item.is-active');
  if (active && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function applyAtComplete(idx) {
  const item = atCompleteState.items[idx];
  const input = document.getElementById('chat-input');
  if (!item || !input) {
    hideAtComplete();
    return;
  }
  const insert = '@' + item.path + (item.type === 'dir' ? '/' : '');
  const v = input.value;
  const before = v.slice(0, atCompleteState.tokenStart);
  const after = v.slice(atCompleteState.tokenEnd);
  input.value = before + insert + after;
  const pos = before.length + insert.length;
  input.selectionStart = input.selectionEnd = pos;
  input.focus();
  hideAtComplete();
  // dir: keep completing for nested paths
  if (item.type === 'dir') {
    scheduleAtCompleteRefresh();
  }
}

async function refreshAtComplete() {
  const input = document.getElementById('chat-input');
  if (!input || !window.codex?.atRefComplete) {
    hideAtComplete();
    return;
  }
  const text = input.value || '';
  const cursor = input.selectionStart ?? text.length;
  const token = findAtTokenAtCursor(text, cursor);
  if (!token) {
    hideAtComplete();
    return;
  }
  const session = activeSession();
  const proj = sessionProject(session);
  if (!proj?.path) {
    hideAtComplete();
    return;
  }
  const reqId = ++atCompleteState.reqId;
  atCompleteState.tokenStart = token.start;
  atCompleteState.tokenEnd = token.end;
  atCompleteState.prefix = token.prefix;
  try {
    const res = await window.codex.atRefComplete({
      projectPath: proj.path,
      prefix: token.prefix,
    });
    if (reqId !== atCompleteState.reqId) return;
    const items = Array.isArray(res?.items) ? res.items : [];
    if (!items.length) {
      hideAtComplete();
      return;
    }
    atCompleteState.open = true;
    atCompleteState.items = items;
    atCompleteState.index = 0;
    renderAtCompletePopup();
  } catch {
    if (reqId === atCompleteState.reqId) hideAtComplete();
  }
}

function scheduleAtCompleteRefresh() {
  if (atCompleteTimer) clearTimeout(atCompleteTimer);
  atCompleteTimer = setTimeout(() => {
    atCompleteTimer = null;
    refreshAtComplete().catch(() => {});
  }, 100);
}

function onAtCompleteKeydown(e) {
  if (!atCompleteState.open || !atCompleteState.items.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    atCompleteState.index = (atCompleteState.index + 1) % atCompleteState.items.length;
    renderAtCompletePopup();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    atCompleteState.index = (atCompleteState.index - 1 + atCompleteState.items.length) % atCompleteState.items.length;
    renderAtCompletePopup();
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    applyAtComplete(atCompleteState.index);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideAtComplete();
    return true;
  }
  return false;
}

function bindAtComplete() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.addEventListener('input', () => scheduleAtCompleteRefresh());
  input.addEventListener('click', () => scheduleAtCompleteRefresh());
  input.addEventListener('keyup', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
    scheduleAtCompleteRefresh();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#at-complete-popup') && e.target !== input) {
      hideAtComplete();
    }
  });
}
function renderAttachPreview() {
  const box = document.getElementById('attach-preview');
  if (!pendingAttaches.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = pendingAttaches.map((a, i) => '<div class="attach-chip">' + (a.type.startsWith('image/') && a.dataUrl ? '<img src="' + a.dataUrl + '" alt="" />' : '📎') + '<span>' + escapeHtml(a.name) + '</span><button type="button" data-rm="' + i + '">×</button></div>').join('');
  box.querySelectorAll('[data-rm]').forEach((btn) => btn.addEventListener('click', () => { pendingAttaches.splice(Number(btn.dataset.rm), 1); renderAttachPreview(); }));
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}
async function handleFiles(fileList, asImage) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (asImage || file.type.startsWith('image/')) {
      if (file.size > 2 * 1024 * 1024) { toast('图片过大（>2MB）：' + file.name); continue; }
      pendingAttaches.push({ name: file.name, type: file.type || 'image/*', dataUrl: await readFileAsDataUrl(file) });
    } else pendingAttaches.push({ name: file.name, type: file.type || 'file', size: file.size });
  }
  renderAttachPreview(); toast('已添加 ' + files.length + ' 个附件');
}
function buildOutgoingText(raw) {
  let text = raw.trim();
  if (pendingAttaches.length) {
    const parts = pendingAttaches.map((a) => a.dataUrl ? ('![' + a.name + '](' + a.dataUrl + ')') : ('📎 附件：' + a.name + (a.size ? (' (' + Math.round(a.size / 1024) + ' KB)') : '')));
    text = [text, ...parts].filter(Boolean).join('\n\n');
  }
  return text;
}
function activeProjectPathForMcp() {
  return sessionProject(activeSession())?.path || '';
}
function handleMcpPromptsListCommand(command) {
  const parts = String(command || '').trim().split(/\s+/);
  const server = parts.length > 1 ? parts[1] : '';
  const target = activeSession();
  if (!window.codex?.listMcpPrompts) { toast('MCP prompts API 不可用'); return true; }
  window.codex.listMcpPrompts({ server }).then((result) => {
    if (!target) return;
    if (!result?.ok) { toast(result?.error || '读取 prompts 失败'); return; }
    const lines = (result.prompts || []).map((prompt) => `- ${prompt.server}/${prompt.name}${prompt.description ? `：${prompt.description}` : ''}`);
    target.messages.push({ role: 'assistant', content: lines.length ? `MCP prompts：\n${lines.join('\n')}` : '没有可用的 MCP prompts。' });
    target.updatedAt = Date.now();
    saveState();
    if (target.id === activeSessionId) renderMessages();
  }).catch((error) => toast(error?.message || String(error)));
  return true;
}
function handleMcpPromptGetCommand(command) {
  const text = String(command || '').trim();
  const match = /^\/mcp-prompt\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(text);
  if (!match) { toast('用法：/mcp-prompt <server> <name> [JSON arguments]'); return true; }
  let args = {};
  if (match[3]) {
    try { args = JSON.parse(match[3]); } catch { toast('arguments 必须是 JSON 对象'); return true; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) { toast('arguments 必须是 JSON 对象'); return true; }
  }
  if (!window.codex?.getMcpPrompt) { toast('MCP prompts API 不可用'); return true; }
  window.codex.getMcpPrompt({ server: match[1], name: match[2], arguments: args }).then((result) => {
    if (!result?.ok) { toast(result?.error || '读取 prompt 失败'); return; }
    const input = document.getElementById('chat-input');
    if (input) { input.value = result.text || ''; input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); }
    toast('Prompt 已填入输入框，可编辑后发送');
  }).catch((error) => toast(error?.message || String(error)));
  return true;
}
function handleSlashCommand(text) {
  const cmd = text.trim(); const lower = cmd.toLowerCase();
  if (lower === '/help') {
    activeSession().messages.push({
      role: 'assistant',
      content: '命令：/help /clear /mode /new 标题 /ls /skills /skill <name> /compact /export md|json /remember /memory /forget /mcp-prompts /mcp-prompt\n'
        + '/compact：把更早的消息压缩成一条摘要，保留最近若干条原文（生成中不可用）\n'
        + '/export md｜/export json：导出当前会话，路径在保存对话框里选\n'
        + '/fetch <url>：抓取网页正文进会话（需先开启网页访问）；/usage：查看 token 用量\n'
        + '/remember <事实>：记入长期记忆（绑定项目时进项目级，否则用户级）\n'
        + '/memory：列出长期记忆；/forget <id>：删除一条\n'
        + '/mcp-prompts [server]：列出 MCP prompts；/mcp-prompt <server> <name> [JSON arguments]：填入输入框\n'
        + '任务/项目右键：置顶、删除、绑定目录\n项目对话可读写真实文件（需绑定）',
    });
    saveState(); renderMessages(); return true;
  }
  if (lower === '/clear') { clearCurrentChat(); return true; }
  if (lower === '/mode') {
    updateStatusBar().then(() => { activeSession().messages.push({ role: 'assistant', content: '状态：' + document.getElementById('status-left').textContent + ' / ' + document.getElementById('status-mid').textContent }); saveState(); renderMessages(); });
    return true;
  }
  if (lower === '/ls' || lower === '/tree') { document.getElementById('chat-input').value = '列出文件'; sendMessage(); return true; }
  if (lower.startsWith('/new ')) { document.getElementById('task-title').value = cmd.slice(5).trim() || '未命名任务'; document.getElementById('task-brief').value = ''; createTaskFromModal(); return true; }
  if (lower === '/skills') {
    const proj = sessionProject(activeSession());
    window.codex.listSkills({ projectPath: proj?.path || null }).then((r) => {
      const lines = (r.skills || []).map((s) => `- **${s.name}** (${s.source}): ${s.description || ''}`);
      activeSession().messages.push({
        role: 'assistant',
        content: lines.length ? ('可用 Skills：\n' + lines.join('\n')) : '暂无 Skills。',
      });
      saveState(); renderMessages();
    }).catch((e) => toast(e.message || String(e)));
    return true;
  }
  if (lower === '/compact') {
    runCompactOnSession(activeSession(), { force: true }).catch((e) => toast(e.message || String(e)));
    return true;
  }
  if (lower === '/export' || lower.startsWith('/export ')) {
    const arg = lower === '/export' ? '' : lower.slice('/export '.length).trim();
    if (!arg || arg === 'md' || arg === 'markdown') {
      runExportOnSession(activeSession(), 'md').catch((e) => toast(e.message || String(e)));
    } else if (arg === 'json') {
      runExportOnSession(activeSession(), 'json').catch((e) => toast(e.message || String(e)));
    } else {
      toast('用法：/export md 或 /export json');
    }
    return true;
  }
  if (lower.startsWith('/fetch ')) {
    const url = cmd.slice(7).trim();
    if (!url) { toast('用法：/fetch <url>'); return true; }
    const targetSession = activeSession();
    toast('抓取中…');
    window.codex.webFetch({ url }).then((result) => {
      if (!targetSession) return;
      if (!result.ok) {
        targetSession.messages.push({
          role: 'assistant',
          content: `网页抓取失败（${result.code || '?'}）：${result.error || ''}`,
          error: true,
        });
      } else {
        const head = `【网页】${result.title ? result.title + ' ' : ''}${result.url}`
          + (result.truncated ? '（已截断）' : '');
        targetSession.messages.push({ role: 'assistant', content: head + '\n\n' + result.text });
      }
      targetSession.updatedAt = Date.now();
      saveState();
      if (targetSession.id === activeSessionId) renderMessages();
    }).catch((error) => toast(error.message || String(error)));
    return true;
  }
  if (lower === '/usage') {
    const targetSession = activeSession();
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const week = new Date(today);
    week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
    const query = (from, groupBy) => window.codex.usageSummary({
      ...(from ? { from, to: now } : {}),
      groupBy,
    });
    Promise.all([
      query(today.getTime(), 'kind'),
      query(today.getTime(), 'model'),
      query(week.getTime(), 'kind'),
      query(week.getTime(), 'model'),
      query(0, 'kind'),
      query(0, 'model'),
    ]).then(([todayKind, todayModel, weekKind, weekModel, totalKind, totalModel]) => {
      if (!targetSession) return;
      if (!totalKind.ok) {
        targetSession.messages.push({ role: 'assistant', content: totalKind.error, error: true });
      } else {
        const currency = totalKind.currency || '$';
        const fmtCost = (cost) => cost > 0 ? ` ${currency}${cost.toFixed(4)}` : '';
        const section = (label, byKind, byModel) => {
          if (!byKind?.ok) return [`${label}：${byKind?.error || '读取失败'}`];
          const lines = [
            `${label}：↑${fmtTok(byKind.totals.in)} ↓${fmtTok(byKind.totals.out)}`
              + fmtCost(byKind.totals.cost)
              + (byKind.totals.estimatedShare > 0
                ? `（约 ${(byKind.totals.estimatedShare * 100).toFixed(0)}% 为估算）`
                : ''),
            '  按来源：' + (byKind.groups.length
              ? byKind.groups.map((group) => `${group.key} ↑${fmtTok(group.in)} ↓${fmtTok(group.out)}${fmtCost(group.cost)}`).join('；')
              : '无'),
            '  按模型：' + (byModel?.ok && byModel.groups.length
              ? byModel.groups.map((group) => `${group.key} ↑${fmtTok(group.in)} ↓${fmtTok(group.out)}${fmtCost(group.cost)}`).join('；')
              : '无'),
          ];
          return lines;
        };
        const lines = [
          ...section('今日', todayKind, todayModel),
          ...section('本周', weekKind, weekModel),
          ...section('总计', totalKind, totalModel),
        ];
        if (totalKind.skipped) lines.push(`（${totalKind.skipped} 条损坏记录已跳过）`);
        if (totalKind.mixedCurrencies?.length) {
          lines.push(`（未合计其他币种：${totalKind.mixedCurrencies.join('、')}）`);
        }
        targetSession.messages.push({ role: 'assistant', content: lines.join('\n') });
      }
      targetSession.updatedAt = Date.now();
      saveState();
      if (targetSession.id === activeSessionId) renderMessages();
    }).catch((error) => toast(error.message || String(error)));
    return true;
  }
  const memorySession = activeSession();
  if (window.CodexMemoryCommands?.handleMemoryCommand(cmd, {
    session: memorySession,
    projectPath: sessionProject(memorySession)?.path || null,
    addMemory: (payload) => window.codex.addMemory(payload),
    listMemory: (payload) => window.codex.listMemory(payload),
    deleteMemory: (payload) => window.codex.deleteMemory(payload),
    toast,
    onMessagesChanged: (session) => {
      session.updatedAt = Date.now();
      saveState();
      if (activeSession() === session) renderMessages();
    },
  })) return true;
  if (lower.startsWith('/skill ')) {
    const name = cmd.slice(7).trim();
    const proj = sessionProject(activeSession());
    window.codex.getSkill({ name, projectPath: proj?.path || null }).then((r) => {
      if (!r.ok) {
        toast(r.error || '未找到 skill');
        return;
      }
      document.getElementById('chat-input').value =
        `请按技能 ${r.name} 执行：\n\n${r.body}`;
      sendMessage();
    }).catch((e) => toast(e.message || String(e)));
    return true;
  }
  return false;
}
function clearCurrentChat() {
  const s = activeSession(); s.messages = [{ role: 'assistant', content: '会话已清空。继续说吧。' }]; s.updatedAt = Date.now(); saveState(); renderMessages(); toast('已清空当前会话');
}

/* ---- Phase D.1: session compact + export ------------------------------- */

/** Structured-clone safe copy; session objects come from localStorage so this is cheap. */
function cloneForIpc(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * One IPC round trip: main plans, summarizes and applies, then hands back the
 * new messages array. The sandboxed preload cannot require the pure helpers.
 */
async function requestCompact(session, force) {
  const originProjectRef = currentProjectRef(session);
  const res = await window.codex.compactSession({
    force: !!force,
    sessionId: String(session?.id || ''),
    messages: cloneForIpc(session?.messages || []),
    candidateLimit: window.MemoryCandidateState.candidateLimit(
      ensureSessionCandidateState(session),
      { perBatch: window.MemoryCandidateState.PER_BATCH_MAX, max: window.MemoryCandidateState.PENDING_MAX }
    ),
  });
  if (res.usage) applyUsageToSession(session, res.usage);
  return { response: res, originProjectRef };
}

function applyCompactResult(session, response, originProjectRef) {
  if (!Array.isArray(response.messages)) throw new Error('压缩结果缺少消息');
  session.messages = response.messages;
  session.updatedAt = Date.now();
  saveState();
  if (session.id === activeSessionId) renderMessages();

  const merged = window.MemoryCandidateState.mergePendingCandidates(
    ensureSessionCandidateState(session),
    response.candidates,
    {
      max: window.MemoryCandidateState.PENDING_MAX,
      defaultScope: originProjectRef ? 'project' : 'user',
      projectRef: originProjectRef,
    }
  );
  session.pendingMemoryCandidates = merged.items;
  saveState();
  updateMemoryCandidateCount();
  return merged;
}

/** Manual `/compact` and the 压缩 button. Refuses while a run is live. */
async function runCompactOnSession(session, { force } = {}) {
  if (!session) return false;
  if (sending || (chatRun && !chatRun.finalized)) {
    toast('请先停止生成，再压缩会话');
    return false;
  }
  const btn = document.getElementById('btn-compact');
  if (btn) btn.disabled = true;
  try {
    const { response: res, originProjectRef } = await requestCompact(session, force);
    if (!res || res.ok === false) {
      toast('压缩失败：' + (res?.error || '未知错误'));
      return false;
    }
    if (!res.needed) {
      toast(force ? '无需压缩：没有可压缩的更早消息' : '未达压缩阈值');
      if (force && activeSessionId === session.id && ensureSessionCandidateState(session).length > 0) {
        openMemoryCandidateReview(session).catch((error) => toast(error?.message || String(error)));
      }
      return false;
    }
    const merged = applyCompactResult(session, res, originProjectRef);
    if (res.candidateWarning) {
      toast('已完成压缩；候选提炼失败');
    } else if (merged.added > 0) {
      toast(`已压缩更早 ${res.compactedCount} 条，提炼 ${merged.added} 条候选`);
    } else {
      toast('已压缩更早 ' + res.compactedCount + ' 条消息');
    }
    if (activeSessionId === session.id && ensureSessionCandidateState(session).length > 0) {
      openMemoryCandidateReview(session, {
        notice: merged.dropped > 0 ? '候选箱已满，部分新候选未保存' : '',
      }).catch((error) => toast(error?.message || String(error)));
    }
    return true;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Send-time auto compact. Never blocks the send — failures are swallowed. */
async function maybeAutoCompact(session) {
  if (!session) return false;
  try {
    const st = await window.codex.getSettings();
    if (st?.autoCompact !== true) return false;
    const { response: res, originProjectRef } = await requestCompact(session, false);
    if (!res?.ok || !res.needed) return false;
    const merged = applyCompactResult(session, res, originProjectRef);
    const suffix = merged.added > 0 ? `；已新增 ${merged.added} 条记忆候选` : '';
    toast('发送前已自动压缩 ' + res.compactedCount + ' 条' + suffix);
    return true;
  } catch {
    return false;
  }
}

/** `/export md|json` and the 导出 buttons. Allowed even while a run is live. */
async function runExportOnSession(session, format) {
  if (!session) return false;
  const fmt = format === 'json' ? 'json' : 'md';
  const res = await window.codex.exportSession({ format: fmt, session: cloneForIpc(session) });
  if (res?.canceled) return false;
  if (!res?.ok) {
    toast('导出失败：' + (res?.error || '未知错误'));
    return false;
  }
  toast('已导出：' + res.path);
  return true;
}
/** In-memory MCP server list for settings UI (list is source of truth). */
let mcpServerDrafts = [];
let mcpSavedFingerprint = '';
const mcpOAuthStatuses = new Map();
const mcpOAuthFlowIds = new Map();
const mcpOAuthErrors = new Map();

function normalizeMcpTransport(t) {
  const x = String(t || '').toLowerCase();
  if (x === 'sse' || x === 'http' || x === 'stdio') return x;
  return 'stdio';
}

function cloneMcpOAuth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of [
    'clientId',
    'resource',
    'authorizationServer',
    'authorizationEndpoint',
    'tokenEndpoint',
    'registrationEndpoint',
    'revocationEndpoint',
  ]) {
    const value = String(raw[key] || '').trim();
    if (value) out[key] = value;
  }
  if (lower === '/mcp-prompts' || lower.startsWith('/mcp-prompts ')) return handleMcpPromptsListCommand(cmd);
  if (lower === '/mcp-prompt' || lower.startsWith('/mcp-prompt ')) return handleMcpPromptGetCommand(cmd);
  if (Array.isArray(raw.scopes)) {
    const scopes = raw.scopes.map((value) => String(value || '').trim()).filter(Boolean);
    if (scopes.length) out.scopes = [...new Set(scopes)].slice(0, 32);
  }
  return out;
}

function cloneMcpServer(s) {
  const transport = normalizeMcpTransport(s?.transport || (s?.url ? 'http' : 'stdio'));
  const out = {
    name: String(s?.name || ''),
    transport,
    enabled: s?.enabled === false ? false : true,
    command: String(s?.command || ''),
    url: String(s?.url || ''),
    sessionRecovery: s?.sessionRecovery === true,
    sampling: { enabled: s?.sampling?.enabled === true },
    tasks: { enabled: s?.tasks?.enabled === true, defaultTtlMs: Number(s?.tasks?.defaultTtlMs) || 3600000 },
    elicitation: { enabled: s?.elicitation?.enabled !== false, allowPrivateUrl: s?.elicitation?.allowPrivateUrl === true },
    roots: Array.isArray(s?.roots) ? s.roots.map((root) => ({ rootId: String(root?.rootId || ''), label: String(root?.label || '') })).filter((root) => root.rootId && root.label) : [],
    session: s?.session && typeof s.session === 'object' ? { state: String(s.session.state || 'disabled'), reusable: s.session.reusable === true, lastErrorCode: s.session.lastErrorCode ? String(s.session.lastErrorCode) : null } : undefined,
  };
  if (Array.isArray(s?.args)) out.args = s.args.map(String);
  if (s?.env && typeof s.env === 'object' && !Array.isArray(s.env)) out.env = { ...s.env };
  if (s?.cwd) out.cwd = String(s.cwd);
  if (s?.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) {
    out.headers = { ...s.headers };
  }
  if (s?.timeoutMs != null && Number.isFinite(Number(s.timeoutMs))) {
    out.timeoutMs = Number(s.timeoutMs);
  }
  if (transport !== 'stdio') {
    out.allowPrivate = s?.allowPrivate === true;
    out.auth = s?.auth === 'oauth' ? 'oauth' : 'none';
    if (out.auth === 'oauth') out.oauth = cloneMcpOAuth(s?.oauth);
  }
  return out;
}

function serializeMcpServerList() {
  return mcpServerDrafts.map((s) => {
    const transport = normalizeMcpTransport(s.transport);
    const base = {
      name: String(s.name || '').trim(),
      transport,
      enabled: s.enabled !== false,
      sessionRecovery: s.sessionRecovery === true,
      sampling: { enabled: s.sampling?.enabled === true },
      tasks: { enabled: s.tasks?.enabled === true, defaultTtlMs: Number(s.tasks?.defaultTtlMs) || 3600000 },
      elicitation: { enabled: s.elicitation?.enabled !== false, allowPrivateUrl: s.elicitation?.allowPrivateUrl === true },
      roots: Array.isArray(s.roots) ? s.roots.map((root) => ({ rootId: String(root?.rootId || ''), label: String(root?.label || '') })).filter((root) => root.rootId && root.label).slice(0, 8) : [],
    };
    if (transport === 'stdio') {
      base.command = String(s.command || '').trim();
      if (Array.isArray(s.args) && s.args.length) base.args = s.args.map(String);
      if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) base.env = { ...s.env };
      if (s.cwd) base.cwd = String(s.cwd);
    } else {
      base.url = String(s.url || '').trim();
      if (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) {
        base.headers = { ...s.headers };
      }
      base.allowPrivate = s.allowPrivate === true;
      base.auth = s.auth === 'oauth' ? 'oauth' : 'none';
      if (base.auth === 'oauth') base.oauth = cloneMcpOAuth(s.oauth);
    }
    if (s.timeoutMs != null && Number.isFinite(Number(s.timeoutMs))) {
      base.timeoutMs = Number(s.timeoutMs);
    }
    return base;
  });
}

function mcpConfigFingerprint(list) {
  try { return JSON.stringify(Array.isArray(list) ? list : []); } catch { return ''; }
}

async function refreshMcpOAuthStatuses() {
  if (!window.codex?.getMcpOAuthStatus) return;
  try {
    const result = await window.codex.getMcpOAuthStatus();
    mcpOAuthStatuses.clear();
    for (const status of result?.statuses || []) {
      if (status?.name) mcpOAuthStatuses.set(status.name, status);
    }
    renderMcpServerList();
  } catch {
    // OAuth status is supplementary; settings remain usable when it is unavailable.
  }
}

function mcpOAuthStatusText(status, flowId, errorCode) {
  if (flowId) return '授权处理中';
  if (status?.authorized) {
    if (status.expiresAt && status.expiresAt <= Date.now()) return '已过期，可刷新';
    return status.canRefresh ? '已授权 · 可刷新' : '已授权';
  }
  if (errorCode) return `授权失败 · ${errorCode}`;
  if (status?.persistence === 'memory') return '未授权 · 仅内存存储可用';
  return '未授权';
}

async function authorizeMcpServerRow(idx, resultEl) {
  const draft = mcpServerDrafts[idx];
  if (!draft || draft.auth !== 'oauth' || !window.codex?.startMcpOAuth) return;
  const saved = await window.codex.getSettings();
  const current = serializeMcpServerList()[idx];
  const savedCfg = (saved?.mcpServers || []).find((item) => item.name === current?.name);
  if (!savedCfg || mcpConfigFingerprint([savedCfg]) !== mcpConfigFingerprint([current])) {
    if (resultEl) {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = '请先保存当前 OAuth 配置，再开始授权';
    }
    return;
  }
  if (resultEl) {
    resultEl.className = 'mcp-test-result';
    resultEl.textContent = '正在打开系统浏览器授权…';
  }
  try {
    const result = await window.codex.startMcpOAuth({ name: current.name });
    if (result?.ok) {
      mcpOAuthErrors.delete(current.name);
      await refreshMcpOAuthStatuses();
    } else if (resultEl) {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = `授权失败：${result?.code || result?.error || '未知错误'}`;
    }
  } catch (error) {
    if (resultEl) {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = `授权失败：${error?.message || String(error)}`;
    }
  }
}

async function cancelMcpOAuthForRow(idx) {
  const name = String(mcpServerDrafts[idx]?.name || '').trim();
  const flowId = mcpOAuthFlowIds.get(name);
  if (!flowId || !window.codex?.cancelMcpOAuth) return;
  await window.codex.cancelMcpOAuth({ flowId });
}

async function logoutMcpOAuthForRow(idx, resultEl) {
  const name = String(mcpServerDrafts[idx]?.name || '').trim();
  if (!name || !window.codex?.logoutMcpOAuth) return;
  try {
    const result = await window.codex.logoutMcpOAuth({ name });
    await refreshMcpOAuthStatuses();
    if (resultEl) {
      resultEl.className = result?.code ? 'mcp-test-result err' : 'mcp-test-result ok';
      resultEl.textContent = result?.code
        ? `已退出本地授权，远端撤销警告：${result.code}`
        : '已退出授权';
    }
  } catch (error) {
    if (resultEl) {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = `退出授权失败：${error?.message || String(error)}`;
    }
  }
}

function setMcpServerDrafts(list) {
  mcpServerDrafts = Array.isArray(list) ? list.map(cloneMcpServer) : [];
  renderMcpServerList();
}

function hideMcpImportPanel() {
  const panel = document.getElementById('mcp-import-panel');
  if (panel) panel.classList.add('hidden');
  const ta = document.getElementById('mcp-import-json');
  if (ta) ta.value = '';
}

function renderMcpServerList() {
  const root = document.getElementById('mcp-server-list');
  if (!root) return;
  root.innerHTML = '';
  if (!mcpServerDrafts.length) {
    const empty = document.createElement('div');
    empty.className = 'mcp-server-empty';
    empty.textContent = '暂无 MCP 服务器，可添加或从 JSON 导入';
    root.appendChild(empty);
    return;
  }
  mcpServerDrafts.forEach((s, idx) => {
    const transport = normalizeMcpTransport(s.transport);
    const row = document.createElement('div');
    row.className = 'mcp-server-row';
    row.dataset.idx = String(idx);

    const enLabel = document.createElement('label');
    enLabel.className = 'mcp-en';
    enLabel.title = '启用';
    const en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = s.enabled !== false;
    en.addEventListener('change', () => {
      mcpServerDrafts[idx].enabled = en.checked;
    });
    enLabel.appendChild(en);

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'mcp-name';
    name.placeholder = '名称';
    name.value = s.name || '';
    name.addEventListener('input', () => {
      mcpServerDrafts[idx].name = name.value;
    });

    const tr = document.createElement('select');
    tr.className = 'mcp-transport';
    for (const opt of ['stdio', 'sse', 'http']) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === transport) o.selected = true;
      tr.appendChild(o);
    }
    tr.addEventListener('change', () => {
      mcpServerDrafts[idx].transport = normalizeMcpTransport(tr.value);
      renderMcpServerList();
    });

    const endpoint = document.createElement('input');
    endpoint.type = 'text';
    endpoint.className = 'mcp-endpoint';
    if (transport === 'stdio') {
      endpoint.placeholder = '命令（如 npx）';
      endpoint.value = s.command || '';
      endpoint.addEventListener('input', () => {
        mcpServerDrafts[idx].command = endpoint.value;
      });
    } else {
      endpoint.placeholder = 'URL（https://…）';
      endpoint.value = s.url || '';
      endpoint.addEventListener('input', () => {
        mcpServerDrafts[idx].url = endpoint.value;
      });
    }

    const resultEl = document.createElement('div');
    resultEl.className = 'mcp-test-result';
    const sessionEl = document.createElement('span');
    sessionEl.className = 'mcp-session-status';
    const sessionState = String(s.session?.state || (s.sessionRecovery ? 'idle' : 'disabled'));
    sessionEl.textContent = `会话：${sessionState}${s.session?.lastErrorCode ? ` · ${s.session.lastErrorCode}` : ''}`;
    sessionEl.title = s.session?.reusable ? '当前进程内可复用，空闲 5 分钟回收' : '每次 run 独立连接';
    row.appendChild(sessionEl);

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn-small mcp-test';
    testBtn.textContent = '测试';
    testBtn.addEventListener('click', () => testMcpServerRow(idx, resultEl, testBtn));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small mcp-del';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      mcpServerDrafts.splice(idx, 1);
      renderMcpServerList();
    });

    row.appendChild(enLabel);
    row.appendChild(name);
    row.appendChild(tr);
    row.appendChild(endpoint);
    row.appendChild(testBtn);
    row.appendChild(delBtn);
    row.appendChild(resultEl);

    const d9Options = document.createElement('div');
    d9Options.className = 'mcp-d9-options';
    const recoveryLabel = document.createElement('label');
    const recovery = document.createElement('input');
    recovery.type = 'checkbox';
    recovery.checked = s.sessionRecovery === true;
    recovery.addEventListener('change', () => { mcpServerDrafts[idx].sessionRecovery = recovery.checked; });
    recoveryLabel.appendChild(recovery);
    recoveryLabel.appendChild(document.createTextNode('进程内恢复'));
    recoveryLabel.title = '仅在当前应用进程内复用，空闲 5 分钟回收；默认关闭';
    d9Options.appendChild(recoveryLabel);

    const samplingLabel = document.createElement('label');
    const sampling = document.createElement('input');
    sampling.type = 'checkbox';
    sampling.checked = s.sampling?.enabled === true;
    sampling.addEventListener('change', () => { if (!mcpServerDrafts[idx].sampling) mcpServerDrafts[idx].sampling = {}; mcpServerDrafts[idx].sampling.enabled = sampling.checked; });
    samplingLabel.appendChild(sampling);
    samplingLabel.appendChild(document.createTextNode('允许 Sampling（每次询问）'));
    samplingLabel.title = '服务端请求模型采样时始终需要审批，full-auto 也不会绕过';
    d9Options.appendChild(samplingLabel);

    const tasksLabel = document.createElement('label');
    const tasksInput = document.createElement('input');
    tasksInput.type = 'checkbox';
    tasksInput.checked = s.tasks?.enabled === true;
    tasksInput.addEventListener('change', () => { if (!mcpServerDrafts[idx].tasks) mcpServerDrafts[idx].tasks = {}; mcpServerDrafts[idx].tasks.enabled = tasksInput.checked; });
    tasksLabel.appendChild(tasksInput);
    tasksLabel.appendChild(document.createTextNode('允许后台 Tasks'));
    tasksLabel.title = '仅在服务端声明 task 能力且工具允许时生效，默认关闭';
    d9Options.appendChild(tasksLabel);

    const ttlLabel = document.createElement('label');
    ttlLabel.appendChild(document.createTextNode('默认 TTL'));
    const ttlInput = document.createElement('input');
    ttlInput.type = 'number';
    ttlInput.min = '60000';
    ttlInput.max = '86400000';
    ttlInput.step = '60000';
    ttlInput.value = String(Number(s.tasks?.defaultTtlMs) || 3600000);
    ttlInput.addEventListener('change', () => { if (!mcpServerDrafts[idx].tasks) mcpServerDrafts[idx].tasks = {}; mcpServerDrafts[idx].tasks.defaultTtlMs = Number(ttlInput.value) || 3600000; });
    ttlLabel.appendChild(ttlInput);
    d9Options.appendChild(ttlLabel);

    const elicitationLabel = document.createElement('label');
    const elicitationInput = document.createElement('input');
    elicitationInput.type = 'checkbox';
    elicitationInput.checked = s.elicitation?.enabled !== false;
    elicitationInput.addEventListener('change', () => { if (!mcpServerDrafts[idx].elicitation) mcpServerDrafts[idx].elicitation = {}; mcpServerDrafts[idx].elicitation.enabled = elicitationInput.checked; });
    elicitationLabel.appendChild(elicitationInput);
    elicitationLabel.appendChild(document.createTextNode('允许 Elicitation'));
    d9Options.appendChild(elicitationLabel);
    const privateElicitationLabel = document.createElement('label');
    const privateElicitationInput = document.createElement('input');
    privateElicitationInput.type = 'checkbox';
    privateElicitationInput.checked = s.elicitation?.allowPrivateUrl === true;
    privateElicitationInput.addEventListener('change', () => { if (!mcpServerDrafts[idx].elicitation) mcpServerDrafts[idx].elicitation = {}; mcpServerDrafts[idx].elicitation.allowPrivateUrl = privateElicitationInput.checked; });
    privateElicitationLabel.appendChild(privateElicitationInput);
    privateElicitationLabel.appendChild(document.createTextNode('开发环境允许 Elicitation 私网 URL'));
    d9Options.appendChild(privateElicitationLabel);

    const rootsBox = document.createElement('div');
    rootsBox.className = 'mcp-roots-box';
    const rootsTitle = document.createElement('span');
    rootsTitle.textContent = 'Roots（仅标签）';
    rootsBox.appendChild(rootsTitle);
    const rootsList = document.createElement('span');
    rootsList.className = 'mcp-roots-list';
    rootsList.textContent = (s.roots || []).length ? s.roots.map((root) => root.label).join('、') : '未授权额外目录';
    rootsBox.appendChild(rootsList);
    const addRoot = document.createElement('button');
    addRoot.type = 'button';
    addRoot.className = 'btn-small';
    addRoot.textContent = '选择目录';
    addRoot.addEventListener('click', async () => {
      if (!window.codex?.chooseMcpRoot) return;
      const result = await window.codex.chooseMcpRoot({ name: mcpServerDrafts[idx].name });
      if (result?.ok && result.settings?.mcpServers) {
        const saved = result.settings.mcpServers.find((item) => item.name === mcpServerDrafts[idx].name);
        if (saved) mcpServerDrafts[idx] = cloneMcpServer(saved);
        renderMcpServerList();
      } else if (!result?.canceled) toast(result?.error || '目录授权失败');
    });
    rootsBox.appendChild(addRoot);
    (s.roots || []).forEach((root) => {
      const removeRoot = document.createElement('button');
      removeRoot.type = 'button';
      removeRoot.className = 'btn-small';
      removeRoot.textContent = `移除 ${root.label}`;
      removeRoot.addEventListener('click', async () => {
        const result = await window.codex.removeMcpRoot({ name: mcpServerDrafts[idx].name, rootId: root.rootId });
        if (result?.ok && result.settings?.mcpServers) {
          const saved = result.settings.mcpServers.find((item) => item.name === mcpServerDrafts[idx].name);
          if (saved) mcpServerDrafts[idx] = cloneMcpServer(saved);
          renderMcpServerList();
        } else toast(result?.error || '移除目录失败');
      });
      rootsBox.appendChild(removeRoot);
    });
    d9Options.appendChild(rootsBox);
    row.appendChild(d9Options);

    if (transport !== 'stdio') {
      const remoteOptions = document.createElement('div');
      remoteOptions.className = 'mcp-remote-options';

      const authLabel = document.createElement('label');
      authLabel.textContent = '认证';
      const authSelect = document.createElement('select');
      authSelect.className = 'mcp-auth-mode';
      for (const value of ['none', 'oauth']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'oauth' ? 'OAuth' : '无';
        option.selected = (s.auth || 'none') === value;
        authSelect.appendChild(option);
      }
      authSelect.addEventListener('change', () => {
        mcpServerDrafts[idx].auth = authSelect.value === 'oauth' ? 'oauth' : 'none';
        renderMcpServerList();
      });
      authLabel.appendChild(authSelect);
      remoteOptions.appendChild(authLabel);

      const privateLabel = document.createElement('label');
      privateLabel.className = 'mcp-private-toggle';
      const privateInput = document.createElement('input');
      privateInput.type = 'checkbox';
      privateInput.checked = s.allowPrivate === true;
      privateInput.addEventListener('change', () => {
        mcpServerDrafts[idx].allowPrivate = privateInput.checked;
      });
      privateLabel.appendChild(privateInput);
      privateLabel.appendChild(document.createTextNode('允许私网地址'));
      privateLabel.title = '仅 MCP transport 生效；OAuth endpoint 仍要求公共 HTTPS';
      remoteOptions.appendChild(privateLabel);

      const status = mcpOAuthStatuses.get(String(s.name || '').trim());
      const flowId = mcpOAuthFlowIds.get(String(s.name || '').trim());
      const statusEl = document.createElement('span');
      statusEl.className = 'mcp-oauth-status';
      statusEl.textContent = s.auth === 'oauth'
        ? mcpOAuthStatusText(status, flowId, mcpOAuthErrors.get(String(s.name || '').trim()))
        : '未使用 OAuth';
      remoteOptions.appendChild(statusEl);

      if (s.auth === 'oauth') {
        const authorizeBtn = document.createElement('button');
        authorizeBtn.type = 'button';
        authorizeBtn.className = 'btn-small';
        authorizeBtn.textContent = flowId ? '取消授权' : (status?.authorized ? '重新授权' : '授权');
        authorizeBtn.disabled = !String(s.name || '').trim();
        authorizeBtn.addEventListener('click', () => {
          if (flowId) cancelMcpOAuthForRow(idx).catch(() => {});
          else authorizeMcpServerRow(idx, resultEl).catch(() => {});
        });
        remoteOptions.appendChild(authorizeBtn);

        if (status?.authorized && !flowId) {
          const logoutBtn = document.createElement('button');
          logoutBtn.type = 'button';
          logoutBtn.className = 'btn-small';
          logoutBtn.textContent = '退出授权';
          logoutBtn.addEventListener('click', () => logoutMcpOAuthForRow(idx, resultEl));
          remoteOptions.appendChild(logoutBtn);
        }

        const oauthEditor = document.createElement('div');
        oauthEditor.className = 'mcp-oauth-editor';
        const oauth = s.oauth || {};
        const fields = [
          ['clientId', '公开 clientId'],
          ['resource', 'resource（可选）'],
          ['authorizationServer', 'authorization server（可选）'],
          ['authorizationEndpoint', 'authorization endpoint（可选）'],
          ['tokenEndpoint', 'token endpoint（可选）'],
          ['registrationEndpoint', 'registration endpoint（可选）'],
          ['revocationEndpoint', 'revocation endpoint（可选）'],
        ];
        for (const [key, placeholder] of fields) {
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = placeholder;
          input.value = oauth[key] || '';
          input.dataset.oauthKey = key;
          input.addEventListener('input', () => {
            if (!mcpServerDrafts[idx].oauth) mcpServerDrafts[idx].oauth = {};
            mcpServerDrafts[idx].oauth[key] = input.value.trim();
          });
          oauthEditor.appendChild(input);
        }
        const scopes = document.createElement('input');
        scopes.type = 'text';
        scopes.placeholder = 'scopes（空格分隔，可选）';
        scopes.value = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : '';
        scopes.addEventListener('input', () => {
          if (!mcpServerDrafts[idx].oauth) mcpServerDrafts[idx].oauth = {};
          mcpServerDrafts[idx].oauth.scopes = scopes.value.split(/\s+/).filter(Boolean);
        });
        oauthEditor.appendChild(scopes);
        row.appendChild(remoteOptions);
        row.appendChild(oauthEditor);
      } else {
        row.appendChild(remoteOptions);
      }

      if (s.auth !== 'oauth') {
        // Keep the row's control line visible without exposing OAuth fields.
        remoteOptions.classList.add('is-none');
      }
    }
    root.appendChild(row);
  });
}

async function testMcpServerRow(idx, resultEl, testBtn) {
  const draft = mcpServerDrafts[idx];
  if (!draft || !window.codex?.testMcpServer) return;
  const cfg = serializeMcpServerList()[idx];
  if (resultEl) {
    resultEl.className = 'mcp-test-result';
    resultEl.textContent = '测试中…';
  }
  if (testBtn) testBtn.disabled = true;
  try {
    const r = await window.codex.testMcpServer(cfg);
    if (!resultEl) return;
    if (r?.ok) {
      resultEl.className = 'mcp-test-result ok';
      resultEl.textContent = `连接成功 · ${r.transport || cfg.transport} · tools ${r.toolsCount ?? 0} · resources ${r.resourcesCount ?? 0}`;
    } else {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = `失败：${r?.error || '未知错误'}`;
    }
  } catch (err) {
    if (resultEl) {
      resultEl.className = 'mcp-test-result err';
      resultEl.textContent = `失败：${err.message || String(err)}`;
    }
  } finally {
    if (testBtn) testBtn.disabled = false;
  }
}

function addMcpServerDraft() {
  mcpServerDrafts.push(cloneMcpServer({
    name: '',
    transport: 'stdio',
    enabled: true,
    command: '',
  }));
  renderMcpServerList();
}

function applyMcpImportJson() {
  const raw = document.getElementById('mcp-import-json')?.value?.trim() || '';
  if (!raw) {
    toast('请粘贴 MCP 服务器 JSON 数组');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    toast('JSON 无效，已中止导入');
    return;
  }
  if (!Array.isArray(parsed)) {
    toast('MCP 服务器 JSON 必须是数组');
    return;
  }
  setMcpServerDrafts(parsed);
  hideMcpImportPanel();
  toast(`已导入 ${mcpServerDrafts.length} 项（保存时校验）`);
}

async function openSettings() {
  const settings = await window.codex.getSettings();
  mcpSavedFingerprint = mcpConfigFingerprint(settings.mcpServers);
  document.getElementById('set-mode').value = settings.mode || 'local';
  document.getElementById('set-base-url').value = settings.baseUrl || '';
  document.getElementById('set-model').value = settings.model || '';
  document.getElementById('set-api-key').value = '';
  document.getElementById('set-api-hint').textContent = settings.apiKeySet ? '已配置 API Key（留空保存则保留原 Key）' : '尚未配置 API Key';
  const pm = document.getElementById('set-permission-mode');
  if (pm) pm.value = settings.permissionMode || 'confirm-writes';
  const ae = document.getElementById('set-agent-enabled');
  if (ae) ae.checked = settings.agentEnabled !== false;
  const at = document.getElementById('set-agent-turns');
  if (at) at.value = settings.maxAgentTurns || 8;
  const te = document.getElementById('set-terminal-enabled');
  if (te) te.checked = Boolean(settings.terminalEnabled);
  const tc = document.getElementById('set-terminal-confirm');
  if (tc) tc.checked = settings.terminalRequireConfirm !== false;
  const ci = document.getElementById('set-code-index-enabled');
  if (ci) ci.checked = settings.codeIndexEnabled !== false;
  const dam = document.getElementById('set-default-agent-mode');
  if (dam) dam.value = settings.defaultAgentMode === 'plan' ? 'plan' : 'agent';
  const vc = document.getElementById('set-verify-command');
  if (vc) vc.value = settings.verifyCommand || '';
  const vbd = document.getElementById('set-verify-before-done');
  if (vbd) vbd.checked = settings.verifyBeforeDone !== false;
  const se = document.getElementById('set-skills-enabled');
  if (se) se.checked = settings.skillsEnabled !== false;
  const sub = document.getElementById('set-subagent-enabled');
  if (sub) sub.checked = settings.subagentEnabled !== false;
  const emp = document.getElementById('set-explore-max-parallel');
  if (emp) emp.value = String(settings.exploreMaxParallel ?? 2);
  const mcpEn = document.getElementById('set-mcp-enabled');
  if (mcpEn) mcpEn.checked = Boolean(settings.mcpEnabled);
  setMcpServerDrafts(Array.isArray(settings.mcpServers) ? settings.mcpServers : []);
  await refreshMcpOAuthStatuses();
  hideMcpImportPanel();
  const ac = document.getElementById('set-auto-compact');
  if (ac) ac.checked = settings.autoCompact === true;
  const ckm = document.getElementById('set-compact-keep-messages');
  if (ckm) ckm.value = String(settings.compactKeepMessages ?? 24);
  const cmm = document.getElementById('set-compact-max-messages');
  if (cmm) cmm.value = String(settings.compactMaxMessages ?? 40);
  const cmt = document.getElementById('set-compact-max-tokens');
  if (cmt) cmt.value = String(settings.compactMaxApproxTokens ?? 24000);
  const me = document.getElementById('set-memory-enabled');
  if (me) me.checked = settings.memoryEnabled !== false;
  const mce = document.getElementById('set-memory-candidate-enabled');
  if (mce) mce.checked = settings.memoryCandidateEnabled !== false;
  const mme = document.getElementById('set-memory-max-entries');
  if (mme) mme.value = String(settings.memoryMaxEntries ?? 200);
  const mtn = document.getElementById('set-memory-inject-topn');
  if (mtn) mtn.value = String(settings.memoryInjectTopN ?? 8);
  const mmt = document.getElementById('set-memory-inject-max-tokens');
  if (mmt) mmt.value = String(settings.memoryInjectMaxTokens ?? 1200);
  const he = document.getElementById('set-hooks-enabled');
  if (he) he.checked = settings.hooksEnabled !== false;
  const webEnabled = document.getElementById('set-web-enabled');
  if (webEnabled) webEnabled.checked = settings.webEnabled === true;
  const webConfirm = document.getElementById('set-web-confirm');
  if (webConfirm) webConfirm.checked = settings.webRequireConfirm !== false;
  const webAllow = document.getElementById('set-web-allow');
  if (webAllow) webAllow.value = (settings.webAllowDomains || []).join('\n');
  const webDeny = document.getElementById('set-web-deny');
  if (webDeny) webDeny.value = (settings.webDenyDomains || []).join('\n');
  const webTimeout = document.getElementById('set-web-timeout');
  if (webTimeout) webTimeout.value = String(settings.webTimeoutMs ?? 15000);
  const webMaxBytes = document.getElementById('set-web-max-bytes');
  if (webMaxBytes) webMaxBytes.value = String(settings.webMaxBytes ?? 524288);
  const webMaxChars = document.getElementById('set-web-max-chars');
  if (webMaxChars) webMaxChars.value = String(settings.webMaxChars ?? 15000);
  const usageEnabled = document.getElementById('set-usage-enabled');
  if (usageEnabled) usageEnabled.checked = settings.usageEnabled !== false;
  const usageMaxRecords = document.getElementById('set-usage-max-records');
  if (usageMaxRecords) usageMaxRecords.value = String(settings.usageMaxRecords ?? 5000);
  const usagePricing = document.getElementById('set-usage-pricing');
  if (usagePricing) {
    usagePricing.value = (settings.usagePricing || [])
      .map((row) => `${row.modelPrefix},${row.inputPerM},${row.outputPerM}`)
      .join('\n');
  }
  const usageCurrency = document.getElementById('set-usage-currency');
  if (usageCurrency) usageCurrency.value = settings.usageCurrency || '$';
  document.getElementById('settings-modal').classList.remove('hidden');
  await refreshHooksSummary();
  await renderMemoryList();
  await refreshUsageSummaryBox();
}
function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
  hideMcpImportPanel();
}
/* ---- Phase D.2: memory list in settings ------------------------------- */

function memoryScopeBadge(scope) {
  const badge = document.createElement('span');
  badge.className = 'memory-scope-badge' + (scope === 'user' ? ' is-user' : '');
  badge.textContent = scope === 'user' ? '用户' : '项目';
  return badge;
}

function memoryIconButton(symbol, title, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'memory-icon-btn' + (className ? ' ' + className : '');
  button.textContent = symbol;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function renderMemoryEntryRow(entry, projectPath) {
  const row = document.createElement('div');
  row.className = 'memory-item';

  function renderDisplay() {
    row.className = 'memory-item';
    row.innerHTML = '';
    const badge = memoryScopeBadge(entry.scope);
    const text = document.createElement('span');
    text.className = 'memory-text';
    text.textContent = entry.text.length > 80 ? entry.text.slice(0, 80) + '…' : entry.text;
    text.title = entry.text;
    const edit = memoryIconButton('✎', '编辑记忆');
    edit.addEventListener('click', renderEdit);
    const del = memoryIconButton('×', '删除记忆', 'is-danger');
    del.addEventListener('click', async () => {
      try {
        const result = await window.codex.deleteMemory({
          projectPath, id: entry.id, scope: entry.scope,
        });
        toast(window.CodexMemoryCommands.deleteResultMessage(result));
        if (result?.ok !== false && result?.removed) await renderMemoryList();
      } catch (error) {
        toast('删除失败：' + (error?.message || String(error)));
      }
    });
    row.append(badge, text, edit, del);
  }

  function renderEdit() {
    row.className = 'memory-item is-editing';
    row.innerHTML = '';
    const badge = memoryScopeBadge(entry.scope);
    badge.title = '编辑时不能迁移作用域；需要迁移请删除后重建';
    const fields = document.createElement('div');
    fields.className = 'memory-edit-fields';
    const text = document.createElement('textarea');
    text.className = 'memory-edit-text';
    text.rows = 2;
    text.maxLength = 1000;
    text.value = entry.text;
    const tags = document.createElement('input');
    tags.type = 'text';
    tags.className = 'memory-edit-tags';
    tags.placeholder = '标签，用逗号分隔';
    tags.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
    const error = document.createElement('div');
    error.className = 'memory-edit-error';

    const actions = document.createElement('div');
    actions.className = 'memory-edit-actions';
    const save = memoryIconButton('✓', '保存记忆');
    const cancel = memoryIconButton('×', '取消编辑');
    cancel.addEventListener('click', renderDisplay);
    save.addEventListener('click', async () => {
      save.disabled = true;
      cancel.disabled = true;
      error.textContent = '';
      try {
        const result = await window.codex.updateMemory({
          projectPath,
          id: entry.id,
          scope: entry.scope,
          expected: {
            text: entry.text,
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            updatedAt: entry.updatedAt ?? null,
          },
          text: text.value,
          tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        });
        if (!result?.ok) {
          error.textContent = result?.code === 'CONFLICT'
            ? '记忆已被修改或删除，请刷新后重试'
            : (result?.error || '保存失败');
          return;
        }
        Object.assign(entry, result.entry);
        toast('记忆已更新');
        renderDisplay();
      } catch (updateError) {
        error.textContent = updateError?.message || String(updateError);
      } finally {
        save.disabled = false;
        cancel.disabled = false;
      }
    });
    actions.append(save, cancel);
    fields.append(text, tags, error, actions);
    row.append(badge, fields);
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }

  renderDisplay();
  return row;
}

async function renderMemoryList() {
  const root = document.getElementById('memory-list');
  if (!root || !window.codex?.listMemory) return;
  root.innerHTML = '';
  const projectPath = sessionProject()?.path || null;
  let res;
  try {
    res = await window.codex.listMemory({ projectPath });
  } catch (e) {
    root.textContent = '读取失败：' + (e.message || String(e));
    return;
  }
  if (!res || res.ok === false) {
    root.textContent = res?.error || '读取失败';
    return;
  }
  const entries = (res.entries || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  if (!entries.length) {
    root.textContent = '暂无记忆。对话里用 /remember <事实> 添加。';
  }
  for (const entry of entries) root.appendChild(renderMemoryEntryRow(entry, projectPath));
  if (res.skipped) {
    const warn = document.createElement('div');
    warn.className = 'field-hint';
    warn.textContent = `跳过 ${res.skipped} 行损坏数据。`;
    root.appendChild(warn);
  }
}

async function refreshHooksSummary() {
  const el = document.getElementById('hooks-summary');
  if (!el || !window.codex?.hooksSummary) return;
  const projectPath = sessionProject()?.path || null;
  try {
    const s = await window.codex.hooksSummary({ projectPath });
    const c = s.countsByEvent || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    el.textContent = s.enabled
      ? `Hooks 已启用 · 共 ${total} 条（用户 ${s.userPath || '-'} / 项目 ${s.projectPath || '无'}）`
      : 'Hooks 已关闭';
    if (s.errors?.length) el.textContent += ` · 警告: ${s.errors[0]}`;
  } catch {
    el.textContent = 'Hooks 摘要加载失败';
  }
}

async function refreshUsageSummaryBox() {
  const box = document.getElementById('usage-summary-box');
  if (!box || !window.codex?.usageSummary) return;
  try {
    const result = await window.codex.usageSummary({ groupBy: 'model' });
    box.textContent = result.ok
      ? `历史总计：↑${fmtTok(result.totals.in)} ↓${fmtTok(result.totals.out)}`
        + (result.totals.cost > 0 ? ` ${result.currency}${result.totals.cost.toFixed(4)}` : '')
        + (result.mixedCurrencies?.length
          ? ` · 未合计 ${result.mixedCurrencies.join('、')}`
          : '')
      : result.error;
  } catch {
    box.textContent = '用量加载失败';
  }
}
async function saveSettingsFromForm() {
  const mcpServers = serializeMcpServerList();
  const partial = {
    mode: document.getElementById('set-mode').value,
    baseUrl: document.getElementById('set-base-url').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    permissionMode: document.getElementById('set-permission-mode')?.value || 'confirm-writes',
    agentEnabled: document.getElementById('set-agent-enabled')?.checked !== false,
    maxAgentTurns: Number(document.getElementById('set-agent-turns')?.value || 8),
    terminalEnabled: Boolean(document.getElementById('set-terminal-enabled')?.checked),
    terminalRequireConfirm: document.getElementById('set-terminal-confirm')?.checked !== false,
    codeIndexEnabled: document.getElementById('set-code-index-enabled')?.checked !== false,
    defaultAgentMode: document.getElementById('set-default-agent-mode')?.value === 'plan' ? 'plan' : 'agent',
    verifyCommand: document.getElementById('set-verify-command')?.value?.trim() || '',
    verifyBeforeDone: document.getElementById('set-verify-before-done')?.checked !== false,
    skillsEnabled: document.getElementById('set-skills-enabled')?.checked !== false,
    subagentEnabled: document.getElementById('set-subagent-enabled')?.checked !== false,
    exploreMaxParallel: Number(document.getElementById('set-explore-max-parallel')?.value || 2),
    mcpEnabled: Boolean(document.getElementById('set-mcp-enabled')?.checked),
    mcpServers,
    hooksEnabled: document.getElementById('set-hooks-enabled')?.checked !== false,
    memoryEnabled: document.getElementById('set-memory-enabled')?.checked !== false,
    memoryCandidateEnabled: document.getElementById('set-memory-candidate-enabled')?.checked !== false,
    memoryMaxEntries: Number(document.getElementById('set-memory-max-entries')?.value || 200),
    memoryInjectTopN: Number(document.getElementById('set-memory-inject-topn')?.value ?? 8),
    memoryInjectMaxTokens: Number(document.getElementById('set-memory-inject-max-tokens')?.value || 1200),
    autoCompact: Boolean(document.getElementById('set-auto-compact')?.checked),
    compactKeepMessages: Number(document.getElementById('set-compact-keep-messages')?.value || 24),
    compactMaxMessages: Number(document.getElementById('set-compact-max-messages')?.value || 40),
    compactMaxApproxTokens: Number(document.getElementById('set-compact-max-tokens')?.value || 24000),
    webEnabled: Boolean(document.getElementById('set-web-enabled')?.checked),
    webRequireConfirm: document.getElementById('set-web-confirm')?.checked !== false,
    webAllowDomains: (document.getElementById('set-web-allow')?.value || '')
      .split('\n').map((value) => value.trim()).filter(Boolean),
    webDenyDomains: (document.getElementById('set-web-deny')?.value || '')
      .split('\n').map((value) => value.trim()).filter(Boolean),
    webTimeoutMs: Number(document.getElementById('set-web-timeout')?.value || 15000),
    webMaxBytes: Number(document.getElementById('set-web-max-bytes')?.value || 524288),
    webMaxChars: Number(document.getElementById('set-web-max-chars')?.value || 15000),
    usageEnabled: document.getElementById('set-usage-enabled')?.checked !== false,
    usageMaxRecords: Number(document.getElementById('set-usage-max-records')?.value || 5000),
    usagePricing: (document.getElementById('set-usage-pricing')?.value || '')
      .split('\n').map((line) => {
        const [modelPrefix, inputPerM, outputPerM] = line.split(',').map((value) => value.trim());
        return { modelPrefix, inputPerM: Number(inputPerM), outputPerM: Number(outputPerM) };
      }).filter((row) => row.modelPrefix),
    usageCurrency: (document.getElementById('set-usage-currency')?.value || '$').slice(0, 4),
  };
  const key = document.getElementById('set-api-key').value; if (key) partial.apiKey = key;
  const saved = await window.codex.saveSettings(partial);
  if (saved?.ok === false) {
    if (saved.code === 'MCP_TASKS_CONFIG_LOCKED') {
      closeSettings();
      showWorkView('scheduled');
    }
    toast(saved.error || '设置保存失败');
    return;
  }
  mcpSavedFingerprint = mcpConfigFingerprint(saved?.mcpServers || mcpServers);
  if (Array.isArray(saved?.mcpServers)) setMcpServerDrafts(saved.mcpServers);
  await refreshMcpOAuthStatuses();
  usageDisplayEnabled = partial.usageEnabled !== false;
  currencySymbol = partial.usageCurrency || '$';
  defaultAgentModeSeed = partial.defaultAgentMode === 'plan' ? 'plan' : 'agent';
  closeSettings();
  renderUsageBar();
  renderContextMeter();
  await updateStatusBar();
  toast('设置已保存');
  // Refresh terminal input enablement hint via status only; gate still enforces at run time.
}
async function sendMessage() {
  if (sending) return;
  const input = document.getElementById('chat-input');
  const raw = input.value || ''; const text = buildOutgoingText(raw); if (!text.trim()) return;
  if (handleSlashCommand(raw.trim())) { input.value = ''; pendingAttaches = []; renderAttachPreview(); return; }
  const session = activeSession(); const proj = sessionProject(session);
  if (session.kind === 'project' && !proj?.path) {
    session.messages.push({ role: 'user', content: text });
    session.messages.push({ role: 'assistant', content: '此项目还没有绑定真实目录。\n\n请点标题旁 **绑定目录**，或右键项目 → 绑定真实目录。', error: true });
    input.value = ''; pendingAttaches = []; renderAttachPreview(); saveState(); renderMessages(); return;
  }
  // Resolve the sender-owned binding before a project chat can invoke the
  // engineering tools. This also covers the short window after app startup,
  // before background worktree reconciliation has finished.
  const projectBindingId = proj?.path ? await bindWorktreeProject(proj) : '';
  if (proj?.path && !projectBindingId) {
    return toast('项目绑定已失效，请重新绑定目录');
  }
  session.messages.push({ role: 'user', content: text }); session.updatedAt = Date.now();
  sessions = [session, ...sessions.filter((s) => s.id !== session.id)];
  input.value = ''; pendingAttaches = []; renderAttachPreview(); hideAtComplete(); setSending(true); saveState();
  if (session.peer && session.peer !== 'codex') {
    renderMessages(); renderLeftDynamic();
    const token = { aborted: false };
    localSendToken = token;
    setTimeout(() => {
      if (localSendToken === token) localSendToken = null;
      if (token.aborted) {
        session.messages.push({ role: 'assistant', content: '⏹ 已停止生成。已完成的文件改动会保留，可继续发送新消息。' });
      } else {
        session.messages.push({ role: 'assistant', content: '（模拟 ' + peerName(session.peer) + '）收到：' + (raw.trim().slice(0, 80) || '[附件]') + '。技术问题可以丢给 Codex 小蓝。' });
      }
      session.updatedAt = Date.now(); setSending(false); saveState(); renderMessages(); input.focus();
    }, 450); return;
  }

  // Phase D.1: optional compact before the model call. Runs while activeRun is
  // still null so the main-side gate lets it through; failures never block send.
  await maybeAutoCompact(session);

  // Live assistant placeholder driven by onChatEvent
  createAssistantRunPlaceholder(session.id);
  renderMessages();
  renderLeftDynamic();

  let invokeResult = null;
  let invokeError = null;
  try {
    const payload = {
      messages: session.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
      project: proj?.path ? { name: proj.name, path: proj.path } : null,
      projectBindingId,
      sessionId: session.id,
      agentMode: sessionAgentMode(session),
    };
    invokeResult = await window.codex.sendChat(payload);
    if (invokeResult?.ok === false && invokeResult.error) {
      const error = new Error(invokeResult.error);
      error.code = invokeResult.code;
      invokeError = error;
      invokeResult = null;
    }
  } catch (err) {
    invokeError = err;
  } finally {
    localSendToken = null;
  }

  // Merge carefully: prefer done-event content, then invoke result
  if (chatRun && !chatRun.finalized) {
    chatRun.invokeDone = true;
    if (invokeResult) {
      if (chatRun.contentFinal == null && invokeResult.content != null) {
        chatRun.contentFinal = String(invokeResult.content);
      }
      if (!chatRun.applied && invokeResult.applied) chatRun.applied = invokeResult.applied;
      if (!Array.isArray(chatRun.fileChanges)) chatRun.fileChanges = [];
      if (Array.isArray(invokeResult.fileChanges) && invokeResult.fileChanges.length) {
        for (const fc of invokeResult.fileChanges) mergeFileChangeEntry(chatRun.fileChanges, fc);
      }
      if (chatRun.fileChanges.length) renderFileChangesStrip();
      // Prefer event content already set; ensure final content exists
      const content = chatRun.contentFinal != null ? chatRun.contentFinal : (invokeResult.content || chatRun.textBuffer || '');
      finalizeChatRun({ content, applied: chatRun.applied || invokeResult.applied });
    } else if (invokeError) {
      let msg = invokeError?.message || String(invokeError);
      msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
      const stopped = invokeError?.code === 'ABORTED'
        || chatRun.aborted
        || /已停止|ABORTED|The user aborted a request|AbortError/i.test(msg);
      if (stopped) {
        chatRun.aborted = true;
        finalizeChatRun({
          aborted: true,
          content: chatRun.contentFinal || chatRun.textBuffer || '',
        });
      } else {
        // Prefer event-filled content; avoid double toast/bubble noise
        if (chatRun.doneEvent && (chatRun.contentFinal || chatRun.textBuffer)) {
          finalizeChatRun({
            error: chatRun.error,
            errorMessage: msg,
            content: chatRun.contentFinal || chatRun.textBuffer,
          });
        } else {
          chatRun.error = true;
          finalizeChatRun({ error: true, errorMessage: msg, content: chatRun.contentFinal || chatRun.textBuffer || '' });
        }
      }
    } else if (chatRun.doneEvent) {
      finalizeChatRun({ content: chatRun.contentFinal || chatRun.textBuffer || '', applied: chatRun.applied });
    } else {
      // Invoke returned nothing and no events — still clear UI
      finalizeChatRun({ content: chatRun.textBuffer || '', applied: chatRun.applied });
    }
  }

  session.updatedAt = Date.now();
  setSending(false);
  saveState();
  renderMessages();
  input.focus();
}
function bindEvents() {
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('btn-stop')?.addEventListener('click', () => { stopGenerating(); });
  document.getElementById('agent-mode-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn || btn.disabled) return;
    setSessionAgentMode(btn.getAttribute('data-mode'));
  });
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (onAtCompleteKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  bindAppDialog();
  document.getElementById('btn-settings').addEventListener('click', () => openSettings().catch((e) => appAlert(e.message)));
  document.getElementById('btn-window-minimize')?.addEventListener('click', () => {
    window.codex?.minimizeWindow?.();
  });
  document.getElementById('btn-window-maximize')?.addEventListener('click', () => {
    window.codex?.toggleMaximizeWindow?.();
  });
  document.getElementById('btn-window-close')?.addEventListener('click', () => {
    window.codex?.closeWindow?.();
  });
  document.querySelector('.qq-titlebar')?.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    window.codex?.toggleMaximizeWindow?.();
  });
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save').addEventListener('click', () => saveSettingsFromForm().catch((e) => appAlert(e.message)));
  document.getElementById('usage-bar')?.addEventListener('click', showUsageDetails);
  document.getElementById('btn-usage-clear')?.addEventListener('click', async () => {
    if (!(await appConfirm('确定清空全部用量记录？此操作不可撤销。'))) return;
    const result = await window.codex.usageClear();
    if (!result?.ok) {
      toast(result?.error || '清空失败');
      return;
    }
    for (const session of sessions) delete session.usage;
    saveState();
    renderUsageBar();
    renderContextMeter();
    await refreshUsageSummaryBox();
    toast('已清空');
  });
  document.getElementById('btn-hooks-refresh')?.addEventListener('click', () => refreshHooksSummary().catch(() => {}));
  document.getElementById('btn-mcp-add')?.addEventListener('click', () => addMcpServerDraft());
  document.getElementById('btn-mcp-import')?.addEventListener('click', () => {
    const panel = document.getElementById('mcp-import-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      document.getElementById('mcp-import-json')?.focus();
    }
  });
  document.getElementById('btn-mcp-import-apply')?.addEventListener('click', () => applyMcpImportJson());
  document.getElementById('btn-mcp-import-cancel')?.addEventListener('click', () => hideMcpImportPanel());
  window.codex.onMcpOAuthEvent?.((event) => {
    const name = String(event?.name || '').trim();
    if (!name) return;
    if (event.state === 'starting' || event.state === 'waiting' || event.state === 'exchanging') {
      mcpOAuthFlowIds.set(name, event.flowId);
      mcpOAuthErrors.delete(name);
    } else {
      mcpOAuthFlowIds.delete(name);
      if (event.state === 'error') mcpOAuthErrors.set(name, event.error || 'MCP_OAUTH_TOKEN_FAILED');
    }
    if (!document.getElementById('settings-modal')?.classList.contains('hidden')) {
      renderMcpServerList();
    }
  });
  window.codex.onMcpSessionEvent?.((event) => {
    if (!event?.server) return;
    // Keep status lightweight and identifier-free; detailed state is refreshed
    // when settings opens and never persisted into the chat transcript.
    if (!document.getElementById('settings-modal')?.classList.contains('hidden')) renderMcpServerList();
    if (event.state === 'reconnecting') toast(`MCP ${event.server} 正在重连…`);
  });
  document.getElementById('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeSettings(); });
  document.getElementById('btn-task-cancel').addEventListener('click', closeTaskModal);
  document.getElementById('btn-task-ok').addEventListener('click', createTaskFromModal);
  document.getElementById('task-modal').addEventListener('click', (e) => { if (e.target.id === 'task-modal') closeTaskModal(); });
  document.getElementById('btn-project-cancel').addEventListener('click', closeProjectModal);
  document.getElementById('btn-project-ok').addEventListener('click', () => createProjectFromModal().catch((error) => toast(error?.message || String(error))));
  document.getElementById('btn-project-browse').addEventListener('click', () => browseProjectPath().catch((e) => toast(e.message)));
  document.getElementById('project-modal').addEventListener('click', (e) => { if (e.target.id === 'project-modal') closeProjectModal(); });
  document.querySelectorAll('#main-toolbar .tb-btn').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  document.querySelectorAll('#left-nav .nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  document.getElementById('left-search').addEventListener('input', (e) => { searchQuery = e.target.value.trim(); renderLeftDynamic(); });
  document.getElementById('contact-randy').addEventListener('click', () => openFriendChat('randy'));
  document.getElementById('robot-card').addEventListener('click', () => openFriendChat('codex'));
  document.getElementById('btn-clear-chat').addEventListener('click', clearCurrentChat);
  document.getElementById('btn-compact')?.addEventListener('click', () => {
    runCompactOnSession(activeSession(), { force: true }).catch((e) => toast(e.message || String(e)));
  });
  document.getElementById('btn-memory-candidates')?.addEventListener('click', () => {
    openCandidateReview(activeSession()).catch((error) => {
      toast(error?.message || String(error));
    });
  });
  document.getElementById('btn-memory-candidate-close')?.addEventListener('click', closeMemoryCandidateReview);
  document.getElementById('btn-memory-candidate-later')?.addEventListener('click', closeMemoryCandidateReview);
  document.getElementById('btn-memory-candidate-accept')?.addEventListener('click', () => {
    acceptSelectedMemoryCandidates().catch((error) => toast(error?.message || String(error)));
  });
  document.getElementById('btn-memory-candidate-reject')?.addEventListener(
    'click', rejectSelectedMemoryCandidates
  );
  document.getElementById('memory-candidate-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'memory-candidate-modal') closeMemoryCandidateReview();
  });
  document.getElementById('btn-export')?.addEventListener('click', () => {
    runExportOnSession(activeSession(), 'md').catch((e) => toast(e.message || String(e)));
  });
  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    runExportOnSession(activeSession(), 'json').catch((e) => toast(e.message || String(e)));
  });
  document.getElementById('btn-bind-project').addEventListener('click', () => { const p = sessionProject(); if (p) bindProjectPath(p.id); });
  document.getElementById('btn-emoji').addEventListener('click', () => document.getElementById('emoji-panel').classList.toggle('hidden'));
  document.getElementById('btn-image').addEventListener('click', () => document.getElementById('file-image').click());
  document.getElementById('btn-attach').addEventListener('click', () => document.getElementById('file-attach').click());
  document.getElementById('file-image').addEventListener('change', async (e) => { await handleFiles(e.target.files, true); e.target.value = ''; });
  document.getElementById('file-attach').addEventListener('change', async (e) => { await handleFiles(e.target.files, false); e.target.value = ''; });
  document.getElementById('chat-input').addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items; if (!items) return; const files = [];
    for (const it of items) { if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); await handleFiles(files, true); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu')) hideContextMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = document.getElementById('memory-candidate-modal');
    if (modal && !modal.classList.contains('hidden')) closeMemoryCandidateReview();
  });
}
function boot() {
  loadState();
  renderEmojiPanel();
  bindEvents();
  bindTerminalPanel();
  bindAtComplete();
  // One global chat:event listener; routes by active chatRun / runId (+ terminal-*)
  if (window.codex?.onChatEvent) {
    window.codex.onChatEvent((ev) => {
      try { handleChatEvent(ev); } catch (e) { console.error('chat event handler', e); }
    });
  }
  window.codex?.onMcpTaskEvent?.((event) => {
    if (!event?.taskRef) return;
    mcpTaskState.set(event.taskRef, event);
    if (currentView === 'scheduled') renderMcpTaskCenter();
    renderMessages();
  });
  window.codex?.onMcpElicitationEvent?.((event) => {
    if (event?.elicitationId) showMcpElicitation(event);
  });
  window.codex?.onEngineeringEvent?.((event) => {
    // Background jobs keep running while the user is on another view; only the
    // engineering and gate views repaint, and nothing here touches history.
    const workflowFinished = event?.type === 'engineering:workflow:event' && ['finished', 'interrupted'].includes(event.reason);
    if (currentView === 'scheduled') {
      loadEngineeringJobs().catch(() => {});
      loadEngineeringWorkflows().catch(() => {});
      refreshEngineeringIndexStatus().catch(() => {});
    } else if (workflowFinished) {
      const project = sessionProject();
      const token = project ? worktreeBindings.get(project.id) : '';
      if (project && token) loadWorkflowGateRuns(project, token).then(() => {
        renderMessages();
        if (currentView === 'prs') renderPullRequestView();
      }).catch(() => {});
    }
  });
  loadMcpTasks().catch(() => {});
  setView('chat');
  for (const project of projects) if (project.path) reconcileWorktreeResults(project);
  updateAgentModeToggle();
  updateStatusBar();
  updateClock();
  setInterval(updateClock, 30000);
  // Load defaultAgentMode seed for new sessions (non-blocking)
  if (window.codex?.getSettings) {
    window.codex.getSettings().then((s) => {
      defaultAgentModeSeed = s?.defaultAgentMode === 'plan' ? 'plan' : 'agent';
    }).catch(() => {});
  }
}
boot();
