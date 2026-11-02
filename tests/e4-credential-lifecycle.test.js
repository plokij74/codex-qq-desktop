'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIpcHarness } = require('./fixtures/e4-models/ipc-harness.cjs');
const NEW = 'synthetic-replacement-not-a-real-key';
const storedRef = (h) => h.settings().modelRegistry.providers[0].auth.secretRef;
const vaultRef = (ref) => ref === 'sec_main_api_key' ? 'main_api_key' : ref;

test('E4 credential empty input keeps the binding and explicit set atomically replaces it', async () => {
  const h = createIpcHarness(); const old = storedRef(h); const revision = h.revision();
  const empty = await h.handlers.setCredential(h.event(), { providerId: h.providerId(), credential: ' ', expectedRevision: revision });
  assert.equal(empty.ok, true); assert.equal(h.revision(), revision); assert.equal(storedRef(h), old);
  const changed = await h.handlers.setCredential(h.event(), { providerId: h.providerId(), credential: NEW, expectedRevision: revision });
  assert.equal(changed.ok, true); assert.equal(h.revision(), revision + 1); assert.notEqual(storedRef(h), old);
  assert.equal(h.values.get(vaultRef(storedRef(h))), NEW);
  assert.equal(h.values.has(vaultRef(old)), false);
  assert.equal(changed.cleanupState, 'clean');
  assert.ok(!JSON.stringify(changed).includes(NEW));
  assert.equal(changed.registry.providers[0].credentialState, 'configured');
});

test('E4 store or precommit failure preserves the old binding and registry revision', async () => {
  for (const flag of ['storeFailure', 'commitFailure', 'verifyFailure']) {
    const h = createIpcHarness(); const old = storedRef(h); const revision = h.revision(); h.flags[flag] = true;
    const result = await h.handlers.setCredential(h.event(), { providerId: h.providerId(), credential: NEW, expectedRevision: revision });
    assert.equal(result.ok, false, flag); assert.equal(storedRef(h), old, flag); assert.equal(h.revision(), revision, flag);
    assert.ok(h.values.has(vaultRef(old)), flag);
    assert.ok(!JSON.stringify(result).includes(NEW), flag);
  }
});

test('E4 retirement failure preserves the committed new credential and returns cleanup pending', async () => {
  const h = createIpcHarness(); const old = vaultRef(storedRef(h)); const revision = h.revision(); h.flags.deleteFailure = true;
  const result = await h.handlers.setCredential(h.event(), { providerId: h.providerId(), credential: NEW, expectedRevision: revision });
  assert.equal(result.ok, true); assert.equal(result.revision, revision + 1); assert.notEqual(vaultRef(storedRef(h)), old);
  assert.equal(result.cleanupState, 'pending'); assert.equal(result.pendingCleanupCount, 1);
  assert.equal(result.registry.providers[0].credentialState, 'configured'); assert.ok(h.values.has(old));
  h.flags.deleteFailure = false;
  const retried = await h.handlers.retryCredentialCleanup(h.event(), { expectedRevision: h.revision() });
  assert.equal(retried.ok, true); assert.equal(retried.cleanupState, 'clean'); assert.equal(h.values.has(old), false);
  assert.equal(h.values.get(vaultRef(storedRef(h))), NEW);
  assert.equal((await h.handlers.retryCredentialCleanup(h.event(), { expectedRevision: h.revision() })).cleanupState, 'clean');
});

test('E4 clear remains unbound after committed cleanup failure and retry never restores it', async () => {
  const h = createIpcHarness(); const revision = h.revision(); h.flags.deleteFailure = true;
  const result = await h.handlers.clearCredential(h.event(), { providerId: h.providerId(), expectedRevision: revision });
  assert.equal(result.ok, true); assert.equal(result.revision, revision + 1); assert.equal(storedRef(h), '');
  assert.equal(result.registry.providers[0].credentialState, 'unset'); assert.equal(result.cleanupState, 'pending');
  h.flags.deleteFailure = false;
  const retry = await h.handlers.retryCredentialCleanup(h.event(), { expectedRevision: h.revision() });
  assert.equal(retry.cleanupState, 'clean'); assert.equal(storedRef(h), ''); assert.equal(h.values.size, 0);
});

test('E4 active credential replacement and clear are rejected before touching the vault', async () => {
  const h = createIpcHarness(); h.flags.inUse = true; const before = [...h.values];
  for (const method of ['setCredential', 'clearCredential']) {
    const result = await h.handlers[method](h.event(), { providerId: h.providerId(), credential: NEW, expectedRevision: h.revision() });
    assert.equal(result.code, 'CONFIG_IN_USE'); assert.deepEqual([...h.values], before);
  }
});

test('E4 private resolver does not expose a credential to a changed origin', async () => {
  const h = createIpcHarness();
  const result = await h.handlers.saveProvider(h.event(), { expectedRevision: h.revision(), provider: {
    id: h.providerId(), name: 'Moved', protocol: 'openai-chat-completions', baseUrl: 'https://other-synthetic.invalid/v1', auth: { kind: 'bearer' },
  } });
  assert.equal(result.ok, true);
  const binding = h.handlers.resolveBinding(h.event(), { sessionId: 'synthetic', assistantId: 'assistant_general', expectedRegistryRevision: h.revision() });
  assert.throws(() => h.handlers.resolveCredential(binding), (err) => err.code === 'MODEL_CREDENTIAL_UNAVAILABLE');
});

// These failures occur after a valid provider edit, not after a key replacement.
test('E4 provider origin and auth-kind edits retire the invalidated credential', async () => {
  for (const edit of [{ baseUrl: 'https://e4-moved.invalid/v1' }, { auth: { kind: 'none' } }]) {
    const h = createIpcHarness(); const old = vaultRef(storedRef(h)); const revision = h.revision();
    const result = await h.handlers.saveProvider(h.event(), { expectedRevision: revision,
      provider: { id: h.providerId(), ...edit } });
    assert.equal(result.ok, true); assert.equal(result.revision, revision + 1);
    assert.equal(storedRef(h), ''); assert.equal(result.registry.providers[0].credentialState, 'unset');
    assert.equal(result.cleanupState, 'clean'); assert.equal(h.values.has(old), false);
    assert.deepEqual(h.deleted, [old]); assert.deepEqual(h.settings().modelCredentialCleanup, []);
  }
});

test('E4 provider credential invalidation atomically commits a cleanup journal and preserves pending state', async () => {
  const h = createIpcHarness(); const old = vaultRef(storedRef(h)); const revision = h.revision(); h.flags.deleteFailure = true;
  const result = await h.handlers.saveProvider(h.event(), { expectedRevision: revision,
    provider: { id: h.providerId(), baseUrl: 'https://e4-moved.invalid/v1' } });
  assert.equal(result.ok, true); assert.equal(result.revision, revision + 1); assert.equal(storedRef(h), '');
  assert.equal(result.cleanupState, 'pending'); assert.equal(result.pendingCleanupCount, 1);
  assert.deepEqual(h.settings().modelCredentialCleanup, [old]); assert.equal(h.values.has(old), true);
  h.flags.deleteFailure = false;
  const retried = await h.handlers.retryCredentialCleanup(h.event(), { expectedRevision: h.revision() });
  assert.equal(retried.ok, true); assert.equal(retried.cleanupState, 'clean'); assert.equal(storedRef(h), '');
  assert.equal(h.values.has(old), false); assert.equal(h.revision(), revision + 1);
});

test('E4 failed provider invalidation commit leaves the old binding and credential intact', async () => {
  const h = createIpcHarness(); const old = storedRef(h); const revision = h.revision(); h.flags.commitFailure = true;
  const result = await h.handlers.saveProvider(h.event(), { expectedRevision: revision,
    provider: { id: h.providerId(), auth: { kind: 'none' } } });
  assert.equal(result.ok, false); assert.equal(result.code, 'MODEL_CONFIG_SAVE_FAILED');
  assert.equal(h.revision(), revision); assert.equal(storedRef(h), old);
  assert.equal(h.values.has(vaultRef(old)), true); assert.deepEqual(h.deleted, []);
});

test('E4 provider rename and same-origin path edits keep the bound credential', async () => {
  const h = createIpcHarness(); const old = storedRef(h); const provider = h.settings().modelRegistry.providers[0];
  const origin = new URL(provider.baseUrl).origin;
  const result = await h.handlers.saveProvider(h.event(), { expectedRevision: h.revision(),
    provider: { id: h.providerId(), name: 'Renamed provider', baseUrl: `${origin}/other/api` } });
  assert.equal(result.ok, true); assert.equal(storedRef(h), old);
  assert.equal(result.registry.providers[0].credentialState, 'configured'); assert.deepEqual(h.deleted, []);
  assert.equal(h.values.has(vaultRef(old)), true);
});
