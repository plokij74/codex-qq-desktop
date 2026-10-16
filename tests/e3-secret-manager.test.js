'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  SecretManager,
  migrateSettingsFile,
} = require('../src/ai/secret-manager');

test('E3 SecretManager - AES-256-GCM vault encrypts, decrypts and lists secrets', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-secret-test-'));
  const vaultPath = path.join(tmpDir, 'secrets.vault.json');

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  const sm = new SecretManager({ vaultPath, useSafeStorage: false });

  // 1. Set secret
  const ok = sm.setSecret('test_api_key', 'sk-proj-1234567890abcdefg', { label: 'Test API Key' });
  assert.equal(ok, true);
  assert.equal(sm.hasSecret('test_api_key'), true);

  // 2. Read back
  const retrieved = sm.getSecret('test_api_key');
  assert.equal(retrieved, 'sk-proj-1234567890abcdefg');

  // 3. Inspect raw file: must NOT contain plaintext secret
  const rawFile = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!rawFile.includes('sk-proj-1234567890abcdefg'));
  const parsed = JSON.parse(rawFile);
  assert.equal(parsed.secrets.test_api_key.cipher, 'aes-256-gcm');
  assert.ok(parsed.secrets.test_api_key.authTag);
  assert.ok(parsed.secrets.test_api_key.iv);

  // 4. List secrets does not expose sensitive value
  const list = sm.listSecrets();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'test_api_key');
  assert.equal(list[0].label, 'Test API Key');
  assert.equal(list[0].value, undefined);

  // 5. Delete secret
  const delOk = sm.deleteSecret('test_api_key');
  assert.equal(delOk, true);
  assert.equal(sm.hasSecret('test_api_key'), false);
  assert.equal(sm.getSecret('test_api_key'), null);
});

test('E3 SecretManager - Dynamic registration and redaction prevents leaks', () => {
  const sm = new SecretManager({ useSafeStorage: false });
  sm.registerSecret('my-super-secret-passphrase', 'CUSTOM_PASS');

  // Exact registered match
  const text1 = 'User logged in with passphrase: my-super-secret-passphrase!';
  assert.equal(sm.redactSecrets(text1), 'User logged in with passphrase: [REDACTED:CUSTOM_PASS]!');

  // Bearer token pattern
  const text2 = 'Authorization: Bearer abc1234567890xyz';
  assert.equal(sm.redactSecrets(text2), 'Authorization: Bearer [REDACTED]');

  // sk- API key pattern
  const text3 = 'Model request failed with key sk-123456789012345678901234567890';
  assert.ok(sm.redactSecrets(text3).includes('[REDACTED:API_KEY]'));
  assert.ok(!sm.redactSecrets(text3).includes('sk-123456789012345678901234567890'));

  // Assignment pattern
  const text4 = 'DEBUG: apiKey="secret_value_123456" in payload';
  const redacted4 = sm.redactSecrets(text4);
  assert.ok(redacted4.includes('apiKey="[REDACTED]"') || redacted4.includes('apiKey=[REDACTED]'));
  assert.ok(!redacted4.includes('secret_value_123456'));
});

test('E3 SecretManager - migrateSettingsFile cleans plaintext apiKey from settings.json', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-migrate-test-'));
  const settingsPath = path.join(tmpDir, 'settings.json');
  const vaultPath = path.join(tmpDir, 'secrets.vault.json');

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // Create legacy settings.json with plaintext key
  const legacySettings = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-legacy-secret-to-migrate-999',
    model: 'gpt-4o-mini',
  };
  fs.writeFileSync(settingsPath, JSON.stringify(legacySettings, null, 2), 'utf8');

  const sm = new SecretManager({ vaultPath, useSafeStorage: false });

  // Run migration
  const result = migrateSettingsFile(settingsPath, sm);
  assert.equal(result.migrated, true);
  assert.equal(result.secretRef, 'sec_main_api_key');

  // Verify migrated secret in vault
  assert.equal(sm.getSecret('main_api_key'), 'sk-legacy-secret-to-migrate-999');

  // Verify settings.json on disk has NO plaintext apiKey
  const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(updatedSettings.apiKey, undefined);
  assert.equal(updatedSettings.apiKeyConfigured, true);
  assert.equal(updatedSettings.secretRef, 'sec_main_api_key');
  assert.equal(updatedSettings.model, 'gpt-4o-mini');
});
