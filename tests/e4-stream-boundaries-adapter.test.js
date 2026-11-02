'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn } = require('../src/ai/model-router');
const { makeBinding, mockFetch, jsonResponse, streamResponse, sse, tools, messages, credential, chat } = require('./fixtures/e4-models/synthetic');

const textItem = (id = 'msg_boundary', text = 'answer') => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const callItem = (extra = {}) => ({ type: 'function_call', id: 'item_boundary', call_id: 'call_boundary', name: 'synthetic_echo', arguments: '{"text":"ok"}', status: 'completed', ...extra });
const completed = (output) => ({ id: 'resp_boundary', status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2 } });
const anthropic = (content, stop_reason = 'end_turn', extra = {}) => ({ type: 'message', role: 'assistant', content, stop_reason, usage: { input_tokens: 4, output_tokens: 2 }, ...extra });
const anthropicStart = () => ({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 4, output_tokens: 0 } } });
const invokeStream = (protocol, frames, extra = {}) => invokeModelTurn({ binding: makeBinding(protocol, { compatibility: { streamMode: 'on' } }), messages, tools, resolveCredential: credential, fetchFn: mockFetch(streamResponse(sse(frames), 3)), ...extra });

test('Chat cannot accept text or tool fragments after finish_reason', async () => {
  for (const late of [{ content: 'late' }, { tool_calls: [{ index: 0, id: 'late_call', function: { name: 'synthetic_echo', arguments: '{"text":"ok"}' } }] }]) {
    const fetchFn = mockFetch(streamResponse(sse([
      { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] },
      { choices: [{ index: 0, delta: late }] }, '[DONE]',
    ])));
    await assert.rejects(invokeModelTurn({ binding: makeBinding(undefined, { compatibility: { streamMode: 'on' } }), messages, tools, resolveCredential: credential, fetchFn }), { code: 'MODEL_PROTOCOL_ERROR' });
    assert.equal(fetchFn.calls.length, 1);
  }
});

test('Chat rejects explicit non-assistant output roles in JSON and SSE', async () => {
  for (const role of ['user', 'system', 'tool']) {
    await assert.rejects(invokeModelTurn({ binding: makeBinding(), messages, resolveCredential: credential, fetchFn: mockFetch(jsonResponse(chat('answer', { choices: [{ message: { role, content: 'answer' }, finish_reason: 'stop' }] }))) }), { code: 'MODEL_PROTOCOL_ERROR' });
    await assert.rejects(invokeStream('openai-chat-completions', [{ choices: [{ delta: { role, content: 'answer' }, finish_reason: 'stop' }] }, '[DONE]']), { code: 'MODEL_PROTOCOL_ERROR' });
  }
});

test('Responses preserves added item identity through done and terminal snapshots', async () => {
  const initial = callItem({ arguments: '', status: 'in_progress' });
  for (const changed of [callItem({ call_id: 'swapped_call' }), callItem({ name: 'different_tool' }), textItem(initial.id)]) {
    await assert.rejects(invokeStream('openai-responses', [
      { type: 'response.output_item.added', output_index: 0, item: initial },
      { type: 'response.output_item.done', output_index: 0, item: changed },
      { type: 'response.completed', response: completed([changed]) },
    ]), { code: 'MODEL_PROTOCOL_ERROR' });
  }
});

test('Responses text deltas are bound to the correct item and live content part', async () => {
  const item = textItem();
  for (const delta of [
    { item_id: 'wrong_item', output_index: 0, content_index: 0 },
    { item_id: item.id, output_index: 1, content_index: 0 },
    { item_id: item.id, output_index: 0, content_index: -1 },
  ]) {
    await assert.rejects(invokeStream('openai-responses', [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', ...delta, delta: 'answer' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: completed([item]) },
    ]), { code: 'MODEL_PROTOCOL_ERROR' });
  }
  await assert.rejects(invokeStream('openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'answer' },
    { type: 'response.completed', response: completed([item]) },
  ]), { code: 'MODEL_PROTOCOL_ERROR' });
});

test('Responses completed arguments and tracked item completion cannot be skipped or contradicted', async () => {
  const call = callItem();
  await assert.rejects(invokeStream('openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
    { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: '{"text":"different"}' },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: completed([call]) },
  ]), { code: 'MODEL_PROTOCOL_ERROR' });
  await assert.rejects(invokeStream('openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
    { type: 'response.completed', response: completed([call]) },
  ]), { code: 'MODEL_PROTOCOL_ERROR' });
});

test('Responses interleaved text is accumulated by output item and content index', async () => {
  const first = textItem('msg_first', 'first'); const second = textItem('msg_second', 'second');
  const turn = await invokeStream('openai-responses', [
    { type: 'response.output_item.added', output_index: 0, item: { ...first, content: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { ...second, content: [] } },
    { type: 'response.output_text.delta', item_id: second.id, output_index: 1, content_index: 0, delta: 'second' },
    { type: 'response.output_text.delta', item_id: first.id, output_index: 0, content_index: 0, delta: 'first' },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.completed', response: completed([first, second]) },
  ]);
  assert.equal(turn.content, 'firstsecond');
});

test('Anthropic terminal message_delta cannot be followed by new content or changed stop reason', async () => {
  for (const late of [
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'late' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
  ]) {
    const frames = [anthropicStart(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, late];
    if (late.type === 'content_block_start') frames.push({ type: 'content_block_stop', index: 1 });
    frames.push({ type: 'message_stop' });
    await assert.rejects(invokeStream('anthropic-messages', frames), { code: 'MODEL_PROTOCOL_ERROR' });
  }
});

test('Anthropic rejects explicit non-assistant message roles in JSON and message_start', async () => {
  const blocks = [{ type: 'text', text: 'answer' }];
  await assert.rejects(invokeModelTurn({ binding: makeBinding('anthropic-messages'), messages, resolveCredential: credential, fetchFn: mockFetch(jsonResponse(anthropic(blocks, 'end_turn', { role: 'user' }))) }), { code: 'MODEL_PROTOCOL_ERROR' });
  const start = anthropicStart(); start.message.role = 'user';
  await assert.rejects(invokeStream('anthropic-messages', [start, { type: 'content_block_start', index: 0, content_block: blocks[0] }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]), { code: 'MODEL_PROTOCOL_ERROR' });
});

test('SSE handles split UTF8, mixed legal line endings and multiline data frames', async () => {
  const frame = 'data: {"choices": [\r\ndata: {"index":0,"delta":{"content":"你好🙂"},"finish_reason":"stop"}]}\r\n\n' + 'data: [DONE]\n\r\n';
  const turn = await invokeModelTurn({ binding: makeBinding(undefined, { compatibility: { streamMode: 'on' } }), messages, resolveCredential: credential, fetchFn: mockFetch(streamResponse(frame, 1)) });
  assert.equal(turn.content, '你好🙂');
});

const terminalFrames = {
  'openai-chat-completions': [{ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }, '[DONE]'],
  'openai-responses': [{ type: 'response.completed', response: completed([textItem()]) }],
  'anthropic-messages': [anthropicStart(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
};
for (const protocol of Object.keys(terminalFrames)) {
  test(`${protocol} awaits reader cancellation before releasing the lock and completing`, async () => {
    let cancelCount = 0; let releaseCount = 0; let finishCancel; let startCancel;
    const cancelled = new Promise((resolve) => { startCancel = resolve; });
    const cleanup = new Promise((resolve) => { finishCancel = resolve; });
    let sent = false;
    const reader = {
      read: async () => { if (sent) throw new Error('Reading past the synthetic terminal'); sent = true; return { done: false, value: new TextEncoder().encode(sse(terminalFrames[protocol])) }; },
      cancel: () => { cancelCount += 1; startCancel(); return cleanup; },
      releaseLock: () => { releaseCount += 1; },
    };
    let settled = false;
    const pending = invokeModelTurn({ binding: makeBinding(protocol, { compatibility: { streamMode: 'on' } }), messages, resolveCredential: credential, fetchFn: mockFetch({ status: 200, body: { getReader: () => reader } }) }).then((turn) => { settled = true; return turn; });
    await cancelled;
    try { assert.equal(settled, false); assert.equal(releaseCount, 0); } finally { finishCancel(); }
    const turn = await pending;
    assert.equal(turn.content, 'answer'); assert.equal(cancelCount, 1); assert.equal(releaseCount, 1);
  });

  test(`${protocol} cancellation of an idle read rejects without late deltas or tools`, async () => {
    const controller = new AbortController(); let startRead; let resolveRead; let cancelCount = 0; let released = 0; let fetchSignal;
    const reading = new Promise((resolve) => { startRead = resolve; });
    const events = [];
    const reader = { read: () => { startRead(); return new Promise((resolve) => { resolveRead = resolve; }); }, cancel: async () => { cancelCount += 1; }, releaseLock: () => { released += 1; } };
    const fetchFn = async (_url, options) => { fetchSignal = options.signal; return { status: 200, body: { getReader: () => reader } }; };
    const pending = invokeModelTurn({ binding: makeBinding(protocol, { compatibility: { streamMode: 'on' } }), messages, tools, resolveCredential: credential, fetchFn, signal: controller.signal, onEvent: (event) => events.push(event) });
    await reading; controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
    resolveRead({ done: false, value: new TextEncoder().encode(sse(terminalFrames[protocol])) }); await new Promise(setImmediate);
    assert.equal(fetchSignal.aborted, true); assert.equal(cancelCount, 1); assert.equal(released, 1); assert.deepEqual(events, []);
  });

  test(`${protocol} response and SSE frame byte ceilings fail without retry`, async () => {
    for (const request of [{ maxResponseBytes: 32 }, { maxFrameBytes: 32 }]) {
      const fetchFn = mockFetch(streamResponse(sse(terminalFrames[protocol]), 1));
      await assert.rejects(invokeModelTurn({ binding: makeBinding(protocol, { compatibility: { streamMode: 'on' } }), messages, resolveCredential: credential, fetchFn, request }), { code: 'MODEL_LIMIT_EXCEEDED' });
      assert.equal(fetchFn.calls.length, 1);
    }
  });
}
