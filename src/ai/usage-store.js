'use strict';

const fs = require('fs');
const path = require('path');

function usageFilePath(userDataPath) {
  return path.join(userDataPath, 'usage.jsonl');
}

function appendRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

function finiteNonNegative(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
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

function readRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], skipped: 0 };
    throw err;
  }

  const records = [];
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
