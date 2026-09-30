'use strict';
const path = require('node:path');
const { canonicalProjectPath, projectKey } = require('./project-index');
const { createGithubCli } = require('./github-cli');
const { createPrAuditStore } = require('./pr-audit-store');
const { AuditSnapshot, cleanupAuditRefs } = require('./pr-audit-snapshot');
const { runAudit } = require('./pr-audit-runtime');
const S = require('./pr-audit-state');

class PrAuditManager {
  constructor(options = {}) {
    this.github = options.githubCli || createGithubCli(); this.store = options.store || createPrAuditStore(options);
    this.runtime = options.runtime || runAudit; this.snapshotFactory = options.snapshotFactory || ((args) => new AuditSnapshot(args));
    this.getSettings = options.getSettings || (() => ({})); this.mutationLock = options.mutationLock;
    this.onEvent = options.onEvent; this.now = options.now || Date.now; this.timeoutMs = options.timeoutMs || S.LIMITS.timeout;
    this.runs = new Map(); this.drafts = new Map(); this.pending = new Set(); this.cleaned = new Map(); this.closing = false;
  }
  current(context) { if (this.closing) throw S.fail('CANCELLED'); S.assertCurrent(context); }
  row(root, auditRef) {
    if (!S.isRef(auditRef)) throw S.fail();
    const row = this.store.get(auditRef, projectKey(canonicalProjectPath(root)));
    if (!row) throw S.fail('NOT_FOUND'); return row;
  }
  save(row, options) {
    const saved = this.store.put(row, options);
    try { this.onEvent?.({ type: 'engineering:pr-audit:event', auditRef: saved.auditRef, projectKey: saved.projectKey,
      prNumber: saved.prNumber, status: saved.status, publicationStatus: saved.publication?.status, stale: saved.stale, turn: saved.turns || 0 }); } catch {}
    return saved;
  }
  async repository(root, context = {}) {
    this.current(context);
    const resolved = await this.github.getCiWatchRepository({ projectPath: root, signal: context.signal, timeoutMs: 15000 });
    this.current(context);
    if (!resolved?.ok || !resolved.repository) throw S.fail('UNAVAILABLE');
    const repo = resolved.repository; const repoRoot = canonicalProjectPath(repo.repoRoot);
    const prefix = path.relative(repoRoot, root).replace(/\\/g, '/');
    if (prefix === '..' || prefix.startsWith('../') || path.isAbsolute(prefix) || !S.digest(repo.repoKey)) throw S.fail('BINDING');
    if (!this.cleaned.has(repoRoot)) {
      this.cleaned.set(repoRoot, cleanupAuditRefs(this.github, repoRoot, new Set([...this.runs.values()].map((r) => r.auditRef))).catch(() => {}));
    }
    await this.cleaned.get(repoRoot); this.current(context);
    return { ...repo, repoRoot, prefix };
  }
  args(repo, context, extra = {}) { return { ...repo, signal: context?.signal, ...extra }; }
  async source(root, prNumber, context) {
    const repo = await this.repository(root, context);
    const pr = S.normalizePr(await this.github.getAuditPr(this.args(repo, context, { number: prNumber })), repo);
    this.current(context);
    if (pr.prNumber !== prNumber) throw S.fail('INCOMPLETE');
    return { repo, source: { ...pr, repoKey: repo.repoKey, prefix: repo.prefix } };
  }
  async fresh(root, expected, context) {
    const fresh = await this.source(root, expected.prNumber, context);
    if (S.sourceKey(fresh.source) !== S.sourceKey(expected)) throw S.fail('CHANGED'); return fresh;
  }
  async capture(root, prNumber, auditRef, context, expected, refNamespace = 'pr-audit') {
    const { repo, source } = await this.source(root, prNumber, context);
    if (expected && S.sourceKey(expected) !== S.sourceKey(source)) throw S.fail('CHANGED');
    if (source.changedFiles > S.LIMITS.remoteFiles) throw S.fail('LIMIT');
    const files = await this.github.getAuditFiles(this.args(repo, context, { number: prNumber }));
    source.mergeBaseSha = await this.github.getAuditMergeBase(this.args(repo, context, source));
    if (expected && expected.mergeBaseSha !== source.mergeBaseSha) throw S.fail('CHANGED');
    this.current(context);
    const snapshot = this.snapshotFactory({ github: this.github, repo, source, auditRef, files, signal: context.signal, refNamespace });
    try { await snapshot.init(); await this.fresh(root, source, context); return snapshot; }
    catch (cause) { await snapshot.cleanup(); throw cause; }
  }
  async start(projectPath, prNumber, note = '', context = {}) {
    try {
      const root = canonicalProjectPath(projectPath); const key = projectKey(root); this.current(context);
      if (!root || !S.number(prNumber)) throw S.fail(); S.text(note, 2000, true);
      const settings = { ...this.getSettings() };
      if (settings.mode !== 'api' || settings.agentEnabled === false || !settings.apiKey || !settings.model) throw S.fail('MODEL_REQUIRED');
      if ([...this.runs.values()].some((r) => r.key === key) || this.runs.size >= 2) throw S.fail('BUSY');
      const row = this.save({ auditRef: S.ref(), projectKey: key, prNumber, createdAt: new Date(this.now()).toISOString(),
        status: 'preparing', stale: false, model: String(settings.model).slice(0, 200) });
      const controller = new AbortController(); const abort = () => controller.abort(context.signal?.reason);
      context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
      const record = { key, root, auditRef: row.auditRef, controller }; this.runs.set(row.auditRef, record);
      context.retainUntilFinished?.();
      const timer = setTimeout(() => controller.abort(S.fail('TIMEOUT')), this.timeoutMs);
      timer.unref?.();
      record.done = Promise.resolve().then(async () => {
        let snapshot;
        const ctx = { ...context, signal: controller.signal };
        try {
          snapshot = await this.capture(root, prNumber, row.auditRef, ctx);
          let current = this.save({ ...this.row(root, row.auditRef), status: 'running', source: snapshot.source, coverage: snapshot.coverage });
          const generated = await this.runtime({ snapshot, settings, note, signal: controller.signal,
            onProgress: ({ turn }) => { current = this.save({ ...this.row(root, row.auditRef), turns: turn }); } });
          this.current(ctx);
          const report = S.normalizeReport({ summary: generated.report.summary, findings: generated.report.findings.map((f) => ({
            priority: f.priority, title: f.title, body: f.body, path: f.path, side: f.side, line: f.line, startLine: f.startLine,
          })) }, snapshot.files);
          for (const f of report.findings) f.contextPath = f.side === 'LEFT' ? snapshot.files.find((file) => file.path === f.path).oldPath : f.path;
          let stale = false;
          try { await this.fresh(root, current.source, ctx); } catch (cause) { this.current(ctx); stale = true; }
          this.save({ ...this.row(root, row.auditRef), status: 'completed', stale, report, usage: numericUsage(generated.usage),
            finishedAt: new Date(this.now()).toISOString(), turns: generated.turns || current.turns });
        } catch (cause) {
          const stopped = controller.signal.aborted;
          const code = stopped ? (controller.signal.reason?.code === 'PR_AUDIT_TIMEOUT' ? 'PR_AUDIT_TIMEOUT' : 'PR_AUDIT_CANCELLED') : S.error(cause).code;
          this.save({ ...this.row(root, row.auditRef), status: stopped ? (this.closing ? 'interrupted' : 'cancelled') : 'failed',
            errorCode: code, finishedAt: new Date(this.now()).toISOString() });
        } finally {
          clearTimeout(timer);
          try { await snapshot?.cleanup(); } finally {
            this.runs.delete(row.auditRef);
            context.signal?.removeEventListener('abort', abort); context.release?.();
          }
        }
      });
      // Resource cleanup must run even if storage or an injected observer fails.
      record.done.catch(() => {});
      return { ok: true, auditRef: row.auditRef, persistence: this.store.persistenceStatus() };
    } catch (cause) { return S.error(cause); }
  }
  list(root, prNumber) {
    try {
      if (prNumber !== undefined && !S.number(prNumber)) throw S.fail();
      const rows = this.store.list(projectKey(canonicalProjectPath(root))).filter((r) => !prNumber || r.prNumber === prNumber)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { ok: true, projectKey: projectKey(canonicalProjectPath(root)), audits: rows.map((r) => ({ auditRef: r.auditRef, prNumber: r.prNumber, status: r.status, stale: r.stale,
        headSha: r.source?.headSha, createdAt: r.createdAt, findingCount: r.report?.findings.length || 0, publicationStatus: r.publication?.status, errorCode: r.errorCode })),
      persistence: this.store.persistenceStatus() };
    } catch (cause) { return S.error(cause); }
  }
  get(root, auditRef) {
    try { const row = this.row(root, auditRef); return { ok: true, audit: { ...row, revision: S.revision(row), repairRevision: S.repairRevision(row) }, persistence: this.store.persistenceStatus() }; }
    catch (cause) { return S.error(cause); }
  }
  cancel(root, auditRef) {
    try { this.row(root, auditRef); this.runs.get(auditRef)?.controller.abort(); return { ok: true }; } catch (cause) { return S.error(cause); }
  }
  async context(root, auditRef, findingId, context = {}) {
    try {
      const row = this.row(root, auditRef); const f = row.report?.findings.find((f) => f.findingId === findingId);
      if (!f || !S.isRef(findingId, 'paf')) throw S.fail('NOT_FOUND');
      const repo = await this.repository(root, context);
      if (repo.repoKey !== row.source.repoKey || repo.prefix !== row.source.prefix) throw S.fail('CHANGED');
      const snapshot = this.snapshotFactory({ github: this.github, repo, source: row.source, auditRef, files: [], signal: context.signal });
      const snippet = await snapshot.read({ path: f.contextPath || f.path, side: f.side, offset: Math.max(1, f.startLine - 8), limit: Math.min(60, f.line - f.startLine + 17) }, false);
      this.current(context); return { ok: true, snippet };
    } catch (cause) { return S.error(cause); }
  }
  eligible(row) {
    if (row.status !== 'completed' || !row.source || !row.report) throw S.fail('INCOMPLETE');
    if (row.publication?.status === 'published') throw S.fail('PUBLISHED');
    if (['uncertain', 'publishing'].includes(row.publication?.status)) throw S.fail('UNCERTAIN');
  }
  async prepare(root, payload, context = {}) {
    let snapshot; let ownsPending = false;
    try {
      const row = this.row(root, payload.auditRef); this.eligible(row);
      if (payload.revision !== S.revision(row)) throw S.fail('CHANGED');
      S.text(payload.summary, S.LIMITS.body);
      if (!Array.isArray(payload.selections) || payload.selections.length > S.LIMITS.findings) throw S.fail();
      if (this.pending.has(row.auditRef) || this.runs.has(row.auditRef)) throw S.fail('BUSY');
      this.pending.add(row.auditRef); ownsPending = true;
      // A separate temporary namespace prevents concurrent context/prepare cleanup collisions.
      snapshot = await this.capture(root, row.prNumber, S.ref(), context, row.source);
      const selected = new Set(); const comments = payload.selections.map((selection) => {
        S.keys(selection, ['findingId', 'title', 'body']);
        const finding = row.report.findings.find((f) => f.findingId === selection.findingId);
        if (!finding || selected.has(finding.findingId) || !S.validLocation(finding, snapshot.files)) throw S.fail('LOCATION');
        selected.add(finding.findingId); S.text(selection.title, 200); S.text(selection.body, S.LIMITS.body);
        const body = `[${finding.priority}] ${selection.title}\n\n${selection.body}`.replace(/\r\n/g, '\n'); S.text(body, S.LIMITS.body);
        return { path: finding.path, side: finding.side, line: finding.line, body,
          ...(finding.startLine !== finding.line ? { start_line: finding.startLine, start_side: finding.side } : {}) };
      });
      const publicationRef = S.ref('pap');
      const coverage = row.coverage;
      const summary = `AI 辅助代码审查\n\n${payload.summary}\n\n审查提交：${row.source.headSha}\n覆盖 ${coverage.reviewed}/${coverage.total} 个变更文件；项目范围外 ${coverage.outside} 个，跳过 ${coverage.skipped.length} 个。仅进行静态阅读，未运行验证。`;
      const body = `${summary}\n\n<!-- codex-qq-pr-audit:${publicationRef} -->`.replace(/\r\n/g, '\n'); S.text(body, S.LIMITS.body);
      const request = { event: 'COMMENT', commit_id: row.source.headSha, body, comments };
      if (Buffer.byteLength(JSON.stringify(request)) > S.LIMITS.report) throw S.fail('LIMIT');
      this.current(context);
      if (S.revision(this.row(root, row.auditRef)) !== payload.revision) throw S.fail('CHANGED');
      for (const [id, draft] of this.drafts) if (draft.auditRef === row.auditRef || this.now() - draft.createdAt > 15 * 60000) this.drafts.delete(id);
      while (this.drafts.size >= 200) this.drafts.delete(this.drafts.keys().next().value);
      const draftRef = S.ref('pad');
      const preview = [summary, ...comments.map((c) => `${c.path} · ${c.side} ${c.start_line || c.line}–${c.line}\n${c.body}`)].join('\n\n');
      this.drafts.set(draftRef, { draftRef, publicationRef, auditRef: row.auditRef, projectKey: row.projectKey, revision: payload.revision,
        payload: request, preview, createdAt: this.now(), used: false, bindingId: context.projectBindingId, ownerId: context.ownerId });
      return { ok: true, draftRef, preview, commentCount: comments.length, headSha: row.source.headSha };
    } catch (cause) {
      if (cause.code === 'PR_AUDIT_CHANGED') { try { this.save({ ...this.row(root, payload.auditRef), stale: true }); } catch {} }
      return S.error(cause);
    } finally { try { await snapshot?.cleanup(); } finally { if (ownsPending) this.pending.delete(payload.auditRef); } }
  }
  async publish(root, draftRef, context = {}) {
    let draft; let intent; let sent = false; let ownsPending = false;
    try {
      draft = this.drafts.get(draftRef);
      if (!S.isRef(draftRef, 'pad') || !draft || draft.projectKey !== projectKey(canonicalProjectPath(root)) || draft.used
        || draft.bindingId !== context.projectBindingId || draft.ownerId !== context.ownerId
        || this.now() - draft.createdAt > 15 * 60000) throw S.fail();
      draft.used = true;
      if (this.pending.has(draft.auditRef)) throw S.fail('BUSY'); this.pending.add(draft.auditRef); ownsPending = true;
      const row = this.row(root, draft.auditRef); this.eligible(row);
      if (S.revision(row) !== draft.revision) throw S.fail('CHANGED');
      await this.fresh(root, row.source, context);
      const gate = context.permissionGate;
      if (!gate) throw S.fail('CONFIRM_REQUIRED');
      const approval = await gate.authorize({ tool: 'pr_audit_publish', risk: 'remote-mutation', source: 'pr-audit',
        summary: `向 PR #${row.prNumber} 发布 COMMENT Review（${draft.payload.comments.length} 条行内意见）`,
        detail: draft.preview, signal: context.signal });
      if (!approval?.allowed) throw S.fail('CONFIRM_REQUIRED');
      const perform = async () => {
        this.current(context); this.eligible(this.row(root, draft.auditRef));
        if (S.revision(this.row(root, draft.auditRef)) !== draft.revision) throw S.fail('CHANGED');
        let current = await this.fresh(root, row.source, context);
        const actor = await this.github.getAuditViewer(this.args(current.repo, context));
        if (!S.remoteId(actor?.id)) throw S.fail('UNAVAILABLE');
        current = await this.fresh(root, row.source, context);
        intent = { status: 'publishing', publicationRef: draft.publicationRef, actorId: actor.id, commitId: row.source.headSha,
          ...S.publicationHashes(draft.payload), createdAt: new Date(this.now()).toISOString() };
        this.save({ ...this.row(root, row.auditRef), publication: intent }, { intent: true });
        this.current(context); sent = true;
        const response = await this.github.createAuditReview(this.args(current.repo, context, { number: row.prNumber, payload: draft.payload }));
        if (!S.remoteId(response?.id)) throw S.fail('UNCERTAIN');
        intent.reviewId = response.id;
        this.save({ ...this.row(root, row.auditRef), publication: intent });
        return this.confirm(root, row.auditRef, current.repo, context);
      };
      const result = this.mutationLock ? await this.mutationLock(perform) : await perform();
      if (result?.code === 'BUSY') throw S.fail('BUSY'); return result;
    } catch (cause) {
      if (intent && draft) {
        const status = sent && cause.code !== 'PR_AUDIT_PUBLISH_FAILED' ? 'uncertain' : 'failed';
        this.save({ ...this.row(root, draft.auditRef), publication: { ...intent, status, errorCode: S.error(cause).code } });
        return S.error(S.fail(status === 'uncertain' ? 'UNCERTAIN' : 'PUBLISH_FAILED'));
      }
      if (draft && cause.code === 'PR_AUDIT_CHANGED') this.save({ ...this.row(root, draft.auditRef), stale: true });
      return S.error(cause);
    } finally { if (ownsPending) { this.pending.delete(draft.auditRef); this.drafts.delete(draftRef); } }
  }
  async confirm(root, auditRef, repo, context) {
    const row = this.row(root, auditRef); const intent = row.publication;
    let review;
    if (intent.reviewId) review = await this.github.getAuditReview(this.args(repo, context, { number: row.prNumber, reviewId: intent.reviewId }));
    else {
      const rows = await this.github.listAuditReviews(this.args(repo, context, { number: row.prNumber }));
      const marker = `<!-- codex-qq-pr-audit:${intent.publicationRef} -->`;
      const matches = rows.filter((r) => r.user?.id === intent.actorId && typeof r.body === 'string' && r.body.includes(marker));
      if (matches.length !== 1) throw S.fail('UNCERTAIN'); review = matches[0];
    }
    if (!S.remoteId(review?.id) || (intent.reviewId && review.id !== intent.reviewId) || review.user?.id !== intent.actorId
      || review.state !== 'COMMENTED' || review.commit_id !== intent.commitId || !review.submitted_at || S.hash(review.body) !== intent.bodyHash) throw S.fail('UNCERTAIN');
    const comments = await this.github.getAuditComments(this.args(repo, context, { number: row.prNumber, reviewId: review.id }));
    if (!Array.isArray(comments) || comments.length !== intent.comments.length) throw S.fail('UNCERTAIN');
    const seen = new Set();
    const actual = comments.map((c) => {
      if (!S.remoteId(c.id) || seen.has(c.id) || c.user?.id !== intent.actorId || c.pull_request_review_id !== review.id
        || (c.original_commit_id || c.commit_id) !== intent.commitId
        || (c.start_side != null && c.start_side !== c.side)) throw S.fail('UNCERTAIN'); seen.add(c.id);
      return { path: c.path, side: c.side, line: c.original_line ?? c.line, startLine: c.original_start_line ?? c.start_line ?? c.original_line ?? c.line, bodyHash: S.hash(c.body) };
    });
    if (S.hash(actual.map(S.hash).sort()) !== S.hash(intent.comments.map(S.hash).sort())) throw S.fail('UNCERTAIN');
    this.current(context);
    let stale = false;
    try { await this.fresh(root, row.source, context); } catch { stale = true; }
    this.save({ ...this.row(root, auditRef), stale, publication: { ...intent, status: 'published', reviewId: review.id, confirmedAt: new Date(this.now()).toISOString() } });
    return { ok: true, auditRef, published: true, stale };
  }
  async reconcile(root, auditRef, context = {}) {
    try {
      const row = this.row(root, auditRef);
      if (row.publication?.status === 'published') return { ok: true, auditRef, published: true, stale: row.stale };
      if (row.publication?.status !== 'uncertain') throw S.fail();
      const repo = await this.repository(root, context);
      if (repo.repoKey !== row.source.repoKey || repo.prefix !== row.source.prefix) throw S.fail('CHANGED');
      return await this.confirm(root, auditRef, repo, context);
    } catch (cause) { return S.error(cause.code === 'PR_AUDIT_BINDING' ? cause : S.fail('UNCERTAIN')); }
  }
  forgetDrafts(ownerId, key) {
    for (const [id, draft] of this.drafts) if (draft.ownerId === ownerId && (!key || draft.projectKey === key)) this.drafts.delete(id);
  }
  close() {
    this.closing = true;
    for (const record of this.runs.values()) {
      record.controller.abort();
      const row = this.store.get(record.auditRef, record.key);
      if (row && S.ACTIVE.has(row.status)) this.store.put({ ...row, status: 'interrupted' });
    }
    this.drafts.clear(); this.store.close();
  }
}
function numericUsage(value = {}) {
  const bounded = (n) => Number.isFinite(n) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n))) : 0;
  return { inputTokens: bounded(value.inputTokens), outputTokens: bounded(value.outputTokens), estimated: !!value.estimated };
}
module.exports = { PrAuditManager, createPrAuditManager: (options) => new PrAuditManager(options) };
