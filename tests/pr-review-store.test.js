'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrReviewStore } = require('../src/ai/pr-review-store');
const { createRepairStore } = require('../src/ai/repair-store');
const { normalizeSource, normalizeRepair } = require('../src/ai/repair-state');
const { normalizeMarker, publicSummary, MARKER_VERSION } = require('../src/ai/worktree-state');
const { fixture, HEAD, DATE } = require('./helpers/pr-review-fixture');

const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
function snapshot(index = 1, project = 'a'.repeat(32)) {
  return { reviewRef: `prv_${index.toString(16).padStart(24, '0')}`, projectKey: project, repoKey: 'b'.repeat(64),
    prNumber: 7, headSha: HEAD, headRefName: 'feature', threadId: `THREAD_${index}`, threadFingerprint: 'c'.repeat(64),
    path: 'src/app.js', line: 2, subjectType: 'LINE', createdAt: new Date(Date.parse(DATE) + index).toISOString() };
}
function dir(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d16-store-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
describe('D16 encrypted snapshots and v3 migration', () => {
  it('stores only immutable metadata, reuses equivalent snapshots and supports restart navigation', async (t) => {
    const root = dir(t); const options = { userDataPath: root, safeStorage };
    const store = createPrReviewStore(options); const f = fixture(t, { store });
    const saved = await f.snapshot(); assert.equal(saved.ok, true); store.close();
    const raw = fs.readFileSync(path.join(root, 'engineering-pr-reviews.json'), 'utf8');
    assert.doesNotMatch(raw, /Handle an empty|threadId|comments|body/);
    const loaded = createPrReviewStore(options); assert.equal(loaded.list().length, 1);
    const item = loaded.list()[0]; assert.equal(Object.isFrozen(item), true);
    assert.throws(() => loaded.put({ ...item, path: 'other.js' }));
    assert.throws(() => loaded.put({ ...item, body: 'do not persist' }));
    f.manager.store = loaded; f.manager.refs.clear();
    const source = await f.manager.source(f.root, saved.reviewRef);
    assert.equal(source.ok, true); assert.match(source.threadRef, /^prt_/);
    assert.equal((await f.manager.get(f.root, source.threadRef)).ok, true);
  });
  it('preserves corrupt encrypted data and uses memory only when encryption or writes fail', (t) => {
    const root = dir(t); const file = path.join(root, 'engineering-pr-reviews.json');
    fs.writeFileSync(file, '{bad-json');
    const store = createPrReviewStore({ userDataPath: root, safeStorage });
    assert.equal(store.persistenceStatus().corrupt, true); assert.throws(() => store.put(snapshot()), { code: 'PR_REVIEW_STORE_CORRUPT' });
    store.close(); assert.equal(fs.readFileSync(file, 'utf8'), '{bad-json');
    const memory = createPrReviewStore({ userDataPath: root, safeStorage: null }); memory.put(snapshot()); memory.close();
    assert.equal(memory.persistenceStatus().persistence, 'memory'); assert.equal(fs.readFileSync(file, 'utf8'), '{bad-json');
    const broken = createPrReviewStore({ storePath: path.join(root, 'other.json'), safeStorage,
      fs: { ...fs, writeFileSync: () => { throw new Error('disk full'); } } });
    broken.put(snapshot()); assert.equal(broken.list().length, 1); assert.equal(broken.persistenceStatus().persistence, 'memory');
    assert.equal(fs.existsSync(path.join(root, 'other.json')), false);
  });
  it('evicts only unprotected snapshots and refuses insertion atomically when capacity is protected', () => {
    const protectedRefs = new Set(); const store = createPrReviewStore({ isProtected: (ref) => protectedRefs.has(ref) });
    for (let i = 1; i <= 50; i++) { store.put(snapshot(i)); protectedRefs.add(snapshot(i).reviewRef); }
    assert.throws(() => store.put(snapshot(51)), { code: 'PR_REVIEW_LIMIT' });
    assert.equal(store.list().length, 50); assert.equal(store.list()[0].reviewRef, snapshot(1).reviewRef);
    protectedRefs.delete(snapshot(1).reviewRef); store.put(snapshot(51));
    assert.equal(store.list().length, 50); assert.equal(store.get(snapshot(1).reviewRef, snapshot().projectKey), null);
    for (let project = 2; project <= 5; project++) for (let i = 1; i <= 50; i++) store.put(snapshot(project * 1000 + i, project.toString(16).repeat(32)));
    assert.equal(store.list().length, 200);
    for (const ref of protectedRefs) assert.ok(store.list().some((item) => item.reviewRef === ref));
  });
  it('migrates encrypted v1/v2 repair stores and writes v3 with optional review validation', (t) => {
    const root = dir(t); const file = path.join(root, 'engineering-repairs.json');
    const old = { repairRef: 'rpr_' + 'a'.repeat(24), projectKey: 'b'.repeat(32), source: { kind: 'verification', jobRef: 'vfy_job_' + 'c'.repeat(24) },
      profileId: 'vfy_' + 'd'.repeat(8), profileFingerprint: 'e'.repeat(64), sourceWorkspaceFingerprint: 'f'.repeat(64), status: 'ready', createdAt: DATE };
    for (const version of [1, 2]) {
      fs.writeFileSync(file, JSON.stringify({ version, cipher: 'electron-safeStorage', payload: Buffer.from(JSON.stringify([old])).toString('base64') }));
      const store = createRepairStore({ userDataPath: root, safeStorage }); assert.equal(store.list().length, 1);
      const item = normalizeRepair({ ...old, repairRef: 'rpr_' + '1'.repeat(24), source: { kind: 'pr_review', reviewRef: snapshot().reviewRef },
        profileId: undefined, profileFingerprint: undefined, sourceWorkspaceFingerprint: undefined, sourceFingerprint: '2'.repeat(64) });
      store.put(item); store.close(); assert.equal(JSON.parse(fs.readFileSync(file)).version, 3);
      assert.equal(createRepairStore({ userDataPath: root, safeStorage }).list().length, 2);
      assert.equal(item.validationProfile, undefined);
    }
    assert.throws(() => normalizeSource({ kind: 'pr_review', reviewRef: snapshot().reviewRef, headSha: HEAD }));
  });
  it('migrates v1/v2 markers and refuses mismatched review origin/delivery/ref combinations', () => {
    const raw = { version: MARKER_VERSION, id: 'wt_review01', state: 'ready', repoRoot: 'D:/repo', projectRoot: 'D:/repo', projectRel: '.',
      projectIdentity: 'windows:d:/repo', worktreeGitDir: 'D:/repo/.git/worktrees/checkout', baseHead: HEAD,
      expectedTree: 'b'.repeat(40), patchSha256: 'c'.repeat(64), patchBytes: 20, createdAt: 1, updatedAt: 2,
      originKind: 'pr_review', baseKind: 'remote_commit', deliveryKind: 'github_pr_update', reviewRef: snapshot().reviewRef };
    const marker = normalizeMarker(raw); assert.ok(marker); assert.equal(marker.version, 3);
    const summary = publicSummary(marker); assert.equal(summary.canCreatePr, false); assert.equal(summary.canUpdatePr, true);
    for (const patch of [{ version: 2 }, { reviewRef: '' }, { remoteCiRef: 'rci_' + 'a'.repeat(24) }, { originKind: 'default' }, { baseKind: 'local_head' }, { deliveryKind: 'default' }]) assert.equal(normalizeMarker({ ...raw, ...patch }), null);
    for (const version of [1, 2]) assert.equal(normalizeMarker({ ...raw, version, originKind: 'default', baseKind: 'local_head', deliveryKind: 'default', reviewRef: undefined }).version, 3);
    assert.equal(normalizeMarker({ ...raw, version: 2, originKind: 'remote_ci', reviewRef: undefined, remoteCiRef: 'rci_' + 'a'.repeat(24) }).version, 3);
  });
});
