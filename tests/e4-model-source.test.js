'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../src/ai/message-schema');
const chat = require('../src/renderer/e4-chat-state');
const { resolveModelBinding, validateModelRegistry } = require('../src/ai/model-profiles');
const { publicModelSource } = require('../src/ai/model-runtime');
const { buildModelUsageEvent } = require('../src/ai/model-usage');
const { normalizeRecord } = require('../src/ai/usage-store');
const { createModelChatFunction } = require('../src/ai/llm-client');
const { exportSessionJson, exportSessionMarkdown } = require('../src/ai/session-export');
const { syntheticRegistry, loadMainFixture, loadPreloadFixture } = require('./helpers/e4-main-fixture');
function acceptedBinding() {
  const registry = syntheticRegistry(); registry.models[0].model = 'm'.repeat(256);
  return resolveModelBinding({ registry: validateModelRegistry(registry), senderId: 1, sessionId: 'source-session',
    runId: 'source-run', clientRequestId: 'source-request', kind: 'chat', assistantId: 'assistant_general' });
}

test('all message projections retain the full 256-character accepted model and bounded revision whitelist', () => {
  const binding = acceptedBinding();
  const source = { ...publicModelSource(binding), apiKey: 'never-export-key', secretRef: 'never-export-ref', providerState: { raw: 'never-export-state' } };
  const message = schema.createMessageV2({ role: 'assistant', content: 'A safe answer', modelSource: source });
  const stored = schema.projectToStorageJson(message), ui = schema.projectToUiModel(message);
  assert.equal(message.schemaVersion, 2); assert.equal(stored.schemaVersion, 2);
  for (const projected of [message, stored, ui]) {
    assert.equal(projected.modelSource.kind, 'api');
    assert.equal(projected.modelSource.model.length, 256); assert.equal(projected.modelSource.model, binding.model);
    assert.equal(projected.modelSource.providerRevision, 1); assert.equal(projected.modelSource.modelRevision, 1);
    assert.equal(projected.modelSource.assistantRevision, 1); assert.equal(projected.modelSource.runId, 'source-run');
    assert.equal(projected.modelSource.assistantName, binding.assistant.name);
    assert.equal(projected.modelSource.clientRequestId, 'source-request');
    assert.deepEqual(Object.keys(projected.modelSource).sort(), ['kind', 'assistantId', 'assistantName', 'providerId', 'modelProfileId', 'model', 'protocol',
      'providerRevision', 'modelRevision', 'assistantRevision', 'runId', 'clientRequestId'].sort());
    assert.equal(JSON.stringify(projected).includes('never-export-'), false);
  }
  assert.deepEqual(schema.projectToModelMessages([message]), [{ role: 'assistant', content: 'A safe answer' }]);
  assert.throws(() => createModelChatFunction({ binding: source }), { code: 'MODEL_BINDING_INVALID' });
});

test('JSON and Markdown exports retain AI session identity and every message source without private snapshot data', () => {
  const binding = acceptedBinding(), source = publicModelSource(binding);
  const session = { id: 'source-session', title: 'Source export', identityType: 'ai', assistantId: 'assistant_general',
    modelProfileId: binding.modelProfileId, messages: [schema.createMessageV2({ role: 'assistant', content: 'A safe answer', modelSource: source })],
    draftsBySession: { privateDraft: 'never-export-draft' }, apiKey: 'never-export-key', providerState: 'never-export-state' };
  const json = exportSessionJson(session), exported = JSON.parse(json).session;
  assert.equal(exported.identityType, 'ai'); assert.equal(exported.assistantId, 'assistant_general');
  assert.equal(exported.modelProfileId, binding.modelProfileId);
  assert.deepEqual(exported.messages[0].modelSource, schema.normalizeModelSource(source));
  const markdown = exportSessionMarkdown(session);
  assert.match(markdown, /modelSource/); assert.ok(markdown.includes(binding.providerId));
  assert.ok(markdown.includes(binding.model)); assert.ok(markdown.includes('source-run'));
  assert.equal(json.includes('never-export-'), false); assert.equal(markdown.includes('never-export-'), false);
});

test('historical source stays unknown and demo-contact exports cannot fabricate AI assistant authority', () => {
  const old = { id: 'old', identityType: 'ai', assistantId: 'assistant_general', modelProfileId: 'selected-now', messages: [{ role: 'assistant', content: 'Old reply' }] };
  assert.equal(JSON.parse(exportSessionJson(old)).session.messages[0].modelSource, undefined);
  const demo = { id: 'legacy-contact', identityType: 'demo-contact', assistantId: 'assistant_codex', modelProfileId: 'forged-model',
    messages: [{ role: 'assistant', content: 'Demo reply', modelSource: { kind: 'legacy-demo' } }] };
  const exported = JSON.parse(exportSessionJson(demo)).session;
  assert.equal(exported.identityType, 'demo-contact'); assert.equal(exported.assistantId, undefined); assert.equal(exported.modelProfileId, undefined);
  assert.deepEqual(exported.messages[0].modelSource, { kind: 'legacy-demo' });
});

test('accepted assistant names remain bounded across renderer, storage, reload and exports', () => {
  const binding = acceptedBinding();
  const source = { ...publicModelSource(binding), assistantName: 'A'.repeat(140), ignoredName: 'never-export-private-name' };
  const message = schema.createMessageV2({ role: 'assistant', content: 'An accepted answer', modelSource: source });
  const state = chat.createState({ sessions: [{ id: binding.sessionId, identityType: 'ai', assistantId: binding.assistantId, messages: [message] }] });
  const saved = chat.serializeState(state, schema.projectToStorageJson);
  assert.equal(saved.ok, true);
  const restored = chat.migrateState(JSON.parse(JSON.stringify(saved.value)));
  assert.equal(restored.ok, true);
  const session = restored.state.sessions[0];
  // The next assistant may be different; neither local migration nor export may relabel the accepted source.
  session.assistantId = 'assistant_selected_for_next_turn';
  const json = JSON.parse(exportSessionJson(session));
  const markdown = exportSessionMarkdown(session);
  const expected = schema.normalizeModelSource(source);
  assert.deepEqual(chat.normalizeModelSource(source), expected);
  for (const projected of [message, session.messages[0], json.session.messages[0], schema.projectToUiModel(message)]) {
    assert.equal(projected.modelSource.assistantName, 'A'.repeat(128));
    assert.equal(projected.modelSource.assistantId, binding.assistantId);
    assert.equal(projected.modelSource.ignoredName, undefined);
  }
  assert.ok(markdown.includes('A'.repeat(128)));
  assert.equal(markdown.includes('never-export-private-name'), false);
  for (const invalid of [null, 2, {}, [], true]) {
    const raw = { kind: 'api', assistantName: invalid };
    assert.equal(schema.normalizeModelSource(raw).assistantName, undefined);
    assert.deepEqual(chat.normalizeModelSource(raw), schema.normalizeModelSource(raw));
  }
});

test('physical-attempt ledger provenance retains revisions and excludes raw auth/state without fake prices', () => {
  const binding = acceptedBinding();
  const usage = buildModelUsageEvent({ binding, settings: { usageEnabled: true }, attempt: { attemptId: 'source-attempt', status: 'completed', finishReason: 'stop',
    usage: { source: 'actual', inputTokens: 12, outputTokens: 3, cachedInputTokens: null, cacheCreationInputTokens: null, totalTokens: 15 } } });
  const row = normalizeRecord({ ...usage, ts: Date.now(), session: binding.sessionId, cur: '$',
    modelSource: { ...usage.modelSource, apiKey: 'never-export-key', providerState: 'never-export-state', secretRef: 'never-export-ref' } });
  assert.ok(row); assert.equal(row.modelSource.providerRevision, binding.providerRevision);
  assert.equal(row.modelSource.modelRevision, binding.modelRevision); assert.equal(row.modelSource.assistantRevision, binding.assistantRevision);
  assert.equal(row.modelSource.kind, 'api'); assert.equal(row.modelSource.model.length, 256); assert.equal(row.cost, null);
  assert.equal(row.attemptId, 'source-attempt'); assert.equal(JSON.stringify(row).includes('never-export-'), false);
});

test('public wire fingerprints ignore names but change for key rotation and never carry vault references', async t => {
  const f = loadMainFixture(t, { registry: syntheticRegistry({ authKind: 'bearer' }) }); const bridge = loadPreloadFixture(f);
  const before = await bridge.api.listModels(); const providerId = before.registry.providers[0].id;
  const renamed = await bridge.api.saveModelProvider({ provider: { id: providerId, name: 'Renamed display only' }, expectedRevision: before.revision });
  assert.equal(renamed.ok, true); assert.equal(renamed.registry.models[0].bindingRevision, before.registry.models[0].bindingRevision);
  const configured = await bridge.api.setModelCredential({ providerId, credential: 'temporary-demo-key-for-owned-test', expectedRevision: renamed.revision });
  assert.equal(configured.ok, true); assert.notEqual(configured.registry.models[0].bindingRevision, renamed.registry.models[0].bindingRevision);
  assert.equal(JSON.stringify(configured).includes('temporary-demo-key-for-owned-test'), false);
  assert.equal(JSON.stringify(configured).includes('secretRef'), false);
  const cleared = await bridge.api.clearModelCredential({ providerId, expectedRevision: configured.revision });
  assert.equal(cleared.ok, true); assert.equal(cleared.cleanupState, 'clean'); assert.equal(f.secrets.size, 0);
  assert.notEqual(cleared.registry.models[0].bindingRevision, configured.registry.models[0].bindingRevision);
  assert.equal(f.requests.length, 0);
});
