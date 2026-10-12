'use strict';
const path = require('node:path');
const { canonicalProjectPath, projectKey } = require('./project-index');
const A = require('./pr-audit-state');
const R = require('./pr-audit-recheck-state');

const ascending = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const sameScope = (a, b) => a && b && ['repoKey', 'prNumber', 'prefix'].every((k) => a[k] === b[k]);
const identity = (row) => row.source || row;
const sameTarget = (a, b) => ['repoKey', 'prNumber', 'prefix', 'baseSha', 'headSha', 'mergeBaseSha', 'baseRefName', 'headRefName', 'descriptionHash'].every((k) => a?.[k] === b?.[k]);
const pick = (row, fields) => Object.fromEntries(fields.filter((k) => row?.[k] !== undefined).map((k) => [k, row[k]]));

// A disposable read model. It never persists verdicts or grants mutation authority.
function buildTracking({ auditRef, audits, sources, followups, repairs, rechecks, results = [], warnings = [], freshness = () => 'unknown' }) {
  const audit = audits.find((r) => r.auditRef === auditRef);
  const anchor = audit?.source || sources.find((s) => s.auditRef === auditRef)
    || followups.find((s) => s.auditRef === auditRef) || rechecks.find((r) => r.source.auditRef === auditRef)?.source;
  if (!anchor) throw A.fail('NOT_FOUND');
  const notices = new Set(warnings);
  if (!audit?.report) notices.add('原始审查报告不可用');
  const original = audit?.report?.findings || [];
  const sourceMap = new Map(sources.filter((s) => s.auditRef === auditRef && sameScope(s, anchor)).map((s) => [s.auditRepairRef, s]));
  const followMap = new Map(followups.filter((s) => s.auditRef === auditRef && sameScope(s, anchor)).map((s) => [s.recheckRepairRef, s]));
  const checks = rechecks.filter((r) => r.source.auditRef === auditRef && sameScope(r.source, anchor));
  const checkMap = new Map(checks.map((r) => [r.recheckRef, r]));
  const resultMap = new Map(results.map((r) => [r.id, r]));
  const checksPublic = checks.map((r) => ({ id: r.recheckRef, recheckRef: r.recheckRef, createdAt: r.createdAt,
    status: r.status, resultId: r.source.resultId, headSha: r.target?.headSha, repairCommit: r.source.repairCommit,
    freshness: r.status === 'completed' ? freshness(r) : 'unknown',
    findings: (r.report?.findings || []).map((f) => pick(f, ['findingId', 'status', 'reason'])) })).sort(ascending);

  function sourceFor(r) {
    return r.source.kind === 'pr_audit' ? sourceMap.get(r.source.auditRepairRef)
      : r.source.kind === 'pr_audit_recheck' ? followMap.get(r.source.recheckRepairRef) : null;
  }
  const rounds = [];
  for (const repair of repairs) {
    const source = sourceFor(repair);
    // When a source is lost, an explicit result reference from a retained recheck is still usable.
    const related = checks.filter((r) => r.source.resultId === repair.resultId && repair.resultId
      && (repair.source.kind === 'pr_audit' ? r.source.auditRepairRef === repair.source.auditRepairRef && !r.source.recheckRepairRef
        : repair.source.kind === 'pr_audit_recheck' && r.source.recheckRepairRef === repair.source.recheckRepairRef));
    if (!source && !related.length) continue;
    const issues = [];
    if (!source) issues.push('修复来源缺失');
    const parent = source?.recheckRef && checkMap.get(source.recheckRef);
    if (source?.recheckRef && (!parent || parent.source.resultId !== source.parentResultId
      || R.repairRevision(parent) !== source.repairRevision)) issues.push('父复审缺失或关联冲突');
    if (source && repair.source.kind === 'pr_audit' && audit?.report
      && A.repairRevision({ ...audit, stale: false }) !== source.repairRevision) issues.push('原报告与修复来源不一致');
    if (source && repair.source.kind === 'pr_audit_recheck' && !sourceMap.has(source.auditRepairRef)) issues.push('初始修复来源缺失');
    const findingIds = source?.findingIds || related[0].source.findingIds;
    if (audit?.report && findingIds.some((id) => !original.some((f) => f.findingId === id))) issues.push('原问题关联缺失');
    const result = resultMap.get(repair.resultId);
    const resultMatches = result && result.originKind === repair.source.kind
      && (repair.source.kind === 'pr_audit' ? result.auditRepairRef === repair.source.auditRepairRef : result.recheckRepairRef === repair.source.recheckRepairRef)
      && (!result.prUpdate?.prNumber || result.prUpdate.prNumber === anchor.prNumber);
    if (repair.resultId && !resultMatches) issues.push('交付记录缺失或关联冲突');
    rounds.push({ id: repair.repairRef, repairRef: repair.repairRef, createdAt: repair.createdAt, status: repair.status,
      findingIds: [...findingIds], parentRecheckRef: source?.recheckRef || null, parentRoundId: null,
      resultId: repair.resultId, resultAvailable: !!resultMatches, baseHead: source?.headSha,
      validationStatus: repair.validation?.status || 'not_run', deliveryStatus: resultMatches ? result.state : 'unavailable',
      repairCommit: resultMatches ? result.prUpdate?.newCommit : undefined,
      recheckRefs: related.map((r) => r.recheckRef), issues });
  }
  // Rechecks remain useful even if their generating task has been evicted. Do not invent a round.
  const orphanRecheckRefs = checks.filter((c) => !rounds.some((r) => r.recheckRefs.includes(c.recheckRef))).map((r) => r.recheckRef);
  if (orphanRecheckRefs.length) notices.add('部分复审对应的修复任务缺失');
  for (const round of rounds) {
    if (!round.parentRecheckRef || round.issues.includes('父复审缺失或关联冲突')) continue;
    const candidates = rounds.filter((r) => r.recheckRefs.includes(round.parentRecheckRef));
    if (candidates.length === 1) round.parentRoundId = candidates[0].id;
    else round.issues.push('父轮次缺失或关联冲突');
  }
  const roundMap = new Map(rounds.map((r) => [r.id, r]));
  for (const round of rounds) {
    const seen = new Set([round.id]); let next = round.parentRoundId;
    while (next) {
      if (seen.has(next)) { round.parentRoundId = null; round.issues.push('轮次关联存在循环'); break; }
      seen.add(next); next = roundMap.get(next)?.parentRoundId;
    }
  }
  rounds.sort(ascending).forEach((r, i) => { r.number = i + 1; if (r.issues.length) notices.add('部分轮次历史不完整'); });
  const findings = original.map((f) => {
    const history = checksPublic.filter((r) => r.findings.some((v) => v.findingId === f.findingId));
    const latest = history.filter((r) => r.status === 'completed').at(-1);
    const verdict = latest?.findings.find((v) => v.findingId === f.findingId);
    return { ...pick(f, ['findingId', 'title', 'priority', 'path', 'side', 'startLine', 'line']),
      latest: latest ? { recheckRef: latest.recheckRef, createdAt: latest.createdAt, headSha: latest.headSha,
        freshness: latest.freshness, status: verdict.status, reason: verdict.reason } : null,
      roundIds: rounds.filter((r) => r.findingIds.includes(f.findingId)).map((r) => r.id), recheckRefs: history.map((r) => r.recheckRef) };
  });
  const counts = { total: findings.length, resolved: 0, still_present: 0, unknown: 0, stale: 0, unverified: 0, unchecked: 0 };
  for (const f of findings) {
    if (!f.latest) counts.unchecked++;
    else if (f.latest.freshness === 'stale') counts.stale++;
    else if (f.latest.freshness !== 'current') counts.unverified++;
    else counts[f.latest.status]++;
  }
  return { auditRef, prNumber: anchor.prNumber, createdAt: audit?.createdAt || anchor.createdAt || checks[0]?.createdAt,
    status: audit?.status || 'unavailable', sourceAvailable: !!audit?.report, findings, rounds,
    rechecks: checksPublic, orphanRecheckRefs, counts, warnings: [...notices] };
}

class PrAuditTracking {
  constructor(options) { Object.assign(this, options); }
  async load(root, ctx) {
    root = canonicalProjectPath(root); A.assertCurrent(ctx);
    const key = projectKey(root);
    const resolved = await this.audits.github.getCiWatchRepository({ projectPath: root, signal: ctx.signal, localOnly: true, timeoutMs: 15000 });
    A.assertCurrent(ctx);
    if (!resolved?.ok || !resolved.repository) throw A.fail('UNAVAILABLE');
    const repo = resolved.repository;
    const prefix = path.relative(canonicalProjectPath(repo.repoRoot), root).replace(/\\/g, '/');
    if (!A.digest(repo.repoKey) || !A.scopePath(`${prefix ? prefix + '/' : ''}file`, prefix)) throw A.fail('BINDING');
    const warnings = [];
    const persistence = {};
    const read = (name, store) => {
      try {
        persistence[name] = store.persistenceStatus();
        if (persistence[name].error || persistence[name].corrupt) warnings.push(`${name}历史读取不完整`);
        return store.list(key).filter((r) => r.projectKey === key);
      } catch { warnings.push(`${name}历史不可用`); return []; }
    };
    const scoped = (r) => identity(r)?.repoKey === repo.repoKey && identity(r)?.prefix === prefix;
    return { root, key, repo: { ...repo, prefix }, warnings, persistence,
      audits: read('审查', this.audits.store).filter(scoped), sources: read('初始修复来源', this.auditRepairs.store).filter(scoped),
      followups: read('续修来源', this.followups.store).filter(scoped), repairs: read('修复', this.repairs.store),
      rechecks: read('复审', this.rechecks.store).filter(scoped) };
  }
  groups(data) {
    const groups = new Map();
    for (const row of [...data.audits, ...data.sources, ...data.followups, ...data.rechecks]) {
      const src = identity(row); const ref = row.auditRef || src.auditRef;
      if (A.isRef(ref) && !groups.has(ref)) groups.set(ref, { auditRef: ref, prNumber: src.prNumber,
        createdAt: row.createdAt, status: data.audits.find((a) => a.auditRef === ref)?.status || 'unavailable' });
    }
    return [...groups.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.auditRef.localeCompare(a.auditRef));
  }
  async list(root, prNumber, ctx = {}) {
    try {
      if (prNumber !== undefined && !A.number(prNumber)) throw A.fail();
      const data = await this.load(root, ctx);
      const reports = this.groups(data).filter((r) => !prNumber || r.prNumber === prNumber).map((r) => ({ ...r,
        sourceAvailable: !!data.audits.find((a) => a.auditRef === r.auditRef)?.report,
        findingCount: data.audits.find((a) => a.auditRef === r.auditRef)?.report?.findings.length || 0 }));
      return { ok: true, projectKey: data.key, reports, warnings: data.warnings, persistence: data.persistence };
    } catch (cause) { return A.error(cause); }
  }
  async get(root, auditRef, ctx = {}) {
    try {
      if (!A.isRef(auditRef)) throw A.fail();
      const data = await this.load(root, ctx);
      const group = this.groups(data).find((g) => g.auditRef === auditRef);
      if (!group) throw A.fail('NOT_FOUND');
      let target; let fallback = 'unknown'; let checkedAt = null;
      try {
        const args = { ...data.repo, signal: ctx.signal, number: group.prNumber };
        const pr = A.normalizePr(await this.audits.github.getAuditPr(args), data.repo);
        A.assertCurrent(ctx);
        if (pr.prNumber !== group.prNumber) throw A.fail('INCOMPLETE');
        const mergeBaseSha = await this.audits.github.getAuditMergeBase({ ...args, ...pr });
        A.assertCurrent(ctx);
        target = R.target({ ...pick(pr, ['prNumber', 'baseSha', 'headSha', 'baseRefName', 'headRefName', 'descriptionHash']),
          repoKey: data.repo.repoKey, prefix: data.repo.prefix, mergeBaseSha });
        checkedAt = new Date().toISOString();
      } catch (cause) {
        A.assertCurrent(ctx);
        if (['PR_AUDIT_NOT_OPEN', 'PR_AUDIT_FORK', 'PR_AUDIT_CHANGED'].includes(cause.code)) {
          fallback = 'stale'; checkedAt = new Date().toISOString();
        } else data.warnings.push('当前 PR 状态未核实，保留历史结论');
      }
      let listed;
      try { listed = await this.worktree?.list({ projectPath: data.root }); } catch {}
      A.assertCurrent(ctx);
      if (!listed?.ok) data.warnings.push('交付记录暂时不可用');
      else if (listed.warnings?.length) data.warnings.push('部分交付记录未通过校验');
      const detail = buildTracking({ ...data, auditRef, results: listed?.ok ? listed.results : [],
        freshness: (r) => target ? (sameTarget(r.target, target) ? 'current' : 'stale') : fallback });
      return { ok: true, projectKey: data.key, detail: { ...detail, checkedAt }, persistence: data.persistence };
    } catch (cause) { return A.error(cause); }
  }
}
module.exports = { PrAuditTracking, buildTracking };
