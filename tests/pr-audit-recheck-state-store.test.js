'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const A = require('../src/ai/pr-audit-state'); const S = require('../src/ai/pr-audit-recheck-state');
const { PrAuditRecheckStore } = require('../src/ai/pr-audit-recheck-store');
const { recheckFixture } = require('./helpers/pr-audit-recheck-fixture');
it('D19 conclusion contract requires every original ID exactly once and verified current evidence', () => {
  const ids = [A.ref('paf'), A.ref('paf')]; const e = A.ref('pce'); const ledger = new Map([[e, { stage: 'target', kind: 'code' }]]);
  const raw = { summary: '复审', findings: ids.map((findingId) => ({ findingId, status: 'resolved', reason: '空输入触发条件被消除', evidence: [e] })) };
  assert.deepEqual(S.report(raw, ids, ledger).findings.map((f) => f.findingId), ids);
  for (const mutate of [(r) => r.findings.pop(), (r) => r.findings.push(r.findings[0]), (r) => { r.findings[0].findingId = ids[1]; },
    (r) => { r.findings[0].evidence = ['invented']; }, (r) => { r.findings[0].status = 'approved'; }]) {
    const copy = structuredClone(raw); mutate(copy); assert.throws(() => S.report(copy, ids, ledger), /REPORT_INVALID/);
  }
  ledger.get(e).stage = 'original_head'; assert.throws(() => S.report(raw, ids, ledger), /REPORT_INVALID/);
  raw.findings.forEach((f) => { f.status = 'unknown'; f.evidence = []; }); assert.equal(S.report(raw, ids, ledger).findings.length, 2);
  ledger.set(e, { stage: 'target', kind: 'absence', existedBefore: true }); raw.findings[0].status = 'resolved'; raw.findings[0].evidence = [e];
  assert.equal(S.report(raw, ids, ledger).findings[0].status, 'resolved'); raw.findings[0].status = 'still_present';
  assert.throws(() => S.report(raw, ids, ledger), /REPORT_INVALID/);
});

it('D19 encrypted history restores interrupted tasks and unknown freshness, prunes oldest finished rows', async (t) => {
  const f = await recheckFixture(t); const row = await f.done(await f.rechecks.start(f.root, f.marker.id));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json'); const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s).map((b) => b ^ 73), decryptString: (b) => Buffer.from(b).map((x) => x ^ 73).toString() };
  const store = new PrAuditRecheckStore({ storePath: file, safeStorage }); store.put(row);
  const active = { ...row, recheckRef: S.ref(), status: 'running' }; store.put(active);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /逐项|空输入|findingId/);
  const restored = new PrAuditRecheckStore({ storePath: file, safeStorage });
  assert.equal(restored.get(active.recheckRef, row.projectKey).status, 'interrupted');
  assert.equal(restored.get(row.recheckRef, row.projectKey).freshness, 'unknown');
  for (let i = 0; i < 55; i++) restored.put({ ...row, recheckRef: S.ref(), createdAt: new Date(Date.now() + i * 1000).toISOString() });
  assert.equal(restored.list().length, 50);
  const memory = new PrAuditRecheckStore();
  for (let i = 0; i < 50; i++) memory.put({ ...active, recheckRef: S.ref() });
  assert.throws(() => memory.put({ ...active, recheckRef: S.ref() }), /LIMIT/);
  assert.throws(() => restored.put({ ...row, prompt: 'private' }), /INVALID/);
  fs.writeFileSync(file, 'broken encrypted file'); const corrupt = new PrAuditRecheckStore({ storePath: file, safeStorage }); corrupt.put(row);
  assert.equal(corrupt.persistenceStatus().corrupt, true); assert.equal(fs.readFileSync(file, 'utf8'), 'broken encrypted file');
  assert.equal(corrupt.referencesUnknown(), true);
  const unavailable = new PrAuditRecheckStore({ storePath: path.join(dir, 'none'), safeStorage: { isEncryptionAvailable: () => false } }); unavailable.put(row);
  assert.equal(fs.existsSync(path.join(dir, 'none')), false);
  const failing = new PrAuditRecheckStore({ storePath: path.join(dir, 'fail'), safeStorage: { ...safeStorage, encryptString: () => { throw new Error(); } } }); failing.put(row);
  assert.equal(failing.persistenceStatus().persistence, 'memory');
});

it('D19 restored history protects its D18 source and D17 report through actual capacity pruning', async (t) => {
  const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
  const f = await recheckFixture(t); const row = await f.done(await f.rechecks.start(f.root, f.marker.id));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const saved = new PrAuditRecheckStore({ userDataPath: f.root, safeStorage }); saved.put(row); saved.close();
  const h = createEngineeringIpcHandlers({ userDataPath: f.root, safeStorage, githubCli: f.github,
    worktreeManager: { list: async () => ({ ok: true, results: [] }) } }); t.after(() => h.close());
  const owner = { sender: { id: 1 } }; const projectBindingId = 'pb_' + 'a'.repeat(32);
  h.bind(owner, { projectBindingId, projectPath: f.root });
  // Startup restore precedes the source scan; missing model config prevents a new audit.
  await h.prAuditStart(owner, { projectBindingId, prNumber: 7 });
  const rechecks = h.prAuditRecheckManager; const repairs = h.prAuditRepairManager; const audits = repairs.audits;
  assert.equal(rechecks.store.list().length, 1);
  audits.store.put(f.row); repairs.store.put(f.item);
  for (let i = 1; i <= 55; i++) {
    const auditRef = 'pra_' + i.toString(16).padStart(24, '0');
    const createdAt = new Date(Date.parse(row.createdAt) + i * 1000).toISOString();
    audits.store.put({ ...f.row, auditRef, createdAt });
    repairs.store.leases.clear();
    repairs.store.put({ ...f.item, auditRepairRef: 'par_' + i.toString(16).padStart(24, '0'), auditRef, createdAt });
  }
  assert.equal(audits.store.list().length, 50); assert.equal(repairs.store.list().length, 50);
  assert.ok(audits.store.get(f.row.auditRef, row.projectKey));
  assert.ok(repairs.store.get(f.item.auditRepairRef, row.projectKey));
  rechecks.store.corrupt = true; rechecks.store.mode = 'memory';
  assert.equal(rechecks.protectsSource('unreadable-source'), true);
  assert.equal(rechecks.protectsReport('unreadable-report'), true);
});
