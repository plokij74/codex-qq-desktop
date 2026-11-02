'use strict';

// Main/preload and model bindings are real; settings, credentials and transport
// are isolated fixtures. No userData, environment secret or endpoint is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMainFixture } = require('./helpers/e4-main-fixture');

const invalidSelections = [
  ['missing model target', { modelProfileId: undefined }],
  ['null model target', { modelProfileId: null }],
  ['empty model target', { modelProfileId: '' }],
  ['unknown model target', { modelProfileId: 'model_diagnostic_absent' }],
  ['non-string model target', { modelProfileId: 1 }],
  ['missing checks', { checks: undefined }],
  ['null checks', { checks: null }],
  ['empty checks', { checks: [] }],
  ['non-array checks', { checks: 'text' }],
  ['duplicate checks', { checks: ['text', 'text'] }],
  ['unimplemented check', { checks: ['vision'] }],
];

for (const [name, selection] of invalidSelections) {
  test(`real main rejects diagnostic ${name} without defaulting to paid requests`, async t => {
    const f = loadMainFixture(t);
    const state = await f.invoke('models:list');
    const payload = { modelProfileId: state.registry.defaultModelProfileId, checks: ['text'],
      expectedRevision: state.revision, ...selection };
    // Match IPC serialization of omitted fields rather than relying on undefined.
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const result = await f.invoke('models:diagnose', payload);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'MODEL_CONFIG_INVALID');
    assert.equal(result.accepted, undefined);
    assert.equal(f.requests.length, 0);
    assert.equal(f.credentialReads.length, 0);
    assert.equal(f.events.filter(record => record.channel === 'models:diagnostic-event').length, 0);
    assert.equal(f.inspect('modelDiagnostics?.activeBindings.length || 0'), 0);
    assert.equal(f.inspect('foregroundModels.current'), null);
    assert.equal(f.settings().mode, 'api');
  });
}
