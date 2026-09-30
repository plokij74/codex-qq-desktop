'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../src/ai/pr-audit-state');
const S = require('../src/ai/pr-audit-repair-state');
const { createPrAuditRepairStore } = require('../src/ai/pr-audit-repair-store');
const { createRepairStore } = require('../src/ai/repair-store');
const { normalizeSource } = require('../src/ai/repair-state');
const { createMarker, normalizeMarker } = require('../src/ai/worktree-state');
const { fixture, DATE } = require('./helpers/pr-audit-repair-fixture');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString('utf8') };

describe('D18 source retention and v4 compatibility', () => {
  it('roundtrips encrypted immutable metadata and rejects arbitrary fields', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const raw = f.manager.store.get(saved.auditRepairRef, f.row.projectKey);
    const file = path.join(f.root, 'audit-repairs.json'); const store = createPrAuditRepairStore({ storePath: file, safeStorage });
    store.put(raw); const bytes = fs.readFileSync(file, 'utf8'); assert.doesNotMatch(bytes, /ORIGINAL_FINDING|auditRepairRef|headSha/);
    const restored = createPrAuditRepairStore({ storePath: file, safeStorage }); assert.deepEqual(restored.get(raw.auditRepairRef, raw.projectKey), raw);
    assert.equal(restored.get(raw.auditRepairRef, 'f'.repeat(32)), null);
    assert.throws(() => store.put({ ...raw, headSha: 'e'.repeat(40) }));
    assert.throws(() => store.put({ ...raw, body: 'injected body' }));
    assert.throws(() => normalizeSource({ kind: 'pr_audit', auditRepairRef: raw.auditRepairRef, findingIds: raw.findingIds }));
  });
  it('retains protected sources and rejects capacity without evicting protected rows', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const raw = f.manager.store.get(saved.auditRepairRef, f.row.projectKey);
    let now = Date.parse(DATE); const protectedRefs = new Set();
    const store = createPrAuditRepairStore({ now: () => now, isProtected: (ref) => protectedRefs.has(ref) });
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...raw, auditRepairRef: A.ref('par'), auditRef: A.ref(), repairRevision: A.hash(i), createdAt: new Date(now + i).toISOString() }));
    rows.forEach((row) => store.put(row)); protectedRefs.add(rows[0].auditRepairRef); now += 16 * 60000;
    store.put({ ...raw, auditRepairRef: A.ref('par'), auditRef: A.ref(), createdAt: new Date(now).toISOString() });
    assert.ok(store.get(rows[0].auditRepairRef, raw.projectKey)); assert.equal(store.get(rows[1].auditRepairRef, raw.projectKey), null);
    for (const row of store.list()) protectedRefs.add(row.auditRepairRef);
    assert.throws(() => store.put({ ...raw, auditRepairRef: A.ref('par'), auditRef: A.ref() }), { code: 'PR_AUDIT_REPAIR_LIMIT' });
    assert.equal(store.list().length, 50);
  });
  it('pins referenced D17 reports through pruning and allows unused source leases to expire', async (t) => {
    let now = Date.parse(DATE); const retained = new Set();
    const f = fixture(t, { managerOptions: { now: () => now, isProtected: (ref) => retained.has(ref) } });
    const saved = await f.snapshot(); assert.equal(f.manager.protectsReport(f.row.auditRef), true);
    retained.add(saved.auditRepairRef); now += 16 * 60000;
    for (let i = 0; i < 52; i++) f.audits.store.put({ ...f.row, auditRef: A.ref(), createdAt: new Date(now + i).toISOString() });
    assert.ok(f.audits.store.get(f.row.auditRef, f.row.projectKey));
    retained.clear(); assert.equal(f.manager.protectsReport(f.row.auditRef), false);
    f.audits.store.put({ ...f.row, auditRef: A.ref(), createdAt: new Date(now + 100).toISOString() });
    assert.equal(f.audits.store.get(f.row.auditRef, f.row.projectKey), null);
    await assert.rejects(f.manager.resolveMetadata(f.root, saved.auditRepairRef), { code: 'PR_AUDIT_NOT_FOUND' });
  });
  it('preserves corrupt storage and never falls back to plaintext after write failure', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const raw = f.manager.store.get(saved.auditRepairRef, f.row.projectKey);
    const file = path.join(f.root, 'corrupt.json'); fs.writeFileSync(file, 'broken ciphertext');
    const broken = createPrAuditRepairStore({ storePath: file, safeStorage }); assert.equal(broken.corrupt, true);
    assert.throws(() => broken.put(raw), { code: 'PR_AUDIT_REPAIR_STORE_CORRUPT' }); broken.close();
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken ciphertext');
    const failed = createPrAuditRepairStore({ storePath: path.join(f.root, 'failed.json'), safeStorage,
      fs: { ...fs, writeFileSync: () => { throw new Error('disk full'); } } });
    failed.put(raw); assert.equal(failed.persistenceStatus().persistence, 'memory'); assert.ok(failed.get(raw.auditRepairRef, raw.projectKey));
    assert.equal(fs.existsSync(path.join(f.root, 'failed.json')), false);
  });
  it('accepts v4 markers but rejects new sources in older markers and repair envelopes', async (t) => {
    const f = fixture(t); const saved = await f.snapshot();
    const marker = createMarker({ id: 'wt_auditrepair1', projectRoot: f.root, repoRoot: f.root, projectIdentity: 'test-project',
      baseHead: f.state.pr.headSha, originKind: 'pr_audit', auditRepairRef: saved.auditRepairRef, baseKind: 'remote_commit', deliveryKind: 'github_pr_update' });
    assert.equal(marker.version, 4);
    for (const version of [1, 2, 3]) assert.equal(normalizeMarker({ ...marker, version }), null);
    assert.equal(normalizeMarker({ ...marker, reviewRef: 'prv_' + '1'.repeat(24) }), null);
    const legacy = { ...marker, originKind: 'default', baseKind: 'local_head', deliveryKind: 'default' }; delete legacy.auditRepairRef;
    for (const version of [1, 2, 3]) assert.equal(normalizeMarker({ ...legacy, version }).version, 4);
    const file = path.join(f.root, 'repairs.json');
    const row = { repairRef: 'rpr_' + '1'.repeat(24), projectKey: f.row.projectKey, source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef },
      sourceFingerprint: S.sourceFingerprint(f.manager.store.get(saved.auditRepairRef, f.row.projectKey)), status: 'ready', createdAt: DATE };
    fs.writeFileSync(file, JSON.stringify({ version: 3, cipher: 'electron-safeStorage', payload: safeStorage.encryptString(JSON.stringify([row])).toString('base64') }));
    assert.equal(createRepairStore({ repairPath: file, safeStorage }).corrupt, true);
    fs.writeFileSync(file, JSON.stringify({ version: 4, cipher: 'electron-safeStorage', payload: safeStorage.encryptString(JSON.stringify([row])).toString('base64') }));
    const restored = createRepairStore({ repairPath: file, safeStorage }); assert.equal(restored.corrupt, false); assert.equal(restored.list()[0].source.kind, 'pr_audit');
  });
});
