'use strict';
// Real main/engineering acceptance and router. Settings, vault, snapshots and wire are synthetic only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createPrAuditManager } = require('../src/ai/pr-audit-manager');
const { PrAuditRecheckManager } = require('../src/ai/pr-audit-recheck-manager');
const { PrAuditStore } = require('../src/ai/pr-audit-store');
const { PrAuditRecheckStore } = require('../src/ai/pr-audit-recheck-store');
const { validateModelRegistry, resolveModelBinding, saveProfile } = require('../src/ai/model-profiles');
const { runAudit, TOOLS: AUDIT_TOOLS } = require('../src/ai/pr-audit-runtime');
const { runRecheck, TOOLS: RECHECK_TOOLS } = require('../src/ai/pr-audit-recheck-runtime');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
const { loadMainFixture, syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');
const A = require('../src/ai/pr-audit-state');
const R = require('../src/ai/pr-audit-recheck-state');
const protocols = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'];
const report = { summary: 'Synthetic read-only audit. No tests or publication performed.', findings: [] };
function registryFor(protocol = protocols[0], { toolMode = 'native', nativeTools = 'supported', authKind = protocol === 'anthropic-messages' ? 'api-key' : 'none' } = {}) {
  const registry = syntheticRegistry({ authKind: authKind === 'api-key' ? 'none' : authKind }); registry.providers[0].protocol = protocol;
  if (protocol === 'anthropic-messages' && authKind === 'api-key') registry.providers[0].auth = {
    kind: 'api-key', secretRef: 'audit-private-test-key', credentialRevision: 1, credentialOrigin: new URL(registry.providers[0].baseUrl).origin };
  registry.models[0].compatibility.toolMode = toolMode;
  for (const name of ['text', 'nativeTools', 'usage']) registry.models[0].capabilities[name] = {
    state: name === 'nativeTools' ? nativeTools : 'supported', source: name === 'nativeTools' && nativeTools === 'unknown' ? 'unknown' : 'declared' };
  return validateModelRegistry(registry);
}
function wire(protocol, value) {
  const content = JSON.stringify(value);
  const body = protocol === protocols[0]
    ? { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    : protocol === protocols[1]
      ? { id: 'resp_synthetic_audit', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 12, output_tokens: 3 } }
      : { id: 'msg_synthetic_audit', type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
function snapshot() {
  const file = { path: 'src/synthetic.js', oldPath: 'src/synthetic.js', patch: '@@ -1 +1 @@\n-old\n+new\n',
    hunks: [{ leftStart: 1, leftCount: 1, rightStart: 1, rightCount: 1, changedLeft: [1], changedRight: [1] }] };
  return { source: { repoKey: 'a'.repeat(64), prNumber: 7, headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), mergeBaseSha: 'c'.repeat(40),
    headRefName: 'synthetic-feature', baseRefName: 'main', descriptionHash: 'd'.repeat(64), prefix: '', title: 'Synthetic PR', body: '', changedFiles: 1 },
  files: [file], coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] }, consume: value => value,
  init: async () => {}, cleanup: async () => {}, read: async () => ({}), list: async () => ({}), search: async () => ({}) };
}
function fixture(t, options = {}) {
  let config; let audits; let rechecks; let bound; let root; let inheritedBinding;
  const captures = []; const contexts = []; const snapshots = [];
  const source = R.source({ auditRef: A.ref(), auditRepairRef: A.ref('par'), resultId: 'wt_SyntheticAuditResult0123456789abcdef', repoKey: 'a'.repeat(64),
    prNumber: 7, prefix: '', headRefName: 'synthetic-feature', baseRefName: 'main', originalHead: 'b'.repeat(40), originalBase: 'c'.repeat(40),
    repairCommit: 'd'.repeat(40), expectedTree: 'e'.repeat(40), repairRevision: 'f'.repeat(64), findingIds: [A.ref('paf')] });
  const findings = [{ findingId: source.findingIds[0], body: 'Synthetic original finding.' }];
  const recheckReport = { summary: 'Synthetic recheck; evidence unavailable.', findings: [{ findingId: source.findingIds[0], status: 'unknown',
    reason: 'Synthetic snapshot does not establish the original trigger.', evidence: [] }] };
  const engineering = { createEngineeringIpcHandlers: args => {
    config = args; root = args.userDataPath;
    audits = createPrAuditManager({ getSettings: args.getSettings, acceptBoundModel: args.acceptBoundModel, store: new PrAuditStore(),
      onEvent: event => args.onPrAuditEvent?.(event, [1]) });
    audits.capture = async (_root, _number, _ref, context) => {
      captures.push({ kind: 'pr-audit', context }); await options.beforeCapture?.(context); A.assertCurrent(context);
      const s = snapshot(); snapshots.push(s); s.cleanup = async () => options.beforeCleanup?.(); return s;
    };
    audits.fresh = async () => ({ source: snapshot().source });
    rechecks = new PrAuditRecheckManager({ auditManager: audits, store: new PrAuditRecheckStore(), auditRepairManager: {}, worktreeManager: {},
      onEvent: event => args.onPrAuditRecheckEvent?.(event, [1]), snapshotFactory: args => {
        const s = snapshot(); s.evidence = new Map(); s.input = async () => ({ originalFindings: findings, fixedTarget: args.target });
        s.init = async () => { captures.push({ kind: 'pr-audit-recheck', context: { signal: args.signal } }); await options.beforeCapture?.({ signal: args.signal }); A.assertCurrent({ signal: args.signal }); };
        s.cleanup = async () => options.beforeCleanup?.(); snapshots.push(s); return s;
      } });
    rechecks.resolve = async () => ({ source, findings });
    rechecks.target = async () => ({ repo: { repoRoot: root }, target: R.target({ repoKey: source.repoKey, prNumber: 7, prefix: '', baseSha: source.originalBase,
      headSha: '1'.repeat(40), mergeBaseSha: source.originalBase, baseRefName: source.baseRefName, headRefName: source.headRefName, descriptionHash: 'd'.repeat(64) }) });
    rechecks.cleanup = async () => {}; rechecks.freshness = async () => 'current'; rechecks.originals = () => findings;
    // Synthetic protection and snapshot input; preserve real IPC and model acceptance/lifecycle.
    for (const manager of [audits, rechecks]) { const start = manager.start.bind(manager); manager.start = (...params) => {
      const context = params[manager === audits ? 3 : 2]; contexts.push(context); context.beforeSnapshot = async () => {}; return start(...params); }; }
    const resolveBinding = (event, payload) => {
      const project = args.resolveBinding(event, payload);
      if (!project || !options.inheritedAssistantId) return project;
      inheritedBinding ||= resolveModelBinding({ registry: args.getSettings().modelRegistry,
        senderId: event.sender.id, sessionId: 'audit-parent-session', runId: 'audit-parent-run', clientRequestId: 'audit-parent-request', kind: 'chat',
        assistantId: options.inheritedAssistantId, modelProfileId: options.inheritedModelProfileId, projectBindingId: payload.projectBindingId });
      return { ...project, modelBinding: inheritedBinding };
    };
    return createEngineeringIpcHandlers({ ...args, resolveBinding, prAuditManager: audits, prAuditRecheckManager: rechecks });
  } };
  const f = loadMainFixture(t, { registry: options.registry || registryFor(options.protocol), settings: { agentEnabled: true, autoCompact: false, ...options.settings },
    modules: { './ai/engineering-ipc': engineering }, beforeClose: () => options.release?.(), fetchFn: () => wire(options.protocol || protocols[0], options.kind === 'recheck' ? recheckReport : report) });
  for (const provider of f.settings().modelRegistry.providers) {
    if (provider.auth.secretRef) f.secrets.set(provider.auth.secretRef, 'not-a-real-provider-key-audit-test');
  }
  async function bind() { bound = await f.invoke('worktree:bind', { projectId: 'synthetic-audit-project', projectPath: f.root }); assert.equal(bound.ok, true); return bound.projectBindingId; }
  async function start(kind = 'audit') { if (!bound) await bind(); return f.invoke(kind === 'audit' ? 'engineering:pr-audit:start' : 'engineering:pr-audit:recheck:start', kind === 'audit'
    ? { projectBindingId: bound.projectBindingId, prNumber: 7, note: 'Synthetic focus' } : { projectBindingId: bound.projectBindingId, resultId: source.resultId }); }
  async function done(out, kind = 'audit') { const manager = kind === 'audit' ? audits : rechecks; const ref = out.auditRef || out.recheckRef; await manager.runs.get(ref)?.done; return manager.row(f.root, ref); }
  return { ...f, start, bind, done, captures, contexts, snapshots, source, config: () => config, audits: () => audits, rechecks: () => rechecks, binding: () => bound, inheritedBinding: () => inheritedBinding };
}
for (const protocol of protocols) for (const kind of ['audit', 'recheck']) {
  test(`E4 real main ${kind} accepts ${protocol === 'anthropic-messages' ? 'private-auth' : 'no-auth'} ${protocol}, pins source and meters one attempt`, async t => {
    const f = fixture(t, { protocol, kind }); const out = await f.start(kind); assert.equal(out.ok, true, out.code);
    assert.equal(typeof f.config().acceptBoundModel, 'function'); const row = await f.done(out, kind); assert.equal(row.status, 'completed', row.errorCode);
    assert.equal(f.requests.length, 1); const registry = f.settings().modelRegistry; assert.equal(f.requests[0].body.model, registry.models[0].model);
    assert.equal(out.modelSource.providerId, registry.providers[0].id); assert.equal(out.modelSource.modelProfileId, registry.defaultModelProfileId);
    assert.equal(out.modelSource.assistantId, 'assistant_codex'); assert.equal(out.modelSource.protocol, protocol); assert.deepEqual(row.modelSource, out.modelSource);
    assert.deepEqual(row.usage, { inputTokens: 12, outputTokens: 3, source: 'actual', estimated: false });
    assert.equal(f.settings().apiKey, '');
    if (protocol === 'anthropic-messages') assert.ok(f.credentialReads.length >= 1);
    else assert.equal(f.credentialReads.length, 0);
    assert.equal(f.settingsLoads.every(load => load?.resolveLegacyApiKey === false), true);
    const ledger = readRecords(usageFilePath(f.root)).records; assert.equal(ledger.length, 1); assert.equal(ledger[0].kind, kind === 'audit' ? 'pr-audit' : 'pr-audit-recheck');
    for (const key of ['providerId', 'modelProfileId', 'runId', 'bindingRevision']) assert.equal(ledger[0][key], out.modelSource[key]);
    assert.equal(f.inspect('backgroundModelBindings.size'), 0); assert.equal(f.inspect('activeModelRequests.size'), 0); assert.equal(f.inspect('foregroundModels.current'), null);
    assert.ok(f.contexts[0].abortController instanceof AbortController);
    const names = protocol === protocols[0] ? f.requests[0].body.tools.map(tool => tool.function.name) : f.requests[0].body.tools.map(tool => tool.name);
    assert.deepEqual(names, (kind === 'audit' ? AUDIT_TOOLS : RECHECK_TOOLS).map(tool => tool.function.name)); assert.equal(names.includes('run_terminal'), false);
  });
}
for (const kind of ['audit', 'recheck']) for (const [options, code] of [[{ nativeTools: 'unknown' }, 'MODEL_CAPABILITY_REQUIRED'], [{ authKind: 'bearer' }, 'MODEL_AUTH_REQUIRED']]) {
  test(`E4 real main ${kind} rejects ${code} before snapshot/storage/request/retention`, async t => {
    const f = fixture(t, { kind, registry: registryFor(protocols[0], options) }); const out = await f.start(kind); assert.equal(out.ok, false); assert.equal(out.code, code);
    assert.equal(f.captures.length, 0); assert.equal(f.snapshots.length, 0); assert.equal(f.requests.length, 0);
    assert.equal(f.audits().store.list().length, 0); assert.equal(f.rechecks().store.list().length, 0); assert.equal(f.audits().taskPool.tasks.size, 0);
    assert.equal(f.inspect('backgroundModelBindings.size'), 0); assert.equal(f.inspect('activeModelRequests.size'), 0);
  });
}
test('E4 no-session audit pins global default, not assistant override or legacy model/key', async t => {
  let registry = registryFor(); const defaultId = registry.defaultModelProfileId;
  registry = saveProfile(registry, 'model', { name: 'Synthetic assistant override', providerId: registry.providers[0].id, model: 'synthetic-assistant-override' });
  const otherId = registry.models.find(model => model.id !== defaultId).id; registry = saveProfile(registry, 'assistant', { id: 'assistant_codex', modelProfileId: otherId });
  const entered = deferred(); const resume = deferred(); const f = fixture(t, { registry, settings: { apiKey: 'synthetic-legacy-not-a-real-key', model: 'synthetic-wrong-global', baseUrl: 'https://wrong-synthetic.invalid' },
    beforeCapture: async () => { entered.resolve(); await resume.promise; }, release: () => resume.resolve() });
  const out = await f.start(); assert.equal(out.ok, true, out.code); await entered.promise; assert.equal(out.modelSource.modelProfileId, defaultId);
  assert.equal(f.audits().runs.get(out.auditRef).modelBinding.sessionId, null);
  f.patchSettings({ modelRegistry: { ...f.settings().modelRegistry, defaultModelProfileId: otherId } }); resume.resolve(); const row = await f.done(out);
  assert.equal(row.status, 'completed', row.errorCode); assert.equal(f.requests[0].body.model, registry.models.find(model => model.id === defaultId).model); assert.equal(row.modelSource.modelProfileId, defaultId);
});
test('E4 independent audit retains binding through cleanup and locks wire configuration', async t => {
  const entered = deferred(); const resume = deferred(); const f = fixture(t, { beforeCleanup: async () => { entered.resolve(); await resume.promise; }, release: () => resume.resolve() });
  const out = await f.start(); assert.equal(out.ok, true, out.code); await entered.promise;
  assert.equal(f.inspect('foregroundModels.current'), null); assert.equal(f.inspect('backgroundModelBindings.size'), 1); assert.equal(f.inspect('activeModelRequests.size'), 1);
  const current = await f.invoke('models:list'); const payload = { provider: { id: current.registry.providers[0].id, baseUrl: 'https://changed-synthetic.invalid/v1' }, expectedRevision: current.revision };
  const blocked = await f.invoke('models:saveProvider', payload); assert.equal(blocked.ok, false); assert.equal(blocked.code, 'CONFIG_IN_USE');
  resume.resolve(); await f.done(out); assert.equal(f.inspect('backgroundModelBindings.size'), 0); assert.equal(f.inspect('activeModelRequests.size'), 0);
  const changed = await f.invoke('models:saveProvider', payload); assert.equal(changed.ok, true, changed.code);
});
for (const revoke of ['project', 'assistant']) {
  test(`E4 real main ${revoke} revocation cancels accepted audit snapshot`, async t => {
    const captured = deferred(); const f = fixture(t, { beforeCapture: async ({ signal }) => { captured.resolve(); await new Promise(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); } });
    const out = await f.start(); assert.equal(out.ok, true, out.code); await captured.promise;
    if (revoke === 'project') assert.equal((await f.invoke('worktree:unbind', { projectBindingId: f.binding().projectBindingId })).ok, true);
    else { const current = await f.invoke('models:list'); assert.equal((await f.invoke('assistants:save', { assistant: { id: 'assistant_codex', toolPolicy: { mode: 'none', allowedTools: [] } }, expectedRevision: current.revision })).ok, true); }
    const row = await f.done(out); assert.equal(row.status, 'cancelled'); assert.equal(f.requests.length, 0); assert.equal(f.contexts[0].signal.aborted, true);
    assert.equal(f.inspect('backgroundModelBindings.size'), 0); assert.equal(f.inspect('activeModelRequests.size'), 0);
  });
}
test('E4 audit IPC refuses renderer session/model/binding forgeries', async t => {
  const f = fixture(t); const token = await f.bind();
  for (const extra of [{ sessionId: 'forged-session' }, { modelProfileId: 'forged-model' }, { modelBinding: {} }, { abortController: {} }]) {
    const out = await f.invoke('engineering:pr-audit:start', { projectBindingId: token, prNumber: 7, ...extra }); assert.equal(out.ok, false); assert.equal(out.code, 'PR_AUDIT_INVALID'); }
  assert.equal(f.requests.length, 0); assert.equal(f.captures.length, 0);
});
test('E4 snapshot advertisement and actual text tools intersect inherited assistant allowlist', async () => {
  let registry = registryFor(protocols[0], { toolMode: 'text-compat' });
  registry = saveProfile(registry, 'assistant', { name: 'Synthetic snapshot reader', toolPolicy: { mode: 'allowlist', allowedTools: ['review_read_file'] } });
  const assistant = registry.assistants.find(profile => profile.name === 'Synthetic snapshot reader'); const binding = resolveModelBinding({ registry, assistantId: assistant.id, kind: 'pr-audit' });
  const s = snapshot(); let reads = 0; let lists = 0; let turns = 0; s.read = async () => { reads++; return {}; }; s.list = async () => { lists++; return {}; };
  const out = await runAudit({ snapshot: s, settings: { mode: 'api', agentEnabled: true }, modelBinding: binding, chatFn: async ({ messages, tools }) => {
    assert.deepEqual(tools.map(tool => tool.function.name), ['review_read_file']); assert.doesNotMatch(messages[0].content, /review_list_files|review_search|run_terminal/);
    return { content: ++turns === 1 ? '```tool review_list_files\n{}\n```\n```tool review_read_file\n{"path":"src/synthetic.js"}\n```' : JSON.stringify(report) }; } });
  assert.equal(out.report.summary, report.summary); assert.equal(reads, 1); assert.equal(lists, 0);
});
test('E4 inherited no-tool assistant exposes no snapshot schemas or executable text tools', async () => {
  const registry = registryFor(protocols[0], { toolMode: 'text-compat' }); const binding = resolveModelBinding({ registry, assistantId: 'assistant_general', kind: 'pr-audit' });
  const out = await runAudit({ snapshot: snapshot(), settings: { mode: 'api', agentEnabled: true }, modelBinding: binding, chatFn: async ({ messages, tools }) => {
    assert.deepEqual(tools, []); assert.doesNotMatch(messages[0].content, /review_read_file|review_list_files|review_search/); return { content: JSON.stringify(report) }; } });
  assert.deepEqual(out.report, report);
});
for (const kind of ['audit', 'recheck']) for (const toolMode of ['text-compat', 'none']) {
  test(`E4 real main ${kind} ${toolMode} needs no native capability and never advertises wire tools`, async t => {
    const f = fixture(t, { kind, registry: registryFor(protocols[0], { toolMode, nativeTools: 'unknown' }) });
    const out = await f.start(kind); assert.equal(out.ok, true, out.code); const row = await f.done(out, kind);
    assert.equal(row.status, 'completed', row.errorCode); assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].body.tools || [], []);
    const system = f.requests[0].body.messages[0].content;
    if (toolMode === 'none') assert.doesNotMatch(system, /review_read_file|review_search|recheck_read_file|recheck_search/);
    else assert.match(system, kind === 'audit' ? /review_read_file/ : /recheck_read_file/);
    assert.equal(readRecords(usageFilePath(f.root)).records.length, 1);
  });
}
test('E4 real main inherits exactly one host session binding and intersects its snapshot tool allowance', async t => {
  let registry = registryFor();
  registry = saveProfile(registry, 'assistant', { name: 'Audit-only reader', toolPolicy: { mode: 'allowlist', allowedTools: ['review_read_file'] } });
  const assistant = registry.assistants.find(a => a.name === 'Audit-only reader');
  const entered = deferred(); const resume = deferred();
  const f = fixture(t, { registry, inheritedAssistantId: assistant.id, beforeCapture: async () => { entered.resolve(); await resume.promise; }, release: () => resume.resolve() });
  const out = await f.start(); assert.equal(out.ok, true, out.code); await entered.promise;
  assert.equal(f.contexts[0].modelBinding, f.inheritedBinding());
  assert.equal(f.audits().runs.get(out.auditRef).modelBinding, f.inheritedBinding());
  assert.equal(out.modelSource.assistantId, assistant.id); assert.equal(f.inheritedBinding().sessionId, 'audit-parent-session');
  resume.resolve(); const row = await f.done(out); assert.equal(row.status, 'completed', row.errorCode);
  assert.deepEqual(f.requests[0].body.tools.map(tool => tool.function.name), ['review_read_file']);
  const ledger = readRecords(usageFilePath(f.root)).records; assert.equal(ledger.length, 1); assert.equal(ledger[0].session, 'audit-parent-session');
  assert.equal(f.inspect('backgroundModelBindings.size'), 0);
});
for (const none of [false, true]) {
  test(`E4 recheck inherited ${none ? 'none' : 'read-only'} assistant never exposes or dispatches denied snapshot tools`, async () => {
    let registry = registryFor(protocols[0], { toolMode: 'text-compat' }); let assistantId = 'assistant_general';
    if (!none) { registry = saveProfile(registry, 'assistant', { name: 'Recheck-only reader', toolPolicy: { mode: 'allowlist', allowedTools: ['recheck_read_file'] } });
      assistantId = registry.assistants.find(a => a.name === 'Recheck-only reader').id; }
    const binding = resolveModelBinding({ registry, assistantId, kind: 'pr-audit-recheck' });
    const findingId = A.ref('paf'); const findings = [{ findingId }];
    const final = { summary: 'Evidence remains unavailable.', findings: [{ findingId, status: 'unknown', reason: 'No proof of repair.', evidence: [] }] };
    const s = snapshot(); s.evidence = new Map(); s.input = async () => ({ findings }); let reads = 0; let lists = 0; let turns = 0;
    s.read = async () => { reads++; return {}; }; s.list = async () => { lists++; return {}; };
    const out = await runRecheck({ snapshot: s, findings, settings: { mode: 'api', agentEnabled: true }, modelBinding: binding,
      chatFn: async ({ messages, tools }) => {
        assert.deepEqual(tools.map(tool => tool.function.name), none ? [] : ['recheck_read_file']);
        assert.doesNotMatch(messages[0].content, /recheck_list_files|recheck_search|review_read_file|run_terminal/);
        if (none) assert.doesNotMatch(messages[0].content, /recheck_read_file/);
        return { content: ++turns === 1 ? '```tool recheck_list_files\n{}\n```\n```tool recheck_read_file\n{"path":"src/proof.js"}\n```' : JSON.stringify(final) };
      } });
    assert.equal(out.report.summary, final.summary); assert.equal(reads, none ? 0 : 1); assert.equal(lists, 0);
  });
}
