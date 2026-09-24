'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrReviewManager } = require('../../src/ai/pr-review-manager');

const HEAD = 'a'.repeat(40);
const DATE = '2026-09-24T02:00:00.000Z';
function comment(id = 'COMMENT_1', body = 'Handle an empty input before indexing it.', overrides = {}) {
  return { id, body, state: 'SUBMITTED', author: { login: 'reviewer' }, createdAt: DATE, updatedAt: DATE, ...overrides };
}
function thread(overrides = {}) {
  return { id: 'THREAD_1', path: 'src/app.js', subjectType: 'LINE', diffSide: 'RIGHT', startDiffSide: null,
    line: 2, startLine: null, isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true,
    comments: { totalCount: 1, nodes: [comment()], pageInfo: { hasNextPage: false, endCursor: null } }, ...overrides };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(read, predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('condition timed out');
}
function fixture(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d16-'));
  const calls = [];
  const state = {
    remote: { host: 'ghe.example.test', owner: 'acme', repo: 'widget' },
    pr: { number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headSha: HEAD, headRefName: 'feature/review',
      headRepository: { nameWithOwner: 'acme/widget' }, repository: { nameWithOwner: 'acme/widget' } },
    threads: options.threads || [thread()], file: { ok: true, lineCount: 20 },
  };
  const github = {
    repository: async () => ({ ok: true, remote: state.remote, nameWithOwner: `${state.remote.owner}/${state.remote.repo}`, base: 'main' }),
    getReviewThreads: async (args) => {
      calls.push(['list', args]);
      const start = Number(args.after || 0);
      const end = Math.min(start + 100, state.threads.length);
      return structuredClone({ ok: true, pr: { ...state.pr, reviewThreads: { totalCount: state.threads.length,
        nodes: state.threads.slice(start, end), pageInfo: { hasNextPage: end < state.threads.length, endCursor: String(end) } } } });
    },
    getReviewThread: async (args) => {
      calls.push(['get', args]);
      const value = state.threads.find((row) => row.id === args.threadId);
      return structuredClone({ ok: true, thread: value ? { ...value, pullRequest: state.pr } : null });
    },
    getReviewFile: async (args) => { calls.push(['file', args]); return structuredClone(state.file); },
    replyReviewThread: async (args) => {
      calls.push(['reply', args]);
      const value = state.threads.find((row) => row.id === args.threadId);
      const id = `COMMENT_${value.comments.totalCount + 1}`;
      value.comments.nodes.push(comment(id, args.body)); value.comments.totalCount++;
      return { ok: true, commentId: id };
    },
    resolveReviewThread: async (args) => { calls.push(['resolve', args]); state.threads.find((row) => row.id === args.threadId).isResolved = true; return { ok: true }; },
    fetchBranchToRef: async (args) => { calls.push(['fetch', args]); return { ok: true }; },
    resolveCommit: async () => ({ ok: true, head: state.pr.headSha }),
    deleteInternalRef: async (args) => { calls.push(['delete-ref', args]); return { ok: true }; },
    branchTip: async () => ({ ok: true, head: state.pr.headSha }),
  };
  const worktrees = [];
  const worktree = options.worktree || { createAtCommit: async (input) => { worktrees.push(input); return { ok: true, handle: { id: 'wt_review1', childProjectPath: root, baseHead: input.baseHead } }; } };
  const manager = createPrReviewManager({ github, worktree, store: options.store, resolveRepo: () => root, mutationLock: options.mutationLock });
  t.after(() => { manager.close(); if (!options.root) fs.rmSync(root, { recursive: true, force: true }); });
  async function read(projectPath = root, index = 0) {
    const list = await manager.threads(projectPath, 7);
    if (!list.ok) throw new Error(list.code);
    return (await manager.get(projectPath, list.threads[index].threadRef)).thread;
  }
  async function snapshot(projectPath = root, index = 0) {
    const selected = await read(projectPath, index);
    return manager.snapshot(projectPath, selected.threadRef, selected.revision);
  }
  const approvals = [];
  const gate = { authorize: async (input) => { approvals.push(input); return { allowed: true }; } };
  return { root, state, github, worktree, worktrees, manager, calls, gate, approvals, read, snapshot };
}
module.exports = { HEAD, DATE, comment, thread, deferred, flush, eventually, fixture };
