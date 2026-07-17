/* Codex QQ Desktop */
const STORAGE_KEY = 'codex-qq-state-v2';
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

function setSending(on) {
  sending = !!on;
  const btn = document.getElementById('btn-send');
  const stop = document.getElementById('btn-stop');
  if (btn) btn.disabled = sending;
  if (stop) stop.classList.toggle('hidden', !sending);
}

/** Local cancel token for friend mock / short delays */
let localSendToken = null;

async function stopGenerating() {
  if (localSendToken) localSendToken.aborted = true;
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
    { id: 'task_kv', title: '优化 KV 读写成本', kind: 'task', peer: 'codex', projectId: null, pinned: true, messages: [{ role: 'assistant', content: SEED_KV }], updatedAt: Date.now() },
    { id: 'task_wechat', title: '微信发送 hello world', kind: 'task', peer: 'codex', projectId: null, pinned: false, messages: [{ role: 'assistant', content: '这个任务可以拆成：\n\n1. 确认接口\n2. 写最小发送脚本\n3. 配 token\n\n把代码或报错贴过来。' }], updatedAt: Date.now() - 1000 },
    { id: 'chat_randy', title: 'Randy Lu', kind: 'friend', peer: 'randy', projectId: null, pinned: false, messages: [{ role: 'assistant', content: '（模拟好友）在的，有事直接说。' }], updatedAt: Date.now() - 2000 },
  ];
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('codex-qq-sessions-v1');
    if (!raw) { sessions = defaultSessions(); projects = defaultProjects(); activeSessionId = sessions[0].id; return; }
    const data = JSON.parse(raw);
    sessions = Array.isArray(data.sessions) && data.sessions.length ? data.sessions.map((s) => ({ pinned: false, projectId: null, ...s })) : defaultSessions();
    projects = Array.isArray(data.projects) && data.projects.length ? data.projects : defaultProjects();
    activeSessionId = data.activeSessionId && sessions.some((s) => s.id === data.activeSessionId) ? data.activeSessionId : sessions[0].id;
    if (data.pluginState) pluginState = { ...pluginState, ...data.pluginState };
  } catch {
    sessions = defaultSessions(); projects = defaultProjects(); activeSessionId = sessions[0].id;
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, projects, activeSessionId, pluginState }));
}
function activeSession() { return sessions.find((s) => s.id === activeSessionId) || sessions[0]; }
function getProject(id) { return projects.find((p) => p.id === id) || null; }
function sessionProject(session = activeSession()) {
  if (!session) return null;
  if (session.projectId) return getProject(session.projectId);
  return null;
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
function renderMessages() {
  const list = document.getElementById('message-list'); if (!list) return;
  const session = activeSession(); const msgs = session?.messages || [];
  const botName = peerName(session?.peer || 'codex');
  list.innerHTML = msgs.map((msg) => {
    const roleClass = msg.role === 'user' ? 'msg-user' : 'msg-assistant';
    const errClass = msg.error ? ' msg-error' : '';
    const who = msg.role === 'user' ? '我' : botName;
    return '<div class="msg '+roleClass+errClass+'"><div class="bubble"><div class="msg-meta">'+who+'</div>'+renderMarkdownLite(msg.content)+'</div></div>';
  }).join('') + (sending ? '<div class="typing">'+botName+' 正在输入… <button type="button" class="linkish" id="inline-stop">停止</button></div>' : '');
  scrollToBottom();
  bindInlineStop();
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
  if (!confirm('确定删除「' + s.title + '」？')) return;
  sessions = sessions.filter((x) => x.id !== id);
  if (activeSessionId === id) activeSessionId = sessions[0].id;
  saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); toast('已删除');
}
function deleteProject(id) {
  const p = getProject(id); if (!p) return;
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
    session = { id: uid('ps'), title: p.name, kind: 'project', peer: 'codex', projectId: p.id, pinned: false, messages: [{ role: 'assistant', content: tip }], updatedAt: Date.now() };
    sessions.unshift(session);
  }
  activeSessionId = session.id; saveState(); setView('chat');
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
}
async function updateStatusBar() {
  try {
    const settings = await window.codex.getSettings();
    document.getElementById('status-left').textContent = '安全 · ' + (settings.mode === 'api' ? 'API 模式' : '本地模拟');
    const proj = sessionProject();
    document.getElementById('status-mid').textContent = proj?.path ? ('项目: ' + proj.name) : (settings.mode === 'api' ? (settings.model || '') : 'mock');
  } catch { document.getElementById('status-left').textContent = '安全'; }
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
  updateHeader(); renderMessages(); renderLeftDynamic(); renderFriends(); updateStatusBar();
}
function switchSession(id) {
  if (!sessions.some((s) => s.id === id)) return;
  activeSessionId = id; saveState(); updateHeader(); renderMessages(); renderLeftDynamic(); renderFriends(); updateStatusBar();
}
function openFriendChat(friendId) {
  const friend = FRIENDS.find((f) => f.id === friendId); if (!friend) return;
  let session = sessions.find((s) => s.kind === 'friend' && s.peer === friendId);
  if (!session) {
    session = { id: uid('friend'), title: friend.name, kind: 'friend', peer: friendId, projectId: null, pinned: false,
      messages: [{ role: 'assistant', content: friend.kind === 'bot' ? '在呢。直接说需求，或先绑定真实项目再让我改代码。' : ('（模拟）' + friend.name + '：你好。') }], updatedAt: Date.now() };
    sessions.unshift(session);
  }
  activeSessionId = session.id; saveState(); setView('chat'); toast('已打开与 ' + friend.name + ' 的会话');
}
function ensureTaskAndAsk(title, firstUserMessage) {
  const session = { id: uid('task'), title, kind: 'task', peer: 'codex', projectId: null, pinned: false, messages: [], updatedAt: Date.now() };
  sessions.unshift(session); activeSessionId = session.id; saveState(); setView('chat');
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
  const session = { id: uid('task'), title, kind: 'task', peer: 'codex', projectId: sessionProject()?.id || null, pinned: false,
    messages: [{ role: 'assistant', content: '新任务「' + title + '」已创建。' + (brief ? ('\n\n说明：' + brief + '\n\n') : '\n\n') + '继续补充细节即可。' }], updatedAt: Date.now() };
  sessions.unshift(session); activeSessionId = session.id; saveState(); closeTaskModal(); setView('chat'); toast('任务已创建');
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
    activeSession().messages.push({ role: 'assistant', content: '命令：/help /clear /mode /new 标题 /ls\n任务/项目右键：置顶、删除、绑定目录\n项目对话可读写真实文件（需绑定）' });
    saveState(); renderMessages(); return true;
  }
  if (lower === '/clear') { clearCurrentChat(); return true; }
  if (lower === '/mode') {
    updateStatusBar().then(() => { activeSession().messages.push({ role: 'assistant', content: '状态：' + document.getElementById('status-left').textContent + ' / ' + document.getElementById('status-mid').textContent }); saveState(); renderMessages(); });
    return true;
  }
  if (lower === '/ls' || lower === '/tree') { document.getElementById('chat-input').value = '列出文件'; sendMessage(); return true; }
  if (lower.startsWith('/new ')) { document.getElementById('task-title').value = cmd.slice(5).trim() || '未命名任务'; document.getElementById('task-brief').value = ''; createTaskFromModal(); return true; }
  return false;
}
function clearCurrentChat() {
  const s = activeSession(); s.messages = [{ role: 'assistant', content: '会话已清空。继续说吧。' }]; s.updatedAt = Date.now(); saveState(); renderMessages(); toast('已清空当前会话');
}
async function openSettings() {
  const settings = await window.codex.getSettings();
  document.getElementById('set-mode').value = settings.mode || 'local';
  document.getElementById('set-base-url').value = settings.baseUrl || '';
  document.getElementById('set-model').value = settings.model || '';
  document.getElementById('set-api-key').value = '';
  document.getElementById('set-api-hint').textContent = settings.apiKeySet ? '已配置 API Key（留空保存则保留原 Key）' : '尚未配置 API Key';
  const ae = document.getElementById('set-agent-enabled');
  if (ae) ae.checked = settings.agentEnabled !== false;
  const at = document.getElementById('set-agent-turns');
  if (at) at.value = settings.maxAgentTurns || 8;
  const te = document.getElementById('set-terminal-enabled');
  if (te) te.checked = Boolean(settings.terminalEnabled);
  const tc = document.getElementById('set-terminal-confirm');
  if (tc) tc.checked = settings.terminalRequireConfirm !== false;
  document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden'); }
async function saveSettingsFromForm() {
  const partial = {
    mode: document.getElementById('set-mode').value,
    baseUrl: document.getElementById('set-base-url').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    agentEnabled: document.getElementById('set-agent-enabled')?.checked !== false,
    maxAgentTurns: Number(document.getElementById('set-agent-turns')?.value || 8),
    terminalEnabled: Boolean(document.getElementById('set-terminal-enabled')?.checked),
    terminalRequireConfirm: document.getElementById('set-terminal-confirm')?.checked !== false,
  };
  const key = document.getElementById('set-api-key').value; if (key) partial.apiKey = key;
  await window.codex.saveSettings(partial); closeSettings(); await updateStatusBar(); toast('设置已保存');
}
async function sendMessage() {
  if (sending) return;
  const input = document.getElementById('chat-input'); const btn = document.getElementById('btn-send');
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
  input.value = ''; pendingAttaches = []; renderAttachPreview(); setSending(true); saveState(); renderMessages(); renderLeftDynamic();
  if (session.peer && session.peer !== 'codex') {
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
  try {
    const payload = { messages: session.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })), project: proj?.path ? { name: proj.name, path: proj.path } : null };
    const res = await window.codex.sendChat(payload);
    session.messages.push({ role: 'assistant', content: res.content || '' });
    if (res.applied?.length) toast('已应用 ' + res.applied.filter((a) => a.ok).length + '/' + res.applied.length + ' 个文件变更');
  } catch (err) {
    let msg = err?.message || String(err);
    msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '');
    const stopped = err?.code === 'ABORTED' || /已停止|ABORTED|The user aborted a request|AbortError/i.test(msg);
    session.messages.push({
      role: 'assistant',
      content: stopped ? '⏹ 已停止生成。已完成的文件改动会保留，可继续发送新消息。' : ('请求失败：\n' + msg),
      error: !stopped,
    });
  } finally {
    if (!(session.peer && session.peer !== 'codex')) localSendToken = null;
    session.updatedAt = Date.now(); setSending(false); saveState(); renderMessages(); input.focus();
  }
}
function bindEvents() {
  document.getElementById('btn-send').addEventListener('click', sendMessage);
  document.getElementById('btn-stop')?.addEventListener('click', () => { stopGenerating(); });
  document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  document.getElementById('btn-settings').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save').addEventListener('click', () => saveSettingsFromForm().catch((e) => alert(e.message)));
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
}
function boot() {
  loadState(); renderEmojiPanel(); bindEvents(); setView('chat'); updateStatusBar(); updateClock(); setInterval(updateClock, 30000);
}
boot();
