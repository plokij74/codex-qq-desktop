'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');

const {
  MAX_CHECK_RUNS,
  MAX_ANNOTATIONS,
  MAX_RAW_LOG_BYTES,
  normalizeDecimalId,
  normalizeSha,
  normalizeHeadRef,
  repositoryKey,
  redactRemoteText,
} = require('./remote-ci-state');
const { MAX_RUNS: MAX_WATCH_RUNS, normalizeRuns: normalizeWatchRuns } = require('./ci-watch-state');

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_MAX = 256 * 1024;

function clip(value, max = 4000) {
  return redactRemoteText(String(value || ''))
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[opurs]_|github_pat_)[A-Za-z0-9_]{8,}/gi, '[REDACTED]')
    .replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\b(?:ASIA|A3T)[0-9A-Z]{16,}\b/g, '[REDACTED]')
    .replace(/\b(?:xox[baprs]-|glpat-)[A-Za-z0-9_-]{10,}\b/gi, '[REDACTED]')
    .replace(/([?&](?:token|sig|signature|x-amz-signature|x-goog-signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/((?:aws_)?secret(?:_access_key)?|password|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

function runRawCommand(command, args, opts = {}) {
  const impl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(Number(opts.maxBytes)) ? Math.max(1, Number(opts.maxBytes)) : MAX_RAW_LOG_BYTES;
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let stdoutBytes = 0;
    const stdout = [];
    let stderr = Buffer.alloc(0);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child?.kill?.(); } catch {}
    };
    try {
      child = impl(command, args, { cwd: opts.cwd, windowsHide: true, shell: false });
    } catch (error) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: clip(error?.message || error), truncated: false });
      return;
    }
    child.stdout?.on?.('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
      const remaining = Math.max(0, maxBytes - stdoutBytes);
      if (remaining) {
        const kept = bytes.subarray(0, remaining);
        stdout.push(kept);
        stdoutBytes += kept.length;
      }
      if (bytes.length > remaining && !truncated) {
        truncated = true;
        try { child.kill?.(); } catch {}
      }
    });
    child.stderr?.on?.('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
      stderr = Buffer.concat([stderr, bytes]).subarray(-64 * 1024);
    });
    child.on?.('error', (error) => {
      finish({
        ok: false,
        code: -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: '',
        error: error?.code === 'ENOENT' ? `${command} 未安装或无法执行` : clip(error?.message || error),
        truncated,
      });
    });
    child.on?.('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (truncated) {
        finish({ ok: true, code: 0, stdout: output, stderr: '', error: '', truncated: true });
      } else if (timedOut || opts.signal?.aborted) {
        finish({ ok: false, code: -1, stdout: output, stderr: '', error: timedOut ? `${command} 超时` : '请求已取消', truncated: false });
      } else if (code !== 0) {
        finish({ ok: false, code: typeof code === 'number' ? code : 1, stdout: '', stderr: '', error: clip(stderr.toString('utf8') || `${command} 执行失败`), truncated: false });
      } else {
        finish({ ok: true, code: 0, stdout: output, stderr: '', error: '', truncated: false });
      }
    });
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener?.('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill?.(); } catch {}
    }, timeoutMs);
  });
}

function remoteParts(hostValue, pathValue) {
  const host = String(hostValue || '').toLowerCase();
  const parts = String(pathValue || '').replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!host || host.length > 255 || !owner || !repo
    || /[\s\r\n\0@]/.test(host) || /[\s\r\n\0\\]/.test(`${owner}${repo}`)) return null;
  return { host, owner, repo, nameWithOwner: `${owner}/${repo}` };
}

function parseRemote(raw) {
  const value = String(raw || '').trim();
  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)
        || (parsed.protocol === 'ssh:' && (parsed.username !== 'git' || parsed.password))
        || parsed.search || parsed.hash) return null;
      return remoteParts(parsed.host, parsed.pathname);
    } catch {
      return null;
    }
  }
  const scp = value.match(/^git@([^:/\s]+):([^/\s]+)\/([^/\s]+?)\/?$/i);
  return scp ? remoteParts(scp[1], `${scp[2]}/${scp[3]}`) : null;
}

function runCommand(command, args, opts = {}) {
  const impl = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : execFile;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    let child;
    const onAbort = () => {
      try { child?.kill?.(); } catch {}
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: '请求已取消', aborted: true });
    };
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = impl(command, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: OUTPUT_MAX,
      }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          finish({ ok: false, code: -1, stdout: '', stderr: '', error: `${command} 未安装或无法执行`, commandMissing: true });
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const error = err
          ? (stderr ? clip(stderr) : `${command} 执行失败${code > 0 ? ` (exit ${code})` : ''}`)
          : '';
        finish({
          ok: !err,
          code,
          // Raw metadata is parsed privately by apiWatchJson, never sent to IPC.
          stdout: opts.rawOutput === true ? String(stdout || '').slice(0, OUTPUT_MAX) : clip(stdout, OUTPUT_MAX),
          stderr: clip(stderr, OUTPUT_MAX),
          error,
        });
      });
    } catch (err) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: clip(err.message || err) });
      return;
    }
    if (opts.input != null) {
      // A process may exit before consuming stdin. Consume EPIPE as a failed
      // request instead of allowing an unhandled stream error to crash main.
      child?.stdin?.on?.('error', onAbort);
      try { if (child?.stdin?.end) child.stdin.end(String(opts.input)); else onAbort(); } catch { onAbort(); }
    }
    if (!settled) {
      timer = setTimeout(() => {
        try { child?.kill?.(); } catch { /* ignore */ }
        finish({ ok: false, code: -1, stdout: '', stderr: '', error: `${command} 超时`, timedOut: true });
      }, timeoutMs + 100);
    }
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function shellSafeName(value, max = 255) {
  const out = String(value || '').trim();
  return out && out.length <= max && !/[\r\n\0]/.test(out) ? out : '';
}

function qualifiedRepo(host, owner, repo) {
  const h = String(host || '').toLowerCase();
  const o = shellSafeName(owner);
  const r = shellSafeName(repo);
  if (!h || !o || !r) return '';
  return h === 'github.com' ? `${o}/${r}` : `${h}/${o}/${r}`;
}

function prNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 0x7fffffff ? number : 0;
}

function sha(value) {
  const out = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(out) ? out : '';
}

function boundedText(value, max) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function normalizeLabel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = boundedText(raw.name, 120);
  return name ? { name, color: boundedText(raw.color, 20) } : null;
}

function normalizePrSummary(raw, { detail = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const number = prNumber(raw.number);
  const url = String(raw.url || '').trim();
  if (!number || !/^https:\/\//i.test(url)) return null;
  const author = typeof raw.author === 'string'
    ? boundedText(raw.author, 120)
    : boundedText(raw.author?.login || raw.author?.name, 120);
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(normalizeLabel).filter(Boolean).slice(0, 50)
    : [];
  const comments = detail && Array.isArray(raw.comments)
    ? raw.comments.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const body = String(item.body ?? '').slice(0, 5000);
      const login = boundedText(item.author?.login || item.author?.name || item.author, 120);
      if (!body && !login) return null;
      return {
        id: boundedText(item.id || item.databaseId, 120),
        author: login,
        body,
        createdAt: boundedText(item.createdAt, 80),
        url: /^https:\/\//i.test(String(item.url || '')) ? String(item.url).slice(0, 2000) : '',
      };
    }).filter(Boolean).slice(0, 50)
    : [];
  const files = detail && Array.isArray(raw.files)
    ? raw.files.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const file = boundedText(item.path, 1000);
      return file ? { path: file, additions: Math.max(0, Number(item.additions) || 0), deletions: Math.max(0, Number(item.deletions) || 0) } : null;
    }).filter(Boolean).slice(0, 200)
    : [];
  return {
    number,
    url: url.slice(0, 2000),
    title: String(raw.title || '').slice(0, 300),
    body: detail ? String(raw.body || '').slice(0, 20000) : undefined,
    state: ['OPEN', 'CLOSED', 'MERGED'].includes(String(raw.state || '').toUpperCase())
      ? String(raw.state).toUpperCase() : boundedText(raw.state, 40).toUpperCase(),
    isDraft: raw.isDraft === true,
    author,
    headRefName: boundedText(raw.headRefName, 255),
    baseRefName: boundedText(raw.baseRefName, 255),
    headSha: sha(raw.headRefOid || raw.headSha || raw.headCommit?.oid),
    isCrossRepository: raw.isCrossRepository === true,
    headRepository: boundedText(raw.headRepository?.nameWithOwner || raw.headRepository?.nameWithOwnerWithOwner || raw.headRepository, 600),
    updatedAt: boundedText(raw.updatedAt, 80),
    mergeable: boundedText(raw.mergeable, 40).toUpperCase(),
    mergeStateStatus: boundedText(raw.mergeStateStatus, 60).toUpperCase(),
    reviewDecision: boundedText(raw.reviewDecision, 60).toUpperCase(),
    labels,
    comments,
    commentsTruncated: detail && Array.isArray(raw.comments) && raw.comments.length > comments.length,
    files,
    filesTruncated: detail && Array.isArray(raw.files) && raw.files.length > files.length,
  };
}

function flattenApiPages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => Array.isArray(item) ? item : [item]);
}

function normalizeCheckRun(raw, { includeOutput = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeDecimalId(raw.id);
  const name = boundedText(raw.name, 200);
  const status = boundedText(raw.status, 40).toLowerCase();
  const conclusion = boundedText(raw.conclusion, 40).toLowerCase();
  const detailsUrl = /^https:\/\//i.test(String(raw.details_url || raw.detailsUrl || ''))
    ? String(raw.details_url || raw.detailsUrl).slice(0, 2000) : '';
  if (!id || !name || !status) return null;
  const normalized = {
    id,
    name,
    status,
    conclusion,
    detailsUrl,
    appSlug: boundedText(raw.app_slug || raw.app?.slug, 100).toLowerCase(),
    startedAt: boundedText(raw.started_at || raw.startedAt, 80),
    completedAt: boundedText(raw.completed_at || raw.completedAt, 80),
    annotationCount: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(raw.annotations_count ?? raw.output?.annotations_count) || 0))),
  };
  if (includeOutput) {
    normalized.output = {
      title: String(raw.output_title ?? raw.output?.title ?? '').slice(0, 1000),
      summary: String(raw.output_summary ?? raw.output?.summary ?? '').slice(0, 12000),
    };
  }
  return normalized;
}

function normalizeActionsRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeDecimalId(raw.id);
  const headSha = normalizeSha(raw.head_sha || raw.headSha);
  const runAttempt = Number(raw.run_attempt ?? raw.runAttempt);
  if (!id || !headSha || !Number.isInteger(runAttempt) || runAttempt < 1) return null;
  return {
    id,
    name: boundedText(raw.name, 200),
    headSha,
    headBranch: boundedText(raw.head_branch || raw.headBranch, 255),
    runAttempt,
    status: boundedText(raw.status, 40).toLowerCase(),
    conclusion: boundedText(raw.conclusion, 40).toLowerCase(),
  };
}

function normalizeActionsJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeDecimalId(raw.id);
  const runId = normalizeDecimalId(raw.run_id || raw.runId);
  const headSha = normalizeSha(raw.head_sha || raw.headSha);
  const runAttempt = Number(raw.run_attempt ?? raw.runAttempt);
  const name = boundedText(raw.name, 200);
  if (!id || !runId || !headSha || !Number.isInteger(runAttempt) || runAttempt < 1 || !name) return null;
  const steps = Array.isArray(raw.steps) ? raw.steps.map((step) => ({
    name: boundedText(step?.name, 200),
    status: boundedText(step?.status, 40).toLowerCase(),
    conclusion: boundedText(step?.conclusion, 40).toLowerCase(),
    number: Number.isFinite(Number(step?.number)) ? Math.max(0, Math.floor(Number(step.number))) : 0,
  })).filter((step) => step.name).slice(0, 100) : [];
  return {
    id,
    runId,
    headSha,
    runAttempt,
    workflowName: boundedText(raw.workflow_name || raw.workflowName, 200),
    name,
    status: boundedText(raw.status, 40).toLowerCase(),
    conclusion: boundedText(raw.conclusion, 40).toLowerCase(),
    startedAt: boundedText(raw.started_at || raw.startedAt, 80),
    completedAt: boundedText(raw.completed_at || raw.completedAt, 80),
    logsAvailable: Boolean(raw.logs_url || raw.logsUrl),
    steps,
  };
}

function parseActionsDetailsUrl(value, { host, owner, repo } = {}) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.host.toLowerCase() !== String(host || '').toLowerCase()) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 7 || parts[0].toLowerCase() !== String(owner || '').toLowerCase()
      || parts[1].toLowerCase() !== String(repo || '').toLowerCase()
      || parts[2] !== 'actions' || parts[3] !== 'runs' || parts[5] !== 'job') return null;
    const runId = normalizeDecimalId(parts[4]);
    const jobId = normalizeDecimalId(parts[6]);
    return runId && jobId ? { runId, jobId } : null;
  } catch { return null; }
}

function normalizeChecks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const checks = list.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const name = boundedText(item.name || item.workflowName || item.context, 200);
    if (!name) return null;
    const state = boundedText(item.state || item.conclusion, 40).toUpperCase();
    const bucket = boundedText(item.bucket, 40).toUpperCase();
    const link = /^https:\/\//i.test(String(item.link || item.detailsUrl || ''))
      ? String(item.link || item.detailsUrl).slice(0, 2000) : '';
    return { name, state, bucket, link };
  }).filter(Boolean).slice(0, 200);
  const passed = checks.filter((item) => ['PASS', 'SUCCESS', 'NEUTRAL'].includes(item.bucket || item.state)).length;
  const pending = checks.filter((item) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(item.bucket || item.state)).length;
  const failed = checks.filter((item) => ['FAIL', 'FAILURE', 'FAILED', 'ERROR', 'CANCEL', 'CANCELLED', 'CANCELED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(item.bucket || item.state)).length;
  const skipped = checks.filter((item) => ['SKIPPED', 'SKIPPING'].includes(item.bucket || item.state)).length;
  const unknown = checks.length - passed - pending - failed - skipped;
  return {
    checks,
    summary: { total: checks.length, passed, pending, failed, skipped, unknown },
    truncated: list.length > checks.length,
  };
}

function createGithubCli(opts = {}) {
  const execFileImpl = opts.execFileImpl;
  const spawnImpl = opts.spawnImpl;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const command = (name, args, extra = {}) => runCommand(name, args, {
    ...extra,
    execFileImpl,
    timeoutMs: extra.timeoutMs || timeoutMs,
  });

  async function git(repoRoot, args, extra = {}) {
    return command('git', ['-C', repoRoot, ...args], extra);
  }

  async function apiJson({ repoRoot, host, endpoint, jq }) {
    const args = ['api', '--hostname', String(host || '').toLowerCase(), endpoint];
    if (jq) args.push('--jq', jq);
    const result = await command('gh', args, { cwd: repoRoot });
    const parsed = parseJson(result.stdout);
    if (!result.ok || parsed == null) return { ok: false, code: 'GH_API_FAILED', error: clip(result.error || 'GitHub API 返回无效结果'), uncertain: result.code === -1 };
    return { ok: true, value: parsed };
  }

  // D15 GET-only metadata path. Keep headers until status/rate-limit parsing;
  // the old command formatter intentionally flattens lines for other callers.
  async function apiWatchJson({ repoRoot, host, endpoint, jq, signal, timeoutMs: queryTimeout }) {
    const result = await command('gh', ['api', '--hostname', host, '--method', 'GET', '--include', endpoint, '--jq', jq], {
      cwd: repoRoot, signal, timeoutMs: queryTimeout, rawOutput: true,
    });
    const failure = (code, extra = {}) => ({ ok: false, code, error: code, ...extra });
    if (result.aborted) return failure('CI_WATCH_ABORTED');
    if (result.commandMissing) return failure('CI_WATCH_GH_UNAVAILABLE');
    if (result.timedOut) return failure('CI_WATCH_QUERY_TIMEOUT', { transient: true });
    let body = result.stdout;
    let status = 0;
    let headers = {};
    for (let i = 0; i < 5 && /^HTTP\//i.test(body); i++) {
      const split = body.match(/\r?\n\r?\n/);
      if (!split) break;
      const lines = body.slice(0, split.index).split(/\r?\n/);
      status = Number(lines.shift().match(/^HTTP\/[\d.]+\s+(\d{3})/i)?.[1]) || 0;
      headers = {};
      for (const line of lines) {
        const pair = line.match(/^([a-z0-9-]+):\s*(.*)$/i);
        if (pair && ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'].includes(pair[1].toLowerCase())) headers[pair[1].toLowerCase()] = pair[2];
      }
      body = body.slice(split.index + split[0].length);
    }
    if (status === 429 || (status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] || /rate limit/i.test(result.error)))) {
      const now = opts.now ? opts.now() : Date.now();
      const retry = headers['retry-after'];
      const retryMs = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - now;
      const resetMs = Number(headers['x-ratelimit-reset']) * 1000 - now;
      const retryAfterMs = Math.max(Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 0,
        headers['x-ratelimit-remaining'] === '0' && Number.isFinite(resetMs) && resetMs > 0 ? resetMs : 0) || 60_000;
      return failure('CI_WATCH_RATE_LIMITED', { rateLimited: true, retryAfterMs, host });
    }
    if (status === 401) return failure('CI_WATCH_AUTH_REQUIRED');
    if (status === 403) return failure('CI_WATCH_FORBIDDEN');
    if (status === 404 || status === 410) return failure('CI_WATCH_TARGET_NOT_FOUND');
    if (status >= 500 || (!status && !result.ok)) return failure('CI_WATCH_NETWORK', { transient: true });
    if (!result.ok || status !== 200) return failure('CI_WATCH_INCOMPLETE');
    const value = parseJson(body);
    return value ? { ok: true, value } : failure('CI_WATCH_INCOMPLETE');
  }

  function validWatchRepo(host, owner, repo) {
    return /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(String(host || ''))
      && [owner, repo].every((part) => typeof part === 'string' && part.length <= 255 && /^[a-z0-9][a-z0-9_.-]*$/i.test(part));
  }

  async function getCiWatchOrigin({ repoRoot, signal, timeoutMs: queryTimeout }) {
    const out = await git(repoRoot, ['config', '--get', 'remote.origin.url'], { signal, timeoutMs: queryTimeout });
    const remote = out.ok ? parseRemote(out.stdout) : null;
    if (!remote || !validWatchRepo(remote.host, remote.owner, remote.repo)) return { ok: false, code: 'CI_WATCH_REPOSITORY_INVALID' };
    return { ok: true, remote, repoKey: repositoryKey(remote.host, remote.nameWithOwner) };
  }

  async function getCiWatchRepository({ projectPath, signal, timeoutMs: queryTimeout, getHostCooldownMs }) {
    const top = await git(projectPath, ['rev-parse', '--show-toplevel'], { signal, timeoutMs: queryTimeout });
    if (!top.ok || !top.stdout) return { ok: false, code: 'CI_WATCH_REPOSITORY_INVALID' };
    const repoRoot = path.resolve(top.stdout.trim());
    const origin = await getCiWatchOrigin({ repoRoot, signal, timeoutMs: queryTimeout });
    if (!origin.ok) return origin;
    const { host, owner, repo, nameWithOwner } = origin.remote;
    const cooldown = getHostCooldownMs?.(host);
    if (Number.isFinite(cooldown) && cooldown > 0) {
      return { ok: false, code: 'CI_WATCH_RATE_LIMITED', rateLimited: true, retryAfterMs: cooldown, host };
    }
    const result = await apiWatchJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}`, jq: '{full_name}', signal, timeoutMs: queryTimeout });
    if (!result.ok) return result;
    if (String(result.value.full_name || '').toLowerCase() !== nameWithOwner.toLowerCase()) return { ok: false, code: 'CI_WATCH_REPOSITORY_INVALID' };
    return { ok: true, repository: { repoRoot, host, owner, repo, nameWithOwner, repoKey: origin.repoKey } };
  }

  async function getCiPrStatus({ repoRoot, host, owner, repo, number, signal, timeoutMs: queryTimeout }) {
    const n = prNumber(number);
    if (!n || !validWatchRepo(host, owner, repo)) return { ok: false, code: 'CI_WATCH_INVALID' };
    const result = await apiWatchJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/pulls/${n}`,
      jq: '{number,state,merged,head_sha:.head.sha,head_ref:.head.ref,head_repo:.head.repo.full_name,base_repo:.base.repo.full_name}', signal, timeoutMs: queryTimeout });
    if (!result.ok) return result;
    const raw = result.value;
    if (raw.number !== n || !['open', 'closed'].includes(raw.state)
      || typeof raw.merged !== 'boolean' || (raw.head_repo !== null && typeof raw.head_repo !== 'string')
      || String(raw.base_repo || '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return { ok: false, code: 'CI_WATCH_PR_INVALID' };
    return { ok: true, pr: {
      number: n, state: raw.merged === true ? 'MERGED' : raw.state.toUpperCase(),
      headSha: normalizeSha(raw.head_sha), headRefName: normalizeHeadRef(raw.head_ref),
      headRepository: typeof raw.head_repo === 'string' ? raw.head_repo.slice(0, 600) : '',
      isCrossRepository: !raw.head_repo || raw.head_repo.toLowerCase() !== raw.base_repo.toLowerCase(),
    } };
  }

  async function getCiRunsForHead({ repoRoot, host, owner, repo, headSha, signal, timeoutMs: queryTimeout }) {
    const head = normalizeSha(headSha);
    if (!head || !validWatchRepo(host, owner, repo)) return { ok: false, code: 'CI_WATCH_INVALID' };
    const runs = [];
    let total = null;
    const jq = '{total_count,workflow_runs:[.workflow_runs[]|{id:(.id|tostring),name,head_sha,run_attempt,status,conclusion}]}';
    for (let page = 1; page <= 2; page++) {
      const result = await apiWatchJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/actions/runs?head_sha=${head}&per_page=100&page=${page}`, jq, signal, timeoutMs: queryTimeout });
      if (!result.ok) return result;
      const count = result.value.total_count;
      const rows = result.value.workflow_runs;
      if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(rows) || (total != null && total !== count)) return { ok: false, code: 'CI_WATCH_INCOMPLETE' };
      total = count;
      if (total > MAX_WATCH_RUNS) return { ok: true, runs: [], truncated: true };
      if (rows.length !== Math.min(100, total - runs.length)) return { ok: false, code: 'CI_WATCH_INCOMPLETE' };
      runs.push(...rows);
      if (runs.length === total) break;
    }
    const normalized = normalizeWatchRuns(runs, head);
    return normalized && normalized.length === total
      ? { ok: true, runs: normalized, truncated: false }
      : { ok: false, code: 'CI_WATCH_INCOMPLETE' };
  }

  async function preflight({ repoRoot, baseHead }) {
    const remote = await git(repoRoot, ['config', '--get', 'remote.origin.url']);
    if (!remote.ok) return { ok: false, code: 'NO_ORIGIN', error: '未配置 origin 远端' };
    const parsed = parseRemote(remote.stdout);
    if (!parsed) return { ok: false, code: 'REMOTE_UNSUPPORTED', error: 'origin 不是可识别的 GitHub 远端' };
    const auth = await command('gh', ['auth', 'status', '--hostname', parsed.host], { cwd: repoRoot });
    if (!auth.ok) return { ok: false, code: 'GH_NOT_AUTHENTICATED', error: 'GitHub CLI 未安装或尚未登录，请先运行 gh auth login' , remote: parsed };
    const qualified = qualifiedRepo(parsed.host, parsed.owner, parsed.repo);
    const view = await command('gh', ['repo', 'view', qualified, '--json', 'defaultBranchRef,nameWithOwner'], { cwd: repoRoot });
    const metadata = parseJson(view.stdout);
    const base = shellSafeName(metadata?.defaultBranchRef?.name);
    if (!view.ok || !base) return { ok: false, code: 'GH_REPO_FAILED', error: clip(view.error || '无法读取 GitHub 仓库默认分支'), remote: parsed };
    const remoteHead = await git(repoRoot, ['ls-remote', 'origin', `refs/heads/${base}`]);
    const head = String(remoteHead.stdout || '').trim().split(/\s+/)[0].toLowerCase();
    if (!remoteHead.ok || !/^[a-f0-9]{40}$/.test(head)) return { ok: false, code: 'REMOTE_HEAD_FAILED', error: '无法读取远端默认分支 HEAD', remote: parsed, base };
    const expected = String(baseHead || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(expected) || head !== expected) return { ok: false, code: 'BASE_CHANGED', error: '远端默认分支已变化，请重新运行隔离任务', remote: parsed, base, remoteHead: head };
    return { ok: true, remote: parsed, base, remoteHead: head };
  }

  async function repository({ repoRoot, signal }) {
    const remote = await git(repoRoot, ['config', '--get', 'remote.origin.url'], { signal });
    if (!remote.ok) return { ok: false, code: 'NO_ORIGIN', error: '未配置 origin 远端' };
    const parsed = parseRemote(remote.stdout);
    if (!parsed) return { ok: false, code: 'REMOTE_UNSUPPORTED', error: 'origin 不是可识别的 GitHub 远端' };
    const auth = await command('gh', ['auth', 'status', '--hostname', parsed.host], { cwd: repoRoot, signal });
    if (!auth.ok) return { ok: false, code: 'GH_NOT_AUTHENTICATED', error: 'GitHub CLI 未安装或尚未登录，请先运行 gh auth login', remote: parsed };
    const qualified = qualifiedRepo(parsed.host, parsed.owner, parsed.repo);
    const view = await command('gh', ['repo', 'view', qualified, '--json', 'defaultBranchRef,nameWithOwner'], { cwd: repoRoot, signal });
    const metadata = parseJson(view.stdout);
    const base = shellSafeName(metadata?.defaultBranchRef?.name);
    const nameWithOwner = shellSafeName(metadata?.nameWithOwner, 600);
    if (!view.ok || !base || !nameWithOwner) return { ok: false, code: 'GH_REPO_FAILED', error: clip(view.error || '无法读取 GitHub 仓库信息'), remote: parsed };
    if (nameWithOwner.toLowerCase() !== `${parsed.owner}/${parsed.repo}`.toLowerCase()) {
      return { ok: false, code: 'REMOTE_MISMATCH', error: 'origin 与 GitHub 仓库不一致', remote: parsed };
    }
    return { ok: true, remote: parsed, base, nameWithOwner };
  }

  async function pushBranch({ repoRoot, branch, source = branch, remote = 'origin' }) {
    const result = await git(repoRoot, ['push', remote, `${source}:refs/heads/${branch}`]);
    return result.ok ? { ok: true } : { ok: false, code: 'PUSH_FAILED', error: clip(result.error || '推送分支失败') };
  }

  async function findExistingPr({ repoRoot, host, owner, repo, head }) {
    const qualified = qualifiedRepo(host, owner, repo);
    const result = await command('gh', ['pr', 'list', '--repo', qualified, '--state', 'all', '--head', head, '--json', 'number,url,state,isDraft'], { cwd: repoRoot });
    if (!result.ok) return { ok: false, code: 'PR_LOOKUP_FAILED', error: clip(result.error) };
    const list = parseJson(result.stdout);
    if (!Array.isArray(list) || list.some((item) => !item || typeof item !== 'object' || !/^https:\/\//i.test(String(item.url || '')))) {
      return { ok: false, code: 'PR_LOOKUP_FAILED', error: 'GitHub PR 查询结果格式无效' };
    }
    return { ok: true, pr: list.length === 1 ? list[0] : null, count: list.length };
  }

  async function createPr({ repoRoot, host, owner, repo, base, head, title, body, draft = true }) {
    const existing = await findExistingPr({ repoRoot, host, owner, repo, head });
    if (!existing.ok) return existing;
    if (existing.count > 1) return { ok: false, code: 'PR_AMBIGUOUS', error: '同一分支存在多个 PR，无法安全继续' };
    if (existing.pr) return { ok: true, pr: existing.pr, existing: true };
    const qualified = qualifiedRepo(host, owner, repo);
    const args = ['pr', 'create', '--repo', qualified, '--base', base, '--head', head, '--title', String(title || '').slice(0, 300), '--body', String(body || '').slice(0, 10000)];
    if (draft !== false) args.push('--draft');
    const result = await command('gh', args, { cwd: repoRoot });
    if (!result.ok) return { ok: false, code: 'PR_CREATE_FAILED', error: clip(result.error || '创建 PR 失败') };
    const url = String(result.stdout || '').trim().split(/\s+/).find((item) => /^https:\/\//i.test(item)) || '';
    if (!url) return { ok: false, code: 'PR_CREATE_UNCLEAR', error: 'GitHub 已返回但无法确认 PR 地址' };
    return { ok: true, pr: { url, state: draft === false ? 'OPEN' : 'OPEN', isDraft: draft !== false } };
  }

  async function repoArgs(host, owner, repo, number) {
    const qualified = qualifiedRepo(host, owner, repo);
    const n = prNumber(number);
    if (!qualified || !n) return null;
    return { qualified, number: String(n) };
  }

  async function listPrs({ repoRoot, host, owner, repo, state = 'open', limit = 50 }) {
    const qualified = qualifiedRepo(host, owner, repo);
    const wantedState = ['open', 'closed', 'merged', 'all'].includes(String(state)) ? String(state) : 'open';
    const requested = Math.min(51, Math.max(2, Number(limit) || 51));
    if (!qualified) return { ok: false, code: 'PR_INVALID', error: 'GitHub 仓库参数无效' };
    const result = await command('gh', [
      'pr', 'list', '--repo', qualified, '--state', wantedState, '--limit', String(requested),
      '--json', 'number,url,title,state,isDraft,author,headRefName,headRefOid,baseRefName,updatedAt,labels',
    ], { cwd: repoRoot });
    if (!result.ok) return { ok: false, code: 'PR_LOOKUP_FAILED', error: clip(result.error || '无法读取 PR 列表') };
    const raw = parseJson(result.stdout);
    if (!Array.isArray(raw)) return { ok: false, code: 'PR_LOOKUP_FAILED', error: 'GitHub PR 列表格式无效' };
    const normalized = raw.map((item) => normalizePrSummary(item)).filter(Boolean);
    return { ok: true, prs: normalized.slice(0, requested - 1), truncated: normalized.length >= requested - 1 && raw.length >= requested, state: wantedState };
  }

  async function getPr({ repoRoot, host, owner, repo, number }) {
    const args = await repoArgs(host, owner, repo, number);
    if (!args) return { ok: false, code: 'PR_INVALID', error: 'PR 编号无效' };
    const result = await command('gh', [
      'pr', 'view', args.number, '--repo', args.qualified,
      '--json', 'number,url,title,body,state,isDraft,author,headRefName,headRefOid,headRepository,isCrossRepository,baseRefName,updatedAt,mergeable,mergeStateStatus,reviewDecision,labels,comments,files',
    ], { cwd: repoRoot });
    if (!result.ok) return { ok: false, code: 'PR_LOOKUP_FAILED', error: clip(result.error || '无法读取 PR 详情') };
    const pr = normalizePrSummary(parseJson(result.stdout), { detail: true });
    return pr ? { ok: true, pr } : { ok: false, code: 'PR_LOOKUP_FAILED', error: 'GitHub PR 详情格式无效' };
  }

  async function getChecks({ repoRoot, host, owner, repo, number }) {
    const args = await repoArgs(host, owner, repo, number);
    if (!args) return { ok: false, code: 'PR_INVALID', error: 'PR 编号无效' };
    const result = await command('gh', ['pr', 'checks', args.number, '--repo', args.qualified, '--json', 'name,state,bucket,link'], { cwd: repoRoot });
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed)) return { ok: false, code: 'PR_CHECKS_FAILED', error: clip(result.error || 'GitHub checks 格式无效') };
    const normalized = normalizeChecks(parsed);
    return { ok: true, ...normalized, exitCode: result.code };
  }

  async function getCheckRunsForRef({ repoRoot, host, owner, repo, headSha }) {
    const qualified = qualifiedRepo(host, owner, repo);
    const cleanSha = sha(headSha);
    if (!qualified || !cleanSha) return { ok: false, code: 'PR_CHECKS_FAILED', error: 'check run 参数无效' };
    const checks = [];
    let truncated = false;
    const jq = '.check_runs | map({id:(.id|tostring),name,status,conclusion,details_url,app_slug:.app.slug,started_at,completed_at,annotations_count:.output.annotations_count})';
    for (let page = 1; page <= 2; page += 1) {
      const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/commits/${cleanSha}/check-runs?filter=latest&per_page=100&page=${page}`, jq });
      if (!result.ok) return { ok: false, code: 'PR_CHECKS_FAILED', error: result.error };
      const rows = flattenApiPages(result.value);
      for (const raw of rows) {
        const item = normalizeCheckRun(raw);
        if (item) checks.push(item);
        if (checks.length >= MAX_CHECK_RUNS) { truncated = rows.length >= 100 || page === 2; break; }
      }
      if (rows.length < 100 || checks.length >= MAX_CHECK_RUNS) break;
    }
    return { ok: true, checks: checks.slice(0, MAX_CHECK_RUNS), truncated };
  }

  async function getCheckRun({ repoRoot, host, owner, repo, checkRunId }) {
    const id = normalizeDecimalId(checkRunId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'PR_CHECKS_FAILED', error: 'check run 参数无效' };
    const jq = '{id:(.id|tostring),name,status,conclusion,details_url,app_slug:.app.slug,started_at,completed_at,annotations_count:.output.annotations_count}';
    const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/check-runs/${id}`, jq });
    if (!result.ok) return { ok: false, code: 'PR_CHECKS_FAILED', error: result.error };
    const check = normalizeCheckRun(result.value);
    return check ? { ok: true, check } : { ok: false, code: 'PR_CHECKS_FAILED', error: 'check run 格式无效' };
  }

  async function getCheckRunContent({ repoRoot, host, owner, repo, checkRunId }) {
    const id = normalizeDecimalId(checkRunId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'PR_CHECKS_FAILED', error: 'check run 参数无效' };
    const jq = '{id:(.id|tostring),name,status,conclusion,details_url,app_slug:.app.slug,started_at,completed_at,output_title:.output.title,output_summary:.output.summary,annotations_count:.output.annotations_count}';
    const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/check-runs/${id}`, jq });
    if (!result.ok) return { ok: false, code: 'PR_CHECKS_FAILED', error: result.error };
    const check = normalizeCheckRun(result.value, { includeOutput: true });
    return check ? { ok: true, check } : { ok: false, code: 'PR_CHECKS_FAILED', error: 'check run 格式无效' };
  }

  async function getCheckAnnotations({ repoRoot, host, owner, repo, checkRunId }) {
    const id = normalizeDecimalId(checkRunId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'PR_CHECKS_FAILED', error: 'annotation 参数无效' };
    const jq = 'map({path,start_line,end_line,start_column,end_column,annotation_level,title,message,raw_details})';
    const annotations = [];
    let truncated = false;
    // GitHub caps a page at 100. Read at most two pages and stop as soon as
    // the bounded public set is known to be truncated.
    for (let page = 1; page <= 2; page += 1) {
      const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/check-runs/${id}/annotations?per_page=100&page=${page}`, jq });
      if (!result.ok || !Array.isArray(result.value)) return { ok: false, code: 'PR_CHECKS_FAILED', error: result.error || 'annotation 格式无效' };
      annotations.push(...result.value);
      if (annotations.length > MAX_ANNOTATIONS) {
        truncated = true;
        break;
      }
      if (result.value.length < 100) break;
      truncated = true;
    }
    return { ok: true, annotations: annotations.slice(0, MAX_ANNOTATIONS), truncated };
  }

  async function getActionsRun({ repoRoot, host, owner, repo, runId }) {
    const id = normalizeDecimalId(runId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'GH_API_FAILED', error: 'workflow run 参数无效' };
    const jq = '{id:(.id|tostring),name,head_sha,head_branch,run_attempt,status,conclusion}';
    const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/actions/runs/${id}`, jq });
    if (!result.ok) return result;
    const run = normalizeActionsRun(result.value);
    return run ? { ok: true, run } : { ok: false, code: 'GH_API_FAILED', error: 'workflow run 格式无效' };
  }

  async function getActionsJob({ repoRoot, host, owner, repo, jobId }) {
    const id = normalizeDecimalId(jobId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'GH_API_FAILED', error: 'Actions job 参数无效' };
    const jq = '{id:(.id|tostring),run_id:(.run_id|tostring),workflow_name,head_sha,run_attempt,name,status,conclusion,started_at,completed_at,logs_url,steps}';
    const result = await apiJson({ repoRoot, host, endpoint: `repos/${owner}/${repo}/actions/jobs/${id}`, jq });
    if (!result.ok) return result;
    const job = normalizeActionsJob(result.value);
    return job ? { ok: true, job } : { ok: false, code: 'GH_API_FAILED', error: 'Actions job 格式无效' };
  }

  async function getActionsJobLog({ repoRoot, host, owner, repo, jobId, signal }) {
    const id = normalizeDecimalId(jobId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'GH_API_FAILED', error: 'Actions job log 参数无效' };
    const result = await runRawCommand('gh', ['api', '--hostname', String(host || '').toLowerCase(), `repos/${owner}/${repo}/actions/jobs/${id}/logs`], {
      cwd: repoRoot,
      timeoutMs,
      maxBytes: MAX_RAW_LOG_BYTES,
      spawnImpl,
      signal,
    });
    return result.ok
      ? { ok: true, log: result.stdout, truncated: result.truncated === true }
      : { ok: false, code: 'GH_API_FAILED', error: clip(result.error || '无法读取 Actions job log'), uncertain: result.code === -1 };
  }

  async function rerunActionsJob({ repoRoot, host, owner, repo, jobId }) {
    const id = normalizeDecimalId(jobId);
    if (!qualifiedRepo(host, owner, repo) || !id) return { ok: false, code: 'GH_API_FAILED', error: 'Actions job 参数无效' };
    const result = await command('gh', ['api', '--hostname', String(host || '').toLowerCase(), '--method', 'POST', `repos/${owner}/${repo}/actions/jobs/${id}/rerun`], { cwd: repoRoot });
    return result.ok
      ? { ok: true }
      : { ok: false, code: 'GH_API_FAILED', error: clip(result.error || '重新运行 Actions job 失败'), uncertain: result.code === -1 };
  }

  async function branchTip({ repoRoot, branch, signal }) {
    const cleanBranch = shellSafeName(branch);
    if (!cleanBranch) return { ok: false, code: 'REMOTE_HEAD_FAILED', error: '远端分支无效' };
    const result = await git(repoRoot, ['ls-remote', 'origin', `refs/heads/${cleanBranch}`], { signal });
    const head = result.ok ? sha(String(result.stdout || '').trim().split(/\s+/)[0]) : '';
    return head ? { ok: true, head } : { ok: false, code: 'REMOTE_HEAD_FAILED', error: '无法读取远端分支 HEAD', uncertain: result.code === -1 };
  }

  async function exactLeasePush({ repoRoot, branch, oldHead, newCommit, signal }) {
    const cleanBranch = shellSafeName(branch);
    const oldSha = sha(oldHead);
    const nextSha = sha(newCommit);
    if (!cleanBranch || !oldSha || !nextSha) return { ok: false, code: 'PUSH_FAILED', error: '精确推送参数无效', uncertain: false };
    const ref = `refs/heads/${cleanBranch}`;
    const result = await git(repoRoot, ['push', '--porcelain', `--force-with-lease=${ref}:${oldSha}`, 'origin', `${nextSha}:${ref}`], { signal, rawOutput: true });
    // A transport failure can exit nonzero after the remote accepted the push.
    // Only an explicit rejection of this exact ref proves it is safe to retry.
    const rejected = String(result.stdout || '').split(/\r?\n/).some((line) => {
      const fields = line.split('\t');
      return fields[0] === '!' && fields[1] === `${nextSha}:${ref}`
        && /^\[(?:rejected|remote rejected)\](?: |$)/.test(fields[2] || '');
    });
    return result.ok ? { ok: true } : { ok: false, code: 'PUSH_FAILED', error: clip(result.error || '精确推送失败'), uncertain: !result.commandMissing && !rejected };
  }

  async function fetchBranchToRef({ repoRoot, branch, targetRef, signal }) {
    const cleanBranch = shellSafeName(branch);
    const cleanRef = String(targetRef || '');
    if (!cleanBranch || !/^refs\/codex\/(?:remote-ci\/rci_|pr-review\/prv_)[a-f0-9]{24}$/.test(cleanRef)) {
      return { ok: false, code: 'REMOTE_CI_FETCH_FAILED', error: '远程 CI fetch 参数无效' };
    }
    // Keep the long-lived fetch tail stable for callers while pinning the
    // submodule/refmap behavior before the existing output-suppression flags.
    const result = await git(repoRoot, ['fetch', '--no-recurse-submodules', '--refmap=', '--no-tags', '--no-write-fetch-head', 'origin', `refs/heads/${cleanBranch}:${cleanRef}`], { signal });
    return result.ok
      ? { ok: true }
      : { ok: false, code: 'REMOTE_CI_FETCH_FAILED', error: clip(result.error || '无法获取 PR head'), uncertain: result.code === -1 };
  }

  async function resolveCommit({ repoRoot, ref, signal }) {
    const cleanRef = String(ref || '');
    if (!/^refs\/codex\/(?:remote-ci\/rci_|pr-review\/prv_)[a-f0-9]{24}$/.test(cleanRef)) {
      return { ok: false, code: 'REMOTE_CI_FETCH_MISMATCH', error: '远程 CI ref 无效' };
    }
    const result = await git(repoRoot, ['rev-parse', '--verify', `${cleanRef}^{commit}`], { signal });
    const head = result.ok ? sha(result.stdout) : '';
    return head ? { ok: true, head } : { ok: false, code: 'REMOTE_CI_FETCH_MISMATCH', error: '无法验证 PR head commit' };
  }

  async function deleteInternalRef({ repoRoot, ref }) {
    const cleanRef = String(ref || '');
    if (!/^refs\/codex\/(?:remote-ci\/rci_|pr-review\/prv_)[a-f0-9]{24}$/.test(cleanRef)) return { ok: false, code: 'REMOTE_CI_FETCH_FAILED', error: '远程 CI ref 无效' };
    const result = await git(repoRoot, ['update-ref', '-d', cleanRef]);
    return result.ok ? { ok: true } : { ok: false, code: 'REMOTE_CI_FETCH_FAILED', error: clip(result.error || '无法清理远程 CI ref') };
  }

  async function runPrAction({ repoRoot, host, owner, repo, number, action, extra = [] }) {
    const args = await repoArgs(host, owner, repo, number);
    if (!args) return { ok: false, code: 'PR_INVALID', error: 'PR 编号无效' };
    const result = await command('gh', ['pr', action, args.number, '--repo', args.qualified, ...extra], { cwd: repoRoot });
    return result.ok
      ? { ok: true }
      : { ok: false, code: 'PR_ACTION_FAILED', error: clip(result.error || `PR ${action} 失败`), uncertain: result.code === -1 };
  }

  async function editPr({ repoRoot, host, owner, repo, number, title, body }) {
    const cleanTitle = String(title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
    const cleanBody = String(body || '').slice(0, 10000);
    if (!cleanTitle) return { ok: false, code: 'PR_INVALID', error: 'PR 标题不能为空' };
    return runPrAction({ repoRoot, host, owner, repo, number, action: 'edit', extra: ['--title', cleanTitle, '--body', cleanBody] });
  }

  async function commentPr({ repoRoot, host, owner, repo, number, body }) {
    const cleanBody = String(body || '').trim().slice(0, 10000);
    if (!cleanBody) return { ok: false, code: 'PR_INVALID', error: '评论不能为空' };
    return runPrAction({ repoRoot, host, owner, repo, number, action: 'comment', extra: ['--body', cleanBody] });
  }

  async function closePr(args) { return runPrAction({ ...args, action: 'close' }); }
  async function reopenPr(args) { return runPrAction({ ...args, action: 'reopen' }); }
  async function readyPr(args) { return runPrAction({ ...args, action: 'ready' }); }

  async function mergePr({ repoRoot, host, owner, repo, number, method = 'squash', headSha }) {
    const allowed = new Set(['merge', 'squash', 'rebase']);
    const cleanSha = sha(headSha);
    if (!allowed.has(method) || !cleanSha) return { ok: false, code: 'PR_INVALID', error: '合并参数无效' };
    const flag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash';
    return runPrAction({
      repoRoot, host, owner, repo, number, action: 'merge',
      extra: [flag, '--match-head-commit', cleanSha, '--delete-branch=false'],
    });
  }

  return {
    ...require('./pr-review-github').createReviewGithub(command, qualifiedRepo),
    parseRemote, runCommand: command, preflight, pushBranch, findExistingPr, createPr,
    repository, listPrs, getPr, getChecks, editPr, commentPr, closePr, reopenPr, readyPr, mergePr,
    getCheckRunsForRef, getCheckRun, getCheckRunContent, getCheckAnnotations, getActionsRun, getActionsJob,
    getActionsJobLog, rerunActionsJob, branchTip, exactLeasePush,
    fetchBranchToRef, resolveCommit, deleteInternalRef,
    getCiWatchRepository, getCiWatchOrigin, getCiPrStatus, getCiRunsForHead,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  parseRemote,
  runCommand,
  runRawCommand,
  createGithubCli,
  qualifiedRepo,
  normalizePrSummary,
  normalizeChecks,
  normalizeCheckRun,
  normalizeActionsRun,
  normalizeActionsJob,
  parseActionsDetailsUrl,
};
