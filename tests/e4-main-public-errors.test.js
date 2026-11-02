'use strict';

// Production main/preload contracts, isolated fixture state and mocked transport only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
const { loadMainFixture, syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');

const terminals = new Set([AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED]);
const privateMarker = 'FIXTURE_PRIVATE_UPSTREAM_BODY_NEVER_PUBLIC';
function assertSafeError(value) {
  assert.equal(typeof value.safeMessage, 'string');
  assert.ok(value.safeMessage.length > 0);
  assert.equal(typeof value.retryable, 'boolean');
  assert.equal(value.message, value.safeMessage);
  const text = JSON.stringify(value);
  for (const forbidden of [privateMarker, 'rawProviderState', 'secretRef', 'credentialOrigin', 'stack', 'cause']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
}
function assertAcceptedIdentity(f, final) {
  const start = f.events.find(item => item.channel === 'chat:event' && item.event.type === 'run-start').event;
  const terminal = f.events.filter(item => item.channel === 'chat:event' && terminals.has(item.event.type));
  assert.equal(terminal.length, 1);
  for (const value of [terminal[0].event, final]) {
    assert.equal(value.runId, start.runId);
    assert.equal(value.sessionId, start.sessionId);
    assert.equal(value.clientRequestId, start.clientRequestId);
    assert.deepEqual(value.modelSource, start.modelSource);
    assert.equal(value.modelSource.kind, 'api');
    assertSafeError(value);
  }
  assert.equal(f.inspect('foregroundModels.current'), null);
}

for (const [status, code] of [[400, 'MODEL_PROTOCOL'], [401, 'MODEL_AUTH_FAILED'], [403, 'MODEL_PERMISSION_DENIED'],
  [404, 'MODEL_NOT_FOUND'], [429, 'MODEL_RATE_LIMIT'], [500, 'MODEL_NETWORK']]) {
  test(`actual main HTTP ${status} returns canonical safe errors without retry or fallback`, async t => {
    const requestId = `req_public_main_${status}`;
    const f = loadMainFixture(t, { fetchFn: async () => new Response(JSON.stringify({
      error: { message: privateMarker, apiKey: privateMarker, rawProviderState: privateMarker },
    }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'retry-after': '3' } }) });
    const final = await f.invoke('chat:send', f.payload());
    assert.equal(final.ok, false); assert.equal(final.accepted, true); assert.equal(final.code, code);
    assert.equal(final.httpStatus, status); assert.equal(final.requestId, requestId); assert.equal(final.retryAfterMs, 3000);
    assert.equal(final.retryable, status === 429 || status === 500);
    assert.equal(final.error, final.safeMessage);
    assertAcceptedIdentity(f, final);
    assert.equal(f.requests.length, 1); assert.equal(f.credentialReads.length, 0);
    const usage = readRecords(usageFilePath(f.root)).records;
    assert.equal(usage.length, 1); assert.equal(usage[0].status, 'failed');
    assert.equal(usage[0].in, null); assert.equal(usage[0].out, null);
    assert.equal(usage[0].kind, 'chat');
  });
}

test('actual main missing credential is canonical and rejected before any paid attempt', async t => {
  const f = loadMainFixture(t, { registry: syntheticRegistry({ authKind: 'bearer' }) });
  const final = await f.invoke('chat:send', f.payload());
  assert.equal(final.ok, false); assert.equal(final.accepted, undefined);
  assert.equal(final.code, 'MODEL_CREDENTIAL_UNAVAILABLE'); assert.equal(final.retryable, false);
  assertSafeError(final);
  assert.equal(f.requests.length, 0); assert.equal(f.credentialReads.length, 0);
  assert.equal(f.events.length, 0); assert.equal(f.inspect('foregroundModels.current'), null);
});

test('actual main owned cancellation is canonical and BUSY keeps the accepted run alive', async t => {
  const entered = deferred();
  const f = loadMainFixture(t, { fetchFn: async (_url, options) => {
    entered.resolve();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error(privateMarker), { name: 'AbortError' }));
    }, { once: true }));
  } });
  const accepted = await f.accept('chat:send', f.payload());
  await entered.promise;
  const busy = await f.invoke('chat:send', f.payload({ clientRequestId: 'public-busy-rejected' }));
  assert.equal(busy.ok, false); assert.equal(busy.code, 'BUSY'); assert.equal(busy.retryable, false);
  assertSafeError(busy);
  assert.equal(f.inspect('foregroundModels.current.abort.signal.aborted'), false);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId })).ok, true);
  const final = await f.settle(accepted);
  assert.equal(final.ok, false); assert.equal(final.aborted, true); assert.equal(final.code, 'MODEL_CANCELLED');
  assert.equal(final.retryable, false); assertAcceptedIdentity(f, final);
  const usage = readRecords(usageFilePath(f.root)).records;
  assert.equal(usage.length, 1); assert.equal(usage[0].status, 'cancelled');
  assert.equal(usage[0].in, null); assert.equal(usage[0].out, null);
});
