'use strict';

const crypto = require('node:crypto');

const REMOTE_CI_REF_RE = /^rci_[a-f0-9]{24}$/;
const DECIMAL_ID_RE = /^[1-9][0-9]{0,39}$/;
const SHA1_RE = /^[a-f0-9]{40}$/i;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/i;
const PROJECT_KEY_RE = /^[a-f0-9]{32,128}$/i;

const MAX_CHECK_RUNS = 200;
const MAX_ANNOTATIONS = 50;
const MAX_ANNOTATION_PATH = 500;
const MAX_ANNOTATION_TEXT = 1500;
const MAX_FAILED_STEPS = 20;
const MAX_RAW_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_EXCERPT_BYTES = 16 * 1024;
const MAX_CHECK_OUTPUT_BYTES = 4 * 1024;
const MAX_REMOTE_CONTEXT_BYTES = 32 * 1024;
const MAX_ERROR = 500;

const ALLOWED_CONCLUSIONS = new Set(['failure', 'timed_out']);
const FIXED_ERROR_CODES = new Set([
  'REMOTE_CI_PROJECT_BINDING_INVALID', 'REMOTE_CI_INVALID', 'REMOTE_CI_NOT_FOUND',
  'REMOTE_CI_UNSUPPORTED_REPOSITORY', 'REMOTE_CI_GH_UNAVAILABLE',
  'REMOTE_CI_PR_NOT_FOUND', 'REMOTE_CI_PR_NOT_OPEN', 'REMOTE_CI_FORK_UNSUPPORTED',
  'REMOTE_CI_HEAD_INVALID', 'REMOTE_CI_HEAD_CHANGED', 'REMOTE_CI_CHECK_NOT_FOUND',
  'REMOTE_CI_CHECK_UNSUPPORTED', 'REMOTE_CI_CHECK_NOT_FAILED',
  'REMOTE_CI_ATTEMPT_CHANGED', 'REMOTE_CI_RESULT_UNAVAILABLE',
  'REMOTE_CI_FETCH_FAILED', 'REMOTE_CI_FETCH_MISMATCH',
  'REMOTE_CI_STORE_CORRUPT', 'REMOTE_CI_STORE_UNAVAILABLE',
  'REMOTE_CI_RERUN_CONFIRM_REQUIRED', 'REMOTE_CI_RERUN_FAILED',
  'REMOTE_CI_RERUN_UNCERTAIN', 'REMOTE_CI_VALIDATION_PROFILE_NOT_FOUND',
  'REMOTE_CI_VALIDATION_PROFILE_CHANGED', 'PR_UPDATE_UNAVAILABLE',
  'PR_UPDATE_CONFIRM_REQUIRED', 'PR_UPDATE_HEAD_CHANGED', 'PR_UPDATE_TREE_MISMATCH',
  'PR_UPDATE_IDENTITY_MISSING', 'PR_UPDATE_PUSH_FAILED', 'PR_UPDATE_UNCERTAIN',
  'PR_UPDATE_CLEANUP_FAILED',
]);

function redactRemoteText(value) {
  return String(value == null ? '' : value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\b(?:gh[opurs]_|github_pat_)[A-Za-z0-9_]{8,}/gi, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\bAuthorization\s*[:=]\s*[^\r\n]+/gi, 'Authorization: [redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s<>]+[?][^\s<>]*/gi, '[redacted URL]')
    .replace(/((?:aws_)?secret(?:_access_key)?|password|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function cleanText(value, max = MAX_ERROR) {
  return redactRemoteText(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function remoteCiError(code, message) {
  const error = new Error(cleanText(message || code));
  error.code = FIXED_ERROR_CODES.has(String(code)) ? String(code) : 'REMOTE_CI_INVALID';
  return error;
}

function isRemoteCiRef(value) { return REMOTE_CI_REF_RE.test(String(value || '')); }
function createRemoteCiRef() { return `rci_${crypto.randomBytes(12).toString('hex')}`; }

function normalizeDecimalId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value == null ? '' : value).trim();
  return DECIMAL_ID_RE.test(text) ? text : '';
}

function normalizeSha(value) {
  const text = String(value || '').trim().toLowerCase();
  return SHA1_RE.test(text) ? text : '';
}

function normalizeFingerprint(value) {
  const text = String(value || '').trim().toLowerCase();
  return FINGERPRINT_RE.test(text) ? text : '';
}

function normalizeProjectKey(value) {
  const text = String(value || '').trim().toLowerCase();
  return PROJECT_KEY_RE.test(text) ? text : '';
}

function normalizeTimestamp(value) {
  const text = cleanText(value, 80);
  const millis = Date.parse(text);
  return text && Number.isFinite(millis) ? new Date(millis).toISOString() : '';
}

function normalizeHeadRef(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(text)
    || text.startsWith('-') || text === '@' || text.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
    || text.startsWith('/') || text.endsWith('/') || text.endsWith('.')
    || text.includes('..') || text.includes('@{') || text.includes('//')) return '';
  return text;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function repositoryKey(host, nameWithOwner) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedName = String(nameWithOwner || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!normalizedHost || normalizedHost.length > 255 || !/^[^\s\u0000/]+(?::\d+)?$/.test(normalizedHost)
    || !/^[^\s\u0000/]+\/[^\s\u0000/]+$/.test(normalizedName)) return '';
  return stableHash({ host: normalizedHost, nameWithOwner: normalizedName });
}

function remoteCiDedupeKey(snapshot) {
  return stableHash({
    projectKey: snapshot.projectKey,
    repoKey: snapshot.repoKey,
    sourceFingerprint: remoteCiSourceFingerprint(snapshot),
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    checkRunId: snapshot.checkRunId,
    runAttempt: snapshot.runAttempt,
  });
}

function remoteCiSourceFingerprint(snapshot) {
  return stableHash({
    repoKey: snapshot.repoKey,
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    headRefName: snapshot.headRefName,
    checkRunId: snapshot.checkRunId,
    runId: snapshot.runId,
    jobId: snapshot.jobId,
    runAttempt: snapshot.runAttempt,
    conclusion: snapshot.conclusion,
  });
}

function normalizeRemoteCiSnapshot(raw, { now = Date.now(), rejectUnknown = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw remoteCiError('REMOTE_CI_INVALID', '远程 CI snapshot 无效');
  const allowed = new Set([
    'remoteCiRef', 'projectKey', 'repoKey', 'prNumber', 'headSha', 'headRefName',
    'checkRunId', 'runId', 'jobId', 'runAttempt', 'workflowName', 'jobName',
    'conclusion', 'completedAt', 'annotationCount', 'annotationsTruncated',
    'logsAvailable', 'createdAt', 'lastVerifiedAt',
  ]);
  if (rejectUnknown && Object.keys(raw).some((key) => !allowed.has(key))) {
    throw remoteCiError('REMOTE_CI_INVALID', '远程 CI snapshot 字段无效');
  }
  const remoteCiRef = String(raw.remoteCiRef || '');
  const projectKey = normalizeProjectKey(raw.projectKey);
  const repoKey = normalizeFingerprint(raw.repoKey);
  const prNumber = Number(raw.prNumber);
  const headSha = normalizeSha(raw.headSha);
  const headRefName = normalizeHeadRef(raw.headRefName);
  const checkRunId = normalizeDecimalId(raw.checkRunId);
  const runId = normalizeDecimalId(raw.runId);
  const jobId = normalizeDecimalId(raw.jobId);
  const runAttempt = Number(raw.runAttempt);
  const conclusion = String(raw.conclusion || '').toLowerCase();
  const workflowName = cleanText(raw.workflowName, 200);
  const jobName = cleanText(raw.jobName, 200);
  const createdAt = raw.createdAt == null ? new Date(now).toISOString() : normalizeTimestamp(raw.createdAt);
  const lastVerifiedAt = raw.lastVerifiedAt == null ? createdAt : normalizeTimestamp(raw.lastVerifiedAt);
  if (!isRemoteCiRef(remoteCiRef) || !projectKey || !repoKey
    || !Number.isInteger(prNumber) || prNumber < 1 || prNumber > 0x7fffffff
    || !headSha || !headRefName || !checkRunId || !runId || !jobId
    || !Number.isInteger(runAttempt) || runAttempt < 1 || runAttempt > 0x7fffffff
    || !ALLOWED_CONCLUSIONS.has(conclusion) || !workflowName || !jobName
    || !createdAt || !lastVerifiedAt) {
    throw remoteCiError('REMOTE_CI_INVALID', '远程 CI snapshot 内容无效');
  }
  const annotationCount = Number.isFinite(Number(raw.annotationCount))
    ? Math.max(0, Math.min(MAX_ANNOTATIONS, Math.floor(Number(raw.annotationCount)))) : 0;
  const completedAt = raw.completedAt == null || raw.completedAt === '' ? '' : normalizeTimestamp(raw.completedAt);
  if (raw.completedAt != null && raw.completedAt !== '' && !completedAt) {
    throw remoteCiError('REMOTE_CI_INVALID', '远程 CI 完成时间无效');
  }
  return {
    remoteCiRef, projectKey, repoKey, prNumber, headSha, headRefName,
    checkRunId, runId, jobId, runAttempt, workflowName, jobName, conclusion,
    ...(completedAt ? { completedAt } : {}),
    annotationCount,
    annotationsTruncated: raw.annotationsTruncated === true,
    logsAvailable: raw.logsAvailable === true,
    createdAt,
    lastVerifiedAt,
  };
}

function publicRemoteCiSummary(raw, dynamic = {}) {
  let snapshot;
  try { snapshot = normalizeRemoteCiSnapshot(raw, { rejectUnknown: false }); } catch { return null; }
  const capability = ['available', 'stale', 'unavailable'].includes(String(dynamic.capability))
    ? String(dynamic.capability) : 'unavailable';
  return {
    remoteCiRef: snapshot.remoteCiRef,
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    headRefName: snapshot.headRefName,
    checkRunId: snapshot.checkRunId,
    runAttempt: snapshot.runAttempt,
    workflowName: snapshot.workflowName,
    jobName: snapshot.jobName,
    conclusion: snapshot.conclusion,
    ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
    annotationCount: snapshot.annotationCount,
    annotationsTruncated: snapshot.annotationsTruncated,
    logsAvailable: snapshot.logsAvailable,
    createdAt: snapshot.createdAt,
    lastVerifiedAt: snapshot.lastVerifiedAt,
    capability,
    canRepair: capability === 'available',
    canRerun: capability === 'available',
    ...(dynamic.reasonCode && FIXED_ERROR_CODES.has(String(dynamic.reasonCode)) ? { reasonCode: String(dynamic.reasonCode) } : {}),
  };
}

module.exports = {
  REMOTE_CI_REF_RE,
  DECIMAL_ID_RE,
  MAX_CHECK_RUNS,
  MAX_ANNOTATIONS,
  MAX_ANNOTATION_PATH,
  MAX_ANNOTATION_TEXT,
  MAX_FAILED_STEPS,
  MAX_RAW_LOG_BYTES,
  MAX_LOG_EXCERPT_BYTES,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_REMOTE_CONTEXT_BYTES,
  MAX_ERROR,
  ALLOWED_CONCLUSIONS,
  FIXED_ERROR_CODES,
  cleanText,
  redactRemoteText,
  remoteCiError,
  isRemoteCiRef,
  createRemoteCiRef,
  normalizeDecimalId,
  normalizeSha,
  normalizeProjectKey,
  normalizeHeadRef,
  repositoryKey,
  remoteCiDedupeKey,
  remoteCiSourceFingerprint,
  normalizeRemoteCiSnapshot,
  publicRemoteCiSummary,
};
