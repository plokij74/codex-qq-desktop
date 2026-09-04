'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('D6 renderer Draft PR integration', () => {
  it('exposes the narrow PR IPC surface', () => {
    const preload = source('src/preload.js');
    const main = source('src/main.js');
    for (const channel of ['worktree:pr:preflight', 'worktree:pr:create', 'worktree:pr:retry', 'worktree:pr:cleanup', 'worktree:pr:open']) {
      assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const channel of ['worktree:pr:list', 'worktree:pr:get', 'worktree:pr:edit', 'worktree:pr:comment', 'worktree:pr:close', 'worktree:pr:reopen', 'worktree:pr:ready', 'worktree:pr:merge']) {
      assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('renders editable title/body and keeps apply and PR as explicit actions', () => {
    const app = source('src/renderer/app.js');
    const css = source('src/renderer/styles.css');
    assert.match(app, /className = 'worktree-pr-title'/);
    assert.match(app, /className = 'worktree-pr-body'/);
    assert.match(app, /确认创建 Draft PR/);
    assert.match(app, /应用全部/);
    assert.match(app, /preflightWorktreePr/);
    assert.match(css, /\.worktree-pr-form/);
  });

  it('replaces the mock PR page with a real repository lifecycle workspace', () => {
    const app = source('src/renderer/app.js');
    const css = source('src/renderer/styles.css');
    assert.doesNotMatch(app, /const PRS =/);
    assert.match(app, /listPullRequests/);
    assert.match(app, /getPullRequest/);
    assert.match(app, /editPullRequest/);
    assert.match(app, /commentPullRequest/);
    assert.match(app, /readyPullRequest/);
    assert.match(app, /mergePullRequest/);
    assert.match(app, /strictMergeReady/);
    assert.match(css, /\.pr-workspace/);
  });

  it('lets users explicitly bind a passed workflow run to apply, Draft PR, and merge', () => {
    const app = source('src/renderer/app.js');
    const css = source('src/renderer/styles.css');
    assert.match(app, /workflowGatePayload\(project, 'apply'/);
    assert.match(app, /workflowGatePayload\(project, 'create_pr'/);
    assert.match(app, /workflowGatePayload\(project, 'merge'/);
    assert.match(app, /workflowRunRef:\s*run\.workflowRunRef/);
    assert.match(app, /expectedFingerprint:\s*run\.endWorkspaceFingerprint/);
    assert.match(app, /不使用工作流门禁/);
    assert.match(app, /前往工程中心/);
    assert.match(css, /\.workflow-gate-control/);
  });
});
