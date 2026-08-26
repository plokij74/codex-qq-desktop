'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/renderer/pr-state');

describe('D7 renderer PR state', () => {
  it('normalizes bounded detail data without accepting invalid URLs', () => {
    const pr = state.normalize({
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
      title: 'Change',
      body: 'Body',
      state: 'open',
      isDraft: false,
      headSha: 'a'.repeat(40),
      checksSummary: { total: 1, passed: 1 },
      checks: [{ name: 'test', bucket: 'pass' }],
      comments: [{ author: 'alice', body: 'ok' }],
      files: [{ path: 'src/a.js', additions: 2, deletions: 1 }],
    }, { detail: true });
    assert.equal(pr.state, 'OPEN');
    assert.equal(pr.checksSummary.passed, 1);
    assert.equal(pr.comments[0].body, 'ok');
    assert.equal(pr.files[0].path, 'src/a.js');
    assert.equal(state.normalize({ number: 7, url: 'javascript:alert(1)' }), null);
  });

  it('deduplicates list entries by PR number', () => {
    const list = state.normalizeList([
      { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'OPEN' },
      { number: 7, url: 'https://github.com/acme/widget/pull/7', state: 'CLOSED' },
      { number: 8, url: 'https://github.com/acme/widget/pull/8', state: 'MERGED' },
    ]);
    assert.deepEqual(list.map((item) => item.number), [7, 8]);
  });
});
