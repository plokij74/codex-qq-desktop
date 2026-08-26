'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager } = require('../src/ai/worktree');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-pr-life-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'codex@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Codex Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

function fakeGithub(overrides = {}) {
  const pr = {
    number: 7,
    url: 'https://github.com/acme/widget/pull/7',
    title: 'Initial',
    body: 'Body',
    state: 'OPEN',
    isDraft: true,
    author: 'alice',
    headRefName: 'feature',
    baseRefName: 'main',
    headSha: 'a'.repeat(40),
    updatedAt: '2026-08-19T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    comments: [],
    files: [{ path: 'a.txt', additions: 1, deletions: 1 }],
  };
  const calls = [];
  const cli = {
    repository: async () => ({ ok: true, remote: { host: 'github.com', owner: 'acme', repo: 'widget' }, base: 'main', nameWithOwner: 'acme/widget' }),
    listPrs: async () => ({ ok: true, prs: [{ ...pr }], truncated: false, state: 'open' }),
    getPr: async () => ({ ok: true, pr: { ...pr, comments: pr.comments.map((item) => ({ ...item })), files: pr.files.map((item) => ({ ...item })) } }),
    getChecks: async () => ({ ok: true, checks: [{ name: 'test', state: 'SUCCESS', bucket: 'PASS', link: '' }], summary: { total: 1, passed: 1, pending: 0, failed: 0, skipped: 0, unknown: 0 } }),
    editPr: async (args) => { calls.push(['edit', args]); pr.title = args.title; pr.body = args.body; return { ok: true }; },
    commentPr: async (args) => { calls.push(['comment', args]); pr.comments.push({ id: 'c1', author: 'me', body: args.body, createdAt: 'now', url: '' }); return { ok: true }; },
    closePr: async (args) => { calls.push(['close', args]); pr.state = 'CLOSED'; return { ok: true }; },
    reopenPr: async (args) => { calls.push(['reopen', args]); pr.state = 'OPEN'; return { ok: true }; },
    readyPr: async (args) => { calls.push(['ready', args]); pr.isDraft = false; return { ok: true }; },
    mergePr: async (args) => { calls.push(['merge', args]); pr.state = 'MERGED'; return { ok: true }; },
    ...overrides,
  };
  return { cli, pr, calls };
}

describe('D7 GitHub PR lifecycle manager', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists, edits, comments, closes, reopens, readies, and squash-merges the current origin PR', async () => {
    const root = makeRepo(); roots.push(root);
    const fake = fakeGithub();
    const manager = createWorktreeManager({ githubCli: fake.cli });
    const listed = await manager.listPrs({ projectPath: root, state: 'open' });
    assert.equal(listed.ok, true);
    assert.equal(listed.repo.nameWithOwner, 'acme/widget');
    assert.equal(listed.prs[0].number, 7);
    const detail = await manager.getPr({ projectPath: root, number: 7 });
    assert.equal(detail.ok, true);
    assert.equal(detail.pr.checksSummary.passed, 1);
    assert.equal((await manager.editPr({ projectPath: root, number: 7, title: 'Updated', body: 'New body' })).pr.title, 'Updated');
    assert.equal((await manager.commentPr({ projectPath: root, number: 7, body: 'Ship it' })).commentPosted, true);
    assert.equal((await manager.closePr({ projectPath: root, number: 7 })).pr.state, 'CLOSED');
    assert.equal((await manager.reopenPr({ projectPath: root, number: 7 })).pr.state, 'OPEN');
    assert.equal((await manager.readyPr({ projectPath: root, number: 7 })).pr.isDraft, false);
    const merged = await manager.mergePr({ projectPath: root, number: 7, method: 'squash' });
    assert.equal(merged.ok, true, merged.error);
    assert.equal(merged.pr.state, 'MERGED');
    const mergeCall = fake.calls.find(([name]) => name === 'merge')[1];
    assert.equal(mergeCall.method, 'squash');
    assert.equal(mergeCall.headSha, 'a'.repeat(40));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  });

  it('blocks merge when checks are absent, pending, or the PR is not mergeable', async () => {
    const root = makeRepo(); roots.push(root);
    let mergeCalls = 0;
    const fake = fakeGithub({
      getChecks: async () => ({ ok: true, checks: [], summary: { total: 0, passed: 0, pending: 0, failed: 0, skipped: 0, unknown: 0 } }),
      mergePr: async () => { mergeCalls += 1; return { ok: true }; },
    });
    fake.pr.isDraft = false;
    const manager = createWorktreeManager({ githubCli: fake.cli });
    assert.equal((await manager.mergePr({ projectPath: root, number: 7, method: 'squash' })).code, 'PR_NO_CHECKS');
    fake.cli.getChecks = async () => ({ ok: true, checks: [{ name: 'test' }], summary: { total: 1, passed: 0, pending: 1, failed: 0, skipped: 0, unknown: 0 } });
    assert.equal((await manager.mergePr({ projectPath: root, number: 7, method: 'squash' })).code, 'PR_CHECKS_FAILED');
    fake.cli.getChecks = async () => ({ ok: true, checks: [{ name: 'test' }], summary: { total: 1, passed: 1, pending: 0, failed: 0, skipped: 0, unknown: 0 } });
    fake.pr.mergeable = 'CONFLICTING';
    assert.equal((await manager.mergePr({ projectPath: root, number: 7, method: 'squash' })).code, 'PR_MERGE_BLOCKED');
    assert.equal(mergeCalls, 0);
  });

  it('accepts timed-out edits and closes when refresh proves the postcondition', async () => {
    const root = makeRepo(); roots.push(root);
    const fake = fakeGithub({
      editPr: async (args) => {
        fake.pr.title = args.title;
        fake.pr.body = args.body;
        return { ok: false, code: 'PR_ACTION_FAILED', error: 'timeout', uncertain: true };
      },
      closePr: async () => {
        fake.pr.state = 'CLOSED';
        return { ok: false, code: 'PR_ACTION_FAILED', error: 'timeout', uncertain: true };
      },
    });
    const manager = createWorktreeManager({ githubCli: fake.cli });
    const edited = await manager.editPr({ projectPath: root, number: 7, title: 'Recovered', body: 'Updated body' });
    assert.equal(edited.ok, true, edited.error);
    assert.equal(edited.recoveredAfterUncertain, true);
    assert.equal(edited.pr.title, 'Recovered');
    const closed = await manager.closePr({ projectPath: root, number: 7 });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.recoveredAfterUncertain, true);
    assert.equal(closed.pr.state, 'CLOSED');
  });

  it('returns PR_ACTION_UNCERTAIN for a timed-out comment even after refresh succeeds', async () => {
    const root = makeRepo(); roots.push(root);
    const fake = fakeGithub({
      commentPr: async (args) => {
        fake.pr.comments.push({ id: 'c1', author: 'me', body: args.body, createdAt: 'now', url: '' });
        return { ok: false, code: 'PR_ACTION_FAILED', error: 'timeout', uncertain: true };
      },
    });
    const manager = createWorktreeManager({ githubCli: fake.cli });
    const commented = await manager.commentPr({ projectPath: root, number: 7, body: 'May have posted' });
    assert.equal(commented.ok, false);
    assert.equal(commented.code, 'PR_ACTION_UNCERTAIN');
    assert.equal(commented.pr.comments.length, 1);
  });
});
