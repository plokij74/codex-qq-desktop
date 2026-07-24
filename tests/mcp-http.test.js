'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHttpClient } = require('../src/ai/mcp-http');
const { createMcpClient } = require('../src/ai/mcp-client');

function makeRequestFn() {
  const calls = [];
  const requestFn = async (url, opts) => {
    const msg = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, headers: opts.headers, msg });
    if (msg && msg.method === 'initialize') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'h' },
          },
        }),
      };
    }
    if (msg && msg.method === 'tools/list') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
          },
        }),
      };
    }
    if (msg && msg.method === 'tools/call') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'pong' }] },
        }),
      };
    }
    if (msg && msg.method === 'resources/list') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { resources: [{ uri: 'file://a', name: 'a' }] },
        }),
      };
    }
    if (msg && msg.method === 'resources/read') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { contents: [{ text: 'hi' }] },
        }),
      };
    }
    if (msg && msg.method === 'notifications/initialized') {
      return { status: 202, headers: {}, bodyText: '' };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        jsonrpc: '2.0',
        id: msg && msg.id,
        result: {},
      }),
    };
  };
  return { requestFn, calls };
}

describe('createMcpHttpClient', () => {
  it('initialize + listTools via mock requestFn', async () => {
    const { requestFn, calls } = makeRequestFn();
    const c = createMcpHttpClient({ url: 'https://example.com/mcp', requestFn });
    await c.start();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'ping');
    await c.close();

    const methods = calls.map((x) => x.msg && x.msg.method);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('notifications/initialized'));
    assert.ok(methods.includes('tools/list'));
    const initCall = calls.find((x) => x.msg && x.msg.method === 'initialize');
    assert.match(
      String(initCall.headers.Accept || initCall.headers.accept || ''),
      /application\/json/
    );
    assert.match(
      String(initCall.headers.Accept || initCall.headers.accept || ''),
      /text\/event-stream/
    );
    assert.equal(initCall.headers['Content-Type'] || initCall.headers['content-type'], 'application/json');
  });

  it('callTool + listResources + readResource', async () => {
    const { requestFn } = makeRequestFn();
    const c = createMcpHttpClient({ url: 'https://example.com/mcp', requestFn });
    await c.start();
    const result = await c.callTool('ping', {});
    assert.deepEqual(result, { content: [{ type: 'text', text: 'pong' }] });
    const resources = await c.listResources();
    assert.equal(resources[0].uri, 'file://a');
    const resource = await c.readResource('file://a');
    assert.deepEqual(resource, { contents: [{ text: 'hi' }] });
    c.close();
  });

  it('listResources returns [] when resources/list fails', async () => {
    const requestFn = async (_url, opts) => {
      const msg = JSON.parse(opts.body);
      if (msg.method === 'initialize') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'h' } },
          }),
        };
      }
      if (msg.method === 'notifications/initialized') {
        return { status: 202, headers: {}, bodyText: '' };
      }
      if (msg.method === 'resources/list') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
      };
    };
    const c = createMcpHttpClient({ url: 'https://example.com/mcp', requestFn });
    await c.start();
    assert.deepEqual(await c.listResources(), []);
    c.close();
  });

  it('parses SSE text/event-stream response body', async () => {
    const requestFn = async (_url, opts) => {
      const msg = JSON.parse(opts.body);
      if (msg.method === 'initialize') {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'sse' },
          },
        });
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          bodyText: `event: message\ndata: ${payload}\n\n`,
        };
      }
      if (msg.method === 'notifications/initialized') {
        return { status: 202, headers: {}, bodyText: '' };
      }
      if (msg.method === 'tools/list') {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] },
        });
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          bodyText: `data: ${payload}\n\n`,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
      };
    };
    const c = createMcpHttpClient({ url: 'https://example.com/mcp', requestFn });
    await c.start();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'echo');
    c.close();
  });

  it('forwards custom headers and rejects after close', async () => {
    const { requestFn, calls } = makeRequestFn();
    const c = createMcpHttpClient({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      requestFn,
    });
    await c.start();
    c.close();
    await assert.rejects(() => c.listTools(), /closed/i);
    const initCall = calls.find((x) => x.msg && x.msg.method === 'initialize');
    assert.equal(initCall.headers.Authorization, 'Bearer t');
  });
});

describe('createMcpClient factory http', () => {
  it('routes transport=http to http client', async () => {
    const { requestFn } = makeRequestFn();
    const c = createMcpClient({
      transport: 'http',
      url: 'https://example.com/mcp',
      requestFn,
    });
    await c.start();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'ping');
    c.close();
  });
});
