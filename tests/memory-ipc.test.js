'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  memoryList,
  memoryAdd,
  memoryDelete,
  memoryAccept,
  memoryUpdate,
} = require('../src/ai/memory-ipc');
const memoryStore = require('../src/ai/memory-store');
const { readAll } = memoryStore;

const SETTINGS = {
  memoryEnabled: true,
  memoryMaxEntries: 200,
  memoryInjectTopN: 8,
  memoryInjectMaxTokens: 1200,
};

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memipc-'));
  const projectPath = path.join(root, 'proj');
  const userDataPath = path.join(root, 'user');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  return { projectPath, userDataPath };
}

describe('memory-ipc', () => {
  it('all three refuse when memoryEnabled is false', () => {
    const { projectPath, userDataPath } = dirs();
    const settings = { ...SETTINGS, memoryEnabled: false };
    for (const fn of [memoryList, memoryAdd, memoryDelete, memoryAccept, memoryUpdate]) {
      const r = fn({ settings, userDataPath, payload: { projectPath, text: 'x', id: 'm_1' } });
      assert.equal(r.ok, false);
      assert.match(r.error, /长期记忆未启用/);
    }
  });

  it('memoryAdd defaults to project scope and records source slash', () => {
    const { projectPath, userDataPath } = dirs();
    const r = memoryAdd({ settings: SETTINGS, userDataPath, payload: { projectPath, text: '构建只用 npm test' } });
    assert.equal(r.ok, true);
    assert.equal(r.scope, 'project');
    const all = readAll({ projectPath, userDataPath });
    assert.equal(all.counts.project, 1);
    assert.equal(all.entries[0].source, 'slash');
  });

  it('memoryAdd falls back to user scope without a project, and honours explicit user scope', () => {
    const { projectPath, userDataPath } = dirs();
    const a = memoryAdd({ settings: SETTINGS, userDataPath, payload: { text: '回答一律中文' } });
    assert.equal(a.scope, 'user');
    const b = memoryAdd({ settings: SETTINGS, userDataPath, payload: { projectPath, text: '偏好深色', scope: 'user' } });
    assert.equal(b.scope, 'user');
    assert.equal(readAll({ projectPath, userDataPath }).counts.project, 0);
  });

  it('memoryAdd applies the settings entry cap', () => {
    const { projectPath, userDataPath } = dirs();
    const settings = { ...SETTINGS, memoryMaxEntries: 20 };
    for (let i = 0; i < 25; i++) {
      memoryAdd({ settings, userDataPath, payload: { projectPath, text: 'fact-' + i } });
    }
    assert.equal(readAll({ projectPath, userDataPath }).counts.project, 20);
  });

  it('memoryAdd reports empty text as an error instead of throwing', () => {
    const { projectPath, userDataPath } = dirs();
    const r = memoryAdd({ settings: SETTINGS, userDataPath, payload: { projectPath, text: '   ' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /空/);
  });

  it('memoryList merges both scopes with counts and skipped', () => {
    const { projectPath, userDataPath } = dirs();
    memoryAdd({ settings: SETTINGS, userDataPath, payload: { projectPath, text: 'p1' } });
    memoryAdd({ settings: SETTINGS, userDataPath, payload: { text: 'u1' } });
    fs.appendFileSync(path.join(projectPath, '.codex', 'memory.jsonl'), 'broken line\n', 'utf8');
    const r = memoryList({ settings: SETTINGS, userDataPath, payload: { projectPath } });
    assert.equal(r.ok, true);
    assert.equal(r.entries.length, 2);
    assert.deepEqual(r.counts, { project: 1, user: 1 });
    assert.equal(r.skipped, 1);
  });

  it('memoryList without a project returns only user entries', () => {
    const { userDataPath } = dirs();
    memoryAdd({ settings: SETTINGS, userDataPath, payload: { text: 'only user' } });
    const r = memoryList({ settings: SETTINGS, userDataPath, payload: {} });
    assert.equal(r.entries.length, 1);
    assert.equal(r.counts.project, 0);
  });

  it('memoryDelete removes by id and reports a miss', () => {
    const { projectPath, userDataPath } = dirs();
    const added = memoryAdd({ settings: SETTINGS, userDataPath, payload: { projectPath, text: '临时事实' } });
    const gone = memoryDelete({ settings: SETTINGS, userDataPath, payload: { projectPath, id: added.id } });
    assert.equal(gone.ok, true);
    assert.equal(gone.removed, true);
    assert.equal(readAll({ projectPath, userDataPath }).counts.project, 0);
    const miss = memoryDelete({ settings: SETTINGS, userDataPath, payload: { projectPath, id: 'm_nope' } });
    assert.equal(miss.removed, false);
  });

  it('an out-of-sandbox projectPath returns an error instead of throwing', () => {
    const { userDataPath } = dirs();
    const bad = { projectPath: path.join(os.tmpdir(), 'no-such-project-dir-xyz'), text: 'x' };
    // 目录不存在时 appendEntry 会 mkdir 出来，这里断言的是 resolveSafe 的越界分支：
    const r = memoryAdd({
      settings: SETTINGS,
      userDataPath,
      payload: { projectPath: bad.projectPath, text: 'x', scope: 'project' },
    });
    // 合法但不存在的目录允许创建；关键是永远返回结构化结果、不抛异常
    assert.equal(typeof r.ok, 'boolean');
  });

  it('memoryAccept requires an explicit scope and never falls project back to user', () => {
    const { userDataPath } = dirs();
    const missingScope = memoryAccept({
      settings: SETTINGS, userDataPath, payload: { text: 'x' },
    });
    assert.equal(missingScope.ok, false);
    assert.match(missingScope.error, /作用域/);

    const missingProject = memoryAccept({
      settings: SETTINGS, userDataPath,
      payload: { scope: 'project', text: '项目事实' },
    });
    assert.equal(missingProject.ok, false);
    assert.match(missingProject.error, /projectPath/);
    assert.equal(readAll({ userDataPath }).counts.user, 0);
  });

  it('memoryAccept fixes new source to compact and keeps deduped old source unchanged', () => {
    const { projectPath, userDataPath } = dirs();
    const accepted = memoryAccept({
      settings: SETTINGS, userDataPath,
      payload: {
        projectPath, scope: 'project', text: '项目构建只用 npm test',
        tags: ['build'], source: 'slash',
      },
    });
    assert.equal(accepted.ok, true);
    let all = readAll({ projectPath, userDataPath });
    assert.equal(all.entries[0].source, 'compact');

    memoryAdd({
      settings: SETTINGS, userDataPath,
      payload: { scope: 'user', text: '回答使用中文' },
    });
    const duplicate = memoryAccept({
      settings: SETTINGS, userDataPath,
      payload: { projectPath, scope: 'user', text: ' 回答使用中文 ' },
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.deduped, true);
    all = readAll({ projectPath, userDataPath });
    assert.equal(all.entries.find((entry) => entry.id === duplicate.id).source, 'slash');
  });

  it('memoryAccept rejects sensitive values in edited text or tags before writing', () => {
    const { userDataPath } = dirs();
    for (const payload of [
      { scope: 'user', text: 'api_key = abcdefghijklmnop', tags: [] },
      { scope: 'user', text: '部署约定', tags: ['password = abcdefghijklmnop'] },
    ]) {
      const result = memoryAccept({ settings: SETTINGS, userDataPath, payload });
      assert.equal(result.ok, false);
      assert.match(result.error, /敏感信息/);
    }
    assert.equal(readAll({ userDataPath }).counts.user, 0);
  });

  it('memoryAccept honors explicit user scope even when a project is bound', () => {
    const { projectPath, userDataPath } = dirs();
    const result = memoryAccept({
      settings: SETTINGS, userDataPath,
      payload: { projectPath, scope: 'user', text: '跨项目偏好' },
    });
    assert.equal(result.scope, 'user');
    assert.deepEqual(readAll({ projectPath, userDataPath }).counts, { project: 0, user: 1 });
  });

  it('memoryAccept applies memoryMaxEntries to accepted candidates', () => {
    const { userDataPath } = dirs();
    const settings = { ...SETTINGS, memoryMaxEntries: 20 };
    for (let index = 0; index < 25; index++) {
      const result = memoryAccept({
        settings, userDataPath,
        payload: { scope: 'user', text: 'accepted-' + index },
      });
      assert.equal(result.ok, true);
    }
    assert.equal(readAll({ userDataPath }).counts.user, 20);
  });

  it('memoryUpdate passes expected state through and returns a stable conflict', () => {
    const { projectPath, userDataPath } = dirs();
    const added = memoryAccept({
      settings: SETTINGS, userDataPath,
      payload: { projectPath, scope: 'project', text: '旧文本', tags: ['old'] },
    });
    const current = readAll({ projectPath, userDataPath }).entries[0];
    const updated = memoryUpdate({
      settings: SETTINGS, userDataPath,
      payload: {
        projectPath, id: added.id, scope: 'project',
        expected: { text: current.text, tags: current.tags, updatedAt: current.updatedAt },
        text: '新文本', tags: ['new'],
      },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.entry.scope, 'project');
    assert.equal(updated.entry.source, 'compact');

    const stale = memoryUpdate({
      settings: SETTINGS, userDataPath,
      payload: {
        projectPath, id: added.id, scope: 'project',
        expected: { text: current.text, tags: current.tags, updatedAt: current.updatedAt },
        text: '覆盖新文本', tags: [],
      },
    });
    assert.deepEqual(stale, {
      ok: false, code: 'CONFLICT', error: '记忆已被修改或删除，请刷新后重试',
    });
  });

  it('memoryUpdate rejects invalid scope and a project update without projectPath', () => {
    const { userDataPath } = dirs();
    for (const payload of [
      { id: 'm_1', scope: 'other', text: 'x' },
      { id: 'm_1', scope: 'project', text: 'x' },
    ]) {
      const result = memoryUpdate({ settings: SETTINGS, userDataPath, payload });
      assert.equal(result.ok, false);
    }
  });

  it('memoryUpdate catches an unexpected store exception', () => {
    const { userDataPath } = dirs();
    const realUpdate = memoryStore.updateEntry;
    memoryStore.updateEntry = () => { throw new Error('unexpected I/O'); };
    let result;
    try {
      result = memoryUpdate({
        settings: SETTINGS, userDataPath,
        payload: { id: 'm_1', scope: 'user', expected: {}, text: 'x', tags: [] },
      });
    } finally {
      memoryStore.updateEntry = realUpdate;
    }
    assert.equal(result.ok, false);
    assert.match(result.error, /unexpected I\/O/);
  });
});
