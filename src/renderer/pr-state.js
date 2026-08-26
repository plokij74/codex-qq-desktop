'use strict';

(function expose(factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(window, 'PullRequestState', { value: api, configurable: false });
}(function createState() {
  function text(value, max) {
    return String(value ?? '').trim().slice(0, max);
  }

  function count(value, max = 200) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.floor(number))) : 0;
  }

  function normalizeChecks(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
      total: count(input.total),
      passed: count(input.passed),
      pending: count(input.pending),
      failed: count(input.failed),
      skipped: count(input.skipped),
      unknown: count(input.unknown),
    };
  }

  function normalize(raw, { detail = false } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const number = count(raw.number, 0x7fffffff);
    const url = /^https:\/\//i.test(String(raw.url || '')) ? text(raw.url, 2000) : '';
    if (!number || !url) return null;
    const state = ['OPEN', 'CLOSED', 'MERGED'].includes(String(raw.state || '').toUpperCase())
      ? String(raw.state).toUpperCase() : '';
    const checks = Array.isArray(raw.checks) ? raw.checks.slice(0, 200).map((item) => ({
      name: text(item?.name, 200),
      state: text(item?.state, 40).toUpperCase(),
      bucket: text(item?.bucket, 40).toUpperCase(),
      link: /^https:\/\//i.test(String(item?.link || '')) ? text(item.link, 2000) : '',
    })).filter((item) => item.name) : [];
    const comments = detail && Array.isArray(raw.comments) ? raw.comments.slice(0, 50).map((item) => ({
      id: text(item?.id, 120),
      author: text(item?.author, 120),
      body: String(item?.body ?? '').slice(0, 5000),
      createdAt: text(item?.createdAt, 80),
      url: /^https:\/\//i.test(String(item?.url || '')) ? text(item.url, 2000) : '',
    })) : [];
    const files = detail && Array.isArray(raw.files) ? raw.files.slice(0, 200).map((item) => ({
      path: text(item?.path, 1000),
      additions: count(item?.additions, Number.MAX_SAFE_INTEGER),
      deletions: count(item?.deletions, Number.MAX_SAFE_INTEGER),
    })).filter((item) => item.path) : [];
    return {
      number,
      url,
      title: String(raw.title || '').slice(0, 300),
      body: detail ? String(raw.body || '').slice(0, 20000) : '',
      state,
      isDraft: raw.isDraft === true,
      author: text(raw.author, 120),
      headRefName: text(raw.headRefName, 255),
      baseRefName: text(raw.baseRefName, 255),
      headSha: /^[a-f0-9]{40}$/i.test(String(raw.headSha || '')) ? String(raw.headSha).toLowerCase() : '',
      updatedAt: text(raw.updatedAt, 80),
      mergeable: text(raw.mergeable, 40).toUpperCase(),
      mergeStateStatus: text(raw.mergeStateStatus, 60).toUpperCase(),
      reviewDecision: text(raw.reviewDecision, 60).toUpperCase(),
      labels: Array.isArray(raw.labels) ? raw.labels.slice(0, 50).map((item) => ({ name: text(item?.name, 120), color: text(item?.color, 20) })).filter((item) => item.name) : [],
      checks,
      checksSummary: normalizeChecks(raw.checksSummary),
      comments,
      commentsTruncated: raw.commentsTruncated === true,
      files,
      filesTruncated: raw.filesTruncated === true,
    };
  }

  function normalizeList(raw) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      const pr = normalize(item);
      if (!pr || seen.has(pr.number)) continue;
      seen.add(pr.number);
      out.push(pr);
    }
    return out;
  }

  return { normalize, normalizeList, normalizeChecks };
}));
