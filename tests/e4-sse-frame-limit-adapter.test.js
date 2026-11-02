'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn } = require('../src/ai/model-router');
const { makeBinding, streamResponse, sse, mockFetch, messages, credential } = require('./fixtures/e4-models/synthetic');
const text = 'synthetic frame text '.repeat(16);
function events(protocol) {
  if (protocol === 'openai-chat-completions') return [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }, '[DONE]',
  ];
  if (protocol === 'openai-responses') return [{ type: 'response.completed', response: { status: 'completed', output: [{ id: 'synthetic-frame-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3 } } }];
  return [
    { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 9 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}
for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  const items = events(protocol); const frames = sse(items);
  // Exactly the bytes frame(value) measures, excluding the final blank delimiter.
  const frameLimit = Math.max(...items.map(item => Buffer.byteLength(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n`, 'utf8')));
  test(`${protocol}: an exact-limit CRLF frame is independent of byte splitting`, async () => {
    for (const chunkSize of [frames.length, 1, 7]) {
      const binding = makeBinding(protocol, { compatibility: { streamMode: 'on' } });
      const fetchFn = mockFetch(streamResponse(frames, chunkSize)); const deltas = [];
      const turn = await invokeModelTurn({ binding, messages, fetchFn, resolveCredential: credential, request: { maxFrameBytes: frameLimit },
        onEvent: event => deltas.push(event.delta) });
      assert.equal(turn.content, text); assert.equal(deltas.join(''), text);
      assert.equal(turn.finishReason, 'stop'); assert.deepEqual(turn.toolCalls, []); assert.equal(fetchFn.calls.length, 1);
    }
  });
  test(`${protocol}: one real frame byte above the limit still fails without retry`, async () => {
    for (const chunkSize of [frames.length, 1]) {
      const binding = makeBinding(protocol, { compatibility: { streamMode: 'on' } });
      const fetchFn = mockFetch(streamResponse(frames, chunkSize));
      await assert.rejects(invokeModelTurn({ binding, messages, fetchFn, resolveCredential: credential, request: { maxFrameBytes: frameLimit - 1 } }),
        error => error.code === 'MODEL_LIMIT_EXCEEDED' && error.usage.source === 'unavailable');
      assert.equal(fetchFn.calls.length, 1);
    }
  });
}
