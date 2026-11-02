'use strict';
// Every endpoint, credential, GitHub response and snapshot in this file is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const networkFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Synthetic fixture: global network is prohibited'); };
test.after(() => { globalThis.fetch = networkFetch; });
const { runAudit, TOOLS } = require('../src/ai/pr-audit-runtime');
const { runRecheck } = require('../src/ai/pr-audit-recheck-runtime');
const { createPrAuditManager } = require('../src/ai/pr-audit-manager');
const { PrAuditStore, durableRecord } = require('../src/ai/pr-audit-store');
const { PrAuditRecheckStore } = require('../src/ai/pr-audit-recheck-store');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createModelChatFunction } = require('../src/ai/llm-client');
const { publicModelSource } = require('../src/ai/model-runtime');
const { makeBinding, jsonResponse, mockFetch, chat } = require('./fixtures/e4-models/synthetic');
const { recheckFixture } = require('./helpers/pr-audit-recheck-fixture');
const A = require('../src/ai/pr-audit-state');
const report = { summary: 'Synthetic read-only audit; no tests or publication performed.', findings: [] };
const apiSettings = () => ({ mode: 'api', agentEnabled: true, compactMaxApproxTokens: 24000 });
const legacySettings = () => ({ ...apiSettings(), apiKey: 'synthetic-not-a-real-key', model: 'synthetic-legacy-model' });
const msg = (content = JSON.stringify(report), extra = {}) => ({ role: 'assistant', content, ...extra });
const native = (name, args = {}) => ({ id: `synthetic_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const fence = (name, args) => `\`\`\`tool ${name}\n${JSON.stringify(args)}\n\`\`\``;
function deferred(t) {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t?.after(() => resolve());
  return { promise, resolve, reject };
}
function snapshot(source = {}) {
  const reads = []; const lists = []; const searches = [];
  const file = { path: 'src/synthetic.js', oldPath: 'src/synthetic.js', patch: '@@ -1 +1 @@\n-old\n+new\n',
    hunks: [{ leftStart: 1, leftCount: 1, rightStart: 1, rightCount: 1, changedLeft: [1], changedRight: [1] }] };
  return { source: { repoKey: 'a'.repeat(64), prNumber: 7, headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), mergeBaseSha: 'c'.repeat(40),
    headRefName: 'synthetic-feature', baseRefName: 'main', descriptionHash: 'd'.repeat(64), prefix: '', title: 'Synthetic PR', body: '', ...source },
  files: [file], coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] }, reads, lists, searches,
  consume: (v) => v, init: async () => {}, cleanup: async () => {},
  read: async (args) => { reads.push(args); return { path: args.path, content: 'SYNTHETIC_SNAPSHOT_CODE' }; },
  list: async (args) => { lists.push(args); return { files: [file.path] }; },
  search: async (args) => { searches.push(args); return { matches: [] }; } };
}
function accepted(binding = makeBinding('openai-chat-completions', { authKind: 'none', kind: 'pr-audit' }), extra = {}) {
  return { binding, chatFn: async () => msg(), modelSource: publicModelSource(binding), release: () => {}, ...extra };
}
function auditFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-audit-synthetic-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const events = []; const snapshots = []; const operations = [];
  const github = {
    getCiWatchRepository: async () => ({ ok: true, repository: { repoRoot: root, repoKey: 'a'.repeat(64), nameWithOwner: 'synthetic/repository' } }),
    getAuditPr: async () => ({ number: 7, baseRepo: 'synthetic/repository', headRepo: 'synthetic/repository', state: 'open', merged: false,
      headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), headRefName: 'synthetic-feature', baseRefName: 'main', changedFiles: 1, title: 'Synthetic PR', body: '' }),
    getAuditFiles: async () => [], getAuditMergeBase: async () => 'c'.repeat(40),
    runCommand: async (command, args) => { operations.push([command, args]); return { code: 0, stdout: '', stderr: '' }; },
  };
  const manager = createPrAuditManager({ githubCli: github, getSettings: apiSettings, onEvent: (event) => events.push(event),
    snapshotFactory: (args) => { const s = snapshot(args.source); snapshots.push(s); return s; }, ...options });
  t.after(async () => { manager.close(); await Promise.all([...manager.runs.values()].map((r) => r.done)); });
  return { root, manager, github, events, snapshots, operations };
}
async function done(f, out) { await f.manager.runs.get(out.auditRef)?.done; return f.manager.row(f.root, out.auditRef); }
function unreadableLegacyAliases(settings) {
  for (const key of ['apiKey', 'baseUrl', 'model']) Object.defineProperty(settings, key, { enumerable: true, configurable: true,
    get() { throw new Error(`Forbidden legacy settings access: ${key}`); } });
  return settings;
}

test('E4 audit runtime accepts a branded no-auth binding without reading legacy settings authority', async () => {
  const binding = makeBinding('openai-chat-completions', { authKind: 'none', kind: 'pr-audit' }); const s = snapshot(); let seen;
  const result = await runAudit({ snapshot: s, settings: unreadableLegacyAliases(apiSettings()), modelBinding: binding,
    chatFn: async (options) => { seen = options; return msg(); } });
  assert.equal(result.report.summary, report.summary); assert.equal(seen.modelBinding, binding);
  for (const key of ['apiKey', 'baseUrl', 'model', 'fetchFn', 'onEvent', 'onUsage']) assert.equal(Object.hasOwn(seen, key), false);
  assert.deepEqual(seen.tools.map((tool) => tool.function.name), TOOLS.map((tool) => tool.function.name));
  assert.equal(Object.isFrozen(seen.tools), true); assert.equal(Object.isFrozen(seen.tools[0].function.parameters), true);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, estimated: false, source: 'unavailable' });
});

test('E4 bound runtime missing controlled chat fails explicitly without global transport', async () => {
  await assert.rejects(runAudit({ snapshot: snapshot(), settings: legacySettings(), modelBinding: makeBinding() }), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
});

test('E4 runtime rejects unbranded and serialized bindings without calling injected chat', async () => {
  let calls = 0;
  for (const binding of [{ protocol: 'openai-chat-completions' }, structuredClone(makeBinding())]) {
    await assert.rejects(runAudit({ snapshot: snapshot(), settings: legacySettings(), modelBinding: binding,
      chatFn: async () => { calls++; return msg(); } }), { code: 'MODEL_BINDING_INVALID' });
  }
  assert.equal(calls, 0);
});

test('E4 native mode ignores text-fenced snapshot tool requests', async () => {
  const s = snapshot(); let calls = 0;
  const result = await runAudit({ snapshot: s, settings: apiSettings(), modelBinding: makeBinding(),
    chatFn: async () => ++calls === 1 ? msg(fence('review_read_file', { path: 'src/synthetic.js' })) : msg() });
  assert.equal(s.reads.length, 0); assert.equal(result.turns, 2); assert.equal(calls, 2);
});

test('E4 text-compat executes only explicitly fenced snapshot tools, not native tool_calls', async () => {
  const s = snapshot(); let calls = 0;
  const result = await runAudit({ snapshot: s, settings: apiSettings(), modelBinding: makeBinding('openai-chat-completions', { compatibility: { toolMode: 'text-compat' } }),
    chatFn: async () => ++calls === 1 ? msg(fence('review_read_file', { path: 'src/synthetic.js' }), { tool_calls: [native('review_search', { query: 'synthetic' })] })
      : msg(fence('submit_review', report)) });
  assert.equal(s.reads.length, 1); assert.equal(s.searches.length, 0); assert.equal(result.turns, 2);
});

test('E4 none mode advertises no tools and executes neither native nor text-fenced calls', async () => {
  const s = snapshot(); let calls = 0;
  const result = await runAudit({ snapshot: s, settings: apiSettings(), modelBinding: makeBinding('openai-chat-completions', { compatibility: { toolMode: 'none' } }),
    chatFn: async ({ tools }) => { assert.deepEqual(tools, []); return ++calls === 1 ? msg(fence('review_read_file', { path: 'src/synthetic.js' }),
      { tool_calls: [native('review_search', { query: 'synthetic' })] }) : msg(); } });
  assert.equal(s.reads.length + s.searches.length, 0); assert.equal(result.turns, 2);
});

test('E4 bound native snapshot schemas reject wrong types and broad assistant tools', async () => {
  const s = snapshot(); let calls = 0; let history;
  await runAudit({ snapshot: s, settings: apiSettings(), modelBinding: makeBinding(),
    chatFn: async ({ messages, tools }) => { history = messages; assert.equal(tools.some((t) => t.function.name === 'run_terminal'), false);
      return ++calls === 1 ? msg(null, { tool_calls: [native('review_read_file', { path: 'src/synthetic.js', offset: '1' }), native('run_terminal', { command: 'synthetic' })] })
        : msg(null, { tool_calls: [native('submit_review', report)] }); } });
  assert.equal(s.reads.length, 0); assert.equal(history.filter((m) => m.role === 'tool').length, 2);
});

test('E4 bound snake_case length finish rejects even a syntactically valid final report', async () => {
  await assert.rejects(runAudit({ snapshot: snapshot(), settings: apiSettings(), modelBinding: makeBinding(),
    chatFn: async () => msg(JSON.stringify(report), { finish_reason: 'length' }) }), { code: 'PR_AUDIT_REPORT_INVALID' });
});

test('E4 bound context and correction budgets remain enforced before further model calls', async () => {
  let calls = 0;
  await assert.rejects(runAudit({ snapshot: snapshot(), settings: { ...apiSettings(), compactMaxApproxTokens: 1 }, modelBinding: makeBinding(),
    chatFn: async () => { calls++; return msg(); } }), { code: 'PR_AUDIT_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  await assert.rejects(runAudit({ snapshot: snapshot(), settings: apiSettings(), modelBinding: makeBinding(),
    chatFn: async () => { calls++; return msg('invalid synthetic report'); } }), { code: 'PR_AUDIT_REPORT_INVALID' });
  assert.equal(calls, 2);
});

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  test(`E4 audit uses the ${protocol} controlled wrapper exactly once with synthetic transport`, async () => {
    const binding = makeBinding(protocol, { ...(protocol === 'anthropic-messages' ? {} : { authKind: 'none' }), kind: 'pr-audit' }); const usage = [];
    const body = protocol === 'openai-chat-completions' ? chat(JSON.stringify(report)) : protocol === 'openai-responses'
      ? { id: 'synthetic-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(report) }] }], usage: { input_tokens: 9, output_tokens: 3 } }
      : { id: 'synthetic-message', type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(report) }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } };
    const fetchFn = mockFetch(jsonResponse(body));
    const chatFn = createModelChatFunction({ binding, fetchFn, resolveCredential: async () => 'synthetic-not-a-real-key', onUsage: (e) => usage.push(e) });
    const result = await runAudit({ snapshot: snapshot(), settings: unreadableLegacyAliases(apiSettings()), modelBinding: binding, chatFn });
    assert.equal(result.report.summary, report.summary); assert.equal(fetchFn.calls.length, 1); assert.equal(usage.length, 1);
    assert.equal(new URL(fetchFn.calls[0].url).hostname, 'synthetic.invalid');
    assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 3, estimated: false, source: 'actual' });
  });
}

test('E4 bound HTTP 400 mentioning tools does not resend or downgrade and wrapper alone records unknown usage', async () => {
  const binding = makeBinding('openai-chat-completions', { authKind: 'none' }); const usage = [];
  const fetchFn = mockFetch(jsonResponse({ error: { message: 'Synthetic tools stream_options unsupported error' } }, 400));
  const chatFn = createModelChatFunction({ binding, fetchFn, resolveCredential: async () => 'synthetic-not-a-real-key', onUsage: (e) => usage.push(e) });
  await assert.rejects(runAudit({ snapshot: snapshot(), settings: legacySettings(), modelBinding: binding, chatFn }), { code: 'MODEL_BAD_REQUEST' });
  assert.equal(fetchFn.calls.length, 1); assert.equal(usage.length, 1); assert.equal(usage[0].usage.source, 'unavailable');
});

test('E4 audit manager fixes callback binding and public source synchronously through snapshot cleanup', async (t) => {
  const binding = makeBinding('openai-chat-completions', { authKind: 'none', kind: 'pr-audit' }); const cleanupEntered = deferred(t); const cleanupGate = deferred(t);
  const source = { ...publicModelSource(binding), providerName: 'Synthetic accepted provider', endpoint: 'https://synthetic.invalid/gateway/v1?synthetic-secret=hidden#hidden', apiKey: 'do-not-persist', request: { synthetic: true } };
  const settings = unreadableLegacyAliases(apiSettings()); let calls = 0; let releases = 0; let runtimeOptions; let callbackArgs;
  const f = auditFixture(t, { getSettings: () => settings, acceptBoundModel: (args) => { callbackArgs = args; calls++; return accepted(binding, { modelSource: source, release: () => releases++ }); },
    runtime: async (options) => { runtimeOptions = options; return { report, turns: 1 }; },
    snapshotFactory: (args) => { const s = snapshot(args.source); s.cleanup = async () => { cleanupEntered.resolve(); await cleanupGate.promise; }; return s; } });
  const context = { ownerId: 7, projectBindingId: 'synthetic_project', isCurrent: () => true, signal: new AbortController().signal, modelBinding: binding };
  const pending = f.manager.start(f.root, 7, '', context);
  assert.equal(calls, 1); assert.equal(callbackArgs.kind, 'pr-audit'); assert.ok(A.isRef(callbackArgs.taskId)); assert.equal(callbackArgs.context, context);
  const out = await pending; assert.equal(out.ok, true); const record = f.manager.runs.get(out.auditRef);
  source.providerName = 'Synthetic later default'; settings.compactMaxApproxTokens = 1;
  await cleanupEntered.promise;
  assert.equal(releases, 0); assert.equal(runtimeOptions.modelBinding, binding); assert.equal(runtimeOptions.settings.compactMaxApproxTokens, 24000);
  assert.equal(out.modelSource.providerName, 'Synthetic accepted provider'); assert.equal(out.modelSource.endpoint, 'https://synthetic.invalid/gateway/v1');
  const row = f.manager.row(f.root, out.auditRef); assert.equal(row.modelSource.providerName, out.modelSource.providerName); assert.equal(row.model, binding.model);
  assert.equal(Object.hasOwn(row.modelSource, 'apiKey'), false); assert.equal(Object.hasOwn(row.modelSource, 'request'), false);
  assert.ok(f.events.every((e) => e.modelSource?.providerName === out.modelSource.providerName));
  assert.equal(f.manager.list(f.root).audits[0].modelSource.bindingRevision, binding.bindingRevision);
  assert.equal(f.manager.get(f.root, out.auditRef).audit.modelSource.bindingRevision, binding.bindingRevision);
  assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null, estimated: false, source: 'unavailable' });
  cleanupGate.resolve(); await record.done; assert.equal(releases, 1); assert.equal(f.manager.runs.size, 0); assert.equal(f.manager.taskPool.tasks.size, 0);
});

test('E4 manager rejects a different callback binding when a branded session binding is inherited', async (t) => {
  const inherited = makeBinding(); const different = makeBinding(); let releases = 0;
  const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: () => accepted(different, { release: () => releases++ }) });
  const out = await f.manager.start(f.root, 7, '', { modelBinding: inherited });
  assert.equal(out.code, 'MODEL_BINDING_INVALID'); assert.equal(releases, 1); assert.equal(f.snapshots.length, 0); assert.equal(f.manager.taskPool.tasks.size, 0);
});

test('E4 callback malformed binding or missing controlled chat is rejected and released before capture', async (t) => {
  for (const [value, code] of [[{ binding: structuredClone(makeBinding()), chatFn: async () => msg() }, 'MODEL_BINDING_INVALID'],
    [{ binding: makeBinding() }, 'MODEL_BOUND_CHAT_REQUIRED']]) {
    let releases = 0;
    const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: () => ({ ...value, release: () => releases++ }) });
    const out = await f.manager.start(f.root, 7);
    assert.equal(out.code, code); assert.equal(releases, 1); assert.equal(f.snapshots.length, 0);
  }
});

test('E4 callback must be synchronous and never accepts a Promise binding', async (t) => {
  const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: async () => accepted() });
  const out = await f.manager.start(f.root, 7); assert.equal(out.code, 'MODEL_BINDING_INVALID'); assert.equal(f.snapshots.length, 0);
});

test('E4 binding release is idempotent even when initial store save fails', async (t) => {
  let releases = 0;
  const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: () => accepted(undefined, { release: () => releases++ }),
    store: { put: () => { throw A.fail('STORE_MEMORY'); }, close() {} } });
  const out = await f.manager.start(f.root, 7);
  assert.equal(out.code, 'PR_AUDIT_STORE_MEMORY'); assert.equal(releases, 1); assert.equal(f.manager.taskPool.tasks.size, 0); assert.equal(f.manager.runs.size, 0);
});

test('E4 failed snapshot initialization retains binding until its own cleanup has finished', async (t) => {
  const entered = deferred(t); const gate = deferred(t); let releases = 0;
  const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: () => accepted(undefined, { release: () => releases++ }),
    snapshotFactory: (args) => ({ ...snapshot(args.source), init: async () => { throw A.fail('INCOMPLETE'); }, cleanup: async () => { entered.resolve(); await gate.promise; } }) });
  const out = await f.manager.start(f.root, 7); assert.equal(out.ok, true); const record = f.manager.runs.get(out.auditRef);
  await entered.promise; assert.equal(releases, 0); gate.resolve(); await record.done;
  assert.equal(releases, 1); assert.equal(f.manager.row(f.root, out.auditRef).status, 'failed');
});

test('E4 independent audit cancellation retains binding until cleanup rather than chat lease release', async (t) => {
  const entered = deferred(t); const gate = deferred(t); const running = deferred(t); let releases = 0;
  const f = auditFixture(t, { getSettings: legacySettings, acceptBoundModel: () => accepted(undefined, { release: () => releases++ }),
    runtime: async ({ signal }) => { running.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(A.fail('CANCELLED')), { once: true })); },
    snapshotFactory: (args) => ({ ...snapshot(args.source), cleanup: async () => { entered.resolve(); await gate.promise; } }) });
  const out = await f.manager.start(f.root, 7); assert.equal(out.ok, true); const record = f.manager.runs.get(out.auditRef);
  await running.promise; assert.equal(f.manager.cancel(f.root, out.auditRef).ok, true); await entered.promise; assert.equal(releases, 0);
  gate.resolve(); await record.done; assert.equal(releases, 1); assert.equal(f.manager.row(f.root, out.auditRef).status, 'cancelled');
});

test('E4 mode api and existing agentEnabled remain mandatory despite configured callback', async (t) => {
  let calls = 0;
  for (const settings of [{ mode: 'local', agentEnabled: true }, { mode: 'api', agentEnabled: false }]) {
    const f = auditFixture(t, { getSettings: () => settings, acceptBoundModel: () => { calls++; return accepted(); } });
    assert.equal((await f.manager.start(f.root, 7)).code, 'PR_AUDIT_MODEL_REQUIRED');
  }
  assert.equal(calls, 0);
});

test('E4 explicit legacy runtime injection remains available but never invents modelSource', async (t) => {
  const f = auditFixture(t, { getSettings: legacySettings, runtime: async () => ({ report, turns: 1 }) });
  const out = await f.manager.start(f.root, 7); assert.equal(out.ok, true); const row = await done(f, out);
  assert.equal(row.status, 'completed'); assert.equal(row.model, legacySettings().model); assert.equal(Object.hasOwn(row, 'modelSource'), false);
  assert.equal(Object.hasOwn(f.manager.get(f.root, out.auditRef).audit, 'modelSource'), false);
});

test('E4 recheck fixes callback before delivery resolution await and never changes the original audit', async (t) => {
  const binding = makeBinding('openai-chat-completions', { authKind: 'none', kind: 'pr-audit-recheck' }); const resolution = deferred(t); let calls = 0; let releases = 0; let seen;
  const f = await recheckFixture(t, { acceptBoundModel: (args) => { seen = args; calls++; return accepted(binding, { release: () => releases++ }); } });
  f.audits.getSettings = () => unreadableLegacyAliases(apiSettings()); const original = f.audits.row(f.root, f.row.auditRef);
  const resolve = f.rechecks.resolve.bind(f.rechecks); f.rechecks.resolve = async (...args) => { await resolution.promise; return resolve(...args); };
  const context = { ownerId: 7, projectBindingId: 'synthetic_project', isCurrent: () => true, modelBinding: binding };
  const pending = f.rechecks.start(f.root, f.marker.id, context);
  assert.equal(calls, 1); assert.equal(seen.kind, 'pr-audit-recheck'); assert.equal(seen.context, context); resolution.resolve();
  const out = await pending; assert.equal(out.ok, true); assert.equal(out.modelSource.bindingRevision, binding.bindingRevision);
  const row = await f.done(out); assert.equal(row.status, 'completed'); assert.equal(releases, 1); assert.equal(row.modelSource.bindingRevision, binding.bindingRevision);
  assert.deepEqual(row.usage, { inputTokens: null, outputTokens: null, estimated: false, source: 'unavailable' });
  assert.deepEqual(f.audits.row(f.root, f.row.auditRef), original);
  assert.ok(f.recheckEvents.every((e) => e.modelSource?.bindingRevision === binding.bindingRevision));
  assert.equal((await f.rechecks.list(f.root)).rechecks[0].modelSource.bindingRevision, binding.bindingRevision);
});

test('E4 recheck inherits audit callback and releases binding when pre-accept delivery validation fails', async (t) => {
  let calls = 0; let releases = 0; let kind;
  const f = await recheckFixture(t); f.audits.acceptBoundModel = (args) => { calls++; kind = args.kind; return accepted(undefined, { release: () => releases++ }); };
  // Inheritance must also work when the parent manager is configured before the recheck starts.
  const out = await f.rechecks.start(f.root, 'invalid-result');
  assert.equal(out.code, 'PR_AUDIT_INVALID'); assert.equal(calls, 1); assert.equal(kind, 'pr-audit-recheck'); assert.equal(releases, 1);
  assert.equal(f.audits.taskPool.tasks.size, 0);
});

test('E4 IPC forwards host sender and only branded host binding before any asynchronous preparation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-ipc-synthetic-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const binding = makeBinding(); const sender = { id: 7, isDestroyed: () => false }; let calls = 0; let seen; let source;
  const handlers = createEngineeringIpcHandlers({ getSettings: apiSettings,
    resolveBinding: () => ({ projectPath: root, modelBinding: binding }),
    acceptBoundModel: (args) => { calls++; seen = args; source = accepted(binding); return source; },
    worktreeManager: { list: async () => ({ ok: true, results: [] }) }, githubCli: {
      getCiWatchRepository: async () => ({ ok: false }), runCommand: async () => ({ code: 0, stdout: '' }),
    } });
  t.after(() => handlers.close()); const event = { sender }; const payload = { projectBindingId: 'pb_11111111111111111111111111111111', prNumber: 7 };
  const pending = handlers.prAuditStart(event, payload);
  assert.equal(calls, 1); assert.equal(seen.context.sender, sender); assert.equal(seen.context.ownerId, 7); assert.equal(seen.context.projectBindingId, payload.projectBindingId);
  assert.equal(seen.context.modelBinding, binding); assert.equal(typeof seen.context.isCurrent, 'function'); assert.ok(seen.context.signal instanceof AbortSignal);
  const out = await pending; assert.equal(out.ok, true); assert.equal(out.modelSource.bindingRevision, binding.bindingRevision);
  await handlers.prAuditRecheckManager.audits.runs.get(out.auditRef)?.done;
  assert.equal((await handlers.prAuditStart(event, { ...payload, sender })).code, 'PR_AUDIT_INVALID');
  assert.equal((await handlers.prAuditStart(event, { ...payload, modelBinding: structuredClone(binding) })).code, 'PR_AUDIT_INVALID');
  assert.equal(calls, 1);
});

test('E4 IPC ignores an unbranded modelBinding supplied by host project metadata', async (t) => {
  const f = auditFixture(t, { getSettings: legacySettings, runtime: async () => ({ report, turns: 1 }) }); let context;
  const start = f.manager.start.bind(f.manager); f.manager.start = (...args) => { context = args[3]; return start(...args); };
  const handlers = createEngineeringIpcHandlers({ prAuditManager: f.manager, resolveBinding: () => ({ projectPath: f.root, modelBinding: structuredClone(makeBinding()) }),
    worktreeManager: { list: async () => ({ ok: true, results: [] }) } }); t.after(() => handlers.close());
  const out = await handlers.prAuditStart({ sender: { id: 7, isDestroyed: () => false } }, { projectBindingId: 'pb_11111111111111111111111111111111', prNumber: 7 });
  assert.equal(out.ok, true); assert.equal(Object.hasOwn(context, 'modelBinding'), false); await done(f, out);
});

test('E4 recheck text-compat prompt and execution use only the fixed recheck tool directory', async (t) => {
  const binding = makeBinding('openai-chat-completions', { authKind: 'none', kind: 'pr-audit-recheck', compatibility: { toolMode: 'text-compat' } });
  let f; let turns = 0; let instructions;
  f = await recheckFixture(t, { runtime: runRecheck, acceptBoundModel: () => accepted(binding, { chatFn: async ({ messages, tools }) => {
    assert.deepEqual(tools.map((tool) => tool.function.name), ['recheck_read_file', 'recheck_list_files', 'recheck_search', 'submit_recheck']);
    if (++turns === 1) { instructions = messages[0].content; return msg(fence('recheck_read_file', { path: 'src/app.js', stage: 'target' })); }
    const evidence = [...f.snapshots[0].evidence.keys()];
    return msg(fence('submit_recheck', { summary: 'Offline recheck evidence verified.', findings: f.item.findingIds.map((findingId) => ({
      findingId, status: 'resolved', reason: 'Offline target fixture verifies the original trigger.', evidence,
    })) }));
  } }) });
  const out = await f.rechecks.start(f.root, f.marker.id); assert.equal(out.ok, true);
  const row = await f.done(out); assert.equal(row.status, 'completed', row.errorCode); assert.equal(turns, 2);
  assert.match(instructions, /使用显式 ```tool recheck_read_file\n/); assert.doesNotMatch(instructions, /使用显式 ```tool review_read_file\n/);
});

for (const kind of ['audit', 'recheck']) {
  test(`E4 ${kind} retainUntilFinished failure releases binding and caller resources before scheduling`, async (t) => {
    let releases = 0; let ownerReleases = 0;
    const options = { acceptBoundModel: () => accepted(undefined, { release: () => releases++ }) };
    const f = kind === 'audit' ? auditFixture(t, options) : await recheckFixture(t, options);
    const manager = kind === 'audit' ? f.manager : f.rechecks;
    const pool = kind === 'audit' ? manager.taskPool : f.audits.taskPool;
    const signal = new AbortController().signal;
    const context = { signal, retainUntilFinished: () => { throw A.fail('STORE_MEMORY'); }, release: () => ownerReleases++ };
    const out = kind === 'audit' ? await manager.start(f.root, 7, '', context) : await manager.start(f.root, f.marker.id, context);
    assert.equal(out.code, 'PR_AUDIT_STORE_MEMORY'); assert.equal(releases, 1); assert.equal(ownerReleases, 1);
    assert.equal(manager.runs.size, 0); assert.equal(pool.tasks.size, 0); assert.equal(f.snapshots.length, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal(manager.store.list()[0].status, 'failed');
  });

  test(`E4 ${kind} persistence metadata failure releases binding without starting a snapshot task`, async (t) => {
    let releases = 0;
    const options = { acceptBoundModel: () => accepted(undefined, { release: () => releases++ }) };
    const f = kind === 'audit' ? auditFixture(t, options) : await recheckFixture(t, options);
    const manager = kind === 'audit' ? f.manager : f.rechecks;
    const pool = kind === 'audit' ? manager.taskPool : f.audits.taskPool;
    manager.store.persistenceStatus = () => { throw A.fail('STORE_MEMORY'); };
    const signal = new AbortController().signal;
    const out = kind === 'audit' ? await manager.start(f.root, 7, '', { signal }) : await manager.start(f.root, f.marker.id, { signal });
    assert.equal(out.code, 'PR_AUDIT_STORE_MEMORY'); assert.equal(releases, 1);
    assert.equal(manager.runs.size, 0); assert.equal(pool.tasks.size, 0); assert.equal(f.snapshots.length, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal(manager.store.list()[0].status, 'failed');
  });
}

test('E4 audit and recheck stores persist only public callback source and nullable unknown usage with old-record compatibility', async (t) => {
  const binding = makeBinding(); const modelSource = { ...publicModelSource(binding), endpoint: 'https://synthetic.invalid/v1?hidden=1#hidden', apiKey: 'DO_NOT_STORE', auth: { synthetic: 'secret' } };
  const usage = { inputTokens: null, outputTokens: null, estimated: false, source: 'unavailable' };
  const raw = { auditRef: A.ref(), projectKey: 'a'.repeat(64), prNumber: 7, createdAt: '2026-10-29T00:00:00.000Z', status: 'failed', modelSource, usage };
  const row = durableRecord(raw); assert.equal(row.modelSource.endpoint, 'https://synthetic.invalid/v1'); assert.equal(Object.hasOwn(row.modelSource, 'apiKey'), false);
  assert.equal(Object.hasOwn(row.modelSource, 'auth'), false); assert.deepEqual(row.usage, usage);
  const old = durableRecord({ ...raw, modelSource: undefined, usage: undefined }); assert.equal(Object.hasOwn(old, 'modelSource'), false);
  const auditStore = new PrAuditStore(); auditStore.put(raw); assert.deepEqual(auditStore.get(raw.auditRef, raw.projectKey), row);
  const f = await recheckFixture(t); const out = await f.rechecks.start(f.root, f.marker.id); const historic = await f.done(out);
  const store = new PrAuditRecheckStore(); const recheck = store.put({ ...historic, modelSource, usage });
  assert.deepEqual(recheck.usage, usage); assert.equal(recheck.modelSource.endpoint, 'https://synthetic.invalid/v1'); assert.equal(Object.hasOwn(recheck.modelSource, 'apiKey'), false);
  assert.equal(Object.hasOwn(store.put({ ...historic, modelSource: undefined }), 'modelSource'), false);
});
