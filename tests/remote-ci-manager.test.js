'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRemoteCiManager } = require('../src/ai/remote-ci-manager');
const { createRemoteCiStore } = require('../src/ai/remote-ci-store');

const head = 'a'.repeat(40);

function fakeGithub(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    repository: async () => ({ ok: true, remote: { host: 'github.com', owner: 'acme', repo: 'widget' }, nameWithOwner: 'acme/widget', base: 'main' }),
    getPr: async () => ({ ok: true, pr: { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'OPEN', isCrossRepository: false, headRepository: 'acme/widget', headRefName: 'feature/fix', headSha: head } }),
    getCheckRunsForRef: async () => ({ ok: true, checks: [{ id: '101', name: 'tests', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/widget/actions/runs/201/job/301', appSlug: 'github-actions', completedAt: '2026-09-16T01:00:00.000Z', annotationCount: 1 }] }),
    getCheckRunContent: async () => { calls.push('content'); return { ok: true, check: { id: '101', name: 'tests', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/widget/actions/runs/201/job/301', appSlug: 'github-actions', annotationCount: 1, output: { title: 'failed', summary: '' } } }; },
    getActionsJob: async () => ({ ok: true, job: { id: '301', runId: '201', headSha: head, runAttempt: 2, workflowName: 'CI', name: 'tests', status: 'completed', conclusion: 'failure', completedAt: '2026-09-16T01:00:00.000Z', logsAvailable: true, steps: [{ name: 'run tests', conclusion: 'failure' }] } }),
    getActionsRun: async () => ({ ok: true, run: { id: '201', name: 'CI', headSha: head, runAttempt: 2, status: 'completed', conclusion: 'failure' } }),
    getCheckAnnotations: async () => { calls.push('annotations'); return { ok: true, annotations: [{ path: 'src/app.js', start_line: 4, annotation_level: 'failure', title: 'test', message: 'expected true' }], truncated: false }; },
    getActionsJobLog: async () => { calls.push('log'); return { ok: true, log: 'private log' }; },
    fetchBranchToRef: async () => ({ ok: true }),
    resolveCommit: async () => ({ ok: true, head }),
    deleteInternalRef: async () => ({ ok: true }),
    rerunActionsJob: async () => ({ ok: true }),
    ...overrides,
  };
  return api;
}

function fixture(github = fakeGithub()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rci-manager-'));
  const store = createRemoteCiStore({ safeStorage: null });
  const worktrees = [];
  const manager = createRemoteCiManager({
    githubCli: github,
    store,
    projectKey: () => 'a'.repeat(32),
    resolveRepo: () => ({ repoRoot: root }),
    worktreeManager: { createAtCommit: async (input) => { worktrees.push(input); return { ok: true, handle: { id: 'wt_remote1', childProjectPath: root, baseHead: input.baseHead } }; } },
    now: () => Date.parse('2026-09-16T02:00:00.000Z'),
  });
  return { root, store, github, worktrees, manager, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('D14 remote CI manager', () => {
  it('rejects missing same-repository proof, mismatched job names, and changed check content', async () => {
    const f = fixture();
    try {
      const original = f.github.getPr;
      f.github.getPr = async () => { const out = await original(); delete out.pr.headRepository; return out; };
      assert.equal((await f.manager.snapshot(f.root, 7, '101')).code, 'REMOTE_CI_FORK_UNSUPPORTED');
      f.github.getPr = original;
      const created = await f.manager.snapshot(f.root, 7, '101');
      const content = f.github.getCheckRunContent;
      f.github.getCheckRunContent = async () => { const out = await content(); out.check.id = '102'; return out; };
      await assert.rejects(f.manager.materializeRepairSource(f.root, created.remoteCiRef), { code: 'REMOTE_CI_CHECK_NOT_FOUND' });
      const job = f.github.getActionsJob;
      f.github.getActionsJob = async () => { const out = await job(); out.job.name = 'unrelated'; return out; };
      assert.equal((await f.manager.snapshot(f.root, 7, '101')).code, 'REMOTE_CI_CHECK_NOT_FOUND');
    } finally { f.cleanup(); }
  });

  it('redacts secrets from bounded context and does not fetch when the local preflight fails', async () => {
    const f = fixture(fakeGithub({ getCheckAnnotations: async () => ({ ok: true, annotations: [] }),
      getActionsJobLog: async () => ({ ok: true, log: '\u001b[31mghp_abcdefgh1234567890\nhttps://logs.example/job?sig=private\nfailed assertion\u001b[0m' }) }));
    try {
      const created = await f.manager.snapshot(f.root, 7, '101');
      const source = await f.manager.materializeRepairSource(f.root, created.remoteCiRef);
      assert.doesNotMatch(source.result.stdout, /ghp_|sig=|\u001b|private/);
      assert.match(source.result.stdout, /failed assertion/);
      let fetches = 0;
      f.github.fetchBranchToRef = async () => { fetches++; return { ok: true }; };
      f.manager.worktree.preflightRemoteCreate = async () => ({ ok: false, code: 'DIRTY_BASE' });
      assert.equal((await source.createWorktree({ project: { path: f.root } })).code, 'DIRTY_BASE');
      assert.equal(fetches, 0);
      assert.doesNotMatch(JSON.stringify(f.store.list()), /assertion|ghp_|private/);
    } finally { f.cleanup(); }
  });

  it('rechecks head after rerun confirmation and blocks a duplicate pending request', async () => {
    const f = fixture();
    try {
      const created = await f.manager.snapshot(f.root, 7, '101');
      let approve;
      let entered;
      const waiting = new Promise((resolve) => { entered = resolve; });
      const gate = { authorize: () => { entered(); return new Promise((resolve) => { approve = resolve; }); } };
      const request = f.manager.rerun(f.root, created.remoteCiRef, { gate });
      await waiting;
      assert.equal((await f.manager.rerun(f.root, created.remoteCiRef, { gate })).ok, false);
      const getPr = f.github.getPr;
      f.github.getPr = async () => { const out = await getPr(); out.pr.headSha = 'b'.repeat(40); return out; };
      let posts = 0;
      f.github.rerunActionsJob = async () => { posts++; return { ok: true }; };
      approve({ allowed: true });
      assert.equal((await request).code, 'REMOTE_CI_HEAD_CHANGED');
      assert.equal(posts, 0);
    } finally { f.cleanup(); }
  });
  it('creates an idempotent metadata-only snapshot and materializes bodies only after approval', async () => {
    const f = fixture();
    try {
      const first = await f.manager.snapshot(f.root, 7, '101');
      const second = await f.manager.snapshot(f.root, 7, '101');
      assert.equal(first.ok, true);
      assert.equal(second.remoteCiRef, first.remoteCiRef);
      assert.deepEqual(f.github.calls, []);

      const metadata = await f.manager.resolveMetadata(f.root, first.remoteCiRef);
      assert.equal(metadata.baseHead, head);
      assert.deepEqual(f.github.calls, []);

      const materialized = await f.manager.materializeRepairSource(f.root, first.remoteCiRef);
      assert.equal(materialized.result.diagnostics[0].path, 'src/app.js');
      assert.deepEqual(f.github.calls, ['content', 'annotations']);
      assert.equal(f.github.calls.includes('log'), false);
      const made = await materialized.createWorktree({ project: { path: f.root }, subagentId: 'rpr_x', goal: 'repair' });
      assert.equal(made.ok, true);
      assert.equal(f.worktrees[0].baseHead, head);
      assert.equal(f.worktrees[0].origin.remoteCiRef, first.remoteCiRef);
    } finally { f.cleanup(); }
  });

  it('fails closed for fork PRs, non-Actions checks, and stale attempts', async () => {
    const fork = fixture(fakeGithub({ getPr: async () => ({ ok: true, pr: { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'OPEN', isCrossRepository: true, headRepository: 'fork/widget', headRefName: 'feature', headSha: head } }) }));
    try { assert.equal((await fork.manager.snapshot(fork.root, 7, '101')).code, 'REMOTE_CI_FORK_UNSUPPORTED'); } finally { fork.cleanup(); }

    const app = fixture(fakeGithub({ getCheckRunsForRef: async () => ({ ok: true, checks: [{ id: '101', name: 'other', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/acme/widget/actions/runs/201/job/301', appSlug: 'circleci' }] }) }));
    try { assert.equal((await app.manager.snapshot(app.root, 7, '101')).code, 'REMOTE_CI_CHECK_UNSUPPORTED'); } finally { app.cleanup(); }

    const staleGithub = fakeGithub();
    const stale = fixture(staleGithub);
    try {
      const created = await stale.manager.snapshot(stale.root, 7, '101');
      staleGithub.getActionsRun = async () => ({ ok: true, run: { id: '201', name: 'CI', headSha: head, runAttempt: 3, status: 'completed', conclusion: 'failure' } });
      const got = await stale.manager.get(stale.root, created.remoteCiRef);
      assert.equal(got.snapshot.capability, 'stale');
      assert.equal(got.snapshot.reasonCode, 'REMOTE_CI_ATTEMPT_CHANGED');
    } finally { stale.cleanup(); }
  });

  it('requires a one-shot remote mutation approval before rerunning', async () => {
    const f = fixture();
    try {
      const created = await f.manager.snapshot(f.root, 7, '101');
      assert.equal((await f.manager.rerun(f.root, created.remoteCiRef)).code, 'REMOTE_CI_RERUN_CONFIRM_REQUIRED');
      let risk = '';
      const allowed = await f.manager.rerun(f.root, created.remoteCiRef, { gate: { authorize: async (input) => { risk = input.risk; return { allowed: true }; } } });
      assert.equal(allowed.ok, true);
      assert.equal(risk, 'remote-mutation');
    } finally { f.cleanup(); }
  });
});
