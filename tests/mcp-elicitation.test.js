'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateElicitationSchema,
  validateElicitationContent,
  checkElicitationUrl,
  createMcpElicitationController,
} = require('../src/ai/mcp-elicitation');

describe('mcp elicitation', () => {
  it('validates flat primitive form schemas and content', () => {
    const schema = validateElicitationSchema({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        color: { type: 'string', enum: ['red', 'blue'] },
      },
      required: ['email', 'count'],
    });
    assert.deepEqual(validateElicitationContent(schema, { email: 'a@example.com', count: 2, color: 'red' }), {
      email: 'a@example.com', count: 2, color: 'red',
    });
    assert.throws(() => validateElicitationContent(schema, { email: 'bad', count: 2 }), { code: 'MCP_ELICITATION_SCHEMA_INVALID' });
    assert.throws(() => validateElicitationSchema({ type: 'object', properties: { password: { type: 'string' } } }), { code: 'MCP_ELICITATION_SENSITIVE_FIELD' });
    assert.throws(() => validateElicitationSchema({ type: 'object', properties: { nested: { type: 'object' } } }), { code: 'MCP_ELICITATION_SCHEMA_INVALID' });
  });

  it('guards public HTTPS URL and requires both development switches for private URL', () => {
    assert.equal(checkElicitationUrl('https://example.com/connect?next=ok').host, 'example.com');
    assert.throws(() => checkElicitationUrl('http://example.com'), { code: 'MCP_ELICITATION_URL_INVALID' });
    assert.throws(() => checkElicitationUrl('https://example.com/?token=abc'), { code: 'MCP_ELICITATION_URL_INVALID' });
    assert.throws(() => checkElicitationUrl('http://127.0.0.1:43123', { allowPrivateUrl: true, devPrivateUrls: false }), { code: 'MCP_ELICITATION_URL_INVALID' });
    assert.equal(checkElicitationUrl('http://127.0.0.1:43123', { allowPrivateUrl: true, devPrivateUrls: true }).private, true);
  });

  it('keeps a FIFO queue with one foreground request', async () => {
    const events = [];
    const controller = createMcpElicitationController({ onEvent: (event) => events.push(event) });
    const first = controller.create('one', { message: 'first', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } });
    const second = controller.create('two', { message: 'second', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } });
    assert.equal(events.length, 1);
    const firstId = events[0].elicitationId;
    assert.equal(first.elicitationId, firstId);
    assert.equal(Object.keys(first).length, 0);
    controller.respond(firstId, 'accept', { name: 'ok' });
    const secondId = controller.list()[0].elicitationId;
    assert.equal(events.length, 2);
    controller.respond(secondId, 'decline');
    assert.deepEqual(await first, { action: 'accept', content: { name: 'ok' } });
    assert.deepEqual(await second, { action: 'decline' });
  });

  it('completes a request when the server sends elicitation/complete', async () => {
    const controller = createMcpElicitationController();
    const pending = controller.create('server', {
      message: 'waiting',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    });
    const id = pending.elicitationId;
    assert.equal(controller.complete(id), true);
    assert.deepEqual(await pending, { action: 'cancel' });
    assert.deepEqual(controller.list(), []);
  });
});
