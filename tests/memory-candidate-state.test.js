'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  textKey,
  candidateKey,
  normalizeProjectRef,
  projectRefMatches,
  normalizePendingCandidates,
  mergePendingCandidates,
  removePendingCandidates,
  candidateLimit,
  buildAcceptPayload,
  filterStoredDuplicates,
} = require('../src/renderer/memory-candidate-state');

const projectRef = { id: 'p1', path: 'D:\\Repo\\' };

describe('D.4 renderer candidate state', () => {
  it('treats a missing legacy session field as an empty inbox', () => {
    assert.deepEqual(normalizePendingCandidates(undefined), []);
  });

  it('normalizes user candidates and filters corrupt project candidates', () => {
    const out = normalizePendingCandidates([
      { id: 'mc_1', text: '  偏好中文  ', tags: [' UI ', 'ui'], evidence: '用户：偏好中文', scope: 'user', createdAt: 10 },
      { id: 'mc_2', text: '项目约定', tags: [], evidence: '项目约定', scope: 'project', projectRef: null, createdAt: 11 },
      null,
    ]);
    assert.deepEqual(out, [{
      id: 'mc_1', text: '偏好中文', tags: ['ui'], evidence: '用户：偏好中文',
      scope: 'user', projectRef: null, edited: false, createdAt: 10,
    }]);
  });

  it('matches Windows project paths independent of slash, case and trailing separator', () => {
    assert.deepEqual(normalizeProjectRef(projectRef), { id: 'p1', path: 'D:/Repo' });
    assert.deepEqual(normalizeProjectRef({ id: 'root', path: 'D:\\' }), { id: 'root', path: 'D:/' });
    assert.equal(normalizeProjectRef({ id: 'p1', path: 'relative/repo' }), null);
    assert.equal(projectRefMatches(projectRef, { id: 'p1', path: 'd:/repo' }), true);
    assert.equal(projectRefMatches(projectRef, { id: 'p2', path: 'd:/repo' }), false);
    assert.equal(projectRefMatches(projectRef, { id: 'p1', path: 'd:/other' }), false);
  });

  it('merges in order, exact-dedupes and reports overflow', () => {
    const existing = [{
      id: 'mc_old', text: '保留旧项', tags: [], evidence: '旧证据',
      scope: 'user', projectRef: null, createdAt: 1,
    }];
    let nextId = 0;
    const merged = mergePendingCandidates(existing, [
      { text: ' 保留旧项 ', tags: [], evidence: '旧证据', scope: 'user' },
      { text: '新增一', tags: ['A'], evidence: '证据一' },
      { text: '新增二', tags: [], evidence: '证据二' },
    ], {
      max: 2, defaultScope: 'project', projectRef,
      now: 20, idFactory: () => 'mc_new_' + (++nextId),
    });
    assert.deepEqual(merged.items.map((x) => x.text), ['保留旧项', '新增一']);
    assert.equal(merged.items[1].scope, 'project');
    assert.equal(merged.added, 1);
    assert.equal(merged.dropped, 1);
  });

  it('lets an explicit incoming scope override the batch default', () => {
    const merged = mergePendingCandidates([], [{
      text: '跨项目偏好', tags: [], evidence: '用户明确表达跨项目偏好', scope: 'user',
    }], { defaultScope: 'project', projectRef, now: 20, idFactory: () => 'mc_user' });
    assert.equal(merged.items[0].scope, 'user');
    assert.equal(merged.items[0].projectRef, null);
  });

  it('replaces malformed persisted ids with a local mc_ id', () => {
    const merged = mergePendingCandidates([], [{
      id: '<bad-id>', text: '有效内容', tags: [], evidence: '有效证据', scope: 'user',
    }], { idFactory: () => 'mc_safe', now: 20 });
    assert.equal(merged.items[0].id, 'mc_safe');
  });

  it('removes selected ids without mutating input', () => {
    const input = [
      { id: 'mc_1', text: 'a', tags: [], evidence: 'a', scope: 'user', projectRef: null, createdAt: 1 },
      { id: 'mc_2', text: 'b', tags: [], evidence: 'b', scope: 'user', projectRef: null, createdAt: 2 },
    ];
    const out = removePendingCandidates(input, ['mc_1']);
    assert.deepEqual(out.map((x) => x.id), ['mc_2']);
    assert.equal(input.length, 2);
  });

  it('computes remaining per-batch capacity', () => {
    assert.equal(candidateLimit([], { perBatch: 5, max: 20 }), 5);
    assert.equal(candidateLimit(Array(18).fill({}), { perBatch: 5, max: 20 }), 2);
    assert.equal(candidateLimit(Array(20).fill({}), { perBatch: 5, max: 20 }), 0);
  });

  it('keeps the first 20 normalized rows in stable order', () => {
    const input = Array.from({ length: 25 }, (_, index) => ({
      id: 'mc_' + index,
      text: '候选-' + index,
      tags: [],
      evidence: '证据-' + index,
      scope: 'user',
      projectRef: null,
      createdAt: index + 1,
    }));
    const out = normalizePendingCandidates(input);
    assert.equal(out.length, 20);
    assert.deepEqual(out.map((item) => item.text), input.slice(0, 20).map((item) => item.text));
  });

  it('uses folded case-insensitive keys for exact dedupe', () => {
    assert.equal(textKey('  NPM   TEST '), textKey('npm test'));
    assert.notEqual(
      candidateKey({ scope: 'user', text: 'npm test' }),
      candidateKey({ scope: 'project', text: 'npm test' })
    );
  });

  it('dedupes only within the same scope and keeps invalid drafts', () => {
    const result = mergePendingCandidates([], [
      { text: '同一文本', tags: [], evidence: '证据', scope: 'user' },
      { text: '同一文本', tags: [], evidence: '证据', scope: 'project', projectRef },
      { text: '同一文本', tags: [], evidence: '证据', scope: 'user' },
    ], { max: 20 });
    assert.deepEqual(result.items.map((item) => item.scope), ['user', 'project']);

    const draft = normalizePendingCandidates([{
      id: 'mc_draft', text: '', tags: ['x'], evidence: '证据', scope: 'user', edited: true,
    }]);
    assert.equal(draft.length, 1);
    assert.equal(draft[0].text, '');
    assert.equal(draft[0].edited, true);
  });

  it('builds a user accept payload without leaking evidence or candidate id', () => {
    const result = buildAcceptPayload({
      id: 'mc_1', text: '偏好中文', tags: ['ui'], evidence: '用户：偏好中文',
      scope: 'user', projectRef: null, createdAt: 1,
    }, projectRef);
    assert.deepEqual(result, {
      ok: true,
      payload: { scope: 'user', text: '偏好中文', tags: ['ui'] },
    });
    assert.equal('evidence' in result.payload, false);
    assert.equal('id' in result.payload, false);
  });

  it('accepts a matching project snapshot and rejects unbound or rebound projects', () => {
    const candidate = {
      id: 'mc_1', text: '项目约定', tags: ['build'], evidence: '项目约定',
      scope: 'project', projectRef, createdAt: 1,
    };
    assert.deepEqual(buildAcceptPayload(candidate, { id: 'p1', path: 'd:/repo/' }), {
      ok: true,
      payload: { projectPath: 'D:/Repo', scope: 'project', text: '项目约定', tags: ['build'] },
    });
    for (const current of [
      null,
      { id: 'p2', path: 'D:/Repo' },
      { id: 'p1', path: 'D:/Other' },
    ]) {
      const result = buildAcceptPayload(candidate, current);
      assert.equal(result.ok, false);
      assert.match(result.error, /项目已变更/);
    }
  });

  it('filters exact stored duplicates without mutating the pending input', () => {
    const pending = [
      { id: 'mc_1', text: '项目约定', tags: [], evidence: '项目约定', scope: 'project', projectRef, createdAt: 1 },
      { id: 'mc_2', text: '项目约定', tags: [], evidence: '项目约定', scope: 'user', projectRef: null, createdAt: 2 },
      { id: 'mc_3', text: '已编辑重复', tags: [], evidence: '已编辑重复', scope: 'project', projectRef, edited: true, createdAt: 3 },
    ];
    const out = filterStoredDuplicates(pending, [{ scope: 'project', text: '  项目约定  ' }]);
    assert.deepEqual(out.map((item) => item.id), ['mc_2', 'mc_3']);
    assert.equal(pending.length, 3);
  });

  it('keeps an unedited project candidate when the current project snapshot changed', () => {
    const pending = [{
      id: 'mc_old', text: '项目约定', tags: [], evidence: '项目约定', scope: 'project',
      projectRef, createdAt: 1,
    }];
    const out = filterStoredDuplicates(
      pending,
      [{ scope: 'project', text: '项目约定' }],
      { id: 'p2', path: 'D:/other' }
    );
    assert.deepEqual(out.map((item) => item.id), ['mc_old']);
  });
});
