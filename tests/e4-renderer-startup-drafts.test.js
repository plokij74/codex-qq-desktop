'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const messageSchema = require('../src/ai/message-schema');
const models = require('../src/renderer/e4-models');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing production section: ${start}`);
  return source.slice(a, b);
}
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
  const next = /\n(?:async )?function [A-Za-z_$]/g;
  next.lastIndex = start + 10;
  const end = next.exec(source);
  return source.slice(start, end ? end.index : source.length);
}
function session(id) {
  return { id, title: id, kind: 'assistant', identityType: 'ai', assistantId: 'assistant_general',
    modelProfileId: null, projectId: null, agentMode: 'agent', messages: [] };
}
function persistedState() {
  const state = chat.createState({ sessions: [session('first'), session('second')], activeSessionId: 'first' });
  chat.updateDraft(state, 'first', { text: 'Reloaded draft 草稿 🚀', attachmentRefs: [
    { attachmentId: 'local-ref', name: 'offline-note.txt', mimeType: 'text/plain', size: 7 },
  ] });
  chat.updateDraft(state, 'second', { text: 'Other session must remain unchanged' });
  return state;
}
function harness(stored) {
  const storage = new Map([[chat.STORAGE_KEY, stored]]), writes = [], nodes = new Map(), boundEditors = [], references = [];
  const node = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      const element = { value: '', hidden: true, textContent: '',
        addEventListener(type, handler) {
          if (id === 'chat-input' && boundEditors.length === 0) boundEditors.push(element.value);
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(handler);
        },
        dispatchEvent(event) { return Promise.all((listeners.get(event.type) || []).map(handler => handler({ ...event, target: element }))); },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
      nodes.set(id, element);
    }
    return nodes.get(id);
  };
  const context = {
    console, Map, Set, Date, Promise, URL,
    window: { E4ChatState: chat, E4Models: { getSwitchWarning: models.getSwitchWarning }, E2Messages: require('../src/renderer/e2-messages'),
      codex: { messageSchema, syncModelSessionReferences(payload) { references.push(payload); return Promise.resolve({ ok: true }); } },
      addEventListener() {} },
    document: { getElementById: node, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { writes.push(value); storage.set(key, value); } },
    STORAGE_KEY: chat.STORAGE_KEY, sessions: [], projects: [], activeSessionId: '', pluginState: {}, chatState: chat.createState(),
    storageWriteBlocked: false, draftPersistenceError: '', pendingAttaches: [], pendingAttachmentsBySession: new Map(),
    chatRun: null, currentView: 'chat', pullRequestDrafts: new Map(), pullRequestForm: null,
    defaultAgentModeSeed: 'agent', defaultSessions: () => [session('seed')], defaultProjects: () => [], normalizeSessionAgentMode: value => value === 'plan' ? 'plan' : 'agent',
    ensureSessionCandidateState() {}, ensureSessionWorktreeState() {}, renderAttachPreview() {},
    setTimeout(callback) { callback(); return 1; }, setInterval: () => 1, clearInterval() {},
    toast() {}, appConfirm: async () => false, renderEmojiPanel() {}, bindAppDialog() {}, sendMessage() {}, closeSettings() {},
    closeTaskModal() {}, createTaskFromModal() {}, closeProjectModal() {}, clearCurrentChat() {}, showUsageDetails() {},
    closeMemoryCandidateReview() {}, rejectSelectedMemoryCandidates() {},
    bindTerminalPanel() {}, bindAtComplete() {}, loadMcpTasks: async () => {}, setView() {},
    updateHeader() {}, renderMessages() {}, renderLeftDynamic() {}, renderFriends() {}, updateStatusBar() {}, updateAgentModeToggle() {},
    updateIsolationBadge() {}, updateClock() {}, reconcileWorktreeResults() {}, sessionProject: () => null,
  };
  vm.createContext(context);
  vm.runInContext([
    section('function normalizeSessionMessageClient(', 'let referenceSyncFingerprint'),
    section('let referenceSyncFingerprint', 'function renderOutboxRecovery('),
    section('function activeSession(', 'function getAssistantForSession('),
    section('function getAssistantForSession(', 'function modelSourceLabel('),
    functionSource('uid'),
    functionSource('createAiSession'),
    functionSource('switchSession'),
    functionSource('bindEvents'),
    section('function boot(', '\nboot();'),
  ].join('\n'), context);
  return { context, storage, writes, boundEditors, references, node };
}

test('actual production boot hydrates the persisted active editor before binding interactive UI', () => {
  const state = persistedState(), stored = JSON.stringify(state), h = harness(stored);
  h.context.boot();
  assert.equal(h.context.activeSessionId, 'first');
  assert.equal(h.node('chat-input').value, state.draftsBySession.first.text);
  assert.deepEqual(h.boundEditors, [state.draftsBySession.first.text]);
  assert.equal(h.context.pendingAttaches.length, 1);
  const ref = h.context.pendingAttaches[0];
  assert.equal(ref.id, 'local-ref'); assert.equal(ref.name, 'offline-note.txt');
  assert.equal(ref.unavailableAfterRestart, true);
  assert.equal(ref.dataUrl, undefined, 'Startup restores a reference, never rereads an attachment');
  assert.equal(h.writes.length, 0, 'Hydrating an existing v3 state must not overwrite storage');
  assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
  assert.equal(h.references.length, 1, 'Startup still synchronizes host-owned session references');
});

test('an immediate session switch after production boot cannot replace the restored draft with an empty editor', () => {
  const state = persistedState(), h = harness(JSON.stringify(state)); h.context.boot();
  h.context.switchSession('second');
  assert.equal(h.node('chat-input').value, state.draftsBySession.second.text);
  assert.equal(h.context.chatState.draftsBySession.first.text, state.draftsBySession.first.text);
  assert.equal(h.context.chatState.draftsBySession.first.revision, state.draftsBySession.first.revision);
  assert.equal(h.context.chatState.draftsBySession.first.attachmentRefs[0].attachmentId, 'local-ref');
  h.context.switchSession('first');
  assert.equal(h.node('chat-input').value, state.draftsBySession.first.text);
  const saved = JSON.parse(h.storage.get(chat.STORAGE_KEY));
  for (const id of ['first', 'second']) assert.equal(saved.draftsBySession[id].text, state.draftsBySession[id].text);
});

test('production boot paints an oversized recoverable draft without modifying its protected container', () => {
  const state = persistedState(); state.draftsBySession.first.text = 'x'.repeat(chat.MAX_DRAFT_TEXT_BYTES + 1);
  const stored = JSON.stringify(state), h = harness(stored); h.context.boot();
  assert.equal(h.context.storageWriteBlocked, true);
  assert.equal(h.node('chat-input').value, state.draftsBySession.first.text);
  assert.equal(h.boundEditors[0], state.draftsBySession.first.text);
  assert.equal(h.writes.length, 0); assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
  assert.equal(h.node('draft-persistence-status').hidden, false);
});

test('production boot preserves a malformed container instead of writing an empty restored editor over it', () => {
  const stored = '{broken', h = harness(stored); h.context.boot();
  assert.equal(h.context.storageWriteBlocked, true); assert.equal(h.context.sessions.length, 0);
  assert.equal(h.node('chat-input').value, ''); assert.equal(h.context.pendingAttaches.length, 0);
  assert.equal(h.writes.length, 0); assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
});

test('production boot of an intentionally empty v3 container remains empty without seeding or persistence', () => {
  const stored = JSON.stringify(chat.createState()), h = harness(stored); h.context.boot();
  assert.equal(h.context.storageWriteBlocked, false); assert.equal(h.context.sessions.length, 0);
  assert.equal(h.node('chat-input').value, ''); assert.equal(h.writes.length, 0);
  assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
});

test('actual input event persists the owning draft before a reload without requiring a send or session switch', () => {
  const state = persistedState(), h = harness(JSON.stringify(state)); h.context.boot();
  const edited = 'Typed without switching 草稿 🧭';
  h.node('chat-input').value = edited; h.node('chat-input').dispatchEvent({ type: 'input' });
  assert.equal(h.context.chatState.draftsBySession.first.text, edited);
  assert.equal(h.context.chatState.draftsBySession.first.revision, state.draftsBySession.first.revision + 1);
  assert.equal(h.context.chatState.draftsBySession.second.text, state.draftsBySession.second.text);
  const stored = h.storage.get(chat.STORAGE_KEY);
  assert.equal(JSON.parse(stored).draftsBySession.first.text, edited);
  const reloaded = harness(stored); reloaded.context.boot();
  assert.equal(reloaded.node('chat-input').value, edited);
  assert.equal(reloaded.writes.length, 0);
});

test('input edits during an accepted outbox preserve its immutable snapshot and newer draft revision', () => {
  const state = persistedState(), h = harness(JSON.stringify(state)); h.context.boot();
  const outbox = chat.createOutbox({ state: h.context.chatState, sessionId: 'first', text: state.draftsBySession.first.text });
  h.context.sending = true; h.context.chatRun = { accepted: true };
  h.node('chat-input').value = 'New edit while the old request settles'; h.node('chat-input').dispatchEvent({ type: 'input' });
  assert.equal(Object.isFrozen(outbox), true); assert.equal(outbox.draftText, state.draftsBySession.first.text);
  chat.finishOutbox(h.context.chatState, outbox, { accepted: true });
  assert.equal(h.context.chatState.draftsBySession.first.text, h.node('chat-input').value);
  assert.equal(JSON.parse(h.storage.get(chat.STORAGE_KEY)).draftsBySession.first.text, h.node('chat-input').value);
});

test('input persistence failures preserve the current editor and old disk container instead of dropping other drafts', () => {
  for (const mode of ['oversized', 'quota']) {
    const state = persistedState(), stored = JSON.stringify(state), h = harness(stored); h.context.boot();
    const edited = mode === 'oversized' ? 'x'.repeat(chat.MAX_DRAFT_TEXT_BYTES + 1) : 'Edit that cannot be persisted';
    if (mode === 'quota') h.context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    h.node('chat-input').value = edited;
    assert.doesNotThrow(() => h.node('chat-input').dispatchEvent({ type: 'input' }));
    assert.equal(h.context.chatState.draftsBySession.first.text.length, edited.length);
    assert.equal(h.node('chat-input').value.length, edited.length);
    assert.equal(h.context.chatState.draftsBySession.second.text, state.draftsBySession.second.text);
    assert.equal(h.storage.get(chat.STORAGE_KEY), stored);
    assert.equal(h.node('draft-persistence-status').hidden, false);
  }
});

function targetHarness({ hasContext = true } = {}) {
  const state = persistedState();
  state.sessions[0].messages = hasContext ? [{ role: 'user', content: 'Synthetic existing context' }] : [];
  const h = harness(JSON.stringify(state)); h.context.boot();
  const ids = ['first', 'second', 'third'];
  const registry = { revision: 7, defaultModelProfileId: 'model_first',
    assistants: [{ id: 'assistant_general', modelProfileId: null }, { id: 'assistant_second', modelProfileId: 'model_second' }],
    models: ids.map(id => ({ id: `model_${id}`, providerId: `provider_${id}`, model: `e4-target-${id}` })),
    providers: ids.map(id => ({ id: `provider_${id}`, baseUrl: `https://${id}.e4-target.invalid/v1` })),
  };
  const dialogs = [], notices = [];
  h.context.modelManager = { getState: () => ({ registry, revision: registry.revision }) };
  h.context.appConfirm = (message, title) => new Promise(resolve => dialogs.push({ message, title, resolve }));
  h.context.window.confirm = () => { throw new Error('A target change must never use a browser-native dialog'); };
  h.context.toast = message => notices.push(message);
  h.context.headerUpdates = 0;
  h.context.updateHeader = () => { h.context.headerUpdates++; };
  return { ...h, registry, dialogs, notices,
    first: () => h.context.sessions.find(item => item.id === 'first'),
    choose(field, value) {
      const control = h.node(field === 'assistantId' ? 'chat-assistant-select' : 'chat-model-select');
      control.value = value; return control.dispatchEvent({ type: 'change' });
    },
  };
}

for (const field of ['assistantId', 'modelProfileId']) {
  test(`actual ${field} change waits for in-app context disclosure without mutating an accepted snapshot`, async () => {
    const h = targetHarness(), first = h.first();
    const before = first[field], history = JSON.stringify(first.messages), drafts = JSON.stringify(h.context.chatState.draftsBySession);
    const outbox = chat.createOutbox({ state: h.context.chatState, sessionId: 'first', modelProfileId: 'model_first', text: 'Accepted immutable input' });
    const source = Object.freeze({ kind: 'api', modelProfileId: 'model_first' });
    h.context.chatRun = { accepted: true, outbox, modelSource: source };
    const value = field === 'assistantId' ? 'assistant_second' : 'model_second';
    const pending = h.choose(field, value);
    assert.equal(h.dialogs.length, 1); assert.equal(first[field], before); assert.equal(h.writes.length, 0);
    assert.match(h.dialogs[0].message, /现有对话上下文/);
    assert.ok(h.dialogs[0].message.includes('https://second.e4-target.invalid'));
    assert.match(h.dialogs[0].message, /自动压缩目标/);
    h.dialogs[0].resolve(true); await pending;
    assert.equal(first[field], value); assert.equal(h.writes.length, 1);
    assert.equal(h.context.chatRun.outbox, outbox); assert.equal(h.context.chatRun.modelSource, source);
    assert.equal(outbox.modelProfileId, 'model_first'); assert.equal(Object.isFrozen(outbox), true);
    assert.equal(JSON.stringify(first.messages), history);
    assert.equal(JSON.stringify(h.context.chatState.draftsBySession), drafts);
  });
}

test('cancelling either actual target selector keeps its prior selection, draft and history', async () => {
  for (const field of ['assistantId', 'modelProfileId']) {
    const h = targetHarness(), first = h.first(), before = first[field];
    const drafts = JSON.stringify(h.context.chatState.draftsBySession), history = JSON.stringify(first.messages);
    const pending = h.choose(field, field === 'assistantId' ? 'assistant_second' : 'model_second');
    h.dialogs[0].resolve(false); await pending;
    assert.equal(first[field], before); assert.equal(h.writes.length, 0); assert.equal(h.context.headerUpdates, 1);
    assert.equal(JSON.stringify(h.context.chatState.draftsBySession), drafts); assert.equal(JSON.stringify(first.messages), history);
  }
});

test('a late target confirmation cannot mutate a different active session', async () => {
  const h = targetHarness(), first = h.first(), pending = h.choose('modelProfileId', 'model_second');
  h.context.switchSession('second');
  const writesAfterSwitch = h.writes.length, second = h.context.activeSession();
  h.dialogs[0].resolve(true); await pending;
  assert.equal(first.modelProfileId, null); assert.equal(second.modelProfileId, null);
  assert.equal(h.context.activeSessionId, 'second'); assert.equal(h.writes.length, writesAfterSwitch);
});

test('a configuration revision change invalidates an outstanding target disclosure', async () => {
  const h = targetHarness(), pending = h.choose('modelProfileId', 'model_second');
  h.registry.revision++;
  h.dialogs[0].resolve(true); await pending;
  assert.equal(h.first().modelProfileId, null); assert.equal(h.writes.length, 0); assert.equal(h.context.headerUpdates, 1);
});

test('only the latest actual selection can commit when confirmations settle out of order', async () => {
  const h = targetHarness();
  const older = h.choose('modelProfileId', 'model_second'), newer = h.choose('modelProfileId', 'model_third');
  assert.equal(h.dialogs.length, 2);
  h.dialogs[1].resolve(true); await newer;
  h.dialogs[0].resolve(true); await older;
  assert.equal(h.first().modelProfileId, 'model_third'); assert.equal(h.writes.length, 1);
});

test('a target change with no existing user context requires no disclosure and performs no model request', async () => {
  const h = targetHarness({ hasContext: false });
  await h.choose('modelProfileId', 'model_second');
  assert.equal(h.dialogs.length, 0); assert.equal(h.first().modelProfileId, 'model_second'); assert.equal(h.writes.length, 1);
  assert.equal(h.context.window.codex.sendChat, undefined); assert.equal(h.context.window.codex.chat, undefined);
});

test('an in-app confirmation failure keeps the current target and editor without an unhandled change rejection', async () => {
  const h = targetHarness(), draft = h.node('chat-input').value;
  h.context.appConfirm = async () => { throw new Error('Synthetic dialog failure'); };
  await assert.doesNotReject(h.choose('modelProfileId', 'model_second'));
  assert.equal(h.first().modelProfileId, null); assert.equal(h.writes.length, 0);
  assert.equal(h.node('chat-input').value, draft); assert.equal(h.notices.length, 1);
});

test('the actual general AI entry creates an empty owned AI session and preserves the previous editor', async () => {
  const h = harness(JSON.stringify(persistedState())); h.context.boot();
  const beforeCount = h.context.sessions.length;
  h.node('chat-input').value = 'Kept when opening a new general AI session';
  await h.node('btn-general-ai').dispatchEvent({ type: 'click' });
  assert.notEqual(h.context.activeSessionId, 'first', 'the visible general AI entry must execute its production handler');
  const created = h.context.activeSession();
  assert.equal(h.context.sessions.length, beforeCount + 1); assert.equal(created.assistantId, 'assistant_general');
  assert.equal(created.identityType, 'ai'); assert.equal(created.modelProfileId, null); assert.equal(created.projectId, null);
  assert.equal(created.messages.length, 0); assert.equal(h.node('chat-input').value, '');
  assert.equal(h.context.chatState.draftsBySession.first.text, 'Kept when opening a new general AI session');
  assert.equal(h.context.chatState.draftsBySession.second.text, 'Other session must remain unchanged');
  assert.equal(h.context.window.codex.chat, undefined); assert.equal(h.context.window.codex.sendChat, undefined);
});
