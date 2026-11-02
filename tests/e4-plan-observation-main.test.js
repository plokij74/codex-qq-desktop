'use strict';
// Dedicated temporary main fixtures and injected wire replies only. No real endpoints or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { loadMainFixture, syntheticRegistry, jsonResponse } = require('./helpers/e4-main-fixture');
const { validateModelRegistry } = require('../src/ai/model-profiles');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
async function planPayload(f) {
  const project = { id: 'observation-plan-project', name: 'Observation fixture', path: f.root };
  const bound = await f.invoke('worktree:bind', { projectId: project.id, projectPath: project.path });
  assert.equal(bound.ok, true);
  return f.payload({ project, projectBindingId: bound.projectBindingId, assistantId: 'assistant_codex', agentMode: 'plan',
    expectedRegistryRevision: f.settings().modelRegistry.revision });
}
test('E4 ordinary text-compat Plan submission records text evidence without drifting proposed or approved authority', async t => {
  const registry = syntheticRegistry(); registry.models[0].compatibility.toolMode = 'text-compat';
  const body = '```tool submit_plan\n' + JSON.stringify({ title: 'Fixture plan', markdown: '# Pure fixture plan\nInspect the empty fixture project only.', steps: ['Inspect the fixture'] }) + '\n```';
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry), settings: { agentEnabled: true, terminalEnabled: false, verifyBeforeDone: false, memoryEnabled: false },
    fetchFn: (_url, _request, count) => jsonResponse(count === 1 ? body : 'The fixture plan is prepared or completed. No external operations performed.') });
  const payload = await planPayload(f); const before = f.settings().modelRegistry;
  const result = await f.invoke('chat:send', payload); assert.equal(result.ok, true, result.code);
  const ready = f.events.filter(event => event.channel === 'chat:event' && event.event.type === AGENT_EVENTS.PLAN_READY);
  assert.equal(ready.length, 1, 'The first ordinary text observation must not invalidate submit_plan before proposal.');
  const planId = ready[0].event.planId; const proposed = f.inspect(`planState.plans.get(${JSON.stringify(planId)})`);
  assert.equal(proposed.status, 'proposed'); assert.equal(proposed.modelRevision, String(before.models[0].revision));
  const after = f.settings().modelRegistry; assert.ok(after.revision > before.revision);
  assert.equal(after.models[0].revision, before.models[0].revision); assert.equal(after.providers[0].revision, before.providers[0].revision);
  assert.equal(after.models[0].capabilities.text.state, 'supported'); assert.equal(after.models[0].capabilities.text.source, 'observed');
  assert.equal(f.requests.length, 2); assert.equal(f.inspect('foregroundModels.current'), null);
  const approved = await f.invoke('chat:approvePlan', { ...payload, expectedRegistryRevision: f.settings().modelRegistry.revision, clientRequestId: 'observation-plan-approval', planId });
  assert.equal(approved.ok, true, approved.code); assert.equal(f.inspect(`planState.plans.get(${JSON.stringify(planId)}).status`), 'approved');
  const count = f.requests.length;
  const replay = await f.invoke('chat:approvePlan', { ...payload, expectedRegistryRevision: f.settings().modelRegistry.revision, clientRequestId: 'observation-plan-replay', planId });
  assert.equal(replay.ok, false); assert.equal(replay.code, 'PLAN_NOT_PROPOSED'); assert.equal(f.requests.length, count);
  const ledger = readRecords(usageFilePath(f.root)).records; assert.equal(ledger.length, count);
  assert.equal(new Set(ledger.map(record => record.attemptId)).size, count);
});
test('E4 first ordinary model evidence during approved execution preserves its spent Plan claim and single usage attempt', async t => {
  const registry = syntheticRegistry(); registry.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared' };
  let runs = 0; let acceptedBinding;
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry), settings: { agentEnabled: true, terminalEnabled: false, verifyBeforeDone: false, memoryEnabled: false },
    agentFn: async args => {
      if (++runs === 1) {
        args.onEvent({ type: AGENT_EVENTS.PLAN_READY, planId: 'observation-executing-plan', markdown: '# Fixture execution plan\nDo not access any external data.' });
        return { content: 'Prepared without making a model request.', fileChanges: [] };
      }
      acceptedBinding = args.modelBinding;
      const message = await args.chatFn({ modelBinding: args.modelBinding, messages: [{ role: 'user', content: 'Complete the accepted fixture execution.' }] });
      return { content: message.content, fileChanges: [] };
    }, fetchFn: () => jsonResponse('Synthetic execution complete. No file edits or commands.') });
  const payload = await planPayload(f); const before = f.settings().modelRegistry;
  const proposed = await f.invoke('chat:send', payload); assert.equal(proposed.ok, true, proposed.code);
  assert.equal(f.requests.length, 0); assert.equal(f.inspect('planState.plans.get("observation-executing-plan").status'), 'proposed');
  const approved = await f.invoke('chat:approvePlan', { ...payload, expectedRegistryRevision: f.settings().modelRegistry.revision, clientRequestId: 'first-evidence-execution', planId: 'observation-executing-plan' });
  assert.equal(approved.ok, true, approved.code);
  assert.equal(f.inspect('planState.plans.get("observation-executing-plan").status'), 'approved');
  assert.equal(f.events.filter(event => event.channel === 'chat:event' && event.event.type === 'plan-approved').length, 1);
  const after = f.settings().modelRegistry; assert.ok(after.revision > before.revision);
  assert.equal(after.models[0].revision, before.models[0].revision); assert.equal(acceptedBinding.modelRevision, before.models[0].revision);
  assert.equal(after.models[0].capabilities.text.source, 'observed'); assert.equal(f.requests.length, 1);
  const ledger = readRecords(usageFilePath(f.root)).records; assert.equal(ledger.length, 1); assert.equal(ledger[0].runId, approved.runId);
  const replay = await f.invoke('chat:approvePlan', { ...payload, expectedRegistryRevision: f.settings().modelRegistry.revision, clientRequestId: 'cannot-revive-executed', planId: 'observation-executing-plan' });
  assert.equal(replay.ok, false); assert.equal(replay.code, 'PLAN_NOT_PROPOSED'); assert.equal(runs, 2); assert.equal(f.requests.length, 1); assert.equal(f.inspect('foregroundModels.current'), null);
});
