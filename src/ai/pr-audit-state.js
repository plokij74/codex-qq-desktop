'use strict';

const crypto = require('node:crypto');
const { validPath } = require('./pr-review-state');
const { normalizeSha, normalizeHeadRef, normalizeProjectKey, redactRemoteText } = require('./remote-ci-state');

const LIMITS = Object.freeze({ files: 100, remoteFiles: 1000, diff: 256 * 1024, blob: 128 * 1024,
  context: 512 * 1024, report: 256 * 1024, findings: 30, body: 5000, turns: 8, timeout: 300000 });
const ACTIVE = new Set(['preparing', 'running']);
const STATES = new Set([...ACTIVE, 'completed', 'failed', 'cancelled', 'interrupted']);
const CODES = new Set(['INVALID', 'BINDING', 'UNAVAILABLE', 'UNSUPPORTED', 'NOT_FOUND', 'NOT_OPEN', 'FORK', 'CHANGED',
  'INCOMPLETE', 'LIMIT', 'CONTEXT_LIMIT', 'LOCATION', 'MODEL_REQUIRED', 'REPORT_INVALID', 'TURNS', 'TIMEOUT',
  'CANCELLED', 'BUSY', 'CONFIRM_REQUIRED', 'PUBLISHED', 'UNCERTAIN', 'PUBLISH_FAILED', 'STORE_CORRUPT', 'STORE_MEMORY']);
const ref = (prefix = 'pra') => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const isRef = (value, prefix = 'pra') => typeof value === 'string' && new RegExp(`^${prefix}_[a-f0-9]{24}$`).test(value);
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const remoteId = (value) => Number.isSafeInteger(value) && value > 0;
function fail(code = 'INVALID') {
  const suffix = String(code).replace(/^PR_AUDIT_/, '');
  const error = new Error(`PR_AUDIT_${CODES.has(suffix) ? suffix : 'UNAVAILABLE'}`); error.code = error.message; return error;
}
const error = (cause) => ({ ok: false, code: fail(cause?.code).code, error: fail(cause?.code).message });
function assertCurrent(context = {}) {
  if (context.signal?.aborted) throw fail(context.signal.reason?.code === 'PR_AUDIT_TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
  if (context.isCurrent?.() === false) throw fail('BINDING');
}
function text(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || (!allowEmpty && !value.trim())) throw fail('INVALID');
  return value;
}
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw fail();
  return value;
}
function scopePath(path, prefix = '') {
  if (!validPath(path) || !validPath(prefix || 'scope')) return false;
  const p = process.platform === 'win32' ? path.toLowerCase() : path;
  const dir = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return !dir || p.startsWith(`${dir}/`);
}
function normalizePr(raw, repo) {
  if (!raw || !number(raw.number) || raw.baseRepo?.toLowerCase() !== repo.nameWithOwner.toLowerCase()) throw fail('INCOMPLETE');
  if (raw.state !== 'open' || raw.merged !== false) throw fail('NOT_OPEN');
  if (raw.headRepo?.toLowerCase() !== repo.nameWithOwner.toLowerCase()) throw fail('FORK');
  const headSha = normalizeSha(raw.headSha); const baseSha = normalizeSha(raw.baseSha);
  const headRefName = normalizeHeadRef(raw.headRefName); const baseRefName = normalizeHeadRef(raw.baseRefName);
  if (!headSha || !baseSha || !headRefName || !baseRefName || !Number.isSafeInteger(raw.changedFiles) || raw.changedFiles < 0) throw fail('INCOMPLETE');
  text(raw.title, 2000, true); text(raw.body ?? '', 128 * 1024, true);
  return { prNumber: raw.number, headSha, baseSha, headRefName, baseRefName, changedFiles: raw.changedFiles,
    title: raw.title, body: raw.body || '', descriptionHash: hash([raw.title, raw.body || '']) };
}
function sourceKey(value) {
  return hash([value.repoKey, value.prNumber, value.headSha, value.baseSha, value.headRefName, value.baseRefName, value.descriptionHash, value.prefix]);
}
function parsePatch(patch, expected = {}) {
  text(patch, LIMITS.diff, true);
  if (Buffer.byteLength(patch) > LIMITS.diff) throw fail('LIMIT');
  const lines = patch.split('\n'); if (lines.at(-1) === '') lines.pop();
  const hunks = []; let current; let additions = 0; let deletions = 0;
  const finish = () => {
    if (current && (current.left !== current.leftCount || current.right !== current.rightCount)) throw fail('INCOMPLETE');
  };
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (header) {
      finish();
      current = { leftStart: Number(header[1]), leftCount: Number(header[2] ?? 1), rightStart: Number(header[3]), rightCount: Number(header[4] ?? 1), left: 0, right: 0, changedLeft: [], changedRight: [] };
      if (Object.values(current).some((v) => typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0))) throw fail('INCOMPLETE');
      for (const side of ['left', 'right']) {
        if ((current[`${side}Count`] && !current[`${side}Start`])
          || current[`${side}Start`] + current[`${side}Count`] > 0x7fffffff) throw fail('INCOMPLETE');
        const previous = hunks.at(-1);
        if (previous && current[`${side}Start`] < previous[`${side}Start`] + previous[`${side}Count`]) throw fail('INCOMPLETE');
      }
      hunks.push(current); continue;
    }
    if (!current) throw fail('INCOMPLETE');
    if (line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) { current.changedRight.push(current.rightStart + current.right++); additions++; }
    else if (line.startsWith('-')) { current.changedLeft.push(current.leftStart + current.left++); deletions++; }
    else if (line.startsWith(' ')) { current.left++; current.right++; }
    else throw fail('INCOMPLETE');
    if (current.left > current.leftCount || current.right > current.rightCount) throw fail('INCOMPLETE');
  }
  finish();
  if (!hunks.length || (expected.additions != null && expected.additions !== additions)
    || (expected.deletions != null && expected.deletions !== deletions)) throw fail('INCOMPLETE');
  return hunks.map(({ left, right, ...hunk }) => hunk);
}
function validLocation(finding, files) {
  if (!['LEFT', 'RIGHT'].includes(finding.side) || !number(finding.line) || !number(finding.startLine)
    || finding.startLine > finding.line || finding.line - finding.startLine >= 20) return false;
  const file = files.find((f) => f.path === finding.path && !f.skipped);
  const side = finding.side === 'LEFT' ? 'left' : 'right';
  return !!file?.hunks?.some((h) => finding.startLine >= h[`${side}Start`] && finding.line < h[`${side}Start`] + h[`${side}Count`]
    && h[side === 'left' ? 'changedLeft' : 'changedRight'].some((line) => line >= finding.startLine && line <= finding.line));
}
function normalizeReport(raw, files) {
  try {
    keys(raw, ['summary', 'findings']); text(raw.summary, LIMITS.body);
    if (!Array.isArray(raw.findings) || raw.findings.length > LIMITS.findings || Buffer.byteLength(JSON.stringify(raw)) > LIMITS.report) throw fail();
    const seen = new Set();
    const findings = raw.findings.map((item) => {
      keys(item, ['priority', 'title', 'body', 'path', 'side', 'line', 'startLine']);
      if (!/^P[0-3]$/.test(item.priority)) throw fail();
      text(item.title, 200); text(item.body, LIMITS.body);
      const finding = { ...item, startLine: item.startLine ?? item.line };
      if (!validLocation(finding, files)) throw fail();
      const key = hash([finding.path, finding.side, finding.startLine, finding.line, finding.title, finding.body]);
      if (seen.has(key)) throw fail(); seen.add(key);
      return { ...finding, findingId: ref('paf'), title: redactRemoteText(finding.title), body: redactRemoteText(finding.body) };
    });
    return { summary: redactRemoteText(raw.summary), findings };
  } catch { throw fail('REPORT_INVALID'); }
}
function revision(row) { return hash([row.auditRef, row.source, row.status, row.stale, row.report, row.publication]); }
function publicationHashes(payload) {
  return { bodyHash: hash(payload.body), comments: (payload.comments || []).map((c) => ({ path: c.path, side: c.side,
    line: c.line, startLine: c.start_line || c.line, bodyHash: hash(c.body) })) };
}
function normalizeRecord(row) {
  if (!row || !isRef(row.auditRef) || !normalizeProjectKey(row.projectKey) || !STATES.has(row.status) || typeof row.createdAt !== 'string'
    || !Number.isFinite(Date.parse(row.createdAt)) || !number(row.prNumber) || Buffer.byteLength(JSON.stringify(row)) > 1024 * 1024) throw fail();
  if (row.source && (!normalizeSha(row.source.headSha) || !normalizeSha(row.source.baseSha) || !normalizeSha(row.source.mergeBaseSha)
    || !normalizeHeadRef(row.source.headRefName) || !normalizeHeadRef(row.source.baseRefName) || !digest(row.source.repoKey)
    || !digest(row.source.descriptionHash) || row.source.prNumber !== row.prNumber || !scopePath(`${row.source.prefix ? `${row.source.prefix}/` : ''}file`, row.source.prefix))) throw fail();
  if (row.report) {
    if (typeof row.report.summary !== 'string' || row.report.summary.length > LIMITS.body || !Array.isArray(row.report.findings) || row.report.findings.length > LIMITS.findings) throw fail();
    for (const f of row.report.findings) {
      if (!isRef(f.findingId, 'paf') || !validPath(f.path) || !['LEFT', 'RIGHT'].includes(f.side) || !number(f.line) || !number(f.startLine)
        || f.startLine > f.line || f.line - f.startLine >= 20 || !/^P[0-3]$/.test(f.priority)
        || (f.contextPath !== undefined && !validPath(f.contextPath))) throw fail();
      text(f.title, 200); text(f.body, LIMITS.body);
    }
  }
  if (row.publication) {
    const p = row.publication;
    if (!['publishing', 'published', 'uncertain', 'failed'].includes(p.status) || !isRef(p.publicationRef, 'pap')
      || !digest(p.bodyHash) || !remoteId(p.actorId) || !normalizeSha(p.commitId) || !Array.isArray(p.comments) || p.comments.length > LIMITS.findings
      || (p.reviewId !== undefined && !remoteId(p.reviewId))) throw fail();
    for (const c of p.comments) if (!validPath(c.path) || !digest(c.bodyHash) || !number(c.line) || !number(c.startLine)
      || c.startLine > c.line || c.line - c.startLine >= 20 || !['LEFT', 'RIGHT'].includes(c.side)) throw fail();
  }
  if (row.coverage && (!['total', 'scoped', 'outside', 'reviewed'].every((key) => Number.isSafeInteger(row.coverage[key]) && row.coverage[key] >= 0)
    || row.coverage.total > LIMITS.remoteFiles || row.coverage.scoped > LIMITS.files || !Array.isArray(row.coverage.skipped)
    || row.coverage.scoped + row.coverage.outside !== row.coverage.total
    || row.coverage.reviewed + row.coverage.skipped.length !== row.coverage.scoped)) throw fail();
  for (const skipped of row.coverage?.skipped || []) { if (!validPath(skipped.path)) throw fail(); text(skipped.reason, 100); }
  if (row.status === 'completed' && (!row.source || !row.report || !row.coverage)) throw fail();
  return structuredClone(row);
}
module.exports = { LIMITS, ACTIVE, STATES, ref, isRef, hash, digest, number, remoteId, fail, error, assertCurrent, text, keys,
  scopePath, normalizePr, sourceKey, parsePatch, validLocation, normalizeReport, revision, publicationHashes, normalizeRecord };
