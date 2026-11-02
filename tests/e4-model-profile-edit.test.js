'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, saveProfile, computeBindingRevision, applyObservedCapabilities, effectiveModelCapabilities } = require('../src/ai/model-profiles');

function configured() {
  let registry = createModelRegistry({ baseUrl: 'https://e4-edit.example.invalid/v1', model: 'e4-edit-model' });
  const id = registry.defaultModelProfileId;
  registry = saveProfile(registry, 'model', { id, request: { temperature: 0.4, chatTokenLimitField: 'max_completion_tokens' } }, { expectedRevision: registry.revision });
  return { registry, id };
}

test('an explicit null edit clears optional request fields without inventing temperature', () => {
  let { registry, id } = configured();
  const oldModel = registry.models.find((item) => item.id === id);
  const oldWire = computeBindingRevision(registry.providers[0], oldModel);
  registry = saveProfile(registry, 'model', { id, revision: oldModel.revision, request: { temperature: null, chatTokenLimitField: null } }, { expectedRevision: registry.revision });
  const model = registry.models.find((item) => item.id === id);
  assert.equal(Object.hasOwn(model.request, 'temperature'), false);
  assert.equal(model.request.chatTokenLimitField, 'max_tokens');
  assert.notEqual(computeBindingRevision(registry.providers[0], model), oldWire);
  assert.throws(() => saveProfile(registry, 'model', { id, request: { maxOutputTokens: null } }, { expectedRevision: registry.revision }), (error) => error.code === 'MODEL_CONFIG_INVALID');
});

test('a name-only edit and one changed declaration preserve other valid observed evidence', () => {
  let { registry, id } = configured();
  const provider = registry.providers[0], model = registry.models.find((item) => item.id === id);
  const wire = computeBindingRevision(provider, model);
  registry = applyObservedCapabilities(registry, { modelProfileId: id, bindingRevision: wire,
    observations: { text: { state: 'supported', checkedAt: '2026-10-30T00:00:00.000Z' }, usage: { state: 'supported', checkedAt: '2026-10-30T00:00:00.000Z' } } });
  registry = saveProfile(registry, 'model', { id, name: 'New visible name', capabilities: { temperature: { state: 'unsupported', source: 'declared' } } }, { expectedRevision: registry.revision });
  const updated = registry.models.find((item) => item.id === id), caps = effectiveModelCapabilities(registry.providers[0], updated);
  assert.equal(computeBindingRevision(registry.providers[0], updated), wire);
  assert.equal(caps.text.state, 'supported'); assert.equal(caps.text.source, 'observed');
  assert.equal(caps.usage.state, 'supported'); assert.equal(caps.usage.source, 'observed');
  assert.equal(caps.temperature.state, 'unsupported'); assert.equal(caps.temperature.source, 'declared');
});
