'use strict';

const fs = require('fs');
const path = require('path');
const { publicModelSource } = require('./model-runtime');

const SOURCES = new Set(['actual', 'estimated', 'unavailable']);
const STATUSES = new Set(['completed', 'failed', 'cancelled']);
const own = (value, key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback;
const text = (value, max = 160) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000\r\n]/.test(value) ? value : null;

function usageFilePath(userDataPath) {
  return path.join(userDataPath, 'usage.jsonl');
}

function appendRecord(file, record) {
  const normalized = normalizeRecord(record);
  if (!normalized) throw Object.assign(new Error('用量记录无效。'), { code: 'USAGE_RECORD_INVALID' });
  // The main process is the sole writer. Check the durable ledger, not an in-memory
  // reservation: a failed append must be retryable and a restart must retain dedupe.
  if (normalized.attemptId && readRecords(file).records.some((row) => row.attemptId === normalized.attemptId)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(normalized) + '\n', 'utf8');
  return true;
}

function finiteNonNegative(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.schemaVersion != null && record.schemaVersion !== 2) return null;
  if (record.schemaVersion === 2 || Object.hasOwn(record, 'source') || record.attemptId != null || record.modelSource != null) return normalizeModelRecord(record);
  const ts = finiteNonNegative(record.ts);
  const inputTokens = finiteNonNegative(record.in);
  const outputTokens = finiteNonNegative(record.out);
  const cachedTokens = finiteNonNegative(record.cached);
  const cost = record.cost === null ? null : finiteNonNegative(record.cost);
  if (
    ts === null || inputTokens === null || outputTokens === null
    || cachedTokens === null || cost === null && record.cost !== null
    || typeof record.session !== 'string' || typeof record.model !== 'string'
    || typeof record.kind !== 'string' || typeof record.est !== 'boolean'
    || typeof record.cur !== 'string' || !record.cur
  ) {
    return null;
  }
  return {
    ts,
    session: record.session,
    model: record.model,
    kind: record.kind,
    in: inputTokens,
    out: outputTokens,
    cached: cachedTokens,
    est: record.est,
    cost,
    cur: record.cur,
  };
}

function normalizeModelRecord(record) {
  const ts = finiteNonNegative(record.ts);
  const inputValue = own(record, 'in', record.inputTokens);
  const outputValue = own(record, 'out', record.outputTokens);
  const cachedValue = own(record, 'cached', record.cachedInputTokens);
  const creationValue = record.cacheCreationInputTokens;
  const token = (value) => value == null ? null : finiteNonNegative(value);
  const input = token(inputValue); const output = token(outputValue);
  const cached = token(cachedValue); const creation = token(creationValue);
  if ([inputValue, outputValue, cachedValue, creationValue].some((value) => value != null
    && (finiteNonNegative(value) === null || Number(value) > Number.MAX_SAFE_INTEGER))) return null;
  const session = own(record, 'session', record.sessionId ?? '');
  const currency = own(record, 'cur', record.currency);
  if (ts === null || typeof session !== 'string' || session.length > 256
    || !text(record.model, 256) || !text(record.kind, 64) || !text(currency, 4)) return null;
  if (Object.hasOwn(record, 'source') && !SOURCES.has(record.source)) return null;
  const source = SOURCES.has(record.source) ? record.source : record.est === true ? 'estimated' : 'unavailable';
  const cost = record.cost == null ? null : finiteNonNegative(record.cost);
  if (record.cost != null && cost === null) return null;
  const attemptId = text(record.attemptId);
  if (record.attemptId != null && !attemptId) return null;
  if (record.status != null && !STATUSES.has(record.status)) return null;
  const raw = record.modelSource && typeof record.modelSource === 'object' && !Array.isArray(record.modelSource) ? record.modelSource : {};
  const field = (name, max = 128) => text(own(record, name, raw[name]), max);
  const modelSource = publicModelSource({
    providerId: field('providerId'), providerName: text(raw.providerName, 128),
    modelProfileId: field('modelProfileId'), modelProfileName: text(raw.modelProfileName, 128),
    assistantId: field('assistantId'), assistantName: text(raw.assistantName, 128),
    model: record.model, protocol: field('protocol', 64), baseUrl: raw.endpoint,
    bindingRevision: field('bindingRevision'), runId: field('runId', 160),
    providerRevision: own(record, 'providerRevision', raw.providerRevision),
    modelRevision: own(record, 'modelRevision', raw.modelRevision), assistantRevision: own(record, 'assistantRevision', raw.assistantRevision),
    clientRequestId: field('clientRequestId', 160), kind: ['api', 'local-demo', 'legacy-demo', 'unknown'].includes(raw.kind)
      ? raw.kind : field('providerId') ? 'api' : 'unknown',
  });
  const finishReason = text(record.finishReason, 128);
  return {
    schemaVersion: 2, ts, session, model: record.model, kind: record.kind,
    in: source === 'unavailable' || input === null ? null : Math.floor(input),
    out: source === 'unavailable' || output === null ? null : Math.floor(output),
    cached: source === 'unavailable' || cached === null ? null : Math.floor(cached),
    cacheCreationInputTokens: source === 'unavailable' || creation === null ? null : Math.floor(creation),
    est: source === 'estimated', cost: source === 'unavailable' ? null : cost, cur: currency,
    costEstimated: source !== 'unavailable' && cost !== null && (record.costEstimated === true || source === 'estimated'),
    source, providerId: modelSource.providerId, modelProfileId: modelSource.modelProfileId,
    assistantId: modelSource.assistantId, protocol: modelSource.protocol, bindingRevision: modelSource.bindingRevision,
    runId: modelSource.runId, clientRequestId: modelSource.clientRequestId, attemptId,
    status: record.status ?? null,
    finishReason: finishReason && /^[A-Za-z0-9_.:-]+$/.test(finishReason) ? finishReason : null,
    modelSource,
  };
}

function readRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], skipped: 0 };
    throw err;
  }

  const records = [];
  const seenAttempts = new Set();
  let skipped = 0;
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = normalizeRecord(JSON.parse(trimmed));
      if (!record) {
        skipped += 1;
        continue;
      }
      if (record.attemptId && seenAttempts.has(record.attemptId)) {
        skipped += 1;
        continue;
      }
      if (record.attemptId) seenAttempts.add(record.attemptId);
      records.push(record);
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function pruneRecords(file, maxRecords) {
  const max = Math.floor(Number(maxRecords));
  if (!Number.isFinite(max) || max <= 0) return;
  const { records } = readRecords(file);
  if (records.length <= max) return;

  const keep = [...records]
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(records.length - max);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, keep.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* The temporary file may not have been created. */
    }
    throw err;
  }
}

function clearRecords(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
}

module.exports = {
  usageFilePath,
  appendRecord,
  readRecords,
  pruneRecords,
  clearRecords,
  normalizeRecord,
};
