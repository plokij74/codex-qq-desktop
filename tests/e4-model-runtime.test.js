'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createForegroundRuntime, publicModelSource } = require('../src/ai/model-runtime');
const input = (extra = {}) => ({ senderId: 1, sessionId: 'session_a', clientRequestId: 'client_a', kind: 'chat', ...extra });

test('one foreground lease covers chat, compact and diagnosis without replacing prior work', () => {
  const runtime = createForegroundRuntime(); const first = runtime.acquire(input());
  for (const kind of ['chat', 'compact', 'diagnostic']) assert.throws(() => runtime.acquire(input({ kind })), { code: 'BUSY' });
  assert.equal(runtime.current, first); assert.equal(first.abort.signal.aborted, false);
});
test('cancel requires exact sender, session and run or client request identifier', () => {
  const runtime = createForegroundRuntime(); const lease = runtime.acquire(input());
  for (const target of [input({ senderId: 2 }), input({ sessionId: 'session_b' }), { senderId: 1, sessionId: 'session_a' }, input({ clientRequestId: 'stale' }), input({ runId: 'stale' })]) {
    assert.equal(runtime.cancel(target).ok, false); assert.equal(lease.abort.signal.aborted, false);
  }
  assert.deepEqual(runtime.cancel({ senderId: 1, sessionId: 'session_a', runId: lease.runId }), { ok: true, runId: lease.runId });
  assert.equal(lease.abort.signal.aborted, true);
});
test('cancellation retains the lease until async cleanup explicitly finishes', async () => {
  const runtime = createForegroundRuntime(); const lease = runtime.acquire(input());
  runtime.cancel(input()); await Promise.resolve();
  assert.equal(runtime.current, lease); assert.throws(() => runtime.acquire(input()), { code: 'BUSY' });
  assert.equal(runtime.release(lease), true); assert.equal(runtime.current, null);
  const next = runtime.acquire(input({ clientRequestId: 'client_b' }));
  assert.equal(runtime.release(lease), false); assert.equal(runtime.current, next);
});
test('owner destruction is internal targeted cancellation, not an unrestricted public stop', () => {
  const runtime = createForegroundRuntime(); const lease = runtime.acquire(input());
  assert.equal(runtime.cancelOwner(2), false); assert.equal(lease.abort.signal.aborted, false);
  assert.equal(runtime.cancelOwner(1), true); assert.equal(runtime.current, lease);
});
test('public model source is a whitelist and never transports auth, prompts or endpoint query', () => {
  const source = publicModelSource({ providerId: 'p', providerName: 'Provider', modelProfileId: 'm', modelProfileName: 'Model', model: 'model-name', protocol: 'openai-responses', baseUrl: 'https://endpoint.invalid/v1?tenant=synthetic', assistantId: 'assistant_general', assistantName: 'General', bindingRevision: 'wire', auth: { secretRef: 'private' }, systemPrompt: 'private prompt', request: { temperature: 0.4 } }, { kind: 'chat', runId: 'r', clientRequestId: 'c' });
  assert.equal(source.model, 'model-name'); assert.equal(source.endpoint, 'https://endpoint.invalid/v1');
  assert.equal(source.runId, 'r'); assert.equal(source.clientRequestId, 'c'); assert.equal(source.kind, 'api');
  assert.ok(!JSON.stringify(source).includes('private')); assert.ok(!JSON.stringify(source).includes('tenant'));
  assert.ok(Object.isFrozen(source));
});
test('invalid acquisition never reserves the runtime and duplicate IDs are not generated for rejected work', () => {
  let ids = 0; const runtime = createForegroundRuntime({ newRunId: () => `run_${++ids}` });
  for (const value of [input({ senderId: 0 }), input({ sessionId: '' }), input({ clientRequestId: '' })]) assert.throws(() => runtime.acquire(value), { code: 'INVALID_RUN_TARGET' });
  assert.equal(ids, 0); assert.equal(runtime.current, null);
  const lease = runtime.acquire(input()); assert.equal(lease.runId, 'run_1');
  assert.throws(() => runtime.acquire(input()), { code: 'BUSY' }); assert.equal(ids, 1);
});
