'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionGate } = require('../src/ai/permission');
const { createMcpSamplingController, ERROR_CODES, validateRequest } = require('../src/ai/mcp-sampling');

describe('mcp sampling', () => {
  it('validates limits and denies all-server context', () => {
    assert.throws(() => validateRequest({ messages: [], maxTokens: 1 }), (error) => error.code === ERROR_CODES.CONTENT_INVALID);
    const gate = createPermissionGate({ onApprovalNeeded: () => {} });
    const controller = createMcpSamplingController({ settings: { mode: 'api', model: 'm', baseUrl: 'https://api.test' }, gate, serverConfig: () => ({ sampling: { enabled: true } }) });
    return assert.rejects(() => controller.createMessage('srv', { messages: [{ role: 'user', content: 'x' }], includeContext: 'allServers' }), (error) => error.code === ERROR_CODES.CONTEXT_DENIED);
  });

  it('requires approval even in full-auto and sends no tools', async () => {
    let approval;
    const gate = createPermissionGate({ permissionMode: 'full-auto', onApprovalNeeded: (payload) => { approval = payload; } });
    const calls = [];
    const controller = createMcpSamplingController({
      settings: { mode: 'api', model: 'm', baseUrl: 'https://api.test', usagePricing: [] },
      gate,
      sessionKey: 'session',
      serverConfig: () => ({ name: 'srv', sampling: { enabled: true } }),
      chatFn: async (opts) => { calls.push(opts); return { role: 'assistant', content: 'ok', usage: { prompt_tokens: 2, completion_tokens: 3 } }; },
    });
    const pending = controller.createMessage('srv', { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(approval.source, 'mcp-sampling');
    assert.equal(approval.server, 'srv');
    gate.resolveApproval(approval.approvalId, 'allow');
    const result = await pending;
    assert.equal(result.content, 'ok');
    assert.equal(calls[0].tools, undefined);
    assert.equal(calls[0].stream, false);
  });

  it('reports a provider timeout distinctly from an abort', async () => {
    let approval;
    const gate = createPermissionGate({ onApprovalNeeded: (payload) => { approval = payload; } });
    const controller = createMcpSamplingController({
      timeoutMs: 20,
      settings: { mode: 'api', model: 'm', baseUrl: 'https://api.test' },
      gate,
      sessionKey: 'timeout-session',
      serverConfig: () => ({ name: 'srv', sampling: { enabled: true } }),
      chatFn: () => new Promise(() => {}),
    });
    const pending = controller.createMessage('srv', { messages: [{ role: 'user', content: 'hello' }] });
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolveApproval(approval.approvalId, 'allow');
    await assert.rejects(pending, (error) => error.code === ERROR_CODES.TIMEOUT);
  });
});
