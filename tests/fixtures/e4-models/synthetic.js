'use strict';
// Isolated, clearly synthetic wire fixtures. No network, environment, userData or vault access.
const { createModelRegistry, validateModelRegistry, resolveModelBinding } = require('../../../src/ai/model-profiles');
function makeBinding(protocol = 'openai-chat-completions', options = {}) {
  const registry = createModelRegistry({ baseUrl: 'https://synthetic.invalid/gateway/v1', model: 'synthetic-model', secretRef: options.noCredential ? '' : 'sec_synthetic' });
  const provider = registry.providers[0]; provider.protocol = protocol;
  provider.auth.kind = options.authKind || (protocol === 'anthropic-messages' ? 'api-key' : 'bearer');
  if (provider.auth.kind === 'none') Object.assign(provider.auth, { secretRef: '', credentialOrigin: null, credentialRevision: 0 });
  const model = registry.models[0];
  model.request = { maxOutputTokens: 256, ...(protocol === 'openai-chat-completions' ? { chatTokenLimitField: 'max_tokens' } : {}), ...options.request };
  if (options.contextWindow !== undefined) model.capabilities.contextWindow = { tokens: options.contextWindow, source: 'declared' };
  model.compatibility = { toolMode: 'native', streamMode: 'off', includeUsage: true, ...options.compatibility };
  for (const name of ['text', 'nativeTools', 'streaming', 'usage']) model.capabilities[name] = { state: 'supported', source: 'declared' };
  for (const [name, state] of Object.entries(options.capabilities || {})) model.capabilities[name] = { state, source: state === 'unknown' ? 'unknown' : 'declared' };
  return resolveModelBinding({ registry: validateModelRegistry(registry), senderId: 7, sessionId: 'synthetic-session', runId: 'synthetic-run', clientRequestId: 'synthetic-request', kind: options.kind || 'chat' });
}
function jsonResponse(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
function streamResponse(frames, chunkSize = 7, counters = {}) {
  const bytes = new TextEncoder().encode(frames); let position = 0;
  const body = new ReadableStream({ pull(controller) { if (position >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(position, position += chunkSize)); }, cancel() { counters.cancel = (counters.cancel || 0) + 1; } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
const sse = (items) => items.map((item) => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`).join('');
function mockFetch(...responses) {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push({ url: String(url), options, body: JSON.parse(options.body) }); const next = responses.shift(); if (!next) throw new Error('Synthetic fixture exhausted'); return typeof next === 'function' ? next(url, options) : next; };
  fetchFn.calls = calls; return fetchFn;
}
const tools = [{ name: 'synthetic_echo', description: 'Return isolated synthetic text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }];
const messages = [{ role: 'system', content: 'Synthetic host prefix.' }, { role: 'system', content: 'Second synthetic prefix.' }, { role: 'user', content: 'Synthetic prompt.' }];
const credential = async () => 'synthetic-not-a-real-key';
const chat = (content = 'synthetic answer', extra = {}) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }, ...extra });
module.exports = { makeBinding, jsonResponse, streamResponse, sse, mockFetch, tools, messages, credential, chat };
