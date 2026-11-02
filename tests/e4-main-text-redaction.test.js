'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMainFixture, syntheticRegistry } = require('./helpers/e4-main-fixture');
const { defaultSecretManager, redactSecrets } = require('../src/ai/secret-manager');
const fake = 'e4-main-fragment-not-a-real-credential-13579';
defaultSecretManager.registerSecret(fake, 'E4_MAIN_FRAGMENT');
function registry() {
  const value = syntheticRegistry();
  value.models[0].compatibility.streamMode = 'on';
  value.models[0].capabilities.streaming = { state: 'supported', source: 'declared' };
  return value;
}
function frame(content, finish) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason: finish || null }] })}\n\n`;
}
function published(f) { return f.events.filter((entry) => entry.channel === 'chat:event' && entry.event.type === 'text-delta').map((entry) => entry.event.text || '').join(''); }

test('actual main IPC never reconstructs a credential reflected across separate model SSE fragments', async (t) => {
  const text = [fake.slice(0, 11), fake.slice(11, 27), fake.slice(27)].map((part) => frame(part)).join('') + frame(null, 'stop') + 'data: [DONE]\n\n';
  const f = loadMainFixture(t, { registry: registry(), fetchFn: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }) });
  const final = await f.invoke('chat:send', f.payload());
  assert.equal(final.ok, true); assert.equal(final.accepted, true);
  assert.equal(published(f).includes(fake), false);
  assert.equal(published(f), redactSecrets(fake));
  assert.equal(final.content.includes(fake), false);
  assert.equal(f.requests.length, 1);
});

test('actual main error and cancellation do not publish a withheld credential prefix or its partialOutput', async (t) => {
  for (const cancelled of [false, true]) await t.test(cancelled ? 'owned cancellation' : 'incomplete EOF', async (t) => {
    let entered; const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const prefix = fake.slice(0, -1);
    const f = loadMainFixture(t, { registry: registry(), fetchFn: async () => {
      if (!cancelled) return new Response(frame(prefix), { headers: { 'content-type': 'text/event-stream' } });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(frame(prefix))); },
        pull() { entered(); return new Promise(() => {}); }, cancel() {},
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    let final;
    if (cancelled) {
      const accepted = await f.accept('chat:send', f.payload());
      await enteredPromise;
      const stop = await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId });
      assert.equal(stop.ok, true);
      final = await f.settle(accepted);
      assert.equal(final.aborted, true);
    } else final = await f.invoke('chat:send', f.payload());
    assert.equal(final.ok, false); assert.equal(final.accepted, true);
    assert.equal(published(f).includes(prefix), false);
    assert.equal(String(final.partialOutput || '').includes(prefix), false);
    for (const event of f.events) assert.equal(JSON.stringify(event.event).includes(prefix), false);
    assert.equal(f.inspect('foregroundModels.current'), null);
    assert.equal(f.requests.length, 1);
  });
});
