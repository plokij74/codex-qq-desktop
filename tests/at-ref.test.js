'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_CAPS,
  parseAtRefs,
  completeAtPath,
  expandAtRefs,
} = require('../src/ai/at-ref');

function mkProject(prefix = 'at-ref-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('DEFAULT_CAPS', () => {
  it('has expected budget keys', () => {
    assert.equal(DEFAULT_CAPS.maxFileBytes, 64 * 1024);
    assert.equal(DEFAULT_CAPS.maxFileLines, 2000);
    assert.equal(DEFAULT_CAPS.maxRangeLines, 500);
    assert.equal(DEFAULT_CAPS.maxRefs, 20);
    assert.equal(DEFAULT_CAPS.maxTotalBytes, 200 * 1024);
    assert.equal(DEFAULT_CAPS.maxTreeEntries, 200);
    assert.equal(DEFAULT_CAPS.dirPreviewFiles, 5);
    assert.equal(DEFAULT_CAPS.dirPreviewBytes, 2048);
    assert.equal(DEFAULT_CAPS.completeLimit, 20);
  });
});

describe('parseAtRefs', () => {
  it('parses multiple plain refs in order', () => {
    const text = 'see @src/a.js and @src/b.js please';
    const refs = parseAtRefs(text);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].raw, '@src/a.js');
    assert.equal(refs[0].path, 'src/a.js');
    assert.equal(refs[0].index, text.indexOf('@src/a.js'));
    assert.equal(refs[0].startLine, undefined);
    assert.equal(refs[0].endLine, undefined);
    assert.equal(refs[1].path, 'src/b.js');
  });

  it('parses line range :start-end', () => {
    const refs = parseAtRefs('look @src/ai/agent.js:10-40 ok');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].raw, '@src/ai/agent.js:10-40');
    assert.equal(refs[0].path, 'src/ai/agent.js');
    assert.equal(refs[0].startLine, 10);
    assert.equal(refs[0].endLine, 40);
  });

  it('parses directory refs with trailing slash', () => {
    const refs = parseAtRefs('tree @src/ai/');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'src/ai/');
    assert.equal(refs[0].raw, '@src/ai/');
  });

  it('ignores @ inside triple-backtick fences', () => {
    const text = [
      'before @keep.js',
      '```js',
      'const x = "@skip.js";',
      '@also/skip.js',
      '```',
      'after @also/keep.js',
    ].join('\n');
    const refs = parseAtRefs(text);
    assert.deepEqual(refs.map((r) => r.path), ['keep.js', 'also/keep.js']);
  });

  it('ignores @ inside inline code', () => {
    const text = 'use `@src/hidden.js` not real, but @src/visible.js is';
    const refs = parseAtRefs(text);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'src/visible.js');
  });

  it('does not treat email-like tokens without path shape as refs', () => {
    // Still may match path-like after @; bare words allowed as paths.
    // Ensure fences/inline are the main ignore; empty path not produced.
    const refs = parseAtRefs('hello world');
    assert.equal(refs.length, 0);
  });

  it('does not treat email addresses as @refs', () => {
    const refs = parseAtRefs('contact user@example.com and also @src/a.js');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].path, 'src/a.js');
    assert.equal(parseAtRefs('email me at alice@bob.org please').length, 0);
  });

  it('returns empty for empty/null text', () => {
    assert.deepEqual(parseAtRefs(''), []);
    assert.deepEqual(parseAtRefs(null), []);
    assert.deepEqual(parseAtRefs(undefined), []);
  });

  it('handles unclosed fence by treating rest as fenced', () => {
    const text = 'a @a.js\n```\n@b.js\n@c.js';
    const refs = parseAtRefs(text);
    assert.deepEqual(refs.map((r) => r.path), ['a.js']);
  });
});

describe('completeAtPath', () => {
  let root;
  beforeEach(() => {
    root = mkProject();
    write(root, 'src/agent.js', '1');
    write(root, 'src/agent-events.js', '2');
    write(root, 'src/util/a.js', '3');
    write(root, 'README.md', 'r');
    write(root, 'secret.local', 'no');
    fs.mkdirSync(path.join(root, 'src', 'ai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'secret.local\n');
  });

  it('completes path prefix in a directory', () => {
    const hits = completeAtPath(root, 'src/ag');
    assert.ok(hits.some((h) => h.path === 'src/agent.js' && h.type === 'file'));
    assert.ok(hits.some((h) => h.path === 'src/agent-events.js' && h.type === 'file'));
    assert.ok(!hits.some((h) => h.path.includes('util')));
  });

  it('lists directory entries for prefix ending with slash', () => {
    const hits = completeAtPath(root, 'src/');
    assert.ok(hits.some((h) => h.path === 'src/agent.js' && h.type === 'file'));
    assert.ok(hits.some((h) => h.path === 'src/ai' && h.type === 'dir'));
    assert.ok(hits.some((h) => h.path === 'src/util' && h.type === 'dir'));
  });

  it('respects gitignore', () => {
    const hits = completeAtPath(root, '');
    assert.ok(hits.some((h) => h.path === 'README.md'));
    assert.ok(!hits.some((h) => h.path === 'secret.local'));
  });

  it('respects limit option and default completeLimit', () => {
    for (let i = 0; i < 30; i++) {
      write(root, `f${String(i).padStart(2, '0')}.txt`, 'x');
    }
    const limited = completeAtPath(root, 'f', { limit: 5 });
    assert.ok(limited.length <= 5);
    const def = completeAtPath(root, 'f');
    assert.ok(def.length <= DEFAULT_CAPS.completeLimit);
  });

  it('rejects traversal prefix safely (empty or no escape)', () => {
    const hits = completeAtPath(root, '../');
    assert.equal(hits.length, 0);
  });
});

describe('expandAtRefs', () => {
  let root;
  beforeEach(() => {
    root = mkProject();
    write(root, 'src/a.js', 'line1\nline2\nline3\nline4\nline5\n');
    write(root, 'src/b.js', 'bbb\n');
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    write(root, 'src/sub/c.js', 'ccc\n');
  });

  it('expands file ref into context:refs fence', () => {
    const r = expandAtRefs(root, 'please check @src/a.js');
    assert.ok(r.contextBlock);
    assert.match(r.contextBlock, /```context:refs/);
    assert.match(r.contextBlock, /### file: src\/a\.js/);
    assert.match(r.contextBlock, /line1/);
    assert.match(r.contextBlock, /line5/);
    assert.equal(r.refs.length, 1);
    assert.equal(r.refs[0].path, 'src/a.js');
    assert.deepEqual(r.warnings, []);
  });

  it('expands line range inclusive', () => {
    const r = expandAtRefs(root, '@src/a.js:2-4');
    assert.match(r.contextBlock, /### file: src\/a\.js:2-4/);
    assert.match(r.contextBlock, /line2/);
    assert.match(r.contextBlock, /line4/);
    assert.doesNotMatch(r.contextBlock, /line1\n/);
    assert.doesNotMatch(r.contextBlock, /line5/);
  });

  it('expands directory with tree text', () => {
    const r = expandAtRefs(root, 'show @src/');
    assert.match(r.contextBlock, /### dir: src/);
    assert.match(r.contextBlock, /a\.js|sub/);
  });

  it('dir expand applies project-root gitignore paths (src/secret)', () => {
    write(root, 'src/secret.txt', 'hidden\n');
    write(root, 'src/visible.txt', 'ok\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'src/secret.txt\n');
    const r = expandAtRefs(root, 'show @src/');
    assert.match(r.contextBlock, /### dir: src/);
    assert.match(r.contextBlock, /visible\.txt/);
    assert.doesNotMatch(r.contextBlock, /secret\.txt/);
  });

  it('warns and skips path traversal', () => {
    const r = expandAtRefs(root, 'bad @../secret.txt and good @src/b.js');
    assert.ok(r.warnings.some((w) => /越界|遍历|\.\./.test(w)));
    assert.match(r.contextBlock, /### file: src\/b\.js/);
    assert.doesNotMatch(r.contextBlock, /secret/);
  });

  it('warns on missing path', () => {
    const r = expandAtRefs(root, '@no/such/file.js');
    assert.ok(r.warnings.length >= 1);
    assert.ok(!r.contextBlock || !r.contextBlock.includes('### file: no/such'));
  });

  it('respects maxRefs budget', () => {
    write(root, 'f1.js', '1');
    write(root, 'f2.js', '2');
    write(root, 'f3.js', '3');
    const r = expandAtRefs(root, '@f1.js @f2.js @f3.js', { ...DEFAULT_CAPS, maxRefs: 2 });
    assert.ok(r.warnings.some((w) => /maxRefs|最多|ref/i.test(w)));
    const fileHeaders = (r.contextBlock || '').match(/### file:/g) || [];
    assert.equal(fileHeaders.length, 2);
  });

  it('truncates large file by maxFileLines / maxFileBytes', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n');
    write(root, 'big.js', lines);
    const r = expandAtRefs(root, '@big.js', {
      ...DEFAULT_CAPS,
      maxFileLines: 10,
      maxFileBytes: 64 * 1024,
    });
    assert.ok(r.warnings.some((w) => /截断|truncat|行|bytes/i.test(w)));
    assert.match(r.contextBlock, /L0/);
    assert.doesNotMatch(r.contextBlock, /L99/);
  });

  it('clamps range larger than maxRangeLines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `R${i}`).join('\n');
    write(root, 'range.js', lines);
    const r = expandAtRefs(root, '@range.js:1-80', {
      ...DEFAULT_CAPS,
      maxRangeLines: 5,
    });
    assert.ok(r.warnings.some((w) => /range|行|截断/i.test(w)));
    assert.match(r.contextBlock, /R0/);
    assert.doesNotMatch(r.contextBlock, /R79/);
  });

  it('stops adding refs when maxTotalBytes exceeded', () => {
    write(root, 'p1.js', 'A'.repeat(100));
    write(root, 'p2.js', 'B'.repeat(100));
    const r = expandAtRefs(root, '@p1.js @p2.js', {
      ...DEFAULT_CAPS,
      maxTotalBytes: 80,
      maxFileBytes: 1000,
    });
    assert.ok(r.warnings.some((w) => /预算|total|总/i.test(w)));
    // at least first ref should appear
    assert.match(r.contextBlock, /### file: p1\.js/);
  });

  it('skips binary files with warning', () => {
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const r = expandAtRefs(root, '@bin.dat');
    assert.ok(r.warnings.some((w) => /二进制|binary/i.test(w)));
    assert.ok(!r.contextBlock || !/[\x00]/.test(r.contextBlock));
  });

  it('returns empty context when no refs', () => {
    const r = expandAtRefs(root, 'hello without refs');
    assert.ok(!r.contextBlock);
    assert.deepEqual(r.refs, []);
    assert.deepEqual(r.warnings, []);
  });

  it('ignores fenced @ when expanding', () => {
    const text = '```\n@src/a.js\n```\nreal @src/b.js';
    const r = expandAtRefs(root, text);
    assert.match(r.contextBlock, /### file: src\/b\.js/);
    assert.doesNotMatch(r.contextBlock, /### file: src\/a\.js/);
  });
});
