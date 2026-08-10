'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  memoryFilePath,
  readEntries,
  readAll,
  appendEntry,
  deleteEntry,
  updateEntry,
  writeAllAtomic,
  normalizeText,
  TEXT_MAX,
} = require('../src/ai/memory-store');

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-'));
  const projectPath = path.join(root, 'proj');
  const userDataPath = path.join(root, 'user');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  return { projectPath, userDataPath };
}

describe('memory-store', () => {
  it('memoryFilePath puts project memory under .codex and rejects escapes', () => {
    const { projectPath, userDataPath } = tmpDirs();
    assert.equal(
      memoryFilePath({ scope: 'project', projectPath }),
      path.join(projectPath, '.codex', 'memory.jsonl'),
    );
    assert.equal(
      memoryFilePath({ scope: 'user', userDataPath }),
      path.join(userDataPath, 'memory.jsonl'),
    );
    assert.throws(() => memoryFilePath({ scope: 'project', projectPath: '' }), /projectPath/);
  });

  it('appendEntry creates .codex and round-trips through readEntries', () => {
    const { projectPath } = tmpDirs();
    const r = appendEntry({
      scope: 'project', projectPath, text: '构建只用 npm test', tags: ['Build'], source: 'slash', maxEntries: 200, now: 1000,
    });
    assert.equal(r.ok, true);
    assert.match(r.id, /^m_/);
    const file = memoryFilePath({ scope: 'project', projectPath });
    const { entries, skipped } = readEntries(file, 'project');
    assert.equal(skipped, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, '构建只用 npm test');
    assert.deepEqual(entries[0].tags, ['build']);
    assert.equal(entries[0].createdAt, 1000);
    assert.equal(entries[0].source, 'slash');
    assert.equal(entries[0].scope, 'project');
  });

  it('appendEntry dedupes on normalized text without adding a line', () => {
    const { projectPath } = tmpDirs();
    const a = appendEntry({ scope: 'project', projectPath, text: '用 npm test', maxEntries: 200, now: 1 });
    const b = appendEntry({ scope: 'project', projectPath, text: '  用   NPM   TEST ', maxEntries: 200, now: 2 });
    assert.equal(b.deduped, true);
    assert.equal(b.id, a.id);
    const { entries } = readEntries(memoryFilePath({ scope: 'project', projectPath }), 'project');
    assert.equal(entries.length, 1);
  });

  it('appendEntry rejects empty text and truncates over-long text', () => {
    const { projectPath } = tmpDirs();
    assert.equal(appendEntry({ scope: 'project', projectPath, text: '   ', maxEntries: 200, now: 1 }).ok, false);
    appendEntry({ scope: 'project', projectPath, text: 'x'.repeat(TEXT_MAX + 500), maxEntries: 200, now: 1 });
    const { entries } = readEntries(memoryFilePath({ scope: 'project', projectPath }), 'project');
    assert.equal(entries[0].text.length, TEXT_MAX);
    assert.ok(entries[0].text.endsWith('…'));
  });

  it('appendEntry prunes oldest beyond maxEntries', () => {
    const { projectPath } = tmpDirs();
    for (let i = 0; i < 5; i++) {
      appendEntry({ scope: 'project', projectPath, text: 'entry-' + i, maxEntries: 3, now: 1000 + i });
    }
    const { entries } = readEntries(memoryFilePath({ scope: 'project', projectPath }), 'project');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.text), ['entry-2', 'entry-3', 'entry-4']);
  });

  it('readEntries skips corrupt lines instead of losing the file', () => {
    const { projectPath } = tmpDirs();
    const file = memoryFilePath({ scope: 'project', projectPath });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '{"id":"m_1","text":"good","tags":[],"createdAt":1,"source":"tool"}',
      'not json at all',
      '{"id":"m_2","text":"","tags":[],"createdAt":2,"source":"tool"}',
      '',
      '{"id":"m_3","text":"also good","tags":[],"createdAt":3,"source":"tool"}',
    ].join('\n'), 'utf8');
    const { entries, skipped } = readEntries(file, 'project');
    assert.equal(skipped, 2);
    assert.deepEqual(entries.map((e) => e.text), ['good', 'also good']);
  });

  it('readAll merges both scopes and counts them', () => {
    const { projectPath, userDataPath } = tmpDirs();
    appendEntry({ scope: 'project', projectPath, text: 'p1', maxEntries: 200, now: 1 });
    appendEntry({ scope: 'user', userDataPath, text: 'u1', maxEntries: 200, now: 2 });
    appendEntry({ scope: 'user', userDataPath, text: 'u2', maxEntries: 200, now: 3 });
    const r = readAll({ projectPath, userDataPath });
    assert.equal(r.entries.length, 3);
    assert.deepEqual(r.counts, { project: 1, user: 2 });
    assert.equal(r.entries.filter((e) => e.scope === 'user').length, 2);
  });

  it('readAll tolerates a missing project binding', () => {
    const { userDataPath } = tmpDirs();
    appendEntry({ scope: 'user', userDataPath, text: 'only user', maxEntries: 200, now: 1 });
    const r = readAll({ projectPath: null, userDataPath });
    assert.equal(r.entries.length, 1);
    assert.equal(r.counts.project, 0);
  });

  it('deleteEntry rewrites atomically and reports misses', () => {
    const { projectPath, userDataPath } = tmpDirs();
    const a = appendEntry({ scope: 'project', projectPath, text: 'keep', maxEntries: 200, now: 1 });
    const b = appendEntry({ scope: 'project', projectPath, text: 'drop', maxEntries: 200, now: 2 });
    const r = deleteEntry({ id: b.id, projectPath, userDataPath });
    assert.equal(r.removed, true);
    assert.equal(r.scope, 'project');
    const { entries } = readEntries(memoryFilePath({ scope: 'project', projectPath }), 'project');
    assert.deepEqual(entries.map((e) => e.id), [a.id]);
    assert.equal(fs.existsSync(memoryFilePath({ scope: 'project', projectPath }) + '.tmp'), false);
    assert.equal(deleteEntry({ id: 'm_missing', projectPath, userDataPath }).removed, false);
  });

  it('deleteEntry without scope checks project first then user', () => {
    const { projectPath, userDataPath } = tmpDirs();
    const u = appendEntry({ scope: 'user', userDataPath, text: 'user only', maxEntries: 200, now: 1 });
    const r = deleteEntry({ id: u.id, projectPath, userDataPath });
    assert.equal(r.removed, true);
    assert.equal(r.scope, 'user');
  });

  it('appendEntry returns ok:false in zh-CN instead of throwing on a missing path binding', () => {
    let p;
    assert.doesNotThrow(() => {
      p = appendEntry({ scope: 'project', projectPath: '', text: '没有打开项目', maxEntries: 200, now: 1 });
    });
    assert.equal(p.ok, false);
    assert.match(p.error, /缺少 projectPath/);

    let u;
    assert.doesNotThrow(() => {
      u = appendEntry({ scope: 'user', userDataPath: null, text: '没有 userData', maxEntries: 200, now: 1 });
    });
    assert.equal(u.ok, false);
    assert.match(u.error, /缺少 userDataPath/);
  });

  it('appendEntry returns ok:false instead of throwing when the write fails', () => {
    const { userDataPath } = tmpDirs();
    const realAppend = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error('EACCES: permission denied'); };
    let r;
    try {
      assert.doesNotThrow(() => {
        r = appendEntry({ scope: 'user', userDataPath, text: '写不进去', maxEntries: 200, now: 1 });
      });
    } finally {
      fs.appendFileSync = realAppend;
    }
    assert.equal(r.ok, false);
    assert.match(r.error, /写入记忆失败/);
  });

  it('deleteEntry returns ok:false instead of throwing when the rewrite fails', () => {
    const { projectPath, userDataPath } = tmpDirs();
    appendEntry({ scope: 'project', projectPath, text: 'keep', maxEntries: 200, now: 1 });
    const b = appendEntry({ scope: 'project', projectPath, text: 'drop', maxEntries: 200, now: 2 });
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('EACCES: permission denied'); };
    let r;
    try {
      assert.doesNotThrow(() => {
        r = deleteEntry({ id: b.id, projectPath, userDataPath });
      });
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.equal(r.ok, false);
    assert.match(r.error, /删除记忆失败/);
    const dir = path.dirname(memoryFilePath({ scope: 'project', projectPath }));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.tmp/.test(f)), []);
  });

  it('a successful delete leaves no tmp file behind', () => {
    const { projectPath, userDataPath } = tmpDirs();
    appendEntry({ scope: 'project', projectPath, text: 'keep', maxEntries: 200, now: 1 });
    const b = appendEntry({ scope: 'project', projectPath, text: 'drop', maxEntries: 200, now: 2 });
    assert.equal(deleteEntry({ id: b.id, projectPath, userDataPath }).removed, true);
    const dir = path.dirname(memoryFilePath({ scope: 'project', projectPath }));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.tmp/.test(f)), []);
  });

  it('writeAllAtomic uses a per-process tmp name and unlinks it when the rename fails', () => {
    const { projectPath } = tmpDirs();
    const file = memoryFilePath({ scope: 'project', projectPath });
    const seen = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    fs.writeFileSync = (p, ...rest) => { seen.push(String(p)); return realWrite(p, ...rest); };
    fs.renameSync = () => { throw new Error('EPERM: rename failed'); };
    try {
      assert.throws(
        () => writeAllAtomic(file, [{ id: 'm_1', text: 'x', tags: [], createdAt: 1, source: 'tool' }]),
        /EPERM/,
      );
    } finally {
      fs.writeFileSync = realWrite;
      fs.renameSync = realRename;
    }
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], file + '.tmp');
    assert.ok(seen[0].startsWith(file + '.tmp-'), seen[0]);
    assert.ok(seen[0].includes(String(process.pid)), seen[0]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => /\.tmp/.test(f)), []);
  });

  it('normalizes hand-edited rows to the persisted safety limits', () => {
    const { userDataPath } = tmpDirs();
    const file = memoryFilePath({ scope: 'user', userDataPath });
    fs.writeFileSync(file, JSON.stringify({
      id: 'm_manual', text: 'x'.repeat(TEXT_MAX + 500),
      tags: Array.from({ length: 12 }, (_, i) => ' TAG-' + i + '-'.repeat(10)),
      createdAt: 1, source: 'tool',
    }) + '\n');
    const { entries } = readEntries(file, 'user');
    assert.equal(entries[0].text.length, TEXT_MAX);
    assert.equal(entries[0].text.endsWith('…'), true);
    assert.equal(entries[0].tags.length, 8);
    assert.equal(entries[0].tags.every((tag) => tag.length <= 24), true);
  });

  it('dedupes repeated over-long input after canonical truncation', () => {
    const { userDataPath } = tmpDirs();
    const text = 'x'.repeat(TEXT_MAX + 500);
    const first = appendEntry({ scope: 'user', userDataPath, text, maxEntries: 200, now: 1 });
    const second = appendEntry({ scope: 'user', userDataPath, text, maxEntries: 200, now: 2 });
    assert.equal(second.deduped, true);
    assert.equal(second.id, first.id);
    assert.equal(readEntries(memoryFilePath({ scope: 'user', userDataPath }), 'user').entries.length, 1);
  });

  it('treats ENOENT as empty but surfaces other read errors', () => {
    const { userDataPath } = tmpDirs();
    const file = memoryFilePath({ scope: 'user', userDataPath });
    assert.deepEqual(readEntries(file, 'user'), { entries: [], skipped: 0 });
    const realRead = fs.readFileSync;
    fs.readFileSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    try {
      assert.throws(() => readEntries(file, 'user'), /denied/);
    } finally {
      fs.readFileSync = realRead;
    }
  });

  it('append and delete translate read failures to ok:false', () => {
    const { userDataPath } = tmpDirs();
    const realRead = fs.readFileSync;
    fs.readFileSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    try {
      assert.equal(appendEntry({ scope: 'user', userDataPath, text: 'x' }).ok, false);
      assert.equal(deleteEntry({ scope: 'user', userDataPath, id: 'm_x' }).ok, false);
    } finally {
      fs.readFileSync = realRead;
    }
  });

  it('normalizeText folds whitespace and case', () => {
    assert.equal(normalizeText('  A   B  '), 'a b');
    assert.equal(normalizeText(null), '');
  });

  it('round-trips compact source and optional updatedAt without migrating old rows', () => {
    const { projectPath } = tmpDirs();
    const added = appendEntry({
      scope: 'project', projectPath, text: '构建只用 npm test',
      tags: ['build'], source: 'compact', maxEntries: 200, now: 1000,
    });
    const file = memoryFilePath({ scope: 'project', projectPath });
    let entries = readEntries(file, 'project').entries;
    assert.equal(entries[0].source, 'compact');
    assert.equal(entries[0].updatedAt, null);

    fs.appendFileSync(file, JSON.stringify({
      id: 'm_legacy', text: '旧行', tags: [], createdAt: 900,
      source: 'unknown-source', updatedAt: 'bad',
    }) + '\n', 'utf8');
    entries = readEntries(file, 'project').entries;
    assert.equal(entries.find((entry) => entry.id === 'm_legacy').source, 'tool');
    assert.equal(entries.find((entry) => entry.id === 'm_legacy').updatedAt, null);

    writeAllAtomic(file, [{ ...entries.find((entry) => entry.id === added.id), updatedAt: 1500 }]);
    entries = readEntries(file, 'project').entries;
    assert.equal(entries[0].id, added.id);
    assert.equal(entries[0].source, 'compact');
    assert.equal(entries[0].updatedAt, 1500);
  });

  it('updates text and tags while preserving identity, source, scope and createdAt', () => {
    const { projectPath } = tmpDirs();
    const added = appendEntry({
      scope: 'project', projectPath, text: '旧约定', tags: ['old'],
      source: 'compact', maxEntries: 200, now: 1000,
    });
    const before = readEntries(
      memoryFilePath({ scope: 'project', projectPath }), 'project'
    ).entries[0];
    const result = updateEntry({
      id: added.id, scope: 'project', projectPath,
      expected: { text: before.text, tags: before.tags, updatedAt: before.updatedAt },
      text: '  新约定  ', tags: [' Build ', 'build'], now: 2000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.deepEqual(result.entry, {
      id: added.id, text: '新约定', tags: ['build'], createdAt: 1000,
      updatedAt: 2000, source: 'compact', scope: 'project',
    });
    const after = readEntries(
      memoryFilePath({ scope: 'project', projectPath }), 'project'
    ).entries[0];
    assert.deepEqual(after, result.entry);
  });

  it('rejects stale text, tags, updatedAt and a missing id as conflicts', () => {
    const variants = [
      { text: '别的文本', tags: ['old'], updatedAt: null },
      { text: '旧约定', tags: ['other'], updatedAt: null },
      { text: '旧约定', tags: ['old'], updatedAt: 999 },
    ];
    for (const expected of variants) {
      const { userDataPath } = tmpDirs();
      const added = appendEntry({
        scope: 'user', userDataPath, text: '旧约定', tags: ['old'], now: 100,
      });
      const result = updateEntry({
        id: added.id, scope: 'user', userDataPath, expected,
        text: '不应写入', tags: [], now: 200,
      });
      assert.deepEqual(result, {
        ok: false, code: 'CONFLICT', error: '记忆已被修改或删除，请刷新后重试',
      });
      assert.equal(readEntries(
        memoryFilePath({ scope: 'user', userDataPath }), 'user'
      ).entries[0].text, '旧约定');
    }

    const { userDataPath } = tmpDirs();
    assert.equal(updateEntry({
      id: 'm_missing', scope: 'user', userDataPath,
      expected: { text: 'x', tags: [], updatedAt: null }, text: 'y', tags: [],
    }).code, 'CONFLICT');
  });

  it('rejects an exact duplicate without changing either row', () => {
    const { userDataPath } = tmpDirs();
    const first = appendEntry({ scope: 'user', userDataPath, text: '保留内容', now: 100 });
    const second = appendEntry({ scope: 'user', userDataPath, text: '待修改内容', now: 200 });
    const file = memoryFilePath({ scope: 'user', userDataPath });
    const before = fs.readFileSync(file, 'utf8');
    const current = readEntries(file, 'user').entries.find((e) => e.id === second.id);
    const result = updateEntry({
      id: second.id, scope: 'user', userDataPath,
      expected: { text: current.text, tags: current.tags, updatedAt: current.updatedAt },
      text: '  保留内容  ', tags: [], now: 300,
    });
    assert.deepEqual(result, { ok: false, code: 'DUPLICATE', error: '已有相同记忆' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(readEntries(file, 'user').entries.find((e) => e.id === first.id).text, '保留内容');
  });

  it('keeps the original file readable and removes tmp files when update rewrite fails', () => {
    const { userDataPath } = tmpDirs();
    const added = appendEntry({ scope: 'user', userDataPath, text: '原内容', now: 100 });
    const file = memoryFilePath({ scope: 'user', userDataPath });
    const current = readEntries(file, 'user').entries[0];
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('EACCES: permission denied'); };
    let result;
    try {
      result = updateEntry({
        id: added.id, scope: 'user', userDataPath,
        expected: { text: current.text, tags: current.tags, updatedAt: null },
        text: '新内容', tags: [], now: 200,
      });
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.equal(result.ok, false);
    assert.match(result.error, /更新记忆失败/);
    assert.equal(readEntries(file, 'user').entries[0].text, '原内容');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => /\.tmp/.test(name)), []);
  });
});
