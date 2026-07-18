const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { grepFiles, globFiles } = require('../src/ai/search');

describe('search', () => {
  it('grep finds line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function runAgentLoop() {}\n');
    const r = grepFiles(root, { pattern: 'runAgentLoop', maxResults: 10 });
    assert.equal(r.ok, true);
    assert.ok(r.matches.some((m) => m.path.includes('a.js') && m.line === 1));
  });

  it('glob finds js', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.writeFileSync(path.join(root, 'x.js'), '1');
    fs.writeFileSync(path.join(root, 'y.txt'), '1');
    const r = globFiles(root, { pattern: '**/*.js' });
    assert.ok(r.files.some((f) => f.endsWith('x.js')));
    assert.ok(!r.files.some((f) => f.endsWith('y.txt')));
  });

  it('respects gitignore node_modules style via rules file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'h.js'), 'SECRET_TOKEN');
    fs.writeFileSync(path.join(root, 'app.js'), 'SECRET_TOKEN');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    const r = grepFiles(root, { pattern: 'SECRET_TOKEN' });
    assert.ok(r.matches.every((m) => !m.path.includes('node_modules')));
    assert.ok(r.matches.some((m) => m.path.includes('app.js')));
  });

  it('respects gitignore for non-SKIP_DIRS name (build_out/)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.mkdirSync(path.join(root, 'build_out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'build_out', 'out.js'), 'BUILD_OUT_SECRET');
    fs.writeFileSync(path.join(root, 'main.js'), 'BUILD_OUT_SECRET');
    fs.writeFileSync(path.join(root, '.gitignore'), 'build_out/\n');
    const r = grepFiles(root, { pattern: 'BUILD_OUT_SECRET' });
    assert.ok(r.matches.every((m) => !m.path.includes('build_out')));
    assert.ok(r.matches.some((m) => m.path.includes('main.js')));
  });

  it('unreadable directory is skipped; sibling files still grepped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.js'), 'LOCKED_SECRET_MARKER');
    fs.writeFileSync(path.join(root, 'visible.js'), 'VISIBLE_SECRET_MARKER');

    let chmodWorked = false;
    try {
      fs.chmodSync(locked, 0o000);
      try {
        fs.readdirSync(locked);
      } catch {
        chmodWorked = true;
      }
    } catch {
      // chmod may fail on some platforms
    }

    if (!chmodWorked) {
      // Restore if partial, then skip when OS still allows reading as root/owner.
      try { fs.chmodSync(locked, 0o755); } catch { /* ignore */ }
      // Skip: cannot create unreadable dir for this user.
      return;
    }

    try {
      const r = grepFiles(root, { pattern: 'SECRET_MARKER' });
      assert.ok(r.matches.some((m) => m.path.includes('visible.js')));
      assert.ok(r.matches.every((m) => !m.path.includes('locked')));
      assert.ok(!r.matches.some((m) => (m.text || '').includes('LOCKED_SECRET_MARKER')));
    } finally {
      try { fs.chmodSync(locked, 0o755); } catch { /* ignore */ }
    }
  });

  it('does not follow symlinks outside project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-in-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-out-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'OUTSIDE_ONLY_SECRET_STRING_XYZ');
    fs.writeFileSync(path.join(root, 'inside.js'), 'INSIDE_ONLY_MARKER');

    const linkPath = path.join(root, 'escape-link');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch (e) {
      // Symlink may require privileges on some platforms
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return;
      throw e;
    }

    const r = grepFiles(root, { pattern: 'OUTSIDE_ONLY_SECRET_STRING_XYZ' });
    assert.equal(r.matches.length, 0);
    const r2 = grepFiles(root, { pattern: 'INSIDE_ONLY_MARKER' });
    assert.ok(r2.matches.some((m) => m.path.includes('inside.js')));
  });
});
