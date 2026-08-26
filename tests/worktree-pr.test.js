'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager } = require('../src/ai/worktree');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-pr-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  git(root, ['config', 'user.email', 'codex@example.test']);
  git(root, ['config', 'user.name', 'Codex Test']);
  fs.writeFileSync(path.join(root, 'app', 'a.txt'), 'one\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

describe('D6 worktree Draft PR lifecycle', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('retries after push without pushing twice and leaves the main tree unchanged', async () => {
    const root = makeRepo(); roots.push(root);
    const baseHead = git(root, ['rev-parse', 'HEAD']);
    let pushes = 0;
    let creates = 0;
    const githubCli = {
      preflight: async () => ({ ok: true, remote: { host: 'github.com', owner: 'acme', repo: 'widget' }, base: 'main', remoteHead: baseHead }),
      pushBranch: async ({ source, branch }) => {
        pushes += 1;
        assert.match(source, /^[a-f0-9]{40}$/);
        assert.match(branch, /^codex\/wt_/);
        return { ok: true };
      },
      findExistingPr: async () => ({ ok: true, pr: null, count: 0 }),
      createPr: async () => {
        creates += 1;
        if (creates === 1) return { ok: false, code: 'PR_CREATE_FAILED', error: 'temporary failure' };
        return { ok: true, pr: { number: 7, url: 'https://github.com/acme/widget/pull/7', isDraft: true } };
      },
      repository: async () => ({ ok: true, remote: { host: 'github.com', owner: 'acme', repo: 'widget' }, base: 'main', nameWithOwner: 'acme/widget' }),
      getPr: async () => ({ ok: true, pr: {
        number: 7, url: 'https://github.com/acme/widget/pull/7', title: 'fix: update a', body: 'Summary',
        state: 'OPEN', isDraft: true, author: 'codex', headRefName: 'codex/test', baseRefName: 'main',
        headSha: 'b'.repeat(40), updatedAt: '2026-08-19T00:00:00Z', mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN', comments: [], files: [],
      } }),
      getChecks: async () => ({ ok: true, checks: [{ name: 'test', bucket: 'PASS', state: 'SUCCESS' }], summary: { total: 1, passed: 1, pending: 0, failed: 0, skipped: 0, unknown: 0 } }),
    };
    const manager = createWorktreeManager({ githubCli });
    const created = await manager.create({ project: { path: path.join(root, 'app') }, goal: 'Update a.txt' });
    assert.equal(created.ok, true, created.error);
    fs.writeFileSync(path.join(created.handle.childProjectPath, 'a.txt'), 'two\n');
    const collected = await manager.collect(created.handle);
    assert.equal(collected.ok, true, collected.error);

    const first = await manager.createPr({ projectPath: path.join(root, 'app'), resultId: created.handle.id, title: 'fix: update a', body: 'Summary', draft: true });
    assert.equal(first.ok, false);
    assert.equal(first.result.state, 'pr_failed');
    assert.equal(first.result.pr.pushed, true);
    assert.equal(pushes, 1);

    const retried = await manager.retryPr({ projectPath: path.join(root, 'app'), resultId: created.handle.id, title: 'fix: update a', body: 'Summary', draft: true });
    assert.equal(retried.ok, true, retried.error);
    assert.equal(retried.result.state, 'pr_created');
    assert.equal(retried.result.pr.url, 'https://github.com/acme/widget/pull/7');
    assert.equal(pushes, 1);
    assert.equal(creates, 2);
    assert.equal(fs.existsSync(created.handle.checkout), false);
    assert.equal(fs.existsSync(path.join(created.handle.resultRoot, 'result.patch')), false);
    assert.equal(git(root, ['branch', '--list', `codex/${created.handle.id}`]), '');
    assert.equal(git(root, ['rev-parse', 'HEAD']), baseHead);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'a.txt'), 'utf8'), 'one\n');
    assert.equal(git(root, ['status', '--porcelain']), '');

    const refreshed = await manager.getPr({ projectPath: path.join(root, 'app'), resultId: created.handle.id });
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.equal(refreshed.result.pr.state, 'OPEN');
    assert.equal(refreshed.result.pr.checksSummary.passed, 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(created.handle.resultRoot, 'meta.json'), 'utf8'));
    assert.equal(persisted.pr.state, 'OPEN');
    assert.equal('body' in persisted.pr, false);
    assert.equal('comments' in persisted.pr, false);
  });
});
