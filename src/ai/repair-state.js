'use strict';

const crypto = require('node:crypto');

const REPAIR_REF_RE = /^rpr_[a-f0-9]{24}$/;
const JOB_REF_RE = /^vfy_job_[a-f0-9]{24}$/;
const WORKFLOW_RUN_REF_RE = /^wf_run_[a-f0-9]{24}$/;
const PROFILE_ID_RE = /^vfy_[a-f0-9]{8,64}$/;
const FINGERPRINT_RE = /^[a-f0-9]{32,128}$/i;

const MAX_DIAGNOSTICS = 50;
const MAX_DIAGNOSTIC_PATH = 500;
const MAX_DIAGNOSTIC_MESSAGE = 1000;
const MAX_OUTPUT_EXCERPT_BYTES = 12 * 1024;
const MAX_NOTE = 2000;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_ERROR = 500;
const MAX_NODE_ID = 120;

const REPAIR_STATES = Object.freeze([
  'queued', 'preparing', 'generating', 'collecting', 'ready', 'no_changes',
  'failed', 'cancelled', 'interrupted',
]);
const VALIDATION_STATES = Object.freeze([
  'not_run', 'queued', 'running', 'passed', 'failed', 'timed_out',
  'cancelled', 'stale', 'interrupted', 'error',
]);
const TERMINAL_REPAIR_STATES = new Set(['ready', 'no_changes', 'failed', 'cancelled', 'interrupted']);
const ACTIVE_REPAIR_STATES = new Set(['queued', 'preparing', 'generating', 'collecting']);

const REPAIR_TRANSITIONS = Object.freeze({
  queued: new Set(['preparing', 'cancelled', 'failed', 'interrupted']),
  preparing: new Set(['generating', 'collecting', 'failed', 'cancelled', 'interrupted']),
  generating: new Set(['collecting', 'failed', 'cancelled', 'interrupted']),
  collecting: new Set(['ready', 'no_changes', 'failed', 'cancelled', 'interrupted']),
  ready: new Set(),
  no_changes: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
});
const VALIDATION_TRANSITIONS = Object.freeze({
  not_run: new Set(['queued']),
  queued: new Set(['running', 'cancelled', 'interrupted', 'error']),
  running: new Set(['passed', 'failed', 'timed_out', 'cancelled', 'stale', 'interrupted', 'error']),
  passed: new Set(), failed: new Set(), timed_out: new Set(), cancelled: new Set(),
  stale: new Set(), interrupted: new Set(), error: new Set(),
});

const FIXED_ERROR_CODES = new Set([
  'REPAIR_PROJECT_BINDING_INVALID', 'REPAIR_INVALID', 'REPAIR_NOT_FOUND',
  'REPAIR_ALREADY_RUNNING', 'REPAIR_SOURCE_INVALID', 'REPAIR_SOURCE_NOT_FAILED',
  'REPAIR_SOURCE_CHANGED', 'REPAIR_SOURCE_NOT_FOUND', 'REPAIR_PROFILE_NOT_FOUND',
  'REPAIR_PROFILE_DISABLED', 'REPAIR_PROFILE_CHANGED', 'REPAIR_WORKSPACE_CHANGED',
  'REPAIR_READ_ONLY', 'REPAIR_APPROVAL_REQUIRED', 'REPAIR_APPROVAL_CANCELLED',
  'REPAIR_WORKTREE_CREATE_FAILED', 'REPAIR_AGENT_UNAVAILABLE', 'REPAIR_GENERATION_FAILED',
  'REPAIR_COLLECT_FAILED', 'REPAIR_NO_CHANGES', 'REPAIR_CANCEL_FAILED',
  'REPAIR_INTERRUPTED', 'REPAIR_RESULT_NOT_FOUND', 'REPAIR_RESULT_UNAVAILABLE',
  'REPAIR_PATCH_CHANGED', 'REPAIR_VALIDATION_RUNNING', 'REPAIR_VALIDATION_UNAVAILABLE',
  'REPAIR_VALIDATION_CANCEL_FAILED', 'REPAIR_TERMINAL_DISABLED', 'REPAIR_STORE_CORRUPT',
  'REPAIR_STORE_UNAVAILABLE',
]);

function repairError(code, message) {
  const error = new Error(String(message || code).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_ERROR));
  error.code = FIXED_ERROR_CODES.has(String(code)) ? String(code) : 'REPAIR_INVALID';
  return error;
}

function cleanText(value, max = MAX_ERROR) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function boundedUtf8(value, maxBytes) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const marker = '\n...[truncated]...\n';
  const side = Math.max(0, Math.floor((maxBytes - Buffer.byteLength(marker)) / 2));
  let out = `${bytes.subarray(0, side).toString('utf8')}${marker}${bytes.subarray(Math.max(side, bytes.length - side)).toString('utf8')}`;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

function normalizeNote(value) { return cleanText(value, MAX_NOTE); }
function isRepairRef(value) { return REPAIR_REF_RE.test(String(value || '')); }
function isJobRef(value) { return JOB_REF_RE.test(String(value || '')); }
function isWorkflowRunRef(value) { return WORKFLOW_RUN_REF_RE.test(String(value || '')); }
function isProfileId(value) { return PROFILE_ID_RE.test(String(value || '')); }
function isFingerprint(value) { return FINGERPRINT_RE.test(String(value || '')); }
function createRepairRef() { return `rpr_${crypto.randomBytes(12).toString('hex')}`; }

function normalizeSource(raw, { rejectUnknown = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw repairError('REPAIR_SOURCE_INVALID', '修复来源无效');
  const keys = Object.keys(raw);
  const allowed = raw.kind === 'verification' ? new Set(['kind', 'jobRef']) : new Set(['kind', 'workflowRunRef', 'nodeId']);
  if (rejectUnknown && keys.some((key) => !allowed.has(key))) throw repairError('REPAIR_SOURCE_INVALID', '修复来源字段无效');
  const kind = String(raw.kind || '');
  if (kind === 'verification') {
    if (!isJobRef(raw.jobRef)) throw repairError('REPAIR_SOURCE_INVALID', '验证作业引用无效');
    return { kind, jobRef: String(raw.jobRef) };
  }
  if (kind === 'workflow') {
    const nodeId = String(raw.nodeId || '').trim();
    if (!isWorkflowRunRef(raw.workflowRunRef) || !nodeId || nodeId.length > MAX_NODE_ID || /[\u0000\r\n]/.test(nodeId)) {
      throw repairError('REPAIR_SOURCE_INVALID', 'workflow 节点来源无效');
    }
    return { kind, workflowRunRef: String(raw.workflowRunRef), nodeId };
  }
  throw repairError('REPAIR_SOURCE_INVALID', '修复来源类型无效');
}

function normalizeTimestamp(value) {
  const text = cleanText(value, 80);
  const time = Date.parse(text);
  return text && Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeErrorCode(value) {
  const code = cleanText(value, 80);
  return FIXED_ERROR_CODES.has(code) ? code : undefined;
}

function normalizeValidation(raw, { rejectUnknown = true } = {}) {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw repairError('REPAIR_INVALID', 'validation 无效');
  const allowed = new Set([
    'status', 'startedAt', 'finishedAt', 'exitCode', 'diagnosticCount',
    'outputTruncated', 'workspaceChanged', 'errorCode', 'statusMessage',
  ]);
  if (rejectUnknown && Object.keys(raw).some((key) => !allowed.has(key))) throw repairError('REPAIR_INVALID', 'validation 字段无效');
  const status = String(raw.status || 'not_run');
  if (!VALIDATION_STATES.includes(status)) throw repairError('REPAIR_INVALID', 'validation 状态无效');
  const out = {
    status,
    diagnosticCount: Number.isFinite(Number(raw.diagnosticCount)) ? Math.max(0, Math.min(MAX_DIAGNOSTICS, Math.floor(Number(raw.diagnosticCount)))) : 0,
    outputTruncated: raw.outputTruncated === true,
    workspaceChanged: raw.workspaceChanged === true,
  };
  for (const field of ['startedAt', 'finishedAt']) {
    if (raw[field] == null) continue;
    const timestamp = normalizeTimestamp(raw[field]);
    if (timestamp) out[field] = timestamp;
  }
  if (Number.isFinite(Number(raw.exitCode))) out.exitCode = Math.max(-1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(raw.exitCode))));
  const errorCode = normalizeErrorCode(raw.errorCode);
  if (errorCode) out.errorCode = errorCode;
  if (raw.statusMessage != null) out.statusMessage = cleanText(raw.statusMessage, MAX_ERROR);
  return out;
}

function normalizeRepair(raw, { now = Date.now(), rejectUnknown = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw repairError('REPAIR_INVALID', '修复记录无效');
  const allowed = new Set([
    'repairRef', 'projectKey', 'source', 'profileId', 'profileFingerprint', 'sourceWorkspaceFingerprint',
    'status', 'resultId', 'rootRepairRef', 'retryOf', 'attempt', 'incomplete', 'diagnosticCount',
    'outputExcerpted', 'createdAt', 'startedAt', 'finishedAt', 'errorCode', 'statusMessage', 'validation',
  ]);
  if (rejectUnknown && Object.keys(raw).some((key) => !allowed.has(key))) throw repairError('REPAIR_INVALID', '修复记录字段无效');
  const repairRef = String(raw.repairRef || '');
  if (!isRepairRef(repairRef)) throw repairError('REPAIR_INVALID', '修复引用无效');
  const source = normalizeSource(raw.source, { rejectUnknown });
  const projectKey = String(raw.projectKey || '');
  if (!/^[a-f0-9]{32,128}$/i.test(projectKey)) throw repairError('REPAIR_INVALID', '项目引用无效');
  const profileId = String(raw.profileId || '');
  if (!isProfileId(profileId)) throw repairError('REPAIR_INVALID', 'profile 引用无效');
  const profileFingerprint = String(raw.profileFingerprint || '').toLowerCase();
  const sourceWorkspaceFingerprint = String(raw.sourceWorkspaceFingerprint || '').toLowerCase();
  if (!isFingerprint(profileFingerprint) || !isFingerprint(sourceWorkspaceFingerprint)) throw repairError('REPAIR_INVALID', 'fingerprint 无效');
  const status = String(raw.status || '');
  if (!REPAIR_STATES.includes(status)) throw repairError('REPAIR_INVALID', '修复状态无效');
  if (raw.resultId != null && !/^wt_[A-Za-z0-9]{6,80}$/.test(String(raw.resultId))) throw repairError('REPAIR_INVALID', 'worktree 结果引用无效');
  if (raw.rootRepairRef != null && !isRepairRef(raw.rootRepairRef)) throw repairError('REPAIR_INVALID', '根修复引用无效');
  if (raw.retryOf != null && !isRepairRef(raw.retryOf)) throw repairError('REPAIR_INVALID', '重试引用无效');
  const attempt = Number.isFinite(Number(raw.attempt)) ? Math.max(1, Math.min(1000, Math.floor(Number(raw.attempt)))) : 1;
  const createdAt = raw.createdAt == null ? new Date(now).toISOString() : normalizeTimestamp(raw.createdAt);
  if (!createdAt) throw repairError('REPAIR_INVALID', '修复时间无效');
  const out = {
    repairRef, projectKey, source, profileId, profileFingerprint, sourceWorkspaceFingerprint, status,
    ...(raw.resultId != null ? { resultId: String(raw.resultId) } : {}),
    rootRepairRef: String(raw.rootRepairRef || repairRef),
    ...(raw.retryOf != null ? { retryOf: String(raw.retryOf) } : {}),
    attempt,
    incomplete: raw.incomplete === true,
    diagnosticCount: Number.isFinite(Number(raw.diagnosticCount)) ? Math.max(0, Math.min(MAX_DIAGNOSTICS, Math.floor(Number(raw.diagnosticCount)))) : 0,
    outputExcerpted: raw.outputExcerpted === true,
    createdAt,
  };
  for (const field of ['startedAt', 'finishedAt']) {
    if (raw[field] == null) continue;
    const timestamp = normalizeTimestamp(raw[field]);
    if (timestamp) out[field] = timestamp;
  }
  const errorCode = normalizeErrorCode(raw.errorCode);
  if (errorCode) out.errorCode = errorCode;
  if (raw.statusMessage != null) out.statusMessage = cleanText(raw.statusMessage, MAX_ERROR);
  const validation = normalizeValidation(raw.validation, { rejectUnknown });
  if (validation) out.validation = validation;
  return out;
}

function canTransition(from, to) {
  return REPAIR_STATES.includes(from) && REPAIR_STATES.includes(to) && REPAIR_TRANSITIONS[from].has(to);
}
function canValidationTransition(from, to) {
  return VALIDATION_STATES.includes(from) && VALIDATION_STATES.includes(to) && VALIDATION_TRANSITIONS[from].has(to);
}
function transitionRepair(raw, status, patch = {}, options = {}) {
  const current = normalizeRepair(raw, options);
  if (!canTransition(current.status, status)) return null;
  return normalizeRepair({ ...current, ...patch, status }, options);
}
function transitionValidation(raw, status, patch = {}) {
  const current = normalizeValidation(raw) || { status: 'not_run', diagnosticCount: 0, outputTruncated: false, workspaceChanged: false };
  if (!canValidationTransition(current.status, status)) return null;
  return normalizeValidation({ ...current, ...patch, status });
}

function publicValidation(raw) {
  const validation = normalizeValidation(raw);
  if (!validation) return { status: 'not_run', diagnosticCount: 0, outputTruncated: false, workspaceChanged: false };
  return { ...validation };
}
function publicRepairSummary(raw) {
  let repair;
  // Internal records may carry non-persisted runtime fields (owner, note,
  // prompt). Normalize permissively here, then emit only the explicit public
  // allowlist below.
  try { repair = normalizeRepair(raw, { rejectUnknown: false }); } catch { return null; }
  return {
    repairRef: repair.repairRef,
    source: { ...repair.source },
    profileId: repair.profileId,
    status: repair.status,
    ...(repair.resultId ? { resultId: repair.resultId } : {}),
    rootRepairRef: repair.rootRepairRef,
    ...(repair.retryOf ? { retryOf: repair.retryOf } : {}),
    attempt: repair.attempt,
    incomplete: repair.incomplete,
    diagnosticCount: repair.diagnosticCount,
    outputExcerpted: repair.outputExcerpted,
    createdAt: repair.createdAt,
    ...(repair.startedAt ? { startedAt: repair.startedAt } : {}),
    ...(repair.finishedAt ? { finishedAt: repair.finishedAt } : {}),
    ...(repair.errorCode ? { errorCode: repair.errorCode } : {}),
    ...(repair.statusMessage ? { statusMessage: repair.statusMessage } : {}),
    validation: publicValidation(repair.validation),
  };
}
function publicRepairResult(raw, { validationResult } = {}) {
  const summary = publicRepairSummary(raw);
  if (!summary) return null;
  const out = { ...summary };
  if (validationResult && typeof validationResult === 'object') {
    const diagnostics = Array.isArray(validationResult.diagnostics)
      ? validationResult.diagnostics.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const diagnosticPath = String(item.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!diagnosticPath || diagnosticPath.startsWith('/') || /^[A-Za-z]:\//.test(diagnosticPath) || diagnosticPath.split('/').includes('..')) return null;
        const line = Number(item.line); const column = Number(item.column);
        if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null;
        return {
          path: diagnosticPath.slice(0, MAX_DIAGNOSTIC_PATH),
          line: Math.floor(line), column: Math.floor(column),
          severity: ['error', 'warning', 'info'].includes(item.severity) ? item.severity : 'error',
          code: item.code == null ? null : cleanText(item.code, 120),
          message: cleanText(item.message, MAX_DIAGNOSTIC_MESSAGE),
          source: cleanText(item.source || 'verification', 80),
        };
      }).filter(Boolean).slice(0, MAX_DIAGNOSTICS)
      : [];
    out.validationResult = {
      status: VALIDATION_STATES.includes(String(validationResult.status)) ? String(validationResult.status) : 'error',
      ...(Number.isFinite(Number(validationResult.exitCode)) ? { exitCode: Number(validationResult.exitCode) } : {}),
      stdout: boundedUtf8(validationResult.stdout, MAX_OUTPUT_EXCERPT_BYTES),
      stderr: boundedUtf8(validationResult.stderr, MAX_OUTPUT_EXCERPT_BYTES),
      diagnostics,
      diagnosticsTruncated: validationResult.diagnosticsTruncated === true,
      outputTruncated: validationResult.outputTruncated === true,
      ...(validationResult.workspaceFingerprintStart ? { workspaceFingerprintStart: cleanText(validationResult.workspaceFingerprintStart, 128) } : {}),
      ...(validationResult.workspaceFingerprintEnd ? { workspaceFingerprintEnd: cleanText(validationResult.workspaceFingerprintEnd, 128) } : {}),
    };
  }
  return out;
}

module.exports = {
  REPAIR_REF_RE, JOB_REF_RE, WORKFLOW_RUN_REF_RE, PROFILE_ID_RE,
  MAX_DIAGNOSTICS, MAX_DIAGNOSTIC_PATH, MAX_DIAGNOSTIC_MESSAGE,
  MAX_OUTPUT_EXCERPT_BYTES, MAX_NOTE, MAX_CONTEXT_BYTES, MAX_ERROR, MAX_NODE_ID,
  REPAIR_STATES, VALIDATION_STATES, TERMINAL_REPAIR_STATES, ACTIVE_REPAIR_STATES,
  REPAIR_TRANSITIONS, VALIDATION_TRANSITIONS, FIXED_ERROR_CODES,
  repairError, cleanText, boundedUtf8, normalizeNote, normalizeTimestamp, normalizeErrorCode,
  isRepairRef, isJobRef, isWorkflowRunRef,
  isProfileId, isFingerprint, createRepairRef, normalizeSource, normalizeValidation,
  normalizeRepair, canTransition, canValidationTransition, transitionRepair,
  transitionValidation, publicValidation, publicRepairSummary, publicSummary: publicRepairSummary,
  publicRepairResult, publicResult: publicRepairResult,
};
