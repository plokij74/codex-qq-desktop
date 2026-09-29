'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AuditSnapshot, verifyPatch, cleanupAuditRefs } = require('../src/ai/pr-audit-snapshot');
const S = require('../src/ai/pr-audit-state');

function initTestGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-snap-test-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  run(['init', '-q']);
  run(['config', 'user.name', 'Snapshot Tester']);
  run(['config', 'user.email', 'snap@example.test']);

  // Base files
  fs.writeFileSync(path.join(dir, 'app.js'), 'function hello() {\n  return "world";\n}\nmodule.exports = { hello };\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nInitial readme\n');
  run(['add', '.']);
  run(['commit', '-qm', 'initial base']);
  run(['branch', '-M', 'main']);
  const baseSha = run(['rev-parse', 'HEAD']);

  // Create feature branch
  run(['checkout', '-qb', 'feature']);
  fs.writeFileSync(path.join(dir, 'app.js'), 'function hello(name) {\n  if (!name) return "world";\n  return name;\n}\nmodule.exports = { hello };\n');
  fs.writeFileSync(path.join(dir, 'new-file.js'), 'const version = 1;\n');
  run(['add', '.']);
  run(['commit', '-qm', 'add name param and new file']);
  const headSha = run(['rev-parse', 'HEAD']);

  // Add origin remote pointing to itself so git fetch works
  run(['remote', 'add', 'origin', dir]);

  return { dir, run, baseSha, headSha, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('D17 PR audit snapshot', () => {
  it('verifies patch against before and after blobs', () => {
    const before = 'function a() {\n  return 1;\n}\n';
    const after = 'function a() {\n  // comment\n  return 2;\n}\n';
    const patch = '@@ -1,3 +1,4 @@\n function a() {\n+  // comment\n-  return 1;\n+  return 2;\n }\n';
    verifyPatch(patch, before, after);

    // Mismatched patch throws INCOMPLETE
    assert.throws(() => verifyPatch(patch, before, before), /PR_AUDIT_INCOMPLETE/);
  });

  it('fetches refs, verifies files, and cleans up temporary refs', async (t) => {
    const repo = initTestGitRepo();
    t.after(() => repo.cleanup());

    const auditRef = S.ref('pra');
    const source = {
      prNumber: 1,
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      mergeBaseSha: repo.baseSha,
      headRefName: 'feature',
      baseRefName: 'main',
      changedFiles: 2,
      prefix: '',
      title: 'feat',
      body: 'test',
    };

    const appDiff = repo.run(['diff', '-u', repo.baseSha, repo.headSha, '--', 'app.js']);
    const appPatch = appDiff.slice(appDiff.indexOf('@@')) + '\n';
    const newDiff = repo.run(['diff', '-u', repo.baseSha, repo.headSha, '--', 'new-file.js']);
    const newPatch = newDiff.slice(newDiff.indexOf('@@')) + '\n';

    const rawFiles = [
      {
        filename: 'app.js',
        status: 'modified',
        additions: 3,
        deletions: 2,
        sha: repo.run(['rev-parse', `${repo.headSha}:app.js`]),
        patch: appPatch,
      },
      {
        filename: 'new-file.js',
        status: 'added',
        additions: 1,
        deletions: 0,
        sha: repo.run(['rev-parse', `${repo.headSha}:new-file.js`]),
        patch: newPatch,
      },
    ];

    const github = {
      runCommand: async (cmd, args, opts = {}) => {
        try {
          const stdout = execFileSync(cmd, args, { cwd: opts.cwd || repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return { ok: true, stdout };
        } catch (err) {
          return { ok: false, error: err.message, stdout: '', stderr: String(err.stderr || '') };
        }
      },
    };

    const snapshot = new AuditSnapshot({
      github,
      repo: { repoRoot: repo.dir },
      source,
      auditRef,
      files: rawFiles,
    });

    await snapshot.init();

    assert.equal(snapshot.coverage.total, 2);
    assert.equal(snapshot.coverage.reviewed, 2);
    assert.equal(snapshot.coverage.skipped.length, 0);

    // Test read
    const readResult = await snapshot.read({ path: 'app.js', side: 'RIGHT', offset: 1, limit: 10 });
    assert.equal(readResult.path, 'app.js');
    assert.equal(readResult.side, 'RIGHT');
    assert.match(readResult.content, /1: function hello\(name\)/);

    // Test list
    const listResult = await snapshot.list();
    assert.ok(listResult.files.includes('app.js'));
    assert.ok(listResult.files.includes('new-file.js'));

    // Test search
    const searchResult = await snapshot.search({ query: 'version' });
    assert.equal(searchResult.matches.length, 1);
    assert.equal(searchResult.matches[0].path, 'new-file.js');
    assert.equal(searchResult.matches[0].line, 1);

    // Verify git refs were created
    const showRefOut = repo.run(['for-each-ref', '--format=%(refname)', `refs/codex/pr-audit/${auditRef}/`]);
    assert.match(showRefOut, /refs\/codex\/pr-audit\/pra_[a-f0-9]{24}\/base/);
    assert.match(showRefOut, /refs\/codex\/pr-audit\/pra_[a-f0-9]{24}\/head/);

    // Test cleanup
    await snapshot.cleanup();
    const afterRefOut = repo.run(['for-each-ref', '--format=%(refname)', `refs/codex/pr-audit/${auditRef}/`]);
    assert.equal(afterRefOut, '');
  });

  it('cleanupAuditRefs removes stale refs and keeps active ones', async (t) => {
    const repo = initTestGitRepo();
    t.after(() => repo.cleanup());

    const activeRef = S.ref('pra');
    const staleRef = S.ref('pra');

    repo.run(['update-ref', `refs/codex/pr-audit/${activeRef}/head`, repo.headSha]);
    repo.run(['update-ref', `refs/codex/pr-audit/${staleRef}/head`, repo.headSha]);

    const github = {
      runCommand: async (cmd, args) => {
        try {
          const stdout = execFileSync(cmd, args, { cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return { ok: true, stdout };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    };

    await cleanupAuditRefs(github, repo.dir, new Set([activeRef]));

    const refs = repo.run(['for-each-ref', '--format=%(refname)', 'refs/codex/pr-audit/']);
    assert.match(refs, new RegExp(activeRef));
    assert.doesNotMatch(refs, new RegExp(staleRef));
  });
});
