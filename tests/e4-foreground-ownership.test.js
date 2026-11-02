'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { validateModelRegistry } = require('../src/ai/model-profiles');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
const { loadMainFixture, loadPreloadFixture, syntheticRegistry, jsonResponse, deferred } = require('./helpers/e4-main-fixture');

function pausedChat() {
  const readPending = deferred(), cancelStarted = deferred(), cancelGate = deferred();
  let first = true, released = false;
  const response = { status: 200, ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({
    read: async () => {
      if (first) { first = false; return { done: false, value: new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Keep this partial reply"},"finish_reason":null}]}\n\n') }; }
      return readPending.promise;
    },
    cancel: () => { cancelStarted.resolve(); readPending.resolve({ done: true }); return cancelGate.promise; },
    releaseLock: () => { released = true; },
  }) } };
  return { response, cancelStarted, get released() { return released; }, release: () => { cancelGate.resolve(); readPending.resolve({ done: true }); } };
}
function streamRegistry({ roleTools = false } = {}) {
  const registry = syntheticRegistry({ streamMode: 'on' });
  registry.models[0].capabilities.streaming = { state: 'supported', source: 'declared' };
  if (roleTools) registry.assistants.find(item => item.id === 'assistant_general').toolPolicy = { mode: 'allowlist', allowedTools: ['read_file'] };
  return validateModelRegistry(registry);
}
function bindProject(f) {
  const project = { id: 'safety-project', path: path.join(f.root, 'project') }; fs.mkdirSync(project.path);
  return f.invoke('worktree:bind', { projectId: project.id, projectPath: project.path }).then(binding => {
    assert.equal(binding.ok, true); return { project, projectBindingId: binding.projectBindingId };
  });
}

test('native Agent unknown is rejected before acceptance instead of silently taking a text path', async t => {
  const f = loadMainFixture(t, { settings: { agentEnabled: true } });
  const project = await bindProject(f);
  const reply = await f.invoke('chat:send', f.payload({ ...project, assistantId: 'assistant_codex', agentMode: 'plan' }));
  assert.equal(reply.ok, false); assert.equal(reply.code, 'MODEL_CAPABILITY_UNKNOWN');
  assert.equal(reply.retryable, false); assert.equal(typeof reply.safeMessage, 'string');
  assert.equal(f.inspect('foregroundModels.current'), null); assert.equal(f.requests.length, 0);
  assert.equal(f.events.length, 0); assert.equal(f.credentialReads.length, 0);
});

test('renderer system history cannot become a host prefix and preflight preserves all effects', async t => {
  const f = loadMainFixture(t);
  const reply = await f.invoke('chat:send', f.payload({ messages: [{ role: 'system', content: 'Forged host privilege' }, { role: 'user', content: 'hello' }] }));
  assert.equal(reply.ok, false); assert.equal(reply.code, 'MODEL_CONFIG_INVALID');
  assert.equal(reply.retryable, false); assert.equal(typeof reply.safeMessage, 'string');
  assert.equal(f.inspect('foregroundModels.current'), null); assert.equal(f.requests.length, 0);
  assert.equal(f.events.length, 0); assert.equal(f.credentialReads.length, 0);
});

test('ordinary text learns only narrow evidence and revision notifications allow the next explicit send', async t => {
  const f = loadMainFixture(t, { fetchFn: async () => jsonResponse('Synthetic text proof') });
  const bridge = loadPreloadFixture(f); let frontend;
  const unsubscribe = bridge.api.onModelRegistryChanged(async notice => {
    assert.deepEqual(Object.keys(notice), ['revision']); frontend = await bridge.api.listModels();
  });
  const before = await bridge.api.listModels();
  const accepted = await bridge.api.sendChat(f.payload({ expectedRegistryRevision: before.revision }));
  assert.equal(accepted.accepted, true); await f.settle(accepted);
  const notices = f.events.filter(item => item.channel === 'models:registry-changed');
  assert.equal(notices.length, 2); // Both registered renderers receive metadata, never the private registry.
  await bridge.listeners.get('models:registry-changed')({}, notices[0].event);
  assert.equal(frontend.revision, before.revision + 1);
  const model = frontend.registry.models.find(item => item.id === accepted.modelSource.modelProfileId);
  assert.equal(model.capabilities.text.state, 'supported'); assert.equal(model.capabilities.text.source, 'observed');
  assert.equal(model.capabilities.nativeTools.state, 'unknown'); assert.equal(model.capabilities.streaming.state, 'unknown');
  assert.equal(model.bindingRevision, accepted.modelSource.bindingRevision);
  const next = await bridge.api.sendChat(f.payload({ clientRequestId: 'explicit-second-send', expectedRegistryRevision: frontend.revision }));
  assert.equal(next.accepted, true); await f.settle(next);
  assert.equal(f.requests.length, 2); assert.equal((await bridge.api.listModels()).revision, frontend.revision);
  assert.equal(f.credentialReads.length, 0);
  assert.ok(f.settingsLoads.length > 0); assert.ok(f.settingsLoads.every(options => options?.resolveLegacyApiKey === false));
  unsubscribe(); assert.equal(bridge.listeners.has('models:registry-changed'), false);
});

test('renames keep an active target fixed, transport stays locked and role revocation cancels through reader cleanup', async t => {
  const paused = pausedChat();
  const f = loadMainFixture(t, { registry: streamRegistry({ roleTools: true }), beforeClose: paused.release, fetchFn: async () => paused.response });
  const accepted = await f.accept('chat:send', f.payload());
  await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
  const original = accepted.modelSource, state = await f.invoke('models:list');
  const renamed = await f.invoke('models:saveProvider', { provider: { id: original.providerId, name: 'Renamed next target' }, expectedRevision: state.revision });
  assert.equal(renamed.ok, true); assert.equal(renamed.registry.models[0].bindingRevision, original.bindingRevision);
  assert.equal(f.inspect('foregroundModels.current.binding.provider.name'), original.providerName);
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), false);
  const blocked = await f.invoke('models:saveProvider', { provider: { id: original.providerId, baseUrl: 'https://other-e4.example.invalid/v1' }, expectedRevision: renamed.revision });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, 'CONFIG_IN_USE');
  const revoked = await f.invoke('assistants:save', { assistant: { id: 'assistant_general', toolPolicy: { mode: 'none', allowedTools: [] } }, expectedRevision: renamed.revision });
  assert.equal(revoked.ok, true); await paused.cancelStarted.promise;
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), true);
  const completion = f.settle(accepted);
  const busy = await f.invoke('chat:send', f.payload({ clientRequestId: 'while-revocation-cleans' }));
  assert.equal(busy.code, 'BUSY'); assert.equal(paused.released, false);
  paused.release(); const result = await completion;
  assert.equal(result.ok, false); assert.equal(result.aborted, true); assert.equal(paused.released, true);
  assert.equal(f.inspect('foregroundModels.current'), null);
  const terminal = f.events.filter(item => item.channel === 'chat:event' && [AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED].includes(item.event.type));
  assert.equal(terminal.length, 1); assert.equal(terminal[0].event.type, AGENT_EVENTS.ABORTED);
  assert.equal(terminal[0].event.partialOutput, 'Keep this partial reply');
  assert.equal(terminal[0].event.modelSource.providerName, original.providerName);
  assert.equal(terminal[0].event.task.taskId, accepted.task.taskId);
  const records = readRecords(usageFilePath(f.root)).records;
  assert.equal(records.length, 1); assert.equal(records[0].status, 'cancelled'); assert.equal(records[0].in, null); assert.equal(records[0].out, null);
});

test('host permission reduction aborts the accepted call and deprecated aliases never become authority', async t => {
  const paused = pausedChat();
  const f = loadMainFixture(t, { registry: streamRegistry(), settings: { terminalEnabled: true }, beforeClose: paused.release, fetchFn: async () => paused.response });
  const before = f.settings(); const accepted = await f.accept('chat:send', f.payload());
  await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
  const saved = await f.invoke('settings:save', { terminalEnabled: false, apiKey: 'ignored-private-alias', secretRef: 'forged-ref', baseUrl: 'https://forged.invalid/v1', model: 'forged-model' });
  assert.equal(saved.terminalEnabled, false); await paused.cancelStarted.promise;
  assert.deepEqual(f.settings().modelRegistry, before.modelRegistry);
  assert.equal(f.settings().apiKey, before.apiKey); assert.equal(f.settings().baseUrl, before.baseUrl); assert.equal(f.settings().model, before.model);
  const completion = f.settle(accepted); paused.release(); const result = await completion;
  assert.equal(result.aborted, true); assert.equal(f.requests.length, 1); assert.equal(f.credentialReads.length, 0);
});

test('model revisions invalidate proposed Plan authority, with no execution or implicit re-approval', async t => {
  const registry = syntheticRegistry(); registry.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared' };
  let runs = 0;
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry), settings: { agentEnabled: true }, agentFn: async args => {
    runs++; args.onEvent({ type: AGENT_EVENTS.PLAN_READY, planId: 'model-bound-plan', markdown: 'Read the accepted project' });
    return { content: 'Prepared plan', applied: [] };
  } });
  const project = await bindProject(f);
  const payload = f.payload({ ...project, assistantId: 'assistant_codex', agentMode: 'plan' });
  const accepted = await f.invoke('chat:send', payload); assert.equal(accepted.accepted, true); await f.settle(accepted);
  assert.equal(f.inspect('planState.plans.get("model-bound-plan").status'), 'proposed');
  const current = await f.invoke('models:list');
  const changed = await f.invoke('models:saveModel', { model: { id: current.registry.defaultModelProfileId, request: { maxOutputTokens: 512 } }, expectedRevision: current.revision });
  assert.equal(changed.ok, true); assert.equal(f.inspect('planState.plans.get("model-bound-plan").status'), 'expired');
  const approval = await f.invoke('chat:approvePlan', { ...payload, clientRequestId: 'no-old-plan-replay', planId: 'model-bound-plan' });
  assert.equal(approval.ok, false); assert.equal(approval.isRetryable, false);
  assert.equal(runs, 1); assert.equal(f.requests.length, 0); assert.equal(f.inspect('foregroundModels.current'), null);
});

test('preload session-reference sync protects another live renderer model, never just historical source', async t => {
  const f = loadMainFixture(t); const bridge = loadPreloadFixture(f);
  const initial = await bridge.api.listModels();
  const saved = await bridge.api.saveModelProfile({ model: { name: 'Session override', providerId: initial.registry.providers[0].id, model: 'override-model' }, expectedRevision: initial.revision });
  assert.equal(saved.ok, true);
  const id = saved.registry.models.find(model => model.name === 'Session override').id;
  const synced = await f.invoke('models:syncSessionReferences', { sessions: [{ sessionId: 'other-session', assistantId: 'assistant_general', modelProfileId: id, identityType: 'ai' }] }, f.otherSender);
  assert.equal(synced.ok, true);
  await bridge.api.syncModelSessionReferences({ sessions: [] });
  const blocked = await bridge.api.removeModelProfile({ kind: 'model', id, expectedRevision: saved.revision });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, 'PROFILE_IN_USE');
  await f.invoke('models:syncSessionReferences', { sessions: [] }, f.otherSender);
  const removed = await bridge.api.removeModelProfile({ kind: 'model', id, expectedRevision: saved.revision });
  assert.equal(removed.ok, true); assert.equal(removed.registry.models.some(model => model.id === id), false);
});

for (const operation of ['unbind', 'rebind', 'rebind-same-path']) {
  test(`project ${operation} revokes its exact accepted model binding through paused reader cleanup`, async t => {
    const paused = pausedChat();
    const f = loadMainFixture(t, { registry: streamRegistry(), beforeClose: paused.release, fetchFn: async () => paused.response });
    const bound = await bindProject(f);
    const accepted = await f.accept('chat:send', f.payload({ ...bound, assistantId: 'assistant_codex' }));
    await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
    let revoked;
    if (operation === 'unbind') {
      revoked = await f.invoke('worktree:unbind', { projectBindingId: bound.projectBindingId });
    } else {
      const replacement = operation === 'rebind-same-path' ? bound.project.path : path.join(f.root, 'replacement');
      if (operation !== 'rebind-same-path') fs.mkdirSync(replacement);
      revoked = await f.invoke('worktree:bind', { projectId: bound.project.id, projectPath: replacement });
      assert.notEqual(revoked.projectBindingId, bound.projectBindingId);
    }
    assert.equal(revoked.ok, true);
    assert.equal(f.inspect(`worktreeIpc.resolveBinding({ sender: { id: 1 } }, { projectBindingId: ${JSON.stringify(bound.projectBindingId)} })`), null);
    assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), true);
    await paused.cancelStarted.promise;
    const completion = f.settle(accepted);
    assert.equal((await f.invoke('chat:send', f.payload({ clientRequestId: 'revoked-root-still-cleaning' }))).code, 'BUSY');
    assert.equal(paused.released, false);
    paused.release(); const result = await completion;
    assert.equal(result.ok, false); assert.equal(result.aborted, true);
    assert.equal(f.inspect('foregroundModels.current'), null); assert.equal(paused.released, true);
    assert.equal(f.requests.length, 1);
    const terminal = f.events.filter(item => item.channel === 'chat:event' && [AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED].includes(item.event.type));
    assert.equal(terminal.length, 1); assert.equal(terminal[0].event.type, AGENT_EVENTS.ABORTED);
    const usage = readRecords(usageFilePath(f.root)).records;
    assert.equal(usage.length, 1); assert.equal(usage[0].status, 'cancelled');
    assert.equal(usage[0].in, null); assert.equal(usage[0].out, null);
  });
}

test('failed or foreign project revocation preserves the accepted owner binding', async t => {
  const paused = pausedChat();
  const f = loadMainFixture(t, { registry: streamRegistry(), beforeClose: paused.release, fetchFn: async () => paused.response });
  const bound = await bindProject(f);
  const accepted = await f.accept('chat:send', f.payload({ ...bound, assistantId: 'assistant_codex' }));
  await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
  assert.equal((await f.invoke('worktree:unbind', { projectBindingId: bound.projectBindingId }, f.otherSender)).ok, false);
  assert.equal((await f.invoke('worktree:bind', { projectId: bound.project.id, projectPath: path.join(f.root, 'missing') })).ok, false);
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), false);
  assert.ok(f.inspect(`worktreeIpc.resolveBinding({ sender: { id: 1 } }, { projectBindingId: ${JSON.stringify(bound.projectBindingId)} })`));
  assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId })).ok, true);
  await paused.cancelStarted.promise;
  const completion = f.settle(accepted); paused.release(); assert.equal((await completion).aborted, true);
});

test('a retained bound model closure rejects revoked project authority before another physical attempt', async t => {
  const paused = pausedChat();
  const f = loadMainFixture(t, { registry: streamRegistry(), beforeClose: paused.release, fetchFn: async () => paused.response });
  const bound = await bindProject(f);
  const accepted = await f.accept('chat:send', f.payload({ ...bound, assistantId: 'assistant_codex' }));
  await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
  const retainedChat = f.inspect('boundModelChat(foregroundModels.current.binding, foregroundModels.current.settings, { kind: "subagent-explore" })');
  assert.equal((await f.invoke('worktree:unbind', { projectBindingId: bound.projectBindingId })).ok, true);
  await paused.cancelStarted.promise;
  const completion = f.settle(accepted); paused.release(); assert.equal((await completion).aborted, true);
  await assert.rejects(retainedChat({ messages: [{ role: 'user', content: 'Do not resend revoked context' }] }), error => error.code === 'ABORTED');
  assert.equal(f.requests.length, 1); assert.equal(f.credentialReads.length, 0);
  assert.equal(readRecords(usageFilePath(f.root)).records.length, 1);
});

for (const unrelated of ['no-project-context', 'other-root', 'other-sender']) {
  test(`project revocation leaves ${unrelated} foreground authority alone`, async t => {
    const paused = pausedChat();
    const f = loadMainFixture(t, { registry: streamRegistry(), beforeClose: paused.release, fetchFn: async () => paused.response });
    const bound = await bindProject(f);
    const payload = unrelated === 'no-project-context' ? f.payload() : f.payload({ ...bound, assistantId: 'assistant_codex' });
    let removed = bound, owner = f.sender;
    if (unrelated === 'other-root') {
      const otherRoot = path.join(f.root, 'other-root'); fs.mkdirSync(otherRoot);
      removed = await f.invoke('worktree:bind', { projectId: 'other-root', projectPath: otherRoot });
    } else if (unrelated === 'other-sender') {
      owner = f.otherSender;
      removed = await f.invoke('worktree:bind', { projectId: bound.project.id, projectPath: bound.project.path }, owner);
    }
    const accepted = await f.accept('chat:send', payload);
    await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.TEXT_DELTA);
    assert.equal((await f.invoke('worktree:unbind', { projectBindingId: removed.projectBindingId }, owner)).ok, true);
    assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), false);
    assert.equal(paused.released, false);
    if (unrelated !== 'no-project-context') {
      assert.equal(f.inspect(`Boolean(worktreeIpc.resolveBinding({ sender: { id: 1 } }, { projectBindingId: ${JSON.stringify(bound.projectBindingId)} }))`), true);
    }
    assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId, clientRequestId: accepted.clientRequestId })).ok, true);
    await paused.cancelStarted.promise;
    const completion = f.settle(accepted); paused.release(); assert.equal((await completion).aborted, true);
    assert.equal(readRecords(usageFilePath(f.root)).records.length, 1);
  });
}

test('project unbind cancels every inherited child model attempt without releasing the parent lease', async t => {
  const readers = [pausedChat(), pausedChat()]; const bothStarted = deferred(); let started = 0, fetches = 0;
  const registry = streamRegistry(); registry.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared' };
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry), settings: { agentEnabled: true },
    beforeClose: () => readers.forEach(reader => reader.release()), fetchFn: async () => readers[fetches++].response,
    agentFn: async args => {
      const children = ['subagent-explore-one', 'subagent-explore-two'].map(kind => args.extensions.createBoundChat(kind, { signal: args.signal }));
      await Promise.all(children.map(chatFn => chatFn({ messages: [{ role: 'user', content: 'Synthetic child read-only goal' }], signal: args.signal,
        onDelta: ({ text }) => { args.onEvent({ type: AGENT_EVENTS.TEXT_DELTA, text }); if (++started === 2) bothStarted.resolve(); } })));
      assert.fail('Revoked child attempts must not reach old-root tool execution');
    },
  });
  const bound = await bindProject(f);
  const accepted = await f.accept('chat:send', f.payload({ ...bound, assistantId: 'assistant_codex' }));
  await bothStarted.promise;
  assert.equal(f.inspect('[...activeModelRequests.values()][0].size'), 2);
  assert.equal((await f.invoke('worktree:unbind', { projectBindingId: bound.projectBindingId })).ok, true);
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), true);
  await Promise.all(readers.map(reader => reader.cancelStarted.promise));
  const completion = f.settle(accepted);
  assert.equal((await f.invoke('chat:send', f.payload({ clientRequestId: 'children-cleaning' }))).code, 'BUSY');
  readers.forEach(reader => reader.release()); const result = await completion;
  assert.equal(result.aborted, true); assert.equal(f.inspect('activeModelRequests.size'), 0);
  assert.equal(f.requests.length, 2);
  const usage = readRecords(usageFilePath(f.root)).records;
  assert.equal(usage.length, 2); assert.ok(usage.every(record => record.status === 'cancelled'));
  assert.equal(new Set(usage.map(record => record.attemptId)).size, 2);
});

test('project unbind cancels pending approval and expires an executing Plan without old-root writes or replay', async t => {
  const registry = syntheticRegistry(); registry.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared' };
  let runs = 0, writes = 0, heldGate;
  const f = loadMainFixture(t, { registry: validateModelRegistry(registry), settings: { agentEnabled: true, permissionMode: 'confirm-writes' }, agentFn: async args => {
    runs++;
    if (args.agentMode === 'plan') {
      args.onEvent({ type: AGENT_EVENTS.PLAN_READY, planId: 'project-revoked-plan', markdown: 'Write only after explicit approval' });
      return { content: 'Prepared plan', applied: [] };
    }
    heldGate = args.gate;
    const authorization = await args.gate.authorize({ tool: 'write_file', risk: 'write', path: 'old-root.txt', signal: args.signal });
    if (authorization.allowed) { writes++; fs.writeFileSync(path.join(args.project.path, 'old-root.txt'), 'Synthetic authorized write'); }
    return { content: 'Plan execution finished', applied: [] };
  } });
  const bound = await bindProject(f);
  const payload = f.payload({ ...bound, assistantId: 'assistant_codex', agentMode: 'plan' });
  const proposed = await f.invoke('chat:send', payload); assert.equal(proposed.ok, true);
  const accepted = await f.accept('chat:approvePlan', { ...payload, planId: 'project-revoked-plan', clientRequestId: 'approve-project-plan' });
  const approval = await f.waitForEvent(item => item.channel === 'chat:event' && item.event.type === AGENT_EVENTS.APPROVAL_NEEDED);
  assert.equal(f.inspect('planState.plans.get("project-revoked-plan").executionStarted'), true);
  assert.equal((await f.invoke('worktree:unbind', { projectBindingId: bound.projectBindingId })).ok, true);
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), true);
  assert.equal(heldGate.resolveApproval(approval.event.approvalId, 'allow'), false);
  const result = await f.settle(accepted); assert.equal(result.aborted, true);
  assert.equal(f.inspect('planState.plans.get("project-revoked-plan").status'), 'expired');
  assert.equal(writes, 0); assert.equal(fs.existsSync(path.join(bound.project.path, 'old-root.txt')), false);
  const replacement = await f.invoke('worktree:bind', { projectId: bound.project.id, projectPath: bound.project.path });
  const replay = await f.invoke('chat:approvePlan', { ...payload, projectBindingId: replacement.projectBindingId, planId: 'project-revoked-plan', clientRequestId: 'cannot-replay-project-plan' });
  assert.equal(replay.ok, false); assert.equal(replay.isRetryable, false);
  assert.equal(runs, 2); assert.equal(f.requests.length, 0);
});
