'use strict';

// Only synthetic models/credentials and disposable JSONL files are used here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelRegistry, updateModelRegistry, resolveModelBinding } = require('../src/ai/model-profiles');
const { buildModelUsageEvent } = require('../src/ai/model-usage');
const { normalizeUsage, normalizeModelUsage, resolvePricing, computeCost, aggregate } = require('../src/ai/usage');
const { usageFilePath, appendRecord, normalizeRecord, readRecords, pruneRecords, clearRecords } = require('../src/ai/usage-store');
const { clampUsageSettings, loadSettings, saveSettings } = require('../src/ai/settings');

function binding(overrides = {}) {
  const registry = updateModelRegistry(createModelRegistry({
    baseUrl: 'https://synthetic.example/gateway/v1', model: 'synthetic-used-model',
    secretRef: 'synthetic-private-secret-ref', apiKeyConfigured: true,
  }), (draft) => {
    draft.providers[0].name = 'Synthetic provider snapshot';
    draft.models[0].name = 'Synthetic profile snapshot';
    draft.assistants[0].name = 'Synthetic assistant snapshot';
  });
  return { ...resolveModelBinding({ registry, senderId: 7, sessionId: 'synthetic-session', runId: 'synthetic-run', clientRequestId: 'synthetic-client', kind: 'chat' }), ...overrides };
}
const settings = (rows = [{ modelPrefix: 'synthetic-used', inputPerM: 2, outputPerM: 6 }]) => ({
  usageEnabled: true, usageCurrency: 'SYN', usagePricing: rows,
  model: 'synthetic-wrong-global-model', compactMaxApproxTokens: 19000,
});
const attempt = (changes = {}) => ({
  attemptId: 'synthetic-attempt-1', status: 'completed', finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: null, cacheCreationInputTokens: 0, source: 'actual' },
  modelSource: { model: 'synthetic-must-not-replace-binding', secretRef: 'synthetic-do-not-expose' },
  ...changes,
});
function ledger(event, extra = {}) {
  return { ...event, ts: 1234, session: event.sessionId, in: event.inputTokens, out: event.outputTokens,
    cached: event.cachedInputTokens, est: event.estimated, cur: event.currency, ...extra };
}
function temporaryLedger(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-synthetic-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return usageFilePath(root);
}
const legacyRecord = (extra = {}) => ({ ts: 1, session: 'legacy-session', model: 'legacy-model', kind: 'main',
  in: 8, out: 2, cached: 0, est: false, cost: null, cur: 'SYN', ...extra });

test('physical attempt produces the existing flat usage event with frozen public source snapshots', () => {
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() });
  assert.equal(event.type, 'usage');
  assert.equal(event.model, 'synthetic-used-model');
  assert.equal(event.kind, 'chat');
  assert.equal(event.inputTokens, 100);
  assert.equal(event.outputTokens, 10);
  assert.equal(event.cachedInputTokens, null);
  assert.equal(event.cacheCreationInputTokens, 0);
  assert.equal(event.source, 'actual');
  assert.equal(event.estimated, false);
  assert.equal(event.attemptId, 'synthetic-attempt-1');
  assert.equal(event.status, 'completed');
  assert.equal(event.finishReason, 'stop');
  assert.equal(event.providerId, 'provider_legacy_openai');
  assert.equal(event.modelProfileId, 'model_legacy_default');
  assert.equal(event.assistantId, 'assistant_codex');
  assert.equal(event.runId, 'synthetic-run');
  assert.equal(event.clientRequestId, 'synthetic-client');
  assert.equal(event.sessionId, 'synthetic-session');
  assert.equal(event.modelSource.providerName, 'Synthetic provider snapshot');
  assert.equal(event.modelSource.modelProfileName, 'Synthetic profile snapshot');
  assert.equal(event.modelSource.assistantName, 'Synthetic assistant snapshot');
  assert.equal(event.modelSource.endpoint, 'https://synthetic.example/gateway/v1');
  assert.equal(event.contextTokens, 100);
  assert.equal(event.contextLimit, 19000);
  assert.ok(Math.abs(event.cost - 0.00026) < 1e-12);
  assert.equal(event.currency, 'SYN');
  const serialized = JSON.stringify(event);
  for (const forbidden of ['synthetic-private-secret-ref', 'synthetic-do-not-expose', 'secretRef', 'credentialOrigin', 'credentialRevision', 'synthetic-wrong-global-model']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.isFrozen(event.modelSource), true);
});

test('helper respects disabled usage and does not invent an attempt or binding', () => {
  assert.equal(buildModelUsageEvent({ binding: binding(), settings: { usageEnabled: false }, attempt: attempt() }), null);
  assert.equal(buildModelUsageEvent({ binding: binding(), settings: settings() }), null);
  assert.equal(buildModelUsageEvent({ settings: settings(), attempt: attempt() }), null);
});

test('failed and cancelled unavailable attempts retain nulls instead of actual zero consumption', () => {
  for (const status of ['failed', 'cancelled']) {
    const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt({ status, finishReason: null,
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, source: 'unavailable' } }) });
    assert.equal(event.source, 'unavailable');
    assert.equal(event.inputTokens, null);
    assert.equal(event.outputTokens, null);
    assert.equal(event.cachedInputTokens, null);
    assert.equal(event.cacheCreationInputTokens, null);
    assert.equal(event.contextTokens, null);
    assert.equal(event.estimated, false);
    assert.equal(event.cost, null);
    assert.equal(event.status, status);
  }
});

test('measured zero usage remains actual zero, distinct from unavailable and missing cache counts', () => {
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt({ usage: {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, source: 'actual',
  } }) });
  assert.equal(event.source, 'actual');
  assert.equal(event.inputTokens, 0);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.cachedInputTokens, 0);
  assert.equal(event.contextTokens, 0);
  assert.equal(event.cost, 0);
});

test('estimated usage is explicitly estimated; invalid/missing counters are never converted to zero', () => {
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt({ usage: {
    inputTokens: 13, outputTokens: 2, source: 'estimated',
  } }) });
  assert.equal(event.estimated, true);
  assert.equal(event.source, 'estimated');
  assert.equal(event.cachedInputTokens, null);
  assert.equal(event.cacheCreationInputTokens, null);
  const normalized = normalizeModelUsage({ inputTokens: Infinity, outputTokens: -1, cachedInputTokens: '', source: 'actual' });
  assert.equal(normalized.inputTokens, null);
  assert.equal(normalized.outputTokens, null);
  assert.equal(normalized.cachedInputTokens, null);
  assert.equal(normalizeModelUsage({ inputTokens: 0, outputTokens: 0, source: 'guess' }).source, 'unavailable');
});

test('canonical normalized usage is not mistaken for gateway raw usage or summed twice', () => {
  const usage = { inputTokens: 72, outputTokens: 3, cachedInputTokens: 60, cacheCreationInputTokens: 4, source: 'actual' };
  assert.deepEqual(normalizeModelUsage(usage), usage);
  assert.deepEqual(normalizeUsage(usage), { ...usage, estimated: false });
  const event = buildModelUsageEvent({ binding: binding({ protocol: 'anthropic-messages' }), settings: settings(), attempt: attempt({ usage }) });
  assert.equal(event.inputTokens, 72);
  assert.equal(event.cachedInputTokens, 60);
  assert.equal(event.cacheCreationInputTokens, 4);
});

test('explicit request context limit wins without deriving context consumption from zero defaults', () => {
  const target = binding();
  target.request = { ...target.request, contextWindowTokens: 8192 };
  assert.equal(buildModelUsageEvent({ binding: target, settings: settings(), attempt: attempt() }).contextLimit, 8192);
  target.request.contextWindowTokens = -1;
  assert.equal(buildModelUsageEvent({ binding: target, settings: settings(), attempt: attempt() }).contextLimit, 19000);
});

test('helper sanitizes source endpoint and never copies attempt provider state/error payload', () => {
  const event = buildModelUsageEvent({ binding: binding({ baseUrl: 'https://synthetic.example/v1?region=synthetic' }), settings: settings(),
    attempt: attempt({ rawProviderState: { syntheticSecret: 'synthetic-private-state' }, error: { message: 'synthetic-private-error' } }) });
  assert.equal(event.modelSource.endpoint, 'https://synthetic.example/v1');
  assert.equal(JSON.stringify(event).includes('synthetic-private-state'), false);
  assert.equal(JSON.stringify(event).includes('synthetic-private-error'), false);
});

test('scoped pricing prefers exact profile then provider and longest actual-model prefix', () => {
  const broad = { providerId: 'provider_new', modelPrefix: 'synthetic', inputPerM: 2, outputPerM: 3 };
  const specific = { providerId: 'provider_new', modelPrefix: 'synthetic-used', inputPerM: 4, outputPerM: 5 };
  const profile = { modelProfileId: 'model_new', inputPerM: 6, outputPerM: 7 };
  const wrong = { providerId: 'provider_other', modelPrefix: 'synthetic-used-model', inputPerM: 999, outputPerM: 999 };
  const rows = [broad, specific, wrong, profile];
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'provider_new', modelProfileId: 'model_new' }), profile);
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'provider_new', modelProfileId: 'different' }), specific);
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'missing' }), null);
});

test('legacy unscoped prices stay legacy-only and never cross into a new provider', () => {
  const rows = [{ modelPrefix: 'synthetic', inputPerM: 1, outputPerM: 2 }];
  assert.equal(resolvePricing('synthetic-used-model', rows), rows[0]);
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'provider_legacy_openai' }), rows[0]);
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'provider_new' }), null);
  const event = buildModelUsageEvent({ binding: binding({ providerId: 'provider_new', modelProfileId: 'model_new' }), settings: settings(rows), attempt: attempt() });
  assert.equal(event.cost, null);
});

test('positive cache creation with no explicit price is unknown instead of charged at guessed regular input rate', () => {
  const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheCreationInputTokens: 30, source: 'actual' };
  assert.equal(computeCost(usage, { inputPerM: 2, outputPerM: 6 }), null);
  assert.equal(buildModelUsageEvent({ binding: binding({ protocol: 'anthropic-messages' }), settings: settings(), attempt: attempt({ usage }) }).cost, null);
  assert.equal(computeCost({ ...usage, source: 'unavailable' }, { inputPerM: 2, outputPerM: 6, cacheCreationInputPerM: 4 }), null);
});

test('explicit cache prices use inclusive normalized input once and keep zero prices valid', () => {
  const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheCreationInputTokens: 30, source: 'actual' };
  assert.ok(Math.abs(computeCost(usage, { inputPerM: 2, outputPerM: 6, cachedInputPerM: 1, cacheCreationInputPerM: 4 }) - 0.0003) < 1e-12);
  assert.equal(computeCost(usage, { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0, cacheCreationInputPerM: 0 }), 0);
  assert.equal(computeCost({ ...usage, cachedInputTokens: 90 }, { inputPerM: 2, outputPerM: 6, cachedInputPerM: 1, cacheCreationInputPerM: 4 }), null);
  assert.equal(computeCost({ ...usage, outputTokens: null }, { inputPerM: 2, outputPerM: 6, cacheCreationInputPerM: 4 }), null);
});

test('ledger schema2 round-trips provenance, terminal status, creation and null cache counters', (t) => {
  const file = temporaryLedger(t);
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() });
  assert.equal(appendRecord(file, ledger(event)), true);
  const { records, skipped } = readRecords(file);
  assert.equal(skipped, 0);
  assert.equal(records.length, 1);
  const row = records[0];
  assert.equal(row.schemaVersion, 2);
  for (const field of ['providerId', 'modelProfileId', 'assistantId', 'protocol', 'bindingRevision', 'runId', 'clientRequestId', 'attemptId', 'status', 'finishReason', 'source', 'cacheCreationInputTokens']) assert.equal(row[field], event[field], field);
  assert.deepEqual(row.modelSource, event.modelSource);
  assert.equal(row.in, 100);
  assert.equal(row.out, 10);
  assert.equal(row.cached, null);
  assert.equal(row.est, false);
  assert.equal(row.modelSource.providerName, 'Synthetic provider snapshot');
});

test('flat model usage events with timestamp/session aliases are accepted by the new ledger boundary', (t) => {
  const file = temporaryLedger(t);
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() });
  appendRecord(file, { ts: 1, ...event });
  const row = readRecords(file).records[0];
  assert.equal(row.in, event.inputTokens);
  assert.equal(row.out, event.outputTokens);
  assert.equal(row.session, 'synthetic-session');
  assert.equal(row.cur, 'SYN');
});

test('ledger stores unavailable nulls and measured actual zero as different records', (t) => {
  const file = temporaryLedger(t);
  const b = binding();
  const unavailable = buildModelUsageEvent({ binding: b, settings: settings(), attempt: attempt({ status: 'cancelled', usage: { source: 'unavailable' } }) });
  const zero = buildModelUsageEvent({ binding: b, settings: settings(), attempt: attempt({ attemptId: 'synthetic-attempt-zero', usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, source: 'actual' } }) });
  appendRecord(file, ledger(unavailable)); appendRecord(file, ledger(zero));
  const [unknown, actual] = readRecords(file).records;
  assert.equal(unknown.in, null); assert.equal(unknown.out, null); assert.equal(unknown.cached, null);
  assert.equal(unknown.cost, null); assert.equal(unknown.source, 'unavailable');
  assert.equal(actual.in, 0); assert.equal(actual.out, 0); assert.equal(actual.cost, 0); assert.equal(actual.source, 'actual');
});

test('attemptId deduplication survives rereads while separate physical attempts are billed separately', (t) => {
  const file = temporaryLedger(t);
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() });
  const row = ledger(event);
  assert.equal(appendRecord(file, row), true);
  assert.equal(appendRecord(file, { ...row, ts: 2 }), false);
  assert.equal(appendRecord(file, { ...row, attemptId: 'synthetic-second-attempt', ts: 3 }), true);
  assert.equal(readRecords(file).records.length, 2);
});

test('failed append never reserves an attemptId and a successful retry writes once', (t) => {
  const file = temporaryLedger(t);
  const row = ledger(buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() }));
  const append = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('synthetic usage disk failure'); };
  try { assert.throws(() => appendRecord(file, row), /synthetic usage disk failure/); }
  finally { fs.appendFileSync = append; }
  assert.equal(appendRecord(file, row), true);
  assert.equal(appendRecord(file, row), false);
});

test('legacy rows remain exact and are not deduplicated or attributed to the current provider', (t) => {
  const file = temporaryLedger(t);
  const old = legacyRecord();
  appendRecord(file, old); appendRecord(file, old);
  assert.deepEqual(readRecords(file), { records: [old, old], skipped: 0 });
  assert.equal(Object.hasOwn(normalizeRecord(old), 'providerId'), false);
  assert.equal(Object.hasOwn(normalizeRecord(old), 'source'), false);
});

test('reader accepts mixed old/new rows, ignores duplicate modern attempts and skips corrupt lines', (t) => {
  const file = temporaryLedger(t);
  const old = legacyRecord();
  const row = ledger(buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() }));
  fs.writeFileSync(file, [JSON.stringify(old), JSON.stringify(row), '{synthetic-corrupt', JSON.stringify({ ...row, ts: 2 })].join('\n') + '\n');
  const result = readRecords(file);
  assert.equal(result.records.length, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.records[0], old);
});

test('modern ledger writes whitelist public metadata and never persist raw provider/private credential fields', (t) => {
  const file = temporaryLedger(t);
  const row = ledger(buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() }));
  row.secretRef = 'synthetic-private-ref'; row.rawProviderState = { key: 'synthetic-private-state' };
  row.modelSource = { ...row.modelSource, auth: { secretRef: 'synthetic-private-source' }, apiKey: 'synthetic-private-key' };
  appendRecord(file, row);
  const text = fs.readFileSync(file, 'utf8');
  for (const forbidden of ['secretRef', 'apiKey', 'rawProviderState', 'synthetic-private']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('pruning/clearing modern rows preserves schema and resets durable attempt deduplication', (t) => {
  const file = temporaryLedger(t);
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() });
  for (let n = 1; n <= 3; n += 1) appendRecord(file, ledger(event, { ts: n, attemptId: `synthetic-attempt-${n}` }));
  pruneRecords(file, 2);
  const rows = readRecords(file).records;
  assert.deepEqual(rows.map((row) => row.ts), [2, 3]);
  assert.equal(rows[0].providerId, event.providerId);
  assert.equal(rows[0].cached, null);
  clearRecords(file);
  assert.equal(appendRecord(file, ledger(event)), true);
  assert.equal(readRecords(file).records.length, 1);
});

test('modern aggregation reports availability rather than passing unknown usage off as actual zero', () => {
  const make = (id, usage) => normalizeRecord(ledger(buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt({ attemptId: id, usage }) })));
  const rows = [
    make('synthetic-actual-zero', { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, source: 'actual' }),
    make('synthetic-unavailable', { source: 'unavailable' }),
    make('synthetic-estimated', { inputTokens: 10, outputTokens: 2, source: 'estimated' }),
  ];
  const result = aggregate(rows);
  assert.equal(result.totals.in, 10); assert.equal(result.totals.out, 2);
  assert.equal(result.availability.actual, 1); assert.equal(result.availability.estimated, 1); assert.equal(result.availability.unavailable, 1);
  assert.equal(result.availability.inputUnknown, 1); assert.equal(result.availability.outputUnknown, 1);
  assert.equal(result.availability.cachedUnknown, 2);
  assert.equal(result.totals.estimatedShare, 1);
});

test('pricing settings retain bounded scope/cache-creation fields while preserving legacy row shape', () => {
  const old = { modelPrefix: 'synthetic', inputPerM: 1, outputPerM: 2 };
  const scoped = { providerId: 'provider_synthetic', modelProfileId: 'model_synthetic', modelPrefix: '', inputPerM: 2, outputPerM: 3, cacheCreationInputPerM: 4, cachedInputPerM: 0 };
  const normalized = clampUsageSettings({ usagePricing: [old, scoped] }).usagePricing;
  assert.deepEqual(normalized[0], old);
  assert.deepEqual(normalized[1], scoped);
  const bounded = clampUsageSettings({ usagePricing: [
    { ...scoped, providerId: 'x'.repeat(129) },
    { ...scoped, modelProfileId: { synthetic: true } },
    { ...scoped, cacheCreationInputPerM: 'not-a-price' },
  ] }).usagePricing;
  assert.equal(bounded.length, 1);
  assert.equal(Object.hasOwn(bounded[0], 'cacheCreationInputPerM'), false);
});

test('scoped prices survive a synthetic settings save/load without activating a vault read', (t) => {
  const file = temporaryLedger(t);
  const root = path.dirname(file);
  const row = { providerId: 'provider_synthetic', modelProfileId: 'model_synthetic', modelPrefix: 'synthetic', inputPerM: 2, outputPerM: 3, cacheCreationInputPerM: 4 };
  const manager = { registerSecret() {}, hasSecret() { return false; }, getSecret() { throw new Error('synthetic vault must not be read'); } };
  const options = { secretManager: manager, resolveLegacyApiKey: false };
  assert.deepEqual(saveSettings(root, { usagePricing: [row] }, options).usagePricing, [row]);
  assert.deepEqual(loadSettings(root, options).usagePricing, [row]);
});

test('a legacy raw gateway source annotation does not opt into canonical usage or change old prefix coercion', () => {
  assert.deepEqual(normalizeUsage({ source: 'synthetic-gateway-metadata', prompt_tokens: 9, completion_tokens: 2 }), {
    inputTokens: 9, outputTokens: 2, cachedInputTokens: 0, estimated: false,
  });
  const row = { modelPrefix: 123, inputPerM: 1, outputPerM: 2 };
  assert.equal(resolvePricing('123-synthetic', [row]), row);
});

test('malformed explicit pricing scope is rejected rather than silently broadened to legacy scope', () => {
  const rows = [{ providerId: 0, modelPrefix: 'synthetic', inputPerM: 0, outputPerM: 0 }];
  assert.equal(resolvePricing('synthetic-used-model', rows), null);
  assert.equal(resolvePricing('synthetic-used-model', rows, { providerId: 'provider_legacy_openai' }), null);
});

test('an unavailable ledger source cannot regain zero counters or estimated cost from legacy fallback mapping', () => {
  const normalized = normalizeRecord({ ...legacyRecord({ in: 0, out: 0, cost: 0 }), schemaVersion: 2,
    source: 'unavailable', cacheCreationInputTokens: 0, costEstimated: true, attemptId: 'synthetic-unavailable-attempt', status: 'failed' });
  assert.equal(normalized.in, null);
  assert.equal(normalized.out, null);
  assert.equal(normalized.cached, null);
  assert.equal(normalized.cacheCreationInputTokens, null);
  assert.equal(normalized.cost, null);
  assert.equal(normalized.costEstimated, false);
});

test('base-rate cache cost estimates are labeled through event, ledger and aggregation', (t) => {
  const file = temporaryLedger(t);
  const event = buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt({ usage: {
    inputTokens: 100, outputTokens: 10, cachedInputTokens: 30, cacheCreationInputTokens: 0, source: 'actual',
  } }) });
  assert.equal(event.costEstimated, true);
  appendRecord(file, ledger(event));
  const { records } = readRecords(file);
  assert.equal(records[0].costEstimated, true);
  assert.equal(aggregate(records).availability.costEstimated, 1);
});

test('model groups isolate identical model names from different providers without rewriting legacy rows', () => {
  const row = ledger(buildModelUsageEvent({ binding: binding(), settings: settings(), attempt: attempt() }));
  const other = { ...row, providerId: 'provider_other', modelProfileId: 'model_other', attemptId: 'synthetic-other', modelSource: { ...row.modelSource, providerId: 'provider_other', modelProfileId: 'model_other' } };
  const old = legacyRecord({ model: row.model });
  const result = aggregate([normalizeRecord(row), normalizeRecord(other), old], { groupBy: 'model' });
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups.filter((group) => group.providerId === 'provider_other').length, 1);
  assert.ok(result.groups.some((group) => group.key === row.model && !group.providerId));
});
