'use strict';

const path = require('node:path');
const { canonicalProjectPath, projectKey } = require('./project-index');
const { repositoryKey, normalizeSha, normalizeHeadRef } = require('./remote-ci-state');
const { createRemoteWorktree, updatePr } = require('./pr-delivery');
const { createPrReviewStore } = require('./pr-review-store');
const S = require('./pr-review-state');

class PrReviewManager {
  constructor(options = {}) {
    this.github = options.githubCli || options.github;
    this.worktree = options.worktreeManager || options.worktree;
    this.store = options.store || createPrReviewStore(options);
    this.resolveRepo = options.resolveRepo;
    this.mutationLock = options.mutationLock;
    this.now = options.now || Date.now;
    this.projectKey = projectKey;
    this.deliverySource = { kind: 'pr_review', refField: 'reviewRef', label: 'PR review' };
    this.refs = new Map();
    this.pendingMutations = new Set();
    this.uncertain = new Set();
    this.closing = false;
  }
  _root(root) { return canonicalProjectPath(root); }
  _current(context = {}) {
    if (this.closing || context.signal?.aborted || context.isCurrent?.() === false) throw S.fail('PR_REVIEW_PROJECT_BINDING_INVALID');
  }
  async _repository(root, context = {}) {
    this._current(context);
    if (!root || !this.github?.repository) throw S.fail('PR_REVIEW_UNAVAILABLE');
    let repoRoot;
    if (this.resolveRepo) {
      const resolved = await this.resolveRepo(root);
      repoRoot = resolved?.repoRoot || resolved;
    } else {
      const result = await this.github.runCommand('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: root, signal: context.signal });
      if (!result?.ok) throw S.fail('PR_REVIEW_UNAVAILABLE');
      repoRoot = result.stdout.trim();
    }
    repoRoot = canonicalProjectPath(repoRoot);
    if (!repoRoot) throw S.fail('PR_REVIEW_UNAVAILABLE');
    const result = await this.github.repository({ repoRoot, signal: context.signal });
    this._current(context);
    const remote = result?.remote;
    if (!result?.ok || !remote || !result.nameWithOwner) throw S.fail('PR_REVIEW_UNAVAILABLE');
    const nameWithOwner = result.nameWithOwner;
    if (`${remote.owner}/${remote.repo}`.toLowerCase() !== nameWithOwner.toLowerCase()) throw S.fail('PR_REVIEW_CHANGED');
    const repoKey = repositoryKey(remote.host, nameWithOwner);
    if (!repoKey) throw S.fail('PR_REVIEW_UNAVAILABLE');
    return { root, repoRoot, remote, repoKey, nameWithOwner };
  }
  _args(repo, extra = {}) { return { repoRoot: repo.repoRoot, host: repo.remote.host, owner: repo.remote.owner, repo: repo.remote.repo, ...extra }; }
  _prData(repo, raw, number) {
    if (!raw || raw.number !== number || raw.repository?.nameWithOwner?.toLowerCase() !== repo.nameWithOwner.toLowerCase()) throw S.fail('PR_REVIEW_NOT_FOUND');
    if (raw.state !== 'OPEN') throw S.fail('PR_REVIEW_PR_NOT_OPEN');
    if (raw.isCrossRepository !== false || raw.headRepository?.nameWithOwner?.toLowerCase() !== repo.nameWithOwner.toLowerCase()) throw S.fail('PR_REVIEW_FORK_UNSUPPORTED');
    if (!normalizeSha(raw.headSha) || !normalizeHeadRef(raw.headRefName)) throw S.fail('PR_REVIEW_INCOMPLETE');
    return { number, headSha: normalizeSha(raw.headSha), headRefName: raw.headRefName };
  }
  async _pr(repo, number, context = {}) {
    const result = await this.github.getReviewThreads(this._args(repo, { number, signal: context.signal }));
    this._current(context);
    if (!result?.ok) throw S.fail(result?.code);
    return this._prData(repo, result.pr, number);
  }
  _remember(root, repo, number, threadId) {
    const key = S.hash([projectKey(root), repo.repoKey, number, threadId]);
    for (const [threadRef, row] of this.refs) if (row.key === key) return threadRef;
    while (this.refs.size >= 1000) this.refs.delete(this.refs.keys().next().value);
    const threadRef = S.ref('prt');
    this.refs.set(threadRef, { key, projectKey: projectKey(root), repoKey: repo.repoKey, prNumber: number, threadId });
    return threadRef;
  }
  async threads(projectPath, number, context = {}) {
    try {
      const root = this._root(projectPath);
      if (!Number.isSafeInteger(number) || number < 1 || number > 0x7fffffff) throw S.fail();
      this._current(context);
      const repo = await this._repository(root, context);
      const rows = []; const seen = new Set(); let after = null; let pr; let total; let truncated = false;
      for (let page = 0; page < 2; page++) {
        const result = await this.github.getReviewThreads(this._args(repo, { number, after, signal: context.signal }));
        this._current(context);
        if (!result?.ok) throw S.fail(result?.code);
        const current = this._prData(repo, result.pr, number);
        if (pr && S.hash(pr) !== S.hash(current)) throw S.fail('PR_REVIEW_CHANGED');
        pr = current;
        const connection = result.pr.reviewThreads;
        if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > 100
          || !Number.isSafeInteger(connection.totalCount) || connection.totalCount < 0
          || (total != null && total !== connection.totalCount) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw S.fail('PR_REVIEW_INCOMPLETE');
        total = connection.totalCount;
        for (const raw of connection.nodes) {
          const thread = S.normalizeThread(raw);
          if (seen.has(thread.id)) throw S.fail('PR_REVIEW_INCOMPLETE');
          seen.add(thread.id); rows.push(thread);
        }
        truncated = connection.pageInfo.hasNextPage;
        if (!truncated) break;
        const cursor = connection.pageInfo.endCursor;
        if (typeof cursor !== 'string' || !cursor || cursor === after || !connection.nodes.length) throw S.fail('PR_REVIEW_INCOMPLETE');
        after = cursor;
      }
      if ((!truncated && rows.length !== total) || rows.length > total) throw S.fail('PR_REVIEW_INCOMPLETE');
      const latestRepo = await this._repository(root, context);
      const latest = await this._pr(latestRepo, number, context);
      this._current(context);
      if (latestRepo.repoKey !== repo.repoKey || S.hash(latest) !== S.hash(pr)) throw S.fail('PR_REVIEW_CHANGED');
      return { ok: true, prNumber: number, headSha: pr.headSha, truncated, total,
        threads: rows.map((thread) => ({ threadRef: this._remember(root, repo, number, thread.id),
          path: S.text(thread.path, 1000), line: thread.line, subjectType: thread.subjectType,
          isResolved: thread.isResolved, isOutdated: thread.isOutdated, commentCount: thread.totalCount })) };
    } catch (cause) { return S.error(cause); }
  }
  async _read(repo, reference, context = {}) {
    const result = await this.github.getReviewThread(this._args(repo, { threadId: reference.threadId, signal: context.signal }));
    this._current(context);
    if (!result?.ok) throw S.fail(result?.code);
    if (result.thread?.id !== reference.threadId) throw S.fail('PR_REVIEW_NOT_FOUND');
    const pr = this._prData(repo, result.thread.pullRequest, reference.prNumber);
    return { repo, pr, raw: result.thread, thread: S.normalizeThread(result.thread, true) };
  }
  async _location(root, loaded, context) {
    const { repo, pr, thread } = loaded;
    if (!thread.complete) return 'PR_REVIEW_INCOMPLETE';
    if (thread.isResolved || thread.isOutdated || !thread.comments.some((c) => c.state === 'SUBMITTED')) return 'PR_REVIEW_NOT_REPAIRABLE';
    if (!S.validPath(thread.path)) return 'PR_REVIEW_LOCATION_UNAVAILABLE';
    const relative = path.relative(repo.repoRoot, root).replace(/\\/g, '/');
    const scopedPath = process.platform === 'win32' ? thread.path.toLowerCase() : thread.path;
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
      || (relative && !scopedPath.startsWith(`${relative}/`))) return 'PR_REVIEW_LOCATION_UNAVAILABLE';
    if (thread.subjectType !== 'FILE' && (thread.diffSide !== 'RIGHT' || !thread.line
      || (thread.startLine && (thread.startDiffSide !== 'RIGHT' || thread.startLine > thread.line)))) return 'PR_REVIEW_LOCATION_UNAVAILABLE';
    const file = await this.github.getReviewFile(this._args(repo, { headSha: pr.headSha, path: thread.path, signal: context.signal }));
    this._current(context);
    if (!file?.ok || (thread.subjectType === 'LINE' && thread.line > file.lineCount)) return 'PR_REVIEW_LOCATION_UNAVAILABLE';
    return null;
  }
  async _load(root, threadRef, context = {}, locate = true) {
    this._current(context);
    const reference = this.refs.get(threadRef);
    if (!S.THREAD_REF_RE.test(threadRef) || !reference || reference.projectKey !== projectKey(root)) throw S.fail('PR_REVIEW_NOT_FOUND');
    const repo = await this._repository(root, context);
    if (repo.repoKey !== reference.repoKey) throw S.fail('PR_REVIEW_CHANGED');
    let loaded = await this._read(repo, reference, context);
    const reasonCode = locate ? await this._location(root, loaded, context) : null;
    if (locate) {
      const second = await this._read(repo, reference, context);
      if (second.thread.fingerprint !== loaded.thread.fingerprint || S.hash(second.pr) !== S.hash(loaded.pr)) throw S.fail('PR_REVIEW_CHANGED');
      loaded = second;
    }
    const currentRepo = await this._repository(root, context);
    this._current(context);
    if (currentRepo.repoKey !== repo.repoKey) throw S.fail('PR_REVIEW_CHANGED');
    return { ...loaded, threadRef, reasonCode,
      revision: S.hash([repo.repoKey, loaded.pr, loaded.thread.fingerprint, loaded.thread.viewerCanReply, loaded.thread.viewerCanResolve]) };
  }
  _public(loaded) {
    const { thread, pr, threadRef, revision, reasonCode } = loaded;
    return { threadRef, revision, prNumber: pr.number, headSha: pr.headSha,
      path: S.text(thread.path, 1000), line: thread.line, startLine: thread.startLine,
      subjectType: thread.subjectType, diffSide: thread.diffSide,
      isResolved: thread.isResolved, isOutdated: thread.isOutdated, complete: thread.complete,
      canRepair: !reasonCode && thread.complete && !thread.isResolved && !thread.isOutdated,
      canReply: thread.complete && thread.viewerCanReply, canResolve: thread.complete && !thread.isResolved && thread.viewerCanResolve,
      reasonCode, comments: thread.comments.filter((c) => c.state === 'SUBMITTED').map((c) => ({
        author: c.author, body: S.text(c.body, 256 * 1024), createdAt: c.createdAt, updatedAt: c.updatedAt,
      })) };
  }
  async get(projectPath, threadRef, context = {}) {
    try { return { ok: true, thread: this._public(await this._load(this._root(projectPath), threadRef, context)) }; }
    catch (cause) { return S.error(cause); }
  }
  async snapshot(projectPath, threadRef, revision, context = {}) {
    try {
      if (!S.REVISION_RE.test(revision)) throw S.fail();
      const root = this._root(projectPath);
      const loaded = await this._load(root, threadRef, context);
      if (loaded.revision !== revision) throw S.fail('PR_REVIEW_CHANGED');
      if (loaded.reasonCode) throw S.fail(loaded.reasonCode);
      const item = this.store.put({ reviewRef: S.ref('prv'), projectKey: projectKey(root), repoKey: loaded.repo.repoKey,
        prNumber: loaded.pr.number, headSha: loaded.pr.headSha, headRefName: loaded.pr.headRefName,
        threadId: loaded.thread.id, threadFingerprint: loaded.thread.fingerprint,
        path: loaded.thread.path, line: loaded.thread.line, subjectType: loaded.thread.subjectType,
        createdAt: new Date(this.now()).toISOString() });
      return { ok: true, reviewRef: item.reviewRef, source: S.publicSource(item), persistence: this.store.persistenceStatus() };
    } catch (cause) { return S.error(cause); }
  }
  async source(projectPath, reviewRef, context = {}) {
    try {
      const root = this._root(projectPath);
      const item = this.store.get(reviewRef, projectKey(root));
      if (!item) throw S.fail('PR_REVIEW_NOT_FOUND');
      const repo = await this._repository(root, context); this._current(context);
      if (repo.repoKey !== item.repoKey) throw S.fail('PR_REVIEW_CHANGED');
      return { ok: true, source: S.publicSource(item), threadRef: this._remember(root, repo, item.prNumber, item.threadId) };
    } catch (cause) { return S.error(cause); }
  }
  async resolveMetadata(projectPath, reviewRef, context = {}) {
    const root = this._root(projectPath);
    const item = this.store.get(reviewRef, projectKey(root));
    if (!item) throw S.fail('PR_REVIEW_NOT_FOUND');
    const repo = await this._repository(root, context);
    if (repo.repoKey !== item.repoKey) throw S.fail('PR_REVIEW_CHANGED');
    const threadRef = this._remember(root, repo, item.prNumber, item.threadId);
    const loaded = await this._load(root, threadRef, context);
    if (loaded.pr.headSha !== item.headSha || loaded.pr.headRefName !== item.headRefName || loaded.thread.fingerprint !== item.threadFingerprint) throw S.fail('PR_REVIEW_CHANGED');
    if (loaded.reasonCode) throw S.fail(loaded.reasonCode);
    return { ...loaded, snapshot: item, source: { kind: 'pr_review', reviewRef },
      sourceFingerprint: S.sourceFingerprint(item), baseHead: item.headSha,
      sourceLabel: `PR #${item.prNumber} · ${S.text(item.path, 1000)}${item.line ? `:${item.line}` : '（文件）'}`,
      approvalLabel: `处理 PR #${item.prNumber} 的审查反馈（隔离修复）` };
  }
  async materializeRepairSource(projectPath, reviewRef, context = {}) {
    const resolved = await this.resolveMetadata(projectPath, reviewRef, context);
    const reviewText = [`PR head: ${resolved.baseHead}`,
      `当前位置: ${resolved.thread.subjectType === 'FILE' ? '文件' : `RIGHT ${resolved.thread.startLine || resolved.thread.line}-${resolved.thread.line}`}`,
      ...resolved.thread.comments.filter((c) => c.state === 'SUBMITTED')
        .map((c) => `${c.author} · ${c.updatedAt}\n${S.text(c.body, 256 * 1024)}`)].join('\n\n');
    if (Buffer.byteLength(reviewText, 'utf8') > 32 * 1024) throw S.fail('PR_REVIEW_CONTEXT_TOO_LARGE');
    return { source: resolved.source, sourceFingerprint: resolved.sourceFingerprint, baseHead: resolved.baseHead,
      sourceLabel: resolved.sourceLabel, approvalLabel: resolved.approvalLabel, reviewText,
      result: { diagnostics: [], stdout: '', stderr: '' },
      ...(context.validationProfile ? { validationProfile: context.validationProfile } : {}),
      createWorktree: (args) => createRemoteWorktree(this, reviewRef, args, context) };
  }
  async _exclusive(key, action) {
    if (this.pendingMutations.has(key)) return S.error(S.fail('PR_REVIEW_BUSY'));
    this.pendingMutations.add(key);
    try { return await action(); } finally { this.pendingMutations.delete(key); }
  }
  async _operate(projectPath, action, payload, context = {}) {
    const root = this._root(projectPath);
    return this._exclusive(`${root}:${payload.threadRef}`, async () => {
      let sent = false; let attempt;
      try {
        if (!S.REVISION_RE.test(payload.revision)) throw S.fail();
        if (action === 'reply' && (typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > S.MAX_REPLY || payload.body.includes('\0'))) throw S.fail();
        const initial = await this._load(root, payload.threadRef, context, false);
        if (initial.revision !== payload.revision) throw S.fail('PR_REVIEW_CHANGED');
        const check = (loaded) => {
          if (!loaded.thread.complete) throw S.fail('PR_REVIEW_INCOMPLETE');
          if (action === 'reply' ? !loaded.thread.viewerCanReply : loaded.thread.isResolved || !loaded.thread.viewerCanResolve) throw S.fail('PR_REVIEW_PERMISSION_DENIED');
        };
        check(initial);
        attempt = S.hash([initial.repo.repoKey, initial.pr.number, initial.thread.id, action, payload.body || '']);
        if (this.uncertain.has(attempt)) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
        const gate = context.permissionGate || context.gate;
        if (!gate?.authorize) throw S.fail('PR_REVIEW_CONFIRM_REQUIRED');
        const decision = await gate.authorize({ tool: `pr_review_${action}`, risk: 'remote-mutation', source: 'pr-review',
          summary: `${action === 'reply' ? '回复' : '解决'} PR #${initial.pr.number} 审查线程`,
          detail: `${S.text(initial.thread.path)}\n${action === 'reply' ? payload.body : '将此线程标记为已解决；不会更改 PR 的审核结论。'}`,
          signal: context.signal });
        this._current(context);
        if (!decision?.allowed) throw S.fail('PR_REVIEW_CONFIRM_REQUIRED');
        const mutate = async () => {
          const fresh = await this._load(root, payload.threadRef, context, false);
          if (fresh.revision !== initial.revision) throw S.fail('PR_REVIEW_CHANGED');
          check(fresh); this._current(context);
          sent = true;
          const args = this._args(fresh.repo, { threadId: fresh.thread.id, body: payload.body, signal: context.signal });
          const response = action === 'reply' ? await this.github.replyReviewThread(args) : await this.github.resolveReviewThread(args);
          if (!response?.ok) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
          const after = await this._load(root, payload.threadRef, context, false);
          if (!after.thread.complete || S.hash(after.pr) !== S.hash(fresh.pr)) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
          let adjusted = after.raw;
          if (action === 'reply') {
            const added = after.thread.comments.find((c) => c.id === response.commentId);
            if (!added || added.body !== payload.body || added.state !== 'SUBMITTED' || fresh.thread.comments.some((c) => c.id === added.id)) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
            adjusted = { ...after.raw, comments: { ...after.raw.comments, totalCount: after.raw.comments.totalCount - 1,
              nodes: after.raw.comments.nodes.filter((c) => c.id !== added.id) } };
          } else {
            if (!after.thread.isResolved) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
            adjusted = { ...after.raw, isResolved: false };
          }
          if (S.normalizeThread(adjusted, true).fingerprint !== fresh.thread.fingerprint) throw S.fail('PR_REVIEW_ACTION_UNCERTAIN');
          return { ok: true, action };
        };
        return await (this.mutationLock ? this.mutationLock(mutate) : mutate());
      } catch (cause) {
        if (sent) {
          if (this.uncertain.size >= 1000) this.uncertain.delete(this.uncertain.values().next().value);
          if (attempt) this.uncertain.add(attempt);
          return S.error(S.fail('PR_REVIEW_ACTION_UNCERTAIN'));
        }
        return S.error(cause);
      }
    });
  }
  reply(projectPath, payload, context) { return this._operate(projectPath, 'reply', payload, context); }
  resolve(projectPath, payload, context) { return this._operate(projectPath, 'resolve', payload, context); }
  updatePr(projectPath, resultId, subject, context) { return updatePr(this, projectPath, resultId, subject, context); }
  close() { this.closing = true; this.refs.clear(); this.store.close(); }
}
module.exports = { PrReviewManager, createPrReviewManager: (options) => new PrReviewManager(options) };
