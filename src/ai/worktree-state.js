'use strict';

const RESULT_ID_RE = /^wt_[A-Za-z0-9]{6,80}$/;
const SHA1_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const MARKER_VERSION = 3;
const PENDING_LIMIT = 3;
const PATCH_MAX_BYTES = 16 * 1024 * 1024;
const FILE_SUMMARY_LIMIT = 200;
const GOAL_MAX = 2000;
const ERROR_MAX = 500;

const STATES = new Set([
  'creating',
  'running',
  'collecting',
  'ready',
  'collect_failed',
  'oversize',
  'conflict',
  'applying',
  'apply_uncertain',
  'applied_cleanup_pending',
  'discarded_cleanup_pending',
  'pr_preparing',
  'pr_committing',
  'pr_pushing',
  'pr_creating',
  'pr_failed',
  'pr_cleanup_pending',
  'pr_created',
  'pr_update_preparing',
  'pr_update_pushing',
  'pr_update_failed',
  'pr_update_uncertain',
  'pr_update_cleanup_pending',
  'pr_updated',
]);

const TRANSITIONS = Object.freeze({
  creating: new Set(['running', 'collect_failed']),
  running: new Set(['collecting', 'collect_failed', 'discarded_cleanup_pending']),
  collecting: new Set(['ready', 'collect_failed', 'oversize', 'discarded_cleanup_pending']),
  ready: new Set(['applying', 'discarded_cleanup_pending', 'conflict', 'pr_preparing', 'pr_update_preparing']),
  collect_failed: new Set(['collecting', 'discarded_cleanup_pending']),
  oversize: new Set(['discarded_cleanup_pending']),
  conflict: new Set(['applying', 'discarded_cleanup_pending', 'pr_preparing', 'pr_update_preparing']),
  applying: new Set(['ready', 'conflict', 'apply_uncertain', 'applied_cleanup_pending']),
  apply_uncertain: new Set(),
  applied_cleanup_pending: new Set(),
  discarded_cleanup_pending: new Set(),
  pr_preparing: new Set(['pr_committing', 'pr_pushing', 'pr_creating', 'pr_failed', 'discarded_cleanup_pending']),
  pr_committing: new Set(['pr_pushing', 'pr_failed']),
  pr_pushing: new Set(['pr_creating', 'pr_failed']),
  pr_creating: new Set(['pr_created', 'pr_failed', 'pr_cleanup_pending']),
  pr_failed: new Set(['pr_preparing', 'discarded_cleanup_pending']),
  pr_cleanup_pending: new Set(['pr_created']),
  pr_created: new Set(),
  pr_update_preparing: new Set(['pr_update_pushing', 'pr_update_failed', 'pr_update_uncertain']),
  pr_update_pushing: new Set(['pr_update_cleanup_pending', 'pr_update_failed', 'pr_update_uncertain']),
  pr_update_failed: new Set(['pr_update_preparing', 'discarded_cleanup_pending']),
  pr_update_uncertain: new Set(['pr_update_preparing', 'pr_update_cleanup_pending']),
  pr_update_cleanup_pending: new Set(['pr_updated']),
  pr_updated: new Set(),
});

function text(value, max = ERROR_MAX) {
  return String(value ?? '').trim().slice(0, max);
}

function isResultId(value) {
  return RESULT_ID_RE.test(String(value || ''));
}

function isSha1(value) {
  return SHA1_RE.test(String(value || ''));
}

function isSha256(value) {
  return SHA256_RE.test(String(value || ''));
}

function isAbsolutePath(value) {
  const p = String(value || '');
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(p);
}

function isSafeAuthorityPath(value) {
  const p = String(value || '').replace(/\\/g, '/');
  return isAbsolutePath(p) && !/(^|\/)\.\.(?:\/|$)/.test(p) && !/[\r\n\0]/.test(p);
}

function normalizePath(value) {
  const p = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(p)) return `${p}/`;
  return p;
}

function cleanFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = String(raw.path || '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /(^|\/)\.\.(?:\/|$)/.test(path) || /\0/.test(path)) return null;
  const status = /^[ACDMRTUXB]$/.test(String(raw.status || '')) ? String(raw.status) : 'M';
  return { path, status, binary: raw.binary === true };
}

function normalizeStats(raw, files) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const finite = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number))) : 0;
  };
  const count = finite(input.files);
  const binaryFiles = finite(input.binaryFiles);
  return {
    files: count || files.length,
    additions: finite(input.additions),
    deletions: finite(input.deletions),
    binaryFiles: Math.min(binaryFiles, count || files.length),
  };
}

function normalizePrChecks(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const finite = (value) => Number.isFinite(Number(value))
    ? Math.min(200, Math.max(0, Math.floor(Number(value)))) : 0;
  const total = finite(input.total);
  const passed = finite(input.passed);
  const pending = finite(input.pending);
  const failed = finite(input.failed);
  const skipped = finite(input.skipped);
  const unknown = finite(input.unknown);
  return {
    total,
    passed: Math.min(passed, total),
    pending: Math.min(pending, total),
    failed: Math.min(failed, total),
    skipped: Math.min(skipped, total),
    unknown: Math.min(unknown, total),
  };
}

function normalizeMarker(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const inputVersion = Number(raw.version);
  if (![1, 2, MARKER_VERSION].includes(inputVersion) || !isResultId(raw.id) || !STATES.has(raw.state)) return null;
  const repoRoot = normalizePath(raw.repoRoot);
  const projectRoot = normalizePath(raw.projectRoot);
  const projectIdentity = text(raw.projectIdentity, 600);
  const rawProjectRel = String(raw.projectRel ?? '').replace(/\\/g, '/');
  if (rawProjectRel.startsWith('/') || /(^|\/)\.\.(?:\/|$)/.test(rawProjectRel)
    || (rawProjectRel !== '.' && /(^|\/)\.(?:\/|$)/.test(rawProjectRel))) return null;
  const projectRel = rawProjectRel.replace(/^\.\/?/, '').replace(/\/$/, '');
  const baseHead = String(raw.baseHead || '').toLowerCase();
  const worktreeGitDir = raw.worktreeGitDir ? normalizePath(raw.worktreeGitDir) : '';
  if (!isSafeAuthorityPath(repoRoot) || !isSafeAuthorityPath(projectRoot) || !projectIdentity
    || !isSha1(baseHead) || (raw.state !== 'creating' && !isSafeAuthorityPath(worktreeGitDir))) return null;

  const files = [];
  for (const item of Array.isArray(raw.files) ? raw.files : []) {
    const clean = cleanFile(item);
    if (!clean) return null;
    files.push(clean);
    if (files.length >= FILE_SUMMARY_LIMIT) break;
  }
  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;

  const rawPatchBytes = Number(raw.patchBytes);
  const patchBytes = Number.isFinite(rawPatchBytes)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(rawPatchBytes)))
    : 0;
  const patchSha256 = raw.patchSha256 == null || raw.patchSha256 === '' ? null : String(raw.patchSha256).toLowerCase();
  const expectedTree = raw.expectedTree == null || raw.expectedTree === '' ? null : String(raw.expectedTree).toLowerCase();
  if (patchSha256 && !isSha256(patchSha256)) return null;
  if (expectedTree && !isSha1(expectedTree)) return null;

  const rawPr = raw.pr && typeof raw.pr === 'object' ? raw.pr : {};
  const pr = {
    host: text(rawPr.host, 255),
    owner: text(rawPr.owner, 255),
    repo: text(rawPr.repo, 255),
    base: text(rawPr.base, 255),
    head: text(rawPr.head, 255),
    commit: isSha1(rawPr.commit) ? String(rawPr.commit).toLowerCase() : '',
    url: text(rawPr.url, 2000),
    number: Number.isInteger(Number(rawPr.number)) && Number(rawPr.number) > 0 ? Number(rawPr.number) : 0,
    draft: rawPr.draft !== false,
    title: text(rawPr.title, 300),
    pushed: rawPr.pushed === true,
    state: ['OPEN', 'CLOSED', 'MERGED'].includes(String(rawPr.state || '').toUpperCase()) ? String(rawPr.state).toUpperCase() : '',
    headSha: isSha1(rawPr.headSha) ? String(rawPr.headSha).toLowerCase() : '',
    mergeable: text(rawPr.mergeable, 40).toUpperCase(),
    mergeStateStatus: text(rawPr.mergeStateStatus, 60).toUpperCase(),
    updatedAt: text(rawPr.updatedAt, 80),
    checksSummary: normalizePrChecks(rawPr.checksSummary),
  };
  const baseKind = raw.baseKind === 'remote_commit' ? 'remote_commit' : 'local_head';
  const originKind = ['remote_ci', 'pr_review'].includes(raw.originKind) ? raw.originKind : 'default';
  const deliveryKind = raw.deliveryKind === 'github_pr_update' ? 'github_pr_update' : 'default';
  const remoteCiRef = /^rci_[a-f0-9]{24}$/.test(String(raw.remoteCiRef || '')) ? String(raw.remoteCiRef) : '';
  const reviewRef = /^prv_[a-f0-9]{24}$/.test(String(raw.reviewRef || '')) ? String(raw.reviewRef) : '';
  if (originKind === 'pr_review' && (inputVersion < 3 || !reviewRef || remoteCiRef)) return null;
  if (originKind === 'remote_ci' && (!remoteCiRef || reviewRef)) return null;
  if (originKind === 'default' && (remoteCiRef || reviewRef || deliveryKind === 'github_pr_update' || baseKind === 'remote_commit')) return null;
  if (originKind !== 'default' && (deliveryKind !== 'github_pr_update' || baseKind !== 'remote_commit')) return null;
  const rawUpdate = raw.prUpdate && typeof raw.prUpdate === 'object' ? raw.prUpdate : {};
  const prUpdate = {
    oldHead: isSha1(rawUpdate.oldHead) ? String(rawUpdate.oldHead).toLowerCase() : '',
    newCommit: isSha1(rawUpdate.newCommit) ? String(rawUpdate.newCommit).toLowerCase() : '',
    expectedTree: isSha1(rawUpdate.expectedTree) ? String(rawUpdate.expectedTree).toLowerCase() : '',
    subject: text(rawUpdate.subject, 300),
    prNumber: Number.isInteger(Number(rawUpdate.prNumber)) && Number(rawUpdate.prNumber) > 0 ? Number(rawUpdate.prNumber) : 0,
    updatedAt: Number.isFinite(Number(rawUpdate.updatedAt)) ? Number(rawUpdate.updatedAt) : 0,
  };

  return {
    version: MARKER_VERSION,
    id: String(raw.id),
    state: String(raw.state),
    sessionId: text(raw.sessionId, 200),
    subagentId: text(raw.subagentId, 200),
    goal: text(raw.goal, GOAL_MAX),
    createdAt,
    updatedAt: Math.max(updatedAt, createdAt),
    repoRoot,
    projectRoot,
    projectIdentity,
    projectRel,
    baseHead,
    baseKind,
    originKind,
    ...(remoteCiRef ? { remoteCiRef } : {}),
    ...(reviewRef ? { reviewRef } : {}),
    deliveryKind,
    worktreeGitDir,
    expectedTree,
    patchSha256,
    patchBytes,
    incomplete: raw.incomplete === true,
    files,
    filesTruncated: raw.filesTruncated === true,
    stats: normalizeStats(raw.stats, files),
    errorCode: raw.errorCode ? text(raw.errorCode, 80) : null,
    error: raw.error ? text(raw.error, ERROR_MAX) : null,
    pr,
    prUpdate,
    ...(Number.isFinite(Number(now)) ? {} : {}),
  };
}

function createMarker(input, { now = Date.now() } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const createdAt = Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now;
  return normalizeMarker({
    ...source,
    version: MARKER_VERSION,
    state: 'creating',
    files: [],
    filesTruncated: false,
    stats: { files: 0, additions: 0, deletions: 0, binaryFiles: 0 },
    incomplete: false,
    errorCode: null,
    error: null,
    patchBytes: 0,
    createdAt,
    updatedAt: createdAt,
  }, { now });
}

function canTransition(from, to) {
  return STATES.has(from) && STATES.has(to) && TRANSITIONS[from].has(to);
}

function transitionMarker(marker, state, patch = {}, { now = Date.now() } = {}) {
  const current = normalizeMarker(marker, { now });
  if (!current || !canTransition(current.state, state)) return null;
  return normalizeMarker({
    ...current,
    ...patch,
    state,
    updatedAt: Number.isFinite(Number(patch.updatedAt)) ? Number(patch.updatedAt) : now,
  }, { now });
}

function isUnresolved(marker) {
  const value = typeof marker === 'string' ? marker : marker?.state;
  return !['applied_cleanup_pending', 'discarded_cleanup_pending', 'pr_created', 'pr_updated'].includes(value);
}

function capabilityFor(marker) {
  const state = typeof marker === 'string' ? marker : marker?.state;
  const discardable = new Set([
    'running', 'collecting', 'ready', 'collect_failed', 'oversize', 'conflict', 'pr_failed', 'pr_update_failed',
  ]);
  return {
    canApply: state === 'ready' || state === 'conflict',
    canDiscard: discardable.has(state),
    canRetryCollect: state === 'collect_failed',
    canCleanup: state === 'applied_cleanup_pending' || state === 'discarded_cleanup_pending',
    canOpen: STATES.has(state) && !['creating', 'pr_created', 'pr_cleanup_pending', 'pr_update_cleanup_pending', 'pr_updated'].includes(state),
    canPreview: ['ready', 'conflict', 'applied_cleanup_pending', 'pr_update_failed', 'pr_update_uncertain'].includes(state),
    canCreatePr: (state === 'ready' || state === 'conflict' || state === 'pr_failed') && marker?.deliveryKind !== 'github_pr_update',
    canRetryPr: state === 'pr_failed',
    canCleanupPr: state === 'pr_cleanup_pending',
    canOpenPr: (state === 'pr_created' || state === 'pr_cleanup_pending') && Boolean(marker?.pr?.url),
    canUpdatePr: marker?.deliveryKind === 'github_pr_update' && ['ready', 'conflict', 'pr_update_failed', 'pr_update_uncertain', 'pr_update_cleanup_pending'].includes(state),
    canRetryPrUpdate: marker?.deliveryKind === 'github_pr_update' && ['pr_update_failed', 'pr_update_uncertain'].includes(state),
  };
}

function publicSummary(raw) {
  const marker = normalizeMarker(raw);
  if (!marker) return null;
  return {
    id: marker.id,
    state: marker.state,
    sessionId: marker.sessionId,
    subagentId: marker.subagentId,
    goal: marker.goal,
    createdAt: marker.createdAt,
    updatedAt: marker.updatedAt,
    baseHead: marker.baseHead,
    baseKind: marker.baseKind,
    originKind: marker.originKind,
    ...(marker.remoteCiRef ? { remoteCiRef: marker.remoteCiRef } : {}),
    ...(marker.reviewRef ? { reviewRef: marker.reviewRef } : {}),
    deliveryKind: marker.deliveryKind,
    incomplete: marker.incomplete,
    files: marker.files,
    filesTruncated: marker.filesTruncated,
    stats: marker.stats,
    errorCode: marker.errorCode,
    error: marker.error,
    pr: marker.pr,
    prUpdate: marker.prUpdate,
    ...capabilityFor(marker),
  };
}

function countUnresolved(markers) {
  return (Array.isArray(markers) ? markers : []).filter((m) => normalizeMarker(m) && isUnresolved(m)).length;
}

module.exports = {
  MARKER_VERSION,
  PENDING_LIMIT,
  PATCH_MAX_BYTES,
  FILE_SUMMARY_LIMIT,
  GOAL_MAX,
  STATES,
  RESULT_ID_RE,
  isResultId,
  isSha1,
  isSha256,
  normalizeMarker,
  createMarker,
  canTransition,
  transitionMarker,
  capabilityFor,
  publicSummary,
  isUnresolved,
  countUnresolved,
};
