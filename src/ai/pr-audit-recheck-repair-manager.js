'use strict';
const A = require('./pr-audit-state');
const R = require('./pr-audit-recheck-state');
const S = require('./pr-audit-recheck-repair-state');
const { MAX_CONTEXT_BYTES } = require('./pr-audit-repair-state');
const { PrAuditRepairManager } = require('./pr-audit-repair-manager');
const { PrAuditRecheckRepairStore } = require('./pr-audit-recheck-repair-store');
const { RecheckSnapshot, cleanupRecheckRefs } = require('./pr-audit-recheck-snapshot');
const { createRemoteWorktree, updatePr } = require('./pr-delivery');
const targetOf = (item) => Object.fromEntries(S.TARGET_FIELDS.map((k) => [k, item[k]]));
class PrAuditRecheckRepairManager extends PrAuditRepairManager {
  constructor(options = {}) {
    super({ ...options, store: options.store || new PrAuditRecheckRepairStore(options) });
    this.getRechecks = options.getRechecks || (() => options.recheckManager);
    this.snapshotFactory = options.snapshotFactory || ((args) => new RecheckSnapshot(args));
    this.recheckPins = new Map();
    this.deliverySource = { kind: 'pr_audit_recheck', refField: 'recheckRepairRef', label: 'PR recheck findings',
      refNamespace: 'pr-audit-recheck-repair', refPrefix: 'pcr', approvalSource: 'pr-audit-recheck' };
  }
  async _repository(root, context = {}) {
    this._current(context);
    const repo = await this.audits.repository(root, context);
    if (!this.cleaned.has(repo.repoRoot)) this.cleaned.set(repo.repoRoot,
      cleanupRecheckRefs(this.github, repo.repoRoot, this.activeRefs, this.deliverySource.refNamespace));
    await this.cleaned.get(repo.repoRoot); this._current(context); return repo;
  }
  sourceRow(root, ref) {
    if (!S.REF_RE.test(ref)) throw S.fail();
    const row = this.store.get(ref, this.projectKey(this._root(root)));
    if (!row) throw S.fail('REPAIR_NOT_FOUND');
    return row;
  }
  protectsRecheck(ref) {
    return this.recheckPins.has(ref) || this.store.referencesUnknown()
      || this.store.list().some((r) => r.recheckRef === ref);
  }
  protectsSource(ref) {
    return this.store.referencesUnknown() || this.store.list().some((r) => r.auditRepairRef === ref);
  }
  protectsReport(ref) {
    return this.reportPins.has(ref) || this.store.referencesUnknown() || this.store.list().some((r) => r.auditRef === ref);
  }
  async pin(item, action) {
    this.recheckPins.set(item.recheckRef, (this.recheckPins.get(item.recheckRef) || 0) + 1);
    try { return await this.withReportPin(item.auditRef, action); }
    finally {
      const count = this.recheckPins.get(item.recheckRef) - 1;
      if (count) this.recheckPins.set(item.recheckRef, count); else this.recheckPins.delete(item.recheckRef);
    }
  }
  historical(root, ref, seen = new Set()) {
    return this.history(root, this.sourceRow(root, ref), seen);
  }
  history(root, item, seen = new Set()) {
    if (seen.has(item.recheckRepairRef) || seen.size >= 200) throw A.fail('RECHECK_SOURCE');
    seen.add(item.recheckRepairRef);
    const rechecks = this.getRechecks(); const parent = rechecks.row(root, item.recheckRef);
    if (R.repairRevision(parent) !== item.repairRevision || parent.source.resultId !== item.parentResultId
      || parent.source.auditRef !== item.auditRef || parent.source.auditRepairRef !== item.auditRepairRef
      || A.hash(targetOf(parent.target || {})) !== A.hash(targetOf(item))) throw S.fail('REPAIR_CHANGED');
    const verdicts = S.selectFindings(parent, item.findingIds);
    if (A.hash(verdicts.map((f) => f.findingId)) !== A.hash(item.findingIds)) throw S.fail();
    const original = rechecks.historical(root, item.auditRepairRef);
    if (original.row.auditRef !== item.auditRef || parent.source.originalHead !== original.item.headSha
      || parent.source.originalBase !== original.item.mergeBaseSha || parent.source.repairRevision !== original.item.repairRevision
      || parent.source.findingIds.some((id) => !original.item.findingIds.includes(id))) throw A.fail('RECHECK_SOURCE');
    if (parent.source.recheckRepairRef) {
      const previous = this.historical(root, parent.source.recheckRepairRef, seen);
      if (parent.source.parentRecheckRef !== previous.item.recheckRef || parent.source.repairBaseHead !== previous.item.headSha
        || A.hash(parent.source.findingIds) !== A.hash(previous.item.findingIds)) throw A.fail('RECHECK_SOURCE');
    } else if (A.hash(parent.source.findingIds) !== A.hash(original.item.findingIds)) throw A.fail('RECHECK_SOURCE');
    const findings = original.findings.filter((f) => item.findingIds.includes(f.findingId));
    if (findings.length !== item.findingIds.length) throw A.fail('RECHECK_SOURCE');
    return { item, parent, row: original.row, rootItem: original.item, findings, verdicts };
  }
  async verify(root, item, context) {
    this._current(context); const history = this.history(root, item);
    const repo = await this._repository(root, context);
    const { target } = await this.getRechecks().target(root, history.parent.source, context);
    if (A.hash(targetOf(target)) !== A.hash(targetOf(item))) throw S.fail('REPAIR_CHANGED');
    const delivered = await this.getRechecks().resolve(root, item.parentResultId, context);
    if (A.hash(delivered.source) !== A.hash(history.parent.source)) throw A.fail('RECHECK_DELIVERY');
    this.history(root, item); this._current(context);
    return { ...history, repo, pr: { ...target, number: item.prNumber }, snapshot: item,
      source: { kind: 'pr_audit_recheck', recheckRepairRef: item.recheckRepairRef },
      sourceFingerprint: S.sourceFingerprint(item), baseHead: item.headSha,
      sourceLabel: 'PR #' + item.prNumber + ' · 复审继续修复 · ' + item.findingIds.length + ' 项',
      approvalLabel: '继续处理 PR #' + item.prNumber + ' 的 ' + item.findingIds.length + ' 项复审问题（隔离修复）' };
  }
  async withFixedSnapshot(root, item, context, action) {
    const resolved = await this.verify(root, item, context); const operationRef = A.ref('pcr');
    this.activeRefs.add(operationRef); let snapshot;
    try {
      snapshot = this.snapshotFactory({ github: this.github, repo: resolved.repo, target: resolved.parent.target,
        source: resolved.parent.source, recheckRef: operationRef, refNamespace: this.deliverySource.refNamespace,
        includeDiffs: false, signal: context.signal });
      await snapshot.init(); await this.verify(root, item, context);
      const value = await action(snapshot, resolved);
      await this.verify(root, item, context);
      return value;
    } finally { try { await snapshot?.cleanup(); } finally { this.activeRefs.delete(operationRef); } }
  }
  async snapshot(projectPath, payload, context = {}) {
    try {
      A.keys(payload, ['recheckRef', 'repairRevision', 'findingIds']); this._current(context);
      const root = this._root(projectPath); const parent = this.getRechecks().row(root, payload.recheckRef);
      if (!A.digest(payload.repairRevision) || R.repairRevision(parent) !== payload.repairRevision) throw S.fail('REPAIR_CHANGED');
      const verdicts = S.selectFindings(parent, payload.findingIds);
      const item = S.normalizeSnapshot({ recheckRepairRef: A.ref('pcr'), recheckRef: parent.recheckRef,
        parentResultId: parent.source.resultId, auditRef: parent.source.auditRef, auditRepairRef: parent.source.auditRepairRef,
        projectKey: parent.projectKey, repairRevision: payload.repairRevision, findingIds: verdicts.map((f) => f.findingId),
        ...targetOf(parent.target), createdAt: new Date(this.now()).toISOString() });
      return await this.pin(item, async () => {
        await this.withFixedSnapshot(root, item, context, async () => {});
        this._current(context); const saved = this.store.put(item);
        return { ok: true, recheckRepairRef: saved.recheckRepairRef, source: S.publicSource(saved), persistence: this.persistenceStatus() };
      });
    } catch (cause) { return A.error(cause); }
  }
  async resolveMetadata(projectPath, ref, context = {}) {
    const root = this._root(projectPath);
    return this.verify(root, this.sourceRow(root, ref), context);
  }
  async materializeRepairSource(projectPath, ref, context = {}) {
    const root = this._root(projectPath); const item = this.sourceRow(root, ref);
    return this.pin(item, () => this.withFixedSnapshot(root, item, context, async (snapshot, resolved) => {
      const sections = ['本轮修复基线: ' + item.headSha + '; 最初审查 head: ' + resolved.parent.source.originalHead];
      const snippets = new Map();
      for (const f of resolved.findings) {
        const verdict = resolved.verdicts.find((v) => v.findingId === f.findingId);
        let original;
        try { original = await snapshot.read({ stage: f.side === 'LEFT' ? 'original_base' : 'original_head',
          path: f.contextPath || f.path, offset: Math.max(1, f.startLine - 8), limit: Math.min(60, f.line - f.startLine + 17) }); }
        catch (cause) {
          this._current(context);
          if (!['PR_AUDIT_LOCATION', 'PR_AUDIT_CONTEXT_LIMIT'].includes(cause.code)) throw cause;
          original = { unavailable: true, code: cause.code };
        }
        const evidence = [];
        for (const id of verdict.evidence) {
          const e = resolved.parent.evidence.find((value) => value.evidenceId === id);
          if (!e) throw A.fail('RECHECK_SOURCE');
          if (!snippets.has(id)) {
            const snippet = await snapshot.read({ stage: e.stage, path: e.path, offset: e.startLine || 1,
              limit: e.kind === 'code' ? e.line - e.startLine + 1 : 1 });
            if (snippet.sha !== e.sha || (e.kind === 'absence') !== !!snippet.absent) throw A.fail('RECHECK_SOURCE');
            snippets.set(id, snippet);
          }
          evidence.push({ ...e, snippet: snippets.get(id) });
        }
        sections.push(JSON.stringify({ originalFinding: f, originalCode: original, verdict, evidence }));
      }
      const auditText = sections.join('\n\n');
      if (Buffer.byteLength(auditText, 'utf8') > MAX_CONTEXT_BYTES) throw S.fail('REPAIR_CONTEXT_LIMIT');
      return { source: resolved.source, sourceFingerprint: resolved.sourceFingerprint, baseHead: resolved.baseHead,
        sourceLabel: resolved.sourceLabel, approvalLabel: resolved.approvalLabel, auditText,
        result: { diagnostics: [], stdout: '', stderr: '' }, ...(context.validationProfile ? { validationProfile: context.validationProfile } : {}),
        createWorktree: (args) => createRemoteWorktree(this, ref, args, context) };
    }));
  }
  async source(projectPath, ref, context = {}) {
    try {
      const root = this._root(projectPath); const { item } = this.historical(root, ref);
      const repo = await this._repository(root, context);
      if (repo.repoKey !== item.repoKey || repo.prefix !== item.prefix) throw S.fail('REPAIR_CHANGED');
      this._current(context); return { ok: true, source: S.publicSource(item) };
    } catch (cause) { return A.error(cause); }
  }
  persistenceStatus() {
    const own = super.persistenceStatus(); const rechecks = this.getRechecks();
    const parents = [rechecks?.store.persistenceStatus(), rechecks?.repairs.persistenceStatus()];
    const unavailable = parents.findIndex((status) => !status?.durable);
    return unavailable < 0 ? own : { ...own, persistence: 'memory', durable: false,
      error: parents[unavailable]?.error || 'PR_AUDIT_REPAIR_STORE_MEMORY' };
  }
  async updatePr(root, resultId, subject, context) {
    const out = await updatePr(this, root, resultId, subject, context);
    if (out?.ok && out.result?.recheckRepairRef) {
      try {
        const item = this.sourceRow(root, out.result.recheckRepairRef);
        const row = this.getRechecks().row(root, item.recheckRef);
        this.getRechecks().save({ ...row, freshness: 'stale' });
      } catch {}
    }
    return out;
  }
}
module.exports = { PrAuditRecheckRepairManager };
