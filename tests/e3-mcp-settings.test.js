'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { loadSettings, saveSettings } = require('../src/ai/settings');
const { SecretManager } = require('../src/ai/secret-manager');
const { exportSessionJson, exportSessionMarkdown } = require('../src/ai/session-export');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-mcp-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const vault = path.join(root, 'secrets.vault.json');
  const manager = new SecretManager({ vaultPath: vault, useSafeStorage: false });
  return { root, file, vault, manager, options: { secretManager: manager }, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
function servers() {
  return [
    { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer mock-header-e3-7234', Cookie: 'mock-cookie-e3-7234' } },
    { name: 'local', transport: 'stdio', command: 'node', env: { SERVICE_TOKEN: 'mock-env-e3-7234', OPAQUE: 'mock-opaque-e3-7234', MODE: 'development' }, args: ['server.js'] },
  ];
}
const secrets = ['mock-header-e3-7234', 'mock-cookie-e3-7234', 'mock-env-e3-7234', 'mock-opaque-e3-7234'];
function assertNoSecrets(text) { for (const value of secrets) assert.equal(text.includes(value), false, value); }

test('MCP maps persist only in the encrypted vault and reload with a fresh manager', (t) => {
  const f = fixture(t);
  const saved = saveSettings(f.root, { mcpServers: servers() }, f.options);
  assert.deepEqual(saved.mcpServers[0].headers, servers()[0].headers);
  assert.deepEqual(saved.mcpServers[1].env, servers()[1].env);
  assertNoSecrets(fs.readFileSync(f.file, 'utf8'));
  assertNoSecrets(fs.readFileSync(f.vault, 'utf8'));
  for (const server of f.disk().mcpServers) {
    assert.match(server.credentialsRef, /^mcp_credentials_[a-f0-9]{32}$/);
    assert.equal(server.headers, undefined);
    assert.equal(server.env, undefined);
  }
  const fresh = new SecretManager({ vaultPath: f.vault, useSafeStorage: false });
  const loaded = loadSettings(f.root, { secretManager: fresh });
  assert.deepEqual(loaded.mcpServers, saved.mcpServers);
  assert.equal(loaded.mcpServers[0].credentialsRef, undefined);
});

test('legacy MCP maps migrate on load and migration is idempotent', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ model: 'preserved-model', mcpServers: servers() }));
  const first = loadSettings(f.root, f.options);
  assert.equal(first.model, 'preserved-model');
  assert.deepEqual(first.mcpServers[0].headers, servers()[0].headers);
  assertNoSecrets(fs.readFileSync(f.file, 'utf8'));
  const snapshot = fs.readFileSync(f.file, 'utf8');
  const refs = f.manager.listSecrets();
  assert.deepEqual(loadSettings(f.root, f.options), first);
  assert.equal(fs.readFileSync(f.file, 'utf8'), snapshot);
  assert.deepEqual(f.manager.listSecrets(), refs);
});

test('failed migration leaves legacy disk untouched and does not return plaintext fallback', (t) => {
  const f = fixture(t);
  const legacy = JSON.stringify({ mcpServers: servers() });
  fs.writeFileSync(f.file, legacy);
  f.manager.setSecret = () => { throw new Error('mock vault write failure'); };
  assert.throws(() => loadSettings(f.root, f.options), { code: 'MCP_CREDENTIAL_STORE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), legacy);
});

test('failed credential updates leave the previously committed settings usable', (t) => {
  const f = fixture(t);
  saveSettings(f.root, { mcpServers: servers() }, f.options);
  const old = fs.readFileSync(f.file, 'utf8');
  const write = f.manager.setSecret.bind(f.manager);
  f.manager.setSecret = () => { throw new Error('mock vault write failure'); };
  const changed = servers(); changed[0].headers.Authorization = 'Bearer replacement-mock-e3';
  assert.throws(() => saveSettings(f.root, { mcpServers: changed }, f.options), { code: 'MCP_CREDENTIAL_STORE_UNAVAILABLE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  f.manager.setSecret = write;
  assert.equal(loadSettings(f.root, f.options).mcpServers[0].headers.Authorization, servers()[0].headers.Authorization);
});

test('failed settings commit does not replace credentials referenced by the old file', (t) => {
  const f = fixture(t);
  saveSettings(f.root, { mcpServers: servers() }, f.options);
  const old = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === f.file) throw new Error('mock settings commit failure');
    return rename(source, destination);
  };
  try {
    const changed = servers(); changed[0].headers.Authorization = 'Bearer replacement-mock-e3';
    assert.throws(() => saveSettings(f.root, { mcpServers: changed }, f.options), /mock settings commit failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  assert.equal(loadSettings(f.root, f.options).mcpServers[0].headers.Authorization, servers()[0].headers.Authorization);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
});

test('updates and renames retire old refs, preserve unrelated records, and removal deletes credentials', (t) => {
  const f = fixture(t);
  f.manager.setSecret('unrelated', 'mock-unrelated');
  saveSettings(f.root, { mcpServers: servers() }, f.options);
  const initial = f.disk().mcpServers;
  saveSettings(f.root, { model: 'new-model' }, f.options);
  assert.deepEqual(f.disk().mcpServers, initial);
  const changed = servers(); changed[0].headers.Cookie = 'mock-new-cookie'; changed[1].name = 'renamed';
  saveSettings(f.root, { mcpServers: changed }, f.options);
  for (const server of initial) assert.equal(f.manager.hasSecret(server.credentialsRef), false);
  assert.deepEqual(loadSettings(f.root, f.options).mcpServers[1].env, changed[1].env);
  saveSettings(f.root, { mcpServers: [] }, f.options);
  assert.deepEqual(f.manager.listSecrets().map((item) => item.key), ['unrelated']);
});

test('incoming refs cannot select vault records and missing persisted refs fail closed', (t) => {
  const f = fixture(t);
  f.manager.setSecret('main_api_key', 'mock-private-api');
  saveSettings(f.root, { mcpServers: [{ name: 'local', command: 'node', credentialsRef: 'main_api_key' }] }, f.options);
  assert.equal(f.disk().mcpServers[0].credentialsRef, undefined);
  assert.equal(loadSettings(f.root, f.options).mcpServers[0].env, undefined);
  const disk = f.disk(); disk.mcpServers[0].credentialsRef = 'mcp_credentials_' + 'a'.repeat(32);
  fs.writeFileSync(f.file, JSON.stringify(disk));
  assert.throws(() => loadSettings(f.root, f.options), { code: 'MCP_CREDENTIAL_STORE_UNAVAILABLE' });
});

test('normalization happens before disk projection including forbidden OAuth token fields', (t) => {
  const f = fixture(t);
  saveSettings(f.root, { mcpServers: [{ name: 'remote', transport: 'http', url: 'https://example.com/mcp', auth: 'oauth', headers: { Authorization: 'Bearer forbidden-static-token', 'X-Api-Key': 'mock-custom-auth' }, oauth: { clientId: 'public', accessToken: 'forbidden-oauth-token' } }] }, f.options);
  const disk = fs.readFileSync(f.file, 'utf8');
  assert.equal(disk.includes('forbidden'), false);
  assert.equal(disk.includes('mock-custom-auth'), false);
  const loaded = loadSettings(f.root, f.options).mcpServers[0];
  assert.deepEqual(loaded.headers, { 'X-Api-Key': 'mock-custom-auth' });
  assert.deepEqual(loaded.oauth, { clientId: 'public' });
});

test('opaque MCP credential values are registered for JSON and Markdown export redaction', (t) => {
  const f = fixture(t);
  saveSettings(f.root, { mcpServers: servers() }, f.options);
  const session = { messages: [{ role: 'assistant', content: secrets.join(' ') }] };
  assertNoSecrets(exportSessionJson(session));
  assertNoSecrets(exportSessionMarkdown(session));
});

test('actual settings IPC keeps credentials private and preserves omitted maps on UI roundtrip', async (t) => {
  const f = fixture(t);
  const handlers = new Map();
  const BrowserWindow = function() {};
  BrowserWindow.getAllWindows = () => [];
  BrowserWindow.getFocusedWindow = () => null;
  const electron = {
    app: { getPath: () => f.root, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
    BrowserWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} }, dialog: {}, shell: { openExternal: async () => {} },
  };
  const original = Module._load;
  Module._load = function(request, parent, isMain) { return request === 'electron' ? electron : original.call(this, request, parent, isMain); };
  try { require('../src/main'); } finally { Module._load = original; }
  const event = { sender: { id: 71, isDestroyed: () => false, send: () => {} } };
  const saved = await handlers.get('settings:save')(event, { mcpServers: servers() });
  assertNoSecrets(JSON.stringify(saved));
  const publicSettings = await handlers.get('settings:get')(event);
  assertNoSecrets(JSON.stringify(publicSettings));
  assert.equal(publicSettings.mcpServers[0].credentialsRef, undefined);
  await handlers.get('settings:save')(event, { mcpServers: publicSettings.mcpServers });
  const loaded = loadSettings(f.root);
  assert.deepEqual(loaded.mcpServers[0].headers, servers()[0].headers);
  assert.deepEqual(loaded.mcpServers[1].env, servers()[1].env);
  assertNoSecrets(fs.readFileSync(f.file, 'utf8'));
});
