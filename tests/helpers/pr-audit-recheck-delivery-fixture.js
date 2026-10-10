'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process'); const assert = require('node:assert/strict');
const A = require('../../src/ai/pr-audit-state'); const R = require('../../src/ai/pr-audit-recheck-state');
const { createWorktreeManager } = require('../../src/ai/worktree');
const { AuditSnapshot } = require('../../src/ai/pr-audit-snapshot');
const { PrAuditRecheckManager } = require('../../src/ai/pr-audit-recheck-manager');
const { PrAuditRecheckRepairManager } = require('../../src/ai/pr-audit-recheck-repair-manager');
const { fixture } = require('./pr-audit-repair-fixture');

async function recheckDeliveryFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d20-git-'));
  const root = path.join(directory, 'repo'); const origin = path.join(directory, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(origin); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (args, cwd = root, extra = {}) => {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...extra }).trim();
      } catch (err) {
        lastErr = err;
        const msg = String(err.stderr || err.stdout || err.message || '');
        if (msg.includes('index.lock') || msg.includes('locked') || msg.includes('Permission denied') || msg.includes('resource busy') || err.code === 'EPERM' || err.code === 'EBUSY') {
          const waitTill = Date.now() + 50 * (attempt + 1);
          while (Date.now() < waitTill) {}
          continue;
        }
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${msg}`, { cause: err });
      }
    }
    throw new Error(`git ${args.join(' ')} failed after retries in ${cwd}: ${String(lastErr.stderr || lastErr.message || '')}`, { cause: lastErr });
  };
  git(['init', '--bare', '-q'], origin); git(['init', '-q']); git(['config', 'user.name', 'D20 Test']);
  git(['config', 'user.email', 'd20@example.test']); git(['config', 'core.autocrlf', 'false']); git(['branch', '-M', 'main']);
  git(['remote', 'add', 'origin', origin]); fs.mkdirSync(path.join(root, 'src'));
  const original = 'function first(xs) {\n  return xs[0];\n}\n// Shared utility.\n// Keep caller behavior.\n// Keep return type.\n// Keep errors bounded.\nmodule.exports = first;\n';
  fs.writeFileSync(path.join(root, 'src/old.js'), original);
  fs.writeFileSync(path.join(root, 'src/deleted.js'), 'function guard(xs) {\n  return Array.isArray(xs);\n}\n');
  fs.writeFileSync(path.join(root, 'src/extra.js'), 'module.exports = 1;\n');
  git(['add', '.']); git(['commit', '-qm', 'base']); const baseHead = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'feature/review']); git(['mv', 'src/old.js', 'src/app.js']); git(['rm', '-q', 'src/deleted.js']);
  fs.writeFileSync(path.join(root, 'src/app.js'), original.replace('xs[0]', 'xs.at(0)'));
  git(['add', '.']); git(['commit', '-qm', 'rename with findings']); const originalHead = git(['rev-parse', 'HEAD']);
  git(['push', '-q', 'origin', 'main', 'feature/review']); git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(root, 'local.txt'), 'keep local work\n'); git(['add', '.']); git(['commit', '-qm', 'local only']);
  const localHead = git(['rev-parse', 'HEAD']); const beforeRefs = git(['show-ref']); const beforeIndex = git(['write-tree']);
  const worktree = createWorktreeManager(); const f = fixture(t, { root, worktree });
  Object.assign(f.state.pr, { headSha: originalHead, baseSha: baseHead, changedFiles: 2 }); f.state.mergeBase = baseHead;
  const patchFor = (paths) => { const diff = git(['diff', '--no-ext-diff', '-M', baseHead, originalHead, '--', ...paths]); return diff.slice(diff.indexOf('@@')) + '\n'; };
  f.github.getAuditFiles = async () => [
    { filename: 'src/app.js', previous_filename: 'src/old.js', status: 'renamed', additions: 1, deletions: 1,
      sha: git(['rev-parse', originalHead + ':src/app.js']), patch: patchFor(['src/old.js', 'src/app.js']) },
    { filename: 'src/deleted.js', status: 'removed', additions: 0, deletions: 3, patch: patchFor(['src/deleted.js']) },
  ];
  f.github.runCommand = async (cmd, args) => {
    assert.equal(cmd, 'git'); f.calls.push(['git', args]);
    try { return { ok: true, stdout: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (error) { return { ok: false, stderr: String(error.stderr || '') }; }
  };
  f.github.fetchBranchToRef = async (args) => { f.calls.push(['fetch', args]); git(['update-ref', args.targetRef, f.state.pr.headSha]); return { ok: true }; };
  f.github.resolveCommit = async ({ ref }) => ({ ok: true, head: git(['rev-parse', ref]) });
  f.github.deleteInternalRef = async ({ ref }) => { git(['update-ref', '-d', ref]); return { ok: true }; };
  f.github.branchTip = async () => ({ ok: true, head: git(['rev-parse', 'refs/heads/feature/review'], origin) });
  const pushes = [];
  function publish(commit, oldHead) {
    git(['fetch', '--no-write-fetch-head', '--no-tags', '--refmap=', root, commit], origin);
    git(['update-ref', 'refs/heads/feature/review', commit, oldHead], origin); f.state.pr.headSha = commit;
  }
  f.github.exactLeasePush = async (args) => {
    pushes.push(args); assert.equal(args.oldHead, f.state.pr.headSha);
    assert.equal(git(['rev-list', '--parents', '-n', '1', args.newCommit]), args.newCommit + ' ' + args.oldHead);
    publish(args.newCommit, args.oldHead); return { ok: true };
  };
  f.audits.snapshotFactory = (args) => new AuditSnapshot(args);
  const row = f.audits.save({ ...f.row, source: { ...A.normalizePr(f.state.pr, f.state.repo), repoKey: f.state.repo.repoKey, prefix: '', mergeBaseSha: baseHead },
    report: { ...f.row.report, findings: [...f.row.report.findings, { ...f.row.report.findings[1], findingId: A.ref('paf'),
      path: 'src/deleted.js', contextPath: 'src/deleted.js', title: 'Deleted guard' }] } });
  const first = await f.snapshot(row.report.findings.map((v) => v.findingId)); assert.equal(first.ok, true, first.code);
  const materialized = await f.manager.materializeRepairSource(root, first.auditRepairRef);
  const created = await materialized.createWorktree({ project: { path: root }, goal: '原问题修复' }); assert.equal(created.ok, true, created.code);
  fs.writeFileSync(path.join(created.handle.checkout, 'src/app.js'), original.replace('xs[0]', 'xs.slice(0)[0]'));
  assert.equal((await worktree.collect(created.handle)).ok, true);
  const firstUpdate = await f.manager.updatePr(root, created.handle.id, 'Initial repair', { gate: f.gate }); assert.equal(firstUpdate.ok, true, firstUpdate.code);
  const inputs = [];
  const rechecks = new PrAuditRecheckManager({ auditManager: f.audits, auditRepairManager: f.manager, worktreeManager: worktree,
    runtime: async ({ snapshot, findings }) => {
      inputs.push(await snapshot.input(findings));
      const evidence = await snapshot.read({ path: 'src/app.js' });
      const absent = await snapshot.read({ path: 'src/deleted.js' });
      return { report: { summary: 'Local deterministic recheck', findings: findings.map((v) => ({
        findingId: v.findingId, status: v.path === 'src/deleted.js' ? 'resolved' : v.side === 'LEFT' ? 'unknown' : 'still_present',
        reason: v.side === 'LEFT' ? '需要继续确认调用方预期。' : '继续检查空输入处理。',
        evidence: v.path === 'src/deleted.js' ? [absent.evidenceId] : v.side === 'LEFT' ? [] : [evidence.evidenceId],
      })) }, turns: 1 };
    } });
  const followups = new PrAuditRecheckRepairManager({ auditManager: f.audits, recheckManager: rechecks, worktreeManager: worktree });
  rechecks.getRecheckRepairs = () => followups;
  t.after(() => { rechecks.close(); followups.close(); });
  const done = async (resultId) => {
    const out = await rechecks.start(root, resultId); assert.equal(out.ok, true, out.code);
    await rechecks.runs.get(out.recheckRef)?.done; return rechecks.row(root, out.recheckRef);
  };
  const parent = await done(created.handle.id); assert.equal(parent.status, 'completed', parent.errorCode);
  const capture = async (report = parent, ids = report.report.findings.filter((v) => v.status !== 'resolved').map((v) => v.findingId)) => {
    const saved = await followups.snapshot(root, { recheckRef: report.recheckRef, repairRevision: R.repairRevision(report), findingIds: ids });
    assert.equal(saved.ok, true, saved.code); return saved;
  };
  const generate = async (saved, expression) => {
    const context = await followups.materializeRepairSource(root, saved.recheckRepairRef);
    const created = await context.createWorktree({ project: { path: root }, goal: '继续修复 PR 复审问题' });
    assert.equal(created.ok, true, created.code);
    fs.writeFileSync(path.join(created.handle.checkout, 'src/app.js'), original.replace('xs[0]', expression));
    const collected = await worktree.collect(created.handle); assert.equal(collected.ok, true, collected.code);
    return { context, created, id: created.handle.id, result: collected.result };
  };
  function advance(changes, tree) {
    const oldHead = f.state.pr.headSha;
    if (!tree) {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(root, '.git', 'd20-test-index') };
      const indexed = (args) => git(args, root, { env });
      indexed(['read-tree', oldHead]);
      for (const [name, content] of Object.entries(changes)) {
        if (content === null) indexed(['update-index', '--force-remove', name]);
        else {
          const hash = git(['hash-object', '-w', '--stdin'], root, { input: content });
          indexed(['update-index', '--add', '--cacheinfo', '100644,' + hash + ',' + name]);
        }
      }
      tree = indexed(['write-tree']);
    }
    const commit = git(['commit-tree', tree, '-p', oldHead, '-m', 'later change']); publish(commit, oldHead); return commit;
  }
  return { ...f, row, root, origin, git, original, originalHead, baseHead, localHead, beforeRefs, beforeIndex,
    rechecks, followups, parent, capture, generate, done, pushes, publish, advance, inputs };
}
module.exports = { recheckDeliveryFixture };
