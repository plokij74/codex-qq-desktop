'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { saveSettings } = require('../src/ai/settings');
const {
  usageFilePath,
  appendRecord,
  readRecords,
  clearRecords,
} = require('../src/ai/usage-store');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-main-usage-'));
const handlers = new Map();
let nextMessage = { role: 'assistant', content: 'answer' };

const app = {
  getPath: () => userData,
  requestSingleInstanceLock: () => true,
  whenReady: () => new Promise(() => {}),
  on: () => {},
  quit: () => {},
};
const BrowserWindow = function BrowserWindow() {};
BrowserWindow.getAllWindows = () => [];
BrowserWindow.getFocusedWindow = () => null;
const electronStub = {
  app,
  BrowserWindow,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  dialog: {},
  shell: {},
};
const openAiStub = {
  chatCompletionMessage: async () => nextMessage,
};

const originalLoad = Module._load;

function usageRecord(ts, extra = {}) {
  return {
    ts,
    session: 's',
    model: 'm',
    kind: 'main',
    in: 10,
    out: 2,
    cached: 0,
    est: false,
    cost: 1,
    cur: '$',
    ...extra,
  };
}

describe('D.3 main web and usage IPC behavior', () => {
  before(() => {
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === 'electron') return electronStub;
      if (request === './ai/openai-compatible' || request === './openai-compatible') {
        return openAiStub;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    require('../src/main');
    Module._load = originalLoad;
  });

  after(() => {
    Module._load = originalLoad;
  });

  it('registers the D.3 handlers and rejects manual fetch while disabled', async () => {
    for (const channel of ['chat:send', 'web:fetch', 'usage:summary', 'usage:clear']) {
      assert.equal(typeof handlers.get(channel), 'function', channel);
    }
    saveSettings(userData, { webEnabled: false });
    assert.deepEqual(await handlers.get('web:fetch')({}, { url: 'https://example.com' }), {
      ok: false,
      error: '网页访问未启用',
    });
  });

  it('filters by time and never adds costs from different currencies', async () => {
    const file = usageFilePath(userData);
    clearRecords(file);
    saveSettings(userData, { usageEnabled: true, usageCurrency: '$' });
    appendRecord(file, usageRecord(100, { cost: 0.1 }));
    appendRecord(file, usageRecord(200, { cost: 0.2, cur: 'EUR' }));
    appendRecord(file, usageRecord(300, { cost: 0.3, cur: 'JPY' }));

    const result = await handlers.get('usage:summary')({}, {
      from: 50,
      to: 250,
      groupBy: 'kind',
    });
    assert.equal(result.ok, true);
    assert.equal(result.totals.in, 20);
    assert.ok(Math.abs(result.totals.cost - 0.1) < 1e-9);
    assert.deepEqual(result.mixedCurrencies, ['EUR']);
  });

  it('clears the ledger and reports the disabled state', async () => {
    const file = usageFilePath(userData);
    assert.equal((await handlers.get('usage:clear')()).ok, true);
    assert.deepEqual(readRecords(file).records, []);
    saveSettings(userData, { usageEnabled: false });
    assert.equal((await handlers.get('usage:summary')({}, {})).ok, false);
    assert.equal((await handlers.get('usage:clear')()).ok, false);
  });

  it('meters fallback API chats when Agent is disabled', async () => {
    clearRecords(usageFilePath(userData));
    saveSettings(userData, {
      mode: 'api',
      apiKey: 'test-key',
      model: 'gpt-test',
      agentEnabled: false,
      memoryEnabled: false,
      usageEnabled: true,
      usagePricing: [],
    });
    nextMessage = {
      role: 'assistant',
      content: 'answer',
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    };
    const sent = [];
    const event = {
      sender: {
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    };
    const result = await handlers.get('chat:send')(event, {
      sessionId: 'fallback-session',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.content, 'answer');
    const records = readRecords(usageFilePath(userData)).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].session, 'fallback-session');
    assert.equal(records[0].in, 12);
    assert.equal(records[0].out, 3);
    assert.equal(sent.filter((item) => item.payload?.type === 'usage').length, 1);
  });

  it('still meters an API call whose empty response is rejected', async () => {
    clearRecords(usageFilePath(userData));
    nextMessage = {
      role: 'assistant',
      content: '',
      usage: { prompt_tokens: 4, completion_tokens: 0 },
    };
    const event = {
      sender: { isDestroyed: () => false, send: () => {} },
    };
    await assert.rejects(
      () => handlers.get('chat:send')(event, {
        sessionId: 'empty-session',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      /API 返回空内容/,
    );
    const records = readRecords(usageFilePath(userData)).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].in, 4);
  });

  it('returns compact usage and attributes its ledger row to the session', async () => {
    clearRecords(usageFilePath(userData));
    nextMessage = {
      role: 'assistant',
      content: 'compact summary',
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: 'message-' + index,
    }));
    const result = await handlers.get('session:compact')({}, {
      sessionId: 'compact-session',
      messages,
      force: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.needed, true);
    assert.equal(result.usage.kind, 'compact');
    assert.equal(result.usage.inputTokens, 20);
    const records = readRecords(usageFilePath(userData)).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].session, 'compact-session');
    assert.equal(records[0].kind, 'compact');
  });
});
