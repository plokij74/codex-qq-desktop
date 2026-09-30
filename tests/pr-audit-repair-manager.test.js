'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRepairManager } = require('../src/ai/repair-manager');
const A = require('../src/ai/pr-audit-state');
const { fixture } = require('./helpers/pr-audit-repair-fixture');
const { eventually, deferred } = require('./helpers/pr-review-fixture');

describe('D18 immutable original findings and D13 repair', () => {
  it('canonicalizes multi-select and reads RIGHT/head and LEFT/old path with isolated refs', async (t) => {
    const f = fixture(t); const ids = f.row.report.findings.map((x) => x.findingId);
    const saved = await f.snapshot([...ids].reverse()); assert.equal(saved.ok, true, saved.code);
    assert.deepEqual(saved.source.findingIds, ids);
    const resolved = await f.manager.materializeRepairSource(f.root, saved.auditRepairRef);
    assert.match(resolved.auditText, /ORIGINAL_FINDING_BODY/); assert.match(resolved.auditText, /renamed; 原路径: src\/old.js/);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'read').map(([, args]) => [args.path, args.side]), [['src/app.js', 'RIGHT'], ['src/old.js', 'LEFT']]);
    assert.ok(f.calls.filter(([kind]) => kind === 'capture').every(([, args]) => args.refNamespace === 'pr-audit-repair'));
    assert.equal(f.calls.filter(([kind]) => kind === 'capture').length, f.calls.filter(([kind]) => kind === 'cleanup').length);
    await resolved.createWorktree({ project: { path: f.root }, goal: '处理 AI PR 审查发现' });
    assert.match(f.calls.find(([kind]) => kind === 'fetch')[1].targetRef, /^refs\/codex\/pr-audit-repair\/par_/);
    assert.deepEqual(f.worktrees[0].origin, { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef });
  });
  it('keeps repairRevision stable across every Review publication state', async (t) => {
    const f = fixture(t); const initial = f.current(); const saved = await f.snapshot();
    for (const status of ['publishing', 'published', 'uncertain', 'failed']) {
      f.audits.store.put({ ...f.current(), publication: { status, publicationRef: A.ref('pap'), actorId: 42,
        commitId: f.state.pr.headSha, bodyHash: A.hash('edited published body'), comments: [] } });
      assert.equal(f.current().repairRevision, initial.repairRevision);
      assert.notEqual(f.current().revision, initial.revision);
      assert.equal((await f.manager.resolveMetadata(f.root, saved.auditRepairRef)).source.auditRepairRef, saved.auditRepairRef);
      assert.equal((await f.snapshot()).ok, true);
    }
  });
  it('rejects empty, duplicate, foreign, over-limit selections and source injection', async (t) => {
    const f = fixture(t); const id = f.row.report.findings[0].findingId;
    for (const ids of [[], [id, id], [A.ref('paf')], Array.from({ length: 6 }, () => A.ref('paf'))]) assert.equal((await f.snapshot(ids)).ok, false);
    assert.equal((await f.manager.snapshot(f.root, { auditRef: f.row.auditRef, repairRevision: f.current().repairRevision,
      findingIds: [id], headSha: f.state.pr.headSha })).ok, false);
    f.audits.store.put({ ...f.current(), stale: true }); assert.equal((await f.snapshot([id])).code, 'PR_AUDIT_REPAIR_CHANGED');
  });
  it('rejects changed head, base, description, merge-base and original report', async (t) => {
    const f = fixture(t); const saved = await f.snapshot();
    for (const field of ['headSha', 'baseSha', 'body', 'headRefName', 'baseRefName']) {
      const old = f.state.pr[field]; f.state.pr[field] = field.endsWith('Sha') ? 'e'.repeat(40) : `${old}-changed`;
      await assert.rejects(f.manager.resolveMetadata(f.root, saved.auditRepairRef), { code: 'PR_AUDIT_REPAIR_CHANGED' }); f.state.pr[field] = old;
    }
    const old = f.state.mergeBase; f.state.mergeBase = 'f'.repeat(40);
    await assert.rejects(f.manager.resolveMetadata(f.root, saved.auditRepairRef), { code: 'PR_AUDIT_REPAIR_CHANGED' }); f.state.mergeBase = old;
    const changed = f.current(); changed.report.findings[0].body = 'Changed original report'; f.audits.store.put(changed);
    await assert.rejects(f.manager.resolveMetadata(f.root, saved.auditRepairRef), { code: 'PR_AUDIT_REPAIR_CHANGED' });
    assert.equal((await f.manager.source(f.root, saved.auditRepairRef)).ok, true);
  });
  it('revalidates after approval and never creates an old-head worktree', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); let runs = 0;
    const repair = createRepairManager({ prAuditRepairManager: f.manager, settings: { permissionMode: 'confirm-writes' }, runImplement: async () => { runs++; } });
    t.after(() => repair.close());
    const out = await repair.start(f.root, { source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef } },
      { gate: { authorize: async () => { f.state.pr.headSha = 'f'.repeat(40); return { allowed: true }; } } });
    assert.equal(out.code, 'PR_AUDIT_REPAIR_CHANGED'); assert.equal(runs, 0); assert.equal(repair.list(f.root).repairs.length, 0);
  });
  it('runs a six-turn single candidate with optional validation and metadata-only history/events', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const seen = []; const events = []; const wait = deferred();
    const profile = { id: 'vfy_' + '1'.repeat(8), name: 'Tests', kind: 'test', command: 'node --test', cwd: '.', enabled: true, timeoutMs: 5000 };
    const repair = createRepairManager({ prAuditRepairManager: f.manager, worktree: f.worktree,
      settings: { permissionMode: 'full-auto', terminalEnabled: true }, getProfiles: () => [profile], onEvent: (event) => events.push(event),
      subagentRuntime: { runIsolatedImplement: async (ctx, args) => {
        seen.push({ ctx, args }); await args.createWorktree({ project: ctx.project, goal: args.markerGoal });
        await wait.promise; return { ok: true, terminalReason: 'completed', result: { id: 'wt_auditrepair1', changed: true } };
      } } }); t.after(() => repair.close());
    const input = { source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef }, note: 'PRIVATE_REPAIR_NOTE\nkeep the API', validationProfileId: profile.id };
    const start = await repair.start(f.root, input); assert.equal(start.ok, true, start.code);
    assert.equal((await repair.start(f.root, input)).code, 'REPAIR_ALREADY_RUNNING');
    wait.resolve(); const out = await eventually(() => repair.get(f.root, start.repairRef), (v) => v.repair.status === 'ready');
    assert.equal(seen[0].args.maxTurns, 6); assert.equal(seen[0].args.markerGoal, '处理 AI PR 审查发现');
    assert.equal(seen[0].ctx.settings.terminalEnabled, false);
    assert.match(seen[0].args.goal, /ORIGINAL_FINDING_BODY/); assert.match(seen[0].args.goal, /PRIVATE_REPAIR_NOTE\nkeep the API/);
    assert.equal(out.repair.validation.status, 'not_run'); assert.equal(out.repair.validationProfile.profileId, profile.id);
    assert.doesNotMatch(JSON.stringify([repair.store.list(), f.manager.store.list(), f.worktrees, events]), /ORIGINAL_FINDING_BODY|ORIGINAL_CODE_EVIDENCE|PRIVATE_REPAIR_NOTE|auditText/);
  });
  it('rejects full UTF-8 context over 32 KiB without queueing or truncating selected findings', async (t) => {
    const f = fixture(t, { findings: 3 }); const row = f.current(); row.report.findings.forEach((finding) => { finding.body = '中'.repeat(5000); }); f.audits.store.put(row);
    const saved = await f.snapshot(); let runs = 0;
    const repair = createRepairManager({ prAuditRepairManager: f.manager, settings: { permissionMode: 'full-auto' }, runImplement: async () => { runs++; } }); t.after(() => repair.close());
    const out = await repair.start(f.root, { source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef } });
    assert.equal(out.code, 'PR_AUDIT_REPAIR_CONTEXT_LIMIT'); assert.equal(repair.list(f.root).repairs.length, 0); assert.equal(runs, 0);
  });
  it('supports deleted LEFT evidence and rejects invalid current hunk mapping', async (t) => {
    const f = fixture(t); const row = f.current(); row.report.findings = [row.report.findings[1]]; f.audits.store.put(row);
    f.state.files[0].status = 'removed'; f.state.files[0].hunks[0].rightCount = 0;
    const saved = await f.snapshot(row.report.findings.map((x) => x.findingId)); assert.equal(saved.ok, true);
    assert.match((await f.manager.materializeRepairSource(f.root, saved.auditRepairRef)).auditText, /变更: removed/);
    f.state.files[0].hunks[0].changedLeft = [];
    assert.equal((await f.snapshot(row.report.findings.map((x) => x.findingId))).code, 'PR_AUDIT_LOCATION');
  });
});
