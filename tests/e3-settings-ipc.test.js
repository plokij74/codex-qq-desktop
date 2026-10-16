'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadSettings, saveSettings } = require('../src/ai/settings');
const { SecretManager } = require('../src/ai/secret-manager');
const { probeIsolationCapabilities } = require('../src/ai/os-isolation');

test('E3 Settings & Secrets - apiKey is encrypted in vault and never stored plaintext on disk', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-set-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  const saved = saveSettings(tmpDir, {
    mode: 'api',
    apiKey: 'sk-secret-test-key-12345',
    executionPolicy: 'strict-isolated',
  });

  // 1. Returned in-memory settings has decrypted apiKey and metadata
  assert.equal(saved.apiKey, 'sk-secret-test-key-12345');
  assert.equal(saved.apiKeyConfigured, true);
  assert.equal(saved.secretRef, 'sec_main_api_key');
  assert.equal(saved.executionPolicy, 'strict-isolated');

  // 2. Read raw settings.json directly from disk
  const settingsFile = path.join(tmpDir, 'settings.json');
  assert.ok(fs.existsSync(settingsFile));
  const rawDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  // Plaintext apiKey must NOT exist in settings.json on disk!
  assert.equal(rawDisk.apiKey, undefined);
  assert.equal(rawDisk.apiKeyConfigured, true);
  assert.equal(rawDisk.secretRef, 'sec_main_api_key');

  // 3. Vault file exists and holds encrypted secret
  const vaultFile = path.join(tmpDir, 'secrets.vault.json');
  assert.ok(fs.existsSync(vaultFile));
  const secMgr = new SecretManager({ vaultPath: vaultFile });
  assert.equal(secMgr.hasSecret('main_api_key'), true);
  assert.equal(secMgr.getSecret('main_api_key'), 'sk-secret-test-key-12345');

  // 4. loadSettings reads back decrypted key
  const loaded = loadSettings(tmpDir);
  assert.equal(loaded.apiKey, 'sk-secret-test-key-12345');
  assert.equal(loaded.apiKeyConfigured, true);
  assert.equal(loaded.secretRef, 'sec_main_api_key');
});

test('E3 Settings & Secrets - auto-migrates legacy plaintext apiKey on load', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-mig-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // Write legacy unencrypted settings.json
  const settingsFile = path.join(tmpDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      mode: 'api',
      apiKey: 'sk-legacy-unencrypted-key-999',
      model: 'gpt-4o',
    }),
    'utf8'
  );

  // Load settings - should trigger automatic migration
  const loaded = loadSettings(tmpDir);
  assert.equal(loaded.apiKey, 'sk-legacy-unencrypted-key-999');
  assert.equal(loaded.apiKeyConfigured, true);

  // Check disk: plaintext key must be erased
  const rawDiskAfter = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(rawDiskAfter.apiKey, undefined);
  assert.equal(rawDiskAfter.apiKeyConfigured, true);

  // Check vault: encrypted secret exists
  const vaultFile = path.join(tmpDir, 'secrets.vault.json');
  assert.ok(fs.existsSync(vaultFile));
  const secMgr = new SecretManager({ vaultPath: vaultFile });
  assert.equal(secMgr.getSecret('main_api_key'), 'sk-legacy-unencrypted-key-999');
});

test('E3 Settings & Secrets - probeIsolationCapabilities reports accurate environment', () => {
  const caps = probeIsolationCapabilities();
  assert.equal(typeof caps.platform, 'string');
  assert.equal(typeof caps.containerAvailable, 'boolean');
  assert.equal(typeof caps.processIsolation, 'string');
  assert.equal(typeof caps.networkFiltering, 'boolean');
  assert.equal(typeof caps.safeStorageAvailable, 'boolean');
  assert.equal(typeof caps.recommendation, 'string');
});
