'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHub, promptResultToText } = require('../src/ai/mcp-hub');

function promptClient() {
  return {
    async start() {},
    async close() {},
    async listTools() { return []; },
    async listResources() { return []; },
    async listPrompts() { return [{ name: 'review', description: 'Review code' }]; },
    async getPrompt(name, args) { return { messages: [{ role: 'user', content: { type: 'text', text: `${name}:${args.lang || 'en'}` } }] }; },
  };
}

describe('mcp prompts', () => {
  it('lists and gets prompts without exposing unsupported content', async () => {
    const hub = createMcpHub({ createClient: () => promptClient() });
    await hub.startAll([{ name: 'srv', command: 'mock' }]);
    const listed = await hub.listPrompts('srv');
    assert.deepEqual(listed.prompts[0], { server: 'srv', name: 'review', description: 'Review code', arguments: [] });
    const got = await hub.getPrompt('srv', 'review', { lang: 'zh' });
    assert.equal(got.text, 'user: review:zh');
    assert.throws(() => promptResultToText({ messages: [{ role: 'user', content: { type: 'image', data: 'secret' } }] }), (error) => error.code === 'MCP_PROMPT_CONTENT_UNSUPPORTED');
    await hub.stopAll();
  });
});
