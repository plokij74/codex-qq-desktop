'use strict';
const A = require('./pr-audit-state');
const { normalizeSha, normalizeHeadRef, normalizeProjectKey } = require('./remote-ci-state');

const REF_RE = /^par_[a-f0-9]{24}$/;
const MAX_FINDINGS = 5;
const MAX_CONTEXT_BYTES = 32 * 1024;
const SOURCE_FIELDS = Object.freeze(['repoKey', 'prNumber', 'headSha', 'baseSha', 'mergeBaseSha', 'headRefName', 'baseRefName', 'prefix', 'descriptionHash', 'changedFiles']);
const FIELDS = ['auditRepairRef', 'auditRef', 'projectKey', 'repairRevision', 'findingIds', 'createdAt', ...SOURCE_FIELDS];
const fail = (code = 'REPAIR_INVALID') => A.fail(code);
function normalizeNote(value = '') { return A.text(value, 2000, true).replace(/\r\n/g, '\n').trim(); }
function normalizeSnapshot(raw) {
  A.keys(raw, FIELDS);
  if (!REF_RE.test(raw.auditRepairRef) || !A.isRef(raw.auditRef) || !normalizeProjectKey(raw.projectKey)
    || !A.digest(raw.repoKey) || !A.digest(raw.repairRevision) || !A.digest(raw.descriptionHash) || !A.number(raw.prNumber)
    || !Array.isArray(raw.findingIds) || !raw.findingIds.length || raw.findingIds.length > MAX_FINDINGS
    || new Set(raw.findingIds).size !== raw.findingIds.length || raw.findingIds.some((id) => !A.isRef(id, 'paf'))
    || !['headSha', 'baseSha', 'mergeBaseSha'].every((key) => normalizeSha(raw[key]) === raw[key])
    || !['headRefName', 'baseRefName'].every((key) => normalizeHeadRef(raw[key]) === raw[key])
    || typeof raw.prefix !== 'string' || !A.scopePath(`${raw.prefix ? `${raw.prefix}/` : ''}file`, raw.prefix)
    || !Number.isSafeInteger(raw.changedFiles) || raw.changedFiles < 0 || raw.changedFiles > A.LIMITS.remoteFiles
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) throw fail();
  return structuredClone(raw);
}
function sourceFingerprint(raw) {
  const row = normalizeSnapshot(raw);
  return A.hash([row.auditRef, row.projectKey, row.repairRevision, row.findingIds, SOURCE_FIELDS.map((key) => row[key])]);
}
function publicSource(row) {
  return { auditRepairRef: row.auditRepairRef, auditRef: row.auditRef, prNumber: row.prNumber,
    findingIds: [...row.findingIds], headSha: row.headSha, createdAt: row.createdAt };
}
function selectFindings(row, ids) {
  if (row.status !== 'completed' || !row.source || !row.report || row.stale) throw fail('REPAIR_CHANGED');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FINDINGS || new Set(ids).size !== ids.length
    || ids.some((id) => !A.isRef(id, 'paf'))) throw fail();
  const selected = row.report.findings.filter((f) => ids.includes(f.findingId));
  if (selected.length !== ids.length) throw fail();
  return selected;
}
module.exports = { REF_RE, MAX_FINDINGS, MAX_CONTEXT_BYTES, SOURCE_FIELDS, normalizeSnapshot, sourceFingerprint, publicSource, selectFindings, normalizeNote, fail };
