'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRepairManager } = require('../src/ai/repair-manager');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { canonicalProjectPath } = require('../src/ai/project-index');
const { fixture, eventually, deferred } = require('./helpers/pr-review-fixture');

describe('D16 D13 single-thread repair reuse', () => {
  it('uses a six-turn isolated repair with a fixed marker goal and no discussion in persisted or public events', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const events = []; const seen = [];
    const repairs = createRepairManager({ prReviewManager: f.manager, worktree: f.worktree,
      settings: { permissionMode: 'full-auto' }, onEvent: (event) => events.push(event),
      subagentRuntime: { runIsolatedImplement: async (ctx, request) => {
        seen.push(request); assert.equal(request.maxTurns, 6);
        assert.equal(request.markerGoal, '处理 PR 审查反馈');
        assert.equal(ctx.project.path, canonicalProjectPath(f.root));
        const made = await request.createWorktree({ project: ctx.project, goal: request.markerGoal, signal: ctx.signal });
        return { ok: made.ok, terminalReason: 'completed', result: { id: 'wt_review01', changed: true } };
      } },
    });
    t.after(() => repairs.close());
    const started = await repairs.start(f.root, { source: { kind: 'pr_review', reviewRef: saved.reviewRef }, note: 'Keep the existing API.' });
    assert.equal(started.ok, true, started.error);
    await eventually(() => repairs.get(f.root, started.repairRef), (out) => out.repair.status === 'ready');
    assert.match(seen[0].goal, /不可信任务数据/); assert.match(seen[0].goal, /Handle an empty input/); assert.match(seen[0].goal, /Keep the existing API/);
    const summary = repairs.get(f.root, started.repairRef).repair;
    assert.deepEqual(summary.source, { kind: 'pr_review', reviewRef: saved.reviewRef });
    assert.equal(summary.validationProfile, undefined); assert.equal(summary.resultId, 'wt_review01');
    assert.doesNotMatch(JSON.stringify([repairs.store.list(), events, f.worktrees]), /Handle an empty|Keep the existing|reviewText|"prompt"/);
  });
  it('rejects a complete prompt over 32 KiB including the note and emits no queued repair', async (t) => {
    const f = fixture(t); f.state.threads[0].comments.nodes[0].body = 'x'.repeat(31_800);
    const saved = await f.snapshot(); let runs = 0;
    const repairs = createRepairManager({ prReviewManager: f.manager, settings: { permissionMode: 'full-auto' }, runImplement: async () => { runs++; } });
    t.after(() => repairs.close());
    const out = await repairs.start(f.root, { source: { kind: 'pr_review', reviewRef: saved.reviewRef }, note: 'n'.repeat(2000) });
    assert.equal(out.code, 'PR_REVIEW_CONTEXT_TOO_LARGE'); assert.equal(runs, 0); assert.equal(repairs.list(f.root).repairs.length, 0);
  });
  it('rechecks the discussion after approval and prevents a second active repair', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const started = deferred(); const finish = deferred();
    const repairs = createRepairManager({ prReviewManager: f.manager, settings: { permissionMode: 'confirm-writes' },
      runImplement: async () => { started.resolve(); return finish.promise; } }); t.after(() => repairs.close());
    const payload = { source: { kind: 'pr_review', reviewRef: saved.reviewRef } };
    const changed = await repairs.start(f.root, payload, { gate: { authorize: async () => { f.state.threads[0].line = 3; return { allowed: true }; } } });
    assert.equal(changed.code, 'PR_REVIEW_CHANGED'); assert.equal(repairs.list(f.root).repairs.length, 0);
    f.state.threads[0].line = 2;
    const first = await repairs.start(f.root, payload, { gate: f.gate }); await started.promise;
    assert.equal((await repairs.start(f.root, payload, { gate: f.gate })).code, 'REPAIR_ALREADY_RUNNING');
    finish.resolve({ ok: true, terminalReason: 'completed', result: { changed: false } });
    await eventually(() => repairs.get(f.root, first.repairRef), (out) => out.repair.status === 'no_changes');
    f.state.threads[0].comments.nodes[0].body += ' changed';
    assert.equal((await repairs.retry(f.root, first.repairRef, {}, { gate: f.gate })).code, 'PR_REVIEW_CHANGED');
  });
  it('freezes the optional local validation profile and does not require it to generate a review repair', async (t) => {
    const f = fixture(t); const saved = await f.snapshot();
    const profile = { id: 'vfy_' + 'a'.repeat(8), name: 'Tests', kind: 'test', command: 'node --test', cwd: '.', enabled: true, timeoutMs: 5000 };
    const repairs = createRepairManager({ prReviewManager: f.manager, settings: { permissionMode: 'full-auto' },
      getProfiles: () => [profile], runImplement: async () => ({ ok: true, terminalReason: 'completed', result: { id: 'wt_profile1', changed: true } }) }); t.after(() => repairs.close());
    const input = { source: { kind: 'pr_review', reviewRef: saved.reviewRef }, validationProfileId: 'vfy_missing' };
    assert.equal((await repairs.start(f.root, input)).code, 'REMOTE_CI_VALIDATION_PROFILE_NOT_FOUND');
    const out = await repairs.start(f.root, { ...input, validationProfileId: profile.id }); assert.equal(out.ok, true);
    assert.equal(out.repair.validationProfile.profileId, profile.id);
    assert.match(out.repair.validationProfile.profileFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(out.repair.validation.status, 'not_run');
    await eventually(() => repairs.get(f.root, out.repairRef), (value) => value.repair.status === 'ready');
  });
  it('retains the sender cancellation signal until generation finishes and keeps partial D5 results', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const entered = deferred(); const events = [];
    const token = 'pb_' + 'a'.repeat(32); const owner = { sender: { id: 1, isDestroyed: () => false } };
    const handlers = createEngineeringIpcHandlers({ prReviewManager: f.manager, worktreeManager: f.worktree,
      getSettings: () => ({ permissionMode: 'full-auto' }), onRepairEvent: (event) => events.push(event),
      subagentRuntime: { runIsolatedImplement: async (ctx) => {
        entered.resolve(ctx.signal);
        return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: true, terminalReason: 'aborted', incomplete: true, result: { id: 'wt_partial1', changed: true } }), { once: true }));
      } },
    }); t.after(() => handlers.close());
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root });
    const first = await handlers.repairStart(owner, { projectBindingId: token, source: { kind: 'pr_review', reviewRef: saved.reviewRef } });
    assert.equal(first.ok, true, first.error); const signal = await entered.promise;
    handlers.unbind(owner, { projectBindingId: token }); assert.equal(signal.aborted, true);
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root });
    const final = await eventually(() => handlers.repairGet(owner, { projectBindingId: token, repairRef: first.repairRef }), (out) => out.repair?.status === 'cancelled');
    assert.equal(final.repair.resultId, 'wt_partial1'); assert.equal(final.repair.incomplete, true);
    assert.doesNotMatch(JSON.stringify(events), /Handle an empty|comments|reviewText|"prompt"/);
  });
});
