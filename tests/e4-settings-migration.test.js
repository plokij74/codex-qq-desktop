'use strict';

// The only data read/written by these tests is temporary, explicitly synthetic data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSettings, saveSettings, getSettingsPath, getModelRegistryBackupPath, getSettingsSecretManager } = require('../src/ai/settings');
const { createModelRegistry, saveProfile, updateModelRegistry, publicModelRegistry } = require('../src/ai/model-profiles');

class SyntheticSecrets {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.reads = []; this.writes = []; }
  registerSecret() {}
  hasSecret(id) { return this.values.has(id); }
  getSecret(id) { this.reads.push(id); return this.values.get(id) || null; }
  setSecret(id, value) { this.writes.push(id); this.values.set(id, value); }
  deleteSecret(id) { return this.values.delete(id); }
}
function fixture(t, data) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-synthetic-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = getSettingsPath(root);
  if (data !== undefined) fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const manager = new SyntheticSecrets({ main_api_key: 'synthetic-only-key-not-a-real-credential' });
  return { root, file, manager, options: { secretManager: manager, resolveLegacyApiKey: false }, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/e4-models/settings-legacy.synthetic.json'), 'utf8'));
const future = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/e4-models/settings-future.synthetic.json'), 'utf8'));

test('main-only secret-manager accessor reuses one instance per isolated settings directory', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  assert.equal(getSettingsSecretManager(first.root), getSettingsSecretManager(first.root));
  assert.notEqual(getSettingsSecretManager(first.root), getSettingsSecretManager(second.root));
  assert.equal(fs.existsSync(first.file), false);
});

test('legacy migration backs up once, atomically preserves other settings/mode and is idempotent', (t) => {
  const f = fixture(t, legacy);
  const first = loadSettings(f.root, f.options);
  const backup = getModelRegistryBackupPath(f.root);
  assert.equal(fs.existsSync(backup), true);
  assert.equal(first.mode, 'local');
  assert.equal(first.maxAgentTurns, 0);
  assert.deepEqual(first.syntheticUnknownSetting, { preserved: true });
  assert.equal(first.modelRegistry.providers[0].id, 'provider_legacy_openai');
  assert.equal(first.modelRegistry.models[0].id, 'model_legacy_default');
  assert.equal(first.modelRegistry.models[0].model, legacy.model);
  assert.equal(first.modelRegistry.providers[0].auth.secretRef, 'sec_main_api_key');
  assert.equal(first.apiKey, '');
  assert.deepEqual(f.manager.reads, []);
  const settingsBytes = fs.readFileSync(f.file, 'utf8');
  const backupBytes = fs.readFileSync(backup, 'utf8');
  assert.deepEqual(loadSettings(f.root, f.options), first);
  assert.equal(fs.readFileSync(f.file, 'utf8'), settingsBytes);
  assert.equal(fs.readFileSync(backup, 'utf8'), backupBytes);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
});

test('legacy plaintext migrates to controlled storage without placing new plaintext in backup', (t) => {
  const key = 'synthetic-only-plaintext-for-migration';
  const f = fixture(t, { ...legacy, apiKey: key });
  const result = loadSettings(f.root, f.options);
  assert.equal(result.apiKey, '');
  assert.equal(f.manager.values.get('main_api_key'), key);
  const disk = fs.readFileSync(f.file, 'utf8');
  const backup = fs.readFileSync(getModelRegistryBackupPath(f.root), 'utf8');
  assert.equal(disk.includes(key), false);
  assert.equal(backup.includes(key), false);
  assert.equal(Object.hasOwn(JSON.parse(backup), 'apiKey'), false);
});

test('compatibility callers may still resolve legacy key while opt-out never decrypts it, including save internal load', (t) => {
  const f = fixture(t, legacy);
  loadSettings(f.root, f.options);
  f.manager.getSecret = () => { throw new Error('synthetic test: legacy key must not be decrypted'); };
  assert.equal(loadSettings(f.root, f.options).apiKey, '');
  assert.equal(saveSettings(f.root, { mode: 'api' }, f.options).apiKey, '');
  assert.equal(f.disk().mode, 'api');
  const compatible = new SyntheticSecrets({ main_api_key: 'synthetic-only-compatible-key' });
  assert.equal(loadSettings(f.root, { secretManager: compatible }).apiKey, 'synthetic-only-compatible-key');
});

test('default settings load is isolated and first legacy save remains compatible', (t) => {
  const f = fixture(t);
  f.manager.values.clear();
  const missing = loadSettings(f.root, f.options);
  assert.equal(missing.mode, 'local');
  assert.equal(missing.modelRegistry.schemaVersion, 1);
  assert.equal(fs.existsSync(f.file), false);
  const saved = saveSettings(f.root, { mode: 'api', apiKey: 'synthetic-first-save', model: 'synthetic-first-model' }, { secretManager: f.manager });
  assert.equal(saved.model, 'synthetic-first-model');
  assert.equal(saved.apiKey, 'synthetic-first-save');
  assert.equal(saved.modelRegistry.models[0].model, 'synthetic-first-model');
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('synthetic-first-save'), false);
});

test('existing registry is authoritative over old aliases and a cleared ref is not resurrected from legacy vault', (t) => {
  const f = fixture(t, legacy);
  const migrated = loadSettings(f.root, f.options);
  const cleared = updateModelRegistry(migrated.modelRegistry, (r) => {
    r.providers[0].auth.secretRef = '';
    r.providers[0].auth.credentialOrigin = null;
    r.providers[0].auth.credentialRevision += 1;
  });
  saveSettings(f.root, { modelRegistry: cleared }, { ...f.options, trustedModelRegistry: true });
  const disk = f.disk(); disk.baseUrl = 'https://must-not-use.synthetic.example/v1'; disk.model = 'must-not-use';
  fs.writeFileSync(f.file, JSON.stringify(disk));
  const read = loadSettings(f.root, f.options);
  assert.equal(read.model, legacy.model);
  assert.equal(read.baseUrl, 'https://synthetic.example/gateway/v1');
  assert.equal(read.modelRegistry.providers[0].auth.secretRef, '');
  assert.equal(read.apiKeyConfigured, false);
  assert.deepEqual(f.manager.reads, []);
  const saved = saveSettings(f.root, { baseUrl: 'https://ignored.synthetic.example', model: 'ignored', secretRef: 'synthetic-incoming-ref', apiKeyConfigured: true }, f.options);
  assert.deepEqual(saved.modelRegistry, cleared);
  assert.equal(saved.model, legacy.model);
  assert.equal(saved.secretRef, '');
});

test('atomic settings commit tolerates a synthetic transient rename sharing error without replacing the backup', (t) => {
  const f = fixture(t, legacy);
  loadSettings(f.root, f.options);
  const backup = fs.readFileSync(getModelRegistryBackupPath(f.root), 'utf8');
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === f.file && ++attempts === 1) throw Object.assign(new Error('synthetic transient rename sharing error'), { code: 'EPERM' });
    return rename(from, to);
  };
  try { assert.equal(saveSettings(f.root, { mode: 'api' }, f.options).mode, 'api'); }
  finally { fs.renameSync = rename; }
  assert.ok(attempts >= 2 && attempts <= 5);
  assert.equal(f.disk().mode, 'api');
  assert.equal(fs.readFileSync(getModelRegistryBackupPath(f.root), 'utf8'), backup);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
});

test('permanent rename sharing errors have a bounded retry and preserve the prior settings atomically', (t) => {
  const f = fixture(t, legacy);
  loadSettings(f.root, f.options);
  const before = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === f.file) { attempts += 1; throw Object.assign(new Error('synthetic permanent rename sharing error'), { code: 'EBUSY' }); }
    return rename(from, to);
  };
  try { assert.throws(() => saveSettings(f.root, { mode: 'api' }, f.options), (error) => error.code === 'EBUSY'); }
  finally { fs.renameSync = rename; }
  assert.ok(attempts > 1 && attempts <= 5);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
  assert.equal(loadSettings(f.root, f.options).mode, legacy.mode);
});

test('public settings writes cannot replace registry or cleanup journal; main-owned transactions can', (t) => {
  const f = fixture(t, legacy);
  const first = loadSettings(f.root, f.options);
  const replacement = saveProfile(first.modelRegistry, 'model', { id: 'model_legacy_default', model: 'synthetic-new-model' });
  const publicWrite = saveSettings(f.root, { modelRegistry: replacement, modelCredentialCleanup: ['synthetic-forbidden-ref'], mode: 'api' }, f.options);
  assert.deepEqual(publicWrite.modelRegistry, first.modelRegistry);
  assert.equal(publicWrite.mode, 'api');
  assert.deepEqual(publicWrite.modelCredentialCleanup, []);
  const mainWrite = saveSettings(f.root, { modelRegistry: replacement, modelCredentialCleanup: ['synthetic-retired-ref'] }, { ...f.options, trustedModelRegistry: true });
  assert.deepEqual(mainWrite.modelRegistry, replacement);
  assert.deepEqual(mainWrite.modelCredentialCleanup, ['synthetic-retired-ref']);
  assert.equal(mainWrite.model, 'synthetic-new-model');
  assert.equal(JSON.stringify(publicModelRegistry(mainWrite.modelRegistry)).includes('synthetic-retired-ref'), false);
  const omitted = saveSettings(f.root, { terminalEnabled: true, modelCredentialCleanup: [] }, f.options);
  assert.deepEqual(omitted.modelCredentialCleanup, ['synthetic-retired-ref']);
  assert.equal(omitted.terminalEnabled, true);
});

test('trusted registry commits validate configuration and reject stale revisions before writing', (t) => {
  const f = fixture(t, legacy);
  const first = loadSettings(f.root, f.options);
  const current = saveProfile(first.modelRegistry, 'model', { id: 'model_legacy_default', name: 'Changed' });
  saveSettings(f.root, { modelRegistry: current }, { ...f.options, trustedModelRegistry: true });
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => saveSettings(f.root, { modelRegistry: first.modelRegistry }, { ...f.options, trustedModelRegistry: true }), { code: 'CONFIG_CONFLICT' });
  const invalid = JSON.parse(JSON.stringify(current)); invalid.defaultModelProfileId = 'missing';
  assert.throws(() => saveSettings(f.root, { modelRegistry: invalid }, { ...f.options, trustedModelRegistry: true }), { code: 'MODEL_CONFIG_INVALID' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('unknown future registry rejects reads and writes without touching file, backup or vault', (t) => {
  const f = fixture(t, future);
  const raw = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => loadSettings(f.root, f.options), { code: 'MODEL_REGISTRY_VERSION_UNSUPPORTED' });
  assert.throws(() => saveSettings(f.root, { mode: 'local', apiKey: 'synthetic-not-accepted' }, { secretManager: f.manager }), { code: 'MODEL_REGISTRY_VERSION_UNSUPPORTED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
  assert.equal(fs.existsSync(getModelRegistryBackupPath(f.root)), false);
  assert.deepEqual(f.manager.reads, []);
  assert.deepEqual(f.manager.writes, []);
});

test('invalid legacy data and malformed existing JSON fail closed instead of returning blank defaults', (t) => {
  for (const data of [{ ...legacy, baseUrl: 'file:///synthetic-invalid' }, '{synthetic-malformed-json']) {
    const f = fixture(t, data);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.throws(() => loadSettings(f.root, f.options), (error) => error.code === 'MODEL_CONFIG_INVALID' && error.needsRepair === true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(fs.existsSync(getModelRegistryBackupPath(f.root)), false);
  }
});

test('missing/unavailable vault keeps configured reference and API mode, without alternate-provider fallback', (t) => {
  const f = fixture(t, { ...legacy, mode: 'api' });
  f.manager.values.clear();
  const loaded = loadSettings(f.root, f.options);
  assert.equal(loaded.mode, 'api');
  assert.equal(loaded.modelRegistry.providers[0].auth.secretRef, 'sec_main_api_key');
  const dto = publicModelRegistry(loaded.modelRegistry, { getCredentialState: () => 'unavailable' });
  assert.equal(dto.providers[0].credentialState, 'unavailable');
  f.manager.getSecret = () => { throw new Error('synthetic vault unavailable'); };
  const compatible = loadSettings(f.root, { secretManager: f.manager });
  assert.equal(compatible.mode, 'api');
  assert.equal(compatible.apiKey, '');
  assert.equal(compatible.modelRegistry.providers[0].auth.secretRef, 'sec_main_api_key');
});

test('failed vault migration preserves original legacy file and reports a repairable error', (t) => {
  const f = fixture(t, { ...legacy, apiKey: 'synthetic-not-storable' });
  const before = fs.readFileSync(f.file, 'utf8');
  f.manager.setSecret = () => { throw new Error('synthetic vault write failure'); };
  assert.throws(() => loadSettings(f.root, f.options), { code: 'MODEL_CREDENTIAL_UNAVAILABLE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.existsSync(getModelRegistryBackupPath(f.root)), false);
});

test('failed atomic migration commit retains original and backup; retry remains idempotent', (t) => {
  const f = fixture(t, legacy);
  const before = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === f.file) throw new Error('synthetic migration commit failure');
    return rename(source, destination);
  };
  try { assert.throws(() => loadSettings(f.root, f.options), /synthetic migration commit failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const backupBytes = fs.readFileSync(getModelRegistryBackupPath(f.root), 'utf8');
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
  assert.equal(loadSettings(f.root, f.options).modelRegistry.models.length, 1);
  assert.equal(fs.readFileSync(getModelRegistryBackupPath(f.root), 'utf8'), backupBytes);
});

test('post-migration opt-out does not re-read even legacy credential metadata', (t) => {
  const f = fixture(t, legacy);
  loadSettings(f.root, f.options);
  f.manager.hasSecret = () => { throw new Error('synthetic forbidden metadata re-read'); };
  f.manager.getSecret = () => { throw new Error('synthetic forbidden plaintext re-read'); };
  const loaded = loadSettings(f.root, f.options);
  assert.equal(loaded.modelRegistry.providers[0].auth.secretRef, 'sec_main_api_key');
  assert.equal(saveSettings(f.root, { terminalEnabled: true }, f.options).apiKey, '');
  assert.equal(loadSettings(f.root, { secretManager: f.manager, resolveSecrets: false }).apiKey, '');
});

test('partial migration does not overwrite an already bound vault record from a stale plaintext alias', (t) => {
  const partial = createModelRegistry(legacy); partial.migration.completed = false;
  const f = fixture(t, { ...legacy, modelRegistry: partial, apiKey: 'synthetic-stale-plaintext-alias' });
  const originalKey = f.manager.values.get('main_api_key');
  const loaded = loadSettings(f.root, f.options);
  assert.equal(loaded.modelRegistry.providers[0].auth.secretRef, 'sec_main_api_key');
  assert.equal(f.manager.values.get('main_api_key'), originalKey);
  assert.deepEqual(f.manager.writes, []);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('synthetic-stale-plaintext-alias'), false);
});

test('half-complete migration resumes by stable IDs and does not duplicate edited profiles', (t) => {
  const complete = createModelRegistry(legacy);
  complete.providers[0].name = 'Synthetic edited legacy provider';
  complete.models = []; complete.assistants = []; complete.migration.completed = false;
  const f = fixture(t, { ...legacy, modelRegistry: complete });
  const first = loadSettings(f.root, f.options);
  assert.equal(first.modelRegistry.providers.length, 1);
  assert.equal(first.modelRegistry.providers[0].name, 'Synthetic edited legacy provider');
  assert.equal(first.modelRegistry.models.length, 1);
  assert.equal(first.modelRegistry.assistants.length, 2);
  assert.deepEqual(loadSettings(f.root, f.options).modelRegistry, first.modelRegistry);
});
