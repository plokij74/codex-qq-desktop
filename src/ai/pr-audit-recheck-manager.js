'use strict';
const { canonicalProjectPath, projectKey } = require('./project-index');
const { isResultId } = require('./worktree-state');
const A = require('./pr-audit-state');
const S = require('./pr-audit-recheck-state');
const { PrAuditRecheckStore } = require('./pr-audit-recheck-store');
const { RecheckSnapshot, cleanupRecheckRefs } = require('./pr-audit-recheck-snapshot');
const { runRecheck } = require('./pr-audit-recheck-runtime');
class PrAuditRecheckManager {
  constructor(options = {}) {
    this.audits = options.auditManager; this.repairs = options.auditRepairManager;
    this.getRecheckRepairs = options.getRecheckRepairs || (() => options.recheckRepairManager);
    this.github = options.githubCli || this.audits.github; this.worktree = options.worktreeManager;
    this.store = options.store || new PrAuditRecheckStore(options);
    this.runtime = options.runtime || runRecheck; this.snapshotFactory = options.snapshotFactory || ((args) => new RecheckSnapshot(args));
    this.onEvent = options.onEvent; this.now = options.now || Date.now; this.timeoutMs = options.timeoutMs || A.LIMITS.timeout;
    this.runs = new Map(); this.cleaned = new Map(); this.closing = false;
  }
  current(ctx) { if (this.closing) throw A.fail('CANCELLED'); A.assertCurrent(ctx); }
  row(root, ref) {
    if (!S.isRef(ref)) throw A.fail(); const row = this.store.get(ref, projectKey(canonicalProjectPath(root)));
    if (!row) throw A.fail('NOT_FOUND'); return row;
  }
  save(row) {
    const saved = this.store.put(row);
    try { this.onEvent?.({ type: 'engineering:pr-audit:recheck:event', projectKey: saved.projectKey, prNumber: saved.prNumber,
      recheckRef: saved.recheckRef, status: saved.status, turn: saved.turns || 0 }); } catch {}
    return saved;
  }
  protectsSource(ref) { return this.store.referencesUnknown?.() || this.store.list().some((r) => r.source.auditRepairRef === ref) || [...this.runs.values()].some((r) => r.source?.auditRepairRef === ref); }
  protectsReport(ref) { return this.store.referencesUnknown?.() || this.store.list().some((r) => r.source.auditRef === ref) || [...this.runs.values()].some((r) => r.source?.auditRef === ref); }
  protectsRecheckRepair(ref) {
    return this.store.referencesUnknown?.() || this.store.list().some((r) => r.source.recheckRepairRef === ref)
      || [...this.runs.values()].some((r) => r.source?.recheckRepairRef === ref);
  }
  cleanup(repoRoot) {
    if (!this.cleaned.has(repoRoot)) this.cleaned.set(repoRoot,
      cleanupRecheckRefs(this.github, repoRoot, { has: (ref) => this.runs.has(ref) }).catch(() => {}));
    return this.cleaned.get(repoRoot);
  }
  async recover(root) {
    const repo = await this.audits.repository(canonicalProjectPath(root));
    await this.cleanup(repo.repoRoot);
  }
  historical(root, auditRepairRef) {
    const item = this.repairs.sourceRow(root, auditRepairRef); const row = this.audits.row(root, item.auditRef);
    // D18 marks the report stale after delivery. Only that flag may differ from the immutable source revision.
    if (row.status !== 'completed' || A.repairRevision({ ...row, stale: false }) !== item.repairRevision) throw A.fail('RECHECK_SOURCE');
    const findings = row.report.findings.filter((f) => item.findingIds.includes(f.findingId));
    if (findings.length !== item.findingIds.length) throw A.fail('RECHECK_SOURCE');
    return { item, row, findings };
  }
  async resolve(root, resultId, ctx) {
    this.current(ctx); if (!isResultId(resultId)) throw A.fail();
    const found = await this.worktree.inspectRemoteResult({ projectPath: root, resultId }); this.current(ctx);
    const m = found?.marker;
    if (!found?.ok || !['pr_audit', 'pr_audit_recheck'].includes(m?.originKind) || m.deliveryKind !== 'github_pr_update'
      || !['pr_updated', 'pr_update_cleanup_pending'].includes(m.state)) throw A.fail('RECHECK_DELIVERY');
    const followup = m.originKind === 'pr_audit_recheck';
    const history = followup ? this.getRecheckRepairs()?.historical(root, m.recheckRepairRef) : this.historical(root, m.auditRepairRef);
    if (!history) throw A.fail('RECHECK_SOURCE');
    const { item, findings } = history; const rootItem = history.rootItem || item;
    if (m.baseHead !== item.headSha || m.prUpdate?.oldHead !== item.headSha || m.prUpdate?.expectedTree !== m.expectedTree
      || m.prUpdate?.prNumber !== item.prNumber) throw A.fail('RECHECK_DELIVERY');
    const source = S.source({ auditRef: rootItem.auditRef, auditRepairRef: rootItem.auditRepairRef, resultId,
      repoKey: item.repoKey, prNumber: item.prNumber, prefix: item.prefix, headRefName: item.headRefName, baseRefName: item.baseRefName,
      originalHead: rootItem.headSha, originalBase: rootItem.mergeBaseSha, repairBaseHead: item.headSha,
      repairCommit: m.prUpdate.newCommit, expectedTree: m.expectedTree,
      repairRevision: rootItem.repairRevision, findingIds: findings.map((f) => f.findingId),
      ...(followup ? { recheckRepairRef: item.recheckRepairRef, parentRecheckRef: item.recheckRef } : {}) });
    return { source, findings };
  }
  originals(root, source) {
    if (!source.recheckRepairRef) return this.historical(root, source.auditRepairRef).findings;
    const history = this.getRecheckRepairs()?.historical(root, source.recheckRepairRef);
    if (!history || history.item.recheckRef !== source.parentRecheckRef || history.item.headSha !== source.repairBaseHead
      || history.rootItem.auditRepairRef !== source.auditRepairRef || history.rootItem.auditRef !== source.auditRef
      || history.rootItem.headSha !== source.originalHead || history.rootItem.mergeBaseSha !== source.originalBase
      || history.rootItem.repairRevision !== source.repairRevision
      || A.hash(history.item.findingIds) !== A.hash(source.findingIds)) throw A.fail('RECHECK_SOURCE');
    return history.findings;
  }
  async target(root, source, ctx) {
    const { repo, source: latest } = await this.audits.source(root, source.prNumber, ctx); this.current(ctx);
    if (['repoKey', 'prNumber', 'prefix', 'baseRefName', 'headRefName'].some((k) => latest[k] !== source[k])) throw A.fail('CHANGED');
    latest.mergeBaseSha = await this.github.getAuditMergeBase(this.audits.args(repo, ctx, latest)); this.current(ctx);
    const target = S.target(Object.fromEntries(['repoKey', 'prNumber', 'prefix', 'baseSha', 'headSha', 'mergeBaseSha', 'baseRefName', 'headRefName', 'descriptionHash'].map((k) => [k, latest[k]])));
    return { repo, target };
  }
  async freshness(root, row, ctx) {
    try { const { target } = await this.target(root, row.source, ctx); return A.hash(target) === A.hash(row.target) ? 'current' : 'stale'; }
    catch (cause) { this.current(ctx); return ['PR_AUDIT_CHANGED', 'PR_AUDIT_NOT_OPEN', 'PR_AUDIT_FORK'].includes(cause.code) ? 'stale' : 'unknown'; }
  }
  async start(projectPath, resultId, ctx = {}) {
    let acquired; let running = false;
    try {
      const root = canonicalProjectPath(projectPath); const key = projectKey(root); this.current(ctx);
      const settings = { ...this.audits.getSettings() };
      if (settings.mode !== 'api' || settings.agentEnabled === false || !settings.apiKey || !settings.model) throw A.fail('MODEL_REQUIRED');
      const ref = S.ref(); this.audits.taskPool.acquire(ref, key); acquired = ref;
      const { source, findings } = await this.resolve(root, resultId, ctx); this.current(ctx);
      const row = this.save({ recheckRef: ref, projectKey: key, prNumber: source.prNumber, source,
        createdAt: new Date(this.now()).toISOString(), status: 'preparing', freshness: 'unknown', model: String(settings.model).slice(0, 200) });
      const controller = new AbortController(); const abort = () => controller.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener('abort', abort, { once: true }); if (ctx.signal?.aborted) abort();
      const record = { ref, root, key, source, controller }; this.runs.set(ref, record); running = true;
      ctx.retainUntilFinished?.(); const context = { ...ctx, signal: controller.signal };
      const timer = setTimeout(() => controller.abort(A.fail('TIMEOUT')), this.timeoutMs); timer.unref?.();
      record.done = Promise.resolve().then(async () => {
        let snapshot;
        try {
          const { repo, target } = await this.target(root, source, context);
          await this.cleanup(repo.repoRoot); this.current(context);
          snapshot = this.snapshotFactory({ github: this.github, repo, target, source, recheckRef: ref, signal: context.signal });
          await snapshot.init(); this.current(context);
          const again = await this.resolve(root, resultId, context);
          if (A.hash(again.source) !== A.hash(source) || await this.freshness(root, { source, target }, context) !== 'current') throw A.fail('CHANGED');
          this.save({ ...this.row(root, ref), status: 'running', target });
          const generated = await this.runtime({ snapshot, findings, settings, signal: context.signal,
            onProgress: ({ turn }) => { this.current(context); this.save({ ...this.row(root, ref), turns: turn }); } });
          this.current(context); this.originals(root, source);
          const report = S.report(generated.report, source.findingIds, snapshot.evidence);
          const selected = new Set(report.findings.flatMap((f) => f.evidence));
          const bounded = (v) => Number.isFinite(v) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(v))) : 0;
          const freshness = await this.freshness(root, this.row(root, ref), context); this.current(context);
          this.save({ ...this.row(root, ref), status: 'completed', freshness, report,
            evidence: [...snapshot.evidence.values()].filter((e) => selected.has(e.evidenceId)),
            usage: { inputTokens: bounded(generated.usage?.inputTokens), outputTokens: bounded(generated.usage?.outputTokens), estimated: !!generated.usage?.estimated },
            turns: generated.turns || this.row(root, ref).turns || 0, finishedAt: new Date(this.now()).toISOString() });
        } catch (cause) {
          const stopped = controller.signal.aborted;
          const errorCode = stopped ? (controller.signal.reason?.code === 'PR_AUDIT_TIMEOUT' ? 'PR_AUDIT_TIMEOUT' : 'PR_AUDIT_CANCELLED') : A.error(cause).code;
          this.save({ ...this.row(root, ref), status: this.closing ? 'interrupted' : stopped ? 'cancelled' : 'failed', errorCode, freshness: 'unknown', finishedAt: new Date(this.now()).toISOString() });
        } finally {
          clearTimeout(timer);
          try { await snapshot?.cleanup(); } finally {
            this.runs.delete(ref); this.audits.taskPool.release(ref); ctx.signal?.removeEventListener('abort', abort); ctx.release?.();
          }
        }
      });
      record.done.catch(() => {});
      return { ok: true, recheckRef: row.recheckRef, persistence: this.store.persistenceStatus() };
    } catch (cause) { if (acquired && !running) this.audits.taskPool.release(acquired); return A.error(cause); }
  }
  async list(root, prNumber, ctx = {}) {
    try {
      this.current(ctx); root = canonicalProjectPath(root); if (prNumber !== undefined && !A.number(prNumber)) throw A.fail();
      const key = projectKey(root);
      const records = this.store.list(key).filter((r) => !prNumber || r.prNumber === prNumber).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      let listed; try { listed = await this.worktree.list({ projectPath: root }); } catch {}
      this.current(ctx);
      const deliveries = [];
      for (const m of listed?.ok ? listed.results || [] : []) {
        if (!['pr_audit', 'pr_audit_recheck'].includes(m.originKind) || !['pr_updated', 'pr_update_cleanup_pending'].includes(m.state)) continue;
        let historical; try { historical = m.originKind === 'pr_audit_recheck'
          ? this.getRecheckRepairs()?.historical(root, m.recheckRepairRef) : this.historical(root, m.auditRepairRef); } catch {}
        const number = historical?.item.prNumber || m.prUpdate?.prNumber;
        if (!A.number(number) || (prNumber && number !== prNumber)) continue;
        deliveries.push({ resultId: m.id, auditRepairRef: historical?.rootItem?.auditRepairRef || m.auditRepairRef,
          ...(m.recheckRepairRef ? { recheckRepairRef: m.recheckRepairRef } : {}), auditRef: historical?.item.auditRef, prNumber: number,
          repairCommit: m.prUpdate?.newCommit, findingCount: historical?.findings.length || 0, available: !!historical,
          ...(!historical ? { errorCode: 'PR_AUDIT_RECHECK_SOURCE' } : {}) });
      }
      return { ok: true, projectKey: key, deliveries: deliveries.slice(0, 200), rechecks: records.map((r) => ({ recheckRef: r.recheckRef,
        resultId: r.source.resultId, auditRef: r.source.auditRef, prNumber: r.prNumber, status: r.status, freshness: 'unknown', createdAt: r.createdAt,
        headSha: r.target?.headSha, turns: r.turns || 0, errorCode: r.errorCode })), persistence: this.store.persistenceStatus(), deliveriesUnavailable: !listed?.ok };
    } catch (cause) { return A.error(cause); }
  }
  async get(root, ref, ctx = {}) {
    try {
      let row = this.row(root, ref); this.current(ctx);
      if (row.status === 'completed') {
        const freshness = await this.freshness(root, row, ctx);
        row = this.row(root, ref); row.freshness = freshness; this.store.put(row);
      }
      let originals = []; let sourceAvailable = true;
      try { originals = this.originals(canonicalProjectPath(root), row.source); } catch { sourceAvailable = false; }
      return { ok: true, recheck: row, originalFindings: originals, sourceAvailable,
        ...(row.status === 'completed' ? { repairRevision: S.repairRevision(row) } : {}), persistence: this.store.persistenceStatus() };
    } catch (cause) { return A.error(cause); }
  }
  cancel(root, ref) { try { this.row(root, ref); this.runs.get(ref)?.controller.abort(); return { ok: true }; } catch (cause) { return A.error(cause); } }
  async context(root, ref, evidenceId, ctx = {}) {
    try {
      const row = this.row(root, ref); const e = row.evidence?.find((e) => e.evidenceId === evidenceId); if (!e) throw A.fail('NOT_FOUND');
      const repo = await this.audits.repository(canonicalProjectPath(root), ctx); this.current(ctx);
      if (repo.repoKey !== row.source.repoKey || repo.prefix !== row.source.prefix) throw A.fail('CHANGED');
      const snapshot = this.snapshotFactory({ github: this.github, repo, target: row.target, source: row.source, recheckRef: ref, signal: ctx.signal });
      const snippet = await snapshot.read({ stage: e.stage, path: e.path, offset: e.startLine || 1, limit: e.kind === 'code' ? e.line - e.startLine + 1 : 1 });
      this.current(ctx); return { ok: true, snippet };
    } catch (cause) { return A.error(cause); }
  }
  close() {
    this.closing = true;
    for (const r of this.runs.values()) { r.controller.abort(); const row = this.store.get(r.ref, r.key); if (row && S.ACTIVE.has(row.status)) this.store.put({ ...row, status: 'interrupted', freshness: 'unknown' }); }
    this.store.close();
  }
}
module.exports = { PrAuditRecheckManager };
