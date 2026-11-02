'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const chat = require('../src/renderer/e4-chat-state');

const session = (id) => ({ id, identityType: 'ai', assistantId: 'assistant_codex', modelProfileId: null, messages: [] });

test('drafts remain session-scoped and an old outbox cannot clear newer edits', () => {
  const state = chat.createState({ sessions: [session('a'), session('b')] });
  assert.equal(chat.updateDraft(state, 'a', { text: 'first' }).ok, true);
  assert.equal(chat.updateDraft(state, 'b', { text: 'second' }).ok, true);
  const outbox = chat.createOutbox({ state, sessionId: 'a', expectedRegistryRevision: 8, text: state.draftsBySession.a.text, messages: [{ role: 'user', content: 'first' }] });
  assert.equal(Object.isFrozen(outbox), true);
  assert.equal(chat.updateDraft(state, 'a', { text: 'new edit' }).ok, true);
  chat.finishOutbox(state, outbox, { accepted: true });
  assert.equal(state.draftsBySession.a.text, 'new edit');
  assert.equal(state.draftsBySession.b.text, 'second');
});

test('draft limits retain the actual in-memory draft across session switches without persisting it', () => {
  const state = chat.createState({ sessions: [session('a'), session('b')] });
  chat.updateDraft(state, 'b', { text: 'other session must survive' });
  const tooLong = 'x'.repeat(chat.MAX_DRAFT_TEXT_BYTES + 1);
  assert.equal(chat.updateDraft(state, 'a', { text: tooLong }).ok, false);
  assert.equal(state.draftsBySession.a.text, tooLong);
  assert.equal(chat.persistableState(state).ok, false);
  const many = Array.from({ length: chat.MAX_DRAFT_ATTACHMENTS + 1 }, (_, i) => ({ attachmentId: String(i), name: 'a' }));
  assert.equal(chat.updateDraft(state, 'a', { attachmentRefs: many }).ok, false);
  assert.equal(state.draftsBySession.a.attachmentRefs.length, many.length);
  assert.equal(state.draftsBySession.b.text, 'other session must survive');
  assert.equal(chat.updateDraft(state, 'a', { text: 'keep', attachmentRefs: [] }).ok, true);
  assert.equal(chat.persistableState(state).ok, true);
});

test('unchanged draft writes do not advance revisions, so switching sessions can consume the accepted snapshot', () => {
  const state = chat.createState({ sessions: [session('a'), session('b')] });
  chat.updateDraft(state, 'a', { text: 'same' });
  const outbox = chat.createOutbox({ state, sessionId: 'a', text: 'same' });
  chat.updateDraft(state, 'a', { text: 'same', attachmentRefs: [] });
  assert.equal(chat.finishOutbox(state, outbox, { accepted: true }), true);
  assert.equal(state.draftsBySession.a.text, '');
});

test('outbox storage retains refused immutable snapshots, never silently evicts, and frees accepted requests', () => {
  const state = chat.createState({ sessions: [session('a')] });
  chat.updateDraft(state, 'a', { text: 'old draft' });
  const outbox = chat.createOutbox({ state, sessionId: 'a', text: 'old draft' });
  const store = chat.createOutboxStore({ maxEntries: 1, maxBytes: 2048 });
  assert.equal(store.add(outbox).ok, true);
  store.fail(outbox.clientRequestId, 'BUSY');
  chat.updateDraft(state, 'a', { text: 'new edit' });
  const next = chat.createOutbox({ state, sessionId: 'a', text: 'new edit' });
  assert.equal(store.add(next).code, 'OUTBOX_LIMIT');
  assert.equal(store.list('a')[0].outbox.draftText, 'old draft');
  assert.equal(state.draftsBySession.a.text, 'new edit');
  assert.equal(store.accept(outbox.clientRequestId), true);
  assert.equal(store.add(next).ok, true);
});

test('run ledger requires run-start acceptance and deduplicates terminal events', () => {
  const ledger = chat.createRunLedger({ sessionId: 'a', clientRequestId: 'req-a' });
  assert.equal(chat.applyRunEvent(ledger, { type: 'task-status', task: { kind: 'session_compact' } }).accepted, false);
  assert.equal(chat.applyRunEvent(ledger, { type: 'done', runId: 'run-a' }).terminal, false);
  const accepted = chat.applyRunEvent(ledger, { type: 'run-start', runId: 'run-a', sessionId: 'a', clientRequestId: 'req-a' });
  assert.equal(accepted.accepted, true);
  assert.equal(chat.applyRunEvent(ledger, { type: 'done', runId: 'run-a', sessionId: 'a', clientRequestId: 'req-a' }).terminal, true);
  assert.equal(chat.applyRunEvent(ledger, { type: 'error', runId: 'run-a', sessionId: 'a', clientRequestId: 'req-a' }).terminal, false);
  assert.equal(chat.applyRunEvent(ledger, { type: 'text-delta', runId: 'run-a', sessionId: 'a', clientRequestId: 'req-a', text: 'late' }).ignore, true);
  assert.equal(chat.applyRunEvent(ledger, { type: 'run-start', runId: 'run-a', sessionId: 'a', clientRequestId: 'req-a' }).ignore, true);
});

test('model source preserves only the bounded public whitelist', () => {
  const input = { kind: 'api', assistantId: 'assistant_codex', assistantName: 'Accepted Codex assistant', providerId: 'p1', modelProfileId: 'm1', protocol: 'openai-chat-completions', model: 'x', providerRevision: 2, modelRevision: 3, assistantRevision: 4, runId: 'r1', clientRequestId: 'c1', source: 'secret', providerState: { apiKey: 'secret' }, apiKey: 'secret' };
  const source = chat.normalizeModelSource(input);
  assert.deepEqual(Object.keys(source).sort(), ['assistantId', 'assistantName', 'clientRequestId', 'kind', 'model', 'modelProfileId', 'modelRevision', 'protocol', 'providerId', 'providerRevision', 'runId', 'assistantRevision'].sort());
  assert.equal(source.apiKey, undefined);
  assert.equal(source.providerState, undefined);
  assert.equal(chat.normalizeModelSource({ kind: 'not-real' }), null);
});
