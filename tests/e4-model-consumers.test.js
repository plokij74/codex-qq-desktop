'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, saveProfile, resolveModelBinding } = require('../src/ai/model-profiles');
const { generateCompactSummary, generateCompactArtifacts } = require('../src/ai/session-compact');
const { generateMemoryCandidates } = require('../src/ai/memory-candidates');
const { createMcpSamplingController } = require('../src/ai/mcp-sampling');

const settings = { mode: 'api', apiKey: 'legacy-not-authority', baseUrl: 'https://legacy.invalid', model: 'legacy-model', memoryEnabled: true, memoryCandidateEnabled: true };
const savedFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('SYNTHETIC_NETWORK_DISABLED'); }; });
test.after(() => { globalThis.fetch = savedFetch; });
function binding(projectMemory = true) {
  let registry = createModelRegistry({ baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model' });
  registry = saveProfile(registry, 'provider', { ...registry.providers[0], auth: { kind: 'none' } });
  registry = saveProfile(registry, 'assistant', { id: 'assistant_synthetic', name: 'Synthetic',
    knowledge: { projectContext: false, projectMemory }, toolPolicy: { mode: 'none', allowedTools: [] } });
  return resolveModelBinding({ registry, assistantId: 'assistant_synthetic', runId: 'run_synthetic', clientRequestId: 'request_synthetic', sessionId: 'session_synthetic', projectBindingId: 'pb_synthetic' });
}
function assertBound(call, expected) {
  assert.equal(call.modelBinding, expected);
  for (const key of ['apiKey', 'baseUrl', 'model']) assert.equal(Object.hasOwn(call, key), false, key);
}

test('bound compact uses the original snapshot and never reports duplicate raw usage', async () => {
  const modelBinding = binding(); const calls = []; const usage = [];
  const output = await generateCompactSummary({ transcript: 'Synthetic conversation', settings, modelBinding,
    chatFn: async (call) => { calls.push(call); return { content: 'Synthetic summary', usage: { inputTokens: 10, outputTokens: 2, source: 'actual' } }; }, onUsage: (event) => usage.push(event) });
  assert.equal(output, 'Synthetic summary'); assertBound(calls[0], modelBinding); assert.equal(usage.length, 0);
});
test('bound compact without a chat closure fails before any legacy transport', async () => {
  await assert.rejects(generateCompactSummary({ transcript: 'Synthetic', settings, modelBinding: binding() }), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
});
test('bound compact rejects a cloned, untrusted model binding', async () => {
  await assert.rejects(generateCompactSummary({ transcript: 'Synthetic', settings, modelBinding: { ...binding() }, chatFn: async () => 'no' }), { code: 'MODEL_BINDING_INVALID' });
});
test('bound candidates keep the same snapshot and leave physical usage to the wrapper', async () => {
  const modelBinding = binding(); const usage = []; let received;
  const output = await generateMemoryCandidates({ transcript: 'I prefer synthetic fixtures.', settings, limit: 2, modelBinding,
    chatFn: async (call) => { received = call; return { content: JSON.stringify({ candidates: [{ text: 'Prefers synthetic fixtures.', tags: [], evidence: 'I prefer synthetic fixtures.' }] }), usage: { inputTokens: 3, outputTokens: 2 } }; }, onUsage: (event) => usage.push(event) });
  assert.equal(output.length, 1); assertBound(received, modelBinding); assert.equal(usage.length, 0);
});
test('bound candidates without a chat closure cannot fetch a global provider', async () => {
  await assert.rejects(generateMemoryCandidates({ transcript: 'Synthetic', settings, limit: 1, modelBinding: binding() }), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
});
test('knowledge-disabled binding suppresses automatic candidate extraction', async () => {
  let called = false;
  const candidates = await generateMemoryCandidates({ transcript: 'Synthetic', settings, limit: 2, modelBinding: binding(false), chatFn: async () => { called = true; return 'no'; } });
  assert.deepEqual(candidates, []); assert.equal(called, false);
});
test('compact summary and candidates use separate bound closures and the same identity', async () => {
  const modelBinding = binding(); const kinds = [];
  const result = await generateCompactArtifacts({ transcript: 'Synthetic', settings, modelBinding, candidateLimit: 1,
    chatFn: async (call) => { assertBound(call, modelBinding); kinds.push('compact'); return { content: 'Summary' }; },
    candidateChatFn: async (call) => { assertBound(call, modelBinding); kinds.push('memory-candidates'); return { content: '{"candidates":[]}' }; } });
  assert.equal(result.summary, 'Summary'); assert.deepEqual(kinds, ['compact', 'memory-candidates']);
});
test('candidate cancellation does not turn compaction into an applied success', async () => {
  const abort = new AbortController();
  await assert.rejects(generateCompactArtifacts({ transcript: 'Synthetic', settings, modelBinding: binding(), candidateLimit: 1, signal: abort.signal,
    chatFn: async () => ({ content: 'Summary' }), candidateChatFn: async () => { abort.abort(); throw Object.assign(new Error('Stopped'), { code: 'ABORTED' }); } }), { code: 'ABORTED' });
});
test('local compact stays explicitly simulated and never calls a model', async () => {
  const result = await generateCompactSummary({ transcript: 'Synthetic', settings: { mode: 'local' }, modelBinding: binding(), chatFn: () => { throw new Error('must not call'); } });
  assert.match(result, /本地模式占位摘要/);
});
test('bound MCP sampling does not require legacy aliases or meter duplicate usage', async () => {
  const modelBinding = binding(false); const usage = []; const controller = createMcpSamplingController({ modelBinding,
    settings: { mode: 'api' }, enabled: true, gate: { authorize: async () => ({ allowed: true }) },
    chatFn: async (call) => { assertBound(call, modelBinding); assert.equal(Object.hasOwn(call, 'stop'), false); assert.equal(Object.hasOwn(call, 'tools'), false); return { content: 'Synthetic answer', usage: { inputTokens: 4, outputTokens: 4, source: 'actual' } }; },
    onUsage: (event) => usage.push(event), onEvent: (event) => usage.push(event) });
  const result = await controller.createMessage('synthetic', { messages: [{ role: 'user', content: { type: 'text', text: 'Synthetic question' } }], maxTokens: 64 });
  assert.equal(result.model, modelBinding.model); assert.equal(usage.length, 0);
});
test('bound MCP sampling without a closure never falls back to global fetch', async () => {
  const controller = createMcpSamplingController({ modelBinding: binding(false), settings, enabled: true, gate: { authorize: async () => ({ allowed: true }) } });
  await assert.rejects(controller.createMessage('synthetic', { messages: [{ role: 'user', content: 'Synthetic' }] }), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
});
test('bound MCP sampling cancellation remains independent and no implicit retry occurs', async () => {
  const abort = new AbortController(); let calls = 0;
  const controller = createMcpSamplingController({ modelBinding: binding(false), signal: abort.signal, settings: { mode: 'api' }, enabled: true,
    gate: { authorize: async () => ({ allowed: true }) }, chatFn: async () => { calls++; throw Object.assign(new Error('ordinary 400'), { code: 'MODEL_REQUEST_REJECTED' }); } });
  await assert.rejects(controller.createMessage('synthetic', { messages: [{ role: 'user', content: 'Synthetic' }] }), { code: 'MCP_SAMPLING_UNAVAILABLE' });
  assert.equal(calls, 1); abort.abort();
  await assert.rejects(controller.createMessage('synthetic', { messages: [{ role: 'user', content: 'Synthetic' }] }), { code: 'MCP_SAMPLING_CANCELLED' });
  assert.equal(calls, 1);
});
