'use strict';

// Injected memory-only protocol fixtures: never reach a model or credential store.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, resolveModelBinding, MODEL_PROTOCOLS } = require('../src/ai/model-profiles');
const { invokeModelTurn } = require('../src/ai/model-router');
const { createModelChatFunction } = require('../src/ai/llm-client');
globalThis.fetch = () => { throw new Error('Real fetch is forbidden in adapter fixture tests.'); };

const messages = [{ role: 'system', content: 'Fixture host prefix.' }, { role: 'user', content: 'Fixture request only.' }];
const tools = [{ name: 'fixture_terminal_echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
const resolveCredential = async () => 'fixture-not-a-real-credential';
function binding(protocol, stream) {
  const registry = createModelRegistry({ baseUrl: 'https://terminal-fixture.invalid/v1', model: 'fixture-model', secretRef: 'fixture_terminal_ref' });
  registry.providers[0].protocol = protocol;
  registry.providers[0].auth.kind = protocol === 'anthropic-messages' ? 'api-key' : 'bearer';
  registry.models[0].request.maxOutputTokens = 128;
  registry.models[0].compatibility.streamMode = stream ? 'on' : 'off';
  for (const name of ['text', 'nativeTools', 'streaming', 'usage']) registry.models[0].capabilities[name] = { state: 'supported', source: 'declared' };
  return resolveModelBinding({ registry, kind: 'fixture-terminal' });
}
function sse(events) { return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''); }
function fetchBody(body, counter = { requests: 0 }) { return async () => { counter.requests += 1; return new Response(body); }; }
function startMessage(usage = { input_tokens: 4, output_tokens: 2 }) { return { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage } }; }
function startBlock(index, type, text = '') { return { type: 'content_block_start', index, content_block: type === 'text' ? { type, text } : { type, id: `call_fixture_${index}`, name: tools[0].name, input: {} } }; }
function delta(index, type, text) { return { type: 'content_block_delta', index, delta: type === 'text' ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: text } }; }
function stopBlock(index) { return { type: 'content_block_stop', index }; }
function stopMessage(reason = 'end_turn', usage = { output_tokens: 2 }) { return [{ type: 'message_delta', delta: { stop_reason: reason }, usage }, { type: 'message_stop' }]; }

for (const types of [['text', 'text'], ['tool_use', 'text'], ['text', 'tool_use'], ['tool_use', 'tool_use']]) {
  test(`Anthropic rejects overlapping ${types.join('/')} blocks before publishing later content or tools`, async () => {
    const events = [startMessage(), startBlock(0, types[0]), startBlock(1, types[1], types[1] === 'text' ? 'later' : ''),
      delta(1, types[1], types[1] === 'text' ? '-tail' : '{"text":"right"}'),
      delta(0, types[0], types[0] === 'text' ? 'earlier' : '{"text":"left"}'),
      stopBlock(0), stopBlock(1), ...stopMessage(types.includes('tool_use') ? 'tool_use' : 'end_turn')];
    const deltas = [];
    const counter = { requests: 0 };
    await assert.rejects(invokeModelTurn({ binding: binding('anthropic-messages', true), messages, tools, resolveCredential,
      fetchFn: fetchBody(sse(events), counter), onEvent: event => deltas.push(event.delta) }), { code: 'MODEL_PROTOCOL_ERROR' });
    assert.deepEqual(deltas, [], 'Content from an illegally opened later block must not be published.');
    assert.equal(counter.requests, 1);
  });
}
for (const events of [
  [startMessage(), startBlock(1, 'text'), delta(1, 'text', 'skipped'), stopBlock(1), ...stopMessage()],
  [startMessage(), startBlock(0, 'text'), stopBlock(0), startBlock(2, 'text'), delta(2, 'text', 'skipped'), stopBlock(2), ...stopMessage()],
  [startMessage(), startBlock(0, 'text'), stopBlock(0), startBlock(0, 'text', 'duplicate'), stopBlock(0), ...stopMessage()],
]) {
  test(`Anthropic rejects block index jumps or reuse: ${events.filter(event => event.type === 'content_block_start').map(event => event.index).join(',')}`, async () => {
    await assert.rejects(invokeModelTurn({ binding: binding('anthropic-messages', true), messages, resolveCredential,
      fetchFn: fetchBody(sse(events)) }), { code: 'MODEL_PROTOCOL_ERROR' });
  });
}
test('Anthropic sequential text blocks have identical live, JSON and SSE content', async () => {
  const events = [startMessage(), startBlock(0, 'text', 'first'), delta(0, 'text', '-tail'), stopBlock(0),
    startBlock(1, 'text', 'second'), delta(1, 'text', '-tail'), stopBlock(1), ...stopMessage()];
  const deltas = [];
  const streamed = await invokeModelTurn({ binding: binding('anthropic-messages', true), messages, resolveCredential,
    fetchFn: fetchBody(sse(events)), onEvent: event => deltas.push(event.delta) });
  const json = await invokeModelTurn({ binding: binding('anthropic-messages', false), messages, resolveCredential,
    fetchFn: fetchBody(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'first-tail' }, { type: 'text', text: 'second-tail' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } })) });
  assert.equal(streamed.content, 'first-tailsecond-tail');
  assert.equal(deltas.join(''), streamed.content);
  assert.equal(json.content, streamed.content);
  assert.deepEqual(json.usage, streamed.usage);
});
test('Anthropic sequential text/tool/text blocks preserve live order and executable call identity', async () => {
  const events = [startMessage(), startBlock(0, 'text', 'intro'), stopBlock(0), startBlock(1, 'tool_use'),
    delta(1, 'tool_use', '{"text":"ok"}'), stopBlock(1), startBlock(2, 'text', 'outro'), stopBlock(2), ...stopMessage('tool_use')];
  const deltas = [];
  const result = await invokeModelTurn({ binding: binding('anthropic-messages', true), messages, tools, resolveCredential,
    fetchFn: fetchBody(sse(events)), onEvent: event => deltas.push(event.delta) });
  assert.equal(result.content, 'introoutro');
  assert.equal(deltas.join(''), result.content);
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{ id: 'call_fixture_1', name: tools[0].name, argumentsJson: '{"text":"ok"}' }]);
});

function emptyBody(protocol, stream, usageKind = 'actual', reason = 'stop') {
  let usage = usageKind === 'missing' ? undefined : { input_tokens: 4, output_tokens: usageKind === 'invalid' ? -2 : 2 };
  if (protocol === 'openai-chat-completions') {
    usage = usage && { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens };
    const choice = { message: { role: 'assistant', content: '' }, finish_reason: reason === 'filtered' ? 'content_filter' : reason };
    return stream ? sse([{ choices: [{ delta: { content: '' }, finish_reason: choice.finish_reason }] }, ...(usage ? [{ choices: [], usage }] : []), '[DONE]'])
      : JSON.stringify({ choices: [choice], ...(usage ? { usage } : {}) });
  }
  if (protocol === 'openai-responses') {
    const raw = { status: reason === 'stop' ? 'completed' : 'incomplete', output: [], ...(usage ? { usage } : {}),
      ...(reason === 'filtered' ? { incomplete_details: { reason: 'content_filter' } } : {}) };
    return stream ? sse([{ type: raw.status === 'completed' ? 'response.completed' : 'response.incomplete', response: raw }]) : JSON.stringify(raw);
  }
  const stopReason = { stop: 'end_turn', length: 'max_tokens', filtered: 'refusal', tool_calls: 'tool_use' }[reason];
  return stream ? sse([startMessage(usage ?? {}), ...stopMessage(stopReason, usage ? { output_tokens: usage.output_tokens } : {})])
    : JSON.stringify({ type: 'message', role: 'assistant', content: [], stop_reason: stopReason, ...(usage ? { usage } : {}) });
}
for (const protocol of MODEL_PROTOCOLS) for (const stream of [false, true]) for (const usageKind of ['actual', 'missing', 'invalid']) {
  test(`${protocol} ${stream ? 'SSE' : 'JSON'} empty completed output: EMPTY_RESPONSE and ${usageKind} usage`, async () => {
    const counter = { requests: 0 };
    const events = [];
    const results = [];
    const chat = createModelChatFunction({ binding: binding(protocol, stream), resolveCredential,
      fetchFn: fetchBody(emptyBody(protocol, stream, usageKind), counter), onUsage: event => events.push(event), onResult: result => results.push(result) });
    await assert.rejects(chat({ messages }), error => {
      assert.equal(error.code, 'MODEL_EMPTY_RESPONSE');
      assert.equal(error.usage.source, usageKind === 'actual' ? 'actual' : 'unavailable');
      if (usageKind === 'actual') { assert.equal(error.usage.inputTokens, 4); assert.equal(error.usage.outputTokens, 2); }
      else assert.equal(error.usage.outputTokens, null);
      assert.equal(error.usage.cachedInputTokens, null);
      assert.equal(error.usage.cacheCreationInputTokens, null);
      assert.ok(error.attemptId);
      return true;
    });
    assert.equal(counter.requests, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].usage.source, usageKind === 'actual' ? 'actual' : 'unavailable');
    assert.deepEqual(results, []);
  });
}
for (const protocol of ['openai-responses', 'anthropic-messages']) for (const stream of [false, true]) for (const reason of ['length', 'filtered']) {
  test(`${protocol} ${stream ? 'SSE' : 'JSON'} empty ${reason} remains an accepted non-executable terminal`, async () => {
    const result = await invokeModelTurn({ binding: binding(protocol, stream), messages, resolveCredential, fetchFn: fetchBody(emptyBody(protocol, stream, 'actual', reason)) });
    assert.equal(result.content, '');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.finishReason, reason);
    assert.equal(result.usage.source, 'actual');
  });
}
test('Responses contradictory empty snapshot remains PROTOCOL_ERROR with unavailable usage, not EMPTY_RESPONSE', async () => {
  const item = { type: 'message', id: 'item_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'seen' }] };
  const body = sse([{ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2 } } }]);
  await assert.rejects(invokeModelTurn({ binding: binding('openai-responses', true), messages, resolveCredential, fetchFn: fetchBody(body) }), error => {
    assert.equal(error.code, 'MODEL_PROTOCOL_ERROR');
    assert.equal(error.usage.source, 'unavailable');
    assert.equal(error.usage.inputTokens, null);
    assert.equal(error.partialOutput, 'seen');
    return true;
  });
});
test('Anthropic unfinished empty block remains PROTOCOL_ERROR with unavailable usage', async () => {
  await assert.rejects(invokeModelTurn({ binding: binding('anthropic-messages', true), messages, resolveCredential,
    fetchFn: fetchBody(sse([startMessage(), startBlock(0, 'text'), ...stopMessage()])) }), error => {
    assert.equal(error.code, 'MODEL_PROTOCOL_ERROR');
    assert.equal(error.usage.source, 'unavailable');
    return true;
  });
});
for (const stream of [false, true]) {
  test(`Anthropic ${stream ? 'SSE' : 'JSON'} tool_use without a tool block remains a protocol error`, async () => {
    await assert.rejects(invokeModelTurn({ binding: binding('anthropic-messages', stream), messages, tools, resolveCredential,
      fetchFn: fetchBody(emptyBody('anthropic-messages', stream, 'actual', 'tool_calls')) }), { code: 'MODEL_PROTOCOL_ERROR' });
  });
}
