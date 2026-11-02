'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, resolveModelBinding, updateModelRegistry } = require('../src/ai/model-profiles');
const { createModelDiagnosticService, DIAGNOSTIC_SYNTHETIC_TEXT } = require('../src/ai/model-diagnostics');
const { ModelError } = require('../src/ai/model-adapters/common');
const { defaultSecretManager } = require('../src/ai/secret-manager');

// Credentials, private-looking values and fetch responses are in-memory fixtures.
const credential = 'qx-diagnostic-error-fixture-only-9382716450';
const privateOutput = 'PRIVATE_UPSTREAM_OUTPUT_FIXTURE_1';
const privateBody = 'PRIVATE_ERROR_BODY_FIXTURE_1';
const privateState = 'PRIVATE_PROVIDER_STATE_FIXTURE_1';
defaultSecretManager.registerSecret(credential, 'E4_DIAGNOSTIC_PUBLIC_ERROR_TEST');
let sequence = 0;
function fixture(protocol = 'openai-chat-completions') {
  const id = ++sequence;
  let registry = createModelRegistry({ baseUrl: 'https://diagnostic-fixture.example/gateway/v1', model: 'diagnostic-fixture-model', secretRef: 'diagnostic-fixture-ref', apiKeyConfigured: true });
  if (protocol !== 'openai-chat-completions') registry = updateModelRegistry(registry, draft => { draft.providers[0].protocol = protocol; draft.providers[0].auth.kind = protocol === 'anthropic-messages' ? 'api-key' : 'bearer'; });
  const sender = { id: 73 };
  const binding = resolveModelBinding({ registry, senderId: sender.id, sessionId: `diagnostic_fixture_session_${id}`, runId: `diagnostic_fixture_run_${id}`, clientRequestId: `diagnostic_fixture_request_${id}`, kind: 'model-diagnostic', assistantId: 'assistant_general' });
  return { registry, binding, sender };
}
function actual(inputTokens = 11, outputTokens = 0, extra = {}) {
  return { inputTokens, outputTokens, cachedInputTokens: null, cacheCreationInputTokens: null, source: 'actual', ...extra };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function tick() { return new Promise(resolve => setImmediate(resolve)); }
function collectService(t, extra = {}) {
  const events = []; const usages = []; const applied = [];
  const service = createModelDiagnosticService({ onEvent: (_, event) => events.push(event), onUsage: item => usages.push(item), applyResult: result => applied.push(result), resolveCredential: () => credential, ...extra });
  t.after(() => service.close());
  return { service, events, usages, applied };
}
async function diagnose(service, input, checks = ['text']) {
  const ack = service.start({ binding: input.binding, sender: input.sender, checks });
  return { ack, done: await service.wait(ack.diagnosticId) };
}
function assertPrivateAbsent(value) {
  const json = JSON.stringify(value);
  for (const forbidden of [credential, 'diagnostic-fixture-ref', privateOutput, privateBody, privateState, 'partialOutput', 'argumentsJson', 'providerState', 'secretRef', 'legacyCode', 'publicError']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
}
function assertErrorFields(entry, expectedCode, retryable) {
  const allowed = new Set(['state', 'capability', 'checkedAt', 'code', 'safeMessage', 'retryable', 'httpStatus', 'requestId', 'retryAfterMs']);
  assert.ok(Object.keys(entry).every(key => allowed.has(key)), Object.keys(entry).join(','));
  assert.equal(entry.code, expectedCode); assert.equal(entry.retryable, retryable);
  assert.equal(typeof entry.safeMessage, 'string'); assert.ok(entry.safeMessage.length > 0);
  assert.equal(entry.capability, 'unknown');
  assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
}
function assertUnavailable(attempt) {
  assert.equal(attempt.usage.source, 'unavailable');
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens']) assert.equal(attempt.usage[key], null);
}
function emptyBody(protocol, input = 11, output = 0) {
  if (protocol === 'openai-responses') return { status: 'completed', output: [], usage: { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: 3 } } };
  if (protocol === 'anthropic-messages') return { type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: input - 5, output_tokens: output, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } };
  return { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: input === 0 ? 0 : 3 } } };
}

for (const [status, code, retryable] of [[403, 'MODEL_PERMISSION_DENIED', false], [429, 'MODEL_RATE_LIMIT', true]]) {
  test(`default router HTTP ${status} check exposes canonical bounded error metadata without reading the body`, async t => {
    const input = fixture(); let fetches = 0; let bodyReads = 0; let cleaned = 0;
    const headers = new Map([['x-request-id', `request_fixture_${status}`], ['retry-after', '4'], ['authorization', credential], ['set-cookie', privateState]]);
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      fetches++; assert.equal(options.redirect, 'error'); assert.equal(JSON.parse(options.body).stream, false);
      return { status, headers: { get: name => headers.get(name) || null }, body: { cancel: async () => { cleaned++; } }, text: async () => { bodyReads++; return JSON.stringify({ error: { type: 'capability_unsupported', message: privateBody }, usage: { prompt_tokens: 900, completion_tokens: 500 } }); } };
    });
    const { service, events, usages, applied } = collectService(t);
    const ack = service.start({ binding: input.binding, sender: input.sender, checks: ['text'] });
    assert.equal(fetches, 0); assert.equal(events.length, 0);
    const done = await service.wait(ack.diagnosticId);
    assert.equal(fetches, 1); assert.equal(bodyReads, 0); assert.equal(cleaned, 1);
    assert.equal(done.state, 'failed'); assert.equal(applied.length, 0); assert.equal(usages.length, 1);
    const check = done.checks.text; assertErrorFields(check, code, retryable);
    assert.equal(check.httpStatus, status); assert.equal(check.requestId, `request_fixture_${status}`); assert.equal(check.retryAfterMs, 4000);
    const finalCheck = events.filter(event => event.type === 'check').at(-1).checks.text;
    assert.deepEqual(finalCheck, check); assertUnavailable(usages[0].attempt);
    assertPrivateAbsent([ack, done, events, usages.map(item => item.attempt)]);
  });
}

test('diagnostic projection has a second whitelist excluding output, tool arguments, sources and private error objects', async t => {
  const input = fixture();
  const error = new ModelError('MODEL_RATE_LIMITED', 'The fixture provider returned HTTP 429.', { status: 429, requestId: 'request_fixture_1', retryAfter: 5, attemptId: 'attempt_fixture_1', usage: actual() });
  Object.assign(error, { partialOutput: privateOutput, content: privateOutput, toolCalls: [{ argumentsJson: privateBody }], providerState: privateState, body: privateBody, cause: new Error(privateBody), modelSource: { kind: 'api', providerName: privateState, secretRef: 'diagnostic-fixture-ref' } });
  error.toJSON = () => assert.fail('Never serialize the error');
  const { service, events, usages } = collectService(t, { invoke: async () => { throw error; } });
  const { done } = await diagnose(service, input);
  assert.equal(error.code, 'MODEL_RATE_LIMITED'); assertErrorFields(done.checks.text, 'MODEL_RATE_LIMIT', true);
  assert.equal(done.checks.text.httpStatus, 429); assert.equal(done.checks.text.retryAfterMs, 5000);
  assert.equal(done.checks.text.requestId, 'request_fixture_1'); assert.equal(usages.length, 1); assertUnavailable(usages[0].attempt);
  assertPrivateAbsent([done, events, usages.map(item => item.attempt)]);
});

test('diagnostic safe messages use the existing complete-secret and prefix withholding redactor', async t => {
  const input = fixture(); const prefix = credential.slice(0, 19);
  const error = new ModelError('MODEL_AUTH_FAILED', `Controlled fixture reason: ${credential}; trailing ${prefix}`, { status: 401, requestId: prefix });
  const { service, events } = collectService(t, { invoke: async () => { throw error; } });
  const { done } = await diagnose(service, input);
  assertErrorFields(done.checks.text, 'MODEL_AUTH_FAILED', false);
  assert.equal(done.checks.text.requestId, undefined);
  assert.equal(JSON.stringify([done, events]).includes(prefix), false); assertPrivateAbsent([done, events]);
});

test('ordinary errors never forward raw or forged safe messages, even for known model or business codes', async t => {
  for (const [rawCode, expected] of [['MODEL_FORBIDDEN', 'MODEL_PERMISSION_DENIED'], ['MODEL_EMPTY_RESPONSE', 'MODEL_EMPTY_RESPONSE'], ['DIAGNOSTIC_REQUEST_FAILED', 'DIAGNOSTIC_REQUEST_FAILED'], [undefined, 'DIAGNOSTIC_REQUEST_FAILED']]) {
    const input = fixture(); const error = Object.assign(new Error(privateBody), { safeMessage: privateBody, name: 'ModelError', usage: actual(), attemptId: `plain_fixture_${sequence}`, ...(rawCode ? { code: rawCode } : {}) });
    const { service, events, usages } = collectService(t, { invoke: async () => { throw error; } });
    const { done } = await diagnose(service, input);
    assertErrorFields(done.checks.text, expected, false); assertUnavailable(usages[0].attempt);
    assertPrivateAbsent([done, events, usages.map(item => item.attempt)]);
  }
});

test('host diagnostic stop errors preserve a fixed business reason without message-derived classification', async t => {
  const input = fixture(); let invoked = 0;
  const error = Object.assign(new Error(privateBody), { code: 'DIAGNOSTIC_TIMEOUT', safeMessage: privateBody, attemptId: 'diagnostic_timeout_fixture_1' });
  const { service, events, usages, applied } = collectService(t, { invoke: async () => { invoked++; throw error; } });
  const { done } = await diagnose(service, input, ['text', 'usage']);
  assert.equal(invoked, 1); assert.equal(done.code, 'DIAGNOSTIC_TIMEOUT'); assert.equal(done.retryable, false);
  assert.equal(typeof done.safeMessage, 'string'); assert.equal(done.task.error, 'DIAGNOSTIC_TIMEOUT');
  assertErrorFields(done.checks.text, 'DIAGNOSTIC_TIMEOUT', false); assert.equal(done.checks.usage.state, 'not-tested');
  assert.equal(applied.length, 0); assertUnavailable(usages[0].attempt); assertPrivateAbsent([done, events]);
});

test('capability codes use explicit host state while diagnostic evidence stays unknown', async t => {
  for (const [state, expected] of [['unknown', 'MODEL_CAPABILITY_UNKNOWN'], ['unsupported', 'MODEL_CAPABILITY_UNSUPPORTED']]) {
    const input = fixture();
    const error = new ModelError('MODEL_CAPABILITY_REQUIRED', 'The fixture message says unsupported, which is not diagnostic evidence.', { capabilityState: state, publicCode: expected });
    const { service, applied } = collectService(t, { invoke: async () => { throw error; } });
    const { done } = await diagnose(service, input);
    assert.equal(error.code, 'MODEL_CAPABILITY_REQUIRED'); assertErrorFields(done.checks.text, expected, false);
    assert.equal(applied.length, 0); assert.equal(done.checks.text.capability, 'unknown');
  }
});

test('internal limit alias still stops remaining checks while snapshots and task errors are canonical', async t => {
  const input = fixture(); let invoked = 0;
  const error = new ModelError('MODEL_LIMIT_EXCEEDED', 'The diagnostic fixture reached its bounded limit.', { attemptId: 'limit_attempt_fixture_1', status: 503, requestId: 'limit_request_fixture_1', retryAfter: 2, usage: actual() });
  const { service, usages, applied } = collectService(t, { invoke: async () => { invoked++; throw error; } });
  const { done } = await diagnose(service, input, ['text', 'usage']);
  assert.equal(error.code, 'MODEL_LIMIT_EXCEEDED'); assert.equal(invoked, 1); assert.equal(done.code, 'MODEL_LIMIT');
  assert.equal(done.task.error, 'MODEL_LIMIT'); assert.equal(done.httpStatus, 503); assert.equal(done.requestId, 'limit_request_fixture_1'); assert.equal(done.retryAfterMs, 2000);
  assertErrorFields(done.checks.text, 'MODEL_LIMIT', false); assert.equal(done.checks.usage.state, 'not-tested');
  assert.equal(applied.length, 0); assertUnavailable(usages[0].attempt);
});

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  test(`default ${protocol} complete empty terminal retains validated actual usage but proves no capability`, async t => {
    const input = fixture(protocol); let fetches = 0;
    t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response(JSON.stringify(emptyBody(protocol)), { status: 200, headers: { 'content-type': 'application/json' } }); });
    const { service, events, usages, applied } = collectService(t);
    const { done } = await diagnose(service, input);
    assert.equal(fetches, 1); assert.equal(done.state, 'failed'); assert.equal(done.checks.text.state, 'failed');
    assertErrorFields(done.checks.text, 'MODEL_EMPTY_RESPONSE', false); assert.equal(applied.length, 0); assert.equal(usages.length, 1);
    const attempt = usages[0].attempt; assert.equal(attempt.status, 'failed'); assert.equal(attempt.finishReason, null);
    assert.equal(attempt.usage.source, 'actual'); assert.equal(attempt.usage.inputTokens, 11); assert.equal(attempt.usage.outputTokens, 0);
    assert.equal(attempt.usage.cachedInputTokens, protocol === 'anthropic-messages' ? 2 : 3);
    assert.equal(attempt.usage.cacheCreationInputTokens, protocol === 'anthropic-messages' ? 3 : null);
    assertPrivateAbsent([done, events, attempt]);
  });
}

test('a complete empty terminal can retain actual zero without manufacturing usage support', async t => {
  const input = fixture();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(emptyBody(input.binding.protocol, 0, 0)), { status: 200, headers: { 'content-type': 'application/json' } }));
  const { service, usages, applied } = collectService(t);
  const { done } = await diagnose(service, input, ['usage']);
  assertErrorFields(done.checks.usage, 'MODEL_EMPTY_RESPONSE', false);
  assert.equal(usages[0].attempt.usage.source, 'actual'); assert.equal(usages[0].attempt.usage.inputTokens, 0); assert.equal(usages[0].attempt.usage.outputTokens, 0); assert.equal(applied.length, 0);
});

test('failed actual is rejected for wrong error type, wrong category and malformed or estimated counts', async t => {
  const cases = [
    Object.assign(new Error(privateBody), { code: 'MODEL_HTTP_ERROR', status: 400, usage: actual() }),
    Object.assign(new Error(privateBody), { code: 'MODEL_EMPTY_RESPONSE', name: 'ModelError', usage: actual() }),
    new ModelError('MODEL_PROTOCOL_ERROR', 'A fixed fixture protocol reason.', { usage: actual() }),
    new ModelError('MODEL_EMPTY_RESPONSE', 'A fixed fixture empty reason.', { usage: actual(-1, 0) }),
    new ModelError('MODEL_EMPTY_RESPONSE', 'A fixed fixture empty reason.', { usage: actual(11, 0, { source: 'estimated' }) }),
    new ModelError('MODEL_EMPTY_RESPONSE', 'A fixed fixture empty reason.', { usage: actual('11', 0) }),
    new ModelError('MODEL_EMPTY_RESPONSE', 'A fixed fixture empty reason.', { usage: actual(11, 0, { cachedInputTokens: 12 }) }),
  ];
  for (const error of cases) {
    error.attemptId = `bad_actual_fixture_${++sequence}`;
    const { service, usages } = collectService(t, { invoke: async () => { throw error; } });
    const { done } = await diagnose(service, fixture());
    assert.equal(done.state, 'failed'); assert.equal(usages.length, 1); assertUnavailable(usages[0].attempt);
  }
});

test('a fake HTTP body or malformed terminal cannot turn error-body usage into actual diagnostic usage', async t => {
  const bodies = [
    { error: { type: 'MODEL_EMPTY_RESPONSE', message: privateBody, usage: { prompt_tokens: 999, completion_tokens: 888 } }, choices: [], usage: { prompt_tokens: 999, completion_tokens: 888 } },
    { choices: [], usage: { prompt_tokens: 999, completion_tokens: 888 } },
  ];
  for (const body of bodies) {
    const input = fixture();
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { service, events, usages } = collectService(t); const { done } = await diagnose(service, input);
    assertErrorFields(done.checks.text, 'MODEL_PROTOCOL', false); assertUnavailable(usages[0].attempt);
    assertPrivateAbsent([done, events]);
  }
});

test('an otherwise valid empty terminal with missing or invalid counters remains unavailable', async t => {
  for (const rawUsage of [{ prompt_tokens: '11', completion_tokens: 0 }, { prompt_tokens: 11, completion_tokens: -1 }, { prompt_tokens: 11 }]) {
    const input = fixture(); const body = emptyBody(input.binding.protocol); body.usage = rawUsage;
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { service, usages } = collectService(t); const { done } = await diagnose(service, input);
    assertErrorFields(done.checks.text, 'MODEL_EMPTY_RESPONSE', false); assertUnavailable(usages[0].attempt);
  }
});

test('default empty-terminal cancellation during cleanup keeps the lease and cannot regain actual usage', async t => {
  const input = fixture(); const cleanupEntered = deferred(); const cleanup = deferred(); let reads = 0; let fetches = 0; let unlocked = 0; let released = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(emptyBody(input.binding.protocol)));
  const reader = { read: async () => reads++ === 0 ? { done: false, value: bytes } : { done: true }, cancel: async () => { cleanupEntered.resolve(); await cleanup.promise; }, releaseLock: () => { unlocked++; } };
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return { status: 200, headers: { get: () => null }, body: { getReader: () => reader } }; });
  const { service, events, usages, applied } = collectService(t, { onRelease: () => { released++; assert.equal(unlocked, 1); } });
  const ack = service.start({ binding: input.binding, sender: input.sender, checks: ['text'] });
  await cleanupEntered.promise;
  assert.equal(service.cancel({ senderId: input.sender.id, diagnosticId: ack.diagnosticId }).ok, true);
  assert.equal(service.isInUse({ modelProfileId: input.binding.modelProfileId }), true); assert.equal(released, 0);
  cleanup.resolve(); const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.code, 'MODEL_CANCELLED'); assert.equal(done.retryable, false);
  assert.equal(fetches, 1); assert.equal(released, 1); assert.equal(unlocked, 1); assert.equal(applied.length, 0); assert.equal(usages.length, 1);
  assert.equal(usages[0].attempt.status, 'cancelled'); assertUnavailable(usages[0].attempt);
  assertErrorFields(done.checks.text, 'MODEL_CANCELLED', false); assertPrivateAbsent([done, events]);
});

test('close keeps late trusted empty actual failures cancelled and unavailable', async t => {
  const input = fixture(); const entered = deferred(); const cleanup = deferred(); let closed = false;
  const error = new ModelError('MODEL_EMPTY_RESPONSE', 'A controlled late fixture empty reason.', { attemptId: 'late_empty_attempt_fixture_1', usage: actual() });
  const { service, usages, applied } = collectService(t, { invoke: async () => { entered.resolve(); await cleanup.promise; throw error; } });
  const ack = service.start({ binding: input.binding, sender: input.sender, checks: ['text'] }); await entered.promise;
  const closing = service.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(service.isInUse({ modelProfileId: input.binding.modelProfileId }), true);
  cleanup.resolve(); await closing; const done = await service.wait(ack.diagnosticId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.code, 'MODEL_CANCELLED'); assert.equal(error.code, 'MODEL_EMPTY_RESPONSE');
  assertUnavailable(usages[0].attempt); assert.equal(usages[0].attempt.status, 'cancelled'); assert.equal(applied.length, 0);
});

test('stale public check copies keep unknown capability and fixed safe stale reason without mutating evidence', async t => {
  const input = fixture();
  const { service } = collectService(t, { invoke: async () => ({ attemptId: 'stale_attempt_fixture_1', content: DIAGNOSTIC_SYNTHETIC_TEXT, finishReason: 'stop', toolCalls: [], usage: actual(11, 1) }) });
  const { done } = await diagnose(service, input);
  const stale = service.getState(input.binding.modelProfileId, 'different_fixture_revision_1');
  assert.equal(done.state, 'passed'); assert.equal(stale.state, 'stale'); assert.equal(stale.code, 'DIAGNOSTIC_STALE');
  assertErrorFields(stale.checks.text, 'DIAGNOSTIC_STALE', false); assert.equal(stale.checks.text.state, 'unknown'); assert.equal(stale.checks.text.checkedAt, done.checks.text.checkedAt);
  assert.equal(service.getState(input.binding.modelProfileId, input.binding.bindingRevision).checks.text.capability, 'supported');
});
