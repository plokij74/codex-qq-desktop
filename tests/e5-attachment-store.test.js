'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAttachmentBudget, LIMITS } = require('../src/ai/attachment-contract');
const { createAttachmentStore, createElectronSafeStorageAdapter } = require('../src/ai/attachment-store');
const { createStoreFixture, unitSafeStorage, deferred, envelope, unpack, capture, digest } = require('./helpers/e5-store-fixture');

async function setup(t, options = {}) {
  const fixture = await createStoreFixture(options);
  const budget = options.budget || createAttachmentBudget();
  const store = createAttachmentStore({ cacheRoot: fixture.cacheRoot, profileNamespace: 'profile-unit', safeStorage: fixture.safeStorage, reader: fixture.reader, budget, now: options.now });
  t.after(async () => { await store.close(); await fixture.cleanup(); });
  await store.initialize();
  const namespace = await store.createNamespace({ sessionId: 'session-unit' });
  return { ...fixture, store, budget, namespace };
}
async function imported(state, captures = [capture()]) {
  return state.store.importBatch({ namespace: state.namespace, sessionId: 'session-unit', captures });
}
const rejected = (code) => (e) => { assert.equal(e.code, code); assert.doesNotMatch(e.message, /CANARY|UNIT_KEY|[A-Za-z]:\\|blob_[a-f0-9]/); return true; };

for (const [label, safeStorage] of [
  ['absent', null], ['unavailable', unitSafeStorage({ available: false })],
  ['basic_text', unitSafeStorage({ backend: 'basic_text' })],
  ['throwing availability', unitSafeStorage({ hooks: { available() { throw new Error('CANARY key detail'); } } })],
  ['unbounded fake', { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }],
]) {
  test(`safeStorage ${label} is explicit memory and performs no managed IO`, async (t) => {
    const s = await setup(t, { safeStorage });
    const result = await imported(s, [capture('CANARY_memory\n')]);
    assert.equal(result.storageMode, 'memory');
    assert.equal(result.refs[0].storageMode, 'memory');
    assert.equal(s.store.cacheStatus().durable, false);
    assert.equal(s.events.length, 0);
    assert.deepEqual(await s.diskFiles(), []);
    const value = await s.store.read(result.refs[0].attachmentId, s.namespace);
    assert.equal(value.bytes.toString(), 'CANARY_memory\n');
    await value.release();
  });
}

test('native adapter cannot bless an ordinary fake as OS safeStorage', () => {
  const fake = unitSafeStorage();
  const adapter = createElectronSafeStorageAdapter(fake, { platform: 'win32', electronVersion: '33.2.1' });
  assert.equal(adapter.isEncryptionAvailable(), false);
});

test('unit bounded safeStorage uses immutable encrypted blobs and encrypted manifest only', async (t) => {
  const s = await setup(t);
  const canary = 'CANARY_DO_NOT_PERSIST_原文_🙂_secret';
  const result = await imported(s, [capture(canary)]);
  assert.equal(result.storageMode, 'encrypted');
  assert.match(result.refs[0].attachmentId, /^att_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(result.refs), /rawDigest|blobKey|Namespace|CANARY|profile-unit|session-unit/);
  const files = await s.diskFiles();
  assert.equal(files.length, 2);
  const forbidden = [canary, Buffer.from(canary).toString('base64'), s.root];
  for (const file of [...files, ...s.events.filter(e => e.op === 'temp').map(e => ({ bytes: e.encrypted }))]) {
    const text = file.bytes.toString();
    for (const needle of forbidden) assert.ok(!text.includes(needle));
    const outer = JSON.parse(text);
    assert.deepEqual(Object.keys(outer).sort(), ['cipher', 'formatVersion', 'payload']);
    assert.equal(outer.cipher, 'electron-safeStorage');
  }
  const value = await s.store.read(result.refs[0].attachmentId, s.namespace);
  assert.equal(value.bytes.toString(), canary);
  const row = s.store.getRecord(result.refs[0].attachmentId, s.namespace);
  assert.equal(row.rawDigest, digest(Buffer.from(canary)));
  assert.equal(row.rawByteLength, Buffer.byteLength(canary));
  row.rawDigest = 'tampered';
  assert.equal(s.store.getRecord(result.refs[0].attachmentId, s.namespace).rawDigest, digest(Buffer.from(canary)));
  await value.release();
  assert.equal(s.budget.snapshot().workBytes, 0);
  assert.equal(s.store.cacheStatus().encryptionEvidence, 'unit-fixture');
});

test('namespace/session and foreign reference mismatch fail before any package read', async (t) => {
  const s = await setup(t);
  const result = await imported(s);
  const other = await s.store.createNamespace({ sessionId: 'other-session' });
  const reads = s.events.filter(e => e.op === 'read').length;
  await assert.rejects(s.store.read(result.refs[0].attachmentId, other), rejected('ATTACHMENT_REFERENCE_INVALID'));
  assert.throws(() => s.store.getNamespace(s.namespace, 'other-session'), rejected('ATTACHMENT_REFERENCE_INVALID'));
  await assert.rejects(s.store.importBatch({ namespace: s.namespace, sessionId: 'other-session', captures: [capture()] }), rejected('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(s.events.filter(e => e.op === 'read').length, reads);
});

test('same profile dedupe shares bytes but not foreign logical authorization', async (t) => {
  const s = await setup(t);
  const a = await imported(s);
  const other = await s.store.createNamespace({ sessionId: 'other-session' });
  const b = await s.store.importBatch({ namespace: other, sessionId: 'other-session', captures: [capture()] });
  assert.notEqual(a.refs[0].attachmentId, b.refs[0].attachmentId);
  assert.equal((await s.diskFiles()).filter(f => f.path.includes(`${path.sep}blobs${path.sep}`)).length, 1);
  assert.equal(b.deduplicated, 0, 'no cross-namespace existence hint');
  await assert.rejects(s.store.read(a.refs[0].attachmentId, other), rejected('ATTACHMENT_REFERENCE_INVALID'));
});

test('future/corrupt manifest is preserved and new namespace is volatile', async (t) => {
  for (const original of [Buffer.from('{"formatVersion":99,"cipher":"electron-safeStorage","payload":"AA=="}'), Buffer.from('CANARY_CORRUPT_ORIGINAL')]) {
    const fixture = await createStoreFixture();
    await fixture.writePackage('manifest.enc.json', original);
    const budget = createAttachmentBudget();
    const store = createAttachmentStore({ cacheRoot: fixture.cacheRoot, profileNamespace: 'profile-unit', safeStorage: fixture.safeStorage, reader: fixture.reader, budget });
    try {
      await store.initialize();
      assert.equal(store.cacheStatus().storageMode, 'memory');
      const namespace = await store.createNamespace({ sessionId: 'session-unit' });
      const result = await store.importBatch({ namespace, sessionId: 'session-unit', captures: [capture('NEW_CANARY')] });
      assert.equal(result.storageMode, 'memory');
      assert.deepEqual(await fs.readFile(path.join(fixture.cacheRoot, 'manifest.enc.json')), original);
      assert.equal(fixture.events.filter(e => e.op === 'commit').length, 0);
    } finally { await store.close(); await fixture.cleanup(); }
  }
});

test('cancel while encrypt is deferred rolls back whole batch and retains the global work slot through cleanup', async (t) => {
  const waiting = deferred(), entered = deferred();
  const safeStorage = unitSafeStorage({ hooks: { async encrypt(text, proceed) { entered.resolve(); await waiting.promise; return proceed(text); } } });
  const s = await setup(t, { safeStorage });
  const controller = new AbortController();
  const operation = s.store.importBatch({ namespace: s.namespace, sessionId: 'session-unit', captures: [capture(), capture('second')] }, { signal: controller.signal });
  await entered.promise; controller.abort();
  assert.equal(s.budget.snapshot().activeWork, 1);
  assert.ok(s.budget.snapshot().workBytes > 0);
  await assert.rejects(s.store.read('att_' + '0'.repeat(32), s.namespace), rejected('ATTACHMENT_REFERENCE_INVALID'));
  waiting.resolve();
  await assert.rejects(operation, rejected('ABORTED'));
  assert.equal(s.store.list(s.namespace).length, 0);
  assert.deepEqual(await s.diskFiles(), []);
  assert.deepEqual(s.budget.snapshot(), { retainedBytes: s.budget.snapshot().retainedBytes, workBytes: 0, activeWork: 0 });
});

test('close during deferred crypto forbids late writes and releases memory after real cleanup', async (t) => {
  const waiting = deferred(), entered = deferred();
  const safeStorage = unitSafeStorage({ hooks: { async encrypt(text, proceed) { entered.resolve(); await waiting.promise; return proceed(text); } } });
  const s = await setup(t, { safeStorage });
  const operation = imported(s);
  await entered.promise;
  const closing = s.store.close();
  assert.equal(s.budget.snapshot().activeWork, 1);
  waiting.resolve();
  await assert.rejects(operation, rejected('ABORTED'));
  await closing;
  assert.deepEqual(await s.diskFiles(), []);
  assert.deepEqual(s.budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});

async function reopen(t, s, safeStorage = s.safeStorage) {
  await s.store.close();
  const budget = createAttachmentBudget();
  const store = createAttachmentStore({ cacheRoot: s.cacheRoot, profileNamespace: 'profile-unit', safeStorage, reader: s.reader, budget });
  t.after(() => store.close()); await store.initialize(); return { store, budget };
}
const memorySnapshot = s => ({ ...s.budget.snapshot() });

for (const phase of ['encrypt', 'decrypt', 'write', 'temp', 'verify', 'rename']) {
  test(`${phase} failure is explicit memory, ciphertext-only cleanup, no published partial durable refs`, async (t) => {
    const hooks = {}, cryptoHooks = {};
    if (phase === 'encrypt' || phase === 'decrypt') cryptoHooks[phase] = () => { throw new Error('CANARY cryptographic detail'); };
    else hooks[phase] = () => { throw new Error('CANARY temporary detail'); };
    const s = await setup(t, { hooks, safeStorage: unitSafeStorage({ hooks: cryptoHooks }) });
    const result = await imported(s, [capture('FAILURE_CANARY')]);
    assert.equal(result.storageMode, 'memory'); assert.equal(result.refs[0].storageMode, 'memory');
    assert.equal(s.store.list(s.namespace).length, 1);
    assert.deepEqual(await s.diskFiles(), []);
    for (const event of s.events.filter(e => e.op === 'temp')) assert.ok(!event.encrypted.toString().includes('FAILURE_CANARY'));
    const value = await s.store.read(result.refs[0].attachmentId, s.namespace);
    assert.equal(value.bytes.toString(), 'FAILURE_CANARY'); await value.release();
    assert.equal(s.budget.snapshot().workBytes, 0);
  });
}

test('raw 2MiB is admitted, +1 and 8MiB batch +1 reject before write, public budget is truthful', async (t) => {
  const s = await setup(t);
  const raw = Buffer.alloc(LIMITS.MAX_FILE_BYTES, 0x61), cap = { ...capture('x'), rawBytes: raw, rawDigest: digest(raw), extractedChars: raw.length };
  const result = await imported(s, [cap]);
  assert.equal(result.refs[0].size, raw.length);
  assert.equal(result.refs[0].budget.extractedChars, raw.length);
  assert.equal(result.refs[0].budget.selectedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS);
  assert.equal(result.refs[0].budget.truncated, true);
  const value = await s.store.read(result.refs[0].attachmentId, s.namespace);
  assert.ok(value.bytes.equals(raw)); await value.release();
  const commits = s.events.filter(e => e.op === 'commit').length;
  await assert.rejects(imported(s, [{ ...cap, rawBytes: Buffer.alloc(raw.length + 1) }]), rejected('ATTACHMENT_FILE_LIMIT'));
  await assert.rejects(imported(s, [cap, cap, cap, cap, capture('x')]), rejected('ATTACHMENT_SELECTION_LIMIT'));
  assert.equal(s.events.filter(e => e.op === 'commit').length, commits);
});

test('large backing buffer is not hidden by a tiny slice and all temporary work is released', async (t) => {
  const s = await setup(t, { safeStorage: null });
  const parent = Buffer.alloc(LIMITS.MAX_ATTACHMENT_WORK_BYTES + 1), view = parent.subarray(0, 1);
  const before = memorySnapshot(s);
  await assert.rejects(imported(s, [{ ...capture('x'), rawBytes: view }]), rejected('ATTACHMENT_CACHE_LIMIT'));
  assert.deepEqual(memorySnapshot(s), before); assert.equal(s.store.cacheStatus().recordCount, 0);
});

test('512 rows/tombstones and 16MiB retained hard cap cannot be bypassed by dedupe', async (t) => {
  const s = await setup(t, { safeStorage: null });
  for (let i = 0; i < LIMITS.MAX_CACHE_RECORDS / 8; i++) await imported(s, Array.from({ length: 8 }, () => capture('x')));
  assert.equal(s.store.cacheStatus().recordCount, 512);
  await assert.rejects(imported(s), rejected('ATTACHMENT_CACHE_LIMIT'));
  const extra = s.budget.reserveRetained(LIMITS.MAX_CACHE_MEMORY_BYTES - s.budget.snapshot().retainedBytes);
  assert.throws(() => s.store.hold([s.store.list(s.namespace)[0].attachmentId], s.namespace), rejected('ATTACHMENT_CACHE_LIMIT'));
  assert.equal(s.store.cacheStatus().activeLeases, 0); extra.release();
  await s.store.clear(s.namespace); assert.equal(s.store.cacheStatus().recordCount, 0);
  await imported(s); assert.equal(s.store.cacheStatus().recordCount, 1);
});

test('cold manifest retains draft/message revisions and logical links but no runtime leases', async (t) => {
  const s = await setup(t), result = await imported(s), id = result.refs[0].attachmentId;
  await s.store.syncMessageLinks(s.namespace, { revision: 7, ids: [id] });
  await s.store.syncDraftLinks(s.namespace, { revision: 9, ids: [] });
  const row = s.store.getRecord(id, s.namespace); assert.equal(row.messageLinked, true); assert.equal(row.draftLinked, false);
  const cold = await reopen(t, s);
  assert.deepEqual(cold.store.getLinkRevisions(s.namespace), { draftRevision: 9, messageRevision: 7 });
  assert.equal(cold.store.getRecord(id, s.namespace).messageLinked, true);
  assert.equal(cold.store.cacheStatus().activeLeases, 0);
  const value = await cold.store.read(id, s.namespace); assert.equal(value.bytes.toString(), 'hello\n'); await value.release();
});

test('shared blob survives one owner delete; clear and active lease defer physical deletion', async (t) => {
  const s = await setup(t), a = await imported(s), idA = a.refs[0].attachmentId;
  const other = s.store.createNamespace({ sessionId: 'other-session' });
  const b = await s.store.importBatch({ namespace: other, sessionId: 'other-session', captures: [capture()] });
  const idB = b.refs[0].attachmentId, lease = s.store.hold([idA], s.namespace, { kind: 'run' });
  await s.store.deleteCopy(idA, s.namespace);
  await assert.rejects(s.store.read(idA, s.namespace), rejected('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(s.store.cacheStatus().blobCount, 1);
  const value = await s.store.read(idB, other); assert.equal(value.bytes.toString(), 'hello\n'); await value.release();
  await s.store.clear(other); assert.equal(s.store.cacheStatus().blobCount, 1);
  await lease.release(); assert.equal(s.store.cacheStatus().blobCount, 0);
  assert.equal((await s.diskFiles()).filter(f => f.path.includes(`${path.sep}blobs${path.sep}`)).length, 0);
});

test('TTL does not evict draft/message linked or leased records and removes idle copies after real release', async (t) => {
  let now = 100000;
  const s = await setup(t, { now: () => now, safeStorage: null }), a = await imported(s), id = a.refs[0].attachmentId;
  await s.store.syncDraftLinks(s.namespace, { revision: 1, ids: [] });
  const lease = s.store.hold([id], s.namespace, { kind: 'preview' });
  now += LIMITS.CACHE_IDLE_TTL_MS + 1; await imported(s, [capture('new')]);
  assert.equal(s.store.getRecord(id, s.namespace).status, 'ready');
  await lease.release(); assert.throws(() => s.store.getRecord(id, s.namespace), rejected('ATTACHMENT_REFERENCE_INVALID'));
  const newId = s.store.list(s.namespace)[0].attachmentId;
  now += LIMITS.CACHE_IDLE_TTL_MS + 1; await imported(s, [capture('third')]);
  assert.equal(s.store.getRecord(newId, s.namespace).draftLinked, true);
});

test('delete failure is visible/retryable and clear never deletes an unverified corrupt package', async (t) => {
  const hooks = {}, s = await setup(t, { hooks }), result = await imported(s), id = result.refs[0].attachmentId;
  hooks.delete = () => { throw new Error('CANARY delete'); };
  await s.store.deleteCopy(id, s.namespace);
  assert.equal(s.store.cacheStatus().blobCount, 1); assert.ok(s.store.cacheStatus().retryableFailures > 0);
  hooks.delete = null; await s.store.clear(s.namespace); assert.equal(s.store.cacheStatus().blobCount, 0);
  const next = await imported(s, [capture('second')]), row = s.store.getRecord(next.refs[0].attachmentId, s.namespace);
  const blobPath = path.join(s.cacheRoot, 'blobs', `${row.blobKey.slice(5)}.enc.json`), bad = Buffer.from('CANARY_BAD_BLOB');
  await fs.writeFile(blobPath, bad);
  await s.store.clear(s.namespace); assert.deepEqual(await fs.readFile(blobPath), bad);
  assert.ok(s.store.cacheStatus().protectedPackageCount > 0);
});

test('cancel after a new blob commits rolls back only new blobs, never an old shared target', async (t) => {
  const hooks = {}, waiting = deferred(), entered = deferred(), cleanupWaiting = deferred(), cleanupEntered = deferred();
  const s = await setup(t, { hooks }), old = await imported(s);
  const before = await s.diskFiles(), originalBlob = before.find(f => f.path.includes(`${path.sep}blobs${path.sep}`));
  hooks.rename = async ({ locator }) => { if (locator === 'manifest.enc.json') { entered.resolve(); await waiting.promise; } };
  hooks.delete = async () => { cleanupEntered.resolve(); await cleanupWaiting.promise; };
  const controller = new AbortController(), operation = s.store.importBatch({ namespace: s.namespace, sessionId: 'session-unit', captures: [capture(), capture('fresh')] }, { signal: controller.signal });
  const caught = assert.rejects(operation, rejected('ABORTED'));
  await entered.promise; controller.abort(); waiting.resolve(); await cleanupEntered.promise;
  assert.equal(s.budget.snapshot().activeWork, 1);
  await assert.rejects(s.budget.withWork({}, async () => {}), rejected('ATTACHMENT_WORK_BUSY'));
  cleanupWaiting.resolve(); await caught;
  hooks.rename = hooks.delete = null;
  assert.deepEqual(await fs.readFile(originalBlob.path), originalBlob.bytes);
  assert.equal((await s.diskFiles()).filter(f => f.path.includes(`${path.sep}blobs${path.sep}`)).length, 1);
  assert.equal(s.store.list(s.namespace).length, 1);
  assert.equal(s.store.list(s.namespace)[0].attachmentId, old.refs[0].attachmentId);
  assert.equal(s.budget.snapshot().workBytes, 0);
});

test('remove changes generation during deferred read and cancelled decrypt holds its slot until completion', async (t) => {
  const hooks = {}, waiting = deferred(), entered = deferred(), s = await setup(t, { hooks }), result = await imported(s), id = result.refs[0].attachmentId;
  hooks.read = async () => { entered.resolve(); await waiting.promise; };
  const operation = s.store.read(id, s.namespace), caught = assert.rejects(operation, rejected('ATTACHMENT_PREVIEW_STALE'));
  await entered.promise; const oldGeneration = s.store.getRecord(id, s.namespace).refGeneration;
  const removed = await s.store.removeFromDraft(id, s.namespace, { revision: 1 }); assert.equal(removed.deferred, true);
  assert.equal(s.store.getRecord(id, s.namespace).refGeneration, oldGeneration + 1);
  waiting.resolve(); await caught; hooks.read = null;
  const decryptWaiting = deferred(), decryptEntered = deferred(), controller = new AbortController();
  const safeStorage = unitSafeStorage();
  const encrypted = await setup(t, { safeStorage }); const b = await imported(encrypted);
  const originalDecrypt = safeStorage.decryptString;
  safeStorage.decryptString = async bytes => { decryptEntered.resolve(); await decryptWaiting.promise; return originalDecrypt(bytes); };
  const read = encrypted.store.read(b.refs[0].attachmentId, encrypted.namespace, { signal: controller.signal }), abortCaught = assert.rejects(read, rejected('ABORTED'));
  await decryptEntered.promise; controller.abort(); assert.equal(encrypted.budget.snapshot().activeWork, 1);
  assert.ok(encrypted.budget.snapshot().workBytes > 0); decryptWaiting.resolve(); await abortCaught;
  assert.equal(encrypted.budget.snapshot().workBytes, 0);
});

test('close during deferred rename does not commit a late package or leak retained bytes', async (t) => {
  const waiting = deferred(), entered = deferred(), hooks = { async rename() { entered.resolve(); await waiting.promise; } };
  const s = await setup(t, { hooks }), operation = imported(s), caught = assert.rejects(operation, rejected('ABORTED'));
  await entered.promise; const closing = s.store.close(); assert.equal(s.budget.snapshot().activeWork, 1);
  waiting.resolve(); await caught; await closing;
  assert.equal(s.events.filter(e => e.op === 'commit').length, 0); assert.deepEqual(await s.diskFiles(), []);
  assert.deepEqual(s.budget.snapshot(), { retainedBytes: 0, workBytes: 0, activeWork: 0 });
});

test('lost key preserves all originals and accepts only independent volatile new copies', async (t) => {
  const s = await setup(t); await imported(s, [capture('KEY_CANARY')]); const before = await s.diskFiles();
  const cold = await reopen(t, s, unitSafeStorage()); assert.equal(cold.store.cacheStatus().storageMode, 'memory');
  assert.throws(() => cold.store.getNamespace(s.namespace, 'session-unit'), rejected('ATTACHMENT_REFERENCE_INVALID'));
  const namespace = cold.store.createNamespace({ sessionId: 'session-new' });
  const result = await cold.store.importBatch({ namespace, sessionId: 'session-new', captures: [capture('independent')] });
  assert.equal(result.storageMode, 'memory');
  for (const file of before) assert.deepEqual(await fs.readFile(file.path), file.bytes);
});

test('startup GC verifies profile/blob/hash/length of orphans and preserves corrupt/future/temp originals', async (t) => {
  const s = await setup(t); await imported(s); const manifest = (await s.diskFiles()).find(f => path.basename(f.path) === 'manifest.enc.json');
  const original = await unpack(s.safeStorage, manifest.bytes);
  const raw = Buffer.from('orphan');
  const validId = '1'.repeat(32), badId = '2'.repeat(32), futureId = '3'.repeat(32), wrongProfileId = '4'.repeat(32);
  const blob = id => ({ formatVersion: 1, profileNamespace: 'profile-unit', blobId: `blob_${id}`, rawDigest: digest(raw), rawByteLength: raw.length, decodeVersion: 1, extractVersion: 1, rawBytesBase64: raw.toString('base64') });
  await s.writePackage(`blobs/${validId}.enc.json`, await envelope(s.safeStorage, blob(validId)));
  const bad = Buffer.from('CANARY_ORPHAN_BAD'), future = await envelope(s.safeStorage, { ...blob(futureId), formatVersion: 9 });
  const wrongProfile = await envelope(s.safeStorage, { ...blob(wrongProfileId), profileNamespace: 'different-profile' }), temp = Buffer.from('CANARY_UNVERIFIED_STAGE');
  await s.writePackage(`blobs/${badId}.enc.json`, bad); await s.writePackage(`blobs/${futureId}.enc.json`, future);
  await s.writePackage(`blobs/${wrongProfileId}.enc.json`, wrongProfile); await s.writePackage(`blobs/.stage-${'5'.repeat(32)}.enc.json`, temp);
  const cold = await reopen(t, s); assert.equal(cold.store.cacheStatus().storageMode, 'encrypted');
  await assert.rejects(fs.access(path.join(s.cacheRoot, 'blobs', `${validId}.enc.json`)), e => e.code === 'ENOENT');
  for (const [locator, bytes] of [[`${badId}.enc.json`, bad], [`${futureId}.enc.json`, future], [`${wrongProfileId}.enc.json`, wrongProfile], [`.stage-${'5'.repeat(32)}.enc.json`, temp]]) assert.deepEqual(await fs.readFile(path.join(s.cacheRoot, 'blobs', locator)), bytes);
  assert.equal(cold.store.cacheStatus().protectedPackageCount, 4);
  assert.deepEqual(await unpack(s.safeStorage, await fs.readFile(manifest.path)), original);
});

for (const extra of [0, 1]) {
  test(`manifest plaintext 2MiB ${extra ? '+1 rejected and preserved' : 'boundary admitted'}`, async (t) => {
    const s = await setup(t); await imported(s); const file = (await s.diskFiles()).find(f => path.basename(f.path) === 'manifest.enc.json');
    const plain = JSON.stringify(await unpack(s.safeStorage, file.bytes));
    const packageBytes = await envelope(s.safeStorage, plain + ' '.repeat(LIMITS.MAX_MANIFEST_PLAIN_BYTES + extra - Buffer.byteLength(plain)));
    await s.writePackage('manifest.enc.json', packageBytes);
    const cold = await reopen(t, s); assert.equal(cold.store.cacheStatus().storageMode, extra ? 'memory' : 'encrypted');
    assert.deepEqual(await fs.readFile(file.path), packageBytes); assert.equal(cold.budget.snapshot().workBytes, 0);
  });
  test(`outer package 4MiB ${extra ? '+1 bounded read rejects' : 'boundary admitted'}`, async (t) => {
    const s = await setup(t); await imported(s); const file = (await s.diskFiles()).find(f => path.basename(f.path) === 'manifest.enc.json');
    const bytes = Buffer.alloc(LIMITS.MAX_MANIFEST_PACKAGE_BYTES + extra, 0x20); file.bytes.copy(bytes);
    await s.writePackage('manifest.enc.json', bytes);
    const cold = await reopen(t, s); assert.equal(cold.store.cacheStatus().storageMode, extra ? 'memory' : 'encrypted');
    assert.deepEqual(await fs.readFile(file.path), bytes);
    if (extra) assert.ok(s.events.some(e => e.op === 'oversize-read' && e.bytes === LIMITS.MAX_MANIFEST_PACKAGE_BYTES + 1));
  });
  test(`blob plaintext 3MiB ${extra ? '+1 denied after bounded fixture decrypt' : 'boundary admitted by declared unit bound'}`, async (t) => {
    const hooks = {}, safeStorage = unitSafeStorage({ hooks, bounds: { decryptMaxBytes: () => LIMITS.MAX_BLOB_PLAIN_BYTES + 1, decryptMaxCodeUnits: () => LIMITS.MAX_BLOB_PLAIN_BYTES + 1 } });
    const s = await setup(t, { safeStorage }), result = await imported(s), id = result.refs[0].attachmentId;
    hooks.decrypt = (cipher, normal) => { const plain = normal(cipher); return plain.includes('"rawBytesBase64"') ? plain + ' '.repeat(LIMITS.MAX_BLOB_PLAIN_BYTES + extra - Buffer.byteLength(plain)) : plain; };
    if (extra) await assert.rejects(s.store.read(id, s.namespace), rejected('ATTACHMENT_CORRUPT'));
    else { const value = await s.store.read(id, s.namespace); assert.equal(value.bytes.toString(), 'hello\n'); await value.release(); }
    assert.equal(s.budget.snapshot().workBytes, 0);
  });
}

for (const [label, mutated] of [
  ['profile', value => ({ ...value, profileNamespace: 'other-profile' })],
  ['blob id', value => ({ ...value, blobId: `blob_${'f'.repeat(32)}` })],
  ['hash', value => ({ ...value, rawDigest: '0'.repeat(64) })],
  ['raw length', value => ({ ...value, rawByteLength: value.rawByteLength + 1 })],
  ['noncanonical raw base64', value => ({ ...value, rawBytesBase64: 'AB==' })],
  ['raw base64 >2MiB', value => ({ ...value, rawBytesBase64: 'A'.repeat(Math.ceil((LIMITS.MAX_FILE_BYTES + 1) / 3) * 4) })],
]) {
  test(`blob ${label} mismatch is denied and original ciphertext remains unchanged`, async (t) => {
    const hooks = {}, safeStorage = unitSafeStorage({ hooks, bounds: { decryptMaxBytes: () => LIMITS.MAX_BLOB_PLAIN_BYTES, decryptMaxCodeUnits: () => LIMITS.MAX_BLOB_PLAIN_BYTES } });
    const s = await setup(t, { safeStorage }), result = await imported(s), id = result.refs[0].attachmentId;
    const before = await s.diskFiles(), originalBlob = before.find(f => f.path.includes(`${path.sep}blobs${path.sep}`));
    hooks.decrypt = (cipher, normal) => { const plain = normal(cipher); return plain.includes('"rawBytesBase64"') ? JSON.stringify(mutated(JSON.parse(plain))) : plain; };
    await assert.rejects(s.store.read(id, s.namespace), rejected('ATTACHMENT_CORRUPT'));
    assert.deepEqual(await fs.readFile(originalBlob.path), originalBlob.bytes);
    assert.equal(s.budget.snapshot().workBytes, 0);
  });
}

test('noncanonical cipher base64 and 3MiB/+1 predicted cipher are refused before decrypt allocation', async (t) => {
  const { canonicalBase64Length } = require('../src/ai/attachment-contract');
  assert.equal(canonicalBase64Length('A'.repeat(LIMITS.MAX_BLOB_CIPHER_BYTES / 3 * 4), LIMITS.MAX_BLOB_CIPHER_BYTES), LIMITS.MAX_BLOB_CIPHER_BYTES);
  assert.throws(() => canonicalBase64Length(Buffer.alloc(LIMITS.MAX_BLOB_CIPHER_BYTES + 1).toString('base64'), LIMITS.MAX_BLOB_CIPHER_BYTES), rejected('ATTACHMENT_CORRUPT'));
  for (const payload of ['AB==', Buffer.alloc(LIMITS.MAX_BLOB_CIPHER_BYTES + 1).toString('base64')]) {
    const s = await setup(t), original = Buffer.from(JSON.stringify({ formatVersion: 1, cipher: 'electron-safeStorage', payload }));
    await s.writePackage('manifest.enc.json', original); let decrypts = 0; const originalDecrypt = s.safeStorage.decryptString;
    s.safeStorage.decryptString = (...args) => { decrypts++; return originalDecrypt(...args); };
    const cold = await reopen(t, s); assert.equal(cold.store.cacheStatus().storageMode, 'memory'); assert.equal(decrypts, 0);
    assert.deepEqual(await fs.readFile(path.join(s.cacheRoot, 'manifest.enc.json')), original);
  }
});

test('JSON depth8/nodes65536 pre-scan denies +1 before full parse', () => {
  const { parseBoundedJson } = require('../src/ai/attachment-contract');
  const options = { maxBytes: LIMITS.MAX_BLOB_PLAIN_BYTES, maxDepth: 8, maxNodes: 65536 };
  assert.ok(parseBoundedJson('['.repeat(8) + '0' + ']'.repeat(8), options));
  assert.throws(() => parseBoundedJson('['.repeat(9) + '0' + ']'.repeat(9), options), rejected('ATTACHMENT_CORRUPT'));
  assert.equal(parseBoundedJson('[' + Array(65535).fill('0').join(',') + ']', options).length, 65535);
  const original = JSON.parse; let calls = 0; JSON.parse = (...args) => { calls++; return original(...args); };
  try { assert.throws(() => parseBoundedJson('[' + Array(65536).fill('0').join(',') + ']', options), rejected('ATTACHMENT_CORRUPT')); assert.equal(calls, 0); }
  finally { JSON.parse = original; }
});

for (const extra of [0, 1]) {
  test(`actual encrypted inventory 64MiB ${extra ? '+1 is preserved and durable denied' : 'boundary permits verified orphan GC'}`, async (t) => {
    const hooks = {}, fixture = await createStoreFixture({ hooks });
    const budget = createAttachmentBudget();
    const store = createAttachmentStore({ cacheRoot: fixture.cacheRoot, profileNamespace: 'profile-unit', safeStorage: fixture.safeStorage, reader: fixture.reader, budget });
    t.after(async () => { await store.close(); await fixture.cleanup(); });
    const manifest = envelope(fixture.safeStorage, { formatVersion: 1, profileNamespace: 'profile-unit', namespaces: [], blobs: [], records: [] });
    await fixture.writePackage('manifest.enc.json', manifest);
    let actualBytes = manifest.length, firstDeleteDiskBytes = null;
    hooks.delete = () => { if (firstDeleteDiskBytes === null) firstDeleteDiskBytes = store.cacheStatus().diskBytes; };
    for (let i = 0; i < 16; i++) {
      const id = (i + 1).toString(16).padStart(32, '0');
      const encoded = envelope(fixture.safeStorage, { formatVersion: 1, profileNamespace: 'profile-unit', blobId: `blob_${id}`, rawDigest: digest(Buffer.from('x')), rawByteLength: 1, decodeVersion: 1, extractVersion: 1, rawBytesBase64: 'eA==' });
      const size = LIMITS.MAX_BLOB_PACKAGE_BYTES - (i === 15 ? manifest.length - extra : 0);
      const padded = Buffer.alloc(size, 0x20); encoded.copy(padded);
      await fixture.writePackage(`blobs/${id}.enc.json`, padded); actualBytes += padded.length;
    }
    assert.equal(actualBytes, LIMITS.MAX_CACHE_DISK_BYTES + extra);
    await store.initialize();
    assert.equal(store.cacheStatus().storageMode, extra ? 'memory' : 'encrypted');
    if (extra) {
      assert.equal(firstDeleteDiskBytes, null); assert.equal(fixture.events.filter(event => event.op === 'delete' || event.op === 'commit').length, 0);
      let remainingBytes = 0;
      for (const file of await fixture.diskFiles()) remainingBytes += file.bytes.length;
      assert.equal(remainingBytes, actualBytes);
    } else {
      assert.equal(firstDeleteDiskBytes, LIMITS.MAX_CACHE_DISK_BYTES);
      assert.equal(fixture.events.filter(event => event.op === 'delete').length, 16);
      assert.equal(store.cacheStatus().diskBytes, manifest.length);
    }
    assert.deepEqual(await fs.readFile(path.join(fixture.cacheRoot, 'manifest.enc.json')), manifest);
    assert.equal(budget.snapshot().workBytes, 0);
  });
}

