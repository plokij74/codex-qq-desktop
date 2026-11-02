'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SecretManager } = require('../src/ai/secret-manager');
const { createModelRegistry } = require('../src/ai/model-profiles');
const { createModelIpcHandlers } = require('../src/ai/model-ipc');
const fs = require('node:fs');

// Exercise the real mutation methods, but replace cryptography and persistence.
// No userData, vault file, machine/environment-derived key or endpoint is used.
function memoryVault() {
  const manager = new SecretManager({ useSafeStorage: false });
  manager.registeredSecrets = new Map();
  manager._encryptValue = (value) => ({ cipher: 'fixture-only', data: value });
  manager._decryptValue = (record) => record.data;
  let persisted = structuredClone(manager.vault);
  let failSave = false;
  manager.save = () => {
    if (failSave) throw new Error('fixture persistence failure');
    persisted = structuredClone(manager.vault);
  };
  return { manager, persisted: () => structuredClone(persisted), failSave: (value) => { failSave = value; } };
}

test('E4 SecretManager failed insert does not publish a phantom credential and remains retryable', () => {
  const h = memoryVault(); const before = structuredClone(h.manager.vault); h.failSave(true);
  assert.throws(() => h.manager.setSecret('model_new', 'fixture-new-value'), /fixture persistence failure/);
  assert.deepEqual(h.manager.vault, before); assert.deepEqual(h.persisted(), before);
  assert.equal(h.manager.hasSecret('model_new'), false); assert.equal(h.manager.getSecret('model_new'), null);
  // Even an uncommitted candidate stays registered to prevent error/output leaks.
  assert.ok(!h.manager.redactSecrets('fixture-new-value').includes('fixture-new-value'));
  h.failSave(false); assert.equal(h.manager.setSecret('model_new', 'fixture-new-value'), true);
  assert.equal(h.manager.getSecret('model_new'), 'fixture-new-value'); assert.deepEqual(h.manager.vault, h.persisted());
});

test('E4 SecretManager failed replacement preserves the old encrypted record and metadata', () => {
  const h = memoryVault(); h.manager.setSecret('model_current', 'fixture-old-value', { label: 'Original label' });
  const before = structuredClone(h.manager.vault); h.failSave(true);
  assert.throws(() => h.manager.setSecret('model_current', 'fixture-next-value', { label: 'Changed label' }), /fixture persistence failure/);
  assert.deepEqual(h.manager.vault, before); assert.deepEqual(h.persisted(), before);
  assert.equal(h.manager.getSecret('model_current'), 'fixture-old-value');
  h.failSave(false); assert.equal(h.manager.setSecret('model_current', 'fixture-next-value', { label: 'Changed label' }), true);
  assert.equal(h.manager.getSecret('model_current'), 'fixture-next-value');
  assert.equal(h.manager.vault.secrets.model_current.createdAt, before.secrets.model_current.createdAt);
  assert.equal(h.manager.vault.secrets.model_current.label, 'Changed label'); assert.deepEqual(h.manager.vault, h.persisted());
});

test('E4 SecretManager failed deletion restores the old record until a durable retry succeeds', () => {
  const h = memoryVault(); h.manager.setSecret('model_retired', 'fixture-retired-value');
  const before = structuredClone(h.manager.vault); h.failSave(true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => h.manager.deleteSecret('model_retired'), /fixture persistence failure/);
    assert.deepEqual(h.manager.vault, before); assert.deepEqual(h.persisted(), before);
    assert.equal(h.manager.hasSecret('model_retired'), true); assert.equal(h.manager.getSecret('model_retired'), 'fixture-retired-value');
  }
  h.failSave(false); assert.equal(h.manager.deleteSecret('model_retired'), true);
  assert.equal(h.manager.hasSecret('model_retired'), false); assert.equal(h.manager.getSecret('model_retired'), null);
  assert.deepEqual(h.manager.vault, h.persisted()); assert.equal(h.manager.deleteSecret('model_retired'), false);
});

function memoryIpc({ shared = false } = {}) {
  const vault = memoryVault(); vault.manager.setSecret('main_api_key', 'fixture-bound-value');
  let settings = { mode: 'local', baseUrl: 'https://e4-fault.invalid/v1', model: 'fixture-model',
    apiKeyConfigured: true, secretRef: 'sec_main_api_key' };
  settings.modelRegistry = createModelRegistry(settings);
  if (shared) settings.modelRegistry.providers.push({ ...structuredClone(settings.modelRegistry.providers[0]), id: 'provider_shared', name: 'Shared provider' });
  const commits = [];
  const handlers = createModelIpcHandlers({
    getSettings: () => structuredClone(settings),
    saveSettings: (partial) => { commits.push(structuredClone(partial)); settings = { ...settings, ...structuredClone(partial) }; },
    getSecretManager: () => vault.manager,
  });
  return { ...vault, handlers, commits, settings: () => structuredClone(settings),
    event: { sender: { id: 1, isDestroyed: () => false } },
    revision: () => settings.modelRegistry.revision,
    providerId: settings.modelRegistry.providers[0].id };
}

test('E4 actual SecretManager save failures keep committed clear cleanup pending across repeated retries', async () => {
  const h = memoryIpc(); const revision = h.revision(); h.failSave(true);
  const cleared = await h.handlers.clearCredential(h.event, { providerId: h.providerId, expectedRevision: revision });
  assert.equal(cleared.ok, true); assert.equal(cleared.cleanupState, 'pending'); assert.equal(cleared.revision, revision + 1);
  assert.equal(h.manager.hasSecret('main_api_key'), true); assert.ok(h.persisted().secrets.main_api_key);
  const failedRetry = await h.handlers.retryCredentialCleanup(h.event, { expectedRevision: h.revision() });
  assert.equal(failedRetry.ok, true); assert.equal(failedRetry.cleanupState, 'pending');
  assert.deepEqual(h.settings().modelCredentialCleanup, ['main_api_key']);
  assert.equal(h.settings().modelRegistry.providers[0].auth.secretRef, '');
  h.failSave(false);
  const success = await h.handlers.retryCredentialCleanup(h.event, { expectedRevision: h.revision() });
  assert.equal(success.ok, true); assert.equal(success.cleanupState, 'clean'); assert.equal(h.manager.hasSecret('main_api_key'), false);
  assert.equal(h.persisted().secrets.main_api_key, undefined); assert.equal(h.revision(), revision + 1);
});

test('E4 provider invalidation and its retired physical reference share one settings commit', async () => {
  const h = memoryIpc(); h.failSave(true);
  const moved = await h.handlers.saveProvider(h.event, { expectedRevision: h.revision(),
    provider: { id: h.providerId, baseUrl: 'https://e4-fault-moved.invalid/v1' } });
  assert.equal(moved.ok, true); assert.equal(moved.cleanupState, 'pending'); assert.equal(moved.mode, 'local');
  assert.equal(h.commits[0].modelRegistry.providers[0].auth.secretRef, '');
  assert.deepEqual(h.commits[0].modelCredentialCleanup, ['main_api_key']);
  assert.equal(h.manager.hasSecret('main_api_key'), true); assert.ok(h.persisted().secrets.main_api_key);
  h.failSave(false); const retried = await h.handlers.retryCredentialCleanup(h.event, { expectedRevision: h.revision() });
  assert.equal(retried.cleanupState, 'clean'); assert.equal(h.persisted().secrets.main_api_key, undefined);
});

test('E4 invalidating one provider never retires a shared legacy credential still bound to another provider', async () => {
  const h = memoryIpc({ shared: true });
  const moved = await h.handlers.saveProvider(h.event, { expectedRevision: h.revision(),
    provider: { id: h.providerId, auth: { kind: 'none' } } });
  assert.equal(moved.ok, true); assert.equal(moved.cleanupState, 'clean');
  assert.equal(h.settings().modelRegistry.providers[0].auth.secretRef, '');
  assert.equal(h.settings().modelRegistry.providers[1].auth.secretRef, 'sec_main_api_key');
  assert.equal(h.manager.getSecret('main_api_key'), 'fixture-bound-value'); assert.ok(h.persisted().secrets.main_api_key);
  assert.deepEqual(h.settings().modelCredentialCleanup, []);
});

const validVaultText = () => JSON.stringify({ version: 1, salt: '01'.repeat(16),
  secrets: { persisted: { cipher: 'fixture-only', data: 'fixture-original-value', label: 'Original' } } });

function memoryFileVault(t, text = validVaultText()) {
  const h = memoryVault(); const manager = h.manager;
  manager.vaultPath = 'E4_MEMORY_ONLY/secrets.vault.json';
  manager.save = SecretManager.prototype.save;
  let raw = text; let readError = null; let writes = 0; let encryptions = 0;
  const temporary = new Map();
  const checkPath = (file) => assert.equal(String(file), manager.vaultPath);
  t.mock.method(fs, 'existsSync', (file) => { checkPath(file); return raw !== null; });
  t.mock.method(fs, 'readFileSync', (file) => {
    checkPath(file);
    if (readError) throw Object.assign(new Error('fixture unreadable'), { code: readError });
    if (raw === null) throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' });
    return raw;
  });
  t.mock.method(fs, 'mkdirSync', () => {});
  t.mock.method(fs, 'writeFileSync', (file, value) => { writes += 1; temporary.set(String(file), String(value)); });
  t.mock.method(fs, 'renameSync', (from, to) => { checkPath(to); assert.ok(temporary.has(String(from))); raw = temporary.get(String(from)); temporary.delete(String(from)); });
  manager._encryptValue = (value) => { encryptions += 1; return { cipher: 'fixture-only', data: value }; };
  return { manager, raw: () => raw, writes: () => writes, encryptions: () => encryptions,
    setText: (value) => { raw = value; }, readFailure: (code) => { readError = code; } };
}

function assertUnavailable(h) {
  const before = structuredClone(h.manager.vault); const raw = h.raw(); const writes = h.writes(); const encryptions = h.encryptions();
  assert.equal(h.manager.getSecret('persisted'), null);
  const blocked = (error) => error.code === 'SECRET_VAULT_UNAVAILABLE';
  assert.throws(() => h.manager.hasSecret('persisted'), blocked);
  assert.throws(() => h.manager.listSecrets(), blocked);
  assert.throws(() => h.manager.setSecret('candidate', 'fixture-candidate-value'), blocked);
  assert.throws(() => h.manager.deleteSecret('persisted'), blocked);
  assert.throws(() => h.manager.deleteSecret('absent'), blocked);
  assert.throws(() => h.manager.save(), blocked);
  assert.equal(h.manager.vaultState, 'unavailable');
  assert.deepEqual(h.manager.vault, before); assert.equal(h.raw(), raw); assert.equal(h.writes(), writes); assert.equal(h.encryptions(), encryptions);
}

test('E4 unreadable existing vault cannot be overwritten or treated as an absent credential until successful reload', (t) => {
  const h = memoryFileVault(t); const original = h.raw(); h.readFailure('EACCES');
  h.manager.load(); assertUnavailable(h); assert.equal(h.raw(), original);
  h.readFailure(null); assert.equal(h.manager.load(), true); assert.equal(h.manager.vaultState, 'ready');
  assert.equal(h.manager.getSecret('persisted'), 'fixture-original-value');
  assert.equal(h.manager.setSecret('candidate', 'fixture-recovered-value'), true);
  assert.equal(JSON.parse(h.raw()).secrets.persisted.data, 'fixture-original-value');
  assert.equal(JSON.parse(h.raw()).secrets.candidate.data, 'fixture-recovered-value');
});

test('E4 malformed and unsupported vault documents remain unchanged and block destructive mutation', (t) => {
  const h = memoryFileVault(t);
  for (const raw of ['{broken', '{}', '[]', JSON.stringify({ version: 2, salt: '01'.repeat(16), secrets: {} }),
    JSON.stringify({ version: 1, salt: '01'.repeat(16), secrets: [] }),
    JSON.stringify({ version: 1, salt: '01'.repeat(16), secrets: { invalid: null } })]) {
    h.setText(raw); h.manager.load(); assertUnavailable(h); assert.equal(h.raw(), raw);
  }
  h.setText(validVaultText()); assert.equal(h.manager.load(), true); assert.equal(h.manager.getSecret('persisted'), 'fixture-original-value');
});

test('E4 a failed reload hides stale readable credentials and only a verified existing document clears unavailable state', (t) => {
  const h = memoryFileVault(t); h.manager.load(); const previouslyLoaded = structuredClone(h.manager.vault);
  h.readFailure('EACCES'); h.manager.load(); assertUnavailable(h); assert.deepEqual(h.manager.vault, previouslyLoaded);
  h.readFailure(null); h.setText(null); h.manager.load(); assertUnavailable(h);
  h.setText(validVaultText()); assert.equal(h.manager.load(), true); assert.equal(h.manager.vaultState, 'ready');
  assert.equal(h.manager.getSecret('persisted'), 'fixture-original-value');
});

test('E4 a genuinely absent new vault remains writable without reading machine secrets', (t) => {
  const h = memoryFileVault(t, null); h.manager.load();
  assert.equal(h.manager.vaultState, 'ready'); assert.equal(h.manager.setSecret('new_fixture', 'fixture-new-vault-value'), true);
  assert.equal(JSON.parse(h.raw()).secrets.new_fixture.data, 'fixture-new-vault-value');
});
