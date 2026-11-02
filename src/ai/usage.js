'use strict';

const {
  approxTokensFromText,
  approxTokensFromMessages,
} = require('./session-compact');

const USAGE_SOURCES = new Set(['actual', 'estimated', 'unavailable']);
const LEGACY_PROVIDER_ID = 'provider_legacy_openai';
function nullableNumber(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function nullableTokens(value) {
  const number = nullableNumber(value);
  return number !== null && number <= Number.MAX_SAFE_INTEGER ? Math.floor(number) : null;
}

/** Sanitize an already normalized physical-attempt usage; never add cache twice. */
function normalizeModelUsage(raw) {
  const source = raw && USAGE_SOURCES.has(raw.source) ? raw.source : 'unavailable';
  const count = (name) => source === 'unavailable' ? null : nullableTokens(raw?.[name]);
  return {
    inputTokens: count('inputTokens'), outputTokens: count('outputTokens'),
    cachedInputTokens: count('cachedInputTokens'), cacheCreationInputTokens: count('cacheCreationInputTokens'),
    source,
  };
}

/** Legacy gateway mapping remains byte-shape compatible for callers without a binding. */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const canonical = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens'].some((key) => Object.hasOwn(raw, key))
    || !['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens'].some((key) => Object.hasOwn(raw, key));
  if (canonical && Object.hasOwn(raw, 'source')) {
    const normalized = normalizeModelUsage(raw);
    return { ...normalized, estimated: normalized.source === 'estimated' };
  }
  const inputTokens = nullableNumber(raw.prompt_tokens ?? raw.input_tokens);
  const outputTokens = nullableNumber(raw.completion_tokens ?? raw.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const rawCached = raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens;
  const cachedInputTokens = rawCached == null ? 0 : nullableNumber(rawCached);
  const cacheCreationTokens = raw.cache_creation_input_tokens == null
    ? 0 : nullableNumber(raw.cache_creation_input_tokens);
  const anthropicStyle = raw.prompt_tokens == null && raw.input_tokens != null;
  const totalInputTokens = anthropicStyle
    ? inputTokens + (cachedInputTokens || 0) + (cacheCreationTokens || 0) : inputTokens;
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

/** Profile exact > provider/prefix > legacy-only unscoped prefix. No provider guessing. */
function resolvePricing(model, pricingList, scope) {
  const modelName = String(model || '');
  if (!modelName || !Array.isArray(pricingList)) return null;
  const scoped = scope && typeof scope === 'object';
  let best = null;
  let bestRank = -1;
  let bestPrefixLength = -1;
  for (const row of pricingList) {
    if (!row || typeof row !== 'object') continue;
    const validScopeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (row.providerId != null && row.providerId !== '' && !validScopeId(row.providerId)
      || row.modelProfileId != null && row.modelProfileId !== '' && !validScopeId(row.modelProfileId)) continue;
    const providerId = row.providerId || null;
    const profileId = row.modelProfileId || null;
    if (!scoped && (providerId || profileId)) continue;
    const prefix = String(row.modelPrefix || '');
    let rank;
    if (profileId) {
      if (profileId !== scope?.modelProfileId || providerId && providerId !== scope?.providerId) continue;
      rank = 2;
    } else {
      if (!prefix || !modelName.startsWith(prefix)) continue;
      if (providerId) {
        if (providerId !== scope?.providerId) continue;
        rank = 1;
      } else {
        if (scoped && scope.providerId !== LEGACY_PROVIDER_ID) continue;
        rank = 0;
      }
    }
    if (rank > bestRank || rank === bestRank && rank !== 2 && prefix.length > bestPrefixLength) {
      best = row; bestRank = rank; bestPrefixLength = prefix.length;
    }
  }
  return best;
}

/** Modern inclusive counters are split only with explicit cache prices. */
function computeCost(usage, pricing, options = {}) {
  if (!usage || !pricing) return null;
  if (!Object.hasOwn(usage, 'source')) {
    // Historical callers deliberately retain their original pricing semantics.
    return ((Number(usage.inputTokens) || 0) / 1e6) * (Number(pricing.inputPerM) || 0)
      + ((Number(usage.outputTokens) || 0) / 1e6) * (Number(pricing.outputPerM) || 0);
  }
  const normalized = normalizeModelUsage(usage);
  const input = normalized.inputTokens;
  const output = normalized.outputTokens;
  const inputRate = nullableNumber(pricing.inputPerM);
  const outputRate = nullableNumber(pricing.outputPerM);
  if (normalized.source === 'unavailable' || input === null || output === null || inputRate === null || outputRate === null) return null;
  const cachedRate = nullableNumber(pricing.cachedInputPerM);
  const creationRate = nullableNumber(pricing.cacheCreationInputPerM);
  const cached = normalized.cachedInputTokens;
  const creation = normalized.cacheCreationInputTokens;
  if (cached !== null && cached > input || creation !== null && creation > input) return null;
  if (cached !== null && creation !== null && cached + creation > input) return null;
  if (creation > 0 && creationRate === null) return null;
  if (creation === null && input > 0 && (options.protocol === 'anthropic-messages'
    || Object.hasOwn(pricing, 'cacheCreationInputPerM') && creationRate !== inputRate)) return null;
  if (cached === null && input > 0 && Object.hasOwn(pricing, 'cachedInputPerM') && cachedRate !== inputRate) return null;
  if (cached > 0 && Object.hasOwn(pricing, 'cachedInputPerM') && cachedRate === null) return null;
  const readCount = cached || 0;
  const creationCount = creation || 0;
  const regularCount = input - readCount - creationCount;
  const cost = (regularCount * inputRate + readCount * (cachedRate ?? inputRate)
    + creationCount * (creationRate ?? inputRate) + output * outputRate) / 1e6;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function dayKey(ts) {
  const date = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function newAvailability() {
  return { actual: 0, estimated: 0, unavailable: 0, legacy: 0,
    inputUnknown: 0, outputUnknown: 0, cachedUnknown: 0, cacheCreationUnknown: 0, costUnknown: 0, costEstimated: 0 };
}
function addAvailability(target, record, modern) {
  target[modern ? record.source : 'legacy'] += 1;
  if (modern) {
    if (nullableNumber(record.in) === null) target.inputUnknown += 1;
    if (nullableNumber(record.out) === null) target.outputUnknown += 1;
    if (nullableNumber(record.cached) === null) target.cachedUnknown += 1;
    if (nullableNumber(record.cacheCreationInputTokens) === null) target.cacheCreationUnknown += 1;
  }
  if (nullableNumber(record.cost) === null) target.costUnknown += 1;
  else if (record.costEstimated === true) target.costEstimated += 1;
}

/** Keep historical totals while separately reporting modern unknown availability. */
function aggregate(records, opts = {}) {
  const validGroups = new Set(['day', 'model', 'kind', 'session']);
  const groupBy = validGroups.has(opts.groupBy) ? opts.groupBy : 'model';
  const totals = { in: 0, out: 0, cost: 0, estimatedShare: 0 };
  const groups = new Map();
  const availability = newAvailability();
  const seenAttempts = new Set();
  let estimatedTokens = 0;
  let hasModern = false;
  for (const raw of Array.isArray(records) ? records : []) {
    const record = raw && typeof raw === 'object' ? raw : {};
    if (typeof record.attemptId === 'string' && record.attemptId) {
      if (seenAttempts.has(record.attemptId)) continue;
      seenAttempts.add(record.attemptId);
    }
    const modern = USAGE_SOURCES.has(record.source);
    hasModern ||= modern;
    const input = nullableNumber(record.in) ?? 0;
    const output = nullableNumber(record.out) ?? 0;
    const cost = typeof record.cost === 'number' && Number.isFinite(record.cost) && record.cost >= 0 ? record.cost : 0;
    const estimated = modern ? record.source === 'estimated' : record.est === true;
    totals.in += input; totals.out += output; totals.cost += cost;
    if (estimated) estimatedTokens += input + output;
    addAvailability(availability, record, modern);
    const scopedModel = groupBy === 'model' && modern;
    const key = groupBy === 'day' ? dayKey(record.ts) : scopedModel
      ? JSON.stringify([record.providerId || null, record.modelProfileId || null, record.model || '?'])
      : String(record[groupBy] ?? '?');
    // Use a tagged map key so a historical model name can never collide with an encoded source.
    const mapKey = JSON.stringify([scopedModel ? 'profile' : 'legacy', key]);
    let entry = groups.get(mapKey);
    if (!entry) {
      const group = { key, in: 0, out: 0, cost: 0, est: 0, count: 0 };
      if (scopedModel) {
        group.model = record.model;
        for (const name of ['providerId', 'modelProfileId', 'assistantId', 'protocol']) {
          if (typeof record[name] === 'string') group[name] = record[name];
        }
      }
      entry = { group, availability: newAvailability() };
      groups.set(mapKey, entry);
    }
    entry.group.in += input; entry.group.out += output; entry.group.cost += cost;
    entry.group.est += estimated ? 1 : 0; entry.group.count += 1;
    addAvailability(entry.availability, record, modern);
  }
  const totalTokens = totals.in + totals.out;
  totals.estimatedShare = totalTokens > 0 ? estimatedTokens / totalTokens : 0;
  const result = { totals, groups: [...groups.values()].map((entry) => hasModern
    ? { ...entry.group, availability: entry.availability } : entry.group).sort((a, b) => a.key.localeCompare(b.key)) };
  if (hasModern) result.availability = availability;
  return result;
}

module.exports = { normalizeUsage, normalizeModelUsage, estimateUsage, resolvePricing, computeCost, aggregate };
