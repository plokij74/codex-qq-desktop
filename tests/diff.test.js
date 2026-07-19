const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeUnifiedDiff, truncateDiff, isProbablyText } = require('../src/ai/diff');

describe('diff', () => {
  it('computeUnifiedDiff detects simple replace', () => {
    const r = computeUnifiedDiff('a.js', 'const x = 1;\n', 'const x = 2;\n');
    assert.equal(r.isBinary, false);
    assert.ok(r.stats.deletions >= 1);
    assert.ok(r.stats.additions >= 1);
    assert.match(r.text, /a\.js/);
    assert.match(r.text, /const x = 2/);
  });

  it('computeUnifiedDiff empty before is all additions', () => {
    const r = computeUnifiedDiff('new.txt', '', 'hello\n');
    assert.ok(r.stats.additions >= 1);
    assert.equal(r.stats.deletions, 0);
  });

  it('truncateDiff marks truncated and shortens', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { text, truncated } = truncateDiff(lines, { maxLines: 50, maxBytes: 1e9 });
    assert.equal(truncated, true);
    assert.match(text, /truncated/i);
    assert.ok(text.split('\n').length < 500);
  });

  it('isProbablyText rejects NUL', () => {
    assert.equal(isProbablyText('a\0b'), false);
    assert.equal(isProbablyText('hello\n'), true);
  });

  it('large line product falls back to full-replace without throwing', () => {
    // ~2500 x ~2500 would be > 2e6 product; keep test fast with moderate sizes
    // that still exceed sum cap (4000) so full-replace path is used.
    const a = Array.from({ length: 2500 }, (_, i) => `old-${i}`).join('\n') + '\n';
    const b = Array.from({ length: 2500 }, (_, i) => `new-${i}`).join('\n') + '\n';
    const r = computeUnifiedDiff('big.txt', a, b);
    assert.equal(r.isBinary, false);
    assert.equal(r.stats.deletions, 2500);
    assert.equal(r.stats.additions, 2500);
    assert.match(r.text, /old-0/);
    assert.match(r.text, /new-0/);
  });
});
