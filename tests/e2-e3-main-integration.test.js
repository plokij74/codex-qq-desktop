'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { saveSettings } = require('../src/ai/settings');

test('E2/E3 actual main IPC: Plan bindings, retry, replay, task events, native host confirmation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e23-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const otherRoot = path.join(dir, 'other'); fs.mkdirSync(otherRoot);
  const handlers = new Map(); const listeners = new Map(); const events = [];
  let sequence = 0; let failRun = false; let failPreflight = false; let agentRuns = 0; let hold = null; let release;
  let nativeConfirm = false; let confirmations = 0;
  const sender = { id: 88, isDestroyed: () => false, send: (channel, data) => events.push(data) };
  const event = { sender };
  const electron = {
    app: { getPath: () => dir, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {}, quit() {} },
    BrowserWindow: Object.assign(function () {}, { getAllWindows: () => [], fromWebContents: () => null }),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    dialog: { showMessageBox: async () => { confirmations++; return { response: nativeConfirm ? 1 : 0 }; } }, shell: {},
  };
  const original = Module._load;
  Module._load = function (name, parent, main) {
    if (name === 'electron') return electron;
    if (name === './ai/settings') {
      const settings = original.call(this, name, parent, main);
      return { ...settings, loadSettings: (...args) => {
        if (failPreflight) { failPreflight = false; throw new Error('retryable-start-failure'); }
        return settings.loadSettings(...args);
      } };
    }
    if (name === './ai/agent') return { runAgentLoop: async ({ agentMode, onEvent }) => {
      if (agentMode === 'plan') onEvent({ type: 'plan-ready', planId: `plan_${++sequence}`, title: 'test', markdown: 'implement', steps: ['one'] });
      else {
        agentRuns++;
        if (hold) await hold;
        if (failRun) {
          onEvent({ type: 'tool-start', callId: 'partial-write', tool: 'write_file', args: { path: 'effect.txt' } });
          fs.appendFileSync(path.join(root, 'effect.txt'), 'effect\n');
          // A crash can occur before tool-end; absence of an event is not proof of no effect.
          throw new Error('injected-partial-execution-failure');
        }
      }
      return { content: 'done', applied: [] };
    }};
    return original.call(this, name, parent, main);
  };
  try { delete require.cache[require.resolve('../src/main')]; require('../src/main'); } finally { Module._load = original; }
  saveSettings(dir, { mode: 'api', apiKey: 'test-e23-key', agentEnabled: true, terminalEnabled: true, permissionMode: 'full-auto', memoryEnabled: false });
  const bind = await handlers.get('worktree:bind')(event, { projectId: 'project-a', projectPath: root });
  assert.equal(bind.ok, true);
  const payload = { sessionId: 's1', project: { id: 'project-a', path: root }, projectBindingId: bind.projectBindingId, messages: [{ role: 'user', content: 'implement feature' }] };
  await handlers.get('chat:send')(event, { ...payload, agentMode: 'plan' });
  let pending = await handlers.get('chat:getPendingPlan')(event, payload);
  assert.equal(pending.plan.planId, 'plan_1');
  const approve = { ...payload, planId: pending.plan.planId };
  const stranger = { sender: { ...sender, id: 89 } };
  assert.equal((await handlers.get('chat:approvePlan')(stranger, approve)).ok, false);
  assert.equal((await handlers.get('chat:approvePlan')(event, { ...approve, project: { path: otherRoot } })).ok, false);
  failPreflight = true;
  const failed = await handlers.get('chat:approvePlan')(event, approve);
  assert.equal(failed.ok, false); assert.equal(failed.isRetryable, true); assert.match(failed.error, /retryable/);
  pending = await handlers.get('chat:getPendingPlan')(event, payload);
  assert.equal(pending.plan.status, 'proposed');
  failRun = false; hold = new Promise((resolve) => { release = resolve; });
  const first = handlers.get('chat:approvePlan')(event, approve);
  assert.equal((await handlers.get('chat:approvePlan')(event, approve)).ok, false);
  release(); assert.equal((await first).ok, true); hold = null;
  assert.equal((await handlers.get('chat:approvePlan')(event, approve)).ok, false);
  assert.equal((await handlers.get('chat:getPendingPlan')(event, payload)).plan, null);
  assert.ok(events.some((item) => item.type === 'plan-approval-failed' && item.isRetryable === true));
  await handlers.get('chat:send')(event, { ...payload, agentMode: 'plan' });
  const partialApprove = { ...payload, planId: (await handlers.get('chat:getPendingPlan')(event, payload)).plan.planId };
  failRun = true;
  const beforePartial = agentRuns;
  const partial = await handlers.get('chat:approvePlan')(event, partialApprove);
  assert.equal(partial.ok, false); assert.equal(partial.isRetryable, false);
  assert.match(partial.error, /检查现场/);
  assert.equal((await handlers.get('chat:getPendingPlan')(event, payload)).plan, null);
  assert.ok(events.some((item) => item.type === 'plan-approval-failed' && item.planId === partialApprove.planId && item.status === 'expired' && item.isRetryable === false));
  failRun = false;
  assert.equal((await handlers.get('chat:approvePlan')(event, partialApprove)).ok, false);
  assert.equal(agentRuns, beforePartial + 1);
  assert.equal(fs.readFileSync(path.join(root, 'effect.txt'), 'utf8'), 'effect\n');
  assert.ok(events.some((item) => item.type === 'task-status' && item.task.data.state === 'failed'));
  assert.ok(events.some((item) => item.type === 'task-status' && item.task.data.state === 'completed'));
  await handlers.get('chat:send')(event, { ...payload, agentMode: 'plan' });
  await handlers.get('worktree:unbind')(event, payload);
  assert.equal((await handlers.get('chat:getPendingPlan')(event, payload)).ok, false);
  // Renderer cannot create an elevation grant, even when it claims confirmation.
  assert.equal((await handlers.get('isolation:requestElevation')(event, { targetPolicy: 'host-unconfined', confirmed: true })).ok, false);
  const command = 'echo ipc-safe';
  const rejected = await handlers.get('terminal:run')(event, { sessionId: 'terminal', projectPath: root, command });
  assert.equal(rejected.ok, false); assert.equal(confirmations, 1);
  nativeConfirm = true;
  const ran = await handlers.get('terminal:run')(event, { sessionId: 'terminal', projectPath: root, command });
  assert.equal(ran.ok, true, JSON.stringify(ran)); assert.match(ran.stdout, /ipc-safe/); assert.equal(confirmations, 2);
  const nativeAvailable = require('../src/ai/windows-isolation').getWindowsIsolationStatus().available;
  assert.equal(ran.isolated, nativeAvailable, JSON.stringify(ran));
  assert.equal(ran.executionMode, nativeAvailable ? 'strict-isolated' : 'host-unconfined');
  if (nativeAvailable) { assert.equal(ran.backend, 'windows-appcontainer-job'); assert.equal(ran.cleanupComplete, true); assert.equal(ran.profileDeleted, true); }
  await handlers.get('settings:save')(event, { executionPolicy: 'host-unconfined' });
  const hostStatus = await handlers.get('isolation:getStatus')(event);
  assert.equal(hostStatus.executionPolicy, 'host-unconfined');
  assert.equal(hostStatus.capabilities.activeMode, 'host-unconfined');
  assert.equal(hostStatus.capabilities.requiresHostConfirmation, true);
  assert.match(hostStatus.modeSource, /per command/);
  const projected = { returnValue: null };
  listeners.get('message:project')(projected, { kind: 'storage', message: { role: 'assistant', content: 'test-e23-key' } });
  assert.ok(!JSON.stringify(projected.returnValue).includes('test-e23-key'));
  const publicEvents = JSON.stringify(events); assert.ok(!publicEvents.includes('test-e23-key'));
});
