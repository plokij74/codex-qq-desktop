'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('../src/ai/agent');
const { createRegistry } = require('../src/ai/extensions/registry');
const { createWebProvider } = require('../src/ai/providers/web');

function settings() {
  return {
    mode: 'api',
    model: 'test',
    maxAgentTurns: 5,
    verifyBeforeDone: false,
    hooksEnabled: false,
    webEnabled: true,
    webAllowDomains: [],
    webDenyDomains: [],
    webTimeoutMs: 15000,
    webMaxBytes: 524288,
    webMaxChars: 15000,
  };
}

function registryWith(fetchImpl) {
  const registry = createRegistry();
  registry.register(createWebProvider({ fetchImpl }));
  return registry;
}

function toolCall(id, url) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: 'web_fetch', arguments: JSON.stringify({ url }) },
    }],
  };
}

describe('web_fetch agent authorization', () => {
  it('does not repeat approval or I/O for a cached URL in the same run', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'web-agent-'));
    let approvals = 0;
    let fetches = 0;
    let turn = 0;

    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: settings(),
      messages: [{ role: 'user', content: 'read twice' }],
      gate: {
        authorize: async () => { approvals += 1; return { allowed: true }; },
      },
      registry: registryWith(async (url) => {
        fetches += 1;
        return { ok: true, url, status: 200, text: 'ok', truncated: false, redirects: [] };
      }),
      chatFn: async () => {
        turn += 1;
        if (turn <= 2) return toolCall(`web-${turn}`, 'https://example.com/a');
        return { role: 'assistant', content: 'done' };
      },
      sessionKey: 'web-cache',
    });

    assert.equal(approvals, 1);
    assert.equal(fetches, 1);
  });

  it('rejects a guarded URL before approval or provider execution', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'web-agent-'));
    let approvals = 0;
    let fetches = 0;
    let turn = 0;

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: settings(),
      messages: [{ role: 'user', content: 'read private' }],
      gate: {
        authorize: async () => { approvals += 1; return { allowed: true }; },
      },
      registry: registryWith(async () => {
        fetches += 1;
        return { ok: true, url: 'http://127.0.0.1/', status: 200, text: 'bad' };
      }),
      chatFn: async () => {
        turn += 1;
        if (turn === 1) return toolCall('web-private', 'http://127.0.0.1/');
        return { role: 'assistant', content: 'denied' };
      },
      sessionKey: 'web-private',
    });

    assert.equal(approvals, 0);
    assert.equal(fetches, 0);
    assert.equal(result.agentLog.find((step) => step.tool === 'web_fetch')?.ok, false);
  });
});
