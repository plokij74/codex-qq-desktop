'use strict';

const crypto = require('node:crypto');
const { redactRemoteText, normalizeSha, normalizeHeadRef, normalizeProjectKey } = require('./remote-ci-state');

const THREAD_REF_RE = /^prt_[a-f0-9]{24}$/;
const REVIEW_REF_RE = /^prv_[a-f0-9]{24}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const MAX_THREADS = 200;
const MAX_COMMENTS = 50;
const MAX_REPLY = 5000;
const ERROR_CODES = new Set([
  'PR_REVIEW_INVALID', 'PR_REVIEW_PROJECT_BINDING_INVALID', 'PR_REVIEW_UNAVAILABLE',
  'PR_REVIEW_UNSUPPORTED', 'PR_REVIEW_NOT_FOUND', 'PR_REVIEW_PR_NOT_OPEN',
  'PR_REVIEW_FORK_UNSUPPORTED', 'PR_REVIEW_CHANGED', 'PR_REVIEW_INCOMPLETE',
  'PR_REVIEW_LOCATION_UNAVAILABLE', 'PR_REVIEW_NOT_REPAIRABLE', 'PR_REVIEW_CONTEXT_TOO_LARGE',
  'PR_REVIEW_CONFIRM_REQUIRED', 'PR_REVIEW_PERMISSION_DENIED', 'PR_REVIEW_ACTION_FAILED',
  'PR_REVIEW_ACTION_UNCERTAIN', 'PR_REVIEW_BUSY', 'PR_REVIEW_LIMIT',
  'PR_REVIEW_STORE_CORRUPT', 'PR_REVIEW_STORE_UNAVAILABLE',
]);
function fail(code = 'PR_REVIEW_INVALID') { return Object.assign(new Error(ERROR_CODES.has(code) ? code : 'PR_REVIEW_INVALID'), { code: ERROR_CODES.has(code) ? code : 'PR_REVIEW_INVALID' }); }
function error(cause) { const code = ERROR_CODES.has(cause?.code) ? cause.code : 'PR_REVIEW_UNAVAILABLE'; return { ok: false, code, error: code }; }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function ref(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function nodeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_+/=-]{1,200}$/.test(value); }
function text(value, max = 500) { return redactRemoteText(value).slice(0, max); }
function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000
    && !/[\\:\u0000-\u001f\u007f]/.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function line(value) { return value === null ? null : Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function normalizeThread(raw, detail = false) {
  if (!raw || !nodeId(raw.id) || typeof raw.path !== 'string' || raw.path.length > 1000
    || !['LINE', 'FILE'].includes(raw.subjectType) || !['LEFT', 'RIGHT'].includes(raw.diffSide)
    || !['LEFT', 'RIGHT', null].includes(raw.startDiffSide)
    || ['isResolved', 'isOutdated', 'viewerCanReply', 'viewerCanResolve'].some((key) => typeof raw[key] !== 'boolean')
    || line(raw.line) === undefined || line(raw.startLine) === undefined
    || !Number.isSafeInteger(raw.comments?.totalCount) || raw.comments.totalCount < 0) throw fail('PR_REVIEW_INCOMPLETE');
  const item = {
    id: raw.id, path: raw.path, subjectType: raw.subjectType, diffSide: raw.diffSide,
    startDiffSide: raw.startDiffSide, line: raw.line, startLine: raw.startLine,
    isResolved: raw.isResolved, isOutdated: raw.isOutdated,
    viewerCanReply: raw.viewerCanReply, viewerCanResolve: raw.viewerCanResolve,
    totalCount: raw.comments.totalCount,
  };
  if (!detail) return item;
  const connection = raw.comments;
  if (!Array.isArray(connection.nodes) || connection.nodes.length > MAX_COMMENTS
    || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw fail('PR_REVIEW_INCOMPLETE');
  const seen = new Set();
  item.comments = connection.nodes.map((comment) => {
    if (!comment || !nodeId(comment.id) || seen.has(comment.id) || typeof comment.body !== 'string'
      || !['PENDING', 'SUBMITTED'].includes(comment.state)
      || !Number.isFinite(Date.parse(comment.createdAt)) || !Number.isFinite(Date.parse(comment.updatedAt))) throw fail('PR_REVIEW_INCOMPLETE');
    seen.add(comment.id);
    return { id: comment.id, body: comment.body, state: comment.state,
      author: text(comment.author?.login || '已删除用户', 120), createdAt: comment.createdAt, updatedAt: comment.updatedAt };
  });
  item.complete = !connection.pageInfo.hasNextPage && item.comments.length === item.totalCount;
  item.fingerprint = hash({ id: item.id, path: item.path, subjectType: item.subjectType, diffSide: item.diffSide,
    startDiffSide: item.startDiffSide, line: item.line, startLine: item.startLine,
    isResolved: item.isResolved, isOutdated: item.isOutdated, totalCount: item.totalCount,
    comments: item.comments.map((c) => [c.id, c.state, c.author, c.createdAt, c.updatedAt, hash(c.body)]) });
  return item;
}
function normalizeSnapshot(raw) {
  const allowed = ['reviewRef', 'projectKey', 'repoKey', 'prNumber', 'headSha', 'headRefName', 'threadId', 'threadFingerprint', 'path', 'line', 'subjectType', 'createdAt'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some((key) => !allowed.includes(key))
    || !REVIEW_REF_RE.test(raw.reviewRef) || !normalizeProjectKey(raw.projectKey) || !REVISION_RE.test(raw.repoKey)
    || !Number.isSafeInteger(raw.prNumber) || raw.prNumber < 1 || raw.prNumber > 0x7fffffff
    || !normalizeSha(raw.headSha) || !normalizeHeadRef(raw.headRefName) || !nodeId(raw.threadId)
    || !REVISION_RE.test(raw.threadFingerprint) || !validPath(raw.path)
    || line(raw.line) === undefined || !['LINE', 'FILE'].includes(raw.subjectType)
    || !Number.isFinite(Date.parse(raw.createdAt))) throw fail();
  return Object.fromEntries(allowed.map((key) => [key, raw[key]]));
}
function sourceFingerprint(item) {
  return hash({ projectKey: item.projectKey, repoKey: item.repoKey, prNumber: item.prNumber,
    headSha: item.headSha, headRefName: item.headRefName, threadId: item.threadId, threadFingerprint: item.threadFingerprint });
}
function publicSource(raw) {
  const item = normalizeSnapshot(raw);
  return { reviewRef: item.reviewRef, prNumber: item.prNumber, headSha: item.headSha,
    path: text(item.path, 1000), line: item.line, subjectType: item.subjectType, createdAt: item.createdAt };
}
module.exports = { THREAD_REF_RE, REVIEW_REF_RE, REVISION_RE, MAX_THREADS, MAX_COMMENTS, MAX_REPLY,
  ERROR_CODES, fail, error, hash, ref, nodeId, text, validPath, normalizeThread, normalizeSnapshot, sourceFingerprint, publicSource };
