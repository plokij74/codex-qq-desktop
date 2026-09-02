'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDiagnostics, MAX_DIAGNOSTICS, MAX_MESSAGE } = require('../src/ai/verification-diagnostics');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-diag-'));
  for (const rel of ['src/app.ts', 'src/lint.js', 'tests/test_app.py', 'pkg/main.go', 'src/main.rs', 'src/Main.java']) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', 'utf8');
  }
  return root;
}

describe('D11 verification diagnostics', () => {
  it('normalizes common compiler, linter, test, Go, Rust, and Java formats', () => {
    const root = project();
    try {
      const output = [
        'src/app.ts(2,4): error TS2322: Type mismatch',
        'src/lint.js: line 3, col 5, Warning - Unexpected value (no-alert)',
        'tests/test_app.py:7: AssertionError: expected true',
        'pkg/main.go:8:2: undefined: thing',
        '--> src/main.rs:9:6',
        'src/Main.java:10: error: cannot find symbol',
        'src/Main.java:[11,3] warning: deprecated API',
      ].join('\n');
      const result = parseDiagnostics(output, { projectRoot: root });
      assert.equal(result.diagnostics.length, 7);
      assert.deepEqual(result.diagnostics.map((item) => item.path), [
        'src/app.ts', 'src/lint.js', 'tests/test_app.py', 'pkg/main.go',
        'src/main.rs', 'src/Main.java', 'src/Main.java',
      ]);
      assert.equal(result.diagnostics[0].code, 'TS2322');
      assert.equal(result.diagnostics[1].severity, 'warning');
      assert.equal(result.diagnostics[1].source, 'eslint');
      assert.equal(result.diagnostics[4].source, 'rust');
      assert.equal(result.diagnostics[6].severity, 'warning');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attributes Jest and Vitest failure frames to the test runner', () => {
    const root = project();
    try {
      const output = [
        '    at Object.<anonymous> (src/app.ts:12:5)',
        ' ❯ tests/test_app.py:7:3',
        '    at Suite.run (src/lint.js:4:11)',
      ].join('\n');
      const result = parseDiagnostics(output, { projectRoot: root });
      assert.equal(result.diagnostics.length, 3);
      // A real stack frame carries neither the word "jest" nor "vitest", so the
      // frame shape itself has to decide the source.
      assert.deepEqual(result.diagnostics.map((item) => item.source), ['test', 'test', 'test']);
      assert.equal(result.diagnostics[0].path, 'src/app.ts');
      assert.equal(result.diagnostics[0].line, 12);
      assert.equal(result.diagnostics[0].column, 5);
      assert.equal(result.diagnostics[1].path, 'tests/test_app.py');
      assert.equal(result.diagnostics[2].line, 4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps Go and pytest sources and reads a Rust error code', () => {
    const root = project();
    try {
      const output = [
        'pkg/main.go:8:2: undefined: thing',
        'tests/test_app.py:7: AssertionError: expected true',
        'error[E0308]: mismatched types',
        '  --> src/main.rs:9:6',
        'src/app.ts:3:1: note: declared here',
      ].join('\n');
      const result = parseDiagnostics(output, { projectRoot: root });
      const bySource = (name) => result.diagnostics.filter((item) => item.source === name);
      assert.equal(bySource('go').length, 1);
      assert.equal(bySource('pytest').length, 1);
      assert.equal(bySource('rust').length, 1);
      assert.equal(result.diagnostics.find((item) => item.path === 'src/app.ts').severity, 'info');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops paths outside the project and bounds count and message length', () => {
    const root = project();
    try {
      const outside = path.join(path.dirname(root), 'outside.ts').replace(/\\/g, '/');
      const lines = [`${outside}:1:1: error: do not expose this path`];
      for (let i = 0; i < MAX_DIAGNOSTICS + 10; i += 1) {
        lines.push(`src/app.ts:${i + 1}:1: error E1000: ${'x'.repeat(MAX_MESSAGE + 100)}`);
      }
      const result = parseDiagnostics(lines.join('\n'), { projectRoot: root });
      assert.equal(result.diagnostics.length, MAX_DIAGNOSTICS);
      assert.equal(result.truncated, true);
      assert.ok(result.skipped >= 1);
      assert.ok(result.diagnostics.every((item) => item.message.length <= MAX_MESSAGE));
      assert.ok(result.diagnostics.every((item) => !path.isAbsolute(item.path)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
