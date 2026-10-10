'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/ai/pr-audit-state');
const R = require('../src/ai/pr-audit-recheck-state');
const { createRepairManager } = require('../src/ai/repair-manager');
const { followupFixture } = require('./helpers/pr-audit-recheck-repair-fixture');
const { eventually, deferred } = require('./helpers/pr-review-fixture');
it('D20 selects original-order still-present and unknown findings with no invented evidence', async (t) => {
  const f = await followupFixture(t); const ids = f.parent.source.findingIds;
  const before = structuredClone(f.parent);
  const saved = await f.snapshot([...ids].reverse()); assert.equal(saved.ok, true, saved.code);
  assert.deepEqual(saved.source.findingIds, ids);
  const source = await f.followups.materializeRepairSource(f.root, saved.recheckRepairRef);
  assert.equal(source.baseHead, f.parent.target.headSha);
  assert.notEqual(source.baseHead, f.parent.source.originalHead);
  assert.match(source.auditText, /ORIGINAL_FINDING_BODY/); assert.match(source.auditText, /UNKNOWN_PRIVATE_REASON/);
  assert.match(source.auditText, /PRIVATE_FIXED_CODE/);
  assert.deepEqual(f.rechecks.row(f.root, f.parent.recheckRef), before);
  assert.ok(f.snapshots20.every((s) => s.refNamespace === 'pr-audit-recheck-repair' && s.includeDiffs === false && s.cleaned));
  await source.createWorktree({ project: { path: f.root }, goal: '继续修复 PR 复审问题' });
  assert.deepEqual(f.worktrees[0].origin, { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef });
  assert.match(f.calls.find(([kind]) => kind === 'fetch')[1].targetRef, /^refs\/codex\/pr-audit-recheck-repair\/pcr_/);
});
it('D20 rejects invalid selections, changed content and stale or unavailable PR snapshots', async (t) => {
  const f = await followupFixture(t); const [id] = f.parent.source.findingIds;
  for (const ids of [[], [id, id], [A.ref('paf')], Array.from({ length: 6 }, () => A.ref('paf'))]) assert.equal((await f.snapshot(ids)).ok, false);
  const changed = structuredClone(f.parent); changed.report.findings[0].status = 'resolved'; f.rechecks.save(changed);
  assert.equal((await f.snapshot([id])).ok, false); f.rechecks.save(f.parent);
  assert.equal((await f.followups.snapshot(f.root, { recheckRef: f.parent.recheckRef,
    repairRevision: R.repairRevision(f.parent), findingIds: [id], headSha: f.parent.target.headSha })).ok, false);
  const saved = await f.snapshot([id]);
  for (const field of ['headSha', 'baseSha', 'body', 'headRefName', 'baseRefName']) {
    const old = f.state.pr[field]; f.state.pr[field] = field.endsWith('Sha') ? '1'.repeat(40) : old + '-changed';
    assert.equal((await f.snapshot([id])).ok, false); f.state.pr[field] = old;
  }
  const get = f.github.getAuditPr; f.github.getAuditPr = async () => { throw new Error('offline'); };
  assert.equal((await f.snapshot([id])).ok, false); f.github.getAuditPr = get;
  // Cached freshness is not authority; successful server verification can refresh an old cache.
  f.rechecks.save({ ...f.parent, freshness: 'unknown' });
  assert.equal((await f.snapshot([id])).ok, true);
  assert.equal(R.repairRevision({ ...f.parent, freshness: 'stale' }), R.repairRevision(f.parent));
  changed.report.findings[0].reason = 'mutated'; f.rechecks.save(changed);
  await assert.rejects(f.followups.resolveMetadata(f.root, saved.recheckRepairRef), /REPAIR_CHANGED/);
});
it('D20 continues two rounds with the root finding identity and each round own baseline', async (t) => {
  const f = await followupFixture(t); const ids = [f.parent.source.findingIds[1]];
  const saved = await f.snapshot(ids); assert.equal(saved.ok, true, saved.code);
  const first = f.deliver(saved.recheckRepairRef);
  const after = await f.done(await f.rechecks.start(f.root, first.id));
  assert.equal(after.status, 'completed', after.errorCode);
  assert.deepEqual(after.source.findingIds, ids);
  assert.equal(after.source.originalHead, f.parent.source.originalHead);
  assert.equal(after.source.originalBase, f.parent.source.originalBase);
  assert.equal(after.source.repairBaseHead, f.parent.target.headSha);
  assert.equal(after.source.parentRecheckRef, f.parent.recheckRef);
  assert.equal(after.source.recheckRepairRef, saved.recheckRepairRef);
  const next = await f.snapshot(ids, after); assert.equal(next.ok, true, next.code);
  const second = f.deliver(next.recheckRepairRef);
  const final = await f.done(await f.rechecks.start(f.root, second.id));
  assert.equal(final.status, 'completed', final.errorCode);
  assert.equal(final.source.repairBaseHead, after.target.headSha);
  assert.equal(final.source.originalHead, f.parent.source.originalHead);
  assert.deepEqual((await f.rechecks.get(f.root, final.recheckRef)).originalFindings.map((r) => r.findingId), ids);
  assert.equal((await f.rechecks.get(f.root, f.parent.recheckRef)).recheck.freshness, 'stale');
  assert.equal((await f.followups.source(f.root, next.recheckRepairRef)).source.recheckRef, after.recheckRef);
  await assert.rejects(f.followups.resolveMetadata(f.root, next.recheckRepairRef), /REPAIR_CHANGED/);
  assert.equal((await f.rechecks.list(f.root, 7)).deliveries.length, 3);
});
it('D20 rejects uncertain parent delivery and revalidates after generation approval', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot();
  f.marker.state = 'pr_update_uncertain';
  await assert.rejects(f.followups.resolveMetadata(f.root, saved.recheckRepairRef), /RECHECK_DELIVERY/);
  f.marker.state = 'pr_updated';
  let runs = 0;
  const repair = createRepairManager({ prAuditRecheckRepairManager: f.followups, settings: { permissionMode: 'confirm-writes' },
    runImplement: async () => { runs++; } }); t.after(() => repair.close());
  const out = await repair.start(f.root, { source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef } },
    { gate: { authorize: async () => { f.state.pr.headSha = '1'.repeat(40); return { allowed: true }; } } });
  assert.equal(out.code, 'PR_AUDIT_REPAIR_CHANGED'); assert.equal(runs, 0);
  assert.equal(repair.list(f.root).repairs.length, 0);
});
it('D20 uses six-turn D13 isolation, optional validation, metadata events and no-changes results', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot(); const calls = []; const events = []; const wait = deferred();
  const profile = { id: 'vfy_' + '1'.repeat(8), name: 'Tests', kind: 'test', command: 'node --test', cwd: '.', enabled: true, timeoutMs: 5000 };
  const repair = createRepairManager({ prAuditRecheckRepairManager: f.followups, worktree: f.worktree,
    settings: { permissionMode: 'full-auto', terminalEnabled: true }, getProfiles: () => [profile], onEvent: (e) => events.push(e),
    subagentRuntime: { runIsolatedImplement: async (ctx, args) => {
      calls.push({ ctx, args }); await args.createWorktree({ project: ctx.project, goal: args.markerGoal });
      await wait.promise; return { ok: true, terminalReason: 'completed', result: { changed: false } };
    } } }); t.after(() => repair.close());
  const input = { source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef },
    note: 'PRIVATE_FOLLOWUP_NOTE', validationProfileId: profile.id };
  const start = await repair.start(f.root, input); assert.equal(start.ok, true, start.code);
  assert.equal((await repair.start(f.root, input)).code, 'REPAIR_ALREADY_RUNNING'); wait.resolve();
  const done = await eventually(() => repair.get(f.root, start.repairRef), (v) => v.repair.status === 'no_changes');
  assert.equal(calls[0].args.maxTurns, 6); assert.equal(calls[0].ctx.settings.terminalEnabled, false);
  assert.match(calls[0].args.goal, /unknown 表示证据不足/); assert.match(calls[0].args.goal, /PRIVATE_FOLLOWUP_NOTE/);
  assert.equal(done.repair.resultId, undefined); assert.equal(done.repair.validation.status, 'not_run');
  assert.equal(done.repair.validationProfile.profileId, profile.id);
  assert.doesNotMatch(JSON.stringify([f.followups.store.list(), repair.store.list(), f.worktrees, events]),
    /PRIVATE_FOLLOWUP_NOTE|PRIVATE_FIXED_CODE|ORIGINAL_FINDING_BODY|UNKNOWN_PRIVATE_REASON/);
});
it('D20 rejects whole context above 32 KiB and preserves unmodified selected findings', async (t) => {
  const f = await followupFixture(t); const row = f.rechecks.row(f.root, f.parent.recheckRef);
  row.report.findings.forEach((r) => { r.reason = '中'.repeat(5000); }); f.rechecks.save(row);
  const saved = await f.snapshot(); assert.equal(saved.ok, true, saved.code);
  // The raw source is below the budget, but the immutable findings, evidence and note together exceed it.
  f.followups.snapshotFactory = (args) => ({ init: async () => {}, cleanup: async () => {},
    read: async ({ stage, path }) => ({ path, sha: stage === 'target' ? args.target.headSha : args.source.originalHead,
      content: 'e'.repeat(8000) }) });
  let runs = 0;
  const repair = createRepairManager({ prAuditRecheckRepairManager: f.followups, settings: { permissionMode: 'full-auto' },
    runImplement: async () => { runs++; } }); t.after(() => repair.close());
  const out = await repair.start(f.root, { source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef } });
  assert.equal(out.code, 'PR_AUDIT_REPAIR_CONTEXT_LIMIT'); assert.equal(runs, 0);
  assert.equal(repair.list(f.root).repairs.length, 0); assert.equal(f.rechecks.row(f.root, row.recheckRef).report.findings[0].reason.length, 5000);
});
it('D20 includes the instructions and note in the final UTF-8 budget before queueing', async (t) => {
  const f = await followupFixture(t); const saved = await f.snapshot(); let runs = 0;
  const original = f.followups.materializeRepairSource.bind(f.followups);
  f.followups.materializeRepairSource = async (...args) => ({ ...await original(...args), auditText: 'x'.repeat(31 * 1024) });
  const repair = createRepairManager({ prAuditRecheckRepairManager: f.followups, settings: { permissionMode: 'full-auto' },
    runImplement: async () => { runs++; } }); t.after(() => repair.close());
  const out = await repair.start(f.root, { source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef }, note: '中'.repeat(1000) });
  assert.equal(out.code, 'PR_AUDIT_REPAIR_CONTEXT_LIMIT'); assert.equal(runs, 0); assert.equal(repair.list(f.root).repairs.length, 0);
});
