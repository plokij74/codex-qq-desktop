'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager } = require('../src/ai/worktree');
const { fixture } = require('./helpers/pr-review-fixture');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

async function delivery(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d16-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Review Test']); git(root, ['config', 'user.email', 'review@example.test']);
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function first(xs) {\n  return xs[0];\n}\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'remote base']);
  const remoteHead = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'local.txt'), 'local-only\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'local head']);
  const localHead = git(root, ['rev-parse', 'HEAD']); const beforeRefs = git(root, ['show-ref']);
  const worktree = createWorktreeManager(); const f = fixture(t, { root, worktree }); f.state.pr.headSha = remoteHead;
  f.github.fetchBranchToRef = async (args) => { git(root, ['update-ref', args.targetRef, remoteHead]); return { ok: true }; };
  f.github.resolveCommit = async (args) => ({ ok: true, head: git(root, ['rev-parse', args.ref]) });
  f.github.deleteInternalRef = async (args) => { git(root, ['update-ref', '-d', args.ref]); return { ok: true }; };
  const source = await f.snapshot(); assert.equal(source.ok, true);
  const materialized = await f.manager.materializeRepairSource(root, source.reviewRef);
  const created = await materialized.createWorktree({ project: { path: root }, goal: '处理 PR 审查反馈' });
  assert.equal(created.ok, true, created.error); assert.equal(git(created.handle.checkout, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(fs.existsSync(path.join(created.handle.checkout, 'local.txt')), false);
  fs.writeFileSync(path.join(created.handle.checkout, 'src', 'app.js'), 'function first(xs) {\n  return xs.length ? xs[0] : null;\n}\n');
  assert.equal((await worktree.collect(created.handle)).ok, true);
  return { ...f, source, created, remoteHead, localHead, beforeRefs };
}

it('D16 delivers an exact-head child commit after source revalidation and keeps manual discussion usable on the new head', async (t) => {
  const f = await delivery(t); let pushes = 0;
  const id = f.created.handle.id;
  const shown = await f.worktree.get({ projectPath: f.root, resultId: id, preview: true });
  assert.equal(shown.result.canApply, false); assert.equal(shown.result.canCreatePr, false); assert.equal(shown.result.originKind, 'pr_review');
  assert.match(shown.preview, /xs.length/);
  f.github.exactLeasePush = async (input) => {
    pushes++; assert.equal(input.oldHead, f.remoteHead); assert.equal(input.branch, 'feature/review');
    assert.equal(git(f.root, ['rev-list', '--parents', '-n', '1', input.newCommit]), `${input.newCommit} ${f.remoteHead}`);
    f.state.pr.headSha = input.newCommit; return { ok: true };
  };
  const originalBody = f.state.threads[0].comments.nodes[0].body;
  const stale = await f.manager.updatePr(f.root, id, 'Fix review', { gate: { authorize: async () => { f.state.threads[0].comments.nodes[0].body += ' changed'; return { allowed: true }; } } });
  assert.equal(stale.code, 'PR_REVIEW_CHANGED'); assert.equal(pushes, 0);
  f.state.threads[0].comments.nodes[0].body = originalBody;
  const prepare = f.worktree.preparePrUpdate;
  f.worktree.preparePrUpdate = async (args) => { const out = await prepare(args); f.state.threads[0].isResolved = true; return out; };
  assert.equal((await f.manager.updatePr(f.root, id, 'Fix review', { gate: f.gate })).code, 'PR_REVIEW_CHANGED');
  assert.equal(pushes, 0); f.state.threads[0].isResolved = false; f.worktree.preparePrUpdate = prepare;
  const updated = await f.manager.updatePr(f.root, id, 'different retry title', { gate: f.gate });
  assert.equal(updated.ok, true, updated.error); assert.equal(updated.result.state, 'pr_updated'); assert.equal(updated.result.prUpdate.subject, 'Fix review');
  assert.equal(updated.result.prUpdate.prNumber, 7); assert.equal(pushes, 1);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.localHead); assert.equal(git(f.root, ['show-ref']), f.beforeRefs); assert.equal(git(f.root, ['status', '--porcelain']), '');
  const nav = await f.manager.source(f.root, f.source.reviewRef);
  const selected = (await f.manager.get(f.root, nav.threadRef)).thread;
  assert.equal(selected.headSha, f.state.pr.headSha);
  assert.equal((await f.manager.reply(f.root, { threadRef: selected.threadRef, revision: selected.revision, body: 'The edge case is covered now.' }, { gate: f.gate })).ok, true);
  assert.equal(f.state.threads[0].isResolved, false);
});

it('D16 reconciles uncertain push across recovery without re-pushing, even while the remote still shows the old head', async (t) => {
  const f = await delivery(t); const id = f.created.handle.id; let pushes = 0; let commit;
  f.github.exactLeasePush = async (args) => { pushes++; commit = args.newCommit; return { ok: false, uncertain: true }; };
  const first = await f.manager.updatePr(f.root, id, 'Fix review', { gate: f.gate });
  assert.equal(first.code, 'PR_UPDATE_UNCERTAIN'); assert.equal(first.result.state, 'pr_update_uncertain');
  await f.worktree.recover({ projectPath: f.root });
  assert.equal((await f.manager.updatePr(f.root, id, 'ignore this')).code, 'PR_UPDATE_UNCERTAIN');
  assert.equal(pushes, 1); assert.equal(f.approvals.length, 1);
  f.state.pr.headSha = commit;
  const reconciled = await f.manager.updatePr(f.root, id, 'ignore this');
  assert.equal(reconciled.ok, true, reconciled.error); assert.equal(reconciled.result.state, 'pr_updated');
  assert.equal(pushes, 1); assert.equal(f.approvals.length, 1);
  assert.equal(git(f.root, ['rev-parse', `${commit}^{tree}`]), reconciled.result.prUpdate.expectedTree);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.localHead); assert.equal(git(f.root, ['show-ref']), f.beforeRefs);
});
