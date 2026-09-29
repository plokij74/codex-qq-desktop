'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrAuditManager } = require('../src/ai/pr-audit-manager');
const S = require('../src/ai/pr-audit-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-mgr-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const repoKey = 'a'.repeat(64);
  const headSha = 'b'.repeat(40);
  const baseSha = 'c'.repeat(40);
  const mergeBaseSha = 'd'.repeat(40);

  const pr = {
    number: 7,
    state: 'open',
    merged: false,
    title: 'Test PR',
    body: 'Test description',
    headSha,
    baseSha,
    headRefName: 'feature',
    baseRefName: 'main',
    headRepo: 'owner/repo',
    baseRepo: 'owner/repo',
    changedFiles: 1,
  };

  const files = [{
    filename: 'src/calc.js',
    status: 'modified',
    additions: 1,
    deletions: 0,
    sha: headSha,
    patch: '@@ -1,2 +1,3 @@\n 1\n+2\n 3\n',
  }];

  const reviewState = {
    reviews: [],
    comments: [],
  };

  const github = {
    getCiWatchRepository: async () => ({
      ok: true,
      repository: {
        host: 'github.com',
        owner: 'owner',
        repo: 'repo',
        nameWithOwner: 'owner/repo',
        repoKey,
        repoRoot: dir,
      },
    }),
    runCommand: async (cmd, args) => ({ ok: true, stdout: '' }),
    getAuditPr: async () => ({ ...pr }),
    getAuditFiles: async () => files,
    getAuditMergeBase: async () => mergeBaseSha,
    getAuditViewer: async () => ({ id: 42, login: 'test-reviewer' }),
    createAuditReview: async ({ payload }) => {
      const reviewId = 999;
      const review = {
        id: reviewId,
        user: { id: 42, login: 'test-reviewer' },
        state: 'COMMENTED',
        commit_id: payload.commit_id,
        body: payload.body,
        submitted_at: new Date().toISOString(),
      };
      reviewState.reviews.push(review);
      let cId = 1000;
      for (const c of payload.comments) {
        reviewState.comments.push({
          id: ++cId,
          pull_request_review_id: reviewId,
          user: { id: 42 },
          path: c.path,
          side: c.side,
          line: c.line,
          start_line: c.start_line,
          original_line: c.line,
          original_start_line: c.start_line,
          original_commit_id: payload.commit_id,
          body: c.body,
        });
      }
      return { id: reviewId, state: 'COMMENTED' };
    },
    getAuditReview: async ({ reviewId }) => reviewState.reviews.find((r) => r.id === reviewId),
    listAuditReviews: async () => reviewState.reviews,
    getAuditComments: async ({ reviewId }) => reviewState.comments.filter((c) => c.pull_request_review_id === reviewId),
  };

  const snapshotFactory = ({ source, auditRef }) => ({
    source,
    auditRef,
    coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] },
    files: [{
      path: 'src/calc.js',
      oldPath: 'src/calc.js',
      patch: '@@ -1,2 +1,3 @@\n 1\n+2\n 3\n',
      hunks: [{ leftStart: 1, leftCount: 2, rightStart: 1, rightCount: 3, changedLeft: [], changedRight: [2] }],
    }],
    init: async () => {},
    cleanup: async () => {},
    read: async () => ({ path: 'src/calc.js', side: 'RIGHT', content: '1: 1\n2: 2\n3: 3', sha: headSha }),
  });

  const runtime = async () => ({
    report: {
      summary: '审查通过，发现 1 项问题。',
      findings: [{
        priority: 'P1',
        title: '除以零',
        body: '可能发生除以零。',
        path: 'src/calc.js',
        side: 'RIGHT',
        line: 2,
        startLine: 2,
      }],
    },
    turns: 1,
    usage: { inputTokens: 100, outputTokens: 50 },
  });

  const events = [];
  const manager = createPrAuditManager({
    githubCli: github,
    snapshotFactory,
    runtime,
    userDataPath: dir,
    getSettings: () => ({ mode: 'api', agentEnabled: true, apiKey: 'k', model: 'm' }),
    onEvent: (ev) => events.push(ev),
  });

  return { dir, manager, events, reviewState, headSha };
}

describe('D17 PR audit manager', () => {
  it('runs start -> prepare -> publish lifecycle', async (t) => {
    const f = fixture(t);
    const startRes = await f.manager.start(f.dir, 7, '关注数值计算');
    assert.equal(startRes.ok, true);
    assert.ok(startRes.auditRef);

    // Wait for async execution
    await new Promise((resolve) => setTimeout(resolve, 50));

    const getRes = f.manager.get(f.dir, startRes.auditRef);
    assert.equal(getRes.ok, true);
    assert.equal(getRes.audit.status, 'completed');
    assert.equal(getRes.audit.report.findings.length, 1);
    const finding = getRes.audit.report.findings[0];

    // Read context
    const ctxRes = await f.manager.context(f.dir, startRes.auditRef, finding.findingId);
    assert.equal(ctxRes.ok, true);
    assert.match(ctxRes.snippet.content, /2: 2/);

    // Prepare draft
    const prepRes = await f.manager.prepare(f.dir, {
      auditRef: startRes.auditRef,
      revision: getRes.audit.revision,
      summary: '确认存在缺陷',
      selections: [{
        findingId: finding.findingId,
        title: '可能除以零',
        body: '必须添加分支判断。',
      }],
    }, { projectBindingId: 'pb_test', ownerId: 1 });

    assert.equal(prepRes.ok, true);
    assert.match(prepRes.draftRef, /^pad_[a-f0-9]{24}$/);
    assert.equal(prepRes.commentCount, 1);
    assert.match(prepRes.preview, /AI 辅助代码审查/);

    // Publish draft with permission gate
    const gate = {
      authorize: async () => ({ allowed: true }),
    };

    const pubRes = await f.manager.publish(f.dir, prepRes.draftRef, {
      projectBindingId: 'pb_test',
      ownerId: 1,
      permissionGate: gate,
    });

    assert.equal(pubRes.ok, true);
    assert.equal(pubRes.published, true);

    // Verify stored publication status
    const afterPub = f.manager.get(f.dir, startRes.auditRef);
    assert.equal(afterPub.audit.publication.status, 'published');
    assert.equal(afterPub.audit.publication.reviewId, 999);
  });

  it('rejects a second start on the same project while running', async (t) => {
    const f = fixture(t);
    const first = await f.manager.start(f.dir, 7);
    assert.equal(first.ok, true);

    const second = await f.manager.start(f.dir, 7);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'PR_AUDIT_BUSY');

    f.manager.cancel(f.dir, first.auditRef);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('supports cancellation of active audit', async (t) => {
    const f = fixture(t);
    f.manager.runtime = (_opts) => new Promise((_resolve, reject) => {
      _opts.signal.addEventListener('abort', () => reject(S.fail('CANCELLED')));
    });

    const startRes = await f.manager.start(f.dir, 7);
    assert.equal(startRes.ok, true);

    const cancelRes = f.manager.cancel(f.dir, startRes.auditRef);
    assert.equal(cancelRes.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = f.manager.get(f.dir, startRes.auditRef);
    assert.equal(after.audit.status, 'cancelled');
  });

  it('reconciles uncertain publication', async (t) => {
    const f = fixture(t);
    const startRes = await f.manager.start(f.dir, 7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const audit = f.manager.get(f.dir, startRes.auditRef).audit;

    // Simulate publication intent stored as uncertain
    const pubRef = S.ref('pap');
    const commentBody = '[P1] test\n\nbody';
    const summaryBody = `AI 辅助代码审查\n\nsummary\n\n审查提交：${f.headSha}\n覆盖 1/1 个变更文件；项目范围外 0 个，跳过 0 个。仅进行静态阅读，未运行验证。\n\n<!-- codex-qq-pr-audit:${pubRef} -->`;

    const comments = [{
      path: 'src/calc.js',
      side: 'RIGHT',
      line: 2,
      startLine: 2,
      bodyHash: S.hash(commentBody),
    }];

    f.manager.store.put({
      ...audit,
      publication: {
        status: 'uncertain',
        publicationRef: pubRef,
        actorId: 42,
        commitId: f.headSha,
        bodyHash: S.hash(summaryBody),
        reviewId: 888,
        comments,
      },
    });

    // Populate fake GitHub with the matching review and comments
    f.reviewState.reviews.push({
      id: 888,
      user: { id: 42 },
      state: 'COMMENTED',
      commit_id: f.headSha,
      body: summaryBody,
      submitted_at: new Date().toISOString(),
    });
    f.reviewState.comments.push({
      id: 2001,
      pull_request_review_id: 888,
      user: { id: 42 },
      path: 'src/calc.js',
      side: 'RIGHT',
      line: 2,
      start_line: 2,
      original_line: 2,
      original_start_line: 2,
      original_commit_id: f.headSha,
      body: commentBody,
    });

    const recRes = await f.manager.reconcile(f.dir, startRes.auditRef);
    assert.equal(recRes.ok, true);
    assert.equal(recRes.published, true);

    const rechecked = f.manager.get(f.dir, startRes.auditRef);
    assert.equal(rechecked.audit.publication.status, 'published');
  });
});
