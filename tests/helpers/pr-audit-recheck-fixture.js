'use strict';
const { fixture } = require('./pr-audit-repair-fixture');
const { PrAuditRecheckManager } = require('../../src/ai/pr-audit-recheck-manager');
const A = require('../../src/ai/pr-audit-state');
async function recheckFixture(t, options = {}) {
  const f = fixture(t); const saved = await f.snapshot();
  const item = f.manager.store.get(saved.auditRepairRef, f.row.projectKey);
  const marker = { id: 'wt_recheckresult', state: 'pr_updated', originKind: 'pr_audit', deliveryKind: 'github_pr_update',
    auditRepairRef: item.auditRepairRef, baseHead: item.headSha, expectedTree: 'f'.repeat(40),
    prUpdate: { oldHead: item.headSha, newCommit: 'e'.repeat(40), expectedTree: 'f'.repeat(40), prNumber: 7 } };
  f.audits.save({ ...f.current(), stale: true }); f.state.pr.headSha = marker.prUpdate.newCommit;
  f.worktree.inspectRemoteResult = async () => ({ ok: true, marker: structuredClone(marker) });
  f.worktree.list = async () => ({ ok: true, results: [structuredClone(marker)] });
  const snapshots = []; const events = [];
  const manager = new PrAuditRecheckManager({ auditManager: f.audits, auditRepairManager: f.manager, worktreeManager: f.worktree,
    onEvent: (e) => events.push(e), snapshotFactory: (args) => {
      const s = { ...args, evidence: new Map(), source: args.target, consume: (v) => v, init: async () => {}, cleanup: async () => { s.cleaned = true; },
        input: async (findings) => ({ findings }), list: async () => ({ files: ['src/app.js'] }), search: async () => ({ matches: [] }),
        read: async ({ stage = 'target', path = 'src/app.js' } = {}) => {
          const evidenceId = A.ref('pce'); s.evidence.set(evidenceId, { evidenceId, stage, sha: args.target.headSha, path, kind: 'code', startLine: 1, line: 2 });
          return { evidenceId, sha: args.target.headSha, path, content: 'TARGET_PRIVATE_CODE' };
        } };
      snapshots.push(s); return s;
    }, runtime: async ({ snapshot, findings }) => {
      const read = await snapshot.read({});
      return { report: { summary: '逐项复审完成', findings: findings.map((f) => ({ findingId: f.findingId, status: 'resolved', reason: '已检查空输入分支', evidence: [read.evidenceId] })) }, turns: 1 };
    }, ...options });
  t.after(() => manager.close());
  const done = async (out) => { await manager.runs.get(out.recheckRef)?.done; return manager.row(f.root, out.recheckRef); };
  return { ...f, rechecks: manager, marker, item, snapshots, recheckEvents: events, done };
}
module.exports = { recheckFixture };
