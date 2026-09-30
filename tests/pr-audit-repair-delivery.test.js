'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager } = require('../src/ai/worktree');
const { AuditSnapshot, cleanupAuditRefs } = require('../src/ai/pr-audit-snapshot');
const { projectKey } = require('../src/ai/project-index');
const A = require('../src/ai/pr-audit-state');
const { fixture } = require('./helpers/pr-audit-repair-fixture');
const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();

async function delivery(t, { collect = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d18-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Audit Repair Test']); git(root, ['config', 'user.email', 'd18@example.test']);
  git(root, ['config', 'core.autocrlf', 'false']); git(root, ['branch', '-M', 'main']); git(root, ['remote', 'add', 'origin', root]);
  fs.mkdirSync(path.join(root, 'src'));
  const old = 'function first(xs) {\n  return xs[0];\n}\n// Keep caller behavior.\n// Keep return type.\n// Keep errors bounded.\n// Shared utility.\nmodule.exports = first;\n';
  fs.writeFileSync(path.join(root, 'src/old.js'), old);
  fs.writeFileSync(path.join(root, 'src/removed.js'), 'function guard(xs) {\n  return Array.isArray(xs);\n}\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']); const baseHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-qb', 'feature/review']); git(root, ['mv', 'src/old.js', 'src/app.js']); git(root, ['rm', '-q', 'src/removed.js']);
  fs.writeFileSync(path.join(root, 'src/app.js'), old.replace('xs[0]', 'xs.at(0)'));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'rename and remove guard']); const remoteHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-qb', 'local', 'main']); fs.writeFileSync(path.join(root, 'local.txt'), 'local only\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'local head']); const localHead = git(root, ['rev-parse', 'HEAD']);
  const beforeRefs = git(root, ['show-ref']);
  const worktree = createWorktreeManager(); const f = fixture(t, { root, worktree });
  Object.assign(f.state.pr, { headSha: remoteHead, baseSha: baseHead, changedFiles: 2 }); f.state.mergeBase = baseHead;
  const patch = (files) => { const diff = git(root, ['diff', '--no-ext-diff', '-M', baseHead, remoteHead, '--', ...files]); return diff.slice(diff.indexOf('@@')) + '\n'; };
  const rawFiles = [
    { filename: 'src/app.js', previous_filename: 'src/old.js', status: 'renamed', additions: 1, deletions: 1,
      sha: git(root, ['rev-parse', `${remoteHead}:src/app.js`]), patch: patch(['src/old.js', 'src/app.js']) },
    { filename: 'src/removed.js', status: 'removed', additions: 0, deletions: 3, patch: patch(['src/removed.js']) },
  ];
  f.github.getAuditFiles = async () => structuredClone(rawFiles);
  f.github.runCommand = async (cmd, args) => {
    assert.equal(cmd, 'git');
    try { return { ok: true, stdout: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }; }
    catch (error) { return { ok: false, stderr: String(error.stderr || '') }; }
  };
  f.github.fetchBranchToRef = async (args) => { f.calls.push(['fetch', args]); git(root, ['update-ref', args.targetRef, remoteHead]); return { ok: true }; };
  f.github.resolveCommit = async (args) => ({ ok: true, head: git(root, ['rev-parse', args.ref]) });
  f.github.deleteInternalRef = async (args) => { git(root, ['update-ref', '-d', args.ref]); return { ok: true }; };
  f.audits.snapshotFactory = (args) => new AuditSnapshot(args);
  const row = f.audits.save({ ...f.row, source: { ...A.normalizePr(f.state.pr, f.state.repo), repoKey: f.state.repo.repoKey, prefix: '', mergeBaseSha: baseHead },
    report: { ...f.row.report, findings: [...f.row.report.findings, { ...f.row.report.findings[1], findingId: A.ref('paf'), path: 'src/removed.js', contextPath: 'src/removed.js', title: 'Restore deleted guard' }] } });
  const source = await f.snapshot(row.report.findings.map((r) => r.findingId)); assert.equal(source.ok, true, source.code);
  const materialized = await f.manager.materializeRepairSource(root, source.auditRepairRef);
  assert.match(materialized.auditText, /src\/old.js/); assert.match(materialized.auditText, /return xs\[0\]/);
  assert.match(materialized.auditText, /return xs.at\(0\)/); assert.match(materialized.auditText, /Array.isArray/);
  assert.match(materialized.auditText, /变更: removed/); assert.equal(git(root, ['show-ref']), beforeRefs);
  if (!collect) return { ...f, row, source, materialized, remoteHead, baseHead, localHead, beforeRefs, rawFiles };
  const created = await materialized.createWorktree({ project: { path: root }, goal: '处理 AI PR 审查发现' });
  assert.equal(created.ok, true, created.error); assert.equal(git(created.handle.checkout, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(fs.existsSync(path.join(created.handle.checkout, 'local.txt')), false);
  assert.equal(fs.existsSync(path.join(created.handle.checkout, 'src/old.js')), false);
  fs.writeFileSync(path.join(created.handle.checkout, 'src/app.js'), old.replace('xs[0]', 'Array.isArray(xs) && xs.length ? xs[0] : null'));
  assert.equal((await worktree.collect(created.handle)).ok, true);
  return { ...f, row, source, created, remoteHead, baseHead, localHead, beforeRefs };
}

it('D18 delivers one exact-head commit from RIGHT, renamed LEFT and deleted findings after separate approval', async (t) => {
  const f = await delivery(t); const id = f.created.handle.id; let pushes = 0;
  const shown = await f.worktree.get({ projectPath: f.root, resultId: id, preview: true });
  assert.equal(shown.result.originKind, 'pr_audit'); assert.equal(shown.result.auditRepairRef, f.source.auditRepairRef);
  assert.equal(shown.result.canApply, false); assert.equal(shown.result.canCreatePr, false); assert.match(shown.preview, /Array.isArray/);
  f.github.exactLeasePush = async (input) => {
    pushes++; assert.equal(input.oldHead, f.remoteHead); assert.equal(input.branch, 'feature/review');
    assert.equal(git(f.root, ['rev-list', '--parents', '-n', '1', input.newCommit]), `${input.newCommit} ${f.remoteHead}`);
    f.state.pr.headSha = input.newCommit; return { ok: true };
  };
  assert.equal((await f.manager.updatePr(f.root, id, 'Fix findings')).code, 'PR_UPDATE_CONFIRM_REQUIRED');
  const body = f.state.pr.body;
  const stale = await f.manager.updatePr(f.root, id, 'Fix findings', { gate: { authorize: async () => { f.state.pr.body += ' changed'; return { allowed: true }; } } });
  assert.equal(stale.code, 'PR_AUDIT_REPAIR_CHANGED'); assert.equal(pushes, 0); f.state.pr.body = body;
  const prepare = f.worktree.preparePrUpdate;
  f.worktree.preparePrUpdate = async (args) => { const result = await prepare(args); f.state.pr.body += ' changed'; return result; };
  assert.equal((await f.manager.updatePr(f.root, id, 'Fix findings', { gate: f.gate })).code, 'PR_AUDIT_REPAIR_CHANGED');
  assert.equal(pushes, 0); f.state.pr.body = body; f.worktree.preparePrUpdate = prepare;
  const result = await f.manager.updatePr(f.root, id, 'ignored retry subject', { gate: f.gate });
  assert.equal(result.ok, true, result.code); assert.equal(result.result.prUpdate.subject, 'Fix findings');
  assert.equal(result.result.state, 'pr_updated'); assert.equal(pushes, 1);
  assert.equal(f.approvals.at(-1).source, 'pr-audit'); assert.equal(f.approvals.at(-1).risk, 'remote-mutation');
  assert.equal(f.current().stale, true);
  assert.equal((await f.manager.source(f.root, f.source.auditRepairRef)).source.auditRef, f.row.auditRef);
  await assert.rejects(f.manager.resolveMetadata(f.root, f.source.auditRepairRef), { code: 'PR_AUDIT_REPAIR_CHANGED' });
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.localHead); assert.equal(git(f.root, ['show-ref']), f.beforeRefs);
  assert.equal(git(f.root, ['status', '--porcelain']), ''); assert.equal(fs.existsSync(path.join(f.root, '.git/FETCH_HEAD')), false);
});

it('D18 recovery reconciles an uncertain push without replay while the old or new remote head is observed', async (t) => {
  const f = await delivery(t); const id = f.created.handle.id; let pushes = 0; let commit;
  f.github.exactLeasePush = async (args) => { pushes++; commit = args.newCommit; return { ok: false, uncertain: true }; };
  const first = await f.manager.updatePr(f.root, id, 'Fix findings', { gate: f.gate });
  assert.equal(first.code, 'PR_UPDATE_UNCERTAIN'); assert.equal(first.result.state, 'pr_update_uncertain');
  const restarted = createWorktreeManager(); f.manager.worktree = restarted;
  await restarted.recover({ projectPath: f.root });
  assert.equal((await f.manager.updatePr(f.root, id, 'ignored')).code, 'PR_UPDATE_UNCERTAIN');
  assert.equal(pushes, 1); assert.equal(f.approvals.length, 1);
  f.state.pr.headSha = commit;
  const reconciled = await f.manager.updatePr(f.root, id, 'ignored');
  assert.equal(reconciled.ok, true, reconciled.code); assert.equal(reconciled.result.state, 'pr_updated');
  assert.equal(pushes, 1); assert.equal(f.approvals.length, 1); assert.equal(f.current().stale, true);
  assert.equal(git(f.root, ['rev-parse', `${commit}^{tree}`]), reconciled.result.prUpdate.expectedTree);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.localHead); assert.equal(git(f.root, ['show-ref']), f.beforeRefs);
});

it('D18 refuses a dirty main checkout and cleans only its own orphan refs', async (t) => {
  const f = await delivery(t, { collect: false });
  fs.writeFileSync(path.join(f.root, 'dirty.txt'), 'keep user edits');
  const refused = await f.materialized.createWorktree({ project: { path: f.root }, goal: '处理 AI PR 审查发现' });
  assert.equal(refused.code, 'DIRTY_BASE'); assert.equal(f.calls.some(([type]) => type === 'fetch'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'dirty.txt'), 'utf8'), 'keep user edits');
  const active = A.ref(); const orphan = A.ref(); const activeDelivery = A.ref('par'); const orphanDelivery = A.ref('par');
  const refs = [`refs/codex/pr-audit-repair/${active}/head`, `refs/codex/pr-audit-repair/${orphan}/base`,
    `refs/codex/pr-audit-repair/${activeDelivery}`, `refs/codex/pr-audit-repair/${orphanDelivery}`,
    `refs/codex/pr-audit/${orphan}/head`, 'refs/codex/pr-audit-repair/foreign/head'];
  for (const ref of refs) git(f.root, ['update-ref', ref, f.remoteHead]);
  await cleanupAuditRefs(f.github, f.root, new Set([active, activeDelivery]), 'pr-audit-repair');
  const after = git(f.root, ['for-each-ref', '--format=%(refname)', 'refs/codex/']).split('\n');
  assert.deepEqual(after.sort(), [refs[0], refs[2], refs[4], refs[5]].sort());
});

it('D18 scopes fixed-commit reads to a subproject and refuses symbolic links and gitlinks on either side', async (t) => {
  const f = await delivery(t, { collect: false }); const scopedRoot = path.join(f.root, 'src');
  // Build Git-only entries with a separate index, so this also runs on Windows
  // without requiring the privilege to create an on-disk symbolic link.
  const index = path.join(f.root, '.git', 'd18-test-index');
  const indexed = (args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
  const link = git(f.root, ['hash-object', '-w', '--stdin'], 'app.js');
  indexed(['read-tree', f.remoteHead]);
  indexed(['update-index', '--add', '--cacheinfo', `120000,${link},src/link.js`]);
  indexed(['update-index', '--add', '--cacheinfo', `160000,${f.baseHead},src/vendor`]);
  const tree = indexed(['write-tree']); const head = git(f.root, ['commit-tree', tree, '-p', f.remoteHead, '-m', 'unsafe entries']);
  git(f.root, ['update-ref', 'refs/heads/feature/review', head]);
  f.state.pr.headSha = head; f.state.pr.changedFiles = 4;
  f.rawFiles.push({ filename: 'src/link.js', status: 'added', sha: link, additions: 1, deletions: 0 },
    { filename: 'src/vendor', status: 'added', sha: f.baseHead, additions: 1, deletions: 0 });
  const row = f.audits.save({ ...f.row, auditRef: A.ref(), projectKey: projectKey(scopedRoot),
    source: { ...A.normalizePr(f.state.pr, f.state.repo), repoKey: f.state.repo.repoKey, prefix: 'src', mergeBaseSha: f.baseHead } });
  const saved = await f.manager.snapshot(scopedRoot, { auditRef: row.auditRef, repairRevision: A.repairRevision(row), findingIds: row.report.findings.map((r) => r.findingId) });
  assert.equal(saved.ok, true, saved.code);
  const captured = await f.audits.capture(scopedRoot, 7, A.ref(), {}, row.source, 'pr-audit-repair');
  try {
    assert.equal(captured.coverage.skipped.length, 2);
    assert.match((await captured.read({ path: 'src/old.js', side: 'LEFT' })).content, /xs\[0\]/);
    for (const path of ['src/link.js', 'src/vendor', '../local.txt', 'local.txt']) {
      for (const side of ['LEFT', 'RIGHT']) await assert.rejects(captured.read({ path, side }), { code: 'PR_AUDIT_LOCATION' });
    }
  } finally { await captured.cleanup(); }
  const unsafe = f.audits.save({ ...row, auditRef: A.ref(), report: { summary: 'Unsafe location', findings: [
    { ...row.report.findings[0], findingId: A.ref('paf'), path: 'src/link.js', contextPath: 'src/link.js', line: 1, startLine: 1 },
  ] } });
  const refused = await f.manager.snapshot(scopedRoot, { auditRef: unsafe.auditRef, repairRevision: A.repairRevision(unsafe), findingIds: unsafe.report.findings.map((r) => r.findingId) });
  assert.equal(refused.code, 'PR_AUDIT_LOCATION');
  assert.equal(git(f.root, ['for-each-ref', '--format=%(refname)', 'refs/codex/pr-audit-repair/']), '');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.localHead); assert.equal(git(f.root, ['status', '--porcelain']), '');
});
