'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

function functionSource(name, optional = false) {
  let start = source.indexOf(`function ${name}(`);
  if (start < 0) { if (optional) return ''; throw new Error(`Missing production function ${name}`); }
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const following = /\n(?:async )?function [A-Za-z_$]/g;
  following.lastIndex = start + 10;
  const match = following.exec(source);
  return source.slice(start, match ? match.index : source.length);
}
function harness() {
  const old = { id: 'old', title: 'Old AI', kind: 'assistant', identityType: 'ai', assistantId: 'assistant_general', modelProfileId: null, projectId: null, messages: [] };
  const other = { ...old, id: 'other', title: 'Other AI' };
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: false,
      focus() {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {} });
    return nodes.get(id);
  };
  node('chat-input').value = 'Unsaved original draft';
  const registry = { revision: 1, defaultModelProfileId: 'm', providers: [{ id: 'p', name: 'Current provider', baseUrl: 'https://new-target.example.invalid/v1' }],
    models: [{ id: 'm', name: 'Different current model', model: 'current-model', providerId: 'p', bindingRevision: 'wire-1' }],
    assistants: [{ id: 'assistant_general', name: 'General', identityType: 'ai' }, { id: 'assistant_codex', name: 'Codex', identityType: 'ai' }] };
  const context = { console, URL, Date, Map, Set, setTimeout, clearTimeout, sessions: [old, other], projects: [{ id: 'project', name: 'Project', path: '' }],
    chatState: chat.createState({ schemaVersion: 3, sessions: [old, other], activeSessionId: 'old' }), activeSessionId: 'old',
    pendingAttaches: [], pendingAttachmentsBySession: new Map(), pendingChatRequests: new Map(), pendingCompactRequests: new Map(),
    activeForegroundTask: null, chatRun: null, sending: false, defaultAgentModeSeed: 'agent', taskModalSubmitting: false,
    draftPersistenceError: '', storageWriteBlocked: false, saved: 0, warnings: [], sends: [],
    document: { getElementById: node }, window: { E4ChatState: chat },
    modelManager: { getState: () => ({ registry, mode: 'api' }) },
    FRIENDS: [{ id: 'codex', name: 'Codex' }, { id: 'legacy', name: 'Legacy friend' }],
    uid: (() => { let n = 0; return (kind) => `${kind}_${++n}`; })(),
    appConfirm: async () => true,
    saveState() { context.saved += 1; return !context.failSave; },
    toast(message) { context.warnings.push(message); },
    renderAttachPreview() {}, renderLeftDynamic() {}, renderMessages() {}, updateHeader() {}, renderFriends() {},
    updateStatusBar() {}, updateAgentModeToggle() {}, reconcileWorktreeResults() {}, setView() {}, closeTaskModal() {},
    sendMessage() { context.sends.push(node('chat-input').value); },
  };
  context.chatState.sessions = context.sessions;
  context.chatState.draftsBySession.other = { text: 'Other saved draft', attachmentRefs: [], revision: 1, updatedAt: 1 };
  vm.createContext(context);
  const functions = ['activeSession', 'ensureDraftSlot', 'currentAttachmentRefs', 'persistActiveDraft', 'persistBeforeSessionChange', 'restoreSessionDraft',
    'getAssistantForSession', 'getEffectiveModelForSession', 'modelOrigin', 'modelSourceLabel', 'getProject', 'sessionProject',
    'openProjectChat', 'openFriendChat', 'createAiSession', 'ensureTaskAndAsk', 'createTaskFromModal', 'switchSession',
    'deleteSession', 'deleteProject'];
  vm.runInContext(functions.map((name) => functionSource(name)).join('\n') + '\n' + functionSource('sessionHasForegroundWork', true), context);
  return { context, node, registry, old, other };
}

test('every AI session creation/open route saves the old editor before changing ownership', async (t) => {
  const routes = [
    ['AI create', (c) => c.createAiSession()], ['project open', (c) => c.openProjectChat('project')],
    ['Codex open', (c) => c.openFriendChat('codex')], ['task auto ask', (c) => c.ensureTaskAndAsk('Task', 'First task message')],
    ['task modal', (c, node) => { node('task-title').value = 'Task'; c.createTaskFromModal(); }],
  ];
  for (const [label, run] of routes) await t.test(label, () => {
    const { context, node } = harness(); run(context, node);
    assert.equal(context.chatState.draftsBySession.old?.text, 'Unsaved original draft');
    assert.notEqual(context.activeSessionId, 'old');
    assert.equal(context.chatState.draftsBySession[context.activeSessionId]?.text || '', label === 'task auto ask' ? 'First task message' : '');
    assert.equal(context.chatState.draftsBySession.other.text, 'Other saved draft');
  });
});

test('failed persistence remains an explicit draft error instead of reporting success', () => {
  const { context } = harness(); context.failSave = true;
  const result = context.persistActiveDraft();
  assert.equal(result.ok, false); assert.match(result.error, /保存|持久化|storage/i);
  assert.equal(context.chatState.draftsBySession.old.text, 'Unsaved original draft');
});

test('deleting an active idle session restores its successor draft and discards only removed draft state', async () => {
  const { context, node } = harness(); await context.deleteSession('old');
  assert.equal(context.activeSessionId, 'other'); assert.equal(node('chat-input').value, 'Other saved draft');
  assert.equal(Object.hasOwn(context.chatState.draftsBySession, 'old'), false);
  assert.equal(context.chatState.draftsBySession.other.text, 'Other saved draft');
});

test('manual compact and a preaccept outbox both prevent deletion of their owning session', async (t) => {
  for (const type of ['manual compact', 'preaccept chat']) await t.test(type, async () => {
    const { context } = harness();
    if (type === 'manual compact') context.activeForegroundTask = { kind: 'session_compact', sessionId: 'old', accepted: true, runId: 'run' };
    else context.pendingChatRequests.set('request', { outbox: { sessionId: 'old' } });
    await context.deleteSession('old');
    assert.equal(context.sessions.some((item) => item.id === 'old'), true);
    assert.match(context.warnings.join(' '), /进行|执行|等待|停止/);
  });
});

test('historical source labels use the immutable recorded remote model, not current profile names', () => {
  const { context } = harness();
  const label = context.modelSourceLabel({ kind: 'api', providerId: 'p', modelProfileId: 'm', model: 'original-remote-model', protocol: 'openai-responses' });
  assert.match(label, /original-remote-model/); assert.match(label, /openai-responses/);
  assert.doesNotMatch(label, /Different current model|current-model/);
  assert.match(context.modelSourceLabel(null), /未知|历史/);
});

test('renderer provenance preserves full configured model identifiers without persisting private fields', () => {
  const model = 'm'.repeat(256), norm = chat.normalizeModelSource({ kind: 'api', model, endpoint: 'private', credentialRevision: 4, providerState: { secret: true } });
  assert.equal(norm.model, model); assert.equal(norm.endpoint, undefined); assert.equal(norm.credentialRevision, undefined); assert.equal(norm.providerState, undefined);
});

for (const message of [
  { role: 'system', content: 'Synthetic compacted history summary', compactSummary: true },
  { role: 'assistant', content: 'Synthetic retained assistant history' },
]) test(`target switch discloses ${message.role}-only context before changing origin`, async () => {
  const { context, node, registry, old } = harness();
  context.window.E4Models = require('../src/renderer/e4-models');
  old.messages = [{ ...message }]; context.persistActiveDraft();
  registry.providers.push({ id: 'p2', baseUrl: 'https://other-target.example.invalid/v1' });
  registry.models.push({ id: 'm2', providerId: 'p2', model: 'other-model' });
  const handlers = new Map(), confirmations = [];
  for (const id of ['chat-model-select', 'chat-assistant-select']) node(id).addEventListener = (type, callback) => handlers.set(`${id}:${type}`, callback);
  context.appConfirm = async (text, title) => { confirmations.push({ text, title }); return false; };
  const from = source.indexOf('  const confirmTargetChange = async (');
  const to = source.indexOf("  document.getElementById('agent-mode-toggle')", from);
  assert.ok(from >= 0 && to > from, 'actual target switch handlers exist');
  vm.runInContext(source.slice(from, to), context);
  const draftRevision = context.chatState.draftsBySession.old.revision, saved = context.saved;
  await handlers.get('chat-model-select:change')({ target: { value: 'm2' } });
  assert.equal(confirmations.length, 1); assert.match(confirmations[0].text, /other-target\.example\.invalid/);
  assert.equal(old.modelProfileId, null); assert.equal(old.assistantId, 'assistant_general');
  assert.equal(node('chat-input').value, 'Unsaved original draft');
  assert.equal(context.chatState.draftsBySession.old.revision, draftRevision); assert.equal(context.saved, saved);
});
