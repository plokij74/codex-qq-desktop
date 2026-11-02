'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIpcHarness } = require('./fixtures/e4-models/ipc-harness.cjs');

test('E4 public registry never returns credential values, references or cleanup journal', async () => {
  const h = createIpcHarness();
  const result = await h.handlers.list(h.event());
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'api');
  assert.equal(result.registry.defaultModelProfileId, h.modelId());
  const json = JSON.stringify(result);
  assert.ok(!json.includes('synthetic-credential-not-a-real-key'));
  assert.ok(!json.includes('secretRef'));
  assert.ok(!json.includes('main_api_key'));
  assert.ok(!json.includes('modelCredentialCleanup'));
});

test('E4 model CRUD and setDefault persist with revision conflicts and no mode change', async () => {
  const h = createIpcHarness();
  const revision = h.revision();
  const saved = await h.handlers.saveModel(h.event(), { expectedRevision: revision, model: {
    id: 'model_synthetic_second', name: 'Second synthetic', providerId: h.providerId(), model: 'synthetic-second',
  } });
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, revision + 1);
  const stale = await h.handlers.setDefault(h.event(), { modelProfileId: 'model_synthetic_second', expectedRevision: revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'CONFIG_CONFLICT');
  assert.equal(stale.registry.defaultModelProfileId, h.modelId());
  const selected = await h.handlers.setDefault(h.event(), { modelProfileId: 'model_synthetic_second', expectedRevision: h.revision() });
  assert.equal(selected.ok, true);
  assert.equal(h.settings().mode, 'api');
  assert.equal(h.settings().modelRegistry.defaultModelProfileId, 'model_synthetic_second');
  const unknown = await h.handlers.setDefault(h.event(), { modelProfileId: 'model_absent', expectedRevision: h.revision() });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'MODEL_CONFIG_INVALID');
});

test('E4 sender validation applies before reads and writes', async () => {
  const h = createIpcHarness();
  assert.equal((await h.handlers.list({ sender: null })).code, 'MODEL_SENDER_INVALID');
  const before = h.revision();
  const result = await h.handlers.setDefault(h.event(0), { expectedRevision: before, modelProfileId: h.modelId() });
  assert.equal(result.ok, false);
  assert.equal(h.revision(), before);
});

test('E4 active provider transport cannot be changed but its display name can', async () => {
  const h = createIpcHarness();
  h.flags.inUse = true;
  const renamed = await h.handlers.saveProvider(h.event(), { expectedRevision: h.revision(), provider: {
    id: h.providerId(), name: 'Renamed synthetic', protocol: 'openai-chat-completions',
    baseUrl: 'https://synthetic.invalid/v1', auth: { kind: 'bearer' },
  } });
  assert.equal(renamed.ok, true);
  const moved = await h.handlers.saveProvider(h.event(), { expectedRevision: h.revision(), provider: {
    id: h.providerId(), name: 'Renamed synthetic', protocol: 'openai-chat-completions',
    baseUrl: 'https://other-synthetic.invalid/v1', auth: { kind: 'bearer' },
  } });
  assert.equal(moved.code, 'CONFIG_IN_USE');
  assert.equal(h.settings().modelRegistry.providers[0].baseUrl, 'https://synthetic.invalid/v1');
});

test('E4 sender-owned session references prevent deletion without becoming permissions', async () => {
  const h = createIpcHarness();
  const model = { id: 'model_session_override', name: 'Override', providerId: h.providerId(), model: 'override' };
  assert.equal((await h.handlers.saveModel(h.event(), { model, expectedRevision: h.revision() })).ok, true);
  const refs = await h.handlers.syncSessionReferences(h.event(), { sessions: [
    { sessionId: 'synthetic_session', assistantId: 'assistant_general', modelProfileId: model.id, identityType: 'ai' },
  ] });
  assert.equal(refs.ok, true);
  assert.equal((await h.handlers.remove(h.event(), { kind: 'model', id: model.id, expectedRevision: h.revision() })).code, 'PROFILE_IN_USE');
  h.handlers.dropSender(1);
  assert.equal((await h.handlers.remove(h.event(), { kind: 'model', id: model.id, expectedRevision: h.revision() })).ok, true);
});

test('E4 referenced custom assistant is archived rather than deleting session history', async () => {
  const h = createIpcHarness();
  const saved = await h.handlers.saveAssistant(h.event(), { expectedRevision: h.revision(), assistant: {
    id: 'assistant_synthetic_custom', name: 'Synthetic assistant', systemPrompt: 'A synthetic test persona.',
  } });
  assert.equal(saved.ok, true);
  await h.handlers.syncSessionReferences(h.event(), { sessions: [
    { sessionId: 'session_custom', assistantId: 'assistant_synthetic_custom', modelProfileId: null, identityType: 'ai' },
  ] });
  const result = await h.handlers.deleteAssistant(h.event(), { assistantId: 'assistant_synthetic_custom', expectedRevision: h.revision() });
  assert.equal(result.ok, true);
  assert.equal(h.settings().modelRegistry.assistants.find((a) => a.id === 'assistant_synthetic_custom').archived, true);
  assert.equal((await h.handlers.deleteAssistant(h.event(), { assistantId: 'assistant_codex', expectedRevision: h.revision() })).code, 'PROFILE_IN_USE');
});
