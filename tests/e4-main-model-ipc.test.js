'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { loadMainFixture, loadPreloadFixture, syntheticRegistry, jsonResponse, deferred } = require('./helpers/e4-main-fixture');

const terminals = new Set([AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED]);
async function assertRejected(promise, predicate) {
  const result = await promise;
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(predicate(result), true, JSON.stringify(result));
  return result;
}
const runEvents = (f, runId) => f.events.filter(record => record.channel === 'chat:event' && record.event.runId === runId).map(record => record.event);

test('real main registers all E4 metadata/credential/diagnostic IPC and preload uses the same channels', async t => {
  const f = loadMainFixture(t);
  for (const channel of ['models:list', 'models:saveProvider', 'models:saveModel', 'models:remove',
    'models:setDefault', 'models:setCredential', 'models:clearCredential', 'models:retryCredentialCleanup',
    'models:syncSessionReferences', 'models:diagnose', 'models:cancelDiagnosis', 'assistants:list', 'assistants:save', 'assistants:delete']) {
    assert.equal(f.handlers.has(channel), true, channel);
  }
  const { api } = loadPreloadFixture(f);
  const registry = await api.listModels();
  assert.equal(registry.registry.schemaVersion, 1);
  assert.equal(JSON.stringify(registry).includes('secretRef'), false);
  assert.equal((await api.retryModelCredentialCleanup({ expectedRevision: registry.revision })).cleanupState, 'clean');
  assert.equal((await api.syncModelSessionReferences({ sessions: [{ sessionId: 'live-session', assistantId: 'assistant_general', modelProfileId: null, identityType: 'ai' }] })).ok, true);
  const publicSettings = await f.invoke('settings:get');
  assert.equal(Object.hasOwn(publicSettings, 'secretRef'), false);
});

test('real main rejects unregistered or demo senders before accepting a model run', async t => {
  const f = loadMainFixture(t);
  const impostor = { id: 1, isDestroyed: () => false, send() {} };
  const invalidSender = await assertRejected(f.invoke('chat:send', f.payload(), impostor), error => error.code === 'MODEL_CONFIG_INVALID');
  assert.equal(invalidSender.retryable, false);
  assert.equal(typeof invalidSender.safeMessage, 'string');
  assert.equal(Object.hasOwn(invalidSender, 'legacyCode'), false);
  await assertRejected(f.invoke('chat:send', f.payload({ identityType: 'demo-contact' })), error => error.code === 'ASSISTANT_IDENTITY_INVALID');
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.filter(record => record.channel === 'chat:event').length, 0);
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('accepted chat, run-start, usage and one final carry one immutable model/task/request identity', async t => {
  const f = loadMainFixture(t);
  const accepted = await f.accept('chat:send', f.payload());
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.modelSource.kind, 'api');
  assert.equal(accepted.modelSource.providerRevision, 1);
  assert.equal(accepted.modelSource.modelRevision, 1);
  assert.equal(accepted.modelSource.assistantRevision, 1);
  assert.equal(accepted.task.kind, 'chat_run');
  const result = await f.settle(accepted);
  const events = runEvents(f, accepted.runId);
  assert.equal(events.filter(event => event.type === AGENT_EVENTS.RUN_START).length, 1);
  assert.equal(events.filter(event => terminals.has(event.type)).length, 1);
  for (const value of [accepted, result, ...events]) {
    assert.equal(value.runId, accepted.runId);
    assert.equal(value.sessionId, accepted.sessionId);
    assert.equal(value.clientRequestId, accepted.clientRequestId);
    assert.deepEqual(value.modelSource, accepted.modelSource);
    assert.equal(value.task.taskId, accepted.task.taskId);
    assert.equal(value.task.kind, accepted.task.kind);
  }
  assert.equal(result.content, 'Synthetic model answer');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].request.headers.Authorization, undefined);
  assert.equal(Object.hasOwn(f.requests[0].body, 'temperature'), false);
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('capability and input preflight fail without acceptance, draft events, credential reads or model attempts', async t => {
  const f = loadMainFixture(t, { registry: syntheticRegistry({ streamMode: 'on' }) });
  await assertRejected(f.invoke('chat:send', f.payload()), error => /CAPABILITY/.test(error.code));
  assert.equal(f.events.filter(record => record.channel === 'chat:event').length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('missing provider credential is a preflight rejection rather than an accepted empty run', async t => {
  const f = loadMainFixture(t, { registry: syntheticRegistry({ authKind: 'bearer' }) });
  await assertRejected(f.invoke('chat:send', f.payload()), error => /AUTH|CREDENTIAL/.test(error.code));
  assert.equal(f.events.filter(record => record.channel === 'chat:event').length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('BUSY precedes auto compact and scoped stop retains the lease until reader.cancel and releaseLock', async t => {
  const cleanup = deferred(); const pendingRead = deferred(); const cancelStarted = deferred();
  let reads = 0; let cancels = 0; let released = false;
  const registry = syntheticRegistry({ streamMode: 'on' });
  registry.models[0].capabilities.streaming = { state: 'supported', source: 'declared', checkedAt: null, bindingRevision: null };
  const f = loadMainFixture(t, { registry, beforeClose: () => { cleanup.resolve(); pendingRead.resolve({ done: true }); },
    fetchFn: async () => ({ ok: true, status: 200, redirected: false,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: { getReader: () => ({
        read: () => ++reads === 1 ? Promise.resolve({ done: false, value: Buffer.from('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Partial streamed answer"},"finish_reason":null}]}\n\n') }) : pendingRead.promise,
        cancel: async () => { cancels++; cancelStarted.resolve(); await cleanup.promise; pendingRead.resolve({ done: true }); },
        releaseLock: () => { released = true; },
      }) },
    }) });
  const accepted = await f.accept('chat:send', f.payload());
  await f.waitForEvent(record => record.event.type === AGENT_EVENTS.TEXT_DELTA && record.event.text === 'Partial streamed answer');
  f.patchSettings({ autoCompact: true, compactMaxMessages: 20 });
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Historical message ${i}` }));
  await assertRejected(f.invoke('chat:send', f.payload({ clientRequestId: 'busy-request', messages: history })), error => error.code === 'BUSY');
  await assertRejected(f.invoke('session:compact', f.payload({ clientRequestId: 'busy-compact', messages: history })), error => error.code === 'BUSY');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId }, f.otherSender)).ok, false);
  assert.equal((await f.invoke('chat:stop', { sessionId: 'other-session', runId: accepted.runId })).ok, false);
  assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId })).ok, true);
  await cancelStarted.promise;
  assert.equal(cancels, 1); assert.equal(released, false);
  assert.equal(f.inspect('foregroundModels.current?.runId'), accepted.runId);
  await assertRejected(f.invoke('chat:send', f.payload({ clientRequestId: 'cleanup-still-busy' })), error => error.code === 'BUSY');
  cleanup.resolve();
  await f.settle(accepted);
  assert.equal(released, true); assert.equal(cancels, 1);
  assert.equal(f.inspect('foregroundModels.current'), null);
  const terminal = runEvents(f, accepted.runId).filter(event => terminals.has(event.type));
  assert.equal(terminal.length, 1); assert.equal(terminal[0].partialOutput, 'Partial streamed answer');
  assert.equal(runEvents(f, accepted.runId).find(event => event.type === AGENT_EVENTS.USAGE).status, 'cancelled');
});

test('manual compact is accepted with a bound foreground task and cannot race chat', async t => {
  const block = deferred();
  const f = loadMainFixture(t, { fetchFn: async () => { await block.promise; return jsonResponse('Bound summary'); } });
  t.after(() => block.resolve());
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }));
  const accepted = await f.accept('session:compact', f.payload({ clientRequestId: 'manual-compact', messages: history, keepMessages: 6, force: true }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.task.kind, 'session_compact');
  assert.equal(accepted.modelSource.kind, 'api');
  await assertRejected(f.invoke('chat:send', f.payload()), error => error.code === 'BUSY');
  block.resolve();
  const result = await f.settle(accepted);
  assert.equal(result.messages[0].content.includes('Bound summary'), true);
  assert.deepEqual(result.messages[0].modelSource, accepted.modelSource);
  assert.equal(result.candidates.length, 0); // General cannot acquire project memory as a compact side effect.
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.filter(record => record.event.type === 'compact-start').length, 1);
  assert.equal(f.events.filter(record => record.event.type === 'compact-done').length, 1);
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('auto compact belongs to the accepted chat binding and never summarizes the new user input', async t => {
  const f = loadMainFixture(t, { settings: { autoCompact: true, compactMaxMessages: 20, compactKeepMessages: 6 },
    fetchFn: async (_url, _request, attempt) => jsonResponse(attempt === 1 ? 'Synthetic summary' : 'Answer to the new question') });
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Old message ${i}`, modelSource: { kind: 'legacy-demo' } }));
  const accepted = await f.invoke('chat:send', f.payload({ messages: [...history, { role: 'user', content: 'NEW USER MUST NOT BE COMPACTED' }] }));
  const result = await f.settle(accepted);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.requests[0].body).includes('NEW USER MUST NOT BE COMPACTED'), false);
  assert.equal(JSON.stringify(f.requests[1].body).includes('Synthetic summary'), true);
  assert.equal(JSON.stringify(f.requests[1].body).includes('NEW USER MUST NOT BE COMPACTED'), true);
  assert.equal(JSON.stringify(f.requests[1].body).includes('modelSource'), false);
  const compacted = runEvents(f, accepted.runId).find(event => event.type === 'session-compacted');
  assert.ok(compacted);
  assert.deepEqual(compacted.modelSource, accepted.modelSource);
  assert.equal(compacted.messages.length, 7);
  assert.equal(compacted.messages.at(-1).content, 'Old message 29');
  assert.equal(result.content, 'Answer to the new question');
});

test('a Gate construction error after acceptance still emits exactly one failed terminal and releases the lease', async t => {
  const f = loadMainFixture(t, { gateFn: () => { throw Object.assign(new Error('Synthetic gate setup failure'), { code: 'GATE_SETUP_FAILED' }); } });
  const accepted = await f.accept('chat:send', f.payload());
  const result = await f.settle(accepted);
  assert.equal(result.ok, false);
  const events = runEvents(f, accepted.runId);
  assert.equal(events.filter(event => terminals.has(event.type)).length, 1);
  assert.equal(events.find(event => terminals.has(event.type)).task.state, 'failed');
  assert.equal(f.inspect('foregroundModels.current'), null);
});

test('model diagnostic events reach the public preload subscription and do not acquire the chat lease', async t => {
  const f = loadMainFixture(t);
  const { api, listeners } = loadPreloadFixture(f);
  const unsubscribe = api.onModelDiagnosticEvent(() => {});
  assert.equal(listeners.has('models:diagnostic-event'), true);
  const registry = await f.invoke('models:list');
  const accepted = await api.diagnoseModel({ modelProfileId: registry.registry.defaultModelProfileId, expectedRevision: registry.revision,
    clientRequestId: 'diagnostic-request', sessionId: 'diagnostic-session', checks: ['text'], confirmed: true });
  assert.ok(accepted.diagnosticId);
  assert.equal(f.inspect('foregroundModels.current'), null);
  const terminal = await f.waitForEvent(record => record.channel === 'models:diagnostic-event' && ['passed', 'failed', 'stale', 'cancelled'].includes(record.event.state));
  assert.equal(terminal.event.state, 'passed');
  assert.equal(f.requests.length, 1);
  unsubscribe();
});

test('foreground invoke resolves the final result after cleanup, not an acceptance-only ACK', async t => {
  for (const channel of ['chat:send', 'session:compact']) await t.test(channel, async subtest => {
    const hold = deferred(); const entered = deferred(); let invokeReturned = false;
    const f = loadMainFixture(subtest, { beforeClose: () => hold.resolve(), fetchFn: async () => {
      entered.resolve(); await hold.promise; return jsonResponse('Synthetic final result');
    } });
    const messages = channel === 'session:compact'
      ? Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Old message ${index}` }))
      : [{ role: 'user', content: 'Synthetic question' }];
    const pending = f.invoke(channel, f.payload({ messages, force: true })).then(result => {
      invokeReturned = true; return result;
    });
    const started = await f.waitForEvent(record => record.channel === 'chat:event'
      && record.event.type === (channel === 'chat:send' ? AGENT_EVENTS.RUN_START : 'compact-start'));
    await entered.promise;
    assert.equal(invokeReturned, false);
    assert.equal(f.inspect('foregroundModels.current?.runId'), started.event.runId);
    hold.resolve();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.runId, started.event.runId);
    assert.equal(result.clientRequestId, started.event.clientRequestId);
    assert.equal(result.sessionId, started.event.sessionId);
    assert.deepEqual(result.modelSource, started.event.modelSource);
    assert.equal(result.task.state, 'completed');
    assert.equal(channel === 'chat:send' ? result.content : result.messages[0].content.includes('Synthetic final result'),
      channel === 'chat:send' ? 'Synthetic final result' : true);
    assert.equal(f.inspect('foregroundModels.current'), null);
  });
});

test('diagnostic cancellation derives owner from Electron rather than caller-supplied senderId', async t => {
  const entered = deferred(); let requestSignal; let readerCancels = 0;
  const f = loadMainFixture(t, { fetchFn: async (_url, request) => {
    requestSignal = request.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic diagnostic partial"},"finish_reason":null}]}\n\n'));
      },
      cancel() { readerCancels++; },
    });
    entered.resolve();
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } });
  const registry = await f.invoke('models:list');
  const accepted = await f.invoke('models:diagnose', { modelProfileId: registry.registry.defaultModelProfileId,
    expectedRevision: registry.revision, checks: ['streaming'] });
  assert.equal(accepted.accepted, true);
  await entered.promise;
  const identities = { diagnosticId: accepted.diagnosticId, sessionId: accepted.sessionId,
    runId: accepted.runId, clientRequestId: accepted.clientRequestId };
  const forged = await f.invoke('models:cancelDiagnosis', { ...identities, senderId: f.sender.id }, f.otherSender);
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'DIAGNOSTIC_NOT_RUNNING');
  assert.equal(requestSignal.aborted, false);
  assert.equal((await f.invoke('models:cancelDiagnosis', { ...identities, senderId: f.otherSender.id })).ok, true);
  const terminal = await f.waitForEvent(record => record.channel === 'models:diagnostic-event'
    && record.event.diagnosticId === accepted.diagnosticId && record.event.state === 'cancelled');
  assert.equal(terminal.senderId, f.sender.id);
  assert.equal(requestSignal.aborted, true);
  assert.equal(readerCancels, 1);
  assert.equal(f.requests.length, 1);
});
