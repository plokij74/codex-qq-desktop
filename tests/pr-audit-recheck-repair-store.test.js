'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const A = require('../src/ai/pr-audit-state'); const R = require('../src/ai/pr-audit-recheck-state');
const S = require('../src/ai/pr-audit-recheck-repair-state');
const { PrAuditRecheckRepairStore } = require('../src/ai/pr-audit-recheck-repair-store');
const { PrAuditRecheckStore } = require('../src/ai/pr-audit-recheck-store');
const { PrAuditStore } = require('../src/ai/pr-audit-store');
const { PrAuditRepairStore } = require('../src/ai/pr-audit-repair-store');
const { createRepairStore } = require('../src/ai/repair-store');
const { createMarker, normalizeMarker, publicSummary } = require('../src/ai/worktree-state');
const { normalizeSource } = require('../src/ai/repair-state');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { followupFixture } = require('./helpers/pr-audit-recheck-repair-fixture');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };
const envelope = (version, rows) => JSON.stringify({ version, cipher: 'electron-safeStorage', payload: safeStorage.encryptString(JSON.stringify(rows)).toString('base64') });

it('D20 encrypts immutable source metadata, deduplicates captures and rejects injected content', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot();
  const row = f.followups.sourceRow(f.root, saved.recheckRepairRef);
  const store = new PrAuditRecheckRepairStore({ userDataPath: f.root, safeStorage }); store.put(row);
  assert.equal(path.basename(store.file), 'engineering-pr-audit-recheck-repairs.json');
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /recheckRepairRef|findingIds|PRIVATE|FIXED_CODE/);
  const restored = new PrAuditRecheckRepairStore({ userDataPath: f.root, safeStorage });
  assert.deepEqual(restored.get(row.recheckRepairRef, row.projectKey), row);
  assert.equal(restored.get(row.recheckRepairRef, 'f'.repeat(32)), null);
  assert.equal(restored.put({ ...row, recheckRepairRef: A.ref('pcr'), createdAt: new Date().toISOString() }).recheckRepairRef, row.recheckRepairRef);
  for (const fields of [{ headSha: 'f'.repeat(40) }, { findingIds: [] }, { body: 'PRIVATE' }, { note: 'PRIVATE' }, { evidence: [] }]) {
    assert.throws(() => restored.put({ ...row, ...fields }));
  }
  assert.throws(() => normalizeSource({ kind: 'pr_audit_recheck', recheckRepairRef: row.recheckRepairRef, repairRevision: row.repairRevision }));
  assert.deepEqual(S.publicSource(row).findingIds, row.findingIds);
});

it('D20 migrates D19 v1 history to v2 and rejects new fields hidden in v1', async (t) => {
  const f = await followupFixture(t); const file = path.join(f.root, 'migration.json');
  const old = structuredClone(f.parent); delete old.source.repairBaseHead;
  fs.writeFileSync(file, envelope(1, [old]));
  const store = new PrAuditRecheckStore({ storePath: file, safeStorage });
  const restored = store.get(old.recheckRef, old.projectKey);
  assert.equal(restored.source.repairBaseHead, old.source.originalHead); assert.equal(restored.freshness, 'unknown');
  assert.equal(R.repairRevision(restored), R.repairRevision(f.parent));
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 2);
  const saved = await f.snapshot(); const delivered = f.deliver(saved.recheckRepairRef);
  const next = await f.done(await f.rechecks.start(f.root, delivered.id)); store.put(next);
  const again = new PrAuditRecheckStore({ storePath: file, safeStorage }).get(next.recheckRef, next.projectKey);
  assert.equal(again.source.repairBaseHead, f.parent.target.headSha);
  assert.equal(again.source.originalHead, f.parent.source.originalHead);
  for (const bad of [f.parent, next, { ...old, evidence: [{ stage: 'repair_base' }] }]) {
    const bytes = envelope(1, [bad]); fs.writeFileSync(file, bytes);
    const corrupt = new PrAuditRecheckStore({ storePath: file, safeStorage });
    assert.equal(corrupt.corrupt, true); corrupt.close(); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

it('D20 requires v5 repair and marker origins and restores records without instructions', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot(); const source = { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef };
  const marker = createMarker({ id: 'wt_d20storage', projectRoot: f.root, repoRoot: f.root, projectIdentity: 'test-project',
    baseHead: f.parent.target.headSha, originKind: source.kind, recheckRepairRef: saved.recheckRepairRef,
    baseKind: 'remote_commit', deliveryKind: 'github_pr_update' });
  assert.equal(marker.version, 5); assert.equal(publicSummary(marker).recheckRepairRef, saved.recheckRepairRef);
  for (const version of [1, 2, 3, 4]) assert.equal(normalizeMarker({ ...marker, version }), null);
  for (const patch of [{ originKind: 'pr_audit' }, { originKind: 'default' }, { recheckRepairRef: '' },
    { auditRepairRef: f.item.auditRepairRef }, { deliveryKind: 'default' }, { baseKind: 'local_head' }]) assert.equal(normalizeMarker({ ...marker, ...patch }), null);
  const row = { repairRef: A.ref('rpr'), projectKey: f.parent.projectKey, source,
    sourceFingerprint: S.sourceFingerprint(f.followups.sourceRow(f.root, saved.recheckRepairRef)), status: 'ready', createdAt: f.parent.createdAt };
  const file = path.join(f.root, 'repairs.json');
  for (const version of [1, 2, 3, 4]) {
    fs.writeFileSync(file, envelope(version, [row])); assert.equal(createRepairStore({ repairPath: file, safeStorage }).corrupt, true);
  }
  fs.writeFileSync(file, envelope(5, [row]));
  assert.deepEqual(createRepairStore({ repairPath: file, safeStorage }).list()[0].source, source);
});

it('D20 protects two restored generations and the root through real capacity pruning', async (t) => {
  const f = await followupFixture(t); const first = await f.snapshot();
  const middle = await f.done(await f.rechecks.start(f.root, f.deliver(first.recheckRepairRef).id));
  const second = await f.snapshot(middle.source.findingIds, middle);
  const sources = new PrAuditRecheckRepairStore({ userDataPath: f.root, safeStorage });
  for (const row of f.followups.store.list()) sources.put(row);
  const rechecks = new PrAuditRecheckStore({ userDataPath: f.root, safeStorage });
  for (const row of f.rechecks.store.list()) rechecks.put(row);
  createRepairStore({ userDataPath: f.root, safeStorage }).put({ repairRef: A.ref('rpr'), projectKey: f.parent.projectKey,
    source: { kind: 'pr_audit_recheck', recheckRepairRef: second.recheckRepairRef }, sourceFingerprint: 'e'.repeat(64),
    status: 'ready', resultId: 'wt_d20retained', createdAt: middle.createdAt });
  const h = createEngineeringIpcHandlers({ userDataPath: f.root, safeStorage, githubCli: f.github,
    worktreeManager: { list: async () => ({ ok: true, results: [] }) } }); t.after(() => h.close());
  const owner = { sender: { id: 1 } }; const projectBindingId = 'pb_' + 'a'.repeat(32);
  h.bind(owner, { projectBindingId, projectPath: f.root }); await h.prAuditStart(owner, { projectBindingId, prNumber: 7 });
  const next = h.prAuditRecheckRepairManager; const prior = h.prAuditRecheckManager; const root = h.prAuditRepairManager;
  assert.equal(next.store.list().length, 2); assert.equal(prior.store.list().length, 2); assert.equal(h.repairManager.store.list().length, 1);
  root.audits.store.put(f.row); root.store.put(f.item);
  const sample = next.sourceRow(f.root, second.recheckRepairRef); const start = Date.parse(middle.createdAt);
  for (const store of [next.store, prior.store, root.store, root.audits.store]) {
    const diagnosticFs = { ...fs };
    for (const op of ['mkdirSync', 'writeFileSync', 'readFileSync', 'renameSync', 'unlinkSync']) diagnosticFs[op] = (...args) => {
      try { return fs[op](...args); }
      catch (error) { t.diagnostic(op + ': ' + error.code + ' ' + error.message); throw error; }
    };
    store.fs = diagnosticFs;
  }
  assert.equal(next.store.isProtected(A.ref('pcr'), sample), false, JSON.stringify({ followups: next.store.persistenceStatus(), rechecks: prior.store.persistenceStatus(), repairs: h.repairManager.store.persistenceStatus() }));
  for (let i = 1; i <= 55; i++) {
    const createdAt = new Date(start + i * 1000).toISOString(); const auditRef = A.ref();
    assert.equal(next.store.isProtected(A.ref('pcr'), sample), false, JSON.stringify({ i, followups: next.store.persistenceStatus(), rechecks: prior.store.persistenceStatus(), repairs: h.repairManager.store.persistenceStatus() }));
    next.store.leases.clear(); next.store.put({ ...sample, recheckRepairRef: A.ref('pcr'), recheckRef: R.ref(), repairRevision: A.hash(i), createdAt });
    prior.store.put({ ...middle, recheckRef: R.ref(), createdAt });
    root.audits.store.put({ ...f.row, auditRef, createdAt });
    root.store.leases.clear(); root.store.put({ ...f.item, auditRef, auditRepairRef: A.ref('par'), createdAt });
  }
  for (const store of [next.store, prior.store, root.store, root.audits.store]) assert.equal(store.list().length, 50);
  assert.ok(next.store.get(first.recheckRepairRef, sample.projectKey)); assert.ok(next.store.get(second.recheckRepairRef, sample.projectKey));
  assert.ok(prior.store.get(f.parent.recheckRef, sample.projectKey)); assert.ok(prior.store.get(middle.recheckRef, sample.projectKey));
  assert.ok(root.store.get(f.item.auditRepairRef, sample.projectKey)); assert.ok(root.audits.store.get(f.row.auditRef, sample.projectKey));
  assert.deepEqual(next.historical(f.root, second.recheckRepairRef).findings.map((f) => f.findingId), sample.findingIds);
  // An unreadable persisted D13 history might reference any of the source rows.
  h.repairManager.store.corrupt = true;
  assert.equal(next.store.isProtected(A.ref('pcr'), sample), true);
  next.store.leases.clear(); assert.throws(() => next.store.put({ ...sample, recheckRepairRef: A.ref('pcr'), recheckRef: R.ref() }), /LIMIT/);
  next.store.corrupt = true;
  assert.equal(next.protectsRecheck(R.ref()), true); assert.equal(next.protectsSource(A.ref('par')), true); assert.equal(next.protectsReport(A.ref()), true);
});

it('D20 enforces global retention and refuses all-protected capacity atomically', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot(); const sample = f.followups.sourceRow(f.root, saved.recheckRepairRef);
  let locked = false; const store = new PrAuditRecheckRepairStore({ isProtected: () => locked });
  for (let i = 0; i < 200; i++) {
    store.leases.clear(); store.put({ ...sample, recheckRepairRef: A.ref('pcr'), recheckRef: R.ref(),
      projectKey: Math.floor(i / 50).toString(16).repeat(32), createdAt: new Date(Date.parse(sample.createdAt) + i).toISOString() });
  }
  locked = true; store.leases.clear(); const before = store.list();
  const row = { ...sample, projectKey: 'e'.repeat(32), recheckRepairRef: A.ref('pcr'), recheckRef: R.ref(), createdAt: new Date().toISOString() };
  assert.throws(() => store.put(row), /LIMIT/); assert.deepEqual(store.list(), before);
  locked = false; store.put(row); assert.equal(store.list().length, 200); assert.equal(store.get(before[0].recheckRepairRef, before[0].projectKey), null);
});

it('D20 preserves corrupt ciphertext and keeps failed writes in memory without plaintext fallback', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot(); const row = f.followups.sourceRow(f.root, saved.recheckRepairRef);
  const file = path.join(f.root, 'broken.json'); fs.writeFileSync(file, 'broken encrypted source');
  const corrupt = new PrAuditRecheckRepairStore({ storePath: file, safeStorage });
  assert.throws(() => corrupt.put(row), /CORRUPT/); corrupt.close(); assert.equal(fs.readFileSync(file, 'utf8'), 'broken encrypted source');
  assert.equal(corrupt.referencesUnknown(), true);
  const unavailable = new PrAuditRecheckRepairStore({ storePath: file, safeStorage: { isEncryptionAvailable: () => false } });
  unavailable.put(row); unavailable.close(); assert.equal(unavailable.referencesUnknown(), true); assert.equal(fs.readFileSync(file, 'utf8'), 'broken encrypted source');
  const failing = new PrAuditRecheckRepairStore({ storePath: path.join(f.root, 'failed.json'), safeStorage,
    fs: { ...fs, renameSync: () => { throw new Error('disk unavailable'); } } });
  failing.put(row); assert.equal(failing.persistenceStatus().persistence, 'memory');
  assert.deepEqual(failing.get(row.recheckRepairRef, row.projectKey), row); assert.equal(fs.existsSync(failing.file), false);
});

it('D20 reports memory-only history when the root repair source could not be persisted', async (t) => {
  const f = await followupFixture(t); const options = { userDataPath: f.root, safeStorage };
  const audit = f.audits.row(f.root, f.item.auditRef);
  f.audits.store = new PrAuditStore(options); f.audits.store.put(audit);
  f.manager.store = new PrAuditRepairStore({ ...options,
    fs: { ...fs, renameSync: () => { throw new Error('root source write failed'); } } });
  f.manager.store.put(f.item);
  f.rechecks.store = new PrAuditRecheckStore(options); f.rechecks.store.put(f.parent);
  f.followups.store = new PrAuditRecheckRepairStore(options);
  const captured = await f.snapshot();
  assert.equal(captured.ok, true);
  for (const store of [f.audits.store, f.rechecks.store, f.followups.store]) assert.equal(store.persistenceStatus().durable, true);
  assert.equal(new PrAuditRepairStore(options).get(f.item.auditRepairRef, f.item.projectKey), null);
  assert.equal(captured.persistence.durable, false);
  assert.equal(captured.persistence.persistence, 'memory');
  assert.equal(captured.persistence.error, 'PR_AUDIT_REPAIR_STORE_MEMORY');
});
