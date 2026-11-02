'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const schema = require('../src/ai/message-schema');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} production section exists`);
  return source.slice(from, to);
}
function element() {
  const children = new Map(), classes = new Set();
  return { dataset: {}, innerHTML: '', textContent: '',
    classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name) },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
    querySelectorAll: () => [], appendChild() {}, addEventListener() {}, remove() {} };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const modelSource = Object.freeze({ kind: 'api', assistantId: 'assistant_codex', providerId: 'provider_fixture', modelProfileId: 'model_fixture', model: 'offline-model', protocol: 'openai-chat-completions', providerRevision: 2, modelRevision: 3, assistantRevision: 1 });
function acceptedFinal(identity, extra = {}) {
  return { ok: true, accepted: true, ...identity, modelSource: { ...modelSource, ...identity }, task: { kind: 'chat_agent', ...identity }, ...extra };
}
// Replace only DOM/infrastructure ports: acceptance, Plan/schema projection,
// finalization, correlation and bounded event drain remain production code.
function harness(t, overrides = {}) {
  const state = chat.createState({ sessions: [
    { id: 'session', peer: 'codex', identityType: 'ai', assistantId: 'assistant_codex', modelProfileId: null, messages: [], agentMode: 'plan' },
    { id: 'other', peer: 'codex', identityType: 'ai', assistantId: 'assistant_general', messages: [], agentMode: 'agent' },
  ] });
  const input = { value: 'Make a plan', focus() {} };
  const calls = [], projections = [], warnings = [], notices = [], timers = new Set();
  const timer = (callback, ms, ...args) => { const handle = setTimeout(() => { timers.delete(handle); callback(...args); }, ms); timers.add(handle); return handle; };
  const cancelTimer = (handle) => { timers.delete(handle); clearTimeout(handle); };
  const invoke = (method, payload) => {
    const identity = { sessionId: payload.sessionId, clientRequestId: payload.clientRequestId, runId: `${method}-run-${calls.length + 1}` };
    calls.push({ method, payload, identity });
    return overrides[method] ? overrides[method](payload, identity) : Promise.resolve(acceptedFinal(identity));
  };
  const context = vm.createContext({
    setTimeout: timer, clearTimeout: cancelTimer, TextEncoder, structuredClone,
    console: { warn: (...args) => warnings.push(args), error: (_label, error) => { throw error; } },
    document: { getElementById: (id) => id === 'chat-input' ? input : null, createElement: element },
    chatState: state, sessions: state.sessions, activeSessionId: 'session',
    activeSession: () => context.sessions.find((session) => session.id === context.activeSessionId), sessionProject: () => null,
    sending: false, chatRun: null, pendingAttaches: [], pendingAttachmentsBySession: new Map(),
    pendingChatRequests: new Map(), pendingCompactRequests: new Map(), completedChatRuns: new Map(),
    activeForegroundTask: null, chatOutboxStore: chat.createOutboxStore(), worktreeBindings: new Map(),
    buildOutgoingText: (text) => text, handleSlashCommand: () => false, cloneForIpc: (value) => JSON.parse(JSON.stringify(value)),
    sessionAgentMode: (session) => session.agentMode, bindWorktreeProject: async () => '',
    currentAttachmentRefs: () => context.pendingAttaches.map((attachment) => ({ ...attachment })),
    persistActiveDraft: () => chat.updateDraft(state, context.activeSessionId, { text: input.value, attachmentRefs: context.currentAttachmentRefs() }),
    restoreSessionDraft: (session) => { input.value = state.draftsBySession[session.id].text; },
    syncModelSessionReferences: async () => ({ ok: true }), setSending: (value) => { context.sending = value; },
    getAssistantForSession: () => ({ name: 'Synthetic assistant' }), peerName: () => 'Synthetic assistant', escapeHtml: (text) => String(text),
    renderAttachPreview() {}, hideAtComplete() {}, saveState() {}, renderMessages() {}, renderLeftDynamic() {}, renderOutboxRecovery() {},
    updateHeader() {}, updateStatusBar() {}, updateForegroundUi() {}, updateAgentModeToggle() {}, scrollToBottom() {},
    handleTerminalPanelEvent: () => false, handleWorktreeEvent() {}, disableApprovalCards() {},
    setRunStatus() {}, toolArgsSummary: () => '', appendTimelineRow() {}, updateStreamBody() {},
    renderUsageBar() {}, renderContextMeter() {}, renderFileChangesStrip() {}, renderMarkdownLite: (text) => String(text),
    mergeFileChangeEntry: (list, entry) => list.push(entry), applyUsageToSession() {},
    toast: (message) => notices.push(message), currentProjectRef: () => null, ensureSessionCandidateState: () => ({}),
    modelManager: { getState: () => ({ revision: 3, mode: 'api', registry: { models: [], assistants: [] } }), load: async () => ({ ok: true }) },
    window: { E4ChatState: chat, E2Messages: require('../src/renderer/e2-messages'),
      MemoryCandidateState: { candidateLimit: () => 0, PER_BATCH_MAX: 10, PENDING_MAX: 100 },
      codex: { messageSchema: schema, sendChat: (payload) => invoke('sendChat', payload), approvePlan: (payload) => invoke('approvePlan', payload), compactSession: (payload) => invoke('compactSession', payload) } },
  });
  vm.runInContext(section('function waitForChatRunEvents(', 'function renderVerifyStrip(')
    + section('function finalizeChatRun(', 'function mcpTaskStatusText(')
    + section('async function sendMessage()', 'function bindEvents()')
    + section('function handleCompactEvent(', 'function scrollToBottom(')
    + section('async function requestCompact(', 'function applyCompactResult('), context);
  const productionWait = context.waitForChatRunEvents;
  context.waitForChatRunEvents = (run, timeoutMs = 5) => productionWait(run, timeoutMs);
  const productionFinalize = context.finalizeChatRun;
  context.finalizeChatRun = (options = {}) => { const run = context.chatRun; productionFinalize(options);
    if (run?.finalized) projections.push({ options, run, message: context.sessions.find((session) => session.id === run.sessionId).messages.at(-1) }); };
  context.window.codex.onChatEvent = (callback) => { context.emit = callback; };
  vm.runInContext(section('    window.codex.onChatEvent((ev) => {', '\n  }\n  window.codex?.onMcpTaskEvent'), context);
  t.after(() => { for (const handle of timers) clearTimeout(handle); timers.clear(); });
  const event = (callIndex, type, extra = {}) => ({ type, ...calls[callIndex].identity, ...extra });
  const session = () => context.sessions.find((item) => item.id === 'session');
  return { context, state, input, calls, projections, warnings, notices, event, session };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, description, budget = 1000) { const deadline = Date.now() + budget;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail(description); await delay(2); } }
async function within(promise, description, budget = 1000) { let timeout;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(description)), budget); })]); }
  finally { clearTimeout(timeout); } }

for (const terminal of ['done', 'error', 'aborted']) test(`terminal paint ${terminal} clears busy before rendering and refreshes accepted source`, async (t) => {
  const final = deferred(), h = harness(t, { sendChat: () => final.promise });
  const paints = [], headers = [];
  h.context.renderMessages = () => {
    const live = h.context.chatRun && h.context.chatRun.sessionId === h.context.activeSessionId && !h.context.chatRun.finalized;
    paints.push({ typing: Boolean(h.context.sending && !live), task: h.context.activeForegroundTask,
      message: [...h.session().messages].reverse().find((item) => item.role === 'assistant') });
  };
  h.context.updateHeader = () => headers.push([...h.session().messages].reverse().find((item) => item.role === 'assistant')?.modelSource);
  const pending = h.context.sendMessage(); await waitUntil(() => h.calls.length === 1, 'send did not reach IPC');
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  h.context.emit(h.event(0, terminal, { content: 'final painted reply', partialOutput: 'final painted reply', error: 'Synthetic terminal error' }));
  await waitUntil(() => h.projections.length === 1, 'terminal did not finalize');
  const paint = paints.find((item) => item.message);
  assert.ok(paint, 'terminal must repaint the projected assistant message');
  assert.equal(paint.typing, false, 'busy must be cleared before the terminal render, not after it');
  assert.equal(paint.task, null, 'the completed task must not remain attached to the terminal paint');
  assert.equal(headers.length, 1, 'terminal must refresh source header once');
  assert.equal(headers[0].model, modelSource.model); assert.equal(headers[0].protocol, modelSource.protocol);
  final.resolve(acceptedFinal(h.calls[0].identity, { ok: terminal === 'done', content: 'final painted reply', aborted: terminal === 'aborted', ...(terminal === 'error' ? { error: 'Synthetic terminal error' } : {}) }));
  await pending;
});

for (const nested of [false, true]) test(`A: ${nested ? 'nested' : 'flat'} final success before run-start drains Plan tools once`, async (t) => {
  const h = harness(t, { sendChat: async (_payload, identity) => { const final = acceptedFinal(identity, { content: 'Plan submitted.' }); return nested ? { ...acceptedFinal(identity), result: final } : final; } });
  await h.context.sendMessage();
  assert.equal(h.projections.length, 0); assert.equal(h.session().messages.length, 0);
  assert.equal(h.input.value, 'Make a plan'); assert.equal(h.state.draftsBySession.session.text, 'Make a plan');
  const entry = h.context.pendingChatRequests.get(h.calls[0].identity.clientRequestId);
  assert.ok(entry?.invokeResult); assert.equal(entry.accepted, false);
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  assert.equal(h.input.value, ''); assert.equal(h.session().messages.length, 1); assert.equal(h.session().messages[0].role, 'user');
  h.context.emit(h.event(0, 'tool-start', { tool: 'submit_plan', callId: 'offline-call' }));
  h.context.emit(h.event(0, 'plan-ready', { planId: 'offline-plan', title: 'Synthetic plan', markdown: 'Read only', steps: ['Inspect'] }));
  h.context.emit(h.event(0, 'tool-end', { tool: 'submit_plan', callId: 'offline-call', ok: true }));
  h.context.emit(h.event(0, 'done', { content: 'Plan submitted.' }));
  assert.equal(h.projections.length, 0);
  await waitUntil(() => h.projections.length === 1, 'Plan terminal did not settle');
  const message = h.projections[0].message;
  assert.equal(message.content, 'Plan submitted.'); assert.equal(message.error, false);
  assert.equal(message.parts.find((part) => part.type === 'plan').planId, 'offline-plan');
  assert.equal(message.trajectory.find((item) => item.callId === 'offline-call').status, 'success');
  assert.equal(message.modelSource.model, 'offline-model'); assert.equal(h.context.sending, false);
  h.input.value = 'next unsent draft'; h.context.persistActiveDraft();
  for (const type of ['run-start', 'done', 'text-delta']) h.context.emit(h.event(0, type, { text: 'late' }));
  await delay(10); assert.equal(h.projections.length, 1); assert.equal(h.session().messages.length, 2);
  assert.equal(h.input.value, 'next unsent draft'); assert.equal(h.state.draftsBySession.session.text, 'next unsent draft');
});
test('B: accepted failure-final before run-start retains partial and missing terminal recovers once', async (t) => {
  const h = harness(t, { sendChat: async (_payload, identity) => acceptedFinal(identity, { ok: false, code: 'SYNTHETIC_FAILURE', error: 'Synthetic failure', partialOutput: 'retained early partial' }) });
  await h.context.sendMessage();
  const entry = h.context.pendingChatRequests.get(h.calls[0].identity.clientRequestId);
  assert.ok(entry); assert.ok(entry.invokeResult); assert.equal(entry.accepted, false);
  assert.equal(h.session().messages.length, 0); assert.equal(h.input.value, 'Make a plan');
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  assert.equal(h.projections.length, 0);
  await waitUntil(() => h.projections.length === 1, 'accepted early failed final never recovered');
  assert.equal(h.projections[0].message.content, 'retained early partial'); assert.equal(h.projections[0].message.error, true);
  assert.equal(h.projections[0].message.modelSource.modelProfileId, 'model_fixture');
  assert.equal(h.projections[0].options.errorMessage, 'Synthetic failure'); assert.equal(h.projections[0].run.invokeDone, true);
  assert.equal(h.projections[0].run.onEventsSettled, null); assert.equal(h.context.pendingChatRequests.size, 0);
  assert.equal(h.context.sending, false); assert.equal(h.session().messages.length, 2); assert.equal(h.input.value, '');
  assert.equal(h.warnings.length, 1);
});
for (const terminal of ['error', 'aborted']) test(`C: late ${terminal} final cannot replay history or clear a newer request/draft`, async (t) => {
  const oldFinal = deferred(), newFinal = deferred(); let request = 0;
  const h = harness(t, { sendChat: () => (++request === 1 ? oldFinal.promise : newFinal.promise) });
  const oldSend = h.context.sendMessage(); await waitUntil(() => h.calls.length === 1, 'old send did not reach IPC');
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  h.context.emit(h.event(0, terminal, { error: 'Old failure', message: 'Old failure', partialOutput: 'old partial' }));
  assert.equal(h.projections.length, 0); await waitUntil(() => h.projections.length === 1, 'old terminal did not drain');
  assert.equal(h.projections[0].message.content, 'old partial'); assert.equal(h.projections[0].message.error, terminal === 'error');
  h.input.value = 'new request'; h.context.persistActiveDraft(); const nextSend = h.context.sendMessage();
  await waitUntil(() => h.calls.length === 2, 'new send did not reach IPC');
  h.context.emit(h.event(1, 'run-start', { modelSource: { ...modelSource, ...h.calls[1].identity } }));
  h.input.value = 'newer unsent edit'; h.context.persistActiveDraft();
  const nextRun = h.context.chatRun, nextEntry = h.context.pendingChatRequests.get(h.calls[1].identity.clientRequestId), draftRevision = h.state.draftsBySession.session.revision;
  oldFinal.resolve(acceptedFinal(h.calls[0].identity, { ok: false, error: 'Late old failure', aborted: terminal === 'aborted', partialOutput: 'late old partial' })); await oldSend;
  for (const type of ['run-start', terminal, 'text-delta']) h.context.emit(h.event(0, type, { text: 'late old text', partialOutput: 'late old partial' }));
  await delay(10); assert.equal(h.context.chatRun, nextRun); assert.equal(h.context.pendingChatRequests.get(h.calls[1].identity.clientRequestId), nextEntry);
  assert.equal(h.context.sending, true); assert.equal(h.projections.length, 1); assert.equal(h.session().messages.length, 3);
  assert.equal(h.input.value, 'newer unsent edit'); assert.equal(h.state.draftsBySession.session.text, 'newer unsent edit'); assert.equal(h.state.draftsBySession.session.revision, draftRevision);
  newFinal.resolve(acceptedFinal(h.calls[1].identity, { content: 'new answer' })); await nextSend;
  h.context.emit(h.event(1, 'done', { content: 'new answer' })); await waitUntil(() => h.projections.length === 2, 'new request did not finish');
  assert.equal(h.session().messages.length, 4); assert.equal(h.input.value, 'newer unsent edit');
});
for (const variant of ['flat failure', 'nested failure', 'flat cancellation']) test(`D: started run recovers from ${variant} final without losing partial/source/draft`, async (t) => {
  const final = deferred(), h = harness(t, { sendChat: () => final.promise });
  const pending = h.context.sendMessage(); await waitUntil(() => h.calls.length === 1, 'send did not reach IPC');
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  h.input.value = 'next draft survives'; h.context.persistActiveDraft(); const run = h.context.chatRun;
  const failed = acceptedFinal(h.calls[0].identity, { ok: false, error: 'Synthetic final failure', aborted: variant === 'flat cancellation', partialOutput: 'retained final-only partial' });
  final.resolve(variant === 'nested failure' ? { ...acceptedFinal(h.calls[0].identity), result: failed } : failed); await pending;
  await waitUntil(() => h.projections.length === 1, 'accepted final never settled');
  assert.equal(h.projections[0].message.content, 'retained final-only partial'); assert.equal(h.projections[0].message.error, variant !== 'flat cancellation');
  assert.equal(h.projections[0].message.modelSource.model, 'offline-model'); assert.equal(run.invokeDone, true); assert.equal(run.onEventsSettled, null);
  assert.equal(h.context.pendingChatRequests.size, 0); assert.equal(h.context.chatRun, null); assert.equal(h.context.sending, false);
  assert.equal(h.input.value, 'next draft survives'); assert.equal(h.state.draftsBySession.session.text, 'next draft survives');
  assert.equal(h.session().messages.length, 2); assert.equal(h.warnings.length, 1);
  h.context.emit(h.event(0, variant === 'flat cancellation' ? 'aborted' : 'error', { partialOutput: 'late duplicate' }));
  await delay(10); assert.equal(h.projections.length, 1);
});
for (const variant of ['started failure', 'no-event failure', 'started cancellation']) test(`F: manual compact ${variant} final settles without consuming composer/history`, async (t) => {
  const final = deferred(), h = harness(t, { compactSession: () => final.promise });
  const pending = h.context.requestCompact(h.session(), true); await waitUntil(() => h.calls.length === 1, 'compact did not reach IPC');
  const entry = h.context.pendingCompactRequests.get(h.calls[0].identity.clientRequestId); assert.ok(entry);
  if (variant !== 'no-event failure') h.context.emit(h.event(0, 'compact-start', { task: { kind: 'session_compact' } }));
  h.input.value = 'edited during compact'; h.context.persistActiveDraft(); const draftRevision = h.state.draftsBySession.session.revision;
  const cancelled = variant === 'started cancellation';
  final.resolve(acceptedFinal(h.calls[0].identity, { ok: false, aborted: cancelled, error: cancelled ? 'Synthetic compact cancelled' : 'Synthetic compact failed', task: { kind: 'session_compact', ...h.calls[0].identity } }));
  const result = await within(pending, 'accepted compact final hangs without terminal');
  assert.equal(result.response.ok, false); assert.match(result.response.error, cancelled ? /cancelled/ : /failed/);
  assert.equal(entry.ledger.accepted, true); assert.equal(entry.ledger.terminal, true); assert.equal(entry.ledger.runId, h.calls[0].identity.runId);
  assert.equal(h.context.pendingCompactRequests.size, 0); assert.equal(h.context.activeForegroundTask, null); assert.equal(h.context.sending, false);
  assert.equal(h.context.chatRun, null); assert.equal(h.projections.length, 0); assert.equal(h.session().messages.length, 0);
  assert.equal(h.input.value, 'edited during compact'); assert.equal(h.state.draftsBySession.session.text, 'edited during compact'); assert.equal(h.state.draftsBySession.session.revision, draftRevision);
  h.context.emit(h.event(0, cancelled ? 'compact-cancelled' : 'compact-error', { task: { kind: 'session_compact' }, error: 'late duplicate' }));
  await delay(10); assert.equal(h.context.sending, false); assert.equal(h.context.pendingCompactRequests.size, 0); assert.equal(h.session().messages.length, 0);
});

test('late completed-run usage stays attributed and deduplicated while another session is accepted', async (t) => {
  const nextFinal = deferred(); let sends = 0;
  const h = harness(t, { sendChat: async (_payload, identity) => (++sends === 1 ? acceptedFinal(identity, { content: 'First answer' }) : nextFinal.promise) });
  h.context.currencySymbol = '$';
  vm.runInContext(section('function applyUsageToSession(', 'function renderUsageBar('), h.context);
  await h.context.sendMessage();
  h.context.emit(h.event(0, 'run-start', { modelSource: { ...modelSource, ...h.calls[0].identity } }));
  h.context.emit(h.event(0, 'done', { content: 'First answer' }));
  await waitUntil(() => h.projections.length === 1, 'first run did not finalize');
  h.context.activeSessionId = 'other'; h.input.value = 'Second request';
  const nextSend = h.context.sendMessage(); await waitUntil(() => h.calls.length === 2, 'second request did not reach IPC');
  h.context.emit(h.event(1, 'run-start', { modelSource: { ...modelSource, ...h.calls[1].identity } }));
  try {
    const nextRun = h.context.chatRun;
    const late = h.event(0, 'usage', { attemptId: 'late-physical-attempt', inputTokens: 17, outputTokens: 5, source: 'actual', kind: 'chat' });
    h.context.emit(late); h.context.emit(late);
    h.context.emit({ ...late, attemptId: 'foreign-attempt', runId: 'wrong-run' });
    assert.equal(h.session().usage?.in, 17);
    assert.equal(h.session().usage?.out, 5);
    assert.equal(h.context.sessions.find((session) => session.id === 'other').usage, undefined);
    assert.equal(h.context.chatRun, nextRun); assert.equal(h.context.sending, true);
    assert.equal(h.projections.length, 1);
  } finally {
    nextFinal.resolve(acceptedFinal(h.calls[1].identity, { content: 'Second answer' }));
    await nextSend; h.context.emit(h.event(1, 'done', { content: 'Second answer' }));
  }
});

test('CONFIG_CONFLICT preaccept refreshes models once without resending or consuming draft/outbox', async (t) => {
  const h = harness(t, { sendChat: async () => ({ ok: false, code: 'CONFIG_CONFLICT', error: 'Synthetic configuration conflict' }) });
  let refreshes = 0; h.context.modelManager.load = async () => { refreshes += 1; return { ok: true }; };
  await h.context.sendMessage();
  assert.equal(refreshes, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.input.value, 'Make a plan'); assert.equal(h.state.draftsBySession.session.text, 'Make a plan');
  assert.equal(h.session().messages.length, 0); assert.equal(h.context.pendingChatRequests.size, 0);
  assert.equal(h.context.chatOutboxStore.list('session').length, 1);
  assert.equal(h.context.chatOutboxStore.list('session')[0].status, 'refused');
  assert.equal(h.context.sending, false);
});
