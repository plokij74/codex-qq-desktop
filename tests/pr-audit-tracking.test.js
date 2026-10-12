'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/ai/pr-audit-state');
const { PrAuditTracking, buildTracking } = require('../src/ai/pr-audit-tracking');
const { followupFixture } = require('./helpers/pr-audit-recheck-repair-fixture');

async function fixture(t) {
  const f = await followupFixture(t);
  const tasks = [{ repairRef: A.ref('rpr'), projectKey: f.row.projectKey, source: { kind: 'pr_audit', auditRepairRef: f.item.auditRepairRef },
    resultId: f.marker.id, status: 'ready', createdAt: '2026-10-10T00:00:00.000Z', validation: { status: 'passed' } }];
  const tracking = new PrAuditTracking({ audits: f.audits, auditRepairs: f.manager, followups: f.followups,
    rechecks: f.rechecks, worktree: f.worktree, repairs: { store: { list: () => structuredClone(tasks), persistenceStatus: () => ({ persistence: 'memory' }) } } });
  const get = async () => { const out = await tracking.get(f.root, f.row.auditRef); assert.equal(out.ok, true, JSON.stringify(out)); return out.detail; };
  async function next(ids = [f.parent.source.findingIds[0]], status = 'resolved') {
    const saved = await f.snapshot(ids); assert.equal(saved.ok, true, saved.code);
    const marker = f.deliver(saved.recheckRepairRef);
    const task = { repairRef: A.ref('rpr'), projectKey: f.row.projectKey, source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef },
      resultId: marker.id, status: 'ready', createdAt: '2026-10-11T00:00:00.000Z' };
    tasks.push(task);
    f.rechecks.runtime = async ({ snapshot, findings }) => {
      const e = await snapshot.read({});
      return { report: { summary: 'checked', findings: findings.map((p) => ({ findingId: p.findingId, status, reason: 'checked code', evidence: [e.evidenceId] })) } };
    };
    f.rechecks.now = () => Date.parse(f.parent.createdAt) + 1000;
    const check = await f.done(await f.rechecks.start(f.root, marker.id));
    return { task, marker, check };
  }
  return { ...f, tracking, tasks, get, next };
}

it('D21 lists local scoped reports without remote PR reads and computes partial continuation correctly', async (t) => {
  const f = await fixture(t); let queries = 0; const pr = f.github.getAuditPr;
  f.github.getAuditPr = async (...args) => { queries++; return pr(...args); };
  const repository = f.github.getCiWatchRepository;
  f.github.getCiWatchRepository = async (args) => { assert.equal(args.localOnly, true); return repository(args); };
  const list = await f.tracking.list(f.root, 7); assert.equal(list.reports.length, 1); assert.equal(queries, 0);
  const first = await f.get(); assert.equal(first.counts.still_present, 1); assert.equal(first.counts.unknown, 1);
  f.github.getCiWatchRepository = repository;
  await f.next(); queries = 0; const before = structuredClone(f.calls);
  const detail = await f.get(); assert.equal(queries, 1); assert.deepEqual(f.calls, before);
  assert.deepEqual(detail.counts, { total: 2, resolved: 1, still_present: 0, unknown: 0, stale: 1, unverified: 0, unchecked: 0 });
  assert.equal(detail.rounds.length, 2); assert.equal(detail.rounds[1].parentRoundId, f.tasks[0].repairRef);
  assert.equal(detail.findings[1].latest.status, 'unknown'); assert.equal(detail.findings[1].latest.freshness, 'stale');
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_FIXED_CODE|ORIGINAL_FINDING_BODY|apiKey|"body"|"evidence"/);
});

it('D21 ignores cached freshness, marks changed snapshots stale and preserves history offline/closed', async (t) => {
  const f = await fixture(t); await f.next();
  for (const field of ['headSha', 'baseSha', 'title', 'body']) {
    const old = f.state.pr[field]; f.state.pr[field] = field.endsWith('Sha') ? '1'.repeat(40) : old + ' changed';
    const d = await f.get(); assert.equal(d.counts.resolved, 0); assert.equal(d.counts.stale, 2); f.state.pr[field] = old;
  }
  const read = f.github.getAuditPr; f.github.getAuditPr = async () => { throw A.fail('UNAVAILABLE'); };
  const offline = await f.get(); assert.equal(offline.counts.unverified, 2); assert.equal(offline.checkedAt, null);
  assert.equal((await f.tracking.list(f.root)).reports.length, 1);
  f.github.getAuditPr = read; f.state.pr.state = 'closed';
  const closed = await f.get(); assert.equal(closed.counts.stale, 2); assert.equal(closed.rounds.length, 2);
});

it('D21 failure/no-change attempts do not overwrite verdicts; source previews are not rounds', async (t) => {
  const f = await fixture(t); const saved = await f.snapshot();
  assert.equal((await f.get()).rounds.length, 1);
  for (const status of ['failed', 'cancelled', 'interrupted', 'no_changes']) f.tasks.push({ ...f.tasks[0], repairRef: A.ref('rpr'),
    source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef }, resultId: undefined, status, createdAt: '2026-10-12T00:00:00.000Z' });
  f.rechecks.now = () => Date.parse(f.parent.createdAt) + 1000;
  f.rechecks.runtime = async () => { throw Error('failure'); };
  await f.done(await f.rechecks.start(f.root, f.marker.id));
  const d = await f.get(); assert.equal(d.rounds.length, 5); assert.equal(d.findings[0].latest.recheckRef, f.parent.recheckRef);
  assert.equal(d.rechecks.at(-1).status, 'failed');
});

it('D21 source loss and unavailable results retain readable fragments without invented links', async (t) => {
  const f = await fixture(t); await f.next();
  f.manager.store.rows.clear(); f.worktree.list = async () => ({ ok: false });
  const d = await f.get(); assert.equal(d.rounds.length, 2); assert.equal(d.findings.length, 2);
  assert.ok(d.rounds.every((r) => !r.resultAvailable)); assert.ok(d.warnings.length);
  f.audits.store.records.clear();
  const missing = await f.get(); assert.equal(missing.sourceAvailable, false); assert.equal(missing.findings.length, 0); assert.equal(missing.rechecks.length, 2);
  f.tasks.length = 0; assert.equal((await f.get()).orphanRecheckRefs.length, 2);
});

it('D21 scopes repository, PR and project; never merges different original reports', async (t) => {
  const f = await fixture(t);
  f.audits.store.put({ ...f.row, auditRef: A.ref(), createdAt: '2026-10-12T00:00:00.000Z' });
  assert.equal((await f.tracking.list(f.root, 7)).reports.length, 2);
  assert.equal((await f.tracking.list(f.root, 8)).reports.length, 0);
  f.state.repo.repoKey = '9'.repeat(64);
  assert.equal((await f.tracking.list(f.root, 7)).reports.length, 0);
  assert.equal((await f.tracking.get(f.root, f.row.auditRef)).code, 'PR_AUDIT_NOT_FOUND');
  assert.equal((await f.tracking.get(f.root, '../evil')).ok, false);
  assert.equal((await f.tracking.list(f.root, '7')).ok, false);
});

it('D21 uses stable creation order, exposes sibling branches and cuts cyclic parent links', async (t) => {
  const f = await fixture(t); const { task, check } = await f.next();
  const data = await f.tracking.load(f.root, {});
  const branch = { ...task, repairRef: A.ref('rpr'), resultId: undefined };
  let d = buildTracking({ ...data, repairs: [...data.repairs, branch], auditRef: f.row.auditRef });
  assert.equal(d.rounds.filter((r) => r.parentRoundId === f.tasks[0].repairRef).length, 2);
  // Malformed edges cannot turn a finite history into an unbounded traversal.
  const source = data.followups[0]; source.recheckRef = check.recheckRef; source.parentResultId = check.source.resultId;
  source.repairRevision = require('../src/ai/pr-audit-recheck-state').repairRevision(check);
  d = buildTracking({ ...data, auditRef: f.row.auditRef });
  assert.equal(d.rounds[1].parentRoundId, null); assert.ok(d.rounds[1].issues.some((v) => v.includes('循环')));
});

it('D21 tied timestamps use reference order and reading never rewrites cached history', async (t) => {
  const f = await fixture(t);
  const latest = { ...structuredClone(f.parent), recheckRef: 'pac_' + 'f'.repeat(24) };
  latest.report.findings = latest.report.findings.map((v) => ({ ...v, status: 'unknown', reason: 'newer tied verdict', evidence: [] }));
  f.rechecks.store.put(latest);
  f.rechecks.store.put({ ...f.parent, recheckRef: 'pac_' + '0'.repeat(24) });
  const before = JSON.stringify([f.audits.store.list(), f.rechecks.store.list(), f.manager.store.list(), f.followups.store.list()]);
  const detail = await f.get();
  assert.equal(detail.findings[0].latest.recheckRef, latest.recheckRef);
  assert.equal(detail.counts.unknown, 2);
  assert.equal(JSON.stringify([f.audits.store.list(), f.rechecks.store.list(), f.manager.store.list(), f.followups.store.list()]), before);
});
