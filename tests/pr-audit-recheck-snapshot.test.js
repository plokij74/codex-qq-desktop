'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const A = require('../src/ai/pr-audit-state'); const S = require('../src/ai/pr-audit-recheck-state');
const { RecheckSnapshot, cleanupRecheckRefs } = require('../src/ai/pr-audit-recheck-snapshot');
function repoFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-git-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options }).trim();
  const write = (p, v) => fs.writeFileSync(path.join(root, p), v);
  git(['init', '-q']); git(['config', 'user.name', 'D19 Test']); git(['config', 'user.email', 'd19@example.test']); git(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(root, 'src')); write('src/app.js', 'function first(xs) {\n  return xs[0];\n}\n'); write('src/remove.js', 'old code\n'); write('outside.txt', 'OUTSIDE_PRIVATE_DATA\n');
  git(['add', '.']); git(['commit', '-qm', 'base']); git(['branch', '-M', 'main']); const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'feature']); write('src/app.js', 'function first(xs) {\n  return xs.at(0);\n}\n'); git(['add', '.']); git(['commit', '-qm', 'original']); const original = git(['rev-parse', 'HEAD']);
  write('src/app.js', 'function first(xs) {\n  return xs?.[0] ?? null;\n}\n'); git(['add', '.']); git(['commit', '-qm', 'repair']); const repair = git(['rev-parse', 'HEAD']);
  git(['remote', 'add', 'origin', root]);
  const source = { auditRef: A.ref(), auditRepairRef: A.ref('par'), resultId: 'wt_d19gitresult', repoKey: 'a'.repeat(64), prNumber: 7,
    prefix: 'src', headRefName: 'feature', baseRefName: 'main', originalHead: original, originalBase: base, repairCommit: repair,
    expectedTree: git(['rev-parse', `${repair}^{tree}`]), repairRevision: 'b'.repeat(64), findingIds: [A.ref('paf')] };
  const target = () => ({ repoKey: source.repoKey, prNumber: 7, prefix: 'src', headRefName: 'feature', baseRefName: 'main',
    baseSha: base, headSha: git(['rev-parse', 'feature']), mergeBaseSha: base, descriptionHash: 'c'.repeat(64) });
  const calls = []; const github = { runCommand: async (cmd, args) => {
    calls.push(args); try { return { ok: true, stdout: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { ok: false, stdout: '', stderr: String(e.stderr || '') }; }
  } };
  const snapshot = () => new RecheckSnapshot({ github, repo: { repoRoot: root }, source, target: target(), recheckRef: S.ref() });
  return { root, git, write, source, target, snapshot, base, original, repair, github, calls };
}
it('D19 fixed snapshots verify delivery and descendants, rename/delete and dirty checkout without changing refs', async (t) => {
  const f = repoFixture(t); const first = f.snapshot(); await first.init();
  assert.match((await first.read({ path: 'src/app.js' })).content, /\?\./);
  assert.match((await first.read({ path: 'src/app.js', stage: 'original_head' })).content, /\.at/);
  assert.match((await first.read({ path: 'src/app.js', stage: 'original_base' })).content, /xs\[0\]/);
  await first.cleanup();
  f.git(['mv', 'src/app.js', 'src/renamed.js']); f.git(['rm', 'src/remove.js']); f.git(['commit', '-qm', 'later rename and delete']);
  const head = f.git(['rev-parse', 'HEAD']); const refs = f.git(['show-ref']);
  f.write('src/renamed.js', 'DIRTY_PRIVATE_WORKTREE\n'); f.git(['add', 'src/renamed.js']); f.write('src/renamed.js', 'DIRTY_UNSTAGED\n');
  const status = f.git(['status', '--porcelain']); const index = f.git(['write-tree']);
  const snap = f.snapshot(); await snap.init();
  assert.equal(snap.source.headSha, head); assert.match((await snap.read({ path: 'src/renamed.js' })).content, /\?\./);
  const absence = await snap.read({ path: 'src/remove.js' }); assert.equal(absence.absent, true);
  assert.equal(snap.evidence.get(absence.evidenceId).existedBefore, true);
  assert.ok(snap.diffs[1].files.some((file) => file.status.startsWith('R')));
  await assert.rejects(() => snap.read({ path: 'outside.txt' }), /LOCATION/);
  await assert.rejects(() => snap.read({ path: '../outside.txt' }), /LOCATION/);
  await snap.cleanup();
  assert.equal(f.git(['rev-parse', 'HEAD']), head); assert.equal(f.git(['write-tree']), index); assert.equal(f.git(['status', '--porcelain']), status); assert.equal(f.git(['show-ref']), refs);
  assert.equal(fs.existsSync(path.join(f.root, '.git', 'FETCH_HEAD')), false);
  const orphan = `refs/codex/pr-audit-recheck/${S.ref()}/head`; const activeRef = S.ref(); const active = `refs/codex/pr-audit-recheck/${activeRef}/head`;
  const foreign = `refs/codex/pr-audit/${A.ref()}/head`; f.git(['update-ref', orphan, head]); f.git(['update-ref', active, head]); f.git(['update-ref', foreign, head]);
  await cleanupRecheckRefs(f.github, f.root, new Set([activeRef]));
  const after = f.git(['show-ref']); assert.ok(!after.includes(orphan)); assert.ok(after.includes(active)); assert.ok(after.includes(foreign));
});
it('D19 handles no current PR diff, rejects removed repair ancestry and mismatched trees', async (t) => {
  const f = repoFixture(t);
  f.write('src/app.js', 'function first(xs) {\n  return xs[0];\n}\n'); f.git(['add', '.']); f.git(['commit', '-qm', 'return to base content']);
  assert.equal(f.git(['diff', f.base, 'HEAD']), ''); const snap = f.snapshot(); await snap.init(); await snap.cleanup();
  f.git(['update-ref', 'refs/heads/feature', f.original]); const unrelated = f.snapshot();
  await assert.rejects(() => unrelated.init(), /RECHECK_ANCESTRY/);
  assert.equal(f.git(['for-each-ref', '--format=%(refname)', 'refs/codex/pr-audit-recheck/']), '');
  f.git(['update-ref', 'refs/heads/feature', f.repair]); f.source.expectedTree = '0'.repeat(40);
  await assert.rejects(() => f.snapshot().init(), /RECHECK_DELIVERY/);
});
it('D19 refuses symlink/gitlink reads and never exposes cross-scope rename contents', async (t) => {
  const f = repoFixture(t); const oid = f.git(['hash-object', '-w', '--stdin'], { input: '../outside.txt\n' });
  f.git(['update-index', '--add', '--cacheinfo', `120000,${oid},src/link`]);
  f.git(['update-index', '--add', '--cacheinfo', `160000,${f.base},src/module`]);
  f.git(['mv', 'outside.txt', 'src/moved.txt']); f.git(['commit', '-qm', 'unsupported paths']);
  const snap = f.snapshot(); await snap.init();
  for (const p of ['src/link', 'src/link/nested', 'src/module', 'src/module/file']) await assert.rejects(() => snap.read({ path: p }), /LOCATION/);
  assert.doesNotMatch(JSON.stringify(snap.diffs), /OUTSIDE_PRIVATE_DATA/);
  assert.ok(snap.diffs[1].skipped.some((s) => s.reason === '跨项目范围移动'));
  await snap.cleanup();
});
