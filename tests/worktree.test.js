'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeManager, parseNumstat } = require('../src/ai/worktree');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-wt-'));
  fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  git(root, ['config', 'user.email', 'codex@example.test']);
  git(root, ['config', 'user.name', 'Codex Test']);
  fs.writeFileSync(path.join(root, 'packages', 'app', 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

describe('D5 worktree Git lifecycle', () => {
  let root;
  let manager;

  beforeEach(() => {
    root = makeRepo();
    manager = createWorktreeManager();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a dirty base and allows ordinary ignored files', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-qm', 'ignore']);
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
    const ignored = await manager.create({ project: { path: path.join(root, 'packages', 'app') }, goal: 'ignored' });
    assert.equal(ignored.ok, true);
    await manager.discard({ projectPath: root, resultId: ignored.handle.id });

    fs.writeFileSync(path.join(root, 'outside.txt'), 'dirty\n');
    const dirty = await manager.create({ project: { path: path.join(root, 'packages', 'app') }, goal: 'dirty' });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.code, 'DIRTY_BASE');
  });

  it('rejects tracked symlink and gitlink modes before creating a worktree', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root, input: 'target\n', encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${blob},packages/app/link`], { cwd: root });
    const symlink = await manager.create({ project: { path: path.join(root, 'packages', 'app') }, goal: 'symlink' });
    assert.equal(symlink.ok, false);
    assert.equal(symlink.code, 'PATH_UNSAFE');

    git(root, ['reset', '-q', '--']);
    const head = git(root, ['rev-parse', 'HEAD']);
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},packages/app/submodule`], { cwd: root });
    const gitlink = await manager.create({ project: { path: path.join(root, 'packages', 'app') }, goal: 'gitlink' });
    assert.equal(gitlink.ok, false);
    assert.equal(gitlink.code, 'UNSUPPORTED_GITLINK');
  });

  it('rejects a gitlink created inside the isolated checkout during collect', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: 'nested repository' });
    assert.equal(out.ok, true, out.error);
    const nested = path.join(out.handle.childProjectPath, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    git(nested, ['config', 'user.email', 'codex@example.test']);
    git(nested, ['config', 'user.name', 'Codex Test']);
    fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested\n');
    git(nested, ['add', '.']);
    git(nested, ['commit', '-qm', 'nested']);
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, false);
    assert.equal(collected.code, 'UNSUPPORTED_GITLINK');
    const listed = await manager.list({ projectPath: bound });
    assert.equal(listed.results[0].state, 'collect_failed');
    await manager.discard({ projectPath: bound, resultId: out.handle.id });
  });

  it('attributes binary rename numstat records to the new path', () => {
    const files = [{ path: 'packages/app/new.bin', status: 'R', binary: false }];
    const stats = parseNumstat(Buffer.from('-\t-\t\0packages/app/old.bin\0packages/app/new.bin\0'), files);
    assert.equal(stats.binaryFiles, 1);
    assert.equal(files[0].binary, true);
  });

  it('creates an isolated locked worktree for a bound subdirectory', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, sessionId: 's1', subagentId: 'sa1', goal: '修改文件' });
    assert.equal(out.ok, true, out.error);
    assert.equal(fs.existsSync(path.join(out.handle.checkout, 'outside.txt')), true);
    assert.equal(fs.existsSync(path.join(out.handle.childProjectPath, 'a.txt')), true);
    assert.equal(git(out.handle.checkout, ['rev-parse', 'HEAD']), git(root, ['rev-parse', 'HEAD']));
    const listed = await manager.list({ projectPath: bound });
    assert.equal(listed.results.length, 1);
    assert.equal(listed.results[0].id, out.handle.id);
    assert.equal(listed.results[0].canApply, false);
    const clean = await manager.discard({ projectPath: bound, resultId: out.handle.id });
    assert.equal(clean.ok, true, clean.error);
    assert.equal(fs.existsSync(out.handle.resultRoot), false);
  });

  it('collects a scoped change then applies it as unstaged main-tree content', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '修改文件' });
    assert.equal(out.ok, true, out.error);
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'new.txt'), 'new\n');
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, true, collected.error);
    assert.equal(collected.result.stats.files, 2);
    assert.equal(fs.readFileSync(path.join(root, 'packages', 'app', 'a.txt'), 'utf8'), 'one\n');
    const preview = await manager.get({ projectPath: bound, resultId: out.handle.id, preview: true });
    assert.equal(preview.ok, true);
    assert.match(preview.preview, /two/);
    const applied = await manager.apply({ projectPath: bound, resultId: out.handle.id });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(fs.readFileSync(path.join(root, 'packages', 'app', 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'two\n');
    assert.equal(fs.readFileSync(path.join(root, 'packages', 'app', 'new.txt'), 'utf8').replace(/\r\n/g, '\n'), 'new\n');
    assert.equal(git(root, ['diff', '--cached']), '');
    assert.equal(fs.existsSync(out.handle.resultRoot), false);
  });

  it('does not apply when the main tree changes after collection', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '修改文件' });
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'a.txt'), 'child\n');
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, true);
    fs.writeFileSync(path.join(root, 'outside.txt'), 'changed\n');
    const applied = await manager.apply({ projectPath: bound, resultId: out.handle.id });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'WORKTREE_DIRTY');
    assert.equal(fs.readFileSync(path.join(root, 'packages', 'app', 'a.txt'), 'utf8'), 'one\n');
    await manager.discard({ projectPath: bound, resultId: out.handle.id });
  });

  it('recovers an interrupted running result as incomplete on the next project open', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '恢复任务' });
    assert.equal(out.ok, true, out.error);
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'a.txt'), 'recovered\n');
    const recovered = await manager.recover({ projectPath: bound });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.results.length, 1);
    assert.equal(recovered.results[0].state, 'ready');
    assert.equal(recovered.results[0].incomplete, true);
    await manager.discard({ projectPath: bound, resultId: out.handle.id });
  });

  it('collects and applies rename plus binary changes without text conversion', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '重命名并新增二进制' });
    assert.equal(out.ok, true, out.error);
    fs.renameSync(
      path.join(out.handle.childProjectPath, 'a.txt'),
      path.join(out.handle.childProjectPath, 'renamed.txt')
    );
    const binary = Buffer.from([0, 1, 2, 3, 255, 0, 200]);
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'asset.bin'), binary);
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, true, collected.error);
    assert.equal(collected.result.stats.files, 2);
    assert.equal(collected.result.stats.binaryFiles, 1);
    const applied = await manager.apply({ projectPath: bound, resultId: out.handle.id });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(fs.existsSync(path.join(bound, 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(bound, 'renamed.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\n');
    assert.deepEqual(fs.readFileSync(path.join(bound, 'asset.bin')), binary);
  });

  it('rejects a marker or patch that no longer matches the isolated index', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '校验补丁' });
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'a.txt'), 'tampered\n');
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, true);
    fs.appendFileSync(path.join(out.handle.resultRoot, 'result.patch'), '\n# tamper\n');
    const applied = await manager.apply({ projectPath: bound, resultId: out.handle.id });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'PATCH_INVALID');
    assert.equal(fs.readFileSync(path.join(bound, 'a.txt'), 'utf8'), 'one\n');
    await manager.discard({ projectPath: bound, resultId: out.handle.id });
  });

  it('recovers an applying marker back to ready when the main tree is still the exact base', async () => {
    const bound = path.join(root, 'packages', 'app');
    const out = await manager.create({ project: { path: bound }, goal: '恢复应用' });
    fs.writeFileSync(path.join(out.handle.childProjectPath, 'a.txt'), 'pending\n');
    const collected = await manager.collect(out.handle);
    assert.equal(collected.ok, true);
    const markerPath = path.join(out.handle.resultRoot, 'meta.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.state = 'applying';
    marker.updatedAt += 1;
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    const recovered = await manager.recover({ projectPath: bound });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.results[0].state, 'ready');
    await manager.discard({ projectPath: bound, resultId: out.handle.id });
  });
});
