'use strict';

const { canonicalProjectPath, projectKey } = require('./project-index');
const { createGithubCli } = require('./github-cli');
const { normalizeSha, normalizeDecimalId } = require('./remote-ci-state');
const {
  ACTIVE, POLL_INTERVAL_MS, QUERY_TIMEOUT_MS, STABLE_WINDOW_MS,
  validWatchRef, createWatchRef, validPrNumber, durationMinutes, code, error,
  normalizeRuns, outcome, fingerprint, publicWatch,
} = require('./ci-watch-state');

const MAX_ACTIVE = 3;
const MAX_HISTORY = 50;
const EXPECTATION_TTL_MS = 60 * 60_000;

function interrupted() { return Object.assign(new Error('CI_WATCH_ABORTED'), { code: 'CI_WATCH_ABORTED' }); }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(interrupted()); };
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (cause) => { signal.removeEventListener('abort', abort); reject(cause); },
    );
  });
}

class CiWatchManager {
  constructor(options = {}) {
    this.github = options.githubCli || createGithubCli();
    this.now = options.now || Date.now;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.canonicalPath = options.canonicalPath || canonicalProjectPath;
    this.projectKey = options.projectKey || projectKey;
    this.onEvent = options.onEvent || (() => {});
    this.records = new Map();
    this.expectations = new Map();
    this.hostCooldowns = new Map();
    this.closed = false;
    this.suspended = false;
  }

  _active(record) { return !this.closed && this.records.get(record.watchRef) === record && ACTIVE.has(record.status); }
  _emit(record, reason, notify = false) {
    record.revision++;
    try { this.onEvent({ type: 'engineering:ci-watch:event', ...publicWatch(record), reason, notify }); } catch {}
  }
  _prune() {
    const history = [...this.records.values()].filter((r) => !ACTIVE.has(r.status)).sort((a, b) => a.finishedAt - b.finishedAt);
    while (history.length > MAX_HISTORY) this.records.delete(history.shift().watchRef);
    for (const [key, item] of this.expectations) {
      const protectedByWatch = [...this.records.values()].some((r) => this._active(r) && r.projectKey === item.projectKey && r.prNumber === item.prNumber);
      if (!protectedByWatch && this.now() - item.createdAt >= EXPECTATION_TTL_MS) this.expectations.delete(key);
    }
    for (const [host, until] of this.hostCooldowns) if (until <= this.now()) this.hostCooldowns.delete(host);
  }
  _finish(record, status, reasonCode = '', result = null) {
    if (!this._active(record)) return;
    record.status = status;
    record.outcome = result;
    record.reasonCode = reasonCode;
    record.finishedAt = this.now();
    record.nextPollAt = null;
    record.unread = status !== 'stopped';
    this.clearTimer(record.timer);
    this.clearTimer(record.deadlineTimer);
    record.abort?.abort();
    this._emit(record, 'finished', record.unread);
    this._prune();
  }
  _expire(record) {
    this._finish(record, 'expired', record.waitingForAttempt ? 'CI_WATCH_AWAITING_ATTEMPT' : !record.runs.length ? 'CI_WATCH_NO_RUNS' : '');
  }
  _schedule(record, delay = POLL_INTERVAL_MS) {
    this.clearTimer(record.timer);
    if (!this._active(record) || this.suspended) { record.nextPollAt = null; return; }
    if (this.now() >= record.deadlineAt) { this._expire(record); return; }
    const wait = Math.max(delay, (this.hostCooldowns.get(record.repo?.host || record.hostHint) || 0) - this.now(), 0);
    record.nextPollAt = Math.min(record.deadlineAt, this.now() + wait);
    record.timer = this.setTimer(() => this._poll(record).catch(() => this._finish(record, 'error', 'CI_WATCH_UNAVAILABLE')), record.nextPollAt - this.now());
    record.timer?.unref?.();
  }

  start(projectPath, prNumber, minutes = 30) {
    const root = this.canonicalPath(projectPath);
    if (!root) return error('CI_WATCH_PROJECT_BINDING_INVALID');
    if (this.closed || !validPrNumber(prNumber) || !durationMinutes(minutes)) return error('CI_WATCH_INVALID');
    this._prune();
    const key = this.projectKey(root);
    const active = [...this.records.values()].filter((r) => this._active(r));
    const existing = active.find((r) => r.projectKey === key);
    if (existing) return existing.prNumber === prNumber
      ? { ok: true, existing: true, watchRef: existing.watchRef, watch: publicWatch(existing, { detail: true }) }
      : { ...error('CI_WATCH_ALREADY_RUNNING'), watchRef: existing.watchRef };
    if (active.length >= MAX_ACTIVE) return error('CI_WATCH_LIMIT');
    const record = {
      watchRef: createWatchRef(), projectPath: root, projectKey: key, prNumber,
      status: 'starting', runs: [], repo: null, headSha: '', headRefName: '', revision: 0,
      createdAt: this.now(), deadlineAt: this.now() + minutes * 60_000,
      unread: false, waitingForAttempt: false, reasonCode: '', errors: 0,
      stableFingerprint: '', stableSince: null, barrierVersion: 0,
      seenAttempts: new Map(), inflight: false, pollGeneration: 0, hostHint: '',
    };
    this.records.set(record.watchRef, record);
    record.deadlineTimer = this.setTimer(() => this._expire(record), minutes * 60_000);
    record.deadlineTimer?.unref?.();
    this._schedule(record, 0);
    this._emit(record, 'started');
    return { ok: true, watchRef: record.watchRef, watch: publicWatch(record, { detail: true }) };
  }
  list(projectPath) {
    const root = this.canonicalPath(projectPath);
    if (!root) return error('CI_WATCH_PROJECT_BINDING_INVALID');
    const key = this.projectKey(root);
    return { ok: true, projectKey: key, watches: [...this.records.values()].filter((r) => r.projectKey === key)
      .sort((a, b) => b.createdAt - a.createdAt).map((r) => publicWatch(r, { detail: true })) };
  }
  _find(projectPath, ref) {
    const root = this.canonicalPath(projectPath);
    const record = validWatchRef(ref) ? this.records.get(ref) : null;
    return root && record?.projectKey === this.projectKey(root) ? record : null;
  }
  get(projectPath, ref) {
    const r = this._find(projectPath, ref);
    return r ? { ok: true, watch: publicWatch(r, { detail: true }) } : error('CI_WATCH_NOT_FOUND');
  }
  // Main-only navigation lookup; the IPC owner must already be proved.
  navigation(key, ref) {
    const r = this.records.get(ref);
    return r?.projectKey === key ? publicWatch(r) : null;
  }
  stop(projectPath, ref) {
    const r = this._find(projectPath, ref);
    if (!r) return error('CI_WATCH_NOT_FOUND');
    this._finish(r, 'stopped');
    return { ok: true, watch: publicWatch(r, { detail: true }) };
  }
  ack(projectPath, ref) {
    const r = this._find(projectPath, ref);
    if (!r) return error('CI_WATCH_NOT_FOUND');
    if (r.unread) { r.unread = false; this._emit(r, 'read'); }
    return { ok: true, watch: publicWatch(r, { detail: true }) };
  }

  noteRerun(event = {}) {
    const root = this.canonicalPath(event.projectPath);
    if (this.closed || !root || !validPrNumber(event.prNumber) || !normalizeSha(event.headSha)
      || !normalizeDecimalId(event.runId) || !Number.isSafeInteger(event.runAttempt) || event.runAttempt < 1
      || !event.repoKey || !event.remoteCiRef || !['sending', 'requested', 'uncertain', 'failed'].includes(event.phase)) return;
    const key = this.projectKey(root);
    const identity = `${key}:${event.remoteCiRef}`;
    this._prune();
    if (event.phase === 'failed') this.expectations.delete(identity);
    else this.expectations.set(identity, {
      projectKey: key, repoKey: event.repoKey, prNumber: event.prNumber, headSha: event.headSha,
      runId: event.runId, runAttempt: event.runAttempt, phase: event.phase, createdAt: this.now(),
    });
    // Overflow cannot silently remove a pending rerun barrier from an active watch.
    if (this.expectations.size > 200) {
      for (const r of this.records.values()) this._finish(r, 'error', 'CI_WATCH_LIMIT');
      this.expectations.delete(this.expectations.keys().next().value);
    }
    for (const r of this.records.values()) {
      if (!this._active(r) || r.projectKey !== key || r.prNumber !== event.prNumber || (r.headSha && r.headSha !== event.headSha)) continue;
      r.barrierVersion++;
      r.stableFingerprint = ''; r.stableSince = null;
      r.waitingForAttempt = this._awaitingAttempt(r);
      this._emit(r, 'rerun');
    }
  }
  _awaitingAttempt(record) {
    let waiting = false;
    for (const [key, item] of this.expectations) {
      if (item.projectKey !== record.projectKey || item.prNumber !== record.prNumber || item.headSha !== record.headSha
        || item.repoKey !== record.repo?.repoKey) continue;
      const run = record.runs.find((r) => r.id === item.runId);
      if (item.phase !== 'sending' && run && run.runAttempt > item.runAttempt) this.expectations.delete(key);
      else waiting = true;
    }
    return waiting;
  }
  _acceptPr(record, pr) {
    if (!pr || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) throw error('CI_WATCH_PR_INVALID');
    if (pr.state !== 'OPEN') { this._finish(record, 'pr_closed'); return false; }
    if (pr.isCrossRepository !== false || String(pr.headRepository).toLowerCase() !== record.repo.nameWithOwner.toLowerCase()) throw error('CI_WATCH_FORK_UNSUPPORTED');
    if (!normalizeSha(pr.headSha) || !pr.headRefName || pr.number !== record.prNumber) throw error('CI_WATCH_PR_INVALID');
    if (record.headSha && (record.headSha !== pr.headSha || record.headRefName !== pr.headRefName)) {
      this._finish(record, 'head_changed'); return false;
    }
    record.headSha = pr.headSha; record.headRefName = pr.headRefName;
    return true;
  }

  async _poll(record) {
    if (!this._active(record) || this.suspended || record.inflight) return;
    if (this.now() >= record.deadlineAt) { this._expire(record); return; }
    if ((this.hostCooldowns.get(record.repo?.host || record.hostHint) || 0) > this.now()) { this._schedule(record, 0); return; }
    record.inflight = true;
    const generation = record.pollGeneration;
    record.nextPollAt = null;
    const abort = new AbortController();
    record.abort = abort;
    let timedOut = false;
    let delay = POLL_INTERVAL_MS;
    const timer = this.setTimer(() => { timedOut = true; abort.abort(); }, Math.min(QUERY_TIMEOUT_MS, record.deadlineAt - this.now()));
    timer?.unref?.();
    const call = async (method, args) => {
      const result = await abortable(method.call(this.github, { ...args, signal: abort.signal, timeoutMs: QUERY_TIMEOUT_MS }), abort.signal);
      if (abort.signal.aborted || !this._active(record) || record.abort !== abort) throw interrupted();
      if (!result?.ok) throw result || error('CI_WATCH_UNAVAILABLE');
      return result;
    };
    try {
      if (!record.repo) {
        const result = await call(this.github.getCiWatchRepository, {
          projectPath: record.projectPath,
          // The adapter calls this only after deriving the host from local origin.
          // Even a newly starting watch must honor another watch's cooldown.
          getHostCooldownMs: (host) => Math.max(0, (this.hostCooldowns.get(host) || 0) - this.now()),
        });
        record.repo = result.repository;
        if (!record.repo?.repoKey || !record.repo.host || !record.repo.nameWithOwner) throw error('CI_WATCH_REPOSITORY_INVALID');
      } else {
        const origin = await call(this.github.getCiWatchOrigin, { repoRoot: record.repo.repoRoot });
        if (origin.repoKey !== record.repo.repoKey) { this._finish(record, 'error', 'CI_WATCH_REPOSITORY_CHANGED'); return; }
      }
      if ((this.hostCooldowns.get(record.repo.host) || 0) > this.now()) return;
      const args = { ...record.repo, number: record.prNumber };
      const before = await call(this.github.getCiPrStatus, args);
      if (!this._acceptPr(record, before.pr)) return;
      const result = await call(this.github.getCiRunsForHead, { ...args, headSha: record.headSha });
      const runs = result.truncated || result.incomplete ? null : normalizeRuns(result.runs, record.headSha);
      if (!runs) throw error('CI_WATCH_INCOMPLETE');
      for (const [id, attempt] of record.seenAttempts) {
        const run = runs.find((r) => r.id === id);
        if (!run || run.runAttempt < attempt) throw error('CI_WATCH_INCOMPLETE');
      }
      for (const run of runs) record.seenAttempts.set(run.id, run.runAttempt);
      record.runs = runs;
      record.status = 'watching'; record.errors = 0; record.reasonCode = '';
      record.lastCheckedAt = this.now();
      record.waitingForAttempt = this._awaitingAttempt(record);
      const resultOutcome = record.waitingForAttempt ? null : outcome(runs);
      const print = fingerprint(runs);
      if (!resultOutcome) { record.stableFingerprint = ''; record.stableSince = null; }
      else if (record.stableFingerprint !== print) { record.stableFingerprint = print; record.stableSince = this.now(); }
      else if (this.now() - record.stableSince >= STABLE_WINDOW_MS) {
        const barrier = record.barrierVersion;
        const after = await call(this.github.getCiPrStatus, args);
        if (!this._acceptPr(record, after.pr)) return;
        const origin = await call(this.github.getCiWatchOrigin, { repoRoot: record.repo.repoRoot });
        if (origin.repoKey !== record.repo.repoKey) { this._finish(record, 'error', 'CI_WATCH_REPOSITORY_CHANGED'); return; }
        if (barrier === record.barrierVersion && !this._awaitingAttempt(record)) {
          this._finish(record, 'completed', '', resultOutcome); return;
        }
      }
    } catch (cause) {
      if (!this._active(record) || this.suspended || generation !== record.pollGeneration) return;
      if (this.now() >= record.deadlineAt) { this._expire(record); return; }
      record.stableFingerprint = ''; record.stableSince = null;
      record.reasonCode = timedOut ? 'CI_WATCH_QUERY_TIMEOUT' : code(cause?.code);
      if (cause?.rateLimited === true) {
        const wait = Number.isFinite(cause.retryAfterMs) && cause.retryAfterMs > 0 ? cause.retryAfterMs : 60_000;
        delay = Math.max(POLL_INTERVAL_MS, Math.min(wait, 24 * 60 * 60_000));
        const host = record.repo?.host || cause.host;
        if (typeof host === 'string' && /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(host)) {
          record.hostHint = host;
          this.hostCooldowns.set(host, Math.max(this.hostCooldowns.get(host) || 0, this.now() + delay));
        }
      } else if (timedOut || cause?.transient === true) {
        record.errors++;
        if (record.errors >= 3) { this._finish(record, 'error', record.reasonCode); return; }
        delay = record.errors * 30_000;
      } else { this._finish(record, 'error', record.reasonCode); return; }
    } finally {
      this.clearTimer(timer);
      record.inflight = false;
      if (record.abort === abort) record.abort = null;
      if (this._active(record)) {
        this._schedule(record, generation !== record.pollGeneration ? 0 : delay);
        if (this._active(record)) this._emit(record, 'updated');
      }
    }
  }

  dropProject(projectPath) {
    const root = this.canonicalPath(projectPath);
    if (!root) return;
    const key = this.projectKey(root);
    for (const r of this.records.values()) if (r.projectKey === key) this._finish(r, 'stopped', 'CI_WATCH_PROJECT_REMOVED');
    for (const [id, item] of this.expectations) if (item.projectKey === key) this.expectations.delete(id);
  }
  suspend() {
    this.suspended = true;
    for (const r of this.records.values()) if (this._active(r)) {
      r.pollGeneration++;
      this.clearTimer(r.timer); r.nextPollAt = null; r.abort?.abort();
      r.stableFingerprint = ''; r.stableSince = null; r.reasonCode = 'CI_WATCH_SUSPENDED';
      this._emit(r, 'suspended');
    }
  }
  resume() {
    this.suspended = false;
    for (const r of this.records.values()) if (this._active(r)) {
      if (this.now() >= r.deadlineAt) this._expire(r);
      else { this._schedule(r, 0); this._emit(r, 'resumed'); }
    }
  }
  close() {
    for (const r of this.records.values()) this._finish(r, 'stopped', 'CI_WATCH_APP_CLOSED');
    this.closed = true;
    this.expectations.clear(); this.hostCooldowns.clear(); this.records.clear();
  }
}

function createCiWatchManager(options) { return new CiWatchManager(options); }
module.exports = { createCiWatchManager, MAX_ACTIVE, MAX_HISTORY };
