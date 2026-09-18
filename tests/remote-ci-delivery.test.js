'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager } = require('../src/ai/worktree');
const { createRemoteCiManager } = require('../src/ai/remote-ci-manager');
const { createRemoteCiStore } = require('../src/ai/remote-ci-store');
const { repositoryKey } = require('../src/ai/remote-ci-state');
const { projectKey } = require('../src/ai/project-index');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

it('D14 delivers an exact remote-base child commit and recovers a push that succeeded before timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d14-delivery-'));
  try {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'CI Test']);
    git(root, ['config', 'user.email', 'ci@example.test']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
    const remoteHead = git(root, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, 'local.txt'), 'local\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'local']);
    const localHead = git(root, ['rev-parse', 'HEAD']);
    const beforeRefs = git(root, ['show-ref']);
    const ref = 'rci_' + '1'.repeat(24);
    const wt = createWorktreeManager();
    const created = await wt.createAtCommit({ project: { path: root }, baseHead: remoteHead, origin: { kind: 'remote_ci', remoteCiRef: ref }, delivery: 'github_pr_update', goal: 'fix' });
    assert.equal(created.ok, true, created.error);
    assert.equal(git(created.handle.checkout, ['rev-parse', 'HEAD']), remoteHead);
    fs.writeFileSync(path.join(created.handle.checkout, 'a.txt'), 'fixed\n');
    const collected = await wt.collect(created.handle);
    assert.equal(collected.ok, true, collected.error);
    const shown = await wt.get({ projectPath: root, resultId: created.handle.id, preview: true });
    assert.equal(shown.result.canApply, false);
    assert.equal(shown.result.canCreatePr, false);
    assert.match(shown.preview, /fixed/);
    const store = createRemoteCiStore();
    store.put({ remoteCiRef: ref, projectKey: projectKey(root), repoKey: repositoryKey('github.com', 'acme/widget'), prNumber: 7,
      headSha: remoteHead, headRefName: 'feature', checkRunId: '101', runId: '201', jobId: '301', runAttempt: 1,
      workflowName: 'CI', jobName: 'test', conclusion: 'failure' });
    let head = remoteHead;
    let pushes = 0;
    const github = {
      repository: async () => ({ ok: true, remote: { host: 'github.com', owner: 'acme', repo: 'widget' }, nameWithOwner: 'acme/widget' }),
      getPr: async () => ({ ok: true, pr: { state: 'OPEN', isCrossRepository: false, headRepository: 'acme/widget', headSha: head, headRefName: 'feature' } }),
      branchTip: async () => ({ ok: true, head }),
      exactLeasePush: async (input) => { assert.equal(input.oldHead, remoteHead); pushes++; head = input.newCommit; return { ok: false, uncertain: true }; },
    };
    const manager = createRemoteCiManager({ store, github, worktree: wt, resolveRepo: () => root });
    manager.resolveMetadata = async () => ({});
    const gate = { authorize: async () => ({ allowed: true }) };
    const first = await manager.updatePr(root, created.handle.id, 'Fix CI', { gate });
    assert.equal(first.code, 'PR_UPDATE_UNCERTAIN');
    const persisted = JSON.parse(fs.readFileSync(path.join(created.handle.resultRoot, 'meta.json'), 'utf8'));
    assert.equal(persisted.prUpdate.newCommit, head);
    assert.equal(git(root, ['rev-list', '--parents', '-n', '1', head]), `${head} ${remoteHead}`);
    assert.equal(git(root, ['rev-parse', `${head}^{tree}`]), persisted.expectedTree);
    await wt.recover({ projectPath: root });
    const retry = await manager.updatePr(root, created.handle.id, 'changed subject', { gate });
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.result.state, 'pr_updated');
    assert.equal(retry.result.prUpdate.subject, 'Fix CI');
    assert.equal(pushes, 1);
    assert.equal(git(root, ['rev-parse', 'HEAD']), localHead);
    assert.equal(git(root, ['show-ref']), beforeRefs);
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'base\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
