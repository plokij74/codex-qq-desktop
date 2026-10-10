'use strict';
const A = require('./pr-audit-state');
const R = require('./pr-audit-recheck-state');
const { normalizeProjectKey } = require('./remote-ci-state');
const { isResultId } = require('./worktree-state');
const REF_RE = /^pcr_[a-f0-9]{24}$/;
const TARGET_FIELDS = ['repoKey', 'prNumber', 'prefix', 'headSha', 'baseSha', 'mergeBaseSha', 'headRefName', 'baseRefName', 'descriptionHash'];
const FIELDS = ['recheckRepairRef', 'recheckRef', 'parentResultId', 'auditRef', 'auditRepairRef', 'projectKey',
  'repairRevision', 'findingIds', 'createdAt', ...TARGET_FIELDS];
const fail = (code = 'REPAIR_INVALID') => A.fail(code);
function normalizeSnapshot(raw) {
  A.keys(raw, FIELDS);
  if (!REF_RE.test(raw.recheckRepairRef) || !R.isRef(raw.recheckRef) || !isResultId(raw.parentResultId)
    || !A.isRef(raw.auditRef) || !A.isRef(raw.auditRepairRef, 'par') || !normalizeProjectKey(raw.projectKey)
    || !A.digest(raw.repairRevision) || !Array.isArray(raw.findingIds) || !raw.findingIds.length || raw.findingIds.length > 5
    || new Set(raw.findingIds).size !== raw.findingIds.length || raw.findingIds.some((id) => !A.isRef(id, 'paf'))
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) throw fail();
  R.target(Object.fromEntries(TARGET_FIELDS.map((k) => [k, raw[k]])));
  return structuredClone(raw);
}
function sourceFingerprint(raw) {
  const row = normalizeSnapshot(raw);
  return A.hash(FIELDS.filter((k) => !['recheckRepairRef', 'createdAt'].includes(k)).map((k) => row[k]));
}
function selectFindings(row, ids) {
  if (row.status !== 'completed' || !row.target || !row.report) throw fail('REPAIR_CHANGED');
  if (!Array.isArray(ids) || !ids.length || ids.length > 5 || new Set(ids).size !== ids.length
    || ids.some((id) => !A.isRef(id, 'paf'))) throw fail();
  const selected = row.report.findings.filter((f) => ids.includes(f.findingId));
  if (selected.length !== ids.length || selected.some((f) => !['still_present', 'unknown'].includes(f.status))) throw fail();
  return selected;
}
function publicSource(row) {
  return { recheckRepairRef: row.recheckRepairRef, recheckRef: row.recheckRef, parentResultId: row.parentResultId,
    auditRef: row.auditRef, auditRepairRef: row.auditRepairRef, prNumber: row.prNumber,
    findingIds: [...row.findingIds], headSha: row.headSha, createdAt: row.createdAt };
}
module.exports = { REF_RE, TARGET_FIELDS, normalizeSnapshot, sourceFingerprint, selectFindings, publicSource, fail };
