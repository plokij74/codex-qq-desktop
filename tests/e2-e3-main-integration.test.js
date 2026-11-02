'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SecretManager } = require('../src/ai/secret-manager');
const { validateModelRegistry } = require('../src/ai/model-profiles');
const { loadMainFixture, syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');

// E4 keeps the E2/E3 ownership/Plan/OS guarantees, but acceptance is now a
// separate response from terminal completion. All model transport is synthetic.
test('E2/E3 actual main IPC: Plan bindings, retry, replay, task events, native host confirmation', async (t) => {
  const registry = syntheticRegistry();
  registry.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared', checkedAt: null, bindingRevision: null };
  let sequence = 0; let failRun = false; let agentRuns = 0; let hold = null;
  let projectRoot;
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry),
    settings: { agentEnabled: true, terminalEnabled: true, permissionMode: 'full-auto', memoryEnabled: false },
    beforeClose: () => hold?.resolve(),
    agentFn: async ({ agentMode, onEvent }) => {
      if (agentMode === 'plan') onEvent({ type: 'plan-ready', planId: `plan_${++sequence}`, title: 'test', markdown: 'implement', steps: ['one'] });
      else {
        agentRuns++;
        if (hold) await hold.promise;
        if (failRun) {
          onEvent({ type: 'tool-start', callId: 'partial-write', tool: 'write_file', args: { path: 'effect.txt' } });
          fs.appendFileSync(path.join(projectRoot, 'effect.txt'), 'effect\n');
          // A crash before tool-end does not prove the absence of effects.
          throw new Error('injected-partial-execution-failure');
        }
      }
      return { content: 'done', applied: [] };
    } });
  new SecretManager({ useSafeStorage: false }).registerSecret('test-e23-key');
  projectRoot = path.join(f.root, 'project'); fs.mkdirSync(projectRoot);
  const otherRoot = path.join(f.root, 'other'); fs.mkdirSync(otherRoot);
  const binding = await f.invoke('worktree:bind', { projectId: 'project-a', projectPath: projectRoot });
  assert.equal(binding.ok, true);
  const payload = request => f.payload({ assistantId: 'assistant_codex', clientRequestId: request,
    sessionId: 's1', project: { id: 'project-a', path: projectRoot }, projectBindingId: binding.projectBindingId,
    messages: [{ role: 'user', content: 'implement feature' }] });
  const propose = async request => {
    const accepted = await f.invoke('chat:send', { ...payload(request), agentMode: 'plan' });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    await f.settle(accepted);
    const pending = await f.invoke('chat:getPendingPlan', payload(request));
    assert.equal(pending.ok, true); assert.ok(pending.plan);
    return pending.plan;
  };
  const firstPlan = await propose('propose-first');
  assert.equal(firstPlan.planId, 'plan_1');
  const approve = { ...payload('approve-first'), planId: firstPlan.planId };
  assert.equal((await f.invoke('chat:approvePlan', approve, f.otherSender)).ok, false);
  assert.equal((await f.invoke('chat:approvePlan', { ...approve, project: { id: 'project-a', path: otherRoot } })).ok, false);

  // Failure before acquisition rolls back a claim and preserves retry authority.
  const rejected = await f.invoke('chat:approvePlan', { ...approve, clientRequestId: 'too-large',
    messages: Array.from({ length: 80 }, () => ({ role: 'user', content: 'z'.repeat(160 * 1024) })) });
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  assert.equal(rejected.isRetryable, true);
  assert.equal((await f.invoke('chat:getPendingPlan', payload('pending'))).plan.status, 'proposed');
  assert.equal(agentRuns, 0); assert.equal(f.requests.length, 0);

  hold = deferred();
  const accepted = await f.accept('chat:approvePlan', approve);
  assert.equal(accepted.accepted, true);
  assert.equal((await f.invoke('chat:approvePlan', approve)).code, 'BUSY');
  assert.equal(f.inspect(`planState.plans.get('${firstPlan.planId}').status`), 'executing');
  assert.ok(!f.events.some(({ event }) => event.type === 'plan-approved' && event.planId === firstPlan.planId));
  hold.resolve(); await f.settle(accepted); hold = null;
  assert.equal((await f.invoke('chat:approvePlan', approve)).ok, false);
  assert.equal((await f.invoke('chat:getPendingPlan', payload('pending-complete'))).plan, null);
  assert.ok(f.events.some(({ event }) => event.type === 'plan-approval-failed' && event.isRetryable));
  const completed = f.events.find(({ event }) => event.type === 'plan-approved' && event.planId === firstPlan.planId).event;
  assert.equal(completed.runId, accepted.runId); assert.equal(completed.task.state, 'completed');

  const partialPlan = await propose('propose-partial');
  const partialApprove = { ...payload('approve-partial'), planId: partialPlan.planId };
  failRun = true;
  const beforePartial = agentRuns;
  const partialAccepted = await f.invoke('chat:approvePlan', partialApprove);
  assert.equal(partialAccepted.accepted, true);
  const partial = await f.settle(partialAccepted);
  assert.equal(partial.ok, false);
  assert.equal((await f.invoke('chat:getPendingPlan', payload('pending-partial'))).plan, null);
  const failure = f.events.find(({ event }) => event.type === 'plan-approval-failed' && event.planId === partialPlan.planId).event;
  assert.equal(failure.isRetryable, false); assert.equal(failure.status, 'expired'); assert.match(failure.error, /检查现场/);
  failRun = false;
  assert.equal((await f.invoke('chat:approvePlan', partialApprove)).ok, false);
  assert.equal(agentRuns, beforePartial + 1);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'effect.txt'), 'utf8'), 'effect\n');
  assert.ok(f.events.some(({ event }) => event.type === 'task-status' && event.task.state === 'failed'));
  assert.ok(f.events.some(({ event }) => event.type === 'task-status' && event.task.state === 'completed'));
  await propose('propose-before-unbind');
  await f.invoke('worktree:unbind', payload('unbind'));
  assert.equal((await f.invoke('chat:getPendingPlan', payload('after-unbind'))).ok, false);

  // Renderer booleans cannot forge an elevation grant; native confirmation is
  // still required per command even under full-auto. Only a temporary project is used.
  assert.equal((await f.invoke('isolation:requestElevation', { targetPolicy: 'host-unconfined', confirmed: true })).ok, false);
  let nativeConfirm = false; let confirmations = 0;
  f.electron.dialog.showMessageBox = async () => { confirmations++; return { response: nativeConfirm ? 1 : 0 }; };
  const command = 'echo ipc-safe';
  const terminalPayload = { sessionId: 'terminal', projectPath: projectRoot, command };
  const denied = await f.invoke('terminal:run', terminalPayload);
  assert.equal(denied.ok, false); assert.equal(confirmations, 1);
  nativeConfirm = true;
  const ran = await f.invoke('terminal:run', terminalPayload);
  assert.equal(ran.ok, true, JSON.stringify(ran)); assert.match(ran.stdout, /ipc-safe/); assert.equal(confirmations, 2);
  const nativeAvailable = require('../src/ai/windows-isolation').getWindowsIsolationStatus().available;
  assert.equal(ran.isolated, nativeAvailable, JSON.stringify(ran));
  assert.equal(ran.executionMode, nativeAvailable ? 'strict-isolated' : 'host-unconfined');
  if (nativeAvailable) { assert.equal(ran.backend, 'windows-appcontainer-job'); assert.equal(ran.cleanupComplete, true); assert.equal(ran.profileDeleted, true); }
  await f.invoke('settings:save', { executionPolicy: 'host-unconfined' });
  const hostStatus = await f.invoke('isolation:getStatus');
  assert.equal(hostStatus.executionPolicy, 'host-unconfined');
  assert.equal(hostStatus.capabilities.activeMode, 'host-unconfined');
  assert.equal(hostStatus.capabilities.requiresHostConfirmation, true); assert.match(hostStatus.modeSource, /per command/);
  const projected = { returnValue: null };
  f.syncHandlers.get('message:project')(projected, { kind: 'storage', message: { role: 'assistant', content: 'test-e23-key' } });
  assert.ok(!JSON.stringify(projected.returnValue).includes('test-e23-key'));
  assert.ok(!JSON.stringify(f.events).includes('test-e23-key'));
});
