const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveSafe,
  writeFile,
  readFile,
  searchReplace,
  parseWriteFences,
  applyWriteFences,
  listTree,
  isListIntent,
  isStructureIntent,
  buildTreeReply,
} = require('../src/ai/project-fs');
const { loadGitignoreRules } = require('../src/ai/gitignore');

describe('project-fs', () => {
  it('resolveSafe blocks path escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    assert.throws(() => resolveSafe(root, '../outside.txt'), /越界/);
  });

  it('write and read file inside project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a/b.txt', 'hello');
    const f = readFile(root, 'a/b.txt');
    assert.equal(f.content, 'hello');
  });

  it('applyWriteFences writes files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    const text = '说明\n\n```write:note.md\n# hi\n```\n';
    const r = applyWriteFences(root, text);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), '# hi');
  });

  it('parseWriteFences extracts ops', () => {
    const ops = parseWriteFences('```create:x.js\n1\n```');
    assert.equal(ops[0].path, 'x.js');
    assert.equal(ops[0].content, '1');
  });

  it('listTree walks nested dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    fs.mkdirSync(path.join(root, 'src', 'util'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'util', 'a.js'), '1');
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    const t = listTree(root, { maxDepth: 5, maxEntries: 100 });
    assert.match(t.treeText, /src\//);
    assert.match(t.treeText, /a\.js/);
    assert.ok(t.count >= 3);
  });

  it('intent detectors', () => {
    assert.equal(isListIntent('列出所有目录'), true);
    assert.equal(isStructureIntent('帮我整理目录结构'), true);
    assert.equal(isListIntent('写个登录页'), false);
  });

  it('buildTreeReply returns real tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    fs.writeFileSync(path.join(root, 'f.txt'), '1');
    const r = buildTreeReply({ name: 'demo', path: root }, '列出文件');
    assert.match(r.content, /真实扫盘|真实路径/);
    assert.match(r.content, /f\.txt/);
  });

  it('listTree skips paths matching ignoreRules from gitignore', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    fs.writeFileSync(path.join(root, 'visible.txt'), 'ok');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
    fs.writeFileSync(path.join(root, '.gitignore'), 'secret.txt\n');
    const rules = loadGitignoreRules(root);
    const t = listTree(root, { maxDepth: 5, maxEntries: 100, ignoreRules: rules, showDot: true });
    assert.match(t.treeText, /visible\.txt/);
    assert.doesNotMatch(t.treeText, /secret\.txt/);
  });

  it('searchReplace unique match', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a.js', 'const x = 1;\nconst y = 2;\n');
    const r = searchReplace(root, 'a.js', 'const x = 1;', 'const x = 42;');
    assert.equal(r.replacements, 1);
    assert.equal(readFile(root, 'a.js').content, 'const x = 42;\nconst y = 2;\n');
  });

  it('searchReplace fails on multiple matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a.js', 'foo\nfoo\n');
    assert.throws(() => searchReplace(root, 'a.js', 'foo', 'bar'), /次|multiple|多/i);
  });

  it('searchReplace replace_all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a.js', 'foo\nfoo\n');
    const r = searchReplace(root, 'a.js', 'foo', 'bar', { replaceAll: true });
    assert.equal(r.replacements, 2);
  });

  it('searchReplace unique match keeps $ tokens literal in newString', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a.js', 'price = OLD;\n');
    const r = searchReplace(root, 'a.js', 'OLD', 'cost is $& and $1');
    assert.equal(r.replacements, 1);
    assert.equal(readFile(root, 'a.js').content, 'price = cost is $& and $1;\n');
  });

  it('readFile offset limit with line numbers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    writeFile(root, 'a.txt', 'l1\nl2\nl3\nl4\n');
    const f = readFile(root, 'a.txt', { offset: 2, limit: 2 });
    assert.match(f.content, /2\|l2/);
    assert.match(f.content, /3\|l3/);
    assert.ok(!f.content.includes('l1') || !/1\|l1/.test(f.content));
  });

  it('readFile full read still enforces maxBytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    const big = 'x'.repeat(5000);
    writeFile(root, 'big.txt', big);
    assert.throws(
      () => readFile(root, 'big.txt', { maxBytes: 100 }),
      /过大|maxBytes|拒绝读取/i,
    );
  });

  it('readFile slice works when total size exceeds maxBytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
    // Build multi-line file larger than maxBytes
    const lines = [];
    for (let i = 1; i <= 200; i += 1) {
      lines.push(`line-${i}-${'y'.repeat(40)}`);
    }
    writeFile(root, 'large.txt', `${lines.join('\n')}\n`);
    const size = fs.statSync(path.join(root, 'large.txt')).size;
    assert.ok(size > 500, 'fixture should exceed maxBytes');

    const f = readFile(root, 'large.txt', { maxBytes: 500, offset: 50, limit: 3 });
    assert.equal(f.startLine, 50);
    assert.equal(f.endLine, 52);
    assert.match(f.content, /50\|line-50/);
    assert.match(f.content, /52\|line-52/);
    assert.doesNotMatch(f.content, /line-1-/);
    assert.ok(f.totalLines >= 200);
  });
});
