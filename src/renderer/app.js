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
const PRS = [
  { id: 128, title: 'fix: d1 migration history backfill', repo: 'haiker', status: 'open', author: 'you' },
  { id: 126, title: 'feat: push delivery dedup', repo: 'haiker', status: 'review', author: 'Randy Lu' },
  { id: 119, title: 'chore: bump wrangler', repo: 'infra', status: 'merged', author: 'bot' },
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
let activeSessionId = '';
let currentView = 'chat';
let sending = false;
let currencySymbol = '$';
let usageDisplayEnabled = true;
/** Seeds agentMode for newly created sessions (from settings.defaultAgentMode). */
let defaultAgentModeSeed = 'agent';

/** Active agent/stream run for the current send (event-driven UI). */
let chatRun = null;

/** Manual / agent terminal panel state (shared output; multi-termId aware). */
let termState = {
  /** @type {Map<string, { source: string, command: string }>} */
  runs: new Map(),
  stickBottom: true,
  pendingApproval: null,
};

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
        return session;
      })
      : defaultSessions();
    sessions.forEach(ensureSessionCandidateState);
    projects = Array.isArray(data.projects) && data.projects.length ? data.projects : defaultProjects();
    activeSessionId = data.activeSessionId && sessions.some((s) => s.id === data.activeSessionId) ? data.activeSessionId : sessions[0].id;
    if (data.pluginState) pluginState = { ...pluginState, ...data.pluginState };
  } catch {
    sessions = defaultSessions();
    sessions.forEach(ensureSessionCandidateState);
    projects = defaultProjects();
    activeSessionId = sessions[0].id;
  }
}
function saveState() {
  sessions.forEach(ensureSessionCandidateState);
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

function rejectSelectedMemoryCandidates() {
  const session = candidateSession();
  if (!session || memoryCandidateBusy) return;
  const ids = ensureSessionCandidateState(session)
    .filter((candidate) => memoryCandidateSelected.has(candidate.id))
    .map((candidate) => candidate.id);
  if (!ids.length || !confirm('确定拒绝所选记忆候选？')) return;
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
  }).join('') + (showTyping ? '<div class="typing">'+botName+' 正在输入… <button type="button" class="linkish" id="inline-stop">停止</button></div>' : '');
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
  setSending(true);
  try {
    const res = await window.codex.approvePlan({
      sessionId: session.id,
      planId: planEv.planId,
      messages: history,
      project: proj?.path ? { name: proj.name, path: proj.path } : null,
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

function handleChatEvent(ev) {
  if (!ev) return;
  // Terminal panel events (agent + manual) always go to the shared panel.
  // Manual approvals may also land here without an active chatRun.
  if (handleTerminalPanelEvent(ev)) return;

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
function deleteSession(id) {
  if (sessions.length <= 1) return toast('至少保留一个会话');
  const s = sessions.find((x) => x.id === id); if (!s) return;
  if (chatRun && !chatRun.finalized && chatRun.sessionId === id) {
    return toast('生成中无法删除该会话，请先停止');
  }
  if (!confirm('确定删除「' + s.title + '」？')) return;
  sessions = sessions.filter((x) => x.id !== id);
  if (activeSessionId === id) activeSessionId = sessions[0].id;
  saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); toast('已删除');
}
function deleteProject(id) {
  const p = getProject(id); if (!p) return;
  const running = chatRun && !chatRun.finalized
    && sessions.some((session) => session.id === chatRun.sessionId && session.projectId === id);
  if (running) return toast('生成中无法删除该项目，请先停止');
  if (!confirm('删除项目「' + p.name + '」？\n（不会删除磁盘上的真实文件夹）')) return;
  projects = projects.filter((x) => x.id !== id);
  sessions = sessions.filter((s) => s.projectId !== id);
  if (!sessions.length) sessions = defaultSessions();
  if (!sessions.some((s) => s.id === activeSessionId)) activeSessionId = sessions[0].id;
  saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); toast('项目已删除（磁盘文件未动）');
}
function renameProject(id) {
  const p = getProject(id); if (!p) return;
  const name = prompt('项目名称', p.name); if (!name || !name.trim()) return;
  p.name = name.trim();
  sessions.forEach((s) => { if (s.projectId === id && s.kind === 'project') s.title = p.name; });
  saveState(); renderLeftDynamic(); updateHeader(); toast('已重命名');
}
async function bindProjectPath(id) {
  const p = getProject(id); if (!p) return;
  const dir = await window.codex.selectDirectory(); if (!dir) return;
  p.path = dir;
  saveState(); renderLeftDynamic(); toast('已绑定：' + dir);
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
function createProjectFromModal() {
  const name = document.getElementById('project-name').value.trim();
  const pathVal = document.getElementById('project-path').value.trim();
  if (!name) return toast('请填写项目名称');
  if (!pathVal) return toast('请选择真实项目目录');
  const p = { id: uid('proj'), name, path: pathVal, pinned: false, createdAt: Date.now() };
  projects.unshift(p); saveState(); closeProjectModal(); openProjectChat(p.id); toast('项目已添加并绑定目录');
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
}
function switchSession(id) {
  if (!sessions.some((s) => s.id === id)) return;
  activeSessionId = id; saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); renderFriends(); updateStatusBar(); updateAgentModeToggle();
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
function showWorkView(view) {
  document.getElementById('view-chat').classList.add('hidden');
  document.getElementById('view-work').classList.remove('hidden');
  const titleMap = { scheduled: '已安排', plugins: '插件', sites: '站点', prs: '拉取请求' };
  document.getElementById('work-title').textContent = titleMap[view] || '工作台';
  document.getElementById('work-sub').textContent = '可点击条目执行操作';
  const body = document.getElementById('work-body');
  if (view === 'scheduled') {
    body.innerHTML = '<div class="card-list">' + SCHEDULED.map((t) => '<div class="work-card"><div class="work-card-title">⏰ ' + escapeHtml(t.title) + '</div><div class="work-card-meta">' + escapeHtml(t.when) + ' · <span class="badge ' + t.status + '">' + t.status + '</span></div><div class="work-card-actions"><button type="button" class="ghost-btn" data-act="run" data-id="' + t.id + '">立即运行</button><button type="button" class="ghost-btn" data-act="chat" data-id="' + t.id + '">交给 Codex</button></div></div>').join('') + '</div>';
    body.querySelectorAll('[data-act="run"]').forEach((btn) => btn.addEventListener('click', () => toast('已触发：' + (SCHEDULED.find((x) => x.id === btn.dataset.id)?.title || ''))));
    body.querySelectorAll('[data-act="chat"]').forEach((btn) => { const item = SCHEDULED.find((x) => x.id === btn.dataset.id); btn.addEventListener('click', () => ensureTaskAndAsk(item?.title || '定时任务', '帮我检查定时任务：' + item?.title)); });
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
    body.innerHTML = '<div class="card-list">' + PRS.map((pr) => '<div class="work-card"><div class="work-card-title">🔀 #' + pr.id + ' ' + escapeHtml(pr.title) + '</div><div class="work-card-meta">' + escapeHtml(pr.repo) + ' · ' + escapeHtml(pr.author) + ' · <span class="badge ' + pr.status + '">' + pr.status + '</span></div><div class="work-card-actions"><button type="button" class="ghost-btn" data-pr-review="' + pr.id + '">让 Codex 审查</button></div></div>').join('') + '</div>';
    body.querySelectorAll('[data-pr-review]').forEach((btn) => { const pr = PRS.find((x) => String(x.id) === btn.dataset.prReview); btn.addEventListener('click', () => ensureTaskAndAsk('PR #' + pr.id, '请审查 PR #' + pr.id + '「' + pr.title + '」')); });
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
function handleSlashCommand(text) {
  const cmd = text.trim(); const lower = cmd.toLowerCase();
  if (lower === '/help') {
    activeSession().messages.push({
      role: 'assistant',
      content: '命令：/help /clear /mode /new 标题 /ls /skills /skill <name> /compact /export md|json /remember /memory /forget\n'
        + '/compact：把更早的消息压缩成一条摘要，保留最近若干条原文（生成中不可用）\n'
        + '/export md｜/export json：导出当前会话，路径在保存对话框里选\n'
        + '/fetch <url>：抓取网页正文进会话（需先开启网页访问）；/usage：查看 token 用量\n'
        + '/remember <事实>：记入长期记忆（绑定项目时进项目级，否则用户级）\n'
        + '/memory：列出长期记忆；/forget <id>：删除一条\n'
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

function normalizeMcpTransport(t) {
  const x = String(t || '').toLowerCase();
  if (x === 'sse' || x === 'http' || x === 'stdio') return x;
  return 'stdio';
}

function cloneMcpServer(s) {
  const transport = normalizeMcpTransport(s?.transport || (s?.url ? 'http' : 'stdio'));
  const out = {
    name: String(s?.name || ''),
    transport,
    enabled: s?.enabled === false ? false : true,
    command: String(s?.command || ''),
    url: String(s?.url || ''),
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
  return out;
}

function serializeMcpServerList() {
  return mcpServerDrafts.map((s) => {
    const transport = normalizeMcpTransport(s.transport);
    const base = {
      name: String(s.name || '').trim(),
      transport,
      enabled: s.enabled !== false,
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
    }
    if (s.timeoutMs != null && Number.isFinite(Number(s.timeoutMs))) {
      base.timeoutMs = Number(s.timeoutMs);
    }
    return base;
  });
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

    const resultEl = document.createElement('div');
    resultEl.className = 'mcp-test-result';

    row.appendChild(enLabel);
    row.appendChild(name);
    row.appendChild(tr);
    row.appendChild(endpoint);
    row.appendChild(testBtn);
    row.appendChild(delBtn);
    row.appendChild(resultEl);
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
  await window.codex.saveSettings(partial);
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
      sessionId: session.id,
      agentMode: sessionAgentMode(session),
    };
    invokeResult = await window.codex.sendChat(payload);
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
  document.getElementById('btn-settings').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save').addEventListener('click', () => saveSettingsFromForm().catch((e) => alert(e.message)));
  document.getElementById('usage-bar')?.addEventListener('click', showUsageDetails);
  document.getElementById('btn-usage-clear')?.addEventListener('click', async () => {
    if (!confirm('确定清空全部用量记录？此操作不可撤销。')) return;
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
  document.getElementById('settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeSettings(); });
  document.getElementById('btn-task-cancel').addEventListener('click', closeTaskModal);
  document.getElementById('btn-task-ok').addEventListener('click', createTaskFromModal);
  document.getElementById('task-modal').addEventListener('click', (e) => { if (e.target.id === 'task-modal') closeTaskModal(); });
  document.getElementById('btn-project-cancel').addEventListener('click', closeProjectModal);
  document.getElementById('btn-project-ok').addEventListener('click', createProjectFromModal);
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
  setView('chat');
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
