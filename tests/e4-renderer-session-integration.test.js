'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const chat = require('../src/renderer/e4-chat-state');
const schema = require('../src/ai/message-schema');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function storageHarness(value) {
  const storage = new Map(value === undefined ? [] : [[chat.STORAGE_KEY, value]]), writes = [], notices = [];
  const status = { textContent: '', hidden: true };
  const context = vm.createContext({
    window: { E4ChatState: chat, E2Messages: require('../src/renderer/e2-messages'), codex: { messageSchema: schema } },
    sessions: [], projects: [], activeSessionId: '', pluginState: {}, chatState: chat.createState(),
    storageWriteBlocked: false, draftPersistenceError: '', STORAGE_KEY: chat.STORAGE_KEY,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); storage.set(key, value); } },
    defaultSessions: () => [{ id: 'seed', messages: [], peer: 'codex', assistantId: 'assistant_codex', identityType: 'ai' }],
    defaultProjects: () => [{ id: 'example-project' }], normalizeSessionAgentMode: (value) => value === 'plan' ? 'plan' : 'agent',
    ensureSessionCandidateState() {}, ensureSessionWorktreeState() {},
    syncModelSessionReferences: async () => ({ ok: true }),
    document: { getElementById: () => status }, toast: (notice) => notices.push(notice), setTimeout: (callback) => { callback(); return 1; },
  });
  vm.runInContext(section('function normalizeSessionMessageClient(', 'let referenceSyncFingerprint'), context);
  return { context, storage, writes, notices, status };
}
for (const value of ['{broken', JSON.stringify({ schemaVersion: 9, sessions: [] }), JSON.stringify({ schemaVersion: 3, sessions: [{}] })]) {
  test('real load rejects malformed or future data without overwriting it with seeded defaults', () => {
    const h = storageHarness(value); h.context.loadState(); h.context.saveState();
    assert.equal(h.context.storageWriteBlocked, true);
    assert.equal(h.storage.get(chat.STORAGE_KEY), value);
    assert.equal(h.context.sessions.some((s) => s.id === 'seed'), false);
    assert.equal(h.status.hidden, false);
    assert.match(h.status.textContent, /原数据|保留|恢复|未保存/);
  });
}
test('real valid empty v3 does not re-seed sample sessions or projects', () => {
  const h = storageHarness(JSON.stringify(chat.createState())); h.context.loadState();
  assert.equal(h.context.sessions.length, 0); assert.equal(h.context.projects.length, 0);
  assert.equal(h.context.storageWriteBlocked, false);
});
test('oversized restored draft remains accessible in memory while original disk container is protected', () => {
  const state = chat.createState({ sessions: [{ id: 's', messages: [], assistantId: 'assistant_general', identityType: 'ai' }] });
  state.draftsBySession.s.text = 'x'.repeat(65537);
  const value = JSON.stringify(state), h = storageHarness(value); h.context.loadState(); h.context.saveState();
  assert.equal(h.context.chatState.draftsBySession.s.text.length, 65537);
  assert.equal(h.storage.get(chat.STORAGE_KEY), value);
  assert.equal(h.context.storageWriteBlocked, true);
});
test('real save reports quota failure and leaves previous successful container unchanged', () => {
  const state = chat.createState({ sessions: [{ id: 's', messages: [], assistantId: 'assistant_general', identityType: 'ai' }] });
  const value = JSON.stringify(state), h = storageHarness(value); h.context.loadState();
  h.context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(h.context.saveState(), false);
  assert.equal(h.storage.get(chat.STORAGE_KEY), value);
  assert.equal(h.status.hidden, false); assert.match(h.status.textContent, /QuotaExceededError/);
});
