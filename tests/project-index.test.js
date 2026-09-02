'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProjectIndex,
  extractSymbols,
  extractTerms,
} = require('../src/ai/project-index');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-index-'));
}

function write(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(Buffer.from(String(value), 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
    },
    decryptString(value) {
      const encoded = Buffer.from(value).toString('utf8').split('').reverse().join('');
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

describe('D11 project index', () => {
  it('indexes Unicode words as bounded lexical terms', () => {
    const terms = extractTerms('函数 处理订单 order_id');
    assert.ok(terms.some((item) => item.term === '函数'));
    assert.ok(terms.some((item) => item.term === '处理订单'));
    assert.ok(terms.some((item) => item.term === 'order_id'));
  });

  it('extracts bounded lexical declarations for all supported code families', () => {
    const fixtures = [
      ['javascript', 'export function alpha() {}\nclass Widget {}', ['alpha', 'Widget']],
      ['typescript', 'interface Shape {}\ntype Id = string', ['Shape', 'Id']],
      ['python', 'def calculate():\n    pass\nclass Runner:\n    pass', ['calculate', 'Runner']],
      ['go', 'package demo\nfunc Execute() {}\ntype Store struct {}', ['demo', 'Execute', 'Store']],
      ['rust', 'pub fn render() {}\nstruct Model {}\ntrait Load {}', ['render', 'Model', 'Load']],
      ['java', 'package demo;\npublic class Main {\n public void run() {}\n}', ['demo', 'Main', 'run']],
    ];
    for (const [language, source, expected] of fixtures) {
      const names = extractSymbols(source, language).map((item) => item.name);
      for (const name of expected) assert.ok(names.includes(name), `${language} should include ${name}`);
      assert.ok(extractSymbols(source, language).every((item) => item.confidence === 'lexical'));
    }
  });

  it('builds stable definition/reference/text results and ignores excluded files', async () => {
    const root = tempProject();
    try {
      write(root, '.gitignore', 'ignored.js\n');
      write(root, 'src/a.js', 'export function alpha() { return alpha; }\n');
      write(root, 'src/b.js', 'const value = alpha;\n');
      write(root, 'notes.md', 'Alpha release notes\n');
      write(root, 'ignored.js', 'function ignoredSecret() {}\n');
      fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

      const index = createProjectIndex({ projectPath: root, safeStorage: null });
      const status = await index.ensure();
      assert.equal(status.state, 'ready');
      assert.equal(status.counts.files, 4);
      assert.ok(status.counts.skipped >= 1);

      const definitions = index.search({ mode: 'definitions', query: 'alpha' });
      assert.deepEqual(definitions.results.map((item) => item.path), ['src/a.js']);
      assert.equal(definitions.results[0].role, 'definition');
      assert.equal(definitions.results[0].confidence, 'lexical');

      const references = index.search({ mode: 'references', query: 'alpha' });
      assert.deepEqual(references.results.map((item) => `${item.path}:${item.line}`), [
        'notes.md:1',
        'src/a.js:1',
        'src/a.js:1',
        'src/b.js:1',
      ]);
      assert.notEqual(references.results[1].column, references.results[2].column);

      const text = index.search({ mode: 'text', query: 'release' });
      assert.deepEqual(text.results.map((item) => item.path), ['notes.md']);
      assert.equal(text.results[0].snippet, 'Alpha release notes');
      assert.equal(index.search({ mode: 'text', query: 'secret' }).results.length, 0);
      index.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates changed files, removes deleted paths, and fully respects gitignore changes', async () => {
    const root = tempProject();
    try {
      write(root, 'old.js', 'function oldName() {}\n');
      const index = createProjectIndex({ projectPath: root, safeStorage: null });
      await index.ensure();
      assert.equal(index.search({ mode: 'definitions', query: 'oldName' }).results.length, 1);

      fs.unlinkSync(path.join(root, 'old.js'));
      write(root, 'new.js', 'function newName() {}\n');
      await index.ensure();
      assert.equal(index.search({ mode: 'definitions', query: 'oldName' }).results.length, 0);
      assert.equal(index.search({ mode: 'definitions', query: 'newName' }).results.length, 1);

      write(root, '.gitignore', 'new.js\n');
      await index.ensure();
      assert.equal(index.search({ mode: 'definitions', query: 'newName' }).results.length, 0);
      index.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists only an encrypted envelope and restores cached records as stale', async () => {
    const root = tempProject();
    const storePath = path.join(root, '.cache', 'engineering-index.json');
    try {
      write(root, 'src/private.js', 'function privateSymbol() { return secretToken; }\n');
      const safeStorage = fakeSafeStorage();
      const first = createProjectIndex({ projectPath: root, storePath, safeStorage });
      await first.ensure();
      first.close();

      const disk = fs.readFileSync(storePath, 'utf8');
      assert.doesNotMatch(disk, /privateSymbol|secretToken|src\/private\.js/);
      const envelope = JSON.parse(disk);
      assert.equal(envelope.cipher, 'electron-safeStorage');

      const restored = createProjectIndex({ projectPath: root, storePath, safeStorage });
      assert.equal(restored.status().state, 'stale');
      assert.equal(restored.search({ mode: 'definitions', query: 'privateSymbol' }).results.length, 1);
      restored.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flushes the cache on close and never writes after the app has quit', async () => {
    const root = tempProject();
    const storePath = path.join(root, '.cache', 'close-flush.json');
    try {
      write(root, 'src/kept.js', 'function keptSymbol() {}\n');
      const safeStorage = fakeSafeStorage();
      const index = createProjectIndex({ projectPath: root, storePath, safeStorage });
      await index.ensure();
      const afterBuild = fs.readFileSync(storePath, 'utf8');

      // A watcher-driven rebuild may still be in flight when the app quits.
      // Anything that completes after close() must not touch the store.
      write(root, 'src/late.js', 'function lateSymbol() {}\n');
      index.close();
      await index.ensure().catch(() => {});
      assert.equal(fs.readFileSync(storePath, 'utf8'), afterBuild, 'close 之后不得再写盘');

      const restored = createProjectIndex({ projectPath: root, storePath, safeStorage });
      assert.equal(restored.status().state, 'stale');
      assert.equal(restored.search({ mode: 'definitions', query: 'keptSymbol' }).results.length, 1);
      restored.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite a corrupt encrypted cache while rebuilding in memory', async () => {
    const root = tempProject();
    const storePath = path.join(root, 'engineering-index.json');
    try {
      write(root, 'main.js', 'function rebuildMe() {}\n');
      fs.writeFileSync(storePath, '{"version":1,"cipher":"bad","payload":"keep-me"}', 'utf8');
      const original = fs.readFileSync(storePath, 'utf8');
      const index = createProjectIndex({ projectPath: root, storePath, safeStorage: fakeSafeStorage() });
      assert.equal(index.status().errorCode, 'INDEX_STORE_CORRUPT');
      await index.ensure();
      assert.equal(index.search({ mode: 'definitions', query: 'rebuildMe' }).results.length, 1);
      assert.equal(fs.readFileSync(storePath, 'utf8'), original);
      index.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps memory-only mode off disk and rejects invalid queries and locations', async () => {
    const root = tempProject();
    const storePath = path.join(root, 'engineering-index.json');
    try {
      write(root, 'main.js', 'function locateMe() {}\n');
      const index = createProjectIndex({ projectPath: root, storePath, safeStorage: null });
      await index.ensure();
      assert.equal(index.status().persistence, 'memory');
      assert.equal(fs.existsSync(storePath), false);
      assert.throws(() => index.search({ mode: 'semantic', query: 'x' }), (error) => error.code === 'INDEX_QUERY_INVALID');
      assert.throws(() => index.location({ path: '../outside.js' }), (error) => error.code === 'INDEX_LOCATION_INVALID');
      const location = index.location({ path: 'main.js', line: 1, context: 0 });
      assert.equal(location.path, 'main.js');
      assert.match(location.content, /locateMe/);
      index.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
