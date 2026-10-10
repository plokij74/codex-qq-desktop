'use strict';
const A = require('./pr-audit-state');
const { isResultId } = require('./worktree-state');
const { normalizeSha, normalizeHeadRef, normalizeProjectKey, redactRemoteText } = require('./remote-ci-state');
const ACTIVE = new Set(['preparing', 'running']);
const STATES = new Set([...ACTIVE, 'completed', 'failed', 'cancelled', 'interrupted']);
const STAGES = ['original_head', 'original_base', 'repair_base', 'repair', 'target'];
const sha = (v) => typeof v === 'string' && normalizeSha(v) === v;
const ref = () => A.ref('pac');
const isRef = (v) => A.isRef(v, 'pac');
const SOURCE_FIELDS = ['auditRef', 'auditRepairRef', 'resultId', 'repoKey', 'prNumber', 'prefix', 'headRefName', 'baseRefName',
  'originalHead', 'originalBase', 'repairBaseHead', 'repairCommit', 'expectedTree', 'repairRevision', 'findingIds',
  'recheckRepairRef', 'parentRecheckRef'];
function source(raw) {
  A.keys(raw, SOURCE_FIELDS);
  if (!A.isRef(raw.auditRef) || !A.isRef(raw.auditRepairRef, 'par') || !isResultId(raw.resultId) || !A.digest(raw.repoKey)
    || !A.number(raw.prNumber) || !A.digest(raw.repairRevision) || !['originalHead', 'originalBase', 'repairCommit', 'expectedTree'].every((k) => sha(raw[k]))
    || !['headRefName', 'baseRefName'].every((k) => typeof raw[k] === 'string' && raw[k] && normalizeHeadRef(raw[k]) === raw[k]) || typeof raw.prefix !== 'string'
    || !A.scopePath(`${raw.prefix ? `${raw.prefix}/` : ''}file`, raw.prefix)
    || !Array.isArray(raw.findingIds) || !raw.findingIds.length || raw.findingIds.length > 5
    || new Set(raw.findingIds).size !== raw.findingIds.length || raw.findingIds.some((id) => !A.isRef(id, 'paf'))) throw A.fail('RECHECK_SOURCE');
  const repairBaseHead = raw.repairBaseHead ?? raw.originalHead;
  if (!sha(repairBaseHead)) throw A.fail('RECHECK_SOURCE');
  if (raw.recheckRepairRef !== undefined) {
    if (!A.isRef(raw.recheckRepairRef, 'pcr') || !isRef(raw.parentRecheckRef) || !sha(raw.repairBaseHead)) throw A.fail('RECHECK_SOURCE');
  } else if (raw.parentRecheckRef !== undefined || repairBaseHead !== raw.originalHead) throw A.fail('RECHECK_SOURCE');
  const normalized = { ...structuredClone(raw), repairBaseHead };
  // Migration and live capture must hash the same semantic source in the same order.
  return Object.fromEntries(SOURCE_FIELDS.filter((key) => normalized[key] !== undefined).map((key) => [key, normalized[key]]));
}
function target(raw) {
  A.keys(raw, ['repoKey', 'prNumber', 'prefix', 'baseSha', 'headSha', 'mergeBaseSha', 'baseRefName', 'headRefName', 'descriptionHash']);
  if (!A.digest(raw.repoKey) || !A.number(raw.prNumber) || !A.digest(raw.descriptionHash)
    || !['baseSha', 'headSha', 'mergeBaseSha'].every((k) => sha(raw[k]))
    || !['baseRefName', 'headRefName'].every((k) => typeof raw[k] === 'string' && raw[k] && normalizeHeadRef(raw[k]) === raw[k])
    || typeof raw.prefix !== 'string' || !A.scopePath(`${raw.prefix ? `${raw.prefix}/` : ''}file`, raw.prefix)) throw A.fail();
  return structuredClone(raw);
}
function evidence(raw, row) {
  A.keys(raw, ['evidenceId', 'stage', 'sha', 'path', 'kind', 'startLine', 'line', 'existedBefore']);
  const expected = { original_head: row.source.originalHead, original_base: row.source.originalBase,
    repair_base: row.source.repairBaseHead, repair: row.source.repairCommit, target: row.target?.headSha };
  if (!A.isRef(raw.evidenceId, 'pce') || !STAGES.includes(raw.stage) || raw.sha !== expected[raw.stage]
    || !A.scopePath(raw.path, row.source.prefix) || !['code', 'absence'].includes(raw.kind)) throw A.fail('REPORT_INVALID');
  if (raw.kind === 'code' && (!A.number(raw.startLine) || !A.number(raw.line) || raw.line < raw.startLine || raw.line - raw.startLine >= 200)) throw A.fail('REPORT_INVALID');
  if (raw.kind === 'absence' && (raw.stage !== 'target' || typeof raw.existedBefore !== 'boolean' || raw.line !== undefined || raw.startLine !== undefined)) throw A.fail('REPORT_INVALID');
  return structuredClone(raw);
}
function report(raw, ids, ledger) {
  try {
    A.keys(raw, ['summary', 'findings']); A.text(raw.summary, 5000);
    if (!Array.isArray(raw.findings) || raw.findings.length !== ids.length || Buffer.byteLength(JSON.stringify(raw)) > A.LIMITS.report) throw A.fail();
    const seen = new Set();
    const findings = raw.findings.map((f) => {
      A.keys(f, ['findingId', 'status', 'reason', 'evidence']); A.text(f.reason, 5000);
      if (!ids.includes(f.findingId) || seen.has(f.findingId) || !['resolved', 'still_present', 'unknown'].includes(f.status)
        || !Array.isArray(f.evidence) || f.evidence.length > 8 || new Set(f.evidence).size !== f.evidence.length) throw A.fail();
      seen.add(f.findingId);
      const items = f.evidence.map((id) => { const e = ledger.get(id); if (!e) throw A.fail(); return e; });
      if (f.status !== 'unknown' && !items.some((e) => e.stage === 'target' && (e.kind === 'code'
        || (f.status === 'resolved' && e.kind === 'absence' && e.existedBefore)))) throw A.fail();
      return { findingId: f.findingId, status: f.status, reason: redactRemoteText(f.reason), evidence: [...f.evidence] };
    });
    return { summary: redactRemoteText(raw.summary), findings: ids.map((id) => findings.find((f) => f.findingId === id)) };
  } catch { throw A.fail('REPORT_INVALID'); }
}
function record(raw) {
  A.keys(raw, ['recheckRef', 'projectKey', 'prNumber', 'source', 'target', 'status', 'freshness', 'createdAt', 'finishedAt', 'model', 'turns', 'usage', 'errorCode', 'report', 'evidence']);
  if (!isRef(raw.recheckRef) || !normalizeProjectKey(raw.projectKey) || !STATES.has(raw.status) || !A.number(raw.prNumber)
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || !['current', 'stale', 'unknown'].includes(raw.freshness)
    || Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024) throw A.fail();
  const row = structuredClone(raw); row.source = source(row.source);
  if (row.prNumber !== row.source.prNumber) throw A.fail();
  if (row.target) {
    row.target = target(row.target);
    if (['repoKey', 'prNumber', 'prefix', 'baseRefName', 'headRefName'].some((k) => row.target[k] !== row.source[k])) throw A.fail();
  }
  if (row.model !== undefined) A.text(row.model, 200, true);
  if (row.errorCode !== undefined) A.text(row.errorCode, 80);
  if (row.finishedAt !== undefined && !Number.isFinite(Date.parse(row.finishedAt))) throw A.fail();
  if (row.turns !== undefined && (!Number.isSafeInteger(row.turns) || row.turns < 0 || row.turns > 8)) throw A.fail();
  if (row.usage) { A.keys(row.usage, ['inputTokens', 'outputTokens', 'estimated']); if (!['inputTokens', 'outputTokens'].every((k) => Number.isSafeInteger(row.usage[k]) && row.usage[k] >= 0) || typeof row.usage.estimated !== 'boolean') throw A.fail(); }
  if (row.evidence) {
    if (!Array.isArray(row.evidence) || row.evidence.length > 40) throw A.fail();
    row.evidence = row.evidence.map((e) => evidence(e, row));
    if (new Set(row.evidence.map((e) => e.evidenceId)).size !== row.evidence.length) throw A.fail();
  }
  if (row.report) row.report = report(row.report, row.source.findingIds, new Map((row.evidence || []).map((e) => [e.evidenceId, e])));
  if (row.status === 'completed' && (!row.target || !row.report)) throw A.fail();
  return row;
}
function repairRevision(row) {
  const r = record(row);
  return A.hash([r.recheckRef, r.projectKey, r.status, r.source, r.target, r.report, r.evidence || []]);
}
module.exports = { ACTIVE, STATES, STAGES, sha, ref, isRef, source, target, evidence, report, record, repairRevision };
