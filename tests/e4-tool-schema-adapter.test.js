'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn } = require('../src/ai/model-router');
const { makeBinding, mockFetch, jsonResponse, tools, messages, credential, chat } = require('./fixtures/e4-models/synthetic');

const responses = (argumentsJson) => ({ status: 'completed', output: [{ type: 'function_call', id: 'item_schema', call_id: 'call_schema', name: 'schema_tool', arguments: argumentsJson, status: 'completed' }] });
const anthropic = (argumentsJson) => ({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_schema', name: 'schema_tool', input: JSON.parse(argumentsJson) }] });
const chatReply = (argumentsJson) => chat('', { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'call_schema', function: { name: 'schema_tool', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] });
const replies = { 'openai-chat-completions': chatReply, 'openai-responses': responses, 'anthropic-messages': anthropic };
const call = (protocol, parameters, argumentsJson, request = {}) => invokeModelTurn({ binding: makeBinding(protocol), messages, tools: [{ name: 'schema_tool', parameters }], request, resolveCredential: credential, fetchFn: mockFetch(jsonResponse(replies[protocol](argumentsJson))) });

for (const protocol of Object.keys(replies)) {
  test(`${protocol} object const/enum equality is independent of JSON key order`, async () => {
    for (const constraint of [{ const: { a: 1, b: 2 } }, { enum: [{ a: 1, b: 2 }] }]) {
      const parameters = { type: 'object', properties: { value: { type: 'object', ...constraint } }, required: ['value'], additionalProperties: false };
      const turn = await call(protocol, parameters, '{"value":{"b":2,"a":1}}');
      assert.equal(turn.toolCalls.length, 1);
    }
  });

  test(`${protocol} uniqueItems cannot be bypassed by reordering object keys`, async () => {
    const parameters = { type: 'object', properties: { values: { type: 'array', uniqueItems: true, items: { type: 'object' } } }, required: ['values'], additionalProperties: false };
    await assert.rejects(call(protocol, parameters, '{"values":[{"a":1,"b":2},{"b":2,"a":1}]}'), { code: 'MODEL_TOOL_INVALID' });
  });

  test(`${protocol} non-streaming tool argument limits report the byte ceiling`, async () => {
    await assert.rejects(call(protocol, { type: 'object' }, '{"text":"' + 'x'.repeat(40) + '"}', { maxArgumentsBytes: 32 }), { code: 'MODEL_LIMIT_EXCEEDED' });
    await assert.rejects(call(protocol, { type: 'object' }, '{"text":"' + '🙂'.repeat(10) + '"}', { maxArgumentsBytes: 32 }), { code: 'MODEL_LIMIT_EXCEEDED' });
  });
}

test('Model history tool arguments enforce byte limits and complete JSON before fetch', async () => {
  for (const argumentsJson of ['{"text":', '{"text":"' + '🙂'.repeat(17000) + '"}']) {
    for (const protocol of Object.keys(replies)) {
      const fetchFn = mockFetch(jsonResponse(replies[protocol]('{"text":"ok"}')));
      await assert.rejects(invokeModelTurn({ binding: makeBinding(protocol), messages: [...messages, { role: 'assistant', content: '', toolCalls: [{ id: 'history_call', name: 'synthetic_echo', argumentsJson }] }, { role: 'tool', toolCallId: 'history_call', content: 'receipt' }], tools, fetchFn, resolveCredential: credential }), (error) => ['MODEL_INPUT_INVALID', 'MODEL_LIMIT_EXCEEDED'].includes(error.code));
      assert.equal(fetchFn.calls.length, 0);
    }
  }
});
