'use strict';
const { canonicalProjectPath, projectKey } = require('./project-index');
const A = require('./pr-audit-state');
const S = require('./pr-audit-repair-state');
const { cleanupAuditRefs } = require('./pr-audit-snapshot');
const { createPrAuditRepairStore } = require('./pr-audit-repair-store');
const { createRemoteWorktree, updatePr } = require('./pr-delivery');

class PrAuditRepairManager {
  constructor(options = {}) {
    this.audits = options.auditManager; this.github = options.githubCli || this.audits?.github;
    this.worktree = options.worktreeManager; this.store = options.store || createPrAuditRepairStore(options);
    this.mutationLock = options.mutationLock; this.now = options.now || Date.now; this.projectKey = projectKey;
    this.deliverySource = { kind: 'pr_audit', refField: 'auditRepairRef', label: 'AI PR review', refNamespace: 'pr-audit-repair', refPrefix: 'par', approvalSource: 'pr-audit' };
    this.activeRefs = new Set(); this.reportPins = new Map(); this.cleaned = new Map(); this.pending = new Set(); this.closing = false;
  }
  _root(root) { return canonicalProjectPath(root); }
  _current(context = {}) { if (this.closing) throw A.fail('CANCELLED'); A.assertCurrent(context); }
  async _repository(root, context = {}) {
    this._current(context);
    const repo = await this.audits.repository(root, context);
    if (!this.cleaned.has(repo.repoRoot)) this.cleaned.set(repo.repoRoot, cleanupAuditRefs(this.github, repo.repoRoot, this.activeRefs, 'pr-audit-repair'));
    await this.cleaned.get(repo.repoRoot); this._current(context); return repo;
  }
  async _pr(repo, number, context = {}) {
    this._current(context);
    const pr = A.normalizePr(await this.github.getAuditPr(this.audits.args(repo, context, { number })), repo);
    if (pr.prNumber !== number) throw A.fail('INCOMPLETE');
    this._current(context); return { ...pr, number };
  }
  report(root, item) {
    const row = this.audits.row(root, item.auditRef);
    if (A.repairRevision(row) !== item.repairRevision) throw S.fail('REPAIR_CHANGED');
    const findings = S.selectFindings(row, item.findingIds);
    return { row, findings };
  }
  sourceRow(root, ref) {
    if (!S.REF_RE.test(ref)) throw S.fail();
    const row = this.store.get(ref, projectKey(root)); if (!row) throw S.fail('REPAIR_NOT_FOUND'); return row;
  }
  protectsReport(auditRef) {
    return this.reportPins.has(auditRef) || this.store.list().some((row) => row.auditRef === auditRef && this.store.protected(row));
  }
  async withReportPin(auditRef, action) {
    this.reportPins.set(auditRef, (this.reportPins.get(auditRef) || 0) + 1);
    try { return await action(); } finally {
      const count = this.reportPins.get(auditRef) - 1;
      if (count) this.reportPins.set(auditRef, count); else this.reportPins.delete(auditRef);
    }
  }
  async withSnapshot(root, row, findings, context, action) {
    await this._repository(root, context);
    const operationRef = A.ref(); this.activeRefs.add(operationRef); let snapshot;
    try {
      snapshot = await this.audits.capture(root, row.prNumber, operationRef, context, row.source, 'pr-audit-repair');
      for (const finding of findings) {
        const file = snapshot.files.find((f) => f.path === finding.path);
        if (!file || !A.scopePath(file.path, row.source.prefix) || !A.scopePath(file.oldPath, row.source.prefix)
          || !A.validLocation(finding, snapshot.files)) throw A.fail('LOCATION');
      }
      this._current(context);
      if (A.repairRevision(this.audits.row(root, row.auditRef)) !== A.repairRevision(row)) throw S.fail('REPAIR_CHANGED');
      return await action(snapshot);
    } finally { try { await snapshot?.cleanup(); } finally { this.activeRefs.delete(operationRef); } }
  }
  async snapshot(projectPath, payload, context = {}) {
    const root = this._root(projectPath);
    try {
      A.keys(payload, ['auditRef', 'repairRevision', 'findingIds']); this._current(context);
      const row = this.audits.row(root, payload.auditRef);
      if (!A.digest(payload.repairRevision) || A.repairRevision(row) !== payload.repairRevision) throw S.fail('REPAIR_CHANGED');
      const findings = S.selectFindings(row, payload.findingIds);
      return await this.withReportPin(row.auditRef, () => this.withSnapshot(root, row, findings, context, async () => {
        const item = this.store.put({ auditRepairRef: A.ref('par'), auditRef: row.auditRef, projectKey: row.projectKey,
          repairRevision: payload.repairRevision, findingIds: findings.map((f) => f.findingId),
          ...Object.fromEntries(S.SOURCE_FIELDS.map((key) => [key, row.source[key]])), createdAt: new Date(this.now()).toISOString() });
        return { ok: true, auditRepairRef: item.auditRepairRef, source: S.publicSource(item), persistence: this.persistenceStatus() };
      }));
    } catch (cause) { return A.error(cause); }
  }
  persistenceStatus() {
    const source = this.store.persistenceStatus(); const report = this.audits.store.persistenceStatus();
    if (!report.durable) return { ...source, persistence: 'memory', durable: false, error: report.error || 'PR_AUDIT_REPAIR_STORE_MEMORY' };
    return source;
  }
  async source(projectPath, ref, context = {}) {
    try {
      const root = this._root(projectPath); const item = this.sourceRow(root, ref); const repo = await this._repository(root, context);
      if (repo.repoKey !== item.repoKey || repo.prefix !== item.prefix) throw S.fail('REPAIR_CHANGED');
      this._current(context); return { ok: true, source: S.publicSource(item) };
    } catch (cause) { return A.error(cause); }
  }
  async resolveMetadata(projectPath, ref, context = {}) {
    const root = this._root(projectPath); this._current(context);
    const item = this.sourceRow(root, ref); this.report(root, item);
    const repo = await this._repository(root, context); const pr = await this._pr(repo, item.prNumber, context);
    const source = { ...pr, repoKey: repo.repoKey, prefix: repo.prefix };
    if (A.sourceKey(source) !== A.sourceKey(item)) throw S.fail('REPAIR_CHANGED');
    const mergeBase = await this.github.getAuditMergeBase(this.audits.args(repo, context, source));
    if (mergeBase !== item.mergeBaseSha) throw S.fail('REPAIR_CHANGED');
    this.report(root, item); this._current(context);
    return { repo, pr, snapshot: item, source: { kind: 'pr_audit', auditRepairRef: ref }, sourceFingerprint: S.sourceFingerprint(item),
      baseHead: item.headSha, sourceLabel: `PR #${item.prNumber} · AI 审查 · ${item.findingIds.length} 项发现`,
      approvalLabel: `处理 PR #${item.prNumber} 的 ${item.findingIds.length} 项 AI 审查发现（隔离修复）` };
  }
  async materializeRepairSource(projectPath, ref, context = {}) {
    const root = this._root(projectPath); const resolved = await this.resolveMetadata(root, ref, context);
    const { row, findings } = this.report(root, resolved.snapshot);
    return this.withReportPin(row.auditRef, () => this.withSnapshot(root, row, findings, context, async (snapshot) => {
      const sections = [`PR head: ${row.source.headSha}; merge-base: ${row.source.mergeBaseSha}`];
      for (const f of findings) {
        const file = snapshot.files.find((entry) => entry.path === f.path);
        const snippet = await snapshot.read({ path: f.side === 'LEFT' ? file.oldPath : file.path, side: f.side,
          offset: Math.max(1, f.startLine - 8), limit: Math.min(60, f.line - f.startLine + 17) }, false);
        sections.push(`[${f.priority}] ${f.title}\n${f.body}\n位置: ${f.path} · ${f.side} ${f.startLine}-${f.line}\n变更: ${file.status || 'modified'}; 原路径: ${file.oldPath}\n固定提交 ${snippet.sha}:\n${snippet.content}`);
      }
      this._current(context); this.report(root, resolved.snapshot);
      const auditText = sections.join('\n\n');
      if (Buffer.byteLength(auditText, 'utf8') > S.MAX_CONTEXT_BYTES) throw S.fail('REPAIR_CONTEXT_LIMIT');
      return { source: resolved.source, sourceFingerprint: resolved.sourceFingerprint, baseHead: resolved.baseHead,
        sourceLabel: resolved.sourceLabel, approvalLabel: resolved.approvalLabel, auditText,
        result: { diagnostics: [], stdout: '', stderr: '' }, ...(context.validationProfile ? { validationProfile: context.validationProfile } : {}),
        createWorktree: (args) => createRemoteWorktree(this, ref, args, context) };
    }));
  }
  async _exclusive(key, action) {
    if (this.pending.has(key)) return A.error(A.fail('BUSY'));
    this.pending.add(key); try { return await action(); } finally { this.pending.delete(key); }
  }
  async updatePr(root, resultId, subject, context) {
    const out = await updatePr(this, root, resultId, subject, context);
    if (out?.ok && out.result?.auditRepairRef) {
      const item = this.store.get(out.result.auditRepairRef, projectKey(this._root(root)));
      if (item) { try { const row = this.audits.row(root, item.auditRef); this.audits.save({ ...row, stale: true }); } catch {} }
    }
    return out;
  }
  close() { this.closing = true; this.store.close(); }
}
module.exports = { PrAuditRepairManager, createPrAuditRepairManager: (options) => new PrAuditRepairManager(options) };
