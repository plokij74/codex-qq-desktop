'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpSseClient } = require('../src/ai/mcp-sse');
const { createMcpClient } = require('../src/ai/mcp-client');

function makeRequestFn(postUrl = 'https://example.com/message') {
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
            serverInfo: { name: 'sse-srv' },
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
  return { requestFn, calls, postUrl };
}

function makeOpenSseFn(bodyText, getUrl = 'https://example.com/sse') {
  const calls = [];
  let closed = false;
  const openSseFn = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers });
    return {
      bodyText,
      close: () => {
        closed = true;
      },
    };
  };
  return { openSseFn, calls, isClosed: () => closed, getUrl };
}

describe('createMcpSseClient', () => {
  it('start opens SSE, uses endpoint event for POST, initialize + listTools', async () => {
    const { requestFn, calls } = makeRequestFn();
    const { openSseFn, calls: sseCalls } = makeOpenSseFn(
      'event: endpoint\ndata: https://example.com/message\n\n'
    );
    const c = createMcpSseClient({
      url: 'https://example.com/sse',
      openSseFn,
      requestFn,
    });
    await c.start();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'ping');
    c.close();

    assert.equal(sseCalls.length, 1);
    assert.equal(sseCalls[0].url, 'https://example.com/sse');
    assert.match(
      String(sseCalls[0].headers.Accept || sseCalls[0].headers.accept || ''),
      /text\/event-stream/
    );

    const methods = calls.map((x) => x.msg && x.msg.method);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('notifications/initialized'));
    assert.ok(methods.includes('tools/list'));
    assert.ok(calls.every((x) => x.url === 'https://example.com/message'));
  });

  it('relative endpoint resolves against SSE url', async () => {
    const { requestFn, calls } = makeRequestFn();
    const { openSseFn } = makeOpenSseFn('event: endpoint\ndata: /message\n\n');
    const c = createMcpSseClient({
      url: 'https://example.com/sse',
      openSseFn,
      requestFn,
    });
    await c.start();
    await c.listTools();
    c.close();
    assert.ok(calls.every((x) => x.url === 'https://example.com/message'));
  });

  it('without endpoint event POSTs to same url', async () => {
    const { requestFn, calls } = makeRequestFn();
    const { openSseFn } = makeOpenSseFn('event: ping\ndata: {}\n\n');
    const c = createMcpSseClient({
      url: 'https://example.com/sse',
      openSseFn,
      requestFn,
    });
    await c.start();
    await c.listTools();
    c.close();
    assert.ok(calls.every((x) => x.url === 'https://example.com/sse'));
  });

  it('callTool + listResources + readResource', async () => {
    const { requestFn } = makeRequestFn();
    const { openSseFn } = makeOpenSseFn(
      'event: endpoint\ndata: https://example.com/message\n\n'
    );
    const c = createMcpSseClient({
      url: 'https://example.com/sse',
      openSseFn,
      requestFn,
    });
    await c.start();
    const result = await c.callTool('ping', {});
    assert.deepEqual(result, { content: [{ type: 'text', text: 'pong' }] });
    const resources = await c.listResources();
    assert.equal(resources[0].uri, 'file://a');
    const resource = await c.readResource('file://a');
    assert.deepEqual(resource, { contents: [{ text: 'hi' }] });
    c.close();
  });

  it('uses optional sseUrl for GET while defaulting POST to url until endpoint', async () => {
    const { requestFn, calls } = makeRequestFn();
    const { openSseFn, calls: sseCalls } = makeOpenSseFn(
      'event: endpoint\ndata: https://example.com/message\n\n'
    );
    const c = createMcpSseClient({
      url: 'https://example.com/post',
      sseUrl: 'https://example.com/events',
      openSseFn,
      requestFn,
    });
    await c.start();
    c.close();
    assert.equal(sseCalls[0].url, 'https://example.com/events');
    assert.ok(calls.every((x) => x.url === 'https://example.com/message'));
  });

  it('forwards custom headers and rejects after close; closes SSE', async () => {
    const { requestFn, calls } = makeRequestFn();
    const { openSseFn, isClosed } = makeOpenSseFn(
      'event: endpoint\ndata: https://example.com/message\n\n'
    );
    const c = createMcpSseClient({
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer t' },
      openSseFn,
      requestFn,
    });
    await c.start();
    c.close();
    assert.equal(isClosed(), true);
    await assert.rejects(() => c.listTools(), /closed/i);
    const initCall = calls.find((x) => x.msg && x.msg.method === 'initialize');
    assert.equal(initCall.headers.Authorization, 'Bearer t');
  });
});

describe('createMcpClient factory sse', () => {
  it('routes transport=sse to sse client', async () => {
    const { requestFn } = makeRequestFn();
    const { openSseFn } = makeOpenSseFn(
      'event: endpoint\ndata: https://example.com/message\n\n'
    );
    const c = createMcpClient({
      transport: 'sse',
      url: 'https://example.com/sse',
      openSseFn,
      requestFn,
    });
    await c.start();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'ping');
    c.close();
  });
});
