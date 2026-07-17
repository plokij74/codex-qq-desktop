const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateLocalReply } = require('../src/ai/local-mock');

describe('generateLocalReply', () => {
  it('returns non-empty string for empty input', () => {
    const r = generateLocalReply('');
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  });

  it('includes bash fence for migration keywords', () => {
    const r = generateLocalReply('帮我看 wrangler d1 migrations');
    assert.match(r, /```bash/);
    assert.match(r, /wrangler/i);
  });

  it('mentions user topic for generic chat', () => {
    const r = generateLocalReply('你好 Codex');
    assert.match(r, /你好 Codex|Codex/);
  });
});
