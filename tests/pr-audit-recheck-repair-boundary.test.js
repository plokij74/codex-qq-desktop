'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createRepairManager } = require('../src/ai/repair-manager');
const { createGithubCli } = require('../src/ai/github-cli');
const R = require('../src/ai/pr-audit-recheck-state');
const { followupFixture } = require('./helpers/pr-audit-recheck-repair-fixture');
const { deferred, eventually } = require('./helpers/pr-review-fixture');
function bridge(t, f, extras = {}) {
  const owner = { sender: { id: 1, isDestroyed: () => false } }; const projectBindingId = 'pb_' + 'a'.repeat(32);
  const h = createEngineeringIpcHandlers({ prAuditManager: f.audits, prAuditRepairManager: f.manager,
    prAuditRecheckManager: f.rechecks, prAuditRecheckRepairManager: f.followups, githubCli: f.github,
    worktreeManager: f.worktree, getSettings: () => ({ permissionMode: 'full-auto' }), ...extras });
  h.bind(owner, { projectBindingId, projectPath: f.root }); t.after(() => h.close());
  return { h, owner, projectBindingId, input: { projectBindingId, recheckRef: f.parent.recheckRef,
    repairRevision: R.repairRevision(f.parent), findingIds: f.parent.source.findingIds } };
}
it('D20 GitHub delivery adapter confines fetch, resolve and cleanup to opaque operation refs', async () => {
  const calls = []; const head = 'b'.repeat(40); const ref = 'refs/codex/pr-audit-recheck-repair/pcr_' + 'a'.repeat(24);
  const github = createGithubCli({ execFileImpl: (command, args, options, callback) => {
    calls.push({ command, args, options }); callback(null, args.includes('rev-parse') ? head + '\n' : '', ''); return { kill() {} };
  } });
  assert.equal((await github.fetchBranchToRef({ repoRoot: 'D:/repo', branch: 'feature/review', targetRef: ref })).ok, true);
  assert.equal((await github.resolveCommit({ repoRoot: 'D:/repo', ref })).head, head);
  assert.equal((await github.deleteInternalRef({ repoRoot: 'D:/repo', ref })).ok, true);
  assert.equal(calls.length, 3); assert.ok(calls.every((c) => c.command === 'git' && c.options.shell === false && c.options.windowsHide));
  assert.ok(calls[0].args.includes('--no-write-fetch-head')); assert.ok(calls[0].args.includes('--refmap='));
  assert.equal(calls[0].args.at(-1), 'refs/heads/feature/review:' + ref);
  for (const bad of ['refs/heads/main', ref + '/head', ref + ':refs/heads/main', ref.replace('/pcr_', '/par_')]) {
    assert.equal((await github.fetchBranchToRef({ repoRoot: 'D:/repo', branch: 'feature/review', targetRef: bad })).ok, false);
    assert.equal((await github.resolveCommit({ repoRoot: 'D:/repo', ref: bad })).ok, false);
    assert.equal((await github.deleteInternalRef({ repoRoot: 'D:/repo', ref: bad })).ok, false);
  }
  assert.equal(calls.length, 3);
});

it('D20 IPC rejects cross-sender/project sources, injected authority and Agent starts', async (t) => {
  const f = await followupFixture(t); const { h, owner, projectBindingId, input } = bridge(t, f);
  const other = { sender: { id: 2 } };
  assert.equal((await h.prAuditRecheckRepairSnapshot(other, input)).ok, false);
  for (const injected of [{ headSha: 'f'.repeat(40) }, { findings: [] }, { target: {} }, { approved: true }, { note: 'private' }]) {
    assert.equal((await h.prAuditRecheckRepairSnapshot(owner, { ...input, ...injected })).ok, false);
  }
  const saved = await h.prAuditRecheckRepairSnapshot(owner, input); assert.equal(saved.ok, true, saved.code);
  const source = { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef };
  const payload = { projectBindingId, recheckRepairRef: saved.recheckRepairRef };
  assert.equal((await h.prAuditRecheckRepairSource(owner, payload)).source.recheckRef, f.parent.recheckRef);
  assert.equal((await h.prAuditRecheckRepairSource(other, payload)).ok, false);
  assert.equal((await h.prAuditRecheckUpdatePr(other, { projectBindingId, resultId: f.marker.id })).ok, false);
  assert.equal((await h.repairStartForAgent(f.root, { source })).ok, false);
  assert.equal((await h.repairStart(owner, { projectBindingId, source: { ...source, headSha: 'f'.repeat(40) } })).ok, false);
  assert.equal((await h.repairStart(owner, { projectBindingId, source, note: 'x'.repeat(2001) })).ok, false);
  assert.equal((await h.repairStart(owner, { projectBindingId, source, validationProfileId: 'vfy_' + 'f'.repeat(16) })).ok, false);
  const secondBinding = 'pb_' + 'b'.repeat(32);
  h.bind(owner, { projectBindingId: secondBinding, projectPath: f.root + '/different-project' });
  assert.equal((await h.prAuditRecheckRepairSource(owner, { ...payload, projectBindingId: secondBinding })).ok, false);
  assert.equal(f.worktrees.length, 0);
});

it('D20 cancels generation on unbind, sender destruction and shutdown with partial results retained', async (t) => {
  for (const stop of ['unbind', 'dropSender', 'close']) {
    const f = await followupFixture(t); const saved = await f.snapshot(); const entered = deferred();
    const { h, owner, projectBindingId } = bridge(t, f, { subagentRuntime: { runIsolatedImplement: async (ctx) => {
      entered.resolve(ctx.signal);
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: true,
        terminalReason: 'aborted', incomplete: true, result: { id: 'wt_d20partial', changed: true } }), { once: true }));
    } } });
    const started = await h.repairStart(owner, { projectBindingId, source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef }, note: 'D20_PRIVATE_NOTE' });
    assert.equal(started.ok, true, started.code); const signal = await entered.promise;
    if (stop === 'unbind') h.unbind(owner, { projectBindingId });
    else if (stop === 'dropSender') h.dropSender(owner);
    else h.close();
    assert.equal(signal.aborted, true);
    const final = await eventually(() => h.repairManager.get(f.root, started.repairRef), (out) => ['cancelled', 'interrupted'].includes(out.repair.status) && !!out.repair.resultId);
    assert.equal(final.repair.resultId, 'wt_d20partial'); assert.equal(final.repair.incomplete, true);
    assert.doesNotMatch(JSON.stringify(h.repairManager.store.list()), /D20_PRIVATE_NOTE|PRIVATE_FIXED_CODE|ORIGINAL_FINDING_BODY/);
  }
});

it('D20 never stores a source when capture completes after its binding was replaced', async (t) => {
  const f = await followupFixture(t); const { h, owner, projectBindingId, input } = bridge(t, f);
  const entered = deferred(); const release = deferred(); const factory = f.followups.snapshotFactory;
  f.followups.snapshotFactory = (args) => ({ ...factory(args), init: async () => { entered.resolve(); await release.promise; } });
  const pending = h.prAuditRecheckRepairSnapshot(owner, input); await entered.promise;
  h.unbind(owner, { projectBindingId }); release.resolve();
  assert.equal((await pending).ok, false); assert.equal(f.followups.store.list().length, 0); assert.equal(f.worktrees.length, 0);
});

it('D20 recovery attaches only a matching source and never resumes the model automatically', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot();
  const source = { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef };
  const repair = createRepairManager({ prAuditRecheckRepairManager: f.followups, worktree: f.worktree }); t.after(() => repair.close());
  const row = { repairRef: 'rpr_' + 'a'.repeat(24), projectKey: f.parent.projectKey, source, sourceFingerprint: 'b'.repeat(64),
    status: 'interrupted', createdAt: f.parent.createdAt };
  repair.store.put(row);
  const marker = { id: 'wt_d20recover', subagentId: row.repairRef, originKind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef };
  assert.equal(repair._reconcileRecoveredWorktrees(f.root, { ok: true, results: [{ ...marker, recheckRepairRef: 'pcr_' + 'f'.repeat(24) }] }).warnings, 1);
  assert.equal(repair.get(f.root, row.repairRef).repair.resultId, undefined);
  assert.equal(repair._reconcileRecoveredWorktrees(f.root, { ok: true, results: [marker] }).recovered, 1);
  assert.equal(repair.get(f.root, row.repairRef).repair.resultId, marker.id);
  assert.equal(repair.get(f.root, row.repairRef).repair.status, 'interrupted');
  assert.equal(f.worktrees.length, 0);
});
