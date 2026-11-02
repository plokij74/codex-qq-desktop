'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const chat = require('../src/renderer/e4-chat-state');

const oldState = () => ({
  sessions: [
    { id: 'old-codex', title: '自定义 Codex 标题', peer: 'codex', kind: 'task', projectId: 'p1', agentMode: 'plan', messages: [{ role: 'assistant', content: 'old answer' }] },
    { id: 'old-demo', title: 'Randy 的旧标题', peer: 'randy', kind: 'friend', messages: [{ role: 'assistant', content: '旧模拟历史' }] },
  ],
  projects: [{ id: 'p1', name: 'demo', path: '' }], activeSessionId: 'old-demo', pluginState: { p1: false },
});

test('v2 and legacy sessions migrate idempotently without relabeling old messages', () => {
  const first = chat.migrateState(oldState());
  assert.equal(first.ok, true);
  assert.equal(first.state.schemaVersion, 3);
  assert.equal(first.state.sessions[0].assistantId, 'assistant_codex');
  assert.equal(first.state.sessions[0].identityType, 'ai');
  assert.equal(first.state.sessions[0].title, '自定义 Codex 标题');
  assert.equal(first.state.sessions[0].agentMode, 'plan');
  assert.equal(first.state.sessions[1].identityType, 'demo-contact');
  assert.equal(first.state.sessions[1].legacyPeer, 'randy');
  assert.equal(first.state.sessions[1].messages[0].content, '旧模拟历史');
  assert.equal(first.state.sessions[0].messages[0].modelSource, undefined, 'old Codex source cannot be inferred');
  assert.deepEqual(first.state.sessions[1].messages[0].modelSource, { kind: 'legacy-demo' });
  assert.deepEqual(chat.migrateState(first.state).state, first.state);
});

test('unsupported future version and storage write failures preserve prior data', () => {
  assert.equal(chat.migrateState({ schemaVersion: 9, sessions: [] }).code, 'UNSUPPORTED_VERSION');
  const original = oldState();
  let stored = 'untouched';
  const failed = chat.writeState({ setItem() { throw new Error('quota'); } }, 'codex-qq-state-v3', original);
  assert.equal(failed.ok, false);
  assert.equal(original.sessions[0].title, '自定义 Codex 标题');
  assert.equal(stored, 'untouched');
});

test('malformed v3 and oversized restored drafts fail visibly instead of becoming empty defaults', () => {
  for (const value of [{ schemaVersion: 3 }, { schemaVersion: 3, sessions: 'broken' }, { schemaVersion: -1, sessions: [] }, { schemaVersion: 'oops', sessions: [] }]) {
    assert.equal(chat.migrateState(value).ok, false);
  }
  const invalid = chat.createState({ sessions: [{ id: 's' }] });
  invalid.draftsBySession.s.text = 'x'.repeat(chat.MAX_DRAFT_TEXT_BYTES + 1);
  assert.equal(chat.migrateState(invalid).ok, false);
  assert.equal(invalid.draftsBySession.s.text.length, chat.MAX_DRAFT_TEXT_BYTES + 1);
});

test('aggregate persistence limit does not evict any otherwise valid session draft', () => {
  const sessions = Array.from({ length: 17 }, (_, index) => ({ id: `s${index}` }));
  const state = chat.createState({ sessions });
  for (const session of sessions) chat.updateDraft(state, session.id, { text: 'x'.repeat(chat.MAX_DRAFT_TEXT_BYTES) });
  assert.equal(chat.persistableState(state).code, 'DRAFT_TOTAL_LIMIT');
  assert.equal(Object.values(state.draftsBySession).every((draft) => draft.text.length === chat.MAX_DRAFT_TEXT_BYTES), true);
});

test('only safe existing attachment metadata enters persistent drafts', () => {
  const state = chat.createState({ sessions: [{ id: 's' }] });
  const draft = chat.updateDraft(state, 's', { text: 'draft', attachmentRefs: [{ attachmentId: 'att1', name: 'x.png', mimeType: 'image/png', size: 12, localAbsPath: 'C:\\secret', dataUrl: 'data:image/png;base64,secret' }] });
  assert.equal(draft.ok, true);
  const saved = chat.persistableState(state);
  assert.equal(saved.ok, true);
  const attachment = saved.value.draftsBySession.s.attachmentRefs[0];
  assert.equal(attachment.localAbsPath, undefined);
  assert.equal(attachment.dataUrl, undefined);
  assert.deepEqual(Object.keys(attachment).sort(), ['attachmentId', 'mimeType', 'name', 'size']);
});

test('aggregate persistence limit measures the serialized UTF-8 drafts rather than unescaped text', () => {
  const sessions = Array.from({ length: 9 }, (_, index) => ({ id: `escaped-${index}` }));
  const state = chat.createState({ sessions });
  for (const session of sessions) chat.updateDraft(state, session.id, { text: '\n'.repeat(chat.MAX_DRAFT_TEXT_BYTES) });
  assert.ok(Buffer.byteLength(JSON.stringify(state.draftsBySession), 'utf8') > chat.MAX_TOTAL_DRAFT_BYTES);
  assert.equal(chat.persistableState(state).code, 'DRAFT_TOTAL_LIMIT');
  assert.equal(Object.values(state.draftsBySession).every((draft) => draft.text.length === chat.MAX_DRAFT_TEXT_BYTES), true);
});

test('migration rejects orphan drafts instead of reporting successful loss', () => {
  const original = { schemaVersion: 3, sessions: [{ id: 's', messages: [] }],
    draftsBySession: { s: { text: 'kept' }, missing: { text: 'must not disappear' } } };
  const before = structuredClone(original);
  const result = chat.migrateState(original);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_STATE');
  assert.deepEqual(original, before);
});

test('migration rejects malformed draft contents instead of silently restoring emptiness', () => {
  for (const draft of [null, 'lost text', { text: ['lost text'] }, { text: 'valid', attachmentRefs: 'lost refs' }]) {
    const original = { schemaVersion: 3, sessions: [{ id: 's', messages: [] }], draftsBySession: { s: draft } };
    const before = structuredClone(original);
    assert.equal(chat.migrateState(original).ok, false);
    assert.deepEqual(original, before);
  }
});

test('migration rejects malformed message collections and normalized duplicate session ids', () => {
  for (const sessions of [[{ id: 's', messages: { content: 'must not disappear' } }], [{ id: 1 }, { id: '1' }]]) {
    const original = { schemaVersion: 3, sessions };
    const before = structuredClone(original);
    assert.equal(chat.migrateState(original).ok, false);
    assert.deepEqual(original, before);
  }
});
