'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { fixture } = require('./helpers/pr-audit-repair-fixture');
const { deferred, eventually } = require('./helpers/pr-review-fixture');

function handlersFor(t, f, extras = {}) {
  const owner = { sender: { id: 1, isDestroyed: () => false } }; const token = 'pb_' + 'a'.repeat(32);
  const handlers = createEngineeringIpcHandlers({ prAuditManager: f.audits, prAuditRepairManager: f.manager, githubCli: f.github,
    worktreeManager: f.worktree, getSettings: () => ({ permissionMode: 'full-auto' }), ...extras });
  handlers.bind(owner, { projectBindingId: token, projectPath: f.root }); t.after(() => handlers.close());
  return { handlers, owner, token };
}
describe('D18 sender-bound UI repair bridge', () => {
  it('rejects cross-sender access, injected source metadata and the Agent start bridge', async (t) => {
    const f = fixture(t); const { handlers, owner, token } = handlersFor(t, f);
    const input = { projectBindingId: token, auditRef: f.row.auditRef, repairRevision: f.current().repairRevision, findingIds: f.row.report.findings.map((x) => x.findingId) };
    assert.equal((await handlers.prAuditRepairSnapshot({ sender: { id: 2 } }, input)).ok, false);
    assert.equal((await handlers.prAuditRepairSnapshot(owner, { ...input, headSha: f.state.pr.headSha })).ok, false);
    const saved = await handlers.prAuditRepairSnapshot(owner, input); assert.equal(saved.ok, true, saved.code);
    assert.equal((await handlers.prAuditRepairSource(owner, { projectBindingId: token, auditRepairRef: saved.auditRepairRef })).source.auditRef, f.row.auditRef);
    assert.equal((await handlers.repairStartForAgent(f.root, { source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef } })).ok, false);
    assert.equal((await handlers.repairStart(owner, { projectBindingId: token, source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef, headSha: f.state.pr.headSha } })).ok, false);
  });
  it('retains cancellation after start returns and preserves partial results when unbound', async (t) => {
    const f = fixture(t); const saved = await f.snapshot(); const entered = deferred();
    const { handlers, owner, token } = handlersFor(t, f, { subagentRuntime: { runIsolatedImplement: async (ctx) => {
      entered.resolve(ctx.signal);
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: true, terminalReason: 'aborted', incomplete: true,
        result: { id: 'wt_d18partial', changed: true } }), { once: true }));
    } } });
    const started = await handlers.repairStart(owner, { projectBindingId: token, source: { kind: 'pr_audit', auditRepairRef: saved.auditRepairRef }, note: 'PRIVATE_UI_NOTE' });
    assert.equal(started.ok, true, started.code); const signal = await entered.promise;
    handlers.unbind(owner, { projectBindingId: token }); assert.equal(signal.aborted, true);
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root });
    const final = await eventually(() => handlers.repairGet(owner, { projectBindingId: token, repairRef: started.repairRef }), (out) => out.repair?.status === 'cancelled');
    assert.equal(final.repair.resultId, 'wt_d18partial'); assert.equal(final.repair.incomplete, true);
    assert.doesNotMatch(JSON.stringify(handlers.repairManager.store.list()), /PRIVATE_UI_NOTE|ORIGINAL_FINDING_BODY/);
  });
  it('does not return a source from a request whose binding was replaced during capture', async (t) => {
    const f = fixture(t); const { handlers, owner, token } = handlersFor(t, f); const entered = deferred(); const release = deferred();
    const original = f.github.getAuditFiles;
    f.github.getAuditFiles = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const pending = handlers.prAuditRepairSnapshot(owner, { projectBindingId: token, auditRef: f.row.auditRef,
      repairRevision: f.current().repairRevision, findingIds: f.row.report.findings.map((x) => x.findingId) });
    await entered.promise; handlers.unbind(owner, { projectBindingId: token }); release.resolve();
    assert.equal((await pending).ok, false); assert.equal(f.manager.store.list().length, 0); assert.equal(f.worktrees.length, 0);
  });
});
