const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveVerifyCommand } = require('../src/ai/verify');

describe('verify', () => {
  it('settings wins', () => {
    assert.equal(resolveVerifyCommand('/x', { verifyCommand: 'pnpm test' }), 'pnpm test');
  });

  it('none disables', () => {
    assert.equal(resolveVerifyCommand('/x', { verifyCommand: 'none' }), null);
    assert.equal(resolveVerifyCommand('/x', { verifyCommand: '-' }), null);
    assert.equal(resolveVerifyCommand('/x', { verifyCommand: 'NONE' }), null);
  });

  it('package.json scripts.test → npm test', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node test.js' } }),
    );
    assert.equal(resolveVerifyCommand(root, { verifyCommand: '' }), 'npm test');
  });

  it('no test script → null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'a' }));
    assert.equal(resolveVerifyCommand(root, {}), null);
  });

  it('no project path and empty settings → null', () => {
    assert.equal(resolveVerifyCommand(null, { verifyCommand: '' }), null);
  });
});
