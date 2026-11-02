'use strict';

// All requests, credentials and response readers in this file are in-memory
// fixtures. No real model, vault, userData or environment secret is accessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, resolveModelBinding, MODEL_PROTOCOLS } = require('../src/ai/model-profiles');
const { invokeModelTurn } = require('../src/ai/model-router');
const { createModelChatFunction } = require('../src/ai/llm-client');
const responsesAdapter = require('../src/ai/model-adapters/openai-responses');

const messages = [{ role: 'system', content: 'Fixture host prefix.' }, { role: 'user', content: 'Fixture request only.' }];
const tools = [{ name: 'fixture_cleanup_echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
const call = { id: 'call_cleanup_fixture', name: tools[0].name, argumentsJson: '{"text":"ok"}' };
const credential = async () => 'fixture-not-a-real-credential';

function makeBinding(protocol, stream) {
  const registry = createModelRegistry({ baseUrl: 'https://cleanup-fixture.invalid/gateway/v1', model: 'fixture-model', secretRef: 'fixture_cleanup_ref' });
  registry.providers[0].protocol = protocol;
  registry.providers[0].auth.kind = protocol === 'anthropic-messages' ? 'api-key' : 'bearer';
  registry.models[0].request.maxOutputTokens = 128;
  registry.models[0].compatibility.streamMode = stream ? 'on' : 'off';
  for (const name of ['text', 'nativeTools', 'streaming', 'usage']) registry.models[0].capabilities[name] = { state: 'supported', source: 'declared' };
  return resolveModelBinding({ registry, kind: 'fixture-cleanup' });
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function encodeSse(events) { return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''); }
function terminalBody(protocol, stream) {
  const usage = { input_tokens: 4, output_tokens: 2 };
  if (protocol === 'openai-chat-completions') {
    const wireCall = { id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } };
    return stream ? encodeSse([
      { choices: [{ delta: { tool_calls: [{ index: 0, ...wireCall }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }, '[DONE]',
    ]) : JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [wireCall] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  }
  if (protocol === 'openai-responses') {
    const item = { type: 'function_call', id: 'item_cleanup_fixture', call_id: call.id, name: call.name, arguments: call.argumentsJson, status: 'completed' };
    const response = { id: 'response_cleanup_fixture', status: 'completed', output: [item], usage };
    return stream ? encodeSse([
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) : JSON.stringify(response);
  }
  const block = { type: 'tool_use', id: call.id, name: call.name, input: { text: 'ok' } };
  return stream ? encodeSse([
    { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]) : JSON.stringify({ type: 'message', role: 'assistant', content: [block], stop_reason: 'tool_use', usage });
}
function controlledTransport(protocol, stream) {
  const started = deferred();
  const cleanup = deferred();
  const counters = { fetch: 0, cancel: 0, release: 0 };
  let sent = false;
  let cleanupFinished = false;
  let fetchSignal;
  const reader = {
    read: async () => {
      if (sent) return { done: true };
      sent = true;
      return { done: false, value: new TextEncoder().encode(terminalBody(protocol, stream)) };
    },
    cancel() { counters.cancel += 1; started.resolve(); return cleanup.promise; },
    releaseLock() { assert.equal(cleanupFinished, true, 'The reader lock must remain held until cancellation finishes.'); counters.release += 1; },
  };
  return {
    counters, started: started.promise,
    get signal() { return fetchSignal; },
    fetchFn: async (_url, options) => { counters.fetch += 1; fetchSignal = options.signal; return { status: 200, body: { getReader: () => reader } }; },
    finishCleanup() { cleanupFinished = true; cleanup.resolve(); },
  };
}
function settled(promise) { return promise.then(result => ({ result }), error => ({ error })); }

for (const protocol of MODEL_PROTOCOLS) for (const stream of [false, true]) {
  const mode = stream ? 'SSE' : 'JSON';
  test(`${protocol} ${mode}: parent cancellation remains effective during awaited reader cleanup`, async () => {
    const transport = controlledTransport(protocol, stream);
    const controller = new AbortController();
    const turnController = new AbortController();
    const usage = [];
    const results = [];
    const chat = createModelChatFunction({ binding: makeBinding(protocol, stream), signal: controller.signal, resolveCredential: credential,
      fetchFn: transport.fetchFn, onUsage: event => usage.push(event), onResult: result => results.push(result) });
    const pending = settled(chat({ messages, tools, signal: turnController.signal }));
    await transport.started;
    assert.equal(transport.counters.release, 0);
    controller.abort();
    assert.equal(turnController.signal.aborted, false);
    await assert.rejects(chat({ messages, tools }), { code: 'MODEL_BUSY' });
    const fetchAborted = transport.signal.aborted;
    transport.finishCleanup();
    const outcome = await pending;
    assert.equal(fetchAborted, true, 'Parent abort must still reach the model fetch signal during cleanup.');
    assert.equal(outcome.error?.code, 'ABORTED', 'Cleanup cancellation must not return executable tool calls or successful output.');
    assert.equal(outcome.result, undefined);
    assert.deepEqual(transport.counters, { fetch: 1, cancel: 1, release: 1 });
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'cancelled');
    assert.equal(usage[0].usage.source, 'unavailable');
    assert.ok(usage[0].attemptId);
    assert.deepEqual(results, []);
  });

  test(`${protocol} ${mode}: request deadline remains effective until reader cleanup finishes`, async () => {
    const transport = controlledTransport(protocol, stream);
    const usage = [];
    const results = [];
    const chat = createModelChatFunction({ binding: makeBinding(protocol, stream), resolveCredential: credential,
      fetchFn: transport.fetchFn, onUsage: event => usage.push(event), onResult: result => results.push(result) });
    const pending = settled(chat({ messages, tools, timeoutMs: 40 }));
    await transport.started;
    await new Promise(resolve => setTimeout(resolve, 65));
    const fetchAborted = transport.signal.aborted;
    transport.finishCleanup();
    const outcome = await pending;
    assert.equal(fetchAborted, true, 'The model deadline must remain active during cleanup.');
    assert.equal(outcome.error?.code, 'MODEL_TIMEOUT');
    assert.equal(outcome.result, undefined);
    assert.deepEqual(transport.counters, { fetch: 1, cancel: 1, release: 1 });
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.equal(usage[0].usage.source, 'unavailable');
    assert.deepEqual(results, []);
  });
}

for (const protocol of MODEL_PROTOCOLS) for (const stream of [false, true]) {
  test(`${protocol} ${stream ? 'SSE' : 'JSON'}: cleanup cancellation is normalized after an earlier tool validation failure`, async () => {
    const transport = controlledTransport(protocol, stream);
    const controller = new AbortController();
    const usage = [];
    const incompatibleTools = [{ name: tools[0].name, parameters: { type: 'object', properties: { text: { type: 'string', const: 'not-ok' } }, required: ['text'], additionalProperties: false } }];
    const chat = createModelChatFunction({ binding: makeBinding(protocol, stream), signal: controller.signal, resolveCredential: credential,
      fetchFn: transport.fetchFn, onUsage: event => usage.push(event) });
    const pending = settled(chat({ messages, tools: incompatibleTools }));
    await transport.started;
    controller.abort();
    transport.finishCleanup();
    const outcome = await pending;
    assert.equal(outcome.error?.code, 'ABORTED', 'Cancellation during cleanup must be considered before public error/usage normalization.');
    assert.equal(outcome.result, undefined);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'cancelled');
    assert.deepEqual(transport.counters, { fetch: 1, cancel: 1, release: 1 });
  });
}

for (const stream of [false, true]) {
  test(`Responses ${stream ? 'SSE' : 'JSON'}: cleanup cancellation invalidates the private continuation token`, async t => {
    const binding = makeBinding('openai-responses', stream);
    const transport = controlledTransport('openai-responses', stream);
    const controller = new AbortController();
    let token;
    const original = responsesAdapter.invoke;
    t.mock.method(responsesAdapter, 'invoke', async options => { const result = await original(options); token = result.providerState; return result; });
    const pending = settled(invokeModelTurn({ binding, messages, tools, signal: controller.signal, resolveCredential: credential, fetchFn: transport.fetchFn }));
    await transport.started;
    controller.abort();
    transport.finishCleanup();
    const outcome = await pending;
    assert.equal(outcome.error?.code, 'ABORTED');
    assert.ok(token, 'The completed adapter turn created a run-private token before cleanup.');
    await assert.rejects(invokeModelTurn({ binding, messages: [...messages, { role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', toolCallId: call.id, content: 'ok' }],
      tools, providerState: token, resolveCredential: credential, fetchFn: transport.fetchFn }), { code: 'MODEL_STATE_INVALID' });
    assert.equal(transport.counters.fetch, 1, 'Invalidated continuation must not start another physical request.');
  });
}
