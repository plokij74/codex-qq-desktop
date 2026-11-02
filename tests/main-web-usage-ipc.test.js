'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { usageFilePath, appendRecord, readRecords } = require('../src/ai/usage-store');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { loadMainFixture, jsonResponse } = require('./helpers/e4-main-fixture');

function usageRecord(ts, extra = {}) {
  return { ts, session: 's', model: 'm', kind: 'main', in: 10, out: 2, cached: 0,
    est: false, cost: 1, cur: '$', ...extra };
}

describe('D.3 main web and usage IPC behavior', () => {
  it('registers the D.3 handlers and rejects manual fetch while disabled', async t => {
    let webRequests = 0;
    const f = loadMainFixture(t, { settings: { webEnabled: false }, modules: {
      './ai/web-fetch': { fetchUrl: async () => { webRequests++; throw new Error('Disabled web fetch must not execute'); } },
    } });
    for (const channel of ['chat:send', 'web:fetch', 'usage:summary', 'usage:clear']) {
      assert.equal(typeof f.handlers.get(channel), 'function', channel);
    }
    assert.deepEqual(await f.invoke('web:fetch', { url: 'https://example.invalid' }), {
      ok: false, error: '网页访问未启用',
    });
    assert.equal(webRequests, 0); assert.equal(f.requests.length, 0);
  });

  it('filters by time and never adds costs from different currencies', async t => {
    const f = loadMainFixture(t, { settings: { usageEnabled: true, usageCurrency: '$' } });
    const file = usageFilePath(f.root);
    appendRecord(file, usageRecord(100, { cost: 0.1 }));
    appendRecord(file, usageRecord(200, { cost: 0.2, cur: 'EUR' }));
    appendRecord(file, usageRecord(300, { cost: 0.3, cur: 'JPY' }));
    const result = await f.invoke('usage:summary', { from: 50, to: 250, groupBy: 'kind' });
    assert.equal(result.ok, true); assert.equal(result.totals.in, 20);
    assert.ok(Math.abs(result.totals.cost - 0.1) < 1e-9);
    assert.deepEqual(Array.from(result.mixedCurrencies), ['EUR']);
  });

  it('clears the ledger and reports the disabled state', async t => {
    const f = loadMainFixture(t, { settings: { usageEnabled: true } });
    const file = usageFilePath(f.root); appendRecord(file, usageRecord(100));
    assert.equal((await f.invoke('usage:clear')).ok, true);
    assert.deepEqual(readRecords(file).records, []);
    f.patchSettings({ usageEnabled: false });
    assert.equal((await f.invoke('usage:summary')).ok, false);
    assert.equal((await f.invoke('usage:clear')).ok, false);
  });

  it('meters bound API chats when Agent is disabled', async t => {
    const f = loadMainFixture(t, { settings: { agentEnabled: false, memoryEnabled: false, usageEnabled: true, usagePricing: [] },
      fetchFn: async () => jsonResponse('answer', { prompt_tokens: 12, completion_tokens: 3 }) });
    const accepted = await f.invoke('chat:send', f.payload({ sessionId: 'fallback-session' }));
    assert.equal(accepted.accepted, true);
    const result = await f.settle(accepted);
    assert.equal(result.content, 'answer');
    assert.equal(f.events.find(item => item.event?.type === AGENT_EVENTS.DONE)?.event.content, 'answer');
    const records = readRecords(usageFilePath(f.root)).records;
    assert.equal(records.length, 1); assert.equal(records[0].session, 'fallback-session');
    assert.equal(records[0].in, 12); assert.equal(records[0].out, 3);
    assert.equal(records[0].modelProfileId, accepted.modelSource.modelProfileId);
    assert.equal(records[0].modelSource.kind, 'api');
    assert.equal(f.events.filter(item => item.event?.type === AGENT_EVENTS.USAGE).length, 1);
    assert.equal(f.requests.length, 1); assert.equal(f.credentialReads.length, 0);
  });

  it('still meters an API call whose empty response is rejected', async t => {
    const f = loadMainFixture(t, { fetchFn: async () => jsonResponse('', { prompt_tokens: 4, completion_tokens: 0 }) });
    const accepted = await f.invoke('chat:send', f.payload({ sessionId: 'empty-session' }));
    assert.equal(accepted.accepted, true);
    const result = await f.settle(accepted);
    assert.equal(result.ok, false); assert.equal(result.code, 'MODEL_EMPTY_RESPONSE');
    const records = readRecords(usageFilePath(f.root)).records;
    assert.equal(records.length, 1); assert.equal(records[0].in, 4); assert.equal(records[0].out, 0);
    assert.equal(f.events.filter(item => item.event?.type === AGENT_EVENTS.USAGE).length, 1);
    assert.equal(f.events.filter(item => item.event?.type === AGENT_EVENTS.ERROR).length, 1);
    assert.equal(f.requests.length, 1);
  });

  it('returns compact usage and attributes its ledger row to the bound session', async t => {
    const f = loadMainFixture(t, { fetchFn: async () => jsonResponse('compact summary', { prompt_tokens: 20, completion_tokens: 5 }) });
    const messages = Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'message-' + index }));
    const accepted = await f.invoke('session:compact', f.payload({ sessionId: 'compact-session', clientRequestId: 'compact-usage-request', messages, force: true }));
    assert.equal(accepted.accepted, true); assert.equal(accepted.task.kind, 'session_compact');
    const result = await f.settle(accepted);
    assert.equal(result.ok, true); assert.equal(result.needed, true);
    assert.equal(result.usage.kind, 'compact'); assert.equal(result.usage.inputTokens, 20);
    const records = readRecords(usageFilePath(f.root)).records;
    assert.equal(records.length, 1); assert.equal(records[0].session, 'compact-session');
    assert.equal(records[0].kind, 'compact'); assert.equal(records[0].in, 20); assert.equal(records[0].out, 5);
    assert.equal(records[0].modelSource.kind, 'api');
    assert.equal(records[0].runId, accepted.runId); assert.equal(f.requests.length, 1);
  });
});
