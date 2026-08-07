'use strict';

const {
  approxTokensFromText,
  approxTokensFromMessages,
} = require('./session-compact');

/** Map gateway-specific usage fields to the application's stable shape. */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const numericToken = (value) => {
    if (typeof value === 'string' && value.trim() === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const inputTokens = numericToken(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = numericToken(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const rawCached = raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens;
  const cachedInputTokens = rawCached == null ? 0 : numericToken(rawCached);
  const cacheCreationTokens = raw.cache_creation_input_tokens == null
    ? 0
    : numericToken(raw.cache_creation_input_tokens);
  const anthropicStyle = raw.prompt_tokens == null && raw.input_tokens != null;
  const totalInputTokens = anthropicStyle
    ? inputTokens + (cachedInputTokens || 0) + (cacheCreationTokens || 0)
    : inputTokens;
  return {
    inputTokens: Math.floor(totalInputTokens),
    outputTokens: Math.max(0, Math.floor(outputTokens)),
    cachedInputTokens: cachedInputTokens === null ? 0 : Math.floor(cachedInputTokens),
    estimated: false,
  };
}

/** Fall back to the same char/4 heuristic used by session compaction. */
function estimateUsage(messages, content) {
  return {
    inputTokens: approxTokensFromMessages(Array.isArray(messages) ? messages : []),
    outputTokens: approxTokensFromText(String(content || '')),
    cachedInputTokens: 0,
    estimated: true,
  };
}

/** Resolve model pricing with the most specific matching prefix. */
function resolvePricing(model, pricingList) {
  const modelName = String(model || '');
  if (!modelName || !Array.isArray(pricingList)) return null;
  let best = null;
  for (const row of pricingList) {
    const prefix = String(row?.modelPrefix || '');
    if (!prefix || !modelName.startsWith(prefix)) continue;
    if (!best || prefix.length > String(best.modelPrefix || '').length) best = row;
  }
  return best;
}

/** Cached input tokens are informational and use the regular input price. */
function computeCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const inputPerM = Number(pricing.inputPerM) || 0;
  const outputPerM = Number(pricing.outputPerM) || 0;
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  return (inputTokens / 1e6) * inputPerM + (outputTokens / 1e6) * outputPerM;
}

function dayKey(ts) {
  const date = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Aggregate normalized JSONL records for the usage UI. */
function aggregate(records, opts = {}) {
  const validGroups = new Set(['day', 'model', 'kind', 'session']);
  const groupBy = validGroups.has(opts.groupBy) ? opts.groupBy : 'model';
  const keyOf = (record) => groupBy === 'day'
    ? dayKey(record.ts)
    : String(record[groupBy] ?? '?');
  const totals = { in: 0, out: 0, cost: 0, estimatedShare: 0 };
  const groups = new Map();
  let estimatedTokens = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const safeCount = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    };
    const inputTokens = safeCount(record?.in);
    const outputTokens = safeCount(record?.out);
    totals.in += inputTokens;
    totals.out += outputTokens;
    if (typeof record?.cost === 'number' && Number.isFinite(record.cost) && record.cost >= 0) {
      totals.cost += record.cost;
    }
    if (record?.est === true) estimatedTokens += inputTokens + outputTokens;

    const key = keyOf(record || {});
    let group = groups.get(key);
    if (!group) {
      group = { key, in: 0, out: 0, cost: 0, est: 0, count: 0 };
      groups.set(key, group);
    }
    group.in += inputTokens;
    group.out += outputTokens;
    if (typeof record?.cost === 'number' && Number.isFinite(record.cost) && record.cost >= 0) {
      group.cost += record.cost;
    }
    if (record?.est === true) group.est += 1;
    group.count += 1;
  }

  const totalTokens = totals.in + totals.out;
  totals.estimatedShare = totalTokens > 0 ? estimatedTokens / totalTokens : 0;
  return {
    totals,
    groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

module.exports = {
  normalizeUsage,
  estimateUsage,
  resolvePricing,
  computeCost,
  aggregate,
};
