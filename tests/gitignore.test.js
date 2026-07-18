const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseGitignore, isIgnored } = require('../src/ai/gitignore');

describe('gitignore', () => {
  it('parses and matches simple patterns', () => {
    const rules = parseGitignore('# c\nnode_modules/\n*.log\ndist\n');
    assert.equal(isIgnored('node_modules/foo', rules), true);
    assert.equal(isIgnored('a.log', rules), true);
    assert.equal(isIgnored('src/a.js', rules), false);
  });
});
