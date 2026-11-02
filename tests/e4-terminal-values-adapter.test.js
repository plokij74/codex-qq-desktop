'use strict';
// Synthetic malformed terminals only: no endpoint, environment, userData or vault access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn } = require('../src/ai/model-router');
const { makeBinding, jsonResponse, streamResponse, sse, mockFetch, messages, credential } = require('./fixtures/e4-models/synthetic');

const content = 'Synthetic partial output.';
const protocols = ['openai-chat-completions', 'anthropic-messages'];

function responseFor(protocol, mode, reason, counters) {
  if (protocol === 'openai-chat-completions') {
    if (mode === 'JSON') return jsonResponse({ choices: [{ message: { role: 'assistant', content }, finish_reason: reason }] });
    return streamResponse(sse([
      { choices: [{ index: 0, delta: { role: 'assistant', content } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
      '[DONE]'
    ]) + ': Synthetic cleanup tail.\r\n\r\n', 3, counters);
  }
  if (mode === 'JSON') return jsonResponse({ type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: reason });
  return streamResponse(sse([
    { type: 'message_start', message: { type: 'message', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason } },
    { type: 'message_stop' }
  ]) + ': Synthetic cleanup tail.\r\n\r\n', 3, counters);
}

for (const protocol of protocols) {
  const validReason = protocol === 'openai-chat-completions' ? 'stop' : 'end_turn';
  const invalidReasons = [
    ['inherited constructor', 'constructor'],
    ['inherited toString', 'toString'],
    ['inherited __proto__', '__proto__'],
    ['array coercion to a recognized reason', [validReason]],
    ['object with unusable toString', { toString: null }]
  ];
  for (const mode of ['JSON', 'SSE']) {
    for (const [label, reason] of invalidReasons) {
      test(`${protocol} ${mode} rejects ${label} instead of publishing a successful non-enum terminal`, async () => {
        const counters = {}; const events = [];
        const response = responseFor(protocol, mode, reason, counters);
        const fetchFn = mockFetch(response);
        await assert.rejects(invokeModelTurn({
          binding: makeBinding(protocol, { compatibility: { streamMode: mode === 'SSE' ? 'on' : 'off' } }),
          messages, fetchFn, resolveCredential: credential, onEvent: event => events.push(event)
        }), error => {
          const expected = protocol === 'anthropic-messages' && mode === 'JSON' && typeof reason === 'string'
            ? 'MODEL_FEATURE_UNSUPPORTED' : 'MODEL_PROTOCOL_ERROR';
          assert.equal(error.code, expected);
          assert.equal(error.usage.source, 'unavailable');
          assert.equal(error.partialOutput || '', mode === 'SSE' ? content : '');
          return true;
        });
        assert.equal(fetchFn.calls.length, 1, 'Malformed terminals must not trigger a retry or protocol fallback.');
        assert.deepEqual(events.map(event => event.delta), mode === 'SSE' ? [content] : []);
        assert.equal(response.body.locked, false, 'The malformed response must release its reader.');
        if (mode === 'SSE') assert.equal(counters.cancel, 1, 'The malformed stream reader must be cancelled once.');
      });
    }

    test(`${protocol} ${mode} still normalizes its recognized string terminal`, async () => {
      const counters = {}; const response = responseFor(protocol, mode, validReason, counters);
      const fetchFn = mockFetch(response);
      const result = await invokeModelTurn({
        binding: makeBinding(protocol, { compatibility: { streamMode: mode === 'SSE' ? 'on' : 'off' } }),
        messages, fetchFn, resolveCredential: credential
      });
      assert.equal(result.finishReason, 'stop');
      assert.equal(result.content, content);
      assert.deepEqual(result.toolCalls, []);
      assert.equal(fetchFn.calls.length, 1);
      assert.equal(response.body.locked, false);
      if (mode === 'SSE') assert.equal(counters.cancel, 1);
    });
  }
}

test('Chat JSON null choice is a protocol failure, not a connection failure', async () => {
  const response = jsonResponse({ choices: [null] });
  const fetchFn = mockFetch(response); const events = [];
  await assert.rejects(invokeModelTurn({
    binding: makeBinding(), messages, fetchFn, resolveCredential: credential, onEvent: event => events.push(event)
  }), error => {
    assert.equal(error.code, 'MODEL_PROTOCOL_ERROR');
    assert.equal(error.usage.source, 'unavailable');
    assert.equal(error.partialOutput || '', '');
    return true;
  });
  assert.equal(fetchFn.calls.length, 1);
  assert.deepEqual(events, []);
  assert.equal(response.body.locked, false);
});
