'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

describe('E1 False Display Stop (G09 / Stop Bleeding)', () => {
  it('plugins view clarifies runtime is pending and does not claim fake success', () => {
    assert.doesNotMatch(appSource, /toast\(\(input\.checked \? '启用' : '禁用'\) \+ '插件成功'\)/);
    assert.match(appSource, /待 E21/);
  });

  it('sites view indicates demo configuration without fake healthy/degraded live badge', () => {
    assert.doesNotMatch(appSource, /<span class="badge '\s*\+\s*s\.status\s*\+\s*'">'\s*\+\s*s\.status\s*\+\s*'<\/span>/);
    assert.match(appSource, /待 E8|待 E18/);
  });

  it('friends list clearly denotes mock characters without fake online badge', () => {
    // Should not claim Randy Lu is real "在线" user
    assert.doesNotMatch(appSource, /name:\s*'Randy Lu',\s*avatar:\s*'🧑',\s*status:\s*'在线'/);
    assert.match(appSource, /模拟|示例/);
  });

  it('file upload provides clarity that non-image file content is not yet read by model', () => {
    assert.match(appSource, /待 E5|待 E7/);
  });

  it('seed data clarifies that initial KV and sessions are templates rather than live inspection results', () => {
    assert.match(appSource, /【示例】/);
  });
});
