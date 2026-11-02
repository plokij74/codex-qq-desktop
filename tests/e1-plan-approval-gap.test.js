'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../src/ai/message-schema');
const helper = require('../src/renderer/e2-messages');
const chat = require('../src/renderer/e4-chat-state');
const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function extract(start, end) { const a = appSource.indexOf(start), b = appSource.indexOf(end, a); assert.ok(a >= 0 && b > a); return appSource.slice(a, b); }

test('G04 finalized Plan creates its request ledger before invoke, without a pre-acceptance bubble', async () => {
  const session = { id: 's', assistantId: 'assistant_codex', identityType: 'ai', messages: [schema.createMessageV2({ role: 'assistant', parts: [{ type: 'plan', planId: 'p', markdown: 'steps', status: 'proposed' }] })] };
  const trace = [];
  const state = chat.createState({ sessions: [session], activeSessionId: 's' });
  chat.updateDraft(state, 's', { text: 'Keep this newer draft', attachmentRefs: [] });
  const ctx = {
    sessions: [session], activeSessionId: 's', chatState: state, pendingChatRequests: new Map(), sending: false, chatRun: null,
    modelManager: { getState: () => ({ revision: 4 }) }, sessionProject: () => null,
    window: { E4ChatState: chat, codex: { messageSchema: schema, approvePlan: async payload => {
      const entry = ctx.pendingChatRequests.get(payload.clientRequestId);
      assert.ok(entry); assert.equal(entry.planId, 'p'); assert.equal(ctx.chatRun, null);
      assert.equal(payload.assistantId, 'assistant_codex'); assert.equal(payload.expectedRegistryRevision, 4);
      assert.equal(payload.messages.length, 1); assert.equal(ctx.sending, true);
      trace.push('invoke');
      return { ok: true, accepted: true, sessionId: 's', runId: 'plan-run', clientRequestId: payload.clientRequestId };
    } } },
    setSending: value => { ctx.sending = value; }, syncModelSessionReferences: async () => { trace.push('sync'); },
    cloneForIpc: value => structuredClone(value), settleChatInvoke: (entry, result) => {
      assert.equal(result.accepted, true); assert.equal(entry.outbox.clientRequestId, result.clientRequestId);
      assert.equal(entry.consumeDraft, false); trace.push('settle');
    },
    rejectChatEntry: () => { throw new Error('Unexpected Plan refusal'); }, toast() {}, saveState() {}, renderMessages() {}, renderLeftDynamic() {}, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function approvePlanFromCard(', '\nfunction renderVerifyStrip'), ctx);
  await ctx.approvePlanFromCard(null, { sessionId: 's', planId: 'p' });
  assert.deepEqual(trace, ['sync', 'invoke', 'settle']);
  assert.equal(ctx.pendingChatRequests.size, 1); assert.equal(ctx.chatRun, null);
  assert.equal(session.messages.length, 1); assert.equal(session.messages[0].parts[0].status, 'proposed');
  assert.equal(state.draftsBySession.s.text, 'Keep this newer draft');
  // Only matching run-start/Plan events can create a bubble; accepted invoke is not a completed Plan.
  assert.equal(ctx.sending, true);
});

test('G05 real schema-v3 save bounds trajectories and reload expires historical authorization', () => {
  const output = new Map();
  const msg = { role: 'assistant', content: 'hello', parts: [{ type: 'plan', planId: 'p', status: 'proposed' }], trajectory: Array.from({ length: 80 }, () => ({ kind: 'tool', tool: 'read', detail: { token: 'secret', output: 'x'.repeat(5000) } })) };
  const state = chat.createState({ sessions: [{ id: 's', assistantId: 'assistant_codex', identityType: 'ai', messages: [msg] }], activeSessionId: 's' });
  const ctx = { sessions: state.sessions, projects: [], activeSessionId: 's', pluginState: {}, chatState: state,
    storageWriteBlocked: false, draftPersistenceError: '', STORAGE_KEY: 'state', localStorage: { setItem: (key, value) => output.set(key, value) },
    document: { getElementById: () => null }, ensureSessionCandidateState() {}, ensureSessionWorktreeState() {},
    window: { E4ChatState: chat, codex: { messageSchema: schema }, E2Messages: helper }, console,
  };
  vm.createContext(ctx); vm.runInContext(extract('function saveState()', '\nfunction activeSession()'), ctx);
  assert.equal(ctx.saveState(), true);
  const container = JSON.parse(output.get('state')), stored = container.sessions[0].messages[0];
  assert.equal(container.schemaVersion, 3); assert.equal(stored.trajectory.length, 50);
  assert.equal(stored.trajectory[0].detail.token, '[REDACTED]'); assert.ok(stored.trajectory[0].detail.output.length < 2100);
  vm.runInContext(extract('function normalizeSessionMessageClient(', '\nfunction loadState()'), ctx);
  const restored = ctx.normalizeSessionMessageClient(stored);
  assert.equal(restored.parts[0].status, 'expired'); assert.equal(restored.trajectory.length, 50);
});
