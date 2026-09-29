'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAuditGithub } = require('../src/ai/pr-audit-github');
const S = require('../src/ai/pr-audit-state');

function fixture() {
  const calls = [];
  let responseHandler = () => ({ ok: true, code: 0, stdout: 'HTTP/1.1 200 OK\r\n\r\n{}' });

  const command = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return responseHandler({ cmd, args, opts });
  };

  const qualifiedRepo = (host, owner, repo) => host === 'github.com' && owner === 'test-owner' && repo === 'test-repo';
  const gh = createAuditGithub(command, qualifiedRepo);

  const baseArgs = {
    host: 'github.com',
    owner: 'test-owner',
    repo: 'test-repo',
    repoRoot: '/repo',
  };

  return { gh, calls, baseArgs, setResponse: (fn) => { responseHandler = fn; } };
}

describe('D17 PR audit GitHub client', () => {
  it('getAuditPr requests PR metadata with jq filter', async () => {
    const f = fixture();
    const prData = {
      number: 12,
      state: 'open',
      merged: false,
      title: 'PR title',
      body: 'PR body',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      headRefName: 'feature',
      baseRefName: 'main',
      headRepo: 'test-owner/test-repo',
      baseRepo: 'test-owner/test-repo',
      changedFiles: 1,
    };

    f.setResponse(() => ({
      ok: true,
      stdout: `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(prData)}`,
    }));

    const result = await f.gh.getAuditPr({ ...f.baseArgs, number: 12 });
    assert.deepEqual(result, prData);
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].args.includes('repos/test-owner/test-repo/pulls/12'));
  });

  it('getAuditFiles fetches and pages file list', async () => {
    const f = fixture();
    const page1 = [
      { filename: 'file1.js', additions: 1, deletions: 0, sha: 'c'.repeat(40), patch: '@@ -0,0 +1 @@\n+1\n', status: 'added' },
    ];

    f.setResponse(() => ({
      ok: true,
      stdout: `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(page1)}`,
    }));

    const files = await f.gh.getAuditFiles({ ...f.baseArgs, number: 12 });
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'file1.js');
  });

  it('getAuditMergeBase compares SHAs', async () => {
    const f = fixture();
    const mergeBase = 'a'.repeat(40);

    f.setResponse(() => ({
      ok: true,
      stdout: `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify(mergeBase)}`,
    }));

    const result = await f.gh.getAuditMergeBase({
      ...f.baseArgs,
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    });
    assert.equal(result, mergeBase);
    assert.ok(f.calls[0].args.includes(`repos/test-owner/test-repo/compare/${'b'.repeat(40)}...${'c'.repeat(40)}?per_page=1`));
  });

  it('createAuditReview posts COMMENT review and parses response', async () => {
    const f = fixture();
    const payload = {
      event: 'COMMENT',
      commit_id: 'd'.repeat(40),
      body: 'AI Review Summary <!-- codex-qq-pr-audit:pap_123456789012345678901234 -->',
      comments: [{
        path: 'src/app.js',
        side: 'RIGHT',
        line: 10,
        body: '[P1] Bug title\n\nBug description',
      }],
    };

    f.setResponse(({ opts }) => {
      assert.equal(opts.input, JSON.stringify(payload));
      return {
        ok: true,
        stdout: `HTTP/1.1 200 OK\r\n\r\n{"id":98765,"state":"COMMENTED"}`,
      };
    });

    const response = await f.gh.createAuditReview({
      ...f.baseArgs,
      number: 12,
      payload,
    });

    assert.equal(response.id, 98765);
    assert.equal(response.state, 'COMMENTED');
  });

  it('maps HTTP 422 to PUBLISH_FAILED for mutation', async () => {
    const f = fixture();
    f.setResponse(() => ({
      ok: false,
      stdout: `HTTP/1.1 422 Unprocessable Entity\r\n\r\n{"message":"Validation Failed"}`,
    }));

    await assert.rejects(
      () => f.gh.createAuditReview({
        ...f.baseArgs,
        number: 12,
        payload: {
          event: 'COMMENT',
          commit_id: 'd'.repeat(40),
          body: 'summary',
          comments: [],
        },
      }),
      /PR_AUDIT_PUBLISH_FAILED/
    );
  });

  it('maps network timeout to UNCERTAIN for mutation', async () => {
    const f = fixture();
    f.setResponse(() => {
      throw new Error('ETIMEDOUT');
    });

    await assert.rejects(
      () => f.gh.createAuditReview({
        ...f.baseArgs,
        number: 12,
        payload: {
          event: 'COMMENT',
          commit_id: 'd'.repeat(40),
          body: 'summary',
          comments: [],
        },
      }),
      /PR_AUDIT_UNCERTAIN/
    );
  });
});
