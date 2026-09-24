'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeThread } = require('../src/ai/pr-review-state');
const { fixture, HEAD, thread, comment, deferred } = require('./helpers/pr-review-fixture');

describe('D16 review source and location', () => {
  it('accepts Draft and a current RIGHT anchor even when the root comment commit is old', async (t) => {
    const f = fixture(t);
    f.state.threads[0].comments.nodes[0].commit = { oid: 'b'.repeat(40) };
    const selected = await f.read();
    assert.equal(selected.canRepair, true);
    const saved = await f.manager.snapshot(f.root, selected.threadRef, selected.revision);
    const again = await f.snapshot();
    assert.equal(saved.reviewRef, again.reviewRef);
    const source = await f.manager.materializeRepairSource(f.root, saved.reviewRef);
    assert.match(source.reviewText, /Handle an empty input/);
    const made = await source.createWorktree({ project: { path: f.root } });
    assert.equal(made.ok, true);
    assert.equal(f.worktrees[0].baseHead, HEAD);
    assert.deepEqual(f.worktrees[0].origin, { kind: 'pr_review', reviewRef: saved.reviewRef });
    assert.equal(f.worktrees[0].delivery, 'github_pr_update');
    assert.match(f.calls.find(([name]) => name === 'fetch')[1].targetRef, /^refs\/codex\/pr-review\/prv_/);
    assert.equal(f.calls.filter(([name]) => name === 'delete-ref').length, 1);
    assert.doesNotMatch(JSON.stringify(f.manager.store.list()), /Handle an empty|comments|body|reviewText/);
  });
  it('bounds list pagination to 200 and excludes discussion bodies from list payloads', async (t) => {
    const f = fixture(t, { threads: Array.from({ length: 205 }, (_, i) => thread({ id: `THREAD_${i}` })) });
    const list = await f.manager.threads(f.root, 7);
    assert.equal(list.ok, true); assert.equal(list.threads.length, 200); assert.equal(list.total, 205); assert.equal(list.truncated, true);
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 3); // 2 pages + final head check
    assert.doesNotMatch(JSON.stringify(list), /Handle an empty|THREAD_|headRefName/);
    f.state.threads.length = 200;
    assert.equal((await f.manager.threads(f.root, 7)).truncated, false);
  });
  it('fails closed for duplicate pages, missing page metadata and head changes during paging', async (t) => {
    const f = fixture(t, { threads: Array.from({ length: 105 }, (_, i) => thread({ id: `THREAD_${i}` })) });
    const original = f.github.getReviewThreads;
    for (const change of [
      (out, args) => { if (args.after) out.pr.reviewThreads.nodes[0].id = 'THREAD_0'; },
      (out) => { delete out.pr.reviewThreads.pageInfo.hasNextPage; },
      (out, args) => { if (args.after) out.pr.headSha = 'b'.repeat(40); },
      (out) => { out.pr.reviewThreads.pageInfo.endCursor = ''; },
    ]) {
      f.github.getReviewThreads = async (args) => { const out = await original(args); change(out, args); return out; };
      assert.equal((await f.manager.threads(f.root, 7)).ok, false);
    }
  });
  it('rejects closed, fork and different repository PRs; thread IDs cannot redirect authority', async (t) => {
    const f = fixture(t); const selected = await f.read(); const original = structuredClone(f.state.pr);
    for (const [patch, code] of [
      [{ state: 'CLOSED' }, 'PR_REVIEW_PR_NOT_OPEN'], [{ isCrossRepository: true }, 'PR_REVIEW_FORK_UNSUPPORTED'],
      [{ headRepository: null }, 'PR_REVIEW_FORK_UNSUPPORTED'], [{ repository: { nameWithOwner: 'other/widget' } }, 'PR_REVIEW_NOT_FOUND'],
      [{ number: 8 }, 'PR_REVIEW_NOT_FOUND'],
    ]) {
      f.state.pr = { ...original, ...patch };
      assert.equal((await f.manager.get(f.root, selected.threadRef)).code, code);
    }
    f.state.pr = original;
    assert.equal((await f.manager.get(f.root, 'THREAD_1')).code, 'PR_REVIEW_NOT_FOUND');
    f.state.remote.host = 'other.example.test';
    assert.equal((await f.manager.get(f.root, selected.threadRef)).code, 'PR_REVIEW_CHANGED');
  });
  it('allows FILE anchors and manual discussion on outdated, LEFT or missing files', async (t) => {
    const f = fixture(t);
    for (const patch of [{ isOutdated: true }, { diffSide: 'LEFT' }, { line: null }, { path: '../escape.js' }, { startLine: 1, startDiffSide: 'LEFT' }, { line: 21 }]) {
      f.state.threads = [thread(patch)];
      const selected = await f.read();
      assert.equal(selected.canRepair, false); assert.equal(selected.canReply, true); assert.equal(selected.canResolve, true);
      assert.equal((await f.manager.snapshot(f.root, selected.threadRef, selected.revision)).ok, false);
    }
    f.state.threads = [thread({ subjectType: 'FILE', line: null })];
    assert.equal((await f.read()).canRepair, true);
    f.state.file = { ok: false };
    const missing = await f.read();
    assert.equal(missing.reasonCode, 'PR_REVIEW_LOCATION_UNAVAILABLE');
    assert.equal((await f.manager.reply(f.root, { threadRef: missing.threadRef, revision: missing.revision, body: 'Please restore the file.' }, { gate: f.gate })).ok, true);
  });
  it('restricts repair to a bound subdirectory and scopes refs to their bound project', async (t) => {
    const f = fixture(t); const subdir = path.join(f.root, 'src'); fs.mkdirSync(subdir);
    const sub = await f.read(subdir); assert.equal(sub.canRepair, true);
    assert.equal((await f.manager.get(f.root, sub.threadRef)).code, 'PR_REVIEW_NOT_FOUND');
    f.state.threads[0].path = 'sibling/app.js';
    assert.equal((await f.read(subdir)).canRepair, false);
  });
  it('keeps oversized discussions viewable and refuses writes or repair for incomplete details', async (t) => {
    const f = fixture(t);
    f.state.threads[0].comments = { nodes: Array.from({ length: 50 }, (_, i) => comment(`C_${i}`)), totalCount: 51, pageInfo: { hasNextPage: true } };
    const selected = await f.read();
    assert.equal(selected.comments.length, 50); assert.equal(selected.complete, false);
    assert.deepEqual([selected.canRepair, selected.canReply, selected.canResolve], [false, false, false]);
    assert.equal((await f.manager.reply(f.root, { threadRef: selected.threadRef, revision: selected.revision, body: 'reply' }, { gate: f.gate })).code, 'PR_REVIEW_INCOMPLETE');
    assert.equal(f.approvals.length, 0);
    f.state.threads = [thread({ comments: { nodes: [comment('C_1', '中'.repeat(12000))], totalCount: 1, pageInfo: { hasNextPage: false } } })];
    const saved = await f.snapshot(); assert.equal(saved.ok, true);
    await assert.rejects(f.manager.materializeRepairSource(f.root, saved.reviewRef), { code: 'PR_REVIEW_CONTEXT_TOO_LARGE' });
  });
  it('respects platform path casing for a mixed-case bound directory without admitting its siblings', async (t) => {
    const f = fixture(t); const subdir = path.join(f.root, 'Packages', 'App'); fs.mkdirSync(subdir, { recursive: true });
    f.state.threads[0].path = 'Packages/App/src/app.js';
    const selected = await f.read(subdir);
    assert.equal(selected.canRepair, true);
    assert.equal(f.calls.filter(([name]) => name === 'file').at(-1)[1].path, 'Packages/App/src/app.js');
    for (const outside of ['Packages/AppSibling/src/app.js', 'Packages/Other/src/app.js']) {
      f.state.threads[0].path = outside;
      const thread = await f.read(subdir);
      assert.equal(thread.canRepair, false); assert.equal(thread.canReply, true);
    }
  });
  it('fingerprints the original body before redaction and hides pending comments from public discussion', () => {
    const before = thread({ comments: { totalCount: 2, nodes: [comment('C1', 'token=secret-one'), comment('C2', 'private draft', { state: 'PENDING' })], pageInfo: { hasNextPage: false } } });
    const after = structuredClone(before); after.comments.nodes[0].body = 'token=secret-two';
    assert.notEqual(normalizeThread(before, true).fingerprint, normalizeThread(after, true).fingerprint);
  });
  it('invalidates frozen sources on edits, replies, resolution, position and head changes', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const original = structuredClone(f.state.threads[0]);
    const changes = [
      (value) => { value.comments.nodes[0].body += ' changed'; },
      (value) => { value.comments.nodes.push(comment('C2')); value.comments.totalCount++; },
      (value) => { value.isResolved = true; }, (value) => { value.isOutdated = true; },
      (value) => { value.line = 3; }, (value) => { value.path = 'src/other.js'; },
    ];
    for (const change of changes) {
      f.state.threads[0] = structuredClone(original); change(f.state.threads[0]);
      await assert.rejects(f.manager.resolveMetadata(f.root, saved.reviewRef), { code: 'PR_REVIEW_CHANGED' });
    }
    f.state.threads[0] = original; f.state.pr.headSha = 'b'.repeat(40);
    await assert.rejects(f.manager.resolveMetadata(f.root, saved.reviewRef), { code: 'PR_REVIEW_CHANGED' });
    const navigation = await f.manager.source(f.root, saved.reviewRef);
    assert.equal(navigation.ok, true);
    const current = (await f.manager.get(f.root, navigation.threadRef)).thread;
    assert.equal(current.headSha, f.state.pr.headSha);
    assert.equal((await f.manager.resolve(f.root, { threadRef: current.threadRef, revision: current.revision }, { gate: f.gate })).ok, true);
  });
  it('rechecks discussion after fetch, cleans its temporary ref, and never creates a stale worktree', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const source = await f.manager.materializeRepairSource(f.root, saved.reviewRef);
    f.github.fetchBranchToRef = async () => { f.state.threads[0].comments.nodes[0].body += ' changed'; return { ok: true }; };
    await assert.rejects(source.createWorktree({ project: { path: f.root } }), { code: 'PR_REVIEW_CHANGED' });
    assert.equal(f.worktrees.length, 0); assert.equal(f.calls.filter(([name]) => name === 'delete-ref').length, 1);
  });
});

describe('D16 independent, confirmed remote thread actions', () => {
  it('replies and resolves without a repair, each using its own approval and fresh revision', async (t) => {
    const f = fixture(t); const selected = await f.read();
    const payload = { threadRef: selected.threadRef, revision: selected.revision, body: 'Thanks, I will follow up.' };
    assert.equal((await f.manager.reply(f.root, payload)).code, 'PR_REVIEW_CONFIRM_REQUIRED');
    assert.equal((await f.manager.reply(f.root, payload, { gate: f.gate })).ok, true);
    assert.equal((await f.manager.resolve(f.root, payload, { gate: f.gate })).code, 'PR_REVIEW_CHANGED');
    const fresh = (await f.manager.get(f.root, selected.threadRef)).thread;
    assert.equal((await f.manager.resolve(f.root, { ...payload, revision: fresh.revision }, { gate: f.gate })).ok, true);
    assert.deepEqual(f.approvals.map((a) => [a.tool, a.risk, a.source]), [['pr_review_reply', 'remote-mutation', 'pr-review'], ['pr_review_resolve', 'remote-mutation', 'pr-review']]);
    assert.equal(f.manager.store.list().length, 0); assert.equal(f.worktrees.length, 0);
  });
  it('rejects stale approval and duplicate pending action; respects revoked permissions', async (t) => {
    const f = fixture(t); const selected = await f.read(); const waiting = deferred(); const entered = deferred();
    const context = { gate: { authorize: () => { entered.resolve(); return waiting.promise; } } };
    const payload = { threadRef: selected.threadRef, revision: selected.revision, body: 'reply' };
    const first = f.manager.reply(f.root, payload, context); await entered.promise;
    assert.equal((await f.manager.resolve(f.root, payload, context)).code, 'PR_REVIEW_BUSY');
    f.state.threads[0].viewerCanReply = false; waiting.resolve({ allowed: true });
    assert.equal((await first).code, 'PR_REVIEW_CHANGED');
    assert.equal(f.calls.filter(([name]) => name === 'reply').length, 0);
  });
  it('revalidates after entering the global mutation lock and after location reads', async (t) => {
    const f = fixture(t, { mutationLock: async (action) => { f.state.pr.headSha = 'b'.repeat(40); return action(); } });
    const selected = await f.read();
    assert.equal((await f.manager.reply(f.root, { threadRef: selected.threadRef, revision: selected.revision, body: 'reply' }, { gate: f.gate })).code, 'PR_REVIEW_CHANGED');
    assert.equal(f.calls.filter(([name]) => name === 'reply').length, 0);
    f.github.getReviewFile = async () => { f.state.threads[0].line = 4; return { ok: true, lineCount: 20 }; };
    assert.equal((await f.manager.get(f.root, selected.threadRef)).code, 'PR_REVIEW_CHANGED');
  });
  it('keeps uncertain replies from being resent even after a fresh read', async (t) => {
    const f = fixture(t); const selected = await f.read(); const post = f.github.replyReviewThread;
    f.github.replyReviewThread = async (args) => { await post(args); return { ok: false, code: 'PR_REVIEW_ACTION_UNCERTAIN' }; };
    const payload = { threadRef: selected.threadRef, revision: selected.revision, body: 'single reply' };
    assert.equal((await f.manager.reply(f.root, payload, { gate: f.gate })).code, 'PR_REVIEW_ACTION_UNCERTAIN');
    const fresh = (await f.manager.get(f.root, selected.threadRef)).thread;
    assert.equal(fresh.comments.at(-1).body, payload.body);
    assert.equal((await f.manager.reply(f.root, { ...payload, revision: fresh.revision }, { gate: f.gate })).code, 'PR_REVIEW_ACTION_UNCERTAIN');
    assert.equal(f.calls.filter(([name]) => name === 'reply').length, 1);
  });
  it('does not call a mutation success when reconciliation finds a concurrent edit or a different reply', async (t) => {
    const f = fixture(t); const selected = await f.read(); const post = f.github.replyReviewThread;
    f.github.replyReviewThread = async (args) => { const result = await post(args); f.state.threads[0].comments.nodes[0].body += ' changed'; return result; };
    assert.equal((await f.manager.reply(f.root, { threadRef: selected.threadRef, revision: selected.revision, body: 'reply' }, { gate: f.gate })).code, 'PR_REVIEW_ACTION_UNCERTAIN');
    const fresh = await f.read();
    f.github.resolveReviewThread = async () => { throw new Error('private server message'); };
    const out = await f.manager.resolve(f.root, { threadRef: fresh.threadRef, revision: fresh.revision }, { gate: f.gate });
    assert.equal(out.code, 'PR_REVIEW_ACTION_UNCERTAIN'); assert.doesNotMatch(JSON.stringify(out), /private/);
  });
  it('blocks invalid reply lengths before approval and aborts before dispatch on binding loss', async (t) => {
    const f = fixture(t); const selected = await f.read(); const payload = { threadRef: selected.threadRef, revision: selected.revision };
    for (const body of ['', '   ', 'a'.repeat(5001), 'a\0b']) assert.equal((await f.manager.reply(f.root, { ...payload, body }, { gate: f.gate })).code, 'PR_REVIEW_INVALID');
    assert.equal(f.approvals.length, 0);
    let current = true;
    const result = await f.manager.reply(f.root, { ...payload, body: 'reply' }, { isCurrent: () => current, gate: { authorize: async () => { current = false; return { allowed: true }; } } });
    assert.equal(result.code, 'PR_REVIEW_PROJECT_BINDING_INVALID');
    assert.equal(f.calls.filter(([name]) => name === 'reply').length, 0);
  });
});
