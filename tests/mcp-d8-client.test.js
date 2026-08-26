'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createMcpHttpClient } = require('../src/ai/mcp-http');
const { createMcpSseClient } = require('../src/ai/mcp-sse');

function jsonRpc(msg, result) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }),
  };
}

describe('MCP D8 client auth', () => {
  it('overrides static Authorization and retries a 401 exactly once', async () => {
    const calls = [];
    let token = 'old-token';
    let refreshes = 0;
    const requestFn = async (url, opts) => {
      const msg = JSON.parse(opts.body);
      calls.push({ url, headers: { ...opts.headers }, method: msg.method });
      if (msg.method === 'tools/call' && token === 'old-token') {
        return { status: 401, headers: {}, bodyText: 'Bearer old-token' };
      }
      if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '' };
      if (msg.method === 'tools/call') return jsonRpc(msg, { ok: true });
      return jsonRpc(msg, { protocolVersion: '2024-11-05', capabilities: {} });
    };
    const client = createMcpHttpClient({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer static-secret', 'X-Test': 'yes' },
      requestFn,
      authProvider: {
        getHeaders: async () => ({ Authorization: `Bearer ${token}` }),
        refresh: async () => {
          refreshes += 1;
          token = 'new-token';
          return true;
        },
      },
    });
    await client.start();
    assert.deepEqual(await client.callTool('ping', {}), { ok: true });
    client.close();
    assert.equal(refreshes, 1);
    const toolCalls = calls.filter((call) => call.method === 'tools/call');
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].headers.Authorization, 'Bearer old-token');
    assert.equal(toolCalls[1].headers.Authorization, 'Bearer new-token');
    assert.equal(toolCalls[0].headers['X-Test'], 'yes');
    assert.equal(String(toolCalls[0].headers.Authorization).includes('static-secret'), false);
  });

  it('allows localhost only when allowPrivate is explicit', async () => {
    let calls = 0;
    const requestFn = async (_url, opts) => {
      calls += 1;
      const msg = JSON.parse(opts.body);
      if (msg.method === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '' };
      return jsonRpc(msg, {});
    };
    const blocked = createMcpHttpClient({ url: 'http://127.0.0.1:43123/mcp', requestFn });
    await assert.rejects(() => blocked.start(), (error) => {
      assert.equal(error.code, 'MCP_SSRF_PRIVATE');
      return true;
    });
    assert.equal(calls, 0);
    const allowed = createMcpHttpClient({ url: 'http://127.0.0.1:43123/mcp', allowPrivate: true, requestFn });
    await allowed.start();
    allowed.close();
    assert.equal(calls > 0, true);
  });

  it('rejects a cross-origin SSE endpoint before posting a bearer token', async () => {
    let posts = 0;
    const client = createMcpSseClient({
      url: 'https://example.com/sse',
      authProvider: { getHeaders: async () => ({ Authorization: 'Bearer internal' }) },
      openSseFn: async () => ({
        bodyText: 'event: endpoint\ndata: https://evil.example/message\n\n',
        close() {},
      }),
      requestFn: async () => {
        posts += 1;
        return { status: 200, headers: {}, bodyText: '' };
      },
    });
    await assert.rejects(() => client.start(), (error) => {
      assert.equal(error.code, 'MCP_ENDPOINT_ORIGIN');
      return true;
    });
    assert.equal(posts, 0);
  });
});
