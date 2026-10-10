'use strict';
const A = require('../../src/ai/pr-audit-state');
const R = require('../../src/ai/pr-audit-recheck-state');
const { PrAuditRecheckRepairManager } = require('../../src/ai/pr-audit-recheck-repair-manager');
const { recheckFixture } = require('./pr-audit-recheck-fixture');
async function followupFixture(t, options = {}) {
  const f = await recheckFixture(t, { runtime: async ({ snapshot, findings }) => {
    const read = await snapshot.read({});
    return { report: { summary: '继续检查原问题', findings: findings.map((finding, i) => ({
      findingId: finding.findingId, status: i ? 'unknown' : 'still_present',
      reason: i ? 'UNKNOWN_PRIVATE_REASON: 需要检查调用方' : 'CURRENT_PRIVATE_REASON: 空输入仍然失败',
      evidence: i ? [] : [read.evidenceId],
    })) }, turns: 1 };
  } });
  const snapshots = [];
  const followups = new PrAuditRecheckRepairManager({ auditManager: f.audits, recheckManager: f.rechecks,
    worktreeManager: f.worktree, snapshotFactory: (args) => {
      const snapshot = { ...args, init: async () => {}, cleanup: async () => { snapshot.cleaned = true; },
        read: async ({ stage, path, offset, limit }) => {
          const sha = { target: args.target.headSha, original_head: args.source.originalHead, original_base: args.source.originalBase,
            repair: args.source.repairCommit, repair_base: args.source.repairBaseHead }[stage];
          return { stage, path, sha, content: 'PRIVATE_FIXED_CODE', offset, limit };
        } };
      snapshots.push(snapshot); return snapshot;
    }, ...options });
  f.rechecks.getRecheckRepairs = () => followups;
  f.rechecks.store.isProtected = (ref) => followups.protectsRecheck(ref);
  const markers = new Map([[f.marker.id, f.marker]]);
  f.worktree.inspectRemoteResult = async ({ resultId }) => ({ ok: markers.has(resultId), marker: structuredClone(markers.get(resultId)) });
  f.worktree.list = async () => ({ ok: true, results: [...markers.values()].map((m) => structuredClone(m)) });
  const parent = await f.done(await f.rechecks.start(f.root, f.marker.id));
  const snapshot = (ids = parent.source.findingIds, row = f.rechecks.row(f.root, parent.recheckRef)) =>
    followups.snapshot(f.root, { recheckRef: row.recheckRef, repairRevision: R.repairRevision(row), findingIds: ids });
  function deliver(ref) {
    const item = followups.sourceRow(f.root, ref); const commit = A.hash(ref).slice(0, 40);
    const marker = { id: 'wt_' + A.ref('d20').slice(4), state: 'pr_updated', originKind: 'pr_audit_recheck',
      deliveryKind: 'github_pr_update', recheckRepairRef: ref, baseHead: item.headSha, expectedTree: 'f'.repeat(40),
      prUpdate: { oldHead: item.headSha, newCommit: commit, expectedTree: 'f'.repeat(40), prNumber: 7 } };
    markers.set(marker.id, marker); f.state.pr.headSha = commit;
    return marker;
  }
  t.after(() => followups.close());
  return { ...f, followups, parent, snapshot, snapshots20: snapshots, markers, deliver };
}
module.exports = { followupFixture };
