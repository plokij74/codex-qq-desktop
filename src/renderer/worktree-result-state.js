'use strict';

(function expose(factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'WorktreeResultState', { value: api, configurable: false });
}(function createState() {
  const ID_RE = /^wt_[A-Za-z0-9]{6,80}$/;
  const STATES = new Set([
    'creating', 'running', 'collecting', 'ready', 'collect_failed', 'oversize',
    'conflict', 'applying', 'apply_uncertain', 'applied_cleanup_pending',
    'discarded_cleanup_pending', 'pr_preparing', 'pr_committing', 'pr_pushing',
    'pr_creating', 'pr_failed', 'pr_cleanup_pending', 'pr_created',
  ]);
  const MAX_GOAL = 160;
  const MAX_FILES = 200;

  function trim(value, max) {
    const text = String(value ?? '').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function normalizeOne(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!ID_RE.test(id) || !STATES.has(String(raw.state || ''))) return null;
    const files = [];
    for (const item of Array.isArray(raw.files) ? raw.files : []) {
      if (!item || typeof item !== 'object') continue;
      const path = String(item.path || '').replace(/\\/g, '/');
      if (!path || path.startsWith('/') || /(^|\/)\.\.(?:\/|$)/.test(path)) continue;
      files.push({ path, status: String(item.status || 'M').slice(0, 1), binary: item.binary === true });
      if (files.length >= MAX_FILES) break;
    }
    const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const n = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number))) : 0;
    };
    const createdAt = n(raw.createdAt);
    const updatedAt = n(raw.updatedAt) || createdAt;
    const rawPr = raw.pr && typeof raw.pr === 'object' ? raw.pr : {};
    return {
      id,
      projectId: String(raw.projectId || ''),
      sessionId: String(raw.sessionId || ''),
      subagentId: trim(raw.subagentId, 120),
      goal: trim(raw.goal, MAX_GOAL),
      state: String(raw.state),
      createdAt,
      updatedAt,
      baseHead: /^[a-f0-9]{40}$/i.test(String(raw.baseHead || '')) ? String(raw.baseHead).toLowerCase() : '',
      incomplete: raw.incomplete === true,
      files,
      filesTruncated: raw.filesTruncated === true || (Array.isArray(raw.files) && raw.files.length > MAX_FILES),
      stats: {
        files: n(stats.files) || files.length,
        additions: n(stats.additions),
        deletions: n(stats.deletions),
        binaryFiles: n(stats.binaryFiles),
      },
      errorCode: raw.errorCode ? trim(raw.errorCode, 80) : null,
      error: raw.error ? trim(raw.error, 300) : null,
      pr: {
        host: trim(rawPr.host, 255),
        owner: trim(rawPr.owner, 255),
        repo: trim(rawPr.repo, 255),
        base: trim(rawPr.base, 255),
        head: trim(rawPr.head, 255),
        commit: /^[a-f0-9]{40}$/i.test(String(rawPr.commit || '')) ? String(rawPr.commit).toLowerCase() : '',
        url: /^https?:\/\//i.test(String(rawPr.url || '')) ? trim(rawPr.url, 2000) : '',
        number: n(rawPr.number),
        draft: rawPr.draft !== false,
        title: trim(rawPr.title, 300),
        pushed: rawPr.pushed === true,
        state: ['OPEN', 'CLOSED', 'MERGED'].includes(String(rawPr.state || '').toUpperCase()) ? String(rawPr.state).toUpperCase() : '',
        headSha: /^[a-f0-9]{40}$/i.test(String(rawPr.headSha || '')) ? String(rawPr.headSha).toLowerCase() : '',
        mergeable: trim(rawPr.mergeable, 40).toUpperCase(),
        mergeStateStatus: trim(rawPr.mergeStateStatus, 60).toUpperCase(),
        updatedAt: trim(rawPr.updatedAt, 80),
        checksSummary: {
          total: n(rawPr.checksSummary?.total),
          passed: n(rawPr.checksSummary?.passed),
          pending: n(rawPr.checksSummary?.pending),
          failed: n(rawPr.checksSummary?.failed),
          skipped: n(rawPr.checksSummary?.skipped),
          unknown: n(rawPr.checksSummary?.unknown),
        },
      },
      prDraftTitle: trim(raw.prDraftTitle, 300),
      prDraftBody: trim(raw.prDraftBody, 10000),
      canApply: raw.canApply === true,
      canDiscard: raw.canDiscard === true,
      canRetryCollect: raw.canRetryCollect === true,
      canCleanup: raw.canCleanup === true,
      canOpen: raw.canOpen === true,
      canPreview: raw.canPreview === true,
      canCreatePr: raw.canCreatePr === true,
      canRetryPr: raw.canRetryPr === true,
      canCleanupPr: raw.canCleanupPr === true,
      canOpenPr: raw.canOpenPr === true,
    };
  }

  function normalizeList(raw) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      const normalized = normalizeOne(item);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      out.push(normalized);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  function merge(existing, incoming) {
    const byId = new Map(normalizeList(existing).map((item) => [item.id, item]));
    for (const item of normalizeList(incoming)) {
      const current = byId.get(item.id);
      if (!current || item.updatedAt >= current.updatedAt) byId.set(item.id, item);
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  function upsert(existing, incoming) {
    return merge(existing, [incoming]);
  }

  // The disk list is authoritative for one project: remove vanished refs and
  // accept its current state even when a local clock made updatedAt appear older.
  function replaceAuthoritative(existing, incoming, projectId) {
    const scope = String(projectId || '');
    const normalizedExisting = normalizeList(existing);
    const drafts = new Map(normalizedExisting.map((item) => [item.id, {
      prDraftTitle: item.prDraftTitle,
      prDraftBody: item.prDraftBody,
    }]));
    const current = normalizedExisting.filter((item) => item.projectId !== scope);
    const authoritative = normalizeList((Array.isArray(incoming) ? incoming : [])
      .map((item) => ({ ...item, ...drafts.get(String(item?.id || '')), projectId: scope })));
    return normalizeList([...current, ...authoritative]);
  }

  function remove(existing, id) {
    const wanted = String(id || '');
    return normalizeList(existing).filter((item) => item.id !== wanted);
  }

  function unresolved(items) {
    return normalizeList(items).filter((item) => !['applied_cleanup_pending', 'discarded_cleanup_pending', 'pr_created'].includes(item.state));
  }

  return { ID_RE, normalizeOne, normalizeList, merge, upsert, replaceAuthoritative, remove, unresolved };
}));
