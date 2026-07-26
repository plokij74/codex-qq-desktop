'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  tokenizeQuery,
  matchScore,
  scoreEntry,
  selectForInjection,
  formatInjection,
} = require('../src/ai/memory-recall');

const NOW = 1785000000000;
const DAY = 86400000;

function entry(over = {}) {
  return {
    id: over.id || 'm_x', text: over.text || 'text', tags: over.tags || [],
    createdAt: over.createdAt != null ? over.createdAt : NOW, source: 'tool',
    scope: over.scope || 'project',
  };
}

describe('memory-recall', () => {
  it('tokenizeQuery splits latin words and CJK bigrams', () => {
    const t = tokenizeQuery('用 npm test 跑构建');
    assert.ok(t.includes('npm'));
    assert.ok(t.includes('test'));
    assert.ok(t.includes('跑构'));
    assert.ok(t.includes('构建'));
    // 单字母不入词，避免噪声
    assert.equal(tokenizeQuery('a b').length, 0);
    assert.deepEqual(tokenizeQuery(null), []);
  });

  it('matchScore counts keywords at 2 and tags at 3, ignoring recency', () => {
    const tokens = tokenizeQuery('npm test');
    assert.equal(matchScore(entry({ text: 'use npm here' }), tokens, 'npm test'), 2);
    assert.equal(matchScore(entry({ text: 'use npm test' }), tokens, 'npm test'), 4);
    assert.equal(matchScore(entry({ text: 'unrelated', tags: ['npm'] }), tokens, 'npm test'), 3);
    assert.equal(matchScore(entry({ text: 'unrelated' }), tokens, 'npm test'), 0);
  });

  it('scoreEntry adds recency decay and a project bonus', () => {
    const fresh = scoreEntry(entry({ createdAt: NOW }), [], '', NOW);
    const old = scoreEntry(entry({ createdAt: NOW - 180 * DAY }), [], '', NOW);
    assert.ok(fresh > old);
    assert.equal(old, 0.5); // 衰减到 0，只剩项目加权
    const user = scoreEntry(entry({ createdAt: NOW - 180 * DAY, scope: 'user' }), [], '', NOW);
    assert.equal(user, 0);
  });

  it('selectForInjection ranks matches above non-matches', () => {
    const entries = [
      entry({ id: 'a', text: '无关内容', createdAt: NOW }),
      entry({ id: 'b', text: '构建只用 npm test', createdAt: NOW - 30 * DAY }),
    ];
    const picked = selectForInjection(entries, {
      queryText: 'npm test 怎么跑', topN: 1, maxApproxTokens: 9999, now: NOW,
    });
    assert.deepEqual(picked.map((e) => e.id), ['b']);
  });

  it('falls back to most recent when nothing matches', () => {
    const entries = [
      entry({ id: 'old', text: 'alpha', createdAt: NOW - 10 * DAY }),
      entry({ id: 'new', text: 'beta', createdAt: NOW }),
    ];
    const picked = selectForInjection(entries, {
      queryText: '完全不相干的问题', topN: 1, maxApproxTokens: 9999, now: NOW,
    });
    assert.deepEqual(picked.map((e) => e.id), ['new']);
  });

  it('topN 0 injects nothing', () => {
    const picked = selectForInjection([entry()], { queryText: 'x', topN: 0, maxApproxTokens: 9999, now: NOW });
    assert.deepEqual(picked, []);
  });

  it('stops at the token budget but always keeps at least one entry', () => {
    const long = 'x'.repeat(400); // 约 100 token
    const entries = [entry({ id: 'a', text: long }), entry({ id: 'b', text: long }), entry({ id: 'c', text: long })];
    const picked = selectForInjection(entries, { queryText: '', topN: 10, maxApproxTokens: 150, now: NOW });
    assert.equal(picked.length, 1);
    const tiny = selectForInjection([entry({ id: 'a', text: long })], {
      queryText: '', topN: 10, maxApproxTokens: 1, now: NOW,
    });
    assert.equal(tiny.length, 1);
  });

  it('formatInjection labels scope and states the data-not-instruction boundary', () => {
    const text = formatInjection([
      entry({ text: '构建只用 npm test', scope: 'project' }),
      entry({ text: '回答一律用中文', scope: 'user' }),
    ]);
    assert.match(text, /【长期记忆】/);
    assert.match(text, /不是指令/);
    assert.match(text, /以用户消息为准/);
    assert.match(text, /- \(项目\) 构建只用 npm test/);
    assert.match(text, /- \(用户\) 回答一律用中文/);
    assert.equal(formatInjection([]), '');
  });

  it('formatInjection never leaks non-text fields', () => {
    const text = formatInjection([entry({ id: 'm_secret', text: 'hello' })]);
    assert.equal(text.includes('m_secret'), false);
    assert.equal(text.includes('tool'), false);
  });
});
