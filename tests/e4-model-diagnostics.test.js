'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, resolveModelBinding, updateModelRegistry, applyObservedCapabilities } = require('../src/ai/model-profiles');
const { createModelDiagnosticService, DIAGNOSTIC_LIMITS } = require('../src/ai/model-diagnostics');

let sequence = 0;
function fixture(extra = {}) {
  const id = ++sequence;
  let registry = createModelRegistry({ baseUrl: 'https://diagnostic.synthetic.example/gateway/v1', model: 'synthetic-model', secretRef: 'synthetic-secret-ref', apiKeyConfigured: true });
  if (extra.modelProfileId || extra.providerId) registry = updateModelRegistry(registry, draft => {
    if (extra.providerId) { draft.providers[0].id = extra.providerId; draft.models[0].providerId = extra.providerId; }
    if (extra.modelProfileId) { draft.models[0].id = extra.modelProfileId; draft.defaultModelProfileId = extra.modelProfileId; }
  });
  const sender = { id: extra.senderId || 41 };
  const binding = resolveModelBinding({ registry, senderId: sender.id, sessionId: `synthetic-session-${id}`, runId: `synthetic-diagnostic-${id}`, clientRequestId: `synthetic-client-${id}`, kind: 'model-diagnostic', assistantId: 'assistant_general', ...extra });
  return { registry, binding, sender };
}
function actual(input = 9, output = 2) { return { inputTokens: input, outputTokens: output, cachedInputTokens: null, cacheCreationInputTokens: null, source: 'actual' }; }
function response(id, extra = {}) { return { attemptId: id, content: 'SYNTHETIC_DIAGNOSTIC_OK', finishReason: 'stop', toolCalls: [], usage: actual(), ...extra }; }
function coded(code, attemptId) { return Object.assign(new Error('synthetic-private-upstream-content'), { code, ...(attemptId ? { attemptId } : {}) }); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function tick() { return new Promise(resolve => setImmediate(resolve)); }
function successfulInvoke(calls) {
  return async options => {
    calls.push(options);
    const id = `synthetic-attempt-${calls.length}`;
    if (options.diagnosticCheck === 'streaming') options.onEvent({ type: 'text-delta', delta: 'synthetic-private-stream-content' });
    if (options.diagnosticCheck === 'nativeTools' && options.messages.every(message => message.role !== 'tool')) {
      return response(id, { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'synthetic-call', name: 'synthetic_echo', argumentsJson: JSON.stringify({ text: options.tools[0].parameters.properties.text.enum[0] }) }], providerState: { syntheticPrivate: 'synthetic-provider-state' } });
    }
    const tool = options.messages.find(message => message.role === 'tool');
    return response(id, tool ? { content: tool.content } : {});
  };
}

function assertNoPrivate(value) {
  const json = JSON.stringify(value);
  for (const forbidden of ['synthetic-secret-ref', 'synthetic-private-upstream-content', 'synthetic-private-stream-content', 'synthetic-provider-state', 'secretRef', 'credentialOrigin', 'credentialRevision', 'rawProviderState', 'argumentsJson']) assert.ok(!json.includes(forbidden), forbidden);
}

test('diagnostic constants are fixed, frozen and side-effect free', async () => {
  assert.deepEqual(DIAGNOSTIC_LIMITS, { timeoutMs: 15000, maxOutputTokens: 128, maxResponseBytes: 262144, maxRequests: 5 });
  assert.ok(Object.isFrozen(DIAGNOSTIC_LIMITS));
  const service = createModelDiagnosticService({ invoke: () => assert.fail('No implicit request') });
  assert.equal(service.getState('model_legacy_default', 'new-wire').state, 'not-tested');
  assert.deepEqual(service.activeBindings, []);
  await service.close();
});

test('start returns synchronous ACK before invoking or emitting and uses shared TaskHandle metadata', async () => {
  const { binding, sender } = fixture(); const calls = []; const events = [];
  const service = createModelDiagnosticService({ invoke: successfulInvoke(calls), onEvent: (owner, event) => { assert.equal(owner, sender); events.push(event); } });
  const ack = service.start({ binding, sender, checks: ['text'] });
  assert.equal(ack.then, undefined); assert.equal(ack.ok, true); assert.equal(ack.accepted, true);
  assert.equal(ack.diagnosticId, binding.runId); assert.equal(ack.runId, binding.runId); assert.equal(ack.sessionId, binding.sessionId); assert.equal(ack.clientRequestId, binding.clientRequestId);
  assert.equal(ack.task.kind, 'model_diagnostic'); assert.equal(ack.task.taskId, binding.runId); assert.equal(ack.task.state, 'running');
  assert.equal(calls.length, 0); assert.equal(events.length, 0); assert.equal(service.isInUse({ modelProfileId: binding.modelProfileId }), true);
  const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'passed'); assert.equal(done.task.state, 'completed'); assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'done');
  for (const event of events) { assert.equal(event.diagnosticId, binding.runId); assert.equal(event.task.kind, 'model_diagnostic'); assert.equal(event.modelSource.model, binding.model); assert.ok(event.checks.text); }
  assertNoPrivate([ack, done, events]); await service.close();
});

test('default four fixed checks issue at most five bounded calls and only synthetic native tool', async () => {
  const { binding, sender } = fixture(); const calls = []; const usages = []; const results = [];
  const service = createModelDiagnosticService({ invoke: successfulInvoke(calls), onUsage: item => usages.push(item), applyResult: result => results.push(result) });
  const ack = service.start({ binding, sender }); const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'passed'); assert.equal(calls.length, 5); assert.equal(usages.length, 5); assert.equal(results.length, 1);
  assert.deepEqual(calls.map(call => call.diagnosticCheck), ['text', 'streaming', 'usage', 'nativeTools', 'nativeTools']);
  for (const call of calls) {
    assert.equal(call.binding, binding); assert.equal(call.purpose, 'diagnostic'); assert.equal(call.request.maxOutputTokens, 128);
    assert.ok(call.request.timeoutMs > 0 && call.request.timeoutMs <= 15000); assert.equal(call.request.maxResponseBytes, 262144); assert.equal(call.request.maxFrameBytes, 262144);
    assert.ok(call.request.deadlineAt > 0); assert.ok(call.signal instanceof AbortSignal);
    assert.ok(call.messages.every(message => ['system', 'user', 'assistant', 'tool'].includes(message.role)));
    assert.deepEqual(call.tools.map(tool => tool.name), call.diagnosticCheck === 'nativeTools' ? ['synthetic_echo'] : []);
  }
  assert.equal(calls[3].request.deadlineAt, calls[4].request.deadlineAt);
  assert.deepEqual(calls[4].providerState, { syntheticPrivate: 'synthetic-provider-state' });
  assert.equal(calls[4].messages.find(message => message.role === 'tool').content, calls[3].tools[0].parameters.properties.text.enum[0]);
  assert.equal(results[0].expectedDeclarations, binding.modelProfile.capabilities); assert.equal(results[0].bindingRevision, binding.bindingRevision);
  for (const observation of Object.values(results[0].observations)) { assert.deepEqual(Object.keys(observation).sort(), ['checkedAt', 'state']); assert.equal(observation.state, 'supported'); assert.ok(Number.isFinite(Date.parse(observation.checkedAt))); }
  assertNoPrivate(done); await service.close();
});

test('only original complete diagnostic binding owned by sender is accepted', async () => {
  const good = fixture(); const service = createModelDiagnosticService({ invoke: () => assert.fail('invalid preflight invokes') });
  const invalid = [{ ...good, binding: { ...good.binding } }, { ...fixture({ kind: 'chat' }) }, { ...fixture({ runId: null }) }, { ...fixture({ clientRequestId: null }) }, { ...fixture({ sessionId: null }) }, { ...good, sender: { id: 999 } }, { ...good, sender: null }];
  for (const item of invalid) assert.throws(() => service.start({ binding: item.binding, sender: item.sender }), error => ['MODEL_BINDING_INVALID', 'MODEL_DIAGNOSTIC_INPUT_INVALID', 'MODEL_SENDER_MISMATCH'].includes(error.code));
  assert.deepEqual(service.activeBindings, []); await service.close();
});

test('rejects arbitrary prompts, tools, endpoint, purpose, budget and malformed check selection', async () => {
  const { binding, sender } = fixture(); const service = createModelDiagnosticService({ invoke: () => assert.fail('untrusted request') });
  for (const extra of [{ messages: [] }, { tools: [] }, { endpoint: 'https://other.synthetic.example' }, { purpose: 'workload' }, { request: { maxOutputTokens: 999 } }, { checks: ['vision'] }, { checks: [] }, { checks: ['text', 'text'] }, { checks: 'text' }]) assert.throws(() => service.start({ binding, sender, ...extra }), { code: 'MODEL_DIAGNOSTIC_INPUT_INVALID' });
  await service.close();
});

test('credential resolver receives original binding but all public surfaces are whitelisted', async () => {
  const { binding, sender } = fixture(); const events = []; let resolved;
  const resolveCredential = value => { resolved = value; return 'synthetic-private-credential'; };
  const service = createModelDiagnosticService({ resolveCredential, invoke: async options => { assert.equal(options.resolveCredential, resolveCredential); assert.equal(await options.resolveCredential(options.binding), 'synthetic-private-credential'); return response('credential-attempt', { modelSource: { secretRef: 'synthetic-secret-ref' }, rawProviderState: 'synthetic-private-upstream-content' }); }, onEvent: (_, event) => events.push(event) });
  const ack = service.start({ binding, sender, checks: ['text'] }); const done = await service.wait(ack.diagnosticId);
  assert.equal(resolved, binding); assertNoPrivate([ack, done, events]); assert.ok(!JSON.stringify(events).includes('synthetic-private-credential')); await service.close();
});

test('native tool omission is unknown and never manufactures unsupported evidence', async () => {
  const { binding, sender } = fixture(); let count = 0; let applies = 0;
  const service = createModelDiagnosticService({ invoke: async () => response(`tool-omitted-${++count}`), applyResult: () => { applies++; } });
  const done = await service.wait(service.start({ binding, sender, checks: ['nativeTools'] }).diagnosticId);
  assert.equal(count, 1); assert.equal(done.checks.nativeTools.state, 'unknown'); assert.equal(done.checks.nativeTools.capability, 'unknown'); assert.equal(done.state, 'failed'); assert.equal(applies, 0); await service.close();
});

test('malformed or interrupted synthetic calls cannot execute or become supported', async () => {
  for (const toolCalls of [[{ id: 'call', name: 'other_tool', argumentsJson: '{}' }], [{ id: 'call', name: 'synthetic_echo', argumentsJson: '{' }], [{ id: 'call', name: 'synthetic_echo', argumentsJson: '{"text":"other"}' }], [{ id: 'call', name: 'synthetic_echo', argumentsJson: '{"text":"SYNTHETIC_DIAGNOSTIC_OK","extra":true}' }]]) {
    const { binding, sender } = fixture(); let count = 0;
    const service = createModelDiagnosticService({ invoke: async () => { count++; return response(`bad-tool-${sequence}`, { finishReason: 'tool_calls', toolCalls }); } });
    const done = await service.wait(service.start({ binding, sender, checks: ['nativeTools'] }).diagnosticId);
    assert.equal(count, 1); assert.equal(done.checks.nativeTools.capability, 'unknown'); await service.close();
  }
});

test('native support requires valid second round exact echo, not just tool selection', async () => {
  const { binding, sender } = fixture(); const calls = []; let applies = 0; const valid = successfulInvoke(calls);
  const service = createModelDiagnosticService({ invoke: async options => { const result = await valid(options); return calls.length === 2 ? { ...result, content: 'wrong echo' } : result; }, applyResult: () => { applies++; } });
  const done = await service.wait(service.start({ binding, sender, checks: ['nativeTools'] }).diagnosticId);
  assert.equal(calls.length, 2); assert.equal(done.checks.nativeTools.capability, 'unknown'); assert.equal(applies, 0); await service.close();
});

test('streaming needs actual delta and complete stop rather than response content alone', async () => {
  for (const sendDelta of [false, true]) {
    const { binding, sender } = fixture();
    const service = createModelDiagnosticService({ invoke: async options => { if (sendDelta) options.onEvent({ type: 'text-delta', delta: 'fixed synthetic delta' }); return response(`stream-${sendDelta}`); } });
    const done = await service.wait(service.start({ binding, sender, checks: ['streaming'] }).diagnosticId);
    assert.equal(done.checks.streaming.capability, sendDelta ? 'supported' : 'unknown'); await service.close();
  }
});

test('usage support requires actual valid input/output counts including actual zero', async () => {
  for (const usage of [actual(0, 0), { ...actual(), source: 'estimated' }, { ...actual(), source: 'unavailable' }, { ...actual(), inputTokens: null }]) {
    const { binding, sender } = fixture(); const service = createModelDiagnosticService({ invoke: async () => response(`usage-${sequence}`, { usage }) });
    const done = await service.wait(service.start({ binding, sender, checks: ['usage'] }).diagnosticId);
    assert.equal(done.checks.usage.capability, usage.source === 'actual' && usage.inputTokens !== null ? 'supported' : 'unknown'); await service.close();
  }
});

test('empty or incomplete text does not establish text support', async () => {
  for (const extra of [{ content: '' }, { content: '   ' }, { finishReason: 'length' }, { finishReason: 'filtered' }]) {
    const { binding, sender } = fixture(); let applies = 0; const service = createModelDiagnosticService({ invoke: async () => response(`text-${sequence}`, extra), applyResult: () => { applies++; } });
    const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
    assert.equal(done.checks.text.capability, 'unknown'); assert.equal(applies, 0); await service.close();
  }
});

test('ordinary upstream errors remain check-local unknown and never unsupported', async () => {
  const { binding, sender } = fixture(); const usages = []; const results = [];
  const service = createModelDiagnosticService({ invoke: async options => { if (options.diagnosticCheck === 'text') throw Object.assign(coded('MODEL_HTTP_ERROR', 'failed-http-attempt'), { status: 400, usage: actual() }); return response('good-usage-attempt'); }, onUsage: item => usages.push(item), applyResult: item => results.push(item) });
  const done = await service.wait(service.start({ binding, sender, checks: ['text', 'usage'] }).diagnosticId);
  assert.equal(done.checks.text.capability, 'unknown'); assert.equal(done.checks.usage.capability, 'supported'); assert.equal(usages.length, 2); assert.equal(usages[0].attempt.usage.source, 'unavailable'); assert.equal(usages[0].attempt.usage.inputTokens, null);
  assert.deepEqual(Object.keys(results[0].observations), ['usage']); assertNoPrivate(done); await service.close();
});

test('preflight errors create no paid attempt or evidence', async () => {
  const { binding, sender } = fixture(); const usages = []; let applies = 0;
  const service = createModelDiagnosticService({ invoke: async () => { throw coded('MODEL_AUTH_REQUIRED'); }, onUsage: item => usages.push(item), applyResult: () => { applies++; } });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  assert.equal(done.state, 'failed'); assert.equal(usages.length, 0); assert.equal(applies, 0); await service.close();
});

test('cancel requires sender and diagnostic plus all supplied identities, retains lock through cleanup', async () => {
  const { binding, sender } = fixture(); const entered = deferred(); const cleanup = deferred(); const usages = []; const releases = []; let seenSignal;
  const service = createModelDiagnosticService({ invoke: async options => { seenSignal = options.signal; entered.resolve(); await cleanup.promise; throw coded('ABORTED', 'cancelled-physical'); }, onUsage: item => usages.push(item), onRelease: value => releases.push(value) });
  const ack = service.start({ binding, sender, checks: ['text'] }); await entered.promise;
  for (const extra of [{ senderId: 99 }, { diagnosticId: 'wrong' }, { sessionId: 'wrong' }, { runId: 'wrong' }, { clientRequestId: 'wrong' }]) assert.equal(service.cancel({ senderId: sender.id, diagnosticId: ack.diagnosticId, ...extra }).ok, false);
  assert.equal(seenSignal.aborted, false); assert.equal(service.cancel({ senderId: sender.id, diagnosticId: ack.diagnosticId, sessionId: binding.sessionId, runId: binding.runId, clientRequestId: binding.clientRequestId }).ok, true);
  assert.equal(seenSignal.aborted, true); assert.equal(service.isInUse({ providerId: binding.providerId }), true); assert.equal(releases.length, 0);
  cleanup.resolve(); const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.task.state, 'cancelled'); assert.equal(usages.length, 1); assert.equal(usages[0].attempt.status, 'cancelled'); assert.equal(usages[0].attempt.usage.source, 'unavailable'); assert.deepEqual(releases, [binding]); assert.equal(service.isInUse({ providerId: binding.providerId }), false); await service.close();
});

test('cancel immediately after ACK makes no request, usage or successful observation', async () => {
  const { binding, sender } = fixture(); const calls = []; const usages = []; const applied = [];
  const service = createModelDiagnosticService({ invoke: successfulInvoke(calls), onUsage: item => usages.push(item), applyResult: item => applied.push(item) });
  const ack = service.start({ binding, sender }); assert.equal(service.cancel({ senderId: sender.id, diagnosticId: ack.diagnosticId }).ok, true);
  const done = await service.wait(ack.diagnosticId); assert.equal(done.state, 'cancelled'); assert.equal(calls.length, 0); assert.equal(usages.length, 0); assert.equal(applied.length, 0); await service.close();
});

test('timeout and byte budget failures stop remaining checks and discard earlier successful evidence', async () => {
  for (const code of ['MODEL_TIMEOUT', 'MODEL_LIMIT_EXCEEDED']) {
    const { binding, sender } = fixture(); const calls = []; const applied = []; const usages = [];
    const service = createModelDiagnosticService({ invoke: async options => { calls.push(options); if (calls.length === 2) throw coded(code, `failed-${code}`); return response(`completed-${code}`); }, applyResult: item => applied.push(item), onUsage: item => usages.push(item) });
    const done = await service.wait(service.start({ binding, sender }).diagnosticId);
    assert.equal(calls.length, 2); assert.equal(done.state, 'failed'); assert.equal(applied.length, 0); assert.equal(usages.length, 2); assert.equal(usages[1].attempt.usage.source, 'unavailable'); assert.equal(done.checks.usage.state, 'not-tested'); await service.close();
  }
});

test('oversized synthetic delta aborts the current invoke and prevents evidence', async () => {
  const { binding, sender } = fixture(); const applied = []; let aborted = false;
  const service = createModelDiagnosticService({ invoke: async options => { options.onEvent({ type: 'text-delta', delta: 'x'.repeat(262145) }); aborted = options.signal.aborted; return response('oversize-attempt'); }, applyResult: item => applied.push(item) });
  const done = await service.wait(service.start({ binding, sender, checks: ['streaming', 'usage'] }).diagnosticId);
  assert.equal(aborted, true); assert.equal(done.state, 'failed'); assert.equal(applied.length, 0); assertNoPrivate(done); await service.close();
});

test('evidence merge uses original declarations and preserves concurrent user declaration', async () => {
  const { binding, sender, registry } = fixture(); let live = registry; let seen;
  const service = createModelDiagnosticService({ invoke: async () => { live = updateModelRegistry(live, draft => { draft.models[0].capabilities.text = { state: 'unsupported', source: 'declared', checkedAt: null, bindingRevision: null }; }); return response('declaration-attempt'); }, applyResult: result => { seen = result; live = applyObservedCapabilities(live, result); } });
  await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  assert.equal(seen.expectedDeclarations, binding.modelProfile.capabilities); assert.equal(live.models[0].capabilities.text.source, 'declared'); assert.equal(live.models[0].capabilities.text.state, 'unsupported'); await service.close();
});

test('stale apply outcome and cross-wire query are stale, names do not expire same wire', async () => {
  const { binding, sender } = fixture(); const events = [];
  const service = createModelDiagnosticService({ invoke: async () => response('stale-attempt'), applyResult: () => ({ stale: true }), onEvent: (_, event) => events.push(event) });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  assert.equal(done.state, 'stale'); assert.equal(events.at(-1).state, 'stale'); assert.equal(service.getState(binding.modelProfileId, 'different-wire').state, 'stale'); assert.equal(service.getState('other-model', binding.bindingRevision).state, 'not-tested'); assertNoPrivate(done); await service.close();
});

test('observer exceptions and rejected promises do not corrupt diagnostics or leak raw errors', async () => {
  const { binding, sender } = fixture(); const calls = []; let releases = 0;
  const service = createModelDiagnosticService({ invoke: successfulInvoke(calls), onEvent: () => { throw new Error('synthetic-private-upstream-content'); }, onUsage: () => Promise.reject(new Error('synthetic-private-upstream-content')), onRetain: () => { throw new Error('synthetic-private-upstream-content'); }, onRelease: () => { releases++; return Promise.reject(new Error('synthetic-private-upstream-content')); } });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId); await tick();
  assert.equal(done.state, 'passed'); assert.equal(releases, 1); assert.equal(service.activeBindings.length, 0); assertNoPrivate(done); await service.close();
});

test('same model concurrent starts reject, other owners/providers are independent, close drains all', async () => {
  const first = fixture({ modelProfileId: 'model_diag_one', providerId: 'provider_diag_one', senderId: 1 }); const second = fixture({ modelProfileId: 'model_diag_two', providerId: 'provider_diag_two', senderId: 2 }); const entered = []; let releases = 0;
  const service = createModelDiagnosticService({ invoke: options => new Promise((_, reject) => { entered.push(options); options.signal.addEventListener('abort', () => reject(coded('ABORTED', `owned-${entered.length}`)), { once: true }); }), onRelease: () => { releases++; } });
  const a = service.start({ binding: first.binding, sender: first.sender, checks: ['text'] });
  assert.throws(() => service.start({ binding: first.binding, sender: first.sender, checks: ['text'] }), error => ['CONFIG_IN_USE', 'DIAGNOSTIC_ID_CONFLICT'].includes(error.code));
  const b = service.start({ binding: second.binding, sender: second.sender, checks: ['text'] }); await tick();
  assert.equal(service.activeBindings.length, 2); assert.equal(service.isInUse({ providerId: 'provider_diag_one', modelProfileId: 'model_diag_two' }), false);
  service.cancelOwner(1); assert.equal((await service.wait(a.diagnosticId)).state, 'cancelled'); assert.equal(service.isInUse({ providerId: 'provider_diag_two' }), true);
  service.cancelProvider('provider_diag_two'); assert.equal((await service.wait(b.diagnosticId)).state, 'cancelled'); assert.equal(releases, 2);
  await service.close(); assert.throws(() => service.start({ binding: fixture().binding, sender: first.sender }), { code: 'DIAGNOSTIC_SERVICE_CLOSED' });
});

test('default router path uses only mocked synthetic fetch, never a real endpoint', async t => {
  const { binding, sender } = fixture(); let fetches = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { fetches++; assert.ok(JSON.parse(options.body).messages.length > 0); return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }); });
  const service = createModelDiagnosticService({ resolveCredential: value => { assert.equal(value, binding); return 'synthetic-credential'; } });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  assert.equal(done.state, 'passed'); assert.equal(fetches, 1); await service.close();
});

test('native two-round check shares one actual 15-second deadline and cleans its timer', async t => {
  const { binding, sender } = fixture(); const entered = deferred(); const calls = []; const usages = []; const applied = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const service = createModelDiagnosticService({ invoke: async options => {
    calls.push(options);
    if (calls.length === 1) {
      t.mock.timers.tick(9000);
      return response('deadline-first', { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'deadline-tool', name: 'synthetic_echo', argumentsJson: JSON.stringify({ text: options.tools[0].parameters.properties.text.enum[0] }) }] });
    }
    entered.resolve();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(coded('ABORTED', 'deadline-second')), { once: true }));
  }, onUsage: item => usages.push(item), applyResult: item => applied.push(item) });
  const ack = service.start({ binding, sender, checks: ['nativeTools'] }); await entered.promise;
  assert.equal(calls[1].request.timeoutMs, 6000); assert.equal(calls[0].request.deadlineAt, calls[1].request.deadlineAt);
  t.mock.timers.tick(5999); assert.equal(calls[1].signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(calls[1].signal.aborted, true);
  const done = await service.wait(ack.diagnosticId);
  assert.equal(done.code, 'DIAGNOSTIC_TIMEOUT'); assert.equal(done.state, 'failed'); assert.equal(applied.length, 0); assert.equal(usages.length, 2); assert.equal(usages[1].attempt.usage.source, 'unavailable');
  t.mock.timers.runAll(); assert.equal(service.activeBindings.length, 0); await service.close();
});

test('default router cancellation cancels a pending synthetic SSE reader before release', async t => {
  const { binding, sender } = fixture(); let cancelledReaders = 0; let released = 0; const usages = [];
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"synthetic partial"}}]}\n\n')); }, cancel() { cancelledReaders++; } });
  t.mock.method(globalThis, 'fetch', async (_url, options) => { assert.equal(JSON.parse(options.body).stream, true); return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }); });
  const service = createModelDiagnosticService({ resolveCredential: () => 'synthetic-credential', onUsage: item => usages.push(item), onRelease: () => { released++; assert.equal(cancelledReaders, 1); } });
  const ack = service.start({ binding, sender, checks: ['streaming'] }); await tick();
  assert.equal(service.cancel({ senderId: sender.id, diagnosticId: ack.diagnosticId }).ok, true);
  const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'cancelled'); assert.equal(cancelledReaders, 1); assert.equal(released, 1); assert.equal(usages.length, 1); assert.equal(usages[0].attempt.usage.source, 'unavailable'); assert.equal(done.checks.streaming.capability, 'unknown'); await service.close();
});

test('close drains a late successful invoke but cancellation cannot regain actual usage or evidence', async () => {
  const { binding, sender } = fixture(); const entered = deferred(); const cleanup = deferred(); const usages = []; const applied = []; let closed = false;
  const service = createModelDiagnosticService({ invoke: async () => { entered.resolve(); await cleanup.promise; return response('late-after-close'); }, onUsage: item => usages.push(item), applyResult: item => applied.push(item) });
  const ack = service.start({ binding, sender, checks: ['text'] }); await entered.promise;
  const closing = service.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(service.isInUse({ modelProfileId: binding.modelProfileId }), true);
  cleanup.resolve(); await closing; const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'cancelled'); assert.equal(usages.length, 1); assert.equal(usages[0].attempt.status, 'cancelled'); assert.equal(usages[0].attempt.usage.inputTokens, null); assert.equal(applied.length, 0); assert.equal(service.activeBindings.length, 0);
});

test('missing attempt provenance cannot prove support and repeated physical ID is emitted once', async () => {
  for (const missing of [false, true]) {
    const { binding, sender } = fixture(); const usages = []; const applied = [];
    const service = createModelDiagnosticService({ invoke: async () => response(missing ? undefined : 'duplicate-physical'), onUsage: item => usages.push(item), applyResult: item => applied.push(item) });
    const done = await service.wait(service.start({ binding, sender, checks: ['text', 'usage'] }).diagnosticId);
    assert.equal(usages.length, missing ? 0 : 1); assert.equal(done.checks.usage.capability, 'unknown'); assert.equal(done.checks.text.capability, missing ? 'unknown' : 'supported');
    assert.equal(applied.length, missing ? 0 : 1); await service.close();
  }
});

test('failed evidence persistence uses a fixed error code and still releases binding', async () => {
  const { binding, sender } = fixture(); const events = []; let released = 0;
  const service = createModelDiagnosticService({ invoke: async () => response('apply-failed'), applyResult: async () => { throw new Error('synthetic-private-upstream-content'); }, onEvent: (_, event) => events.push(event), onRelease: () => { released++; } });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  assert.equal(done.code, 'DIAGNOSTIC_APPLY_FAILED'); assert.equal(done.task.error, 'DIAGNOSTIC_APPLY_FAILED'); assert.equal(done.state, 'failed'); assert.equal(released, 1); assert.equal(events.at(-1).type, 'error'); assertNoPrivate([events, done]); await service.close();
});

test('display-only revisions keep diagnostic wire current and public snapshots are immutable', async () => {
  const { binding, sender, registry } = fixture(); const service = createModelDiagnosticService({ invoke: async () => response('rename-attempt') });
  const done = await service.wait(service.start({ binding, sender, checks: ['text'] }).diagnosticId);
  const renamed = updateModelRegistry(registry, draft => { draft.providers[0].name = 'Renamed synthetic provider'; draft.models[0].name = 'Renamed synthetic model'; });
  const next = resolveModelBinding({ registry: renamed, senderId: sender.id, sessionId: binding.sessionId, assistantId: 'assistant_general', runId: 'renamed-diagnostic', clientRequestId: 'renamed-client', kind: 'model-diagnostic' });
  assert.equal(next.bindingRevision, binding.bindingRevision); assert.equal(service.getState(binding.modelProfileId, next.bindingRevision).state, 'passed');
  assert.throws(() => { done.checks.text.capability = 'unsupported'; }, TypeError); assert.throws(() => { service.activeBindings.push(binding); }, TypeError); assert.equal(service.getState(binding.modelProfileId, next.bindingRevision).checks.text.capability, 'supported'); await service.close();
});

test('destroyed owners cannot start and malformed cancellation cannot throw or target a run', async () => {
  const { binding, sender } = fixture(); const service = createModelDiagnosticService({ invoke: () => assert.fail('destroyed owner request') });
  assert.throws(() => service.start({ binding, sender: { ...sender, isDestroyed: () => true }, checks: ['text'] }), { code: 'MODEL_SENDER_MISMATCH' });
  assert.deepEqual(service.cancel(null), { ok: false, code: 'DIAGNOSTIC_NOT_RUNNING' }); assert.deepEqual(service.cancel('invalid'), { ok: false, code: 'DIAGNOSTIC_NOT_RUNNING' }); await service.close();
});

test('default Responses native check preserves accepted assistant content and argument bytes for continuation', async t => {
  const base = fixture(); const registry = updateModelRegistry(base.registry, draft => { draft.providers[0].protocol = 'openai-responses'; });
  const binding = resolveModelBinding({ registry, senderId: base.sender.id, sessionId: base.binding.sessionId, runId: base.binding.runId, clientRequestId: base.binding.clientRequestId, kind: 'model-diagnostic', assistantId: 'assistant_general' });
  const output = [{ type: 'message', id: 'message-diag', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic-private-upstream-content' }] }, { type: 'function_call', id: 'fc-diag', call_id: 'call-diag', name: 'synthetic_echo', arguments: '{ "text" : "SYNTHETIC_DIAGNOSTIC_OK" }' }];
  const calls = []; const events = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 2) { assert.deepEqual(body.input.slice(1, 3), output); assert.deepEqual(body.input.at(-1), { type: 'function_call_output', call_id: 'call-diag', output: 'SYNTHETIC_DIAGNOSTIC_OK' }); }
    return new Response(JSON.stringify({ status: 'completed', output: calls.length === 1 ? output : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_DIAGNOSTIC_OK' }] }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const service = createModelDiagnosticService({ resolveCredential: () => 'synthetic-credential', onEvent: (_, event) => events.push(event) });
  const done = await service.wait(service.start({ binding, sender: base.sender, checks: ['nativeTools'] }).diagnosticId);
  assert.equal(done.state, 'passed'); assert.equal(calls.length, 2); assertNoPrivate([events, done]); await service.close();
});

// All inputs, model identities, credentials and fetch responses above are synthetic.
// No userData, vault, environment secrets, real tools or real network are read.
