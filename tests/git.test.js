'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

const { findGitRoot, gitStatus, gitDiff, gitCommit, parseStatusPorcelain } = require('../src/ai/git');

function initTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  // default branch name can vary; leave as-is
  return root;
}

describe('parseStatusPorcelain', () => {
  it('keeps dots in branch names (feature/v1.2.3)', () => {
    const r = parseStatusPorcelain('## feature/v1.2.3...origin/feature/v1.2.3 [ahead 1]\n M a.txt\n');
    assert.equal(r.branch, 'feature/v1.2.3');
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].path, 'a.txt');
  });

  it('parses branch without tracking', () => {
    const r = parseStatusPorcelain('## main\n');
    assert.equal(r.branch, 'main');
  });

  it('parses detached HEAD', () => {
    const r = parseStatusPorcelain('## HEAD (no branch)\n');
    assert.equal(r.branch, 'HEAD');
  });
});

describe('git.js', { skip: !gitAvailable }, () => {
  it('findGitRoot walks up to .git', () => {
    const root = initTempRepo();
    const nested = path.join(root, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findGitRoot(nested), root);
    assert.equal(findGitRoot(root), root);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nogit-'));
    assert.equal(findGitRoot(bare), null);
  });

  it('status / diff / commit on modified file', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');

    const st = await gitStatus(root);
    assert.ok(st.ok);
    assert.ok(st.entries.some((e) => e.path === 'a.txt' || e.path.endsWith('a.txt')));
    assert.ok(st.branch);
    assert.ok(st.summary);

    const d = await gitDiff(root, { path: 'a.txt' });
    assert.ok(d.ok);
    assert.match(d.text, /v2/);
    assert.equal(d.staged, false);

    const c = await gitCommit(root, { message: 'update a', paths: ['a.txt'] });
    assert.ok(c.ok, c.error);
    assert.ok(c.commit);
    assert.ok(c.branch);
  });

  it('gitCommit fails empty message', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'y\n');
    const r = await gitCommit(root, { message: '   ', paths: ['a.txt'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /message|消息|空/i);
  });

  it('gitCommit without paths fails when nothing staged', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    const r = await gitCommit(root, { message: 'no stage' });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有可提交的暂存变更/);
  });

  it('gitCommit stage:false with paths fails', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');
    const r = await gitCommit(root, { message: 'x', paths: ['a.txt'], stage: false });
    assert.equal(r.ok, false);
  });

  it('gitCommit rejects path escape', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    const r = await gitCommit(root, { message: 'x', paths: ['../outside.txt'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /越界/);
  });

  it('non-repo returns ok:false', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nogit-'));
    const st = await gitStatus(bare);
    assert.equal(st.ok, false);
    assert.match(st.error, /不是 git 仓库|not a git/i);
  });

  it('gitDiff staged uses cached', async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'staged\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    const d = await gitDiff(root, { staged: true });
    assert.ok(d.ok);
    assert.equal(d.staged, true);
    assert.match(d.text, /staged/);
  });
});
