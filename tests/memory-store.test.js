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

  it('normalizeText folds whitespace and case', () => {
    assert.equal(normalizeText('  A   B  '), 'a b');
    assert.equal(normalizeText(null), '');
  });
});
