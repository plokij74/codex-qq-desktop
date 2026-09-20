'use strict';

const crypto = require('node:crypto');
const { normalizeDecimalId, normalizeSha, redactRemoteText } = require('./remote-ci-state');

const MAX_RUNS = 200;
const POLL_INTERVAL_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;
const STABLE_WINDOW_MS = 30_000;
const ACTIVE = new Set(['starting', 'watching']);
const STATUSES = new Set([...ACTIVE, 'completed', 'head_changed', 'pr_closed', 'expired', 'stopped', 'error']);
const RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed']);
const CONCLUSIONS = new Set(['success', 'neutral', 'skipped', 'failure', 'timed_out', 'startup_failure', 'cancelled', 'action_required', 'stale']);
const FAILURES = new Set(['failure', 'timed_out', 'startup_failure']);
const CODES = new Set([
  'CI_WATCH_INVALID', 'CI_WATCH_PROJECT_BINDING_INVALID', 'CI_WATCH_NOT_FOUND',
  'CI_WATCH_ALREADY_RUNNING', 'CI_WATCH_LIMIT', 'CI_WATCH_UNAVAILABLE',
  'CI_WATCH_REPOSITORY_INVALID', 'CI_WATCH_REPOSITORY_CHANGED', 'CI_WATCH_PR_INVALID',
  'CI_WATCH_FORK_UNSUPPORTED', 'CI_WATCH_INCOMPLETE', 'CI_WATCH_NETWORK',
  'CI_WATCH_QUERY_TIMEOUT', 'CI_WATCH_RATE_LIMITED', 'CI_WATCH_AUTH_REQUIRED',
  'CI_WATCH_FORBIDDEN', 'CI_WATCH_TARGET_NOT_FOUND', 'CI_WATCH_GH_UNAVAILABLE',
  'CI_WATCH_NO_RUNS', 'CI_WATCH_AWAITING_ATTEMPT', 'CI_WATCH_SUSPENDED',
  'CI_WATCH_PROJECT_REMOVED', 'CI_WATCH_APP_CLOSED',
]);

function validWatchRef(value) { return typeof value === 'string' && /^ciw_[a-f0-9]{24}$/.test(value); }
function createWatchRef() { return `ciw_${crypto.randomBytes(12).toString('hex')}`; }
function validPrNumber(value) { return Number.isInteger(value) && value > 0 && value <= 0x7fffffff; }
function durationMinutes(value = 30) { return [15, 30, 60].includes(value) ? value : null; }
function code(value) { return CODES.has(value) ? value : 'CI_WATCH_UNAVAILABLE'; }
function error(value) { const safe = code(value); return { ok: false, code: safe, error: safe }; }

function normalizeRuns(raw, headSha) {
  if (!Array.isArray(raw) || raw.length > MAX_RUNS || !normalizeSha(headSha)) return null;
  const rows = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const id = normalizeDecimalId(item.id);
    const head = normalizeSha(item.headSha ?? item.head_sha);
    const attempt = item.runAttempt ?? item.run_attempt;
    const status = String(item.status || '').toLowerCase();
    if (!id || seen.has(id) || head !== headSha || !Number.isSafeInteger(attempt) || attempt < 1 || !RUN_STATUSES.has(status)) return null;
    seen.add(id);
    const conclusion = String(item.conclusion || '').toLowerCase();
    rows.push({
      id, headSha: head, runAttempt: attempt, status,
      name: redactRemoteText(String(item.name || 'GitHub Actions')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      conclusion: status === 'completed' ? (CONCLUSIONS.has(conclusion) ? conclusion : 'unknown') : '',
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function counts(runs = []) {
  const out = { total: runs.length, completed: 0, pending: 0, passed: 0, failed: 0, skipped: 0, attention: 0 };
  for (const run of runs) {
    if (run.status !== 'completed') { out.pending++; continue; }
    out.completed++;
    if (run.conclusion === 'success') out.passed++;
    else if (FAILURES.has(run.conclusion)) out.failed++;
    else if (['neutral', 'skipped'].includes(run.conclusion)) out.skipped++;
    else out.attention++;
  }
  return out;
}

function outcome(runs) {
  const c = counts(runs);
  if (!c.total || c.pending) return null;
  if (c.failed) return 'failed';
  if (c.attention || !c.passed) return 'attention';
  return 'passed';
}

function fingerprint(runs) {
  return crypto.createHash('sha256').update(JSON.stringify(runs.map((r) => [r.id, r.runAttempt, r.status, r.conclusion]))).digest('hex');
}

function publicWatch(record, { detail = false } = {}) {
  const out = {
    watchRef: record.watchRef, projectKey: record.projectKey, prNumber: record.prNumber,
    headSha: record.headSha || '', status: record.status, outcome: record.outcome || null,
    revision: record.revision, counts: counts(record.runs),
    createdAt: record.createdAt, deadlineAt: record.deadlineAt,
    lastCheckedAt: record.lastCheckedAt || null, nextPollAt: record.nextPollAt || null,
    finishedAt: record.finishedAt || null, unread: record.unread === true,
    waitingForAttempt: record.waitingForAttempt === true,
    reasonCode: record.reasonCode ? code(record.reasonCode) : '',
  };
  if (detail) out.runs = record.runs.map(({ id, name, runAttempt, status, conclusion }) => ({ id, name, runAttempt, status, conclusion }));
  return out;
}

module.exports = {
  MAX_RUNS, POLL_INTERVAL_MS, QUERY_TIMEOUT_MS, STABLE_WINDOW_MS, ACTIVE, STATUSES,
  validWatchRef, createWatchRef, validPrNumber, durationMinutes, code, error,
  normalizeRuns, counts, outcome, fingerprint, publicWatch,
};
