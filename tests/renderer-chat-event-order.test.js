'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const helper = section('function waitForChatRunEvents(', 'function createAssistantRunPlaceholder(');
const send = section('async function sendMessage()', 'function bindEvents()');
const approve = section('async function approvePlanFromCard(', 'function setPersistedPlanStatus(');
const handler = section('function handleChatEvent(', 'function scrollToBottom(');
function harness() {
  const session = { id: 'session', peer: 'codex', messages: [], agentMode: 'plan' };
  const input = { value: 'Make a plan', focus() {} };
  const finalized = [];
  const warnings = [];
  const context = vm.createContext({
    setTimeout, clearTimeout, console: { warn: (...args) => warnings.push(args), error: (_label, error) => { throw error; } },
    document: { getElementById: () => input },
    session, sessions: [session], activeSessionId: session.id,
    activeSession: () => session, sessionProject: () => null,
    sending: false, chatRun: null, pendingAttaches: [], localSendToken: null,
    buildOutgoingText: (s) => s, handleSlashCommand: () => false,
    sessionAgentMode: () => 'plan', maybeAutoCompact: async () => {},
    renderAttachPreview() {}, hideAtComplete() {}, saveState() {}, renderMessages() {}, renderLeftDynamic() {},
    setSending: (value) => { context.sending = value; },
    createAssistantRunPlaceholder: () => (context.chatRun = {
      sessionId: session.id, runId: null, el: { dataset: {} },
      trajectory: [], fileChanges: [], textBuffer: '', finalized: false, invokeDone: false, doneEvent: false,
    }),
    finalizeChatRun: (opts) => {
      finalized.push({ ...opts, aborted: opts.aborted || context.chatRun.aborted, plan: context.chatRun.planPart, trajectory: [...context.chatRun.trajectory] });
      context.chatRun.finalized = true;
      context.chatRun = null;
    },
    handleTerminalPanelEvent: () => false,
    setRunStatus() {}, toolArgsSummary: () => '', appendTimelineRow() {}, disableApprovalCards() {}, updateAgentModeToggle() {}, toast() {},
    renderPlanCard: (event) => { context.chatRun.planPart = { type: 'plan', planId: event.planId, status: 'proposed' }; },
    setPersistedPlanStatus: (_sessionId, _planId, status) => { session.planStatus = status; },
    worktreeBindings: new Map(),
    window: { E2Messages: require('../src/renderer/e2-messages'), codex: {
      messageSchema: { projectToStorageJson: (m) => m },
      sendChat: async () => ({ content: 'Plan submitted.' }),
      approvePlan: async () => ({ ok: true, result: { content: 'Executed.' } }),
    } },
  });
  vm.runInContext(helper + send + approve + handler, context);
  // Use the production event subscription body, including its completion signal.
  const subscribe = section('    window.codex.onChatEvent((ev) => {', '\n  }\n  window.codex?.onMcpTaskEvent');
  context.window.codex.onChatEvent = (cb) => { context.emit = cb; };
  vm.runInContext(subscribe, context);
  return { context, session, finalized, warnings };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('invoke reply overtaking plan-ready preserves the Plan until done is handled', async () => {
  const { context, finalized } = harness();
  const pending = context.sendMessage();
  await turn();
  assert.equal(finalized.length, 0, 'invoke reply alone must not finalize');
  assert.equal(context.sending, true);
  context.emit({ type: 'run-start', runId: 'run' });
  context.emit({ type: 'tool-start', runId: 'run', tool: 'submit_plan', callId: 'call' });
  context.emit({ type: 'plan-ready', runId: 'run', planId: 'plan' });
  context.emit({ type: 'tool-end', runId: 'run', tool: 'submit_plan', callId: 'call', ok: true });
  context.emit({ type: 'done', runId: 'run', content: 'Plan submitted.' });
  assert.equal(finalized.length, 0, 'do not finalize within a nested IPC/event handler');
  await pending;
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].plan.planId, 'plan');
  assert.equal(finalized[0].trajectory[0].tool, 'submit_plan');
  assert.equal(finalized[0].trajectory[0].status, 'success');
  assert.equal(context.sending, false);
});

for (const terminal of ['done', 'error', 'aborted']) {
  test(`approval waits for ${terminal} after an early invoke reply`, async () => {
    const { context, finalized } = harness();
    const pending = context.approvePlanFromCard(null, { planId: 'plan', sessionId: 'session' });
    await turn();
    assert.equal(finalized.length, 0);
    context.emit({ type: 'run-start', runId: 'execution' });
    context.emit({ type: terminal, runId: 'execution', content: 'Executed.', message: 'Execution failed.' });
    await pending;
    assert.equal(finalized.length, 1);
    assert.equal(context.sending, false);
    if (terminal === 'aborted') assert.equal(finalized[0].aborted, true);
  });
}

test('already delivered terminal events also leave the current stack before finalization', async () => {
  const { context } = harness();
  let resolved = false;
  const pending = context.waitForChatRunEvents({ doneEvent: true }).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  await pending;
  assert.equal(resolved, true);
});

test('missing terminal event has a bounded recovery without leaving a waiter', async () => {
  const { context, warnings } = harness();
  const run = { runId: 'lost-event', doneEvent: false };
  await context.waitForChatRunEvents(run, 5);
  assert.equal(run.onEventsSettled, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /terminal event missing/);
});
