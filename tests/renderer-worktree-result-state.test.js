'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/renderer/worktree-result-state');

function result(overrides = {}) {
  return {
    id: 'wt_ab12cd34', state: 'ready', projectId: 'p1', sessionId: 's1',
    subagentId: 'sa1', goal: '修改设置', createdAt: 10, baseHead: 'a'.repeat(40),
    updatedAt: 10,
    files: [{ path: 'src/a.js', status: 'M', binary: false }],
    stats: { files: 1, additions: 2, deletions: 0, binaryFiles: 0 },
    canApply: true, canDiscard: true, canPreview: true, ...overrides,
  };
}

describe('D5 renderer result state', () => {
  it('filters corrupt refs and strips filesystem authority fields', () => {
    const out = state.normalizeOne({ ...result(), checkout: 'C:/secret', patch: 'x', repoRoot: 'C:/repo' });
    assert.equal(out.id, 'wt_ab12cd34');
    assert.equal('checkout' in out, false);
    assert.equal('patch' in out, false);
    assert.equal('repoRoot' in out, false);
    assert.equal(state.normalizeOne({ ...result(), id: '../bad' }), null);
    assert.equal(state.normalizeOne({ ...result(), state: 'unknown' }), null);
  });

  it('merges by opaque id and keeps newest state', () => {
    const first = state.normalizeList([result()]);
    const merged = state.merge(first, [result({ state: 'conflict', updatedAt: 12, errorCode: 'BASE_CHANGED' })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].state, 'conflict');
    const stale = state.merge(merged, [result({ state: 'ready', updatedAt: 11 })]);
    assert.equal(stale[0].state, 'conflict');
    assert.equal(state.remove(merged, 'wt_ab12cd34').length, 0);
  });

  it('does not impose a renderer unresolved cap', () => {
    const items = Array.from({ length: 5 }, (_, i) => result({ id: `wt_${String(i).padStart(6, '0')}`, createdAt: i }));
    assert.equal(state.unresolved(items).length, 5);
  });

  it('replaces one project authoritatively and preserves other projects', () => {
    const other = result({ id: 'wt_other1', projectId: 'p2', updatedAt: 100 });
    const stale = result({ state: 'conflict', updatedAt: 100 });
    const incoming = result({ state: 'ready', updatedAt: 1 });
    const out = state.replaceAuthoritative([stale, other], [incoming], 'p1');
    assert.equal(out.length, 2);
    assert.equal(out.find((item) => item.projectId === 'p1').state, 'ready');
    assert.equal(out.find((item) => item.projectId === 'p2').id, 'wt_other1');
  });
});
