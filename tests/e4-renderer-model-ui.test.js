'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/renderer/e4-models');

const registry = (revision = 3) => ({
  schemaVersion: 1,
  revision,
  defaultModelProfileId: 'm1',
  providers: [{
    id: 'p1', name: 'Local OpenAI', protocol: 'openai-chat-completions', baseUrl: 'http://localhost:1234/v1',
    revision, auth: { kind: 'bearer' }, credentialState: 'configured', transportConfirmation: null,
  }],
  models: [{
    id: 'm1', name: 'Model One', providerId: 'p1', model: 'qwen-local', revision,
    request: { maxOutputTokens: 1024, chatTokenLimitField: 'max_tokens' },
    compatibility: { toolMode: 'native', streamMode: 'auto', includeUsage: false },
    capabilities: {
      text: { state: 'supported', source: 'observed', checkedAt: '2026-10-29T00:00:00Z', bindingRevision: 'abc' },
      nativeTools: { state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null },
      contextWindow: { tokens: 8192, source: 'declared' },
    },
  }],
  assistants: [{
    id: 'assistant_codex', name: 'Codex', builtIn: true, identityType: 'ai', modelProfileId: null,
    revision, systemPrompt: '', knowledge: { projectContext: true, projectMemory: true }, projectId: null,
    toolPolicy: { mode: 'none', allowedTools: [] },
  }],
});

function harness(overrides = {}) {
  const calls = [];
  let current = registry();
  const api = {
    listModels: async () => ({ ok: true, mode: 'local', revision: current.revision, registry: current, cleanupState: 'clean', pendingCleanupCount: 0 }),
    saveModelProvider: async (payload) => { calls.push(['provider', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    saveModelProfile: async (payload) => { calls.push(['model', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    setDefaultModel: async (payload) => { calls.push(['default', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = { ...registry(payload.expectedRevision + 1), defaultModelProfileId: payload.modelProfileId } }; },
    removeModelProfile: async (payload) => { calls.push(['remove', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    setModelCredential: async (payload) => { calls.push(['credential', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    clearModelCredential: async (payload) => { calls.push(['clearCredential', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    retryModelCredentialCleanup: async (payload) => { calls.push(['cleanup', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    listAssistants: async () => ({ ok: true, assistants: current.assistants, revision: current.revision, registry: current }),
    saveAssistant: async (payload) => { calls.push(['assistant', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    deleteAssistant: async (payload) => { calls.push(['deleteAssistant', payload]); return { ok: true, revision: payload.expectedRevision + 1, registry: current = registry(payload.expectedRevision + 1) }; },
    diagnoseModel: async (payload) => { calls.push(['diagnose', payload]); return { ok: true, accepted: true, diagnosticId: 'diag1', runId: 'run1', sessionId: 'session1', clientRequestId: 'request1', task: { kind: 'model_diagnostic' }, modelSource: { kind: 'api', modelProfileId: payload.modelProfileId } }; },
    cancelModelDiagnosis: async (payload) => { calls.push(['cancelDiagnosis', payload]); return { ok: true }; },
    onModelDiagnosticEvent: (callback) => { api.emit = callback; return () => {}; },
    ...overrides,
  };
  const manager = models.createModelManager(api);
  return { manager, api, calls, get registry() { return current; }, set registry(value) { current = value; } };
}

test('model manager refreshes its revision on conflict and uses exact IPC payload names', async () => {
  const conflictRegistry = registry(9);
  const h = harness({
    saveModelProvider: async (payload) => {
      h.calls.push(['provider', payload]);
      return { ok: false, code: 'CONFLICT', error: 'stale', registry: conflictRegistry, revision: 9 };
    },
  });
  await h.manager.load();
  const result = await h.manager.saveProvider({ id: 'p1', name: 'Edited' });
  assert.equal(result.ok, false);
  assert.equal(h.manager.getState().revision, 9);
  assert.equal(h.calls[0][1].expectedRevision, 3);
});

test('model save strips observed capability evidence and never sends credential state', async () => {
  const h = harness();
  await h.manager.load();
  await h.manager.saveModel({
    id: 'm1', name: 'Model One', providerId: 'p1', model: 'qwen-local', request: { maxOutputTokens: 1024 },
    compatibility: { toolMode: 'native', streamMode: 'auto', includeUsage: false },
    capabilities: { text: { state: 'supported', source: 'observed', checkedAt: 'date', bindingRevision: 'abc' }, vision: { state: 'unsupported', source: 'declared' } },
    credentialState: 'configured', providerState: { apiKey: 'secret' },
  });
  const payload = h.calls[0][1];
  assert.equal(payload.expectedRevision, 3);
  assert.equal(payload.model.capabilities.text, undefined);
  assert.equal(payload.model.capabilities.vision.state, 'unsupported');
  assert.equal(payload.model.credentialState, undefined);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
});

test('custom assistant defaults to isolated identity, no knowledge, and no tools', () => {
  const draft = models.createAssistantDraft({ id: 'assistant_custom_1', name: 'Helper' });
  assert.deepEqual(draft.knowledge, { projectContext: false, projectMemory: false });
  assert.deepEqual(draft.toolPolicy, { mode: 'none', allowedTools: [] });
  const codex = models.createAssistantDraft({ id: 'assistant_codex', name: 'Codex', builtIn: true });
  assert.deepEqual(codex.knowledge, { projectContext: true, projectMemory: true });
  assert.deepEqual(models.normalizeToolPolicy(codex, { mode: 'allowlist', allowedTools: ['@host-authorized'] }), { mode: 'allowlist', allowedTools: ['@host-authorized'] });
  assert.deepEqual(models.normalizeToolPolicy(draft, { mode: 'allowlist', allowedTools: ['@host-authorized', '*', 'search_repo'] }), { mode: 'allowlist', allowedTools: ['search_repo'] });
});

test('diagnosis preview is synthetic and diagnosis events become stale after registry changes', async () => {
  const h = harness();
  await h.manager.load();
  const preview = h.manager.previewDiagnosis('m1', ['text', 'nativeTools']);
  assert.equal(preview.synthetic, true);
  assert.equal(preview.externalRequests, 0);
  assert.equal(preview.estimatedCost, null);
  await h.manager.startDiagnosis('m1', ['text', 'nativeTools']);
  assert.deepEqual(h.calls.find(([name]) => name === 'diagnose')[1], { modelProfileId: 'm1', checks: ['text', 'nativeTools'], expectedRevision: 3 });
  h.api.emit({ diagnosticId: 'diag1', modelProfileId: 'm1', type: 'start', sessionId: 'session1', runId: 'run1', clientRequestId: 'request1' });
  const changed = registry(4); changed.models[0].model = 'changed-wire-model';
  h.manager.applyResult({ ok: true, revision: 4, registry: changed });
  h.api.emit({ diagnosticId: 'diag1', modelProfileId: 'm1', type: 'check-result', sessionId: 'session1', runId: 'run1', clientRequestId: 'request1', check: 'text', result: { state: 'supported' } });
  assert.equal(h.manager.getState().diagnostics.diag1.stale, true);
  await h.manager.cancelDiagnosis('diag1');
  assert.deepEqual(h.calls.at(-1), ['cancelDiagnosis', { diagnosticId: 'diag1', sessionId: 'session1', runId: 'run1', clientRequestId: 'request1' }]);
});

test('diagnosis preview discloses concrete origin/protocol and counts nativeTools as two physical requests', async () => {
  const h = harness(); await h.manager.load();
  const preview = h.manager.previewDiagnosis('m1', ['text', 'streaming', 'nativeTools', 'usage']);
  assert.equal(preview.potentialRequests, 5); assert.equal(preview.origin, 'http://localhost:1234');
  assert.equal(preview.protocol, 'openai-chat-completions'); assert.equal(preview.model, 'qwen-local');
  assert.equal(preview.maxOutputTokens, 128); assert.equal(preview.timeoutMs, 15000); assert.equal(preview.maxResponseBytes, 262144);
});
test('rename/default/capability revision changes do not stale diagnosis; main wire fingerprint drift does', async () => {
  const h = harness(); const initial = registry(); initial.models[0].bindingRevision = 'wire-a'; h.registry = initial;
  await h.manager.load(); await h.manager.startDiagnosis('m1', ['text']);
  const renamed = registry(4); renamed.models[0].bindingRevision = 'wire-a'; renamed.models[0].name = 'Renamed'; renamed.providers[0].name = 'Renamed provider';
  h.manager.applyResult({ ok: true, registry: renamed });
  assert.equal(h.manager.getState().diagnostics.diag1.stale, false);
  renamed.models[0].bindingRevision = 'wire-b'; h.manager.applyResult({ ok: true, registry: renamed });
  assert.equal(h.manager.getState().diagnostics.diag1.stale, true);
});
test('actual check/checks map/state contract is correlated and terminal immutable', async () => {
  const h = harness(); await h.manager.load(); await h.manager.startDiagnosis('m1', ['text']);
  const ev = { diagnosticId: 'diag1', modelProfileId: 'm1', sessionId: 'session1', runId: 'run1', clientRequestId: 'request1' };
  assert.equal(h.manager.onDiagnosticEvent({ ...ev, sessionId: 'foreign', type: 'check', checks: { text: { state: 'passed' } } }), false);
  assert.equal(h.manager.onDiagnosticEvent({ ...ev, type: 'done', state: 'passed', startedAt: '2026-10-29T00:00:00Z', completedAt: '2026-10-29T00:00:01Z', requestCount: 1, bindingRevision: 'wire-a', checks: { text: { state: 'passed', capability: 'supported', checkedAt: '2026-10-29T00:00:01Z' } } }), true);
  let item = h.manager.getState().diagnostics.diag1;
  assert.equal(item.status, 'passed'); assert.equal(item.results.text.capability, 'supported'); assert.equal(item.requestCount, 1);
  assert.equal(h.manager.onDiagnosticEvent({ ...ev, type: 'check', state: 'running', checks: { text: { state: 'failed' } } }), false);
  item = h.manager.getState().diagnostics.diag1; assert.equal(item.status, 'passed'); assert.equal(item.results.text.state, 'passed');
});
test('every registry mutation synchronizes latest session refs first and surfaces transport failure without throwing', async () => {
  const order = [], h = harness({ saveModelProvider: async () => { order.push('save'); throw new Error('ipc disconnected'); } });
  const manager = models.createModelManager(h.api, { beforeMutation: async () => { order.push('refs'); return { ok: true }; } });
  await manager.load(); const result = await manager.saveProvider({ id: 'p1', name: 'Edited' });
  assert.deepEqual(order, ['refs', 'save']); assert.equal(result.ok, false); assert.match(manager.getState().error, /ipc disconnected/);
});
test('unknown previous target and existing compact-only context still require explicit cross-origin disclosure', () => {
  assert.equal(models.getSwitchWarning({ current: null, next: { id: 'm1', providerId: 'p1', origin: 'https://one.example' }, hasContext: true, autoCompact: true }).required, true);
});

test('cross-origin target reports context disclosure and possible compaction before switching', () => {
  const warning = models.getSwitchWarning({
    current: { id: 'm1', providerId: 'p1', origin: 'https://one.example' },
    next: { id: 'm2', providerId: 'p2', origin: 'https://two.example' },
    hasContext: true,
    autoCompact: true,
  });
  assert.equal(warning.required, true);
  assert.equal(warning.contextDisclosed, true);
  assert.equal(warning.autoCompactTarget, 'm2');
});

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
test('name-only model save omits read-only observed capabilities instead of resetting main evidence', async () => {
  const h = harness(); await h.manager.load();
  const current = h.manager.getState().registry.models[0];
  await h.manager.saveModel({ ...current, name: 'Renamed only' });
  const saved = h.calls.find(([name]) => name === 'model')[1].model;
  assert.equal(owns(saved.capabilities, 'text'), false);
  assert.equal(saved.capabilities.contextWindow.source, 'declared');
  assert.equal(JSON.stringify(saved.capabilities).includes('observed'), false);
});
test('explicit null clears optional request fields without inventing temperature zero', () => {
  const draft = models.modelDraftForSave({ id: 'm1', request: { maxOutputTokens: 1024, temperature: null, chatTokenLimitField: null } });
  assert.equal(draft.request.temperature, null);
  assert.equal(draft.request.chatTokenLimitField, null);
  assert.equal(owns(models.modelDraftForSave({ id: 'm1', request: { maxOutputTokens: 1024 } }).request, 'temperature'), false);
});
test('revision-only older conflict responses cannot rewind the refreshed registry revision', async () => {
  const h = harness(); await h.manager.load();
  h.manager.applyResult({ ok: true, registry: registry(10), revision: 10 });
  h.manager.applyResult({ ok: false, code: 'CONFIG_CONFLICT', revision: 9, error: 'Preserve pending edits' });
  assert.equal(h.manager.getState().revision, 10);
  assert.equal(h.manager.getState().registry.revision, 10);
});
test('a diagnosis accepted after concurrent wire change is stale immediately even before its events', async () => {
  let complete; const h = harness({ diagnoseModel: () => new Promise((resolve) => { complete = resolve; }) });
  const first = registry(); first.models[0].bindingRevision = 'wire-a'; h.registry = first;
  await h.manager.load(); const starting = h.manager.startDiagnosis('m1', ['text']);
  const next = registry(4); next.models[0].bindingRevision = 'wire-b'; h.registry = next; h.manager.applyResult({ ok: true, registry: next, revision: 4 });
  complete({ ok: true, diagnosticId: 'diag-race', runId: 'run-race', sessionId: 'session-race', clientRequestId: 'request-race' });
  await starting; assert.equal(h.manager.getState().diagnostics['diag-race'].stale, true);
});
