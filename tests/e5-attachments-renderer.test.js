'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const schema = require('../src/ai/message-schema');
const models = require('../src/renderer/e4-models');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const helperPath = path.join(__dirname, '../src/renderer/e5-attachments.js');
const helper = fs.existsSync(helperPath) ? require(helperPath) : null;
const plain = value => JSON.parse(JSON.stringify(value));
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a, `production section ${start}`); return source.slice(a, b); }
function productionFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source); assert.ok(match, `production function ${name}`);
  const next = /\n(?:async )?function [A-Za-z_$]/g; next.lastIndex = match.index + match[0].length;
  const end = next.exec(source); return source.slice(match.index, end ? end.index : source.length);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const ref = (id = 'ref_fixture', extra = {}) => ({ refVersion: 1, attachmentId: id, name: 'fixture.txt', mimeType: 'text/plain', size: 40, source: 'user_upload', status: 'ready', storageMode: 'encrypted', budget: { extractedChars: 40 }, ...extra });
const session = id => ({ id, title: id, kind: 'assistant', identityType: 'ai', assistantId: 'assistant_general', modelProfileId: null, projectId: null, agentMode: 'agent', messages: [] });
function fixtureState() { const state = chat.createState({ sessions: [session('first'), session('second')], activeSessionId: 'first' }); chat.updateDraft(state, 'first', { text: 'raw user draft' }); return state; }
function preview(attachment, extra = {}) { return { ok: true, required: true, previewId: 'preview_fixture', expiresAt: Date.now() + 60000,
  target: { providerId: 'provider_fixture', providerName: 'Offline provider', origin: 'https://offline.invalid', model: 'offline-model', modelProfileId: 'model_fixture', assistantId: 'assistant_general', assistantName: 'Fixture assistant', protocol: 'openai-responses' },
  attachments: [{ ...attachment, budget: { ...attachment.budget, selectedChars: 24, selectedBytes: 30, truncated: false } }], budget: { estimatedInputTokens: 17, contextLimit: 32000, maxOutputTokens: 2000 }, ...extra }; }
function harness(t, { state = fixtureState(), stored = JSON.stringify(state), ports = {} } = {}) {
  const calls = [], notices = [], writes = [], bodyHtmlWrites = [], nodes = new Map(), storage = new Map([[chat.STORAGE_KEY, stored]]), timers = new Set(), boundEditors = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  function element(id = '') {
    const classes = new Set(['hidden']), listeners = new Map(), queries = new Map(); let html = '', text = '';
    const el = { id, dataset: {}, value: '', hidden: true, disabled: false, checked: false, children: [], parentNode: null, selectionStart: 0, selectionEnd: 0,
      get innerHTML() { return html; }, set innerHTML(value) { html = value; this.children = []; if (id === 'attachment-preview-text') bodyHtmlWrites.push(value); },
      get textContent() { return text; }, set textContent(value) { text = String(value); },
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, force) { const value = force === undefined ? !classes.has(name) : force; if (value) classes.add(name); else classes.delete(name); return value; } },
      setAttribute(name, value) { this[name] = String(value); }, getAttribute(name) { return this[name] ?? null; },
      addEventListener(type, callback) { if (id === 'chat-input' && !boundEditors.length) boundEditors.push(el.value); if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
      removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== callback)); },
      async dispatchEvent(event) { const full = { preventDefault() {}, stopPropagation() {}, ...event, target: event.target || el }; for (const fn of listeners.get(event.type) || []) await fn(full); if (typeof el[`on${event.type}`] === 'function') await el[`on${event.type}`](full); },
      click() { if (!this.disabled) return this.dispatchEvent({ type: 'click' }); }, focus() { document.activeElement = this; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; }, append(...children) { children.forEach(child => this.appendChild(child)); }, replaceChildren(...children) { this.children = []; this.append(...children); }, remove() {},
      querySelector(selector) { if (!queries.has(selector)) queries.set(selector, element()); return queries.get(selector); }, querySelectorAll: () => [], closest: () => null,
    }; return el;
  }
  const document = { getElementById: node, createElement: () => element(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const invoke = async (method, payload) => { calls.push({ method, payload: plain(payload || {}) });
    if (method === 'registerSession' || method === 'restoreSession') assert.ok(typeof payload.clientRequestId === 'string' && payload.clientRequestId.length > 0, 'Production namespace calls require a fresh clientRequestId');
    if (ports[method]) return ports[method](payload, calls);
    if (method === 'registerSession' || method === 'restoreSession') return { ok: true, attachmentSessionBindingId: `grant_${payload.sessionId}`, namespaceRef: `namespace_${payload.sessionId}`, storageMode: 'encrypted', refs: [] };
    if (method === 'prepareSend') return { ok: true, required: false };
    if (method === 'previewPage') return { ok: true, text: '<script>globalThis.executed = true</script> inert 😀', offset: payload.offset || 0, nextOffset: null, totalCodePoints: 47 };
    if (method === 'list') return { ok: true, refs: [], storageMode: 'encrypted' };
    if (method === 'cacheStatus') return { ok: true, storageMode: 'encrypted', bytes: 30, records: 1 };
    if (method === 'sendChat' || method === 'approvePlan') return { ok: true, accepted: true, sessionId: payload.sessionId, clientRequestId: payload.clientRequestId, runId: `run_${calls.length}` };
    return { ok: true, refs: [] };
  };
  const managerState = { revision: 3, registry: { revision: 3, models: [{ id: 'model_fixture', providerId: 'provider_fixture', model: 'offline-model' }], assistants: [{ id: 'assistant_general', modelProfileId: 'model_fixture' }] } };
  let modelSubscriber;
  const manager = { getState: () => managerState, subscribe: callback => { modelSubscriber = callback; }, load: async () => ({}), loadAssistants: async () => ({}) };
  const attachments = Object.fromEntries(['registerSession', 'restoreSession', 'chooseExternal', 'proposeDrop', 'captureProjectRefs', 'list', 'prepareSend', 'previewPage', 'remove', 'deleteCopy', 'cancel', 'cacheStatus', 'clearCache'].map(method => [method, payload => invoke(method, payload)]));
  const context = vm.createContext({ console, TextEncoder, structuredClone, Map, Set, Date, Promise, URL, Event: class { constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); } },
    document, localStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { writes.push(value); storage.set(key, value); } },
    setTimeout(callback, ms, ...args) { const handle = setTimeout(() => { timers.delete(handle); callback(...args); }, ms); timers.add(handle); return handle; }, clearTimeout(handle) { timers.delete(handle); clearTimeout(handle); }, setInterval: () => 1, clearInterval() {},
    FileReader: class { constructor() { assert.fail('E5 must never instantiate FileReader'); } },
    STORAGE_KEY: chat.STORAGE_KEY, sessions: [], projects: [], activeSessionId: '', pluginState: {}, chatState: chat.createState(), storageWriteBlocked: false, draftPersistenceError: '', pendingAttaches: [], pendingAttachmentsBySession: new Map(),
    chatRun: null, sending: false, currentView: 'chat', pullRequestDrafts: new Map(), pullRequestForm: null, defaultAgentModeSeed: 'agent',
    pendingChatRequests: new Map(), pendingCompactRequests: new Map(), completedChatRuns: new Map(), chatOutboxStore: chat.createOutboxStore(), activeForegroundTask: null, worktreeBindings: new Map(),
    defaultSessions: () => [session('seed')], defaultProjects: () => [], normalizeSessionAgentMode: value => value === 'plan' ? 'plan' : 'agent', sessionAgentMode: value => value?.agentMode || 'agent',
    ensureSessionCandidateState() {}, ensureSessionWorktreeState() {}, toast: message => notices.push(message), appConfirm: async () => true,
    renderEmojiPanel() {}, bindAppDialog() {}, closeSettings() {}, closeTaskModal() {}, createTaskFromModal() {}, closeProjectModal() {}, clearCurrentChat() {}, showUsageDetails() {},
    closeMemoryCandidateReview() {}, rejectSelectedMemoryCandidates() {}, bindTerminalPanel() {}, bindAtComplete() {}, loadMcpTasks: async () => {}, setView() {},
    updateHeader() {}, renderMessages() {}, renderLeftDynamic() {}, renderFriends() {}, updateStatusBar() {}, updateAgentModeToggle() {}, updateIsolationBadge() {}, updateClock() {}, reconcileWorktreeResults() {},
    renderOutboxRecovery() {}, hideAtComplete() {}, handleSlashCommand: () => false, cloneForIpc: value => plain(value),
    getAssistantForSession: () => ({ name: 'Fixture assistant' }), peerName: () => 'Fixture assistant', escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    setSending(value) { context.sending = !!value; }, scrollToBottom() {}, setRunStatus() {}, handleTerminalPanelEvent: () => false, handleWorktreeEvent() {}, renderUsageBar() {}, renderContextMeter() {},
    sessionProject: value => context.projects.find(project => project.id === value?.projectId) || null, bindWorktreeProject: async project => context.worktreeBindings.get(project.id) || '',
    window: { E4ChatState: chat, E5Attachments: helper, E2Messages: require('../src/renderer/e2-messages'), E4Models: { getSwitchWarning: models.getSwitchWarning, createModelSettingsUi: () => ({ manager }) }, addEventListener() {},
      codex: { messageSchema: schema, attachments, sendChat: payload => invoke('sendChat', payload), approvePlan: payload => invoke('approvePlan', payload), syncModelSessionReferences: async () => ({ ok: true }), atRefComplete: payload => invoke('atRefComplete', payload) } },
  });
  vm.runInContext([
    section('function normalizeSessionMessageClient(', 'let referenceSyncFingerprint'),
    section('let referenceSyncFingerprint', 'function renderOutboxRecovery('),
    section('function activeSession(', 'function getAssistantForSession('),
    productionFunction('uid'), productionFunction('switchSession'), productionFunction('createAiSession'),
    section(source.includes('function attachmentApi(') ? 'function attachmentApi(' : 'function renderAttachPreview(', 'function activeProjectPathForMcp('),
    section('function waitForChatRunEvents(', 'function renderVerifyStrip('),
    section('async function sendMessage()', 'function bindEvents()'), productionFunction('bindEvents'), section('function boot(', '\nboot();'),
    section('function handleChatEvent(', '\nfunction scrollToBottom('), productionFunction('appendAcceptedUserMessage'), productionFunction('refreshAtComplete'),
  ].join('\n'), context, { filename: 'src/renderer/app.js [production VM sections]' });
  t.after(() => { for (const handle of timers) clearTimeout(handle); timers.clear(); });
  const callsOf = method => calls.filter(call => call.method === method);
  const active = () => context.sessions.find(item => item.id === context.activeSessionId);
  return { context, node, calls, callsOf, notices, writes, storage, boundEditors, bodyHtmlWrites, active, managerState, modelChanged() { modelSubscriber?.(); } };
}
async function until(predicate, label) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(done => setTimeout(done, 2)); } assert.fail(label); }
async function openSendPreview(h) { const pending = h.context.sendMessage(); await until(() => h.callsOf('previewPage').length > 0 && !h.node('attachment-send-preview').classList.contains('hidden'), 'real send must open controlled preview'); await until(() => h.node('attachment-preview-text').textContent.length > 0, 'preview page not painted'); return { pending }; }
async function choose(h, attachment = ref()) { h.context.window.codex.attachments.chooseExternal = async payload => { h.calls.push({ method: 'chooseExternal', payload: plain(payload) }); return { ok: true, refs: [attachment], storageMode: attachment.storageMode }; }; await h.node('btn-attach').click(); }

test('real production boot restores metadata only and requires explicit main namespace confirmation before cold refs can send', async t => {
  const state = fixtureState(); state.sessions[0].namespaceRef = 'ans_11111111111111111111111111111111'; state.draftsBySession.first.attachmentRefs = [ref()];
  const stored = JSON.stringify(state), h = harness(t, { state, stored, ports: { restoreSession: async payload => ({ ok: true, attachmentSessionBindingId: 'restored_grant', namespaceRef: payload.namespaceRef, storageMode: 'encrypted', refs: [ref()] }) } }); h.context.boot();
  assert.equal(h.node('chat-input').value, 'raw user draft'); assert.deepEqual(h.boundEditors, ['raw user draft']);
  assert.equal(h.callsOf('restoreSession').length, 0); assert.equal(h.callsOf('list').length, 0); assert.equal(h.callsOf('registerSession').length, 0); assert.equal(h.writes.length, 0);
  await h.context.sendMessage(); assert.equal(h.callsOf('sendChat').length, 0); assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
  await h.node('btn-attachment-restore').click(); assert.equal(h.callsOf('restoreSession').length, 1); assert.equal(h.active().namespaceRef, 'ans_11111111111111111111111111111111');
  const saved = h.storage.get(chat.STORAGE_KEY); assert.equal(saved.includes('restored_grant'), false); assert.equal(saved.includes('dataUrl'), false);
});
test('actual text-only send still calls prepareSend with the real snapshot, including raw @ that renderer detection must not consume', async t => {
  const h = harness(t); h.context.boot(); await h.context.sendMessage();
  assert.equal(h.callsOf('prepareSend').length, 1); assert.equal(h.callsOf('sendChat').length, 1);
  const prepare = h.callsOf('prepareSend')[0].payload, sent = h.callsOf('sendChat')[0].payload;
  for (const key of ['sessionId', 'clientRequestId', 'assistantId', 'modelProfileId', 'expectedRegistryRevision', 'projectBindingId', 'draftRevision', 'attachmentIds', 'messages']) assert.deepEqual(prepare[key], sent[key], key);
  assert.equal(prepare.requestKind, 'chat'); assert.equal(sent.messages.at(-1).content, 'raw user draft');
});
test('real attach-only send previews inert text, exact target/mode/budget, then sends identical snapshot with memory-only ticket', async t => {
  const attachment = ref('ref_fixture', { storageMode: 'memory' });
  const h = harness(t, { ports: { prepareSend: async () => preview(attachment) } }); h.context.boot(); await choose(h, attachment);
  h.node('chat-input').value = ''; await h.node('chat-input').dispatchEvent({ type: 'input' });
  const { pending } = await openSendPreview(h);
  assert.equal(h.callsOf('sendChat').length, 0); assert.match(h.node('attachment-preview-target').textContent, /Offline provider.*offline-model.*openai-responses/);
  assert.match(h.node('attachment-preview-storage').textContent, /仅内存/); assert.match(h.node('attachment-preview-budget').textContent, /17.*32000.*2000/);
  assert.match(h.node('attachment-preview-list').children[0].children[0].textContent, /24.*30/);
  assert.equal(h.node('attachment-preview-list').children[0].children[1].max, '24');
  assert.match(h.node('attachment-preview-text').textContent, /<script>/); assert.deepEqual(h.bodyHtmlWrites, []); assert.equal(h.context.executed, undefined);
  assert.equal(h.writes.some(value => /globalThis.executed|preview_fixture|grant_first/.test(value)), false);
  await h.node('attachment-preview-confirm').click(); await pending;
  const prepared = h.callsOf('prepareSend')[0].payload, sent = h.callsOf('sendChat')[0].payload;
  for (const key of ['messages', 'attachmentIds', 'draftRevision', 'clientRequestId', 'projectBindingId']) assert.deepEqual(sent[key], prepared[key]);
  assert.equal(sent.messages.at(-1).content, ''); assert.equal(sent.attachmentPreviewId, 'preview_fixture'); assert.equal(sent.attachmentSessionBindingId, 'grant_first');
  assert.equal(h.node('attachment-preview-text').textContent, ''); assert.equal(h.context.chatState.draftsBySession.first.attachmentRefs.length, 1, 'no consumption before authoritative run-start');
});
test('truncation acknowledgement and bounded pagination gate real send, not a helper-only path', async t => {
  const attachment = ref(); let page = 0;
  const h = harness(t, { ports: { prepareSend: async () => preview(attachment, { attachments: [{ ...attachment, budget: { ...attachment.budget, selectedChars: 16390, selectedBytes: 17000, truncated: true } }] }),
    previewPage: async payload => (++page === 1 ? { ok: true, text: 'x'.repeat(16384), offset: 0, nextOffset: 16384, totalCodePoints: 16390 } : { ok: true, text: '第二页😀', offset: payload.offset, nextOffset: null, totalCodePoints: 16390 }) } });
  h.context.boot(); await choose(h); const { pending } = await openSendPreview(h);
  assert.equal(h.node('attachment-preview-confirm').disabled, true);
  await h.node('attachment-preview-next').click(); await until(() => h.node('attachment-preview-text').textContent === '第二页😀', 'next bounded page');
  assert.equal(h.callsOf('previewPage')[1].payload.offset, 16384);
  h.node('attachment-preview-truncated').checked = true; await h.node('attachment-preview-truncated').dispatchEvent({ type: 'change' });
  await h.node('attachment-preview-confirm').click(); await pending; assert.equal(h.callsOf('sendChat').length, 1);
});
test('preview cancel and prepare failure preserve draft/outbox and never dispatch; retry gets new request and preview', async t => {
  let attempts = 0; const attachment = ref();
  const h = harness(t, { ports: { prepareSend: async () => (++attempts === 1 ? { ok: false, code: 'ATTACHMENT_MISSING', error: 'synthetic missing' } : preview(attachment, { previewId: `preview_${attempts}` })) } }); h.context.boot(); await choose(h);
  await h.context.sendMessage(); assert.equal(h.callsOf('sendChat').length, 0); assert.equal(h.node('chat-input').value, 'raw user draft');
  const { pending } = await openSendPreview(h); await h.node('attachment-preview-cancel').click(); await pending;
  assert.equal(h.callsOf('sendChat').length, 0); assert.equal(h.node('chat-input').value, 'raw user draft'); assert.equal(h.active().messages.length, 0);
  assert.notEqual(h.callsOf('prepareSend')[0].payload.clientRequestId, h.callsOf('prepareSend')[1].payload.clientRequestId); assert.ok(h.callsOf('cancel').some(call => call.payload.previewId === 'preview_2'));
});
for (const change of ['draft', 'session', 'target']) test(`real ${change} change invalidates an open preview and clears body without sending`, async t => {
  const h = harness(t, { ports: { prepareSend: async () => preview(ref()) } }); h.context.boot(); await choose(h); const { pending } = await openSendPreview(h);
  if (change === 'draft') { h.node('chat-input').value = 'newer unsent draft'; await h.node('chat-input').dispatchEvent({ type: 'input' }); }
  if (change === 'session') h.context.switchSession('second');
  if (change === 'target') { h.managerState.revision++; h.managerState.registry.revision++; h.modelChanged(); }
  await pending; assert.equal(h.callsOf('sendChat').length, 0); assert.equal(h.node('attachment-preview-text').textContent, ''); assert.ok(h.callsOf('cancel').length);
  if (change === 'draft') assert.equal(h.context.chatState.draftsBySession.first.text, 'newer unsent draft');
  if (change === 'session') assert.equal(h.context.activeSessionId, 'second');
});
test('deferred main picker completion belongs only to the original draft, never the active editor after session switch', async t => {
  const picker = deferred(); const h = harness(t, { ports: { chooseExternal: () => picker.promise } }); h.context.boot();
  const pending = h.node('btn-attach').click(); await until(() => h.callsOf('chooseExternal').length === 1, 'native picker IPC'); h.context.switchSession('second');
  h.node('chat-input').value = 'second local draft'; await h.node('chat-input').dispatchEvent({ type: 'input' });
  picker.resolve({ ok: true, refs: [ref()], storageMode: 'encrypted' }); await pending;
  assert.equal(h.node('chat-input').value, 'second local draft'); assert.equal(h.context.pendingAttaches.length, 0);
  assert.equal(h.context.chatState.draftsBySession.first.attachmentRefs[0].attachmentId, 'ref_fixture'); assert.equal(h.context.chatState.draftsBySession.second.attachmentRefs.length, 0);
  h.context.switchSession('first'); assert.equal(h.context.pendingAttaches[0].attachmentId, 'ref_fixture');
});
test('real Plan approval prepares and previews same immutable messages/approval binding without consuming draft or Plan authority on cancel', async t => {
  const state = fixtureState(); state.sessions[0].messages = [{ role: 'user', content: 'approved request @src/fixture.txt' }, { role: 'assistant', content: 'plan', parts: [{ type: 'plan', planId: 'plan_fixture', status: 'proposed', markdown: 'inert plan' }] }];
  const h = harness(t, { state, ports: { prepareSend: async () => preview(ref('project_ref', { source: 'at_project_ref' })) } }); h.context.boot();
  // Cold persisted plans deliberately expire. This fixture represents a new
  // live main-owned proposed Plan received after boot, not recovered authority.
  h.active().messages[1].parts[0].status = 'proposed';
  const card = h.node('plan-card'); card.dataset = { sessionId: 'first', planId: 'plan_fixture', planRevision: '2' };
  const pending = h.context.approvePlanFromCard(card, { planId: 'plan_fixture', planRevision: 2 }); await until(() => h.callsOf('previewPage').length > 0, 'Plan must preview');
  const prepared = h.callsOf('prepareSend')[0].payload; assert.equal(prepared.requestKind, 'approvePlan'); assert.equal(prepared.planId, 'plan_fixture'); assert.equal(prepared.planRevision, 2);
  assert.equal(prepared.messages[0].content, 'approved request @src/fixture.txt');
  await h.node('attachment-preview-cancel').click(); await pending; assert.equal(h.callsOf('approvePlan').length, 0);
  assert.equal(h.active().messages[1].parts[0].status, 'proposed'); assert.equal(h.node('chat-input').value, 'raw user draft');
});
test('Plan confirmation sends preview-bound snapshot, and authoritative run-start alone publishes generated project refs', async t => {
  const state = fixtureState(); state.sessions[0].messages = [{ role: 'user', content: '@src/fixture.txt inspect' }];
  const h = harness(t, { state, ports: { prepareSend: async () => preview(ref('project_ref', { source: 'at_project_ref' })) } }); h.context.boot();
  const card = h.node('plan-card'); card.dataset = { sessionId: 'first', planId: 'plan_fixture' };
  const pending = h.context.approvePlanFromCard(card, { planId: 'plan_fixture' }); await until(() => h.callsOf('previewPage').length > 0 && h.node('attachment-preview-text').textContent.length > 0, 'Plan preview');
  await h.node('attachment-preview-confirm').click(); await pending;
  const prepared = h.callsOf('prepareSend')[0].payload, sent = h.callsOf('approvePlan')[0].payload;
  for (const key of ['messages', 'planId', 'clientRequestId', 'draftRevision', 'attachmentIds']) assert.deepEqual(sent[key], prepared[key]);
  assert.equal(sent.attachmentPreviewId, 'preview_fixture'); assert.equal(h.node('chat-input').value, 'raw user draft');
});
test('image button/paste/drop explicitly reject E6 without FileReader, base64 or importer calls', async t => {
  const h = harness(t); h.context.boot(); await h.node('btn-image').click();
  await h.node('chat-input').dispatchEvent({ type: 'paste', clipboardData: { items: [{ type: 'image/png', getAsFile: () => ({ name: 'fixture.png', type: 'image/png', size: 4 }) }] } });
  await h.context.handleFiles([{ name: 'fixture.png', type: 'image/png', size: 4 }], true);
  assert.equal(h.callsOf('proposeDrop').length, 0); assert.equal(h.context.pendingAttaches.length, 0); assert.ok(h.notices.some(text => /E6.*未支持|未支持.*E6/.test(text)));
  assert.equal(h.writes.some(value => /data:image|base64/.test(value)), false);
});
test('actual at-complete uses host project binding and current session/model public references', async t => {
  const h = harness(t); h.context.boot(); h.context.projects = [{ id: 'project_fixture', path: 'C:\\synthetic-project' }]; h.active().projectId = 'project_fixture'; h.context.worktreeBindings.set('project_fixture', 'project_grant');
  h.context.findAtTokenAtCursor = () => ({ start: 0, end: 5, prefix: 'src/' }); h.context.atCompleteState = { reqId: 0 }; h.context.renderAtCompletePopup = () => {};
  h.node('chat-input').value = '@src/'; h.node('chat-input').selectionStart = 5; await h.context.refreshAtComplete();
  const payload = h.callsOf('atRefComplete')[0].payload; assert.equal(payload.projectBindingId, 'project_grant'); assert.equal(payload.projectPath, undefined); assert.equal(payload.sessionId, 'first'); assert.equal(payload.assistantId, 'assistant_general'); assert.equal(payload.expectedRegistryRevision, 3);
});
for (const bad of ['oversized', 'malformed', 'legacy-body']) test(`real boot preserves the ${bad} protected container instead of overwriting or reading attachments`, t => {
  const state = fixtureState(); if (bad === 'oversized') state.draftsBySession.first.text = 'x'.repeat(65537);
  if (bad === 'legacy-body') state.draftsBySession.first.attachmentRefs = [{ attachmentId: 'old', name: 'old.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,synthetic' }];
  const stored = bad === 'malformed' ? '{broken' : JSON.stringify(state), h = harness(t, { stored }); h.context.boot();
  assert.equal(h.context.storageWriteBlocked, true); assert.equal(h.writes.length, 0); assert.equal(h.storage.get(chat.STORAGE_KEY), stored); assert.equal(h.callsOf('restoreSession').length, 0);
});
