'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { recheckFixture } = require('./helpers/pr-audit-recheck-fixture');
const { deferred } = require('./helpers/pr-review-fixture');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');

it('D19 rechecks a stale original report without changing its findings or publication', async (t) => {
  const f = await recheckFixture(t); const original = f.current();
  const started = await f.rechecks.start(f.root, f.marker.id); assert.equal(started.ok, true, started.code);
  const row = await f.done(started); assert.equal(row.status, 'completed', row.errorCode);
  assert.equal(row.freshness, 'current'); assert.equal(row.report.findings.length, 2);
  assert.deepEqual(f.current(), original); assert.equal(f.snapshots[0].cleaned, true);
  assert.equal(f.audits.taskPool.tasks.size, 0);
  assert.doesNotMatch(JSON.stringify(row), /TARGET_PRIVATE_CODE|ORIGINAL_FINDING_BODY/);
  assert.doesNotMatch(JSON.stringify(f.recheckEvents), /原|TARGET|source|report|evidence/);
  assert.equal(f.rechecks.protectsSource(f.item.auditRepairRef), true);
  assert.equal(f.rechecks.protectsReport(f.item.auditRef), true);
  const detail = await f.rechecks.get(f.root, row.recheckRef); assert.equal(detail.originalFindings.length, 2);
  const context = await f.rechecks.context(f.root, row.recheckRef, row.evidence[0].evidenceId); assert.match(context.snippet.content, /TARGET/);
  assert.equal((await f.rechecks.context(f.root, row.recheckRef, 'pce_' + '0'.repeat(24))).ok, false);
});

it('D19 rejects uncertain delivery, mutated original findings, missing sources and changed branches', async (t) => {
  const f = await recheckFixture(t);
  f.marker.state = 'pr_update_uncertain'; assert.equal((await f.rechecks.start(f.root, f.marker.id)).code, 'PR_AUDIT_RECHECK_DELIVERY');
  f.marker.state = 'pr_update_cleanup_pending'; f.state.pr.headRefName = 'other';
  let out = await f.rechecks.start(f.root, f.marker.id); assert.equal((await f.done(out)).errorCode, 'PR_AUDIT_CHANGED');
  f.state.pr.headRefName = 'feature/review';
  const row = f.current(); row.report.findings[0].body = 'tampered'; f.audits.save(row);
  assert.equal((await f.rechecks.start(f.root, f.marker.id)).code, 'PR_AUDIT_RECHECK_SOURCE');
  f.manager.store.rows.clear(); assert.equal((await f.rechecks.start(f.root, f.marker.id)).ok, false);
  assert.equal(f.audits.taskPool.tasks.size, 0);
});

it('D19 retains old-head conclusions as stale and marks failed freshness reads unknown', async (t) => {
  const f = await recheckFixture(t); const runtime = f.rechecks.runtime;
  f.rechecks.runtime = async (args) => { const result = await runtime(args); f.state.pr.headSha = '9'.repeat(40); return result; };
  const row = await f.done(await f.rechecks.start(f.root, f.marker.id));
  assert.equal(row.status, 'completed'); assert.equal(row.freshness, 'stale'); assert.equal(row.target.headSha, 'e'.repeat(40));
  f.github.getAuditPr = async () => { throw new Error('offline'); };
  const detail = await f.rechecks.get(f.root, row.recheckRef); assert.equal(detail.recheck.freshness, 'unknown');
  const list = await f.rechecks.list(f.root, 7); assert.equal(list.rechecks[0].freshness, 'unknown');
  f.worktree.list = async () => { throw new Error('marker scan unavailable'); };
  const unavailable = await f.rechecks.list(f.root, 7);
  assert.equal(unavailable.ok, true); assert.equal(unavailable.deliveriesUnavailable, true);
  assert.equal(unavailable.rechecks.length, 1);
});

it('D17 and D19 share project/global slots and release them on cancellation', async (t) => {
  const entered = deferred();
  const f = await recheckFixture(t, { runtime: async ({ signal }) => { entered.resolve(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); throw new Error('cancel'); } });
  const out = await f.rechecks.start(f.root, f.marker.id); await entered.promise;
  assert.equal((await f.audits.start(f.root, 7)).code, 'PR_AUDIT_BUSY');
  assert.equal((await f.rechecks.start(f.root, f.marker.id)).code, 'PR_AUDIT_BUSY');
  f.audits.taskPool.acquire('other', 'other-project');
  assert.throws(() => f.audits.taskPool.acquire('third', 'third-project'), /BUSY/); f.audits.taskPool.release('other');
  f.rechecks.cancel(f.root, out.recheckRef); assert.equal((await f.done(out)).status, 'cancelled');
  assert.equal(f.audits.taskPool.tasks.size, 0);
});

it('D19 IPC rejects injection and cross-sender access, retains abort through unbind', async (t) => {
  const entered = deferred();
  const f = await recheckFixture(t, { runtime: async ({ signal }) => { entered.resolve(signal); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); throw new Error('cancel'); } });
  const h = createEngineeringIpcHandlers({ prAuditManager: f.audits, prAuditRepairManager: f.manager, prAuditRecheckManager: f.rechecks, worktreeManager: f.worktree });
  const owner = { sender: { id: 1, isDestroyed: () => false } }; const token = 'pb_' + 'a'.repeat(32);
  h.bind(owner, { projectBindingId: token, projectPath: f.root }); t.after(() => h.close());
  const p = { projectBindingId: token, resultId: f.marker.id };
  assert.equal((await h.prAuditRecheckStart({ sender: { id: 2 } }, p)).ok, false);
  for (const key of ['headSha', 'path', 'findings', 'approved']) assert.equal((await h.prAuditRecheckStart(owner, { ...p, [key]: true })).ok, false);
  const out = await h.prAuditRecheckStart(owner, p); assert.equal(out.ok, true, out.code);
  const signal = await entered.promise; h.unbind(owner, { projectBindingId: token }); assert.equal(signal.aborted, true);
  assert.equal((await f.done(out)).status, 'cancelled');
  assert.equal((await h.prAuditRecheckGet(owner, { projectBindingId: token, recheckRef: out.recheckRef })).ok, false);
});

it('D19 timeout cleans snapshots and releases the shared slot', async (t) => {
  const f = await recheckFixture(t, { timeoutMs: 20, runtime: async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const keepAlive = setTimeout(() => {}, 500); t.after(() => clearTimeout(keepAlive));
  const row = await f.done(await f.rechecks.start(f.root, f.marker.id));
  assert.equal(row.errorCode, 'PR_AUDIT_TIMEOUT'); assert.equal(f.snapshots[0].cleaned, true);
  assert.equal(f.audits.taskPool.tasks.size, 0);
});
