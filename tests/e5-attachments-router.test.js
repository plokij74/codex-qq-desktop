'use strict';
// Synthetic fixtures only; no endpoint, environment or credential-vault access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelOperationBudget, preflightModelRequest, invokeModelTurn, ModelError } = require('../src/ai/model-router');
const { createModelChatFunction } = require('../src/ai/llm-client');
const { makeBinding, jsonResponse, chat, mockFetch, tools } = require('./fixtures/e4-models/synthetic');
const protocols = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'];
const prompt = [{ role: 'system', content: 'Synthetic system.' }, { role: 'user', content: 'Synthetic attachment.' }];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const budget = (contextLimit = 32000, extra = {}) => createModelOperationBudget({ contextLimit, check: async () => {}, ...extra });
function terminal(protocol, usage = true) {
  if (protocol === protocols[0]) { const raw = chat('synthetic answer'); if (!usage) delete raw.usage; return raw; }
  if (protocol === protocols[1]) return { id: 'synthetic-response', status: 'completed', output: [{ id: 'synthetic-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }], ...(usage ? { usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } : {}) };
  return { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }], stop_reason: 'end_turn', ...(usage ? { usage: { input_tokens: 9, output_tokens: 3 } } : {}) };
}
function harness(protocol, options = {}) {
  const counts = { credentials: 0 }; return { binding: makeBinding(protocol, options), counts, fetchFn: mockFetch(jsonResponse(terminal(protocol))), resolveCredential: async () => { counts.credentials++; return 'synthetic-not-a-real-key'; } };
}
function noAttempt(error, code) { assert.equal(error.code, code); assert.equal(error.attemptId, undefined); assert.equal(error.usage, undefined); return true; }

test('factory rejects unbranded/spread/serialized/null budgets before any guard, credentials or fetch', async () => {
  assert.equal(typeof createModelOperationBudget, 'function');
  const h = harness(protocols[0]); let guards = 0; const accepted = budget(32000, { check: async () => { guards++; } });
  assert.ok(Object.isFrozen(accepted));
  assert.throws(() => createModelOperationBudget({ contextLimit: 0, check() {} }), { code: 'MODEL_INPUT_INVALID' });
  assert.throws(() => createModelOperationBudget({ contextLimit: 32000 }), { code: 'MODEL_INPUT_INVALID' });
  for (const operationBudget of [{ contextLimit: 32000, check() {} }, { ...accepted }, JSON.parse(JSON.stringify(accepted)), null]) {
    assert.throws(() => preflightModelRequest({ binding: h.binding, messages: prompt, operationBudget }), { code: 'MODEL_INPUT_INVALID' });
    assert.throws(() => createModelChatFunction({ ...h, operationBudget }), { code: 'MODEL_INPUT_INVALID' });
    await assert.rejects(invokeModelTurn({ ...h, messages: prompt, operationBudget }), (e) => noAttempt(e, 'MODEL_INPUT_INVALID'));
  }
  assert.equal(guards, 0); assert.equal(h.counts.credentials, 0); assert.equal(h.fetchFn.calls.length, 0);
});

test('known min(declared, explicit) is not capped at 32000; unknown min(explicit, 32000) is enforced', () => {
  const known = makeBinding(protocols[0], { contextWindow: 96000, request: { maxOutputTokens: 128 } });
  const small = makeBinding(protocols[0], { contextWindow: 8192 }); const unknown = makeBinding(protocols[0], { contextWindow: null });
  const make = (binding, contextLimit, compactMaxApproxTokens) => createModelOperationBudget({ binding, contextLimit, compactMaxApproxTokens, check() {} });
  assert.equal(make(known, undefined, 48000).contextLimit, 48000); assert.equal(make(small, 64000, 48000).contextLimit, 8192);
  assert.equal(make(unknown, 64000, 48000).contextLimit, 32000); assert.equal(make(unknown, 64000, 4096).contextLimit, 4096);
  const messages = [{ role: 'user', content: 'x'.repeat(140000) }];
  assert.doesNotThrow(() => preflightModelRequest({ binding: known, messages, operationBudget: make(known, undefined, 48000) }));
  assert.throws(() => preflightModelRequest({ binding: unknown, messages, operationBudget: budget(96000) }), { code: 'MODEL_CONTEXT_LIMIT' });
  assert.doesNotThrow(() => preflightModelRequest({ binding: unknown, messages })); // E4 unchanged.
});

for (const protocol of protocols) {
  test(`${protocol}: 65536-codepoint UTF-8 string, native tools, output reserve and actual usage`, async () => {
    const text = '😀'.repeat(65534) + '中\n'; assert.equal([...text].length, 65536); assert.equal(text.length, 131070); assert.equal(Buffer.byteLength(text), 262140);
    const h = harness(protocol, { contextWindow: 96000, request: { maxOutputTokens: 128 } }); const checks = []; const dispatches = [];
    const operationBudget = budget(48000, { attachmentSummary: { count: 1, rawBytes: 262140, selectedBytes: 262140, selectedChars: 65536, truncatedCount: 0 }, check: async (info) => checks.push(info), onDispatch: (info) => dispatches.push(info) });
    const result = await invokeModelTurn({ ...h, messages: [{ role: 'user', content: text }], tools, operationBudget }); const wire = h.fetchFn.calls[0].body;
    const sentText = protocol === protocols[0] ? wire.messages[0].content : protocol === protocols[1] ? wire.input[0].content : wire.messages[0].content[0].text;
    assert.equal(typeof sentText, 'string'); assert.ok(sentText === text, 'Exact synthetic UTF-8 text must survive encoding.');
    assert.deepEqual(protocol === protocols[0] ? wire.tools[0].function.parameters : protocol === protocols[1] ? wire.tools[0].parameters : wire.tools[0].input_schema, tools[0].parameters);
    assert.equal(protocol === protocols[1] ? wire.max_output_tokens : wire.max_tokens, 128);
    assert.equal(h.counts.credentials, 1); assert.equal(h.fetchFn.calls.length, 1); assert.equal(dispatches.length, 1); assert.equal(dispatches[0].attemptId, result.attemptId);
    assert.deepEqual(checks.map((i) => i.stage), ['prepare', 'dispatch']); const info = checks[1]; const encoded = h.fetchFn.calls[0].options.body;
    assert.equal(info.requestBytes, Buffer.byteLength(encoded)); assert.equal(info.approxInputTokens, Math.ceil(encoded.length / 4)); assert.equal(info.contextLimit, 48000); assert.equal(info.maxOutputTokens, 128);
    assert.equal(info.body, undefined); assert.equal(info.headers, undefined); assert.equal(JSON.stringify(info).includes(text), false);
    assert.equal(result.usage.source, 'actual'); assert.equal(result.usage.inputTokens, 9); assert.equal(result.usage.outputTokens, 3);
  });
  test(`${protocol}: unknown 32000 normalized exact boundary/+1, output and 4MiB UTF-8/schema budgets preflight`, async () => {
    const h = harness(protocol, { contextWindow: null, request: { maxOutputTokens: 128 } });
    const overhead = JSON.stringify({ messages: [{ role: 'user', content: '' }], tools: [] }).length; const text = 'x'.repeat((32000 - 128) * 4 - overhead);
    const messages = [{ role: 'user', content: text }]; assert.equal(Math.ceil(JSON.stringify({ messages, tools: [] }).length / 4) + 128, 32000);
    assert.doesNotThrow(() => preflightModelRequest({ binding: h.binding, messages, operationBudget: budget(64000) }));
    await assert.rejects(invokeModelTurn({ ...h, messages: [{ role: 'user', content: text + 'x' }], operationBudget: budget(64000) }), (e) => noAttempt(e, 'MODEL_CONTEXT_LIMIT'));
    await assert.rejects(invokeModelTurn({ ...h, messages: prompt, operationBudget: budget(128) }), (e) => noAttempt(e, 'MODEL_CONTEXT_LIMIT'));
    const large = harness(protocol, { contextWindow: 2000000, request: { maxOutputTokens: 1 } }); const bytes = 4194304 - overhead;
    const raw = '中'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3); const huge = [{ role: 'user', content: raw }]; assert.equal(Buffer.byteLength(JSON.stringify({ messages: huge, tools: [] })), 4194304);
    assert.doesNotThrow(() => preflightModelRequest({ binding: large.binding, messages: huge, operationBudget: budget(2000000) }));
    for (const input of [{ messages: [{ role: 'user', content: raw + 'x' }] }, { messages: huge, tools }]) await assert.rejects(invokeModelTurn({ ...large, ...input, operationBudget: budget(2000000) }), (e) => noAttempt(e, 'MODEL_LIMIT_EXCEEDED'));
    assert.equal(h.counts.credentials + large.counts.credentials, 0); assert.equal(h.fetchFn.calls.length + large.fetchFn.calls.length, 0);
  });
  test(`${protocol}: paused prepare invalidation preserves safe ATTACHMENT code before credential`, async () => {
    const h = harness(protocol); const entered = deferred(); const resume = deferred();
    const operationBudget = budget(32000, { check: async ({ stage }) => { assert.equal(stage, 'prepare'); entered.resolve(); await resume.promise; const e = new Error('DO NOT LEAK synthetic private text'); e.code = 'ATTACHMENT_REFERENCE_INVALID'; throw e; } });
    let settled = false; const running = invokeModelTurn({ ...h, messages: prompt, operationBudget }).finally(() => { settled = true; });
    await entered.promise; assert.equal(settled, false); assert.equal(h.counts.credentials, 0); resume.resolve();
    await assert.rejects(running, (e) => { noAttempt(e, 'ATTACHMENT_REFERENCE_INVALID'); assert.ok(e instanceof ModelError); assert.equal(e.message.includes('DO NOT LEAK'), false); return true; });
    assert.equal(h.counts.credentials, 0); assert.equal(h.fetchFn.calls.length, 0);
  });
  for (const cause of ['remove', 'cancel']) test(`${protocol}: paused async dispatch ${cause} has zero fetch/attempt/usage and awaited cleanup`, async () => {
    const h = harness(protocol); const entered = deferred(); const resume = deferred(); const controller = new AbortController(); const dispatches = []; const usage = [];
    const operationBudget = budget(32000, { check: async ({ stage, signal }) => { if (stage !== 'dispatch') return; entered.resolve(); await resume.promise; if (cause === 'remove') { const e = new Error('private'); e.code = 'ATTACHMENT_DELETED'; throw e; } assert.ok(signal.aborted); }, onDispatch: (info) => dispatches.push(info) });
    const modelChat = createModelChatFunction({ ...h, operationBudget, signal: controller.signal, onUsage: (event) => usage.push(event) }); let settled = false;
    const running = modelChat({ messages: prompt }).finally(() => { settled = true; }); await entered.promise; if (cause === 'cancel') controller.abort();
    await Promise.resolve(); assert.equal(settled, false); assert.equal(h.fetchFn.calls.length, 0); assert.equal(dispatches.length, 0); await assert.rejects(modelChat({ messages: prompt }), { code: 'MODEL_BUSY' });
    resume.resolve(); await assert.rejects(running, (e) => noAttempt(e, cause === 'remove' ? 'ATTACHMENT_DELETED' : 'ABORTED'));
    assert.equal(h.counts.credentials, 1); assert.equal(h.fetchFn.calls.length, 0); assert.deepEqual(dispatches, []); assert.deepEqual(usage, []);
  });
  test(`${protocol}: fixed bound budget ignores per-call override; 429 is one attempt/usage without retry`, async () => {
    const h = harness(protocol); h.fetchFn = mockFetch(jsonResponse({ error: { message: 'synthetic' } }, 429), jsonResponse(terminal(protocol))); const usage = []; const dispatches = [];
    const modelChat = createModelChatFunction({ ...h, operationBudget: budget(32000, { onDispatch: (info) => dispatches.push(info) }), onUsage: (event) => usage.push(event) });
    await assert.rejects(modelChat({ messages: prompt, operationBudget: { contextLimit: 1 } }), { code: 'MODEL_RATE_LIMITED' });
    assert.equal(h.counts.credentials, 1); assert.equal(h.fetchFn.calls.length, 1); assert.equal(dispatches.length, 1); assert.equal(usage.length, 1); assert.equal(usage[0].attemptId, dispatches[0].attemptId); assert.equal(usage[0].usage.source, 'unavailable');
  });
  test(`${protocol}: entire final wire protocol overhead is checked before credential`, async () => {
    const h = harness(protocol, { contextWindow: 2000000, request: { maxOutputTokens: 1 } }); const baseline = harness(protocol, { contextWindow: 2000000, request: { maxOutputTokens: 1 } });
    await invokeModelTurn({ ...baseline, messages: prompt, operationBudget: budget(2000000) }); const projection = JSON.stringify({ messages: prompt, tools: [] });
    assert.ok(Buffer.byteLength(baseline.fetchFn.calls[0].options.body) > Buffer.byteLength(projection));
    await assert.rejects(invokeModelTurn({ ...h, messages: prompt, request: { maxRequestBytes: Buffer.byteLength(projection) }, operationBudget: budget(2000000) }), (e) => noAttempt(e, 'MODEL_LIMIT_EXCEEDED'));
    await assert.rejects(invokeModelTurn({ ...h, messages: prompt, operationBudget: budget(Math.ceil(projection.length / 4) + 1) }), (e) => noAttempt(e, 'MODEL_CONTEXT_LIMIT'));
    assert.equal(h.counts.credentials, 0); assert.equal(h.fetchFn.calls.length, 0);
  });
}

for (const protocol of protocols) {
  test(`${protocol}: actual final wire 32000/output and 4194304 UTF-8 byte exact/+1 boundaries`, async () => {
    const request = { maxOutputTokens: 128 };
    const empty = [{ role: 'user', content: '' }];
    const base = harness(protocol, { contextWindow: null, request });
    await invokeModelTurn({ ...base, messages: empty, tools, operationBudget: budget(64000) });
    const wireUnits = base.fetchFn.calls[0].options.body.length;
    const contextText = 'x'.repeat((32000 - 128) * 4 - wireUnits);
    const exactContext = harness(protocol, { contextWindow: null, request });
    const contextMessages = [{ role: 'user', content: contextText }];
    assert.doesNotThrow(() => preflightModelRequest({ binding: exactContext.binding, messages: contextMessages, tools, operationBudget: budget(64000) }));
    const contextResult = await invokeModelTurn({ ...exactContext, messages: contextMessages, tools, operationBudget: budget(64000) });
    assert.equal(exactContext.fetchFn.calls[0].options.body.length, 127488);
    assert.equal(Math.ceil(exactContext.fetchFn.calls[0].options.body.length / 4) + 128, 32000);
    assert.equal(contextResult.usage.source, 'actual'); assert.equal(contextResult.usage.inputTokens, 9);
    const tooMuchContext = harness(protocol, { contextWindow: null, request });
    const moreContext = [{ role: 'user', content: contextText + 'x' }];
    assert.doesNotThrow(() => preflightModelRequest({ binding: tooMuchContext.binding, messages: moreContext, tools, operationBudget: budget(64000) }));
    await assert.rejects(invokeModelTurn({ ...tooMuchContext, messages: moreContext, tools, operationBudget: budget(64000) }), (e) => noAttempt(e, 'MODEL_CONTEXT_LIMIT'));
    assert.equal(tooMuchContext.counts.credentials, 0); assert.equal(tooMuchContext.fetchFn.calls.length, 0);
    const bodyBytes = 4194304 - Buffer.byteLength(base.fetchFn.calls[0].options.body);
    const byteText = '中'.repeat(Math.floor(bodyBytes / 3)) + 'x'.repeat(bodyBytes % 3);
    const exactBytes = harness(protocol, { contextWindow: 2000000, request });
    const byteMessages = [{ role: 'user', content: byteText }];
    await invokeModelTurn({ ...exactBytes, messages: byteMessages, tools, operationBudget: budget(2000000) });
    assert.equal(Buffer.byteLength(exactBytes.fetchFn.calls[0].options.body), 4194304);
    const tooManyBytes = harness(protocol, { contextWindow: 2000000, request });
    const moreBytes = [{ role: 'user', content: byteText + 'x' }];
    assert.doesNotThrow(() => preflightModelRequest({ binding: tooManyBytes.binding, messages: moreBytes, tools, operationBudget: budget(2000000) }));
    await assert.rejects(invokeModelTurn({ ...tooManyBytes, messages: moreBytes, tools, operationBudget: budget(2000000) }), (e) => noAttempt(e, 'MODEL_LIMIT_EXCEEDED'));
    assert.equal(tooManyBytes.counts.credentials, 0); assert.equal(tooManyBytes.fetchFn.calls.length, 0);
    assert.equal(exactContext.counts.credentials, 1); assert.equal(exactBytes.counts.credentials, 1);
  });
  test(`${protocol}: actual/estimated terminal usage and dispatch notification are exactly once`, async () => {
    for (const actual of [true, false]) {
      const h = harness(protocol); h.fetchFn = mockFetch(jsonResponse(terminal(protocol, actual)));
      const usage = []; const dispatches = []; const results = [];
      const modelChat = createModelChatFunction({ ...h, operationBudget: budget(32000, { onDispatch: (info) => dispatches.push(info) }), onUsage: (event) => usage.push(event), onResult: (event) => results.push(event) });
      const result = await modelChat({ messages: prompt });
      assert.equal(h.fetchFn.calls.length, 1); assert.equal(h.counts.credentials, 1);
      assert.equal(usage.length, 1); assert.equal(dispatches.length, 1); assert.equal(results.length, 1);
      assert.equal(usage[0].attemptId, dispatches[0].attemptId);
      assert.equal(usage[0].usage.source, actual ? 'actual' : 'estimated');
      assert.equal(usage[0].usage.inputTokens, actual ? 9 : Math.ceil(prompt.reduce((n, m) => n + m.content.length, 0) / 4));
      assert.equal(usage[0].usage.outputTokens, actual ? 3 : Math.ceil(result.content.length / 4));
    }
  });
}

test('pre-copy JSON accounting matches UTF-8/escapes/lone surrogates and reserves output without conflating units', () => {
  const { measureModelJson } = require('../src/ai/model-operation-budget');
  const text = '中😀\\\"\r\n\t\b\f\u0001\u2028\ud800x\udc00';
  const value = { text, omitted: undefined, nested: [null, true, false, 0, -0, 1.25, NaN, Infinity, undefined, , text] };
  const encoded = JSON.stringify(value); const tokens = Math.ceil(encoded.length / 4);
  assert.deepEqual(measureModelJson(value, { contextLimit: tokens + 128, maxOutputTokens: 128 }), { requestBytes: Buffer.byteLength(encoded), jsonCodeUnits: encoded.length, approxInputTokens: tokens });
  assert.throws(() => measureModelJson(value, { maxRequestBytes: Buffer.byteLength(encoded) - 1 }), { code: 'MODEL_LIMIT_EXCEEDED' });
  assert.throws(() => measureModelJson(value, { contextLimit: tokens + 128, maxOutputTokens: 129 }), { code: 'MODEL_CONTEXT_LIMIT' });
});

for (const contextLimit of [2048, 32000]) test(`Responses final wire includes opaque stateless annotations at ${contextLimit}`, async () => {
  const h = harness(protocols[1], { contextWindow: null, request: { maxOutputTokens: 128 } }); const raw = terminal(protocols[1]);
  raw.output[0].content[0].annotations = [{ type: 'url_citation', start_index: 0, end_index: 1, title: 'Synthetic citation', url: 'https://synthetic.invalid/' + 'x'.repeat(contextLimit === 2048 ? 12000 : 140000) }];
  h.fetchFn = mockFetch(jsonResponse(raw), jsonResponse(terminal(protocols[1]))); const usage = []; const dispatches = []; const operationBudget = budget(contextLimit, { onDispatch: (info) => dispatches.push(info) });
  const modelChat = createModelChatFunction({ ...h, operationBudget, onUsage: (event) => usage.push(event) }); const first = await modelChat({ messages: prompt });
  const messages = [...prompt, { role: 'assistant', content: first.content }, { role: 'user', content: 'Continue.' }]; assert.doesNotThrow(() => preflightModelRequest({ binding: h.binding, messages, operationBudget }));
  await assert.rejects(modelChat({ messages }), (e) => noAttempt(e, 'MODEL_CONTEXT_LIMIT')); assert.equal(h.fetchFn.calls.length, 1); assert.equal(h.counts.credentials, 1); assert.equal(dispatches.length, 1); assert.equal(usage.length, 1);
});

test('wire copy reservation metadata is exact and released after awaited reader cleanup', async () => {
  const h = harness(protocols[0]); const entered = deferred(); const done = deferred(); const reservations = []; let releases = 0; let read = false;
  const encoded = new TextEncoder().encode(JSON.stringify(chat('synthetic answer')));
  h.fetchFn = mockFetch({ status: 200, headers: new Headers(), body: { getReader() { return { async read() { if (read) return { done: true }; read = true; return { done: false, value: encoded }; }, async cancel() { entered.resolve(); await done.promise; }, releaseLock() {} }; } } });
  let settled = false; const running = invokeModelTurn({ ...h, messages: prompt, operationBudget: budget(32000, { reserveWire: async (info) => { reservations.push(info); return async () => { releases++; }; } }) }).finally(() => { settled = true; });
  await entered.promise; assert.equal(reservations.length, 1); const info = reservations[0]; assert.equal(info.stage, 'wire'); assert.equal(info.stringBytes, 2 * info.jsonCodeUnits); assert.equal(info.requestBytes, Buffer.byteLength(h.fetchFn.calls[0].options.body)); assert.equal(info.body, undefined); assert.equal(releases, 0); assert.equal(settled, false);
  done.resolve(); await running; assert.equal(releases, 1);
});

test('cancellation during wire reservation waits and releases, with no credentials or fetch', async () => {
  const h = harness(protocols[0]); const entered = deferred(); const resume = deferred(); const controller = new AbortController(); let releases = 0; let settled = false;
  const running = invokeModelTurn({ ...h, messages: prompt, signal: controller.signal, operationBudget: budget(32000, { reserveWire: async () => { entered.resolve(); await resume.promise; return async () => { releases++; }; } }) }).finally(() => { settled = true; });
  await entered.promise; controller.abort(); await Promise.resolve(); assert.equal(settled, false); resume.resolve();
  await assert.rejects(running, (e) => noAttempt(e, 'ABORTED')); assert.equal(releases, 1); assert.equal(h.counts.credentials, 0); assert.equal(h.fetchFn.calls.length, 0);
});

test('transport awaits context.check and independently rechecks signal after await', async () => {
  const { createRequestContext, postJson } = require('../src/ai/model-adapters/transport'); const { LIMITS } = require('../src/ai/model-adapters/common');
  const controller = new AbortController(); const context = createRequestContext({ signal: controller.signal, timeoutMs: 10000, limits: LIMITS }); const original = context.check.bind(context); const entered = deferred(); const resume = deferred(); let fetches = 0; let attempts = 0;
  context.check = (info) => info?.stage === 'dispatch' ? (async () => { entered.resolve(); await resume.promise; })() : original(info);
  const running = postJson({ url: 'https://synthetic.invalid/dispatch', body: { text: 'synthetic' }, headers: {}, context, fetchFn: async () => { fetches++; return jsonResponse({ ok: true }); }, onAttempt: () => { attempts++; } });
  await entered.promise; controller.abort(); resume.resolve(); await assert.rejects(running, { code: 'ABORTED' }); await context.dispose(); assert.equal(fetches, 0); assert.equal(attempts, 0);
});

test('guard deadline remains connected until guard cleanup; no credential/fetch/usage', async () => {
  const h = harness(protocols[0]); const entered = deferred(); const resume = deferred(); const usage = []; let settled = false;
  const modelChat = createModelChatFunction({ ...h, operationBudget: budget(32000, { check: async ({ stage, signal }) => { if (stage !== 'prepare') return; entered.resolve(signal); await resume.promise; } }), onUsage: (event) => usage.push(event) });
  const running = modelChat({ messages: prompt, timeoutMs: 30 }).finally(() => { settled = true; }); const signal = await entered.promise;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); assert.equal(signal.reason.code, 'MODEL_TIMEOUT'); assert.equal(settled, false); resume.resolve();
  await assert.rejects(running, (e) => noAttempt(e, 'MODEL_TIMEOUT')); assert.equal(h.counts.credentials, 0); assert.equal(h.fetchFn.calls.length, 0); assert.deepEqual(usage, []);
});
