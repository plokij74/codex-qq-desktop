'use strict';
// Isolated synthetic configuration and credentials. Never reads userData or the environment.
const { createModelRegistry } = require('../../../src/ai/model-profiles');
const { createModelIpcHandlers } = require('../../../src/ai/model-ipc');

const clone = (value) => structuredClone(value);
function createIpcHarness() {
  let settings = { mode: 'api', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
    apiKeyConfigured: true, secretRef: 'sec_main_api_key', memoryEnabled: true };
  settings.modelRegistry = createModelRegistry(settings);
  const values = new Map([['main_api_key', 'synthetic-credential-not-a-real-key']]);
  const flags = { commitFailure: false, storeFailure: false, verifyFailure: false, deleteFailure: false, inUse: false };
  const deleted = [];
  const changes = [];
  const manager = {
    hasSecret: (ref) => values.has(ref),
    getSecret: (ref) => { if (flags.verifyFailure) throw new Error('synthetic decode failure'); return values.get(ref) || null; },
    setSecret: (ref, value) => { if (flags.storeFailure) throw new Error('synthetic store failure'); values.set(ref, value); return true; },
    deleteSecret: (ref) => { if (flags.deleteFailure) throw new Error('synthetic cleanup failure'); deleted.push(ref); return values.delete(ref); },
    registerSecret: () => {},
  };
  const handlers = createModelIpcHandlers({
    getSettings: () => clone(settings),
    saveSettings: (partial) => { if (flags.commitFailure) throw new Error('synthetic commit failure'); settings = { ...settings, ...clone(partial) }; return clone(settings); },
    getSecretManager: () => manager,
    isInUse: () => flags.inUse,
    onRegistryChange: (before, after) => changes.push({ before: clone(before), after: clone(after) }),
  });
  const event = (id = 1) => ({ sender: { id, isDestroyed: () => false } });
  return { handlers, event, manager, values, flags, deleted, changes, settings: () => clone(settings),
    revision: () => settings.modelRegistry.revision,
    providerId: () => settings.modelRegistry.providers[0].id,
    modelId: () => settings.modelRegistry.models[0].id };
}
module.exports = { createIpcHarness };
