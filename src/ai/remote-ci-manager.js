'use strict';

const path = require('node:path');
const {
  MAX_ANNOTATIONS,
  MAX_ANNOTATION_PATH,
  MAX_ANNOTATION_TEXT,
  MAX_FAILED_STEPS,
  MAX_LOG_EXCERPT_BYTES,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_REMOTE_CONTEXT_BYTES,
  ALLOWED_CONCLUSIONS,
  cleanText,
  redactRemoteText,
  remoteCiError,
  createRemoteCiRef,
  normalizeRemoteCiSnapshot,
  publicRemoteCiSummary,
  remoteCiDedupeKey,
  remoteCiSourceFingerprint,
  repositoryKey,
  normalizeSha,
  normalizeHeadRef,
  normalizeDecimalId,
} = require('./remote-ci-state');
const { canonicalProjectPath, projectKey: defaultProjectKey } = require('./project-index');
const { parseActionsDetailsUrl } = require('./github-cli');
const { parseDiagnostics, normalizePath: normalizeDiagnosticPath } = require('./verification-diagnostics');
const { redactVerificationOutput } = require('./verification-manager');

const MAX_FAILURES = 200;

function resultError(error, fallback = 'REMOTE_CI_RESULT_UNAVAILABLE') {
  const code = String(error?.code || fallback);
  const allowed = new Set([
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
  return {
    ok: false,
    code: allowed.has(code) ? code : fallback,
    error: allowed.has(code) ? code : fallback,
  };
}

function boundedUtf8(value, maxBytes) {
  const text = String(value || '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const marker = '\n...[truncated]...\n';
  const side = Math.max(0, Math.floor((maxBytes - Buffer.byteLength(marker)) / 2));
  let out = `${bytes.subarray(0, side).toString('utf8')}${marker}${bytes.subarray(Math.max(side, bytes.length - side)).toString('utf8')}`;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

function excerptLog(value) {
  return boundedUtf8(value, MAX_LOG_EXCERPT_BYTES);
}

function same(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function normalizePrNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 0x7fffffff ? n : 0;
}

function safeAnnotationPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw || raw.length > MAX_ANNOTATION_PATH || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)
    || raw.split('/').includes('..') || /[\u0000\r\n]/.test(raw)) return '';
  return raw.replace(/^\.\//, '');
}

function normalizeAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pathValue = safeAnnotationPath(raw.path);
  const title = cleanText(raw.title, MAX_ANNOTATION_TEXT);
  const message = cleanText(raw.message || raw.raw_details, MAX_ANNOTATION_TEXT);
  if (!pathValue && !title && !message) return null;
  return {
    ...(pathValue ? { path: pathValue } : {}),
    ...(Number.isFinite(Number(raw.start_line)) && Number(raw.start_line) > 0 ? { line: Math.floor(Number(raw.start_line)) } : {}),
    ...(Number.isFinite(Number(raw.start_column)) && Number(raw.start_column) > 0 ? { column: Math.floor(Number(raw.start_column)) } : {}),
    severity: ['failure', 'warning', 'notice'].includes(String(raw.annotation_level || '').toLowerCase())
      ? String(raw.annotation_level).toLowerCase() === 'notice' ? 'info' : String(raw.annotation_level).toLowerCase() === 'failure' ? 'error' : 'warning'
      : 'error',
    title,
    message,
  };
}

function outputText(check) {
  const title = cleanText(check?.output?.title, MAX_CHECK_OUTPUT_BYTES);
  const summary = cleanText(check?.output?.summary, MAX_CHECK_OUTPUT_BYTES);
  return boundedUtf8([title, summary].filter(Boolean).join('\n\n'), MAX_CHECK_OUTPUT_BYTES).text;
}

class RemoteCiManager {
  constructor(options = {}) {
    this.github = options.githubCli || options.github || null;
    this.worktree = options.worktreeManager || options.worktree || null;
    this.store = options.store;
    this.now = options.now || (() => Date.now());
    this.projectKey = options.projectKey || defaultProjectKey;
    this.resolveRepo = options.resolveRepo;
    this.getProfiles = options.getProfiles;
    this.mutationLock = options.mutationLock;
    this.pendingMutations = new Set();
    this.onRerunEvent = options.onRerunEvent;
  }

  _root(projectPath) {
    return canonicalProjectPath(projectPath);
  }

  async _repoRoot(root) {
    if (typeof this.resolveRepo === 'function') {
      const resolved = await this.resolveRepo(root);
      const candidate = resolved?.repoRoot || resolved?.root || resolved;
      if (candidate) return canonicalProjectPath(candidate) || String(candidate);
    }
    if (this.github?.runCommand) {
      const out = await this.github.runCommand('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: root });
      const value = out?.ok ? String(out.stdout || '').trim() : '';
      if (value) return canonicalProjectPath(value) || value;
    }
    return root;
  }

  async _repository(root) {
    if (!this.github?.repository) throw remoteCiError('REMOTE_CI_GH_UNAVAILABLE', 'GitHub CLI 适配器不可用');
    const repoRoot = await this._repoRoot(root);
    const result = await this.github.repository({ repoRoot });
    if (!result?.ok || !result.remote || !result.nameWithOwner) {
      throw remoteCiError(result?.code === 'GH_NOT_AUTHENTICATED' ? 'REMOTE_CI_GH_UNAVAILABLE' : 'REMOTE_CI_UNSUPPORTED_REPOSITORY', result?.error || '无法确认 origin GitHub 仓库');
    }
    const remote = result.remote;
    const nameWithOwner = String(result.nameWithOwner || `${remote.owner}/${remote.repo}`).trim();
    const repoKey = repositoryKey(remote.host, nameWithOwner);
    if (!repoKey) throw remoteCiError('REMOTE_CI_UNSUPPORTED_REPOSITORY', 'origin GitHub 仓库身份无效');
    return { root, repoRoot, remote, nameWithOwner, repoKey, base: result.base };
  }

  async _pr(repo, number) {
    const prNumber = normalizePrNumber(number);
    if (!prNumber) throw remoteCiError('REMOTE_CI_INVALID', 'PR 编号无效');
    const result = await this.github.getPr({ repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, number: prNumber });
    if (!result?.ok || !result.pr) throw remoteCiError('REMOTE_CI_PR_NOT_FOUND', result?.error || '无法读取 PR');
    const pr = result.pr;
    if (String(pr.state || '').toUpperCase() !== 'OPEN') throw remoteCiError('REMOTE_CI_PR_NOT_OPEN', 'PR 不是打开状态');
    if (pr.isCrossRepository !== false || !same(pr.headRepository, repo.nameWithOwner)) {
      throw remoteCiError('REMOTE_CI_FORK_UNSUPPORTED', 'fork PR 不支持远程 CI 修复');
    }
    const headSha = normalizeSha(pr.headSha);
    const headRefName = normalizeHeadRef(pr.headRefName);
    if (!headSha || !headRefName) throw remoteCiError('REMOTE_CI_HEAD_INVALID', 'PR head 无效');
    return { ...pr, number: prNumber, headSha, headRefName, headRepository: pr.headRepository || repo.nameWithOwner };
  }

  async _checks(repo, headSha) {
    if (!this.github?.getCheckRunsForRef) throw remoteCiError('REMOTE_CI_GH_UNAVAILABLE', 'GitHub Actions check 适配器不可用');
    const result = await this.github.getCheckRunsForRef({ repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, headSha });
    if (!result?.ok) throw remoteCiError('REMOTE_CI_RESULT_UNAVAILABLE', result?.error || '无法读取 GitHub Actions checks');
    return Array.isArray(result.checks) ? result.checks.slice(0, MAX_FAILURES) : [];
  }

  async _candidate(repo, pr, checkRunId, { content = false, checks: existingChecks } = {}) {
    const id = normalizeDecimalId(checkRunId);
    if (!id) throw remoteCiError('REMOTE_CI_INVALID', 'check run 编号无效');
    const checks = existingChecks || await this._checks(repo, pr.headSha);
    const listed = checks.find((item) => same(item.id, id));
    if (!listed) throw remoteCiError('REMOTE_CI_CHECK_NOT_FOUND', 'check run 不属于当前 PR head');
    if (String(listed.appSlug || '').toLowerCase() !== 'github-actions') throw remoteCiError('REMOTE_CI_CHECK_UNSUPPORTED', 'check 不是 GitHub Actions');
    if (String(listed.status || '').toLowerCase() !== 'completed') throw remoteCiError('REMOTE_CI_CHECK_NOT_FAILED', 'check 尚未完成');
    if (!ALLOWED_CONCLUSIONS.has(String(listed.conclusion || '').toLowerCase())) throw remoteCiError('REMOTE_CI_CHECK_NOT_FAILED', 'check 不是可修复失败');
    const details = parseActionsDetailsUrl(listed.detailsUrl, { host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo });
    if (!details) throw remoteCiError('REMOTE_CI_CHECK_UNSUPPORTED', 'Actions 详情链接不属于当前仓库');
    const jobResult = await this.github.getActionsJob({ repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, jobId: details.jobId });
    if (!jobResult?.ok || !jobResult.job) throw remoteCiError('REMOTE_CI_RESULT_UNAVAILABLE', jobResult?.error || '无法读取 Actions job');
    const job = jobResult.job;
    if (!same(job.id, details.jobId) || !same(job.runId, details.runId)
      || !same(job.headSha, pr.headSha) || String(job.status).toLowerCase() !== 'completed'
      || !ALLOWED_CONCLUSIONS.has(String(job.conclusion || '').toLowerCase())
      || String(job.conclusion).toLowerCase() !== String(listed.conclusion).toLowerCase()) {
      throw remoteCiError('REMOTE_CI_CHECK_NOT_FOUND', 'Actions job 与 check run 对账失败');
    }
    if (job.name !== listed.name) throw remoteCiError('REMOTE_CI_CHECK_NOT_FOUND');
    const runResult = await this.github.getActionsRun({ repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, runId: details.runId });
    if (!runResult?.ok || !runResult.run) throw remoteCiError('REMOTE_CI_RESULT_UNAVAILABLE', runResult?.error || '无法读取 Actions run');
    const run = runResult.run;
    if (!same(run.id, details.runId) || !same(run.headSha, pr.headSha) || Number(run.runAttempt) !== Number(job.runAttempt)
      || run.status !== 'completed') {
      throw remoteCiError('REMOTE_CI_ATTEMPT_CHANGED', 'Actions run attempt 已变化');
    }
    let check = listed;
    if (content && this.github.getCheckRunContent) {
      const detailed = await this.github.getCheckRunContent({ repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, checkRunId: id });
      if (!detailed?.ok || !detailed.check) throw remoteCiError('REMOTE_CI_RESULT_UNAVAILABLE', detailed?.error || '无法读取 check 输出');
      check = detailed.check;
    }
    return { repo, pr, check, job, run, runId: details.runId, jobId: details.jobId };
  }

  _snapshotFrom(candidate, root, ref) {
    const item = normalizeRemoteCiSnapshot({
      remoteCiRef: ref,
      projectKey: this.projectKey(root),
      repoKey: candidate.repo.repoKey,
      prNumber: candidate.pr.number,
      headSha: candidate.pr.headSha,
      headRefName: candidate.pr.headRefName,
      checkRunId: candidate.check.id,
      runId: candidate.runId,
      jobId: candidate.jobId,
      runAttempt: candidate.job.runAttempt,
      workflowName: candidate.job.workflowName || candidate.run.name || candidate.check.name,
      jobName: candidate.job.name,
      conclusion: candidate.job.conclusion,
      completedAt: candidate.job.completedAt || candidate.check.completedAt || undefined,
      annotationCount: candidate.check.annotationCount || 0,
      annotationsTruncated: false,
      logsAvailable: candidate.job.logsAvailable === true,
      createdAt: new Date(this.now()).toISOString(),
      lastVerifiedAt: new Date(this.now()).toISOString(),
    });
    return item;
  }

  async failures(projectPath, prNumber) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID', message: '项目绑定无效' });
    try {
      const repo = await this._repository(root);
      const pr = await this._pr(repo, prNumber);
      const checks = await this._checks(repo, pr.headSha);
      const failures = [];
      const unsupported = [];
      for (const check of checks) {
        const base = {
          checkRunId: String(check.id || ''), name: cleanText(check.name, 200), status: cleanText(check.status, 40).toLowerCase(),
          conclusion: cleanText(check.conclusion, 40).toLowerCase(), appSlug: cleanText(check.appSlug, 100).toLowerCase(),
        };
        try {
          const candidate = await this._candidate(repo, pr, check.id, { checks });
          const item = {
            ...base,
            workflowName: cleanText(candidate.job.workflowName || candidate.run.name, 200),
            jobName: cleanText(candidate.job.name, 200),
            runAttempt: Number(candidate.job.runAttempt),
            completedAt: cleanText(candidate.job.completedAt || check.completedAt, 80),
            annotationCount: candidate.check.annotationCount || 0,
            logsAvailable: candidate.job.logsAvailable === true,
            importable: true,
          };
          failures.push(item);
        } catch (error) {
          unsupported.push({ ...base, importable: false, reasonCode: String(error.code || 'REMOTE_CI_CHECK_UNSUPPORTED') });
        }
      }
      return { ok: true, pr: { number: pr.number, headSha: pr.headSha, headRefName: pr.headRefName }, failures, unsupported };
    } catch (error) { return resultError(error); }
  }

  async snapshot(projectPath, prNumber, checkRunId) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID', message: '项目绑定无效' });
    if (this.store?.corrupt) return resultError({ code: 'REMOTE_CI_STORE_CORRUPT', message: '远程 CI 历史存储损坏' });
    try {
      const repo = await this._repository(root);
      const pr = await this._pr(repo, prNumber);
      const candidate = await this._candidate(repo, pr, checkRunId);
      const base = this._snapshotFrom(candidate, root, createRemoteCiRef());
      const duplicate = this.store?.findDuplicate?.(base);
      const item = duplicate || this.store?.put?.(base) || base;
      return { ok: true, snapshot: publicRemoteCiSummary(item, { capability: 'available' }), remoteCiRef: item.remoteCiRef };
    } catch (error) { return resultError(error); }
  }

  async _loadSnapshot(root, remoteCiRef) {
    const key = this.projectKey(root);
    const item = this.store?.get?.(remoteCiRef, key);
    if (!item) throw remoteCiError('REMOTE_CI_NOT_FOUND', '远程 CI 来源不存在');
    const repo = await this._repository(root);
    const pr = await this._pr(repo, item.prNumber);
    if (!same(item.repoKey, repo.repoKey) || !same(item.headSha, pr.headSha) || !same(item.headRefName, pr.headRefName)) {
      throw remoteCiError('REMOTE_CI_HEAD_CHANGED', 'PR head 或仓库已变化');
    }
    const candidate = await this._candidate(repo, pr, item.checkRunId);
    if (!same(candidate.runId, item.runId) || !same(candidate.jobId, item.jobId) || Number(candidate.job.runAttempt) !== Number(item.runAttempt)
      || !same(candidate.job.name, item.jobName) || !same(candidate.job.conclusion, item.conclusion)) {
      throw remoteCiError('REMOTE_CI_ATTEMPT_CHANGED', '远程 CI attempt 已变化');
    }
    return { item, repo, pr, candidate };
  }

  async get(projectPath, remoteCiRef) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID', message: '项目绑定无效' });
    const item = this.store?.get?.(remoteCiRef, this.projectKey(root));
    if (!item) return resultError({ code: 'REMOTE_CI_NOT_FOUND', message: '远程 CI 来源不存在' });
    try {
      await this._loadSnapshot(root, remoteCiRef);
      return { ok: true, snapshot: publicRemoteCiSummary(item, { capability: 'available' }) };
    } catch (error) {
      const code = ['REMOTE_CI_HEAD_CHANGED', 'REMOTE_CI_ATTEMPT_CHANGED', 'REMOTE_CI_PR_NOT_OPEN', 'REMOTE_CI_FORK_UNSUPPORTED'].includes(error.code) ? 'stale' : 'unavailable';
      return { ok: true, snapshot: publicRemoteCiSummary(item, { capability: code, reasonCode: error.code }) };
    }
  }

  async list(projectPath, limit = 50) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID', message: '项目绑定无效' });
    const rows = this.store?.list?.(this.projectKey(root), limit) || [];
    const snapshots = [];
    for (const item of rows) {
      const got = await this.get(root, item.remoteCiRef);
      if (got.ok && got.snapshot) snapshots.push(got.snapshot);
    }
    return { ok: true, snapshots, persistence: this.store?.persistenceStatus?.() || null };
  }

  async resolveMetadata(projectPath, remoteCiRef) {
    const root = this._root(projectPath);
    if (!root) throw remoteCiError('REMOTE_CI_PROJECT_BINDING_INVALID', '项目绑定无效');
    const loaded = await this._loadSnapshot(root, remoteCiRef);
    const sourceFingerprint = remoteCiSourceFingerprint(loaded.item);
    return {
      source: { kind: 'remote_ci', remoteCiRef: loaded.item.remoteCiRef },
      sourceFingerprint,
      baseHead: loaded.item.headSha,
      sourceLabel: `GitHub Actions ${loaded.item.workflowName} / ${loaded.item.jobName}`,
      approvalLabel: `在 PR #${loaded.item.prNumber} 的 GitHub Actions job「${loaded.item.jobName}」隔离生成修复`,
      repo: loaded.repo,
      pr: loaded.pr,
      snapshot: loaded.item,
      candidate: loaded.candidate,
    };
  }

  _materializeContext(loaded, root) {
    const candidate = loaded.candidate;
    const checkOutput = outputText(candidate.check);
    const annotationsRaw = this.github.getCheckAnnotations
      ? null
      : [];
    return { candidate, checkOutput, annotationsRaw };
  }

  async materializeRepairSource(projectPath, remoteCiRef, options = {}) {
    const root = this._root(projectPath);
    if (!root) throw remoteCiError('REMOTE_CI_PROJECT_BINDING_INVALID', '项目绑定无效');
    const loaded = await this._loadSnapshot(root, remoteCiRef);
    // The second resolver call above is deliberately metadata-only. Fetch all
    // private CI bodies only after the caller has completed its write gate.
    let check = loaded.candidate.check;
    if (this.github.getCheckRunContent) {
      const detailed = await this.github.getCheckRunContent({ repoRoot: loaded.repo.repoRoot, host: loaded.repo.remote.host, owner: loaded.repo.remote.owner, repo: loaded.repo.remote.repo, checkRunId: loaded.item.checkRunId });
      if (detailed?.ok && detailed.check) {
        const detail = detailed.check;
        if (detail.id !== loaded.item.checkRunId || detail.name !== loaded.item.jobName || detail.conclusion !== loaded.item.conclusion || detail.status !== 'completed' || detail.appSlug !== 'github-actions') throw remoteCiError('REMOTE_CI_CHECK_NOT_FOUND');
        check = detail;
      }
    }
    const checkOutput = outputText(check);
    let annotations = [];
    let annotationsTruncated = false;
    if (this.github.getCheckAnnotations) {
      const got = await this.github.getCheckAnnotations({ repoRoot: loaded.repo.repoRoot, host: loaded.repo.remote.host, owner: loaded.repo.remote.owner, repo: loaded.repo.remote.repo, checkRunId: loaded.item.checkRunId });
      if (got?.ok) { annotations = got.annotations || []; annotationsTruncated = got.truncated === true; }
    }
    const diagnostics = [];
    for (const raw of annotations.slice(0, MAX_ANNOTATIONS)) {
      const item = normalizeAnnotation(raw);
      if (!item?.path || !item.line) continue;
      const safe = normalizeDiagnosticPath(item.path, root);
      if (!safe) continue;
      const redacted = redactVerificationOutput(`${item.title ? `${item.title}: ` : ''}${item.message}`, root).text;
      diagnostics.push({ path: safe, line: item.line, column: item.column || 1, severity: item.severity, code: null, message: redacted, source: 'github-actions' });
    }
    const failedSteps = (loaded.candidate.job.steps || []).filter((step) => ALLOWED_CONCLUSIONS.has(String(step.conclusion || '').toLowerCase())).slice(0, MAX_FAILED_STEPS);
    let log = '';
    let logTruncated = false;
    if (!diagnostics.length && loaded.candidate.job.logsAvailable && this.github.getActionsJobLog) {
      const got = await this.github.getActionsJobLog({ repoRoot: loaded.repo.repoRoot, host: loaded.repo.remote.host, owner: loaded.repo.remote.owner, repo: loaded.repo.remote.repo, jobId: loaded.item.jobId });
      if (got?.ok) { const excerpt = excerptLog(got.log); log = excerpt.text; logTruncated = excerpt.truncated || got.truncated === true; }
    }
    const pieces = [
      checkOutput ? `check output:\n${checkOutput}` : '',
      diagnostics.length ? `annotations:\n${diagnostics.map((d) => `${d.path}:${d.line}:${d.column} ${d.severity} ${d.message}`).join('\n')}` : '',
      failedSteps.length ? `failed steps:\n${failedSteps.map((s) => `${cleanText(s.name, 200)} (${cleanText(s.conclusion, 40)})`).join('\n')}` : '',
      log ? `job log excerpt:\n${log}` : '',
    ].filter(Boolean);
    if (!pieces.length) throw remoteCiError('REMOTE_CI_RESULT_UNAVAILABLE', '远程 CI 没有可用失败内容');
    const context = boundedUtf8(redactVerificationOutput(redactRemoteText(pieces.join('\n\n')), root).text, MAX_REMOTE_CONTEXT_BYTES);
    const result = {
      stdout: context.text,
      stderr: '',
      diagnostics: diagnostics.slice(0, 50),
      diagnosticsTruncated: annotationsTruncated || diagnostics.length > 50,
      outputTruncated: context.truncated || logTruncated,
    };
    const metadata = await this.resolveMetadata(root, remoteCiRef);
    const createWorktree = async ({ project, sessionId, subagentId, goal, signal } = {}) => {
      const fresh = await this.resolveMetadata(root, remoteCiRef);
      const targetRef = `refs/codex/remote-ci/${createRemoteCiRef()}`;
      if (!this.github.fetchBranchToRef || !this.github.resolveCommit || !this.github.deleteInternalRef || !this.worktree?.createAtCommit) {
        return { ok: false, code: 'REMOTE_CI_FETCH_FAILED', error: '远程基线 worktree 能力不可用' };
      }
      let fetched = false;
      try {
        if (signal?.aborted) return { ok: false, code: 'REMOTE_CI_FETCH_FAILED' };
        if (this.worktree.preflightRemoteCreate) {
          const check = await this.worktree.preflightRemoteCreate({ projectPath: root });
          if (!check?.ok) return check;
        }
        fetched = true;
        const got = await this.github.fetchBranchToRef({ repoRoot: fresh.repo.repoRoot, branch: fresh.pr.headRefName, targetRef });
        if (!got?.ok) return got;
        fetched = true;
        const commit = await this.github.resolveCommit({ repoRoot: fresh.repo.repoRoot, ref: targetRef });
        if (!commit?.ok || !same(commit.head, fresh.baseHead)) return { ok: false, code: 'REMOTE_CI_FETCH_MISMATCH', error: '获取的 PR head 与来源不一致' };
        return await this.worktree.createAtCommit({ project, baseHead: fresh.baseHead, sessionId, subagentId, goal, origin: { kind: 'remote_ci', remoteCiRef }, delivery: 'github_pr_update', signal });
      } finally {
        if (fetched) { try { await this.github.deleteInternalRef({ repoRoot: fresh.repo.repoRoot, ref: targetRef }); } catch {} }
      }
    };
    return {
      source: metadata.source,
      sourceFingerprint: metadata.sourceFingerprint,
      baseHead: metadata.baseHead,
      sourceLabel: metadata.sourceLabel,
      approvalLabel: metadata.approvalLabel,
      result,
      delivery: { kind: 'github_pr_update', remoteCiRef },
      createWorktree,
      ...(options.validationProfile ? { validationProfile: options.validationProfile } : {}),
    };
  }

  async _exclusive(key, fn) {
    if (this.pendingMutations.has(key)) return resultError({ code: 'PR_UPDATE_UNAVAILABLE' });
    this.pendingMutations.add(key);
    try { return await fn(); } finally { this.pendingMutations.delete(key); }
  }

  async updatePr(projectPath, resultId, subject, context = {}) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID' });
    return this._exclusive(`${root}:${resultId}`, async () => {
      let prepared = false;
      let pushStarted = false;
      try {
        const inspect = async () => {
          const found = await this.worktree.inspectRemoteResult({ projectPath: root, resultId });
          if (!found?.ok) throw remoteCiError('PR_UPDATE_UNAVAILABLE');
          const item = this.store?.get(found.marker.remoteCiRef, this.projectKey(root));
          if (!item || item.headSha !== found.marker.baseHead) throw remoteCiError('PR_UPDATE_UNAVAILABLE');
          const repo = await this._repository(root);
          const pr = await this._pr(repo, item.prNumber);
          if (repo.repoKey !== item.repoKey || pr.headRefName !== item.headRefName) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          return { found, item, repo, pr };
        };
        const initial = await inspect();
        const frozenSubject = initial.found.marker.prUpdate?.subject || cleanText(subject, 300) || `Fix CI for PR #${initial.item.prNumber}`;
        const gate = context.permissionGate || context.gate;
        if (!gate?.authorize) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
        const decision = await gate.authorize({ tool: 'remote_ci_update_pr', risk: 'remote-mutation', source: 'remote-ci',
          summary: `更新 PR #${initial.item.prNumber} · ${initial.item.headRefName}`,
          detail: `${initial.item.headSha.slice(0, 12)} · ${initial.found.marker.stats?.files || 0} 个文件 · ${frozenSubject}`, signal: context.signal });
        if (!decision?.allowed || context.isCurrent?.() === false) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
        const mutate = async () => {
          const fresh = await inspect();
          const prior = fresh.found.marker.prUpdate;
          const tip = await this.github.branchTip({ repoRoot: fresh.repo.repoRoot, branch: fresh.item.headRefName });
          if (!tip?.ok) throw remoteCiError('PR_UPDATE_UNCERTAIN');
          if (prior?.newCommit && fresh.pr.headSha === prior.newCommit && tip.head === prior.newCommit) {
            const verified = await this.worktree.verifyPrUpdate({ projectPath: root, resultId });
            if (!verified?.ok) throw remoteCiError('PR_UPDATE_TREE_MISMATCH');
            return this.worktree.completePrUpdate({ projectPath: root, resultId, prNumber: fresh.item.prNumber });
          }
          if (fresh.pr.headSha !== fresh.item.headSha || tip.head !== fresh.item.headSha) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          await this.resolveMetadata(root, fresh.item.remoteCiRef);
          if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          const ready = await this.worktree.preparePrUpdate({ projectPath: root, resultId, subject: frozenSubject });
          if (!ready?.ok) return ready;
          prepared = true;
          const last = await inspect();
          const lastTip = await this.github.branchTip({ repoRoot: last.repo.repoRoot, branch: last.item.headRefName });
          if (!lastTip?.ok || lastTip.head !== ready.oldHead || last.pr.headSha !== ready.oldHead) throw remoteCiError('PR_UPDATE_HEAD_CHANGED');
          if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('PR_UPDATE_CONFIRM_REQUIRED');
          pushStarted = true;
          const pushed = await this.github.exactLeasePush({ repoRoot: last.repo.repoRoot, branch: last.item.headRefName, oldHead: ready.oldHead, newCommit: ready.commit });
          if (!pushed?.ok) {
            pushStarted = pushed?.uncertain !== false;
            throw remoteCiError(pushStarted ? 'PR_UPDATE_UNCERTAIN' : 'PR_UPDATE_PUSH_FAILED');
          }
          const after = await this._pr(last.repo, last.item.prNumber);
          if (after.headSha !== ready.commit) throw remoteCiError('PR_UPDATE_UNCERTAIN');
          return this.worktree.completePrUpdate({ projectPath: root, resultId, prNumber: last.item.prNumber });
        };
        return await (this.mutationLock ? this.mutationLock(mutate) : mutate());
      } catch (cause) {
        const out = pushStarted ? resultError({ code: 'PR_UPDATE_UNCERTAIN' }) : resultError(cause, 'PR_UPDATE_UNAVAILABLE');
        if (prepared) return this.worktree.failPrUpdate({ projectPath: root, resultId, code: out.code, error: out.error, uncertain: pushStarted });
        return out;
      }
    });
  }

  async rerun(projectPath, remoteCiRef, context = {}) {
    return this._exclusive(`${projectPath}:${remoteCiRef}`, () => this._rerun(projectPath, remoteCiRef, context));
  }

  async _rerun(projectPath, remoteCiRef, context = {}) {
    const root = this._root(projectPath);
    if (!root) return resultError({ code: 'REMOTE_CI_PROJECT_BINDING_INVALID', message: '项目绑定无效' });
    try {
      const metadata = await this.resolveMetadata(root, remoteCiRef);
      const gate = context.permissionGate || context.gate;
      if (!gate?.authorize) throw remoteCiError('REMOTE_CI_RERUN_CONFIRM_REQUIRED', '重新运行 job 需要独立确认');
      const approval = await gate.authorize({ tool: 'remote_ci_rerun', risk: 'remote-mutation', source: 'remote-ci', summary: `重新运行 GitHub Actions job「${metadata.snapshot.jobName}」`, detail: `PR #${metadata.snapshot.prNumber} · ${metadata.snapshot.headSha.slice(0, 12)}`, sessionKey: context.sessionKey, signal: context.signal });
      if (!approval?.allowed) throw remoteCiError('REMOTE_CI_RERUN_CONFIRM_REQUIRED', '用户拒绝重新运行 job');
      const fresh = await this.resolveMetadata(root, remoteCiRef);
      if (context.isCurrent?.() === false || context.signal?.aborted) throw remoteCiError('REMOTE_CI_RERUN_CONFIRM_REQUIRED');
      const rerunEvent = (phase) => {
        try { this.onRerunEvent?.({
          projectPath: root, repoKey: fresh.snapshot.repoKey, prNumber: fresh.snapshot.prNumber,
          headSha: fresh.snapshot.headSha, runId: fresh.snapshot.runId, runAttempt: fresh.snapshot.runAttempt,
          remoteCiRef, phase,
        }); } catch {}
      };
      rerunEvent('sending');
      let out;
      try {
        out = await this.github.rerunActionsJob({ repoRoot: fresh.repo.repoRoot, host: fresh.repo.remote.host, owner: fresh.repo.remote.owner, repo: fresh.repo.remote.repo, jobId: fresh.snapshot.jobId });
      } catch (cause) {
        rerunEvent('uncertain');
        throw remoteCiError('REMOTE_CI_RERUN_UNCERTAIN');
      }
      rerunEvent(out?.ok ? 'requested' : out?.uncertain ? 'uncertain' : 'failed');
      if (!out?.ok) throw remoteCiError(out?.uncertain ? 'REMOTE_CI_RERUN_UNCERTAIN' : 'REMOTE_CI_RERUN_FAILED', out?.error || '重新运行 job 失败');
      return { ok: true, requested: true, remoteCiRef };
    } catch (error) { return resultError(error, 'REMOTE_CI_RERUN_FAILED'); }
  }
}

function createRemoteCiManager(options) { return new RemoteCiManager(options); }

module.exports = { RemoteCiManager, createRemoteCiManager, boundedUtf8, normalizeAnnotation };
