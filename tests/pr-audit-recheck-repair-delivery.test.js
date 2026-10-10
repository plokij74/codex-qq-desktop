'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const A = require('../src/ai/pr-audit-state'); const R = require('../src/ai/pr-audit-recheck-state');
const { createWorktreeManager } = require('../src/ai/worktree');
const { RecheckSnapshot, cleanupRecheckRefs } = require('../src/ai/pr-audit-recheck-snapshot');
const { recheckDeliveryFixture } = require('./helpers/pr-audit-recheck-delivery-fixture');

it('D20 delivers two real Git rounds with original LEFT/RIGHT locations and each selected baseline', async (t) => {
  const f = await recheckDeliveryFixture(t); const first = await f.capture();
  const one = await f.generate(first, 'xs?.at(0) ?? null');
  assert.equal(one.context.baseHead, f.parent.target.headSha); assert.notEqual(one.context.baseHead, f.originalHead);
  assert.match(one.context.auditText, /return xs\[0\]/); assert.match(one.context.auditText, /return xs.at\(0\)/);
  assert.match(one.context.auditText, /xs.slice\(0\)/);
  const preview = await f.worktree.get({ projectPath: f.root, resultId: one.id, preview: true });
  assert.equal(preview.result.originKind, 'pr_audit_recheck'); assert.equal(preview.result.recheckRepairRef, first.recheckRepairRef);
  assert.equal(preview.result.canApply, false); assert.equal(preview.result.canCreatePr, false);
  assert.equal((await f.followups.updatePr(f.root, one.id, 'Continue first round')).code, 'PR_UPDATE_CONFIRM_REQUIRED');
  const body = f.state.pr.body;
  assert.equal((await f.followups.updatePr(f.root, one.id, 'Continue first round', { gate: { authorize: async () => {
    f.state.pr.body += ' changed'; return { allowed: true };
  } } })).code, 'PR_AUDIT_REPAIR_CHANGED');
  assert.equal(f.pushes.length, 1); f.state.pr.body = body;
  const sent = await f.followups.updatePr(f.root, one.id, 'Continue first round', { gate: f.gate }); assert.equal(sent.ok, true, sent.code);
  assert.equal(f.approvals.at(-1).tool, 'pr_audit_recheck_update_pr'); assert.equal(f.approvals.at(-1).source, 'pr-audit-recheck');
  assert.equal(f.rechecks.row(f.root, f.parent.recheckRef).freshness, 'stale');
  assert.equal(f.rechecks.store.list().length, 1, 'delivery alone never starts rechecking');
  const middle = await f.done(one.id); assert.equal(middle.status, 'completed', middle.errorCode);
  assert.equal(middle.source.originalHead, f.originalHead); assert.equal(middle.source.originalBase, f.baseHead);
  assert.equal(middle.source.repairBaseHead, f.parent.target.headSha);
  assert.deepEqual(middle.source.findingIds, first.source.findingIds);
  assert.equal(f.inputs.at(-1).diffs[0].from, 'repair_base');
  assert.match(f.inputs.at(-1).findings.find((v) => v.side === 'LEFT').snippet.content, /xs\[0\]/);
  const selected = [middle.report.findings.find((v) => v.status === 'unknown').findingId];
  const second = await f.capture(middle, selected); const two = await f.generate(second, 'Array.isArray(xs) && xs.length ? xs[0] : null');
  assert.equal(two.context.baseHead, middle.target.headSha);
  const last = await f.followups.updatePr(f.root, two.id, 'Continue second round', { gate: f.gate }); assert.equal(last.ok, true, last.code);
  const final = await f.done(two.id); assert.equal(final.status, 'completed', final.errorCode);
  assert.deepEqual(final.source.findingIds, selected); assert.equal(final.source.repairBaseHead, middle.target.headSha);
  assert.equal(final.source.originalHead, f.originalHead); assert.equal(final.source.parentRecheckRef, middle.recheckRef);
  assert.equal(f.pushes.length, 3);
  assert.equal(f.git(['show-ref']), f.beforeRefs); assert.equal(f.git(['rev-parse', 'HEAD']), f.localHead);
  assert.equal(f.git(['write-tree']), f.beforeIndex); assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(f.root, '.git', 'FETCH_HEAD')), false);
});

it('D20 reconciles an uncertain real commit after restart using frozen delivery without another push', async (t) => {
  const f = await recheckDeliveryFixture(t); const source = await f.capture(); const generated = await f.generate(source, 'xs?.at(0) ?? null');
  let pending; let attempts = 0;
  f.github.exactLeasePush = async (args) => { pending = args; attempts++; return { ok: false, uncertain: true }; };
  const first = await f.followups.updatePr(f.root, generated.id, 'Continue repair', { gate: f.gate });
  assert.equal(first.code, 'PR_UPDATE_UNCERTAIN'); assert.equal(first.result.state, 'pr_update_uncertain');
  const restored = createWorktreeManager(); f.followups.worktree = restored; await restored.recover({ projectPath: f.root });
  assert.equal((await f.followups.updatePr(f.root, generated.id, 'ignored')).code, 'PR_UPDATE_UNCERTAIN'); assert.equal(attempts, 1);
  f.publish(pending.newCommit, pending.oldHead);
  const parent = await f.rechecks.get(f.root, f.parent.recheckRef); assert.equal(parent.recheck.freshness, 'stale');
  const beforeApprovals = f.approvals.length;
  const checked = await f.followups.updatePr(f.root, generated.id, 'ignored');
  assert.equal(checked.ok, true, checked.code); assert.equal(checked.result.state, 'pr_updated'); assert.equal(attempts, 1);
  assert.equal(f.approvals.length, beforeApprovals);
  assert.equal(f.git(['rev-parse', pending.newCommit + '^{tree}']), checked.result.prUpdate.expectedTree);
  assert.equal(f.git(['show-ref']), f.beforeRefs); assert.equal(f.git(['rev-parse', 'HEAD']), f.localHead);
});

it('D20 fixed snapshots handle later rename/delete and empty PR diff, rejecting force-pushed ancestry or a wrong tree', async (t) => {
  const f = await recheckDeliveryFixture(t); const source = await f.capture(); const one = await f.generate(source, 'xs?.at(0) ?? null');
  assert.equal((await f.followups.updatePr(f.root, one.id, 'Continue repair', { gate: f.gate })).ok, true);
  const delivered = (await f.rechecks.resolve(f.root, one.id)).source;
  f.advance({ 'src/app.js': null, 'src/moved.js': f.original.replace('xs[0]', 'xs?.at(0) ?? null'), 'src/extra.js': null });
  const make = async (origin = delivered) => new RecheckSnapshot({ github: f.github, repo: { repoRoot: f.root }, source: origin,
    target: (await f.rechecks.target(f.root, origin)).target, recheckRef: A.ref('pcr'), refNamespace: 'pr-audit-recheck-repair' });
  const snapshot = await make(); await snapshot.init();
  assert.match((await snapshot.read({ stage: 'original_head', path: 'src/app.js' })).content, /xs.at/);
  assert.match((await snapshot.read({ stage: 'original_base', path: 'src/old.js' })).content, /xs\[0\]/);
  assert.match((await snapshot.read({ stage: 'repair_base', path: 'src/app.js' })).content, /xs.slice/);
  assert.match((await snapshot.read({ path: 'src/moved.js' })).content, /\?\./);
  assert.equal((await snapshot.read({ path: 'src/extra.js' })).absent, true);
  assert.ok(snapshot.diffs[1].files.some((v) => v.status.startsWith('R'))); await snapshot.cleanup();
  f.advance({}, f.git(['rev-parse', f.baseHead + '^{tree}']));
  assert.equal(f.git(['diff', f.baseHead, f.state.pr.headSha]), '');
  const empty = await make(); await empty.init(); await empty.cleanup();
  await assert.rejects(async () => (await make({ ...delivered, expectedTree: '0'.repeat(40) })).init(), /RECHECK_DELIVERY/);
  f.git(['update-ref', 'refs/heads/feature/review', f.originalHead], f.origin); f.state.pr.headSha = f.originalHead;
  await assert.rejects(async () => (await make()).init(), /RECHECK_ANCESTRY/);
  assert.equal(f.git(['for-each-ref', '--format=%(refname)', 'refs/codex/pr-audit-recheck-repair/']), '');
  assert.equal(f.git(['rev-parse', 'HEAD']), f.localHead); assert.equal(f.git(['status', '--porcelain']), '');
});

it('D20 rejects a dirty main checkout before fetch and cleans only its own inactive references', async (t) => {
  const f = await recheckDeliveryFixture(t); const source = await f.capture();
  const context = await f.followups.materializeRepairSource(f.root, source.recheckRepairRef);
  f.calls.length = 0; fs.writeFileSync(path.join(f.root, 'dirty.txt'), 'keep user edits');
  const denied = await context.createWorktree({ project: { path: f.root }, goal: 'Continue repair' });
  assert.equal(denied.code, 'DIRTY_BASE'); assert.equal(f.calls.some(([kind]) => kind === 'fetch'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'dirty.txt'), 'utf8'), 'keep user edits');
  const active = A.ref('pcr'); const unused = A.ref('pcr'); const old = R.ref();
  const activeDelivery = A.ref('pcr'); const unusedDelivery = A.ref('pcr');
  const refs = [`refs/codex/pr-audit-recheck-repair/${active}/head`, `refs/codex/pr-audit-recheck-repair/${activeDelivery}`,
    `refs/codex/pr-audit-recheck-repair/${unused}/base`, `refs/codex/pr-audit-recheck-repair/${unusedDelivery}`,
    `refs/codex/pr-audit-recheck/${old}/head`, 'refs/codex/pr-audit-recheck-repair/unrelated/head'];
  for (const ref of refs) f.git(['update-ref', ref, f.state.pr.headSha]);
  await cleanupRecheckRefs(f.github, f.root, new Set([active, activeDelivery]), 'pr-audit-recheck-repair');
  const after = f.git(['for-each-ref', '--format=%(refname)', 'refs/codex/']).split('\n');
  assert.deepEqual(after.sort(), [refs[0], refs[1], refs[4], refs[5]].sort());
});
