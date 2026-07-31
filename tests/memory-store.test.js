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
});
