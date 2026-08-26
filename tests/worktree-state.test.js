'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKER_VERSION,
  PENDING_LIMIT,
  normalizeMarker,
  createMarker,
  canTransition,
  transitionMarker,
  capabilityFor,
  publicSummary,
  countUnresolved,
} = require('../src/ai/worktree-state');

function marker(overrides = {}) {
  return {
    version: MARKER_VERSION,
    id: 'wt_ab12cd34',
    state: 'ready',
    sessionId: 's_1',
    subagentId: 'sa_1',
    goal: '实现隔离修改',
    createdAt: 100,
    updatedAt: 101,
    repoRoot: 'D:/repo',
    projectRoot: 'D:/repo/packages/app',
    projectIdentity: 'windows:d:/repo/packages/app',
    projectRel: 'packages/app',
    baseHead: 'a'.repeat(40),
    worktreeGitDir: 'D:/repo/.git/worktrees/checkout',
    expectedTree: 'b'.repeat(40),
    patchSha256: 'c'.repeat(64),
    patchBytes: 20,
    incomplete: false,
    files: [{ path: 'packages/app/a.js', status: 'M', binary: false }],
    filesTruncated: false,
    stats: { files: 1, additions: 2, deletions: 1, binaryFiles: 0 },
    errorCode: null,
    error: null,
    ...overrides,
  };
}

describe('D5 worktree marker state', () => {
  it('normalizes a v1 marker and rejects invalid authority fields', () => {
    const normalized = normalizeMarker(marker());
    assert.equal(normalized.id, 'wt_ab12cd34');
    assert.equal(normalized.projectRel, 'packages/app');
    assert.equal(normalized.files[0].path, 'packages/app/a.js');
    assert.equal(normalizeMarker(marker({ id: '../bad' })), null);
    assert.equal(normalizeMarker(marker({ version: 2 })), null);
    assert.equal(normalizeMarker(marker({ projectRel: '../outside' })), null);
    assert.equal(normalizeMarker(marker({ patchSha256: 'nope' })), null);
  });

  it('creates a creating marker with bounded defaults', () => {
    const out = createMarker(marker({ state: undefined, createdAt: undefined, updatedAt: undefined }), { now: 500 });
    assert.equal(out.state, 'creating');
    assert.equal(out.createdAt, 500);
    assert.equal(out.updatedAt, 500);
    assert.deepEqual(out.files, []);
  });

  it('allows only the documented lifecycle transitions', () => {
    assert.equal(canTransition('creating', 'running'), true);
    assert.equal(canTransition('ready', 'applying'), true);
    assert.equal(canTransition('ready', 'pr_preparing'), true);
    assert.equal(canTransition('pr_pushing', 'pr_creating'), true);
    assert.equal(canTransition('pr_creating', 'pr_cleanup_pending'), true);
    assert.equal(canTransition('collect_failed', 'collecting'), true);
    assert.equal(canTransition('ready', 'collecting'), false);
    assert.equal(canTransition('apply_uncertain', 'ready'), false);
    const applied = transitionMarker(marker(), 'applying', {}, { now: 200 });
    assert.equal(applied.state, 'applying');
    assert.equal(applied.updatedAt, 200);
    assert.equal(transitionMarker(marker(), 'collecting'), null);
  });

  it('keeps summaries bounded and never exposes filesystem authority paths', () => {
    const summary = publicSummary(marker({ pr: {
      host: 'github.com', owner: 'acme', repo: 'widget', number: 7,
      url: 'https://github.com/acme/widget/pull/7', state: 'open', headSha: 'd'.repeat(40),
      checksSummary: { total: 2, passed: 1, skipped: 1 }, body: 'must not persist',
    } }));
    assert.equal(summary.id, 'wt_ab12cd34');
    assert.equal(summary.updatedAt, 101);
    assert.equal('repoRoot' in summary, false);
    assert.equal('projectRoot' in summary, false);
    assert.equal('worktreeGitDir' in summary, false);
    assert.equal('patchSha256' in summary, false);
    assert.equal(summary.canApply, true);
    assert.equal(summary.canPreview, true);
    assert.equal(summary.canCreatePr, true);
    assert.equal(summary.pr.state, 'OPEN');
    assert.equal(summary.pr.headSha, 'd'.repeat(40));
    assert.deepEqual(summary.pr.checksSummary, { total: 2, passed: 1, pending: 0, failed: 0, skipped: 1, unknown: 0 });
    assert.equal('body' in summary.pr, false);
  });

  it('maps action capabilities and counts only unresolved markers', () => {
    assert.deepEqual(capabilityFor('collect_failed'), {
      canApply: false, canDiscard: true, canRetryCollect: true,
      canCleanup: false, canOpen: true, canPreview: false,
      canCreatePr: false, canRetryPr: false, canCleanupPr: false, canOpenPr: false,
    });
    assert.equal(capabilityFor('applied_cleanup_pending').canCleanup, true);
    assert.equal(capabilityFor('applied_cleanup_pending').canDiscard, false);
    assert.equal(capabilityFor('apply_uncertain').canDiscard, false);
    assert.equal(countUnresolved([
      marker(),
      marker({ id: 'wt_bc12cd34', state: 'applied_cleanup_pending' }),
      marker({ id: 'wt_cd12cd34', state: 'discarded_cleanup_pending' }),
      marker({ id: 'wt_de12cd34', state: 'pr_created' }),
      { bad: true },
    ]), 1);
    assert.equal(PENDING_LIMIT, 3);
  });
});
