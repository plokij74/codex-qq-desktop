'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} section exists`);
  return source.slice(from, to);
}
function harness(overrides = {}) {
  const state = chat.createState({ sessions: [
    { id: 'session', peer: 'codex', identityType: 'ai', assistantId: 'assistant_codex', modelProfileId: null, messages: [], agentMode: 'plan' },
    { id: 'other', peer: 'codex', identityType: 'ai', assistantId: 'assistant_general', modelProfileId: null, messages: [], agentMode: 'agent' },
  ] });
  const input = { value: 'Make a plan', focus() {} };
  const finalized = [], warnings = [], calls = [], notices = [];
  const context = vm.createContext({
    setTimeout, clearTimeout, TextEncoder, structuredClone,
    console: { warn: (...args) => warnings.push(args), error: (_label, error) => { throw error; } },
    document: { getElementById: (id) => id === 'chat-input' ? input : null },
    chatState: state, sessions: state.sessions, activeSessionId: 'session',
    activeSession: () => context.sessions.find((s) => s.id === context.activeSessionId), sessionProject: () => null,
    sending: false, chatRun: null, pendingAttaches: [], localSendToken: null,
    pendingAttachmentsBySession: new Map(), pendingChatRequests: new Map(), pendingCompactRequests: new Map(),
    chatOutboxStore: chat.createOutboxStore(), completedChatRuns: new Map(), activeForegroundTask: null,
    buildOutgoingText: (text) => text, handleSlashCommand: () => false,
    cloneForIpc: (value) => JSON.parse(JSON.stringify(value)),
    sessionAgentMode: (s) => s.agentMode, bindWorktreeProject: async () => '',
    currentAttachmentRefs: () => context.pendingAttaches.map((a) => ({ ...a })),
    persistActiveDraft: () => chat.updateDraft(state, context.activeSessionId, { text: input.value, attachmentRefs: context.currentAttachmentRefs() }),
    restoreSessionDraft: (s) => { input.value = state.draftsBySession[s.id].text; context.pendingAttaches = state.draftsBySession[s.id].attachmentRefs.slice(); },
    renderAttachPreview() {}, hideAtComplete() {}, saveState() {}, renderMessages() {}, renderLeftDynamic() {}, renderOutboxRecovery() {},
    updateHeader() {}, renderFriends() {}, updateStatusBar() {}, reconcileWorktreeResults() {},
    updateForegroundUi() {}, syncModelSessionReferences: async () => ({ ok: true }),
    setSending: (value) => { context.sending = value; },
    createAssistantRunPlaceholder: (sessionId) => (context.chatRun = {
      sessionId, runId: null, el: { dataset: {}, remove() {} },
      trajectory: [], fileChanges: [], textBuffer: '', finalized: false, invokeDone: false, doneEvent: false,
    }),
    finalizeChatRun: (opts = {}) => {
      const run = context.chatRun;
      finalized.push({ ...opts, aborted: opts.aborted || run.aborted, plan: run.planPart, trajectory: [...run.trajectory] });
      context.sessions.find((s) => s.id === run.sessionId).messages.push({ role: 'assistant', content: opts.content || run.contentFinal || run.textBuffer || '', modelSource: run.modelSource });
      run.finalized = true; context.chatRun = null;
    },
    handleTerminalPanelEvent: () => false, handleWorktreeEvent() {},
    setRunStatus() {}, toolArgsSummary: () => '', appendTimelineRow() {}, disableApprovalCards() {}, updateAgentModeToggle() {}, toast: (s) => notices.push(s),
    updateStreamBody() {}, renderUsageBar() {}, renderContextMeter() {}, renderFileChangesStrip() {},
    renderMarkdownLite: (s) => s, mergeFileChangeEntry: (list, entry) => list.push(entry),
    applyUsageToSession: (s, ev) => { s.usageCount = (s.usageCount || 0) + 1; },
    renderPlanCard: (event) => { context.chatRun.planPart = { type: 'plan', planId: event.planId, status: 'proposed' }; },
    setPersistedPlanStatus: (id, _planId, status) => { context.sessions.find((s) => s.id === id).planStatus = status; },
    worktreeBindings: new Map(),
    modelManager: { getState: () => ({ revision: 3, mode: 'api', registry: { models: [], assistants: [] } }), load: async () => ({ ok: true }) },
    currentProjectRef: () => null, ensureSessionCandidateState: () => ({}),
    window: { MemoryCandidateState: { candidateLimit: () => 0, PER_BATCH_MAX: 10, PENDING_MAX: 100 }, E4ChatState: chat, E2Messages: require('../src/renderer/e2-messages'), codex: {
      compactSession: async (payload) => { calls.push(['compact', payload]); return { ok: true, accepted: true, runId: 'compact-run', sessionId: payload.sessionId, clientRequestId: payload.clientRequestId }; },
      messageSchema: { normalizeMessage: (m) => m, projectToStorageJson: (m) => m },
      sendChat: async (payload) => { calls.push(['send', payload]); return { ok: true, accepted: true, runId: 'run', sessionId: payload.sessionId, clientRequestId: payload.clientRequestId }; },
      approvePlan: async (payload) => { calls.push(['approve', payload]); return { ok: true, accepted: true, runId: 'execution', sessionId: payload.sessionId, clientRequestId: payload.clientRequestId }; },
      stopChat: async (payload) => { calls.push(['stop', payload]); return { ok: true }; },
      ...overrides,
    } },
  });
  vm.runInContext(section('function waitForChatRunEvents(', 'function createAssistantRunPlaceholder(')
    + section('async function sendMessage()', 'function bindEvents()')
    + section('async function approvePlanFromCard(', 'function setPersistedPlanStatus(')
    + section('function handleCompactEvent(', 'function scrollToBottom(')
    + section('async function stopGenerating()', 'function bindInlineStop()')
    + section('function switchSession(', 'function openFriendChat(')
    + section('async function requestCompact(', 'function applyCompactResult('), context);
  const subscribe = section('    window.codex.onChatEvent((ev) => {', '\n  }\n  window.codex?.onMcpTaskEvent');
  context.window.codex.onChatEvent = (callback) => { context.emit = callback; };
  vm.runInContext(subscribe, context);
  const event = (type, extra = {}, runId = 'run') => ({ type, runId, sessionId: calls[0]?.[1].sessionId || 'session', clientRequestId: calls[0]?.[1].clientRequestId, ...extra });
  return { context, state, input, finalized, warnings, calls, notices, event };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 5));

test('real send path sends schema history to main without unavailable preload model projection', async () => {
  const h = harness();
  h.state.sessions[0].messages.push({ role: 'assistant', schemaVersion: 2, content: 'old', modelSource: { kind: 'api', modelProfileId: 'old' } });
  await h.context.sendMessage();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].messages[0].modelSource.modelProfileId, 'old');
  assert.equal(h.state.sessions[0].messages.length, 1, 'no user/placeholder before accepted event');
  assert.equal(h.input.value, 'Make a plan');
});

test('invoke accepted reply overtaking Plan events consumes draft only once and drains the handler before terminal projection', async () => {
  const h = harness();
  await h.context.sendMessage();
  assert.equal(h.finalized.length, 0);
  h.context.emit(h.event('run-start', { modelSource: { kind: 'api', modelProfileId: 'm1' } }));
  assert.equal(h.input.value, '');
  h.context.emit(h.event('tool-start', { tool: 'submit_plan', callId: 'call' }));
  h.context.emit(h.event('plan-ready', { planId: 'plan' }));
  h.context.emit(h.event('tool-end', { tool: 'submit_plan', callId: 'call', ok: true }));
  h.context.emit(h.event('done', { content: 'Plan submitted.' }));
  assert.equal(h.finalized.length, 0, 'never finalize inside event callback or nested synchronous IPC');
  await turn();
  assert.equal(h.finalized.length, 1);
  assert.equal(h.finalized[0].plan.planId, 'plan');
  assert.equal(h.finalized[0].trajectory[0].status, 'success');
  assert.equal(h.context.sending, false);
  h.context.emit(h.event('done')); h.context.emit(h.event('text-delta', { text: 'late' }));
  assert.equal(h.finalized.length, 1);
});

test('BUSY/preflight retains refused outbox and newer edits without inserting history', async () => {
  let settle;
  const h = harness({ sendChat: (payload) => { h.calls.push(['send', payload]); return new Promise((r) => { settle = r; }); } });
  const pending = h.context.sendMessage();
  await turn();
  h.input.value = 'new edit'; h.context.persistActiveDraft();
  settle({ ok: false, code: 'BUSY', error: 'busy' }); await pending;
  assert.equal(h.state.sessions[0].messages.length, 0);
  assert.equal(h.input.value, 'new edit');
  assert.equal(h.context.chatOutboxStore.list('session')[0].outbox.draftText, 'Make a plan');
  assert.equal(h.context.sending, false);
});

test('switching during accepted streaming keeps all output and usage in the original session, never stops another session', async () => {
  const h = harness();
  await h.context.sendMessage(); h.context.emit(h.event('run-start'));
  h.context.switchSession('other'); h.input.value = 'other draft'; h.context.persistActiveDraft();
  await h.context.stopGenerating();
  assert.equal(h.calls.some(([name]) => name === 'stop'), false);
  h.context.emit(h.event('text-delta', { text: 'first answer' }));
  h.context.emit(h.event('usage', { usageId: 'u1', inputTokens: 5 }));
  h.context.emit(h.event('usage', { usageId: 'u1', inputTokens: 5 }));
  h.context.emit(h.event('done', { content: 'first answer' })); await turn();
  assert.equal(h.state.sessions[0].messages.at(-1).content, 'first answer');
  assert.equal(h.state.sessions[1].messages.length, 0);
  assert.equal(h.state.sessions[0].usageCount, 1);
  assert.equal(h.input.value, 'other draft');
  assert.equal(h.state.draftsBySession.other.text, 'other draft');
});

test('late accepted event after switching consumes unchanged original draft but preserves new draft edits', async () => {
  const h = harness();
  await h.context.sendMessage(); h.context.switchSession('other');
  h.input.value = 'other pending'; h.context.persistActiveDraft();
  h.context.emit(h.event('run-start'));
  assert.equal(h.state.draftsBySession.session.text, '');
  assert.equal(h.state.draftsBySession.other.text, 'other pending');
  assert.equal(h.input.value, 'other pending');
});

test('unknown/missing/mismatched event identity cannot mutate a live run or any history', async () => {
  const h = harness();
  await h.context.sendMessage();
  h.context.emit({ type: 'run-start', sessionId: 'session', runId: 'run', clientRequestId: 'foreign' });
  assert.equal(h.context.chatRun, null);
  h.context.emit(h.event('run-start'));
  for (const invalid of [{ type: 'text-delta', runId: 'run', text: 'missing' }, h.event('done', { sessionId: 'other' }), h.event('done', { runId: 'foreign' }), h.event('done', { clientRequestId: 'foreign' })]) h.context.emit(invalid);
  assert.equal(h.context.chatRun.textBuffer, '');
  assert.equal(h.finalized.length, 0);
});

test('session-compacted must match accepted identity and keeps this turn user, placeholder, and draft', async () => {
  const h = harness();
  h.state.sessions[0].messages.push({ role: 'assistant', content: 'history' });
  await h.context.sendMessage(); h.context.emit(h.event('run-start'));
  h.input.value = 'next turn'; h.context.persistActiveDraft();
  h.context.emit(h.event('session-compacted', { messages: [{ role: 'assistant', content: 'summary', compact: true }] }));
  assert.deepEqual(Array.from(h.state.sessions[0].messages, (m) => m.content), ['summary', 'Make a plan']);
  assert.equal(h.context.chatRun.sessionId, 'session');
  assert.equal(h.input.value, 'next turn');
  h.context.emit(h.event('session-compacted', { clientRequestId: 'foreign', messages: [] }));
  assert.equal(h.state.sessions[0].messages.length, 2);
});

for (const terminal of ['done', 'error', 'aborted']) {
  test(`Plan approval uses correlated accepted run and drains ${terminal} without touching composer`, async () => {
    const h = harness();
    await h.context.approvePlanFromCard(null, { planId: 'plan', sessionId: 'session' });
    assert.equal(h.finalized.length, 0);
    const payload = h.calls[0][1];
    assert.ok(payload.clientRequestId);
    assert.equal(payload.assistantId, 'assistant_codex');
    h.context.emit(h.event('run-start', {}, 'execution'));
    h.context.emit(h.event(terminal, { content: 'Executed.', message: 'Execution failed.' }, 'execution'));
    assert.equal(h.finalized.length, 0);
    await turn();
    assert.equal(h.finalized.length, 1);
    assert.equal(h.context.sending, false);
    assert.equal(h.input.value, 'Make a plan');
    if (terminal === 'aborted') assert.equal(h.finalized[0].aborted, true);
  });
}

test('stop targets only accepted active session and remains stopping until terminal cleanup', async () => {
  const h = harness();
  await h.context.sendMessage(); h.context.emit(h.event('run-start'));
  await h.context.stopGenerating();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), ['stop', { sessionId: 'session', runId: 'run' }]);
  assert.equal(h.context.sending, true);
  assert.equal(h.context.chatRun.stopping, true);
});

for (const terminal of ['compact-done', 'compact-error', 'compact-cancelled']) {
  test(`manual ${terminal} uses its own ledger, does not consume draft, and releases only after handler drains`, async () => {
    const h = harness(); let resolved = false;
    const pending = h.context.requestCompact(h.state.sessions[0], true).then((result) => { resolved = true; return result; });
    await turn(); assert.equal(h.context.sending, true);
    h.context.emit(h.event('compact-start', { task: { kind: 'session_compact' } }, 'compact-run'));
    h.context.switchSession('other'); await h.context.stopGenerating();
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
    h.context.emit(h.event(terminal, { clientRequestId: 'foreign', task: { kind: 'session_compact' } }, 'compact-run'));
    assert.equal(resolved, false);
    h.context.emit(h.event('usage', { usageId: 'c1', task: { kind: 'session_compact' } }, 'compact-run'));
    h.context.emit(h.event('usage', { usageId: 'c1', task: { kind: 'session_compact' } }, 'compact-run'));
    h.context.emit(h.event(terminal, { messages: [{ role: 'assistant', compact: true, content: 'summary' }], error: 'cancelled', task: { kind: 'session_compact' } }, 'compact-run'));
    assert.equal(resolved, false); assert.equal(h.context.sending, true);
    const result = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 50))]);
    assert.ok(result); assert.equal(result.response.ok, terminal === 'compact-done');
    assert.equal(h.context.sending, false); assert.equal(h.context.chatRun, null); assert.equal(h.finalized.length, 0);
    assert.equal(h.state.draftsBySession.session.text, 'Make a plan');
    assert.equal(h.state.sessions[0].usageCount, 1);
  });
}
test('manual BUSY has no placeholder and retains editor/history', async () => {
  const h = harness({ compactSession: async () => ({ ok: false, code: 'BUSY', error: 'busy' }) });
  const result = await h.context.requestCompact(h.state.sessions[0], true);
  assert.equal(result.response.code, 'BUSY'); assert.equal(h.context.sending, false);
  assert.equal(h.input.value, 'Make a plan'); assert.equal(h.finalized.length, 0); assert.equal(h.state.sessions[0].messages.length, 0);
});
for (const terminal of ['error', 'aborted']) test(`${terminal} preserves partialOutput even without preceding text events`, async () => {
  const h = harness(); await h.context.sendMessage(); h.context.emit(h.event('run-start'));
  h.context.emit(h.event(terminal, { message: 'failed', partialOutput: 'retained partial text' })); await turn();
  assert.match(h.state.sessions[0].messages.at(-1).content, /retained partial text/);
});

test('already delivered terminal events leave the current stack before wait completion', async () => {
  const h = harness(); let resolved = false;
  const pending = h.context.waitForChatRunEvents({ doneEvent: true }).then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  await pending; assert.equal(resolved, true);
});

test('missing terminal event has bounded recovery without leaving a waiter', async () => {
  const h = harness(); const run = { runId: 'lost-event', doneEvent: false };
  await h.context.waitForChatRunEvents(run, 5);
  assert.equal(run.onEventsSettled, null); assert.equal(h.warnings.length, 1);
});
