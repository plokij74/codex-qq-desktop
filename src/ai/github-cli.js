'use strict';

const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_MAX = 256 * 1024;

function clip(value, max = 4000) {
  return String(value || '')
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[opurs]_|github_pat_)[A-Za-z0-9_]{8,}/gi, '[REDACTED]')
    .replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
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
      resolve(result);
    };
    let child;
    try {
      child = impl(command, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: OUTPUT_MAX,
      }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          finish({ ok: false, code: -1, stdout: '', stderr: '', error: `${command} 未安装或无法执行` });
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const error = err
          ? (stderr ? clip(stderr) : `${command} 执行失败${code > 0 ? ` (exit ${code})` : ''}`)
          : '';
        finish({
          ok: !err,
          code,
          stdout: clip(stdout, OUTPUT_MAX),
          stderr: clip(stderr, OUTPUT_MAX),
          error,
        });
      });
    } catch (err) {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: clip(err.message || err) });
      return;
    }
    if (!settled) {
      timer = setTimeout(() => {
        try { child?.kill?.(); } catch { /* ignore */ }
        finish({ ok: false, code: -1, stdout: '', stderr: '', error: `${command} 超时` });
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
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const command = (name, args, extra = {}) => runCommand(name, args, {
    ...extra,
    execFileImpl,
    timeoutMs: extra.timeoutMs || timeoutMs,
  });

  async function git(repoRoot, args, extra = {}) {
    return command('git', ['-C', repoRoot, ...args], extra);
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

  async function repository({ repoRoot }) {
    const remote = await git(repoRoot, ['config', '--get', 'remote.origin.url']);
    if (!remote.ok) return { ok: false, code: 'NO_ORIGIN', error: '未配置 origin 远端' };
    const parsed = parseRemote(remote.stdout);
    if (!parsed) return { ok: false, code: 'REMOTE_UNSUPPORTED', error: 'origin 不是可识别的 GitHub 远端' };
    const auth = await command('gh', ['auth', 'status', '--hostname', parsed.host], { cwd: repoRoot });
    if (!auth.ok) return { ok: false, code: 'GH_NOT_AUTHENTICATED', error: 'GitHub CLI 未安装或尚未登录，请先运行 gh auth login', remote: parsed };
    const qualified = qualifiedRepo(parsed.host, parsed.owner, parsed.repo);
    const view = await command('gh', ['repo', 'view', qualified, '--json', 'defaultBranchRef,nameWithOwner'], { cwd: repoRoot });
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
      '--json', 'number,url,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,updatedAt,mergeable,mergeStateStatus,reviewDecision,labels,comments,files',
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
    parseRemote, runCommand: command, preflight, pushBranch, findExistingPr, createPr,
    repository, listPrs, getPr, getChecks, editPr, commentPr, closePr, reopenPr, readyPr, mergePr,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  parseRemote,
  runCommand,
  createGithubCli,
  qualifiedRepo,
  normalizePrSummary,
  normalizeChecks,
};
