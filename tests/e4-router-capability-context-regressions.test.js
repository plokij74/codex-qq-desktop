'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { invokeModelTurn, preflightModelRequest, createModelChatFunction } = require('../src/ai/model-router');
const { buildModelUsageEvent } = require('../src/ai/model-usage');
const { makeBinding, jsonResponse, mockFetch, messages, credential, chat } = require('./fixtures/e4-models/synthetic');
const protocols = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'];
const nativeHistory = () => [
  ...messages,
  { role: 'assistant', content: '', toolCalls: [{ id: 'synthetic-history-call', name: 'synthetic_echo', argumentsJson: '{"text":"history"}' }] },
  { role: 'tool', content: 'synthetic history result', toolCallId: 'synthetic-history-call' },
  { role: 'user', content: 'Continue the synthetic conversation.' },
];
function terminal(protocol, content = 'synthetic answer') {
  if (protocol === 'openai-chat-completions') return chat(content);
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', id: 'synthetic-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3 } };
  return { type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } };
}
for (const protocol of protocols) {
  for (const state of ['unknown', 'unsupported']) test(`${protocol}: native history needs verified native-tools capability even with no new tools`, async () => {
    const binding = makeBinding(protocol, { capabilities: { nativeTools: state } });
    const fetchFn = mockFetch(jsonResponse(terminal(protocol))); let credentials = 0;
    const input = { binding, messages: nativeHistory(), tools: [] };
    assert.throws(() => preflightModelRequest(input), { code: 'MODEL_CAPABILITY_REQUIRED', publicCode: state === 'unknown' ? 'MODEL_CAPABILITY_UNKNOWN' : 'MODEL_CAPABILITY_UNSUPPORTED' });
    await assert.rejects(invokeModelTurn({ ...input, fetchFn, resolveCredential: async () => { credentials += 1; return credential(); } }), { code: 'MODEL_CAPABILITY_REQUIRED' });
    assert.equal(credentials, 0); assert.equal(fetchFn.calls.length, 0);
  });
  for (const toolMode of ['none', 'text-compat']) test(`${protocol}: ${toolMode} cannot silently send native tool history`, async () => {
    const binding = makeBinding(protocol, { compatibility: { toolMode } });
    const fetchFn = mockFetch(jsonResponse(terminal(protocol))); let credentials = 0;
    await assert.rejects(invokeModelTurn({ binding, messages: nativeHistory(), tools: [], fetchFn,
      resolveCredential: async () => { credentials += 1; return credential(); } }), { code: 'MODEL_CAPABILITY_REQUIRED', publicCode: 'MODEL_CAPABILITY_UNSUPPORTED' });
    assert.equal(credentials, 0); assert.equal(fetchFn.calls.length, 0);
  });
  test(`${protocol}: supported native history without re-declaring tools remains usable`, async () => {
    const binding = makeBinding(protocol); const fetchFn = mockFetch(jsonResponse(terminal(protocol)));
    const result = await invokeModelTurn({ binding, messages: nativeHistory(), tools: [], fetchFn, resolveCredential: credential });
    assert.equal(result.content, 'synthetic answer'); assert.deepEqual(result.toolCalls, []); assert.equal(fetchFn.calls.length, 1);
    const body = fetchFn.calls[0].body;
    if (protocol === 'openai-chat-completions') assert.equal(body.messages.find(m => m.role === 'tool').tool_call_id, 'synthetic-history-call');
    else if (protocol === 'openai-responses') assert.equal(body.input.find(i => i.type === 'function_call_output').call_id, 'synthetic-history-call');
    else assert.equal(body.messages.find(m => m.content.some(p => p.type === 'tool_result')).content[0].tool_use_id, 'synthetic-history-call');
  });
  test(`${protocol}: usage context limit comes from the accepted declared capability`, () => {
    const binding = makeBinding(protocol, { contextWindow: 8192 });
    const event = buildModelUsageEvent({ binding, settings: { compactMaxApproxTokens: 32000 },
      attempt: { attemptId: 'synthetic-context-usage', status: 'completed', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: null, cacheCreationInputTokens: null, source: 'actual' } } });
    assert.equal(event.contextLimit, 8192); assert.equal(event.contextTokens, 9); assert.equal(event.source, 'actual');
  });
}
function annotatedResponse(size) {
  const raw = terminal('openai-responses', 'accepted synthetic turn');
  raw.output[0].content[0].annotations = [{ type: 'url_citation', start_index: 0, end_index: 1, title: 'Synthetic annotation', url: 'https://synthetic.invalid/' + 'x'.repeat(size) }];
  return raw;
}
for (const boundary of ['router', 'legacy']) test(`Responses ${boundary}: replayed opaque items participate in the context budget`, async () => {
  const binding = makeBinding('openai-responses', { contextWindow: 2048, request: { maxOutputTokens: 128 } });
  const raw = annotatedResponse(12000); const fetchFn = mockFetch(jsonResponse(raw), jsonResponse(terminal('openai-responses')));
  const chatFn = createModelChatFunction({ binding, fetchFn, resolveCredential: credential });
  const first = boundary === 'router'
    ? await invokeModelTurn({ binding, messages, fetchFn, resolveCredential: credential })
    : await chatFn({ messages });
  const continuation = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: 'Continue.' }];
  // The normalized view fits; only the retained upstream items cross the declared limit.
  assert.doesNotThrow(() => preflightModelRequest({ binding, messages: continuation }));
  await assert.rejects(boundary === 'router'
    ? invokeModelTurn({ binding, messages: continuation, providerState: first.providerState, fetchFn, resolveCredential: credential })
    : chatFn({ messages: continuation }), error => error.code === 'MODEL_CONTEXT_LIMIT' && !error.attemptId);
  assert.equal(fetchFn.calls.length, 1);
});
for (const contextWindow of [2048, null]) test(`Responses: valid replay preserves annotations with context window ${contextWindow}`, async () => {
  const binding = makeBinding('openai-responses', { contextWindow, request: { maxOutputTokens: 128 } });
  const raw = annotatedResponse(contextWindow === null ? 12000 : 32);
  const fetchFn = mockFetch(jsonResponse(raw), jsonResponse(terminal('openai-responses')));
  const first = await invokeModelTurn({ binding, messages, fetchFn, resolveCredential: credential });
  const result = await invokeModelTurn({ binding, messages: [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: 'Continue.' }],
    providerState: first.providerState, fetchFn, resolveCredential: credential });
  assert.equal(result.content, 'synthetic answer'); assert.equal(fetchFn.calls.length, 2);
  const replayed = fetchFn.calls[1].body.input.find(item => item.id === 'synthetic-message');
  assert.deepEqual(replayed, raw.output[0]); assert.equal(fetchFn.calls[1].body.store, false);
  assert.notEqual(first.attemptId, result.attemptId);
});
test('unknown model context limit retains the explicit legacy compact fallback', () => {
  const binding = makeBinding('openai-chat-completions', { contextWindow: null });
  const event = buildModelUsageEvent({ binding, settings: { compactMaxApproxTokens: 32000 },
    attempt: { attemptId: 'synthetic-context-fallback', status: 'failed', usage: { source: 'unavailable' } } });
  assert.equal(event.contextLimit, 32000); assert.equal(event.inputTokens, null);
});
for (const protocol of protocols) test(`${protocol}: internal native-tool diagnosis may replay synthetic history while the capability is unknown`, async () => {
  const binding = makeBinding(protocol, { kind: 'model-diagnostic', capabilities: { nativeTools: 'unknown' }, compatibility: { toolMode: 'none' } });
  const fetchFn = mockFetch(jsonResponse(terminal(protocol)));
  const result = await invokeModelTurn({ binding, messages: nativeHistory(), tools: require('./fixtures/e4-models/synthetic').tools,
    purpose: 'diagnostic', diagnosticCheck: 'nativeTools', request: { maxOutputTokens: 128 }, fetchFn, resolveCredential: credential });
  assert.equal(result.content, 'synthetic answer'); assert.equal(fetchFn.calls.length, 1);
});
