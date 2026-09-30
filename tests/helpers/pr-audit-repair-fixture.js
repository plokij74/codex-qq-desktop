'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectKey } = require('../../src/ai/project-index');
const { createPrAuditManager } = require('../../src/ai/pr-audit-manager');
const { createPrAuditRepairManager } = require('../../src/ai/pr-audit-repair-manager');
const A = require('../../src/ai/pr-audit-state');

const DATE = '2026-09-30T02:00:00.000Z';
function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d18-'));
  const calls = []; const events = [];
  const state = {
    repo: { repoRoot: root, host: 'github.com', owner: 'acme', repo: 'widget', nameWithOwner: 'acme/widget', repoKey: 'a'.repeat(64) },
    pr: { number: 7, state: 'open', merged: false, title: 'Repair inputs', body: 'Original description', headRepo: 'acme/widget', baseRepo: 'acme/widget',
      headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), headRefName: 'feature/review', baseRefName: 'main', changedFiles: 1 },
    mergeBase: 'd'.repeat(40),
    files: [{ path: 'src/app.js', oldPath: 'src/old.js', status: 'renamed',
      hunks: [{ leftStart: 1, leftCount: 3, rightStart: 1, rightCount: 3, changedLeft: [2], changedRight: [2] }] }],
  };
  const github = {
    getCiWatchRepository: async () => ({ ok: true, repository: { ...state.repo } }),
    getAuditPr: async () => ({ ...state.pr }), getAuditMergeBase: async () => state.mergeBase,
    getAuditFiles: async () => [{ filename: 'src/app.js' }],
    runCommand: async (_cmd, args) => { calls.push(['git', args]); return { ok: true, stdout: '' }; },
    fetchBranchToRef: async (args) => { calls.push(['fetch', args]); return { ok: true }; },
    resolveCommit: async () => ({ ok: true, head: state.pr.headSha }),
    deleteInternalRef: async (args) => { calls.push(['delete-ref', args]); return { ok: true }; },
    branchTip: async () => ({ ok: true, head: state.pr.headSha }),
  };
  const snapshotFactory = ({ source, auditRef, refNamespace }) => ({
    source, files: structuredClone(state.files),
    init: async () => { calls.push(['capture', { auditRef, refNamespace }]); },
    cleanup: async () => { calls.push(['cleanup', auditRef]); },
    read: async (args) => { calls.push(['read', args]); return { ...args, content: '1: input\n2: ORIGINAL_CODE_EVIDENCE\n3: return', sha: args.side === 'LEFT' ? state.mergeBase : state.pr.headSha }; },
  });
  const audits = createPrAuditManager({ githubCli: github, snapshotFactory, onEvent: (event) => events.push(event),
    getSettings: () => ({ mode: 'api', agentEnabled: true, apiKey: 'test-key', model: 'test-model' }) });
  const row = audits.store.put({ auditRef: A.ref(), projectKey: projectKey(root), prNumber: 7, createdAt: DATE,
    status: 'completed', stale: false,
    source: { ...A.normalizePr(state.pr, state.repo), repoKey: state.repo.repoKey, prefix: '', mergeBaseSha: state.mergeBase },
    coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] },
    report: { summary: 'Two input issues', findings: Array.from({ length: options.findings || 2 }, (_, i) => ({
      findingId: A.ref('paf'), priority: 'P1', title: `Original finding ${i + 1}`, body: 'ORIGINAL_FINDING_BODY: handle empty input.',
      path: 'src/app.js', contextPath: i === 1 ? 'src/old.js' : 'src/app.js', side: i === 1 ? 'LEFT' : 'RIGHT', line: 2, startLine: 2,
    })) },
  });
  const worktrees = [];
  const worktree = options.worktree || {
    createAtCommit: async (args) => { worktrees.push(args); return { ok: true, handle: { id: 'wt_auditrepair1', childProjectPath: root, baseHead: args.baseHead } }; },
    list: async () => ({ ok: true, results: [] }),
  };
  const manager = createPrAuditRepairManager({ auditManager: audits, githubCli: github, worktreeManager: worktree, ...options.managerOptions });
  audits.store.isProtected = (ref) => manager.protectsReport(ref);
  const approvals = []; const gate = { authorize: async (args) => { approvals.push(args); return { allowed: true }; } };
  function current() { return audits.get(root, row.auditRef).audit; }
  function snapshot(ids = row.report.findings.map((f) => f.findingId), context = {}) {
    return manager.snapshot(root, { auditRef: row.auditRef, repairRevision: current().repairRevision, findingIds: ids }, context);
  }
  t.after(() => { manager.close(); audits.close(); if (!options.root) fs.rmSync(root, { recursive: true, force: true }); });
  return { root, state, github, calls, events, audits, manager, row, current, snapshot, worktree, worktrees, gate, approvals };
}
module.exports = { fixture, DATE };
