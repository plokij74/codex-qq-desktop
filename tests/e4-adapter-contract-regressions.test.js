'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn, preflightModelRequest } = require('../src/ai/model-router');
const { createModelDiagnosticService } = require('../src/ai/model-diagnostics');
const { makeBinding, mockFetch, jsonResponse, streamResponse, sse, tools, messages, credential, chat } = require('./fixtures/e4-models/synthetic');

const completed = output => ({ id: 'resp_contract_fixture', status: 'completed', output, usage: { input_tokens: 9, output_tokens: 3 } });
const textItem = (id, ...texts) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: texts.map(text => ({ type: 'output_text', text, annotations: [] })) });
async function responsesStream(frames) {
  const events = [];
  const turn = await invokeModelTurn({ binding: makeBinding('openai-responses', { compatibility: { streamMode: 'on' } }), messages,
    fetchFn: mockFetch(streamResponse(sse(frames), 1)), resolveCredential: credential, onEvent: event => events.push(event.delta) });
  return { turn, events };
}

// Every request and credential here is an in-memory fixture; no real tools,
// files, machine-key derivation, vault, environment secrets or endpoints.
test('E4 diagnostics select their own wire stream mode without inheriting workload streaming policy', () => {
  for (const streamMode of ['off', 'auto', 'on']) for (const streaming of ['unknown', 'unsupported', 'supported']) {
    const binding = makeBinding(undefined, { kind: 'model-diagnostic', compatibility: { streamMode }, capabilities: { text: 'unknown', nativeTools: 'unknown', streaming } });
    for (const diagnosticCheck of ['text', 'streaming', 'usage', 'nativeTools']) {
      const prepared = preflightModelRequest({ binding, messages, tools: diagnosticCheck === 'nativeTools' ? tools : [], purpose: 'diagnostic', diagnosticCheck,
        request: { stream: true, maxOutputTokens: 128, timeoutMs: 15000, maxResponseBytes: 262144 } });
      assert.equal(prepared.request.stream, diagnosticCheck === 'streaming', `${streamMode}/${streaming}/${diagnosticCheck}`);
      assert.equal(prepared.request.maxOutputTokens, 128); assert.equal(prepared.timeoutMs, 15000); assert.equal(prepared.limits.maxResponseBytes, 262144);
    }
  }
  const unrelatedUnsupported = makeBinding(undefined, { kind: 'model-diagnostic', capabilities: { text: 'unsupported', streaming: 'unknown' } });
  assert.throws(() => preflightModelRequest({ binding: unrelatedUnsupported, messages, purpose: 'diagnostic', diagnosticCheck: 'usage' }), { code: 'MODEL_CAPABILITY_REQUIRED' });
  assert.throws(() => preflightModelRequest({ binding: makeBinding(undefined, { compatibility: { streamMode: 'on' }, capabilities: { streaming: 'unknown' } }), messages }), { code: 'MODEL_CAPABILITY_REQUIRED' });
});

test('E4 default diagnostic service completes all five actual fixture requests when workload stream is on and unknown', async t => {
  const binding = makeBinding(undefined, { kind: 'model-diagnostic', compatibility: { streamMode: 'on' }, capabilities: { text: 'unknown', streaming: 'unknown', nativeTools: 'unknown' } });
  const bodies = []; const usages = [];
  const fetchFn = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.stream) return streamResponse(sse([{ choices: [{ delta: { content: 'SYNTHETIC_DIAGNOSTIC_OK' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }, '[DONE]']), 1);
    const result = body.messages.find(message => message.role === 'tool');
    if (result) return jsonResponse(chat(result.content));
    if (body.tools) {
      const tool = body.tools[0].function;
      return jsonResponse(chat('', { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'fixture_native_call', type: 'function', function: { name: tool.name, arguments: JSON.stringify({ text: tool.parameters.properties.text.enum[0] }) } }] }, finish_reason: 'tool_calls' }] }));
    }
    return jsonResponse(chat('SYNTHETIC_DIAGNOSTIC_OK'));
  };
  t.mock.method(globalThis, 'fetch', fetchFn);
  const service = createModelDiagnosticService({ resolveCredential: credential, onUsage: usage => usages.push(usage) });
  try {
    const ack = service.start({ binding, sender: { id: binding.senderId } }); const done = await service.wait(ack.diagnosticId);
    assert.equal(done.state, 'passed'); assert.equal(bodies.length, 5); assert.equal(usages.length, 5);
    assert.deepEqual(bodies.map(body => body.stream), [false, true, false, false, false]);
    for (const body of bodies) assert.equal(body.max_tokens, 128);
  } finally { await service.close(); }
});

test('E4 Responses live text follows output_index rather than interleaved arrival order', async () => {
  const first = textItem('fixture_first', 'first'); const second = textItem('fixture_second', 'second');
  const { turn, events } = await responsesStream([
    { type: 'response.output_item.added', output_index: 1, item: { ...second, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 1, item_id: second.id, content_index: 0, delta: 'second' },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.output_item.added', output_index: 0, item: { ...first, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: first.id, content_index: 0, delta: 'first' },
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.completed', response: completed([first, second]) }
  ]);
  assert.equal(turn.content, 'firstsecond'); assert.equal(events.join(''), turn.content);
});

test('E4 Responses live text follows content_index when message parts arrive out of order', async () => {
  const item = textItem('fixture_parts', 'first', 'second');
  const { turn, events } = await responsesStream([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 1, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 1, delta: 'second' },
    { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 1, part: item.content[1] },
    { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'first' },
    { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed([item]) }
  ]);
  assert.equal(turn.content, 'firstsecond'); assert.equal(events.join(''), turn.content);
});

test('E4 Responses snapshots publish unseen text parts exactly once after earlier streamed text', async () => {
  const item = textItem('fixture_snapshot_tail', 'first', 'second');
  const { turn, events } = await responsesStream([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'first' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed([item]) }
  ]);
  assert.equal(turn.content, 'firstsecond'); assert.equal(events.join(''), turn.content);
});

test('E4 Responses never publish queued later output from an unterminated stream', async () => {
  const item = textItem('fixture_queued', 'later'); const events = [];
  const frames = [{ type: 'response.output_item.added', output_index: 1, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 1, item_id: item.id, content_index: 0, delta: 'later' }, { type: 'response.output_item.done', output_index: 1, item }];
  await assert.rejects(invokeModelTurn({ binding: makeBinding('openai-responses', { compatibility: { streamMode: 'on' } }), messages,
    fetchFn: mockFetch(streamResponse(sse(frames), 1)), resolveCredential: credential, onEvent: event => events.push(event.delta) }), { code: 'MODEL_PROTOCOL_ERROR' });
  assert.deepEqual(events, []);
});

test('E4 Chat streamed refusal has the same filtered content and usage as JSON, without emitting refusal text', async () => {
  const refusal = 'Fixture refusal, not a secret.';
  const json = await invokeModelTurn({ binding: makeBinding(), messages, fetchFn: mockFetch(jsonResponse(chat('', { choices: [{ message: { role: 'assistant', content: '', refusal }, finish_reason: 'stop' }] }))), resolveCredential: credential });
  const events = [];
  const frames = [{ choices: [{ delta: { refusal: refusal.slice(0, 8) } }] }, { choices: [{ delta: { refusal: refusal.slice(8) }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }, '[DONE]'];
  const streamed = await invokeModelTurn({ binding: makeBinding(undefined, { compatibility: { streamMode: 'on' } }), messages,
    fetchFn: mockFetch(streamResponse(sse(frames), 1)), resolveCredential: credential, onEvent: event => events.push(event.delta) });
  assert.equal(json.finishReason, 'filtered'); assert.equal(streamed.finishReason, json.finishReason); assert.equal(streamed.content, json.content);
  assert.deepEqual(streamed.usage, json.usage); assert.deepEqual(events, []);
});

test('E4 Chat refusal cannot return executable tools in either JSON or SSE', async () => {
  const call = { id: 'fixture_refused_call', type: 'function', function: { name: tools[0].name, arguments: '{"text":"ok"}' } };
  const json = jsonResponse(chat('', { choices: [{ message: { role: 'assistant', content: '', refusal: 'Fixture refusal.', tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
  const streamed = streamResponse(sse([{ choices: [{ delta: { refusal: 'Fixture refusal.', tool_calls: [{ ...call, index: 0 }] }, finish_reason: 'tool_calls' }] }, '[DONE]']), 1);
  for (const [streamMode, response] of [['off', json], ['on', streamed]]) await assert.rejects(invokeModelTurn({ binding: makeBinding(undefined, { compatibility: { streamMode } }), messages, tools,
    fetchFn: mockFetch(response), resolveCredential: credential }), { code: 'MODEL_TOOL_INVALID' });
});

test('E4 Chat rejects invalid refusal fields and refusal fragments arriving after finish', async () => {
  for (const frames of [
    [{ choices: [{ delta: { refusal: 42 }, finish_reason: 'stop' }] }, '[DONE]'],
    [{ choices: [{ delta: { content: 'fixture text' }, finish_reason: 'stop' }] }, { choices: [{ delta: { refusal: 'late fixture refusal' } }] }, '[DONE]']
  ]) await assert.rejects(invokeModelTurn({ binding: makeBinding(undefined, { compatibility: { streamMode: 'on' } }), messages,
    fetchFn: mockFetch(streamResponse(sse(frames), 1)), resolveCredential: credential }), { code: 'MODEL_PROTOCOL_ERROR' });
});
