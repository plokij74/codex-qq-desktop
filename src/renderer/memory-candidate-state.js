'use strict';

(function expose(factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'MemoryCandidateState', { value: api, configurable: false });
}(function createMemoryCandidateState() {
  const PENDING_MAX = 20;
  const PER_BATCH_MAX = 5;
  const TEXT_MAX = 1000;
  const EVIDENCE_MAX = 240;

  function textKey(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function candidateKey(candidate) {
    const text = textKey(candidate?.text);
    const scope = candidate?.scope === 'project' || candidate?.scope === 'user'
      ? candidate.scope
      : '';
    return text && scope ? scope + '\0' + text : '';
  }

  function normalizeTags(raw) {
    const out = [];
    for (const value of Array.isArray(raw) ? raw : []) {
      const tag = String(value ?? '').trim().toLowerCase().slice(0, 24);
      if (tag && !out.includes(tag)) out.push(tag);
      if (out.length >= 8) break;
    }
    return out;
  }

  function trimTo(value, max) {
    const text = String(value ?? '').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function cleanPath(value) {
    const normalized = String(value ?? '').trim().replace(/\\/g, '/');
    return /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, '');
  }

  function normalizeProjectRef(value) {
    const id = String(value?.id ?? '').trim();
    const path = cleanPath(value?.path);
    const absolute = /^(?:[A-Za-z]:\/|\/)/.test(path);
    return id && absolute ? { id, path } : null;
  }

  function projectRefMatches(a, b) {
    const left = normalizeProjectRef(a);
    const right = normalizeProjectRef(b);
    return Boolean(
      left && right
      && left.id === right.id
      && left.path.toLowerCase() === right.path.toLowerCase()
    );
  }

  function makeId() {
    return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizeOne(raw, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const text = trimTo(raw.text, TEXT_MAX);
    const evidence = trimTo(raw.evidence, EVIDENCE_MAX);
    if ((!text && options.allowEmptyText !== true) || !evidence) return null;
    const scope = raw.scope === 'project' || raw.scope === 'user'
      ? raw.scope
      : (options.defaultScope === 'project' ? 'project' : 'user');
    const projectRef = scope === 'project'
      ? normalizeProjectRef(raw.projectRef || options.projectRef)
      : null;
    if (scope === 'project' && !projectRef) return null;
    const idFactory = typeof options.idFactory === 'function' ? options.idFactory : makeId;
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const rawId = String(raw.id || '').trim();
    const id = /^mc_[A-Za-z0-9_-]{1,80}$/.test(rawId) ? rawId : String(idFactory());
    return {
      id,
      text,
      tags: normalizeTags(raw.tags),
      evidence,
      scope,
      projectRef,
      edited: raw.edited === true,
      createdAt: Number(raw.createdAt) || now,
    };
  }

  function normalizePendingCandidates(raw, { max = PENDING_MAX, allowDrafts = true } = {}) {
    const out = [];
    for (const value of Array.isArray(raw) ? raw : []) {
      const item = normalizeOne(value, { allowEmptyText: allowDrafts });
      if (!item) continue;
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  }

  function mergePendingCandidates(existing, incoming, options = {}) {
    const max = Number(options.max) > 0 ? Number(options.max) : PENDING_MAX;
    const items = normalizePendingCandidates(existing, { max, allowDrafts: true });
    const seen = new Set(items.map(candidateKey).filter(Boolean));
    let added = 0;
    let dropped = 0;
    for (const raw of Array.isArray(incoming) ? incoming : []) {
      const item = normalizeOne(raw, { ...options, allowEmptyText: false });
      const key = candidateKey(item);
      if (!item || !key || seen.has(key)) continue;
      if (items.length >= max) { dropped++; continue; }
      seen.add(key);
      items.push(item);
      added++;
    }
    return { items, added, dropped };
  }

  function removePendingCandidates(existing, ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
    return normalizePendingCandidates(existing, { allowDrafts: true }).filter((item) => !wanted.has(item.id));
  }

  function candidateLimit(existing, { perBatch = PER_BATCH_MAX, max = PENDING_MAX } = {}) {
    const count = Array.isArray(existing) ? existing.length : 0;
    return Math.max(0, Math.min(perBatch, max - count));
  }

  function buildAcceptPayload(candidate, currentProjectRef) {
    const item = normalizeOne(candidate);
    if (!item) return { ok: false, error: '候选内容无效' };
    const base = { scope: item.scope, text: item.text, tags: item.tags };
    if (item.scope === 'user') return { ok: true, payload: base };
    if (!projectRefMatches(item.projectRef, currentProjectRef)) {
      return {
        ok: false,
        error: '候选所属项目已变更，请切换为用户记忆或拒绝',
      };
    }
    return {
      ok: true,
      payload: { projectPath: item.projectRef.path, ...base },
    };
  }

  function filterStoredDuplicates(pending, storedEntries, currentProjectRef) {
    const stored = new Set(
      (Array.isArray(storedEntries) ? storedEntries : [])
        .map((entry) => candidateKey(entry))
        .filter(Boolean)
    );
    return normalizePendingCandidates(pending, { allowDrafts: true }).filter(
      (candidate) => candidate.edited
        || (candidate.scope === 'project' && currentProjectRef
          && !projectRefMatches(candidate.projectRef, currentProjectRef))
        || !stored.has(candidateKey(candidate))
    );
  }

  return {
    PENDING_MAX,
    PER_BATCH_MAX,
    textKey,
    candidateKey,
    normalizeProjectRef,
    projectRefMatches,
    normalizePendingCandidates,
    mergePendingCandidates,
    removePendingCandidates,
    candidateLimit,
    buildAcceptPayload,
    filterStoredDuplicates,
  };
}));
