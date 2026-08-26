'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpRpcDispatcher, RPC_ERRORS } = require('../src/ai/mcp-rpc');

describe('mcp-rpc dispatcher', () => {
  it('multiplexes responses and answers server requests/notifications', async () => {
    const sent = [];
    const notifications = [];
    const dispatcher = createMcpRpcDispatcher({
      timeoutMs: 1000,
      send: (message) => sent.push(message),
      requestHandler: async (method, params) => {
        if (method === 'roots/list') return { roots: params?.ok ? [{ uri: 'file:///p' }] : [] };
        throw Object.assign(new Error('unknown'), { code: 'MCP_METHOD_NOT_FOUND' });
      },
      notificationHandler: (method) => notifications.push(method),
    });
    const pending = dispatcher.request('tools/list', {}, { replayable: true });
    assert.equal(sent[0].method, 'tools/list');
    dispatcher.dispatch({ jsonrpc: '2.0', id: sent[0].id, result: { tools: [] } });
    assert.deepEqual(await pending, { tools: [] });
    dispatcher.dispatch({ jsonrpc: '2.0', id: 44, method: 'roots/list', params: { ok: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.find((message) => message.id === 44).result, { roots: [{ uri: 'file:///p' }] });
    dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, ['notifications/tools/list_changed']);
  });

  it('returns method-not-found and emits cancellation on abort', async () => {
    const sent = [];
    const dispatcher = createMcpRpcDispatcher({ timeoutMs: 1000, send: (message) => sent.push(message) });
    dispatcher.dispatch({ jsonrpc: '2.0', id: 7, method: 'unsupported' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.find((message) => message.id === 7).error.code, RPC_ERRORS.METHOD_NOT_FOUND);
    const controller = new AbortController();
    const pending = dispatcher.request('slow', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'MCP_CANCELLED');
    assert.ok(sent.some((message) => message.method === 'notifications/cancelled'));
  });

  it('rejects immediately when the request signal was already aborted', async () => {
    const sent = [];
    const controller = new AbortController();
    controller.abort();
    const dispatcher = createMcpRpcDispatcher({ send: (message) => sent.push(message) });
    await assert.rejects(
      dispatcher.request('already-cancelled', {}, { signal: controller.signal }),
      (error) => error.code === 'MCP_CANCELLED',
    );
    assert.equal(sent.length, 0);
    assert.equal(dispatcher.getPending().length, 0);
  });

  it('propagates inbound cancellation to the server request handler', async () => {
    const sent = [];
    let inboundSignal;
    const dispatcher = createMcpRpcDispatcher({
      timeoutMs: 1000,
      send: (message) => sent.push(message),
      requestHandler: (_method, _params, _message, signal) => new Promise((resolve, reject) => {
        inboundSignal = signal;
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.code = 'MCP_CANCELLED';
          reject(error);
        }, { once: true });
      }),
    });
    dispatcher.dispatch({ jsonrpc: '2.0', id: 12, method: 'sampling/createMessage', params: {} });
    dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 12 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inboundSignal.aborted, true);
    assert.equal(sent.find((message) => message.id === 12).error.data.code, 'MCP_CANCELLED');
  });
});
