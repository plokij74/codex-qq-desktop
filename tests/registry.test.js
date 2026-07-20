const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../src/ai/extensions/registry');

describe('extension registry', () => {
  it('collects tools from enabled providers only', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'a',
      isEnabled: () => true,
      getTools: () => [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object', properties: {} } } }],
      execute: async () => JSON.stringify({ ok: true }),
    });
    reg.register({
      id: 'b',
      isEnabled: () => false,
      getTools: () => [{ type: 'function', function: { name: 'tool_b', parameters: { type: 'object', properties: {} } } }],
      execute: async () => JSON.stringify({ ok: true }),
    });
    const tools = await reg.collectTools({});
    assert.deepEqual(tools.map((t) => t.function.name), ['tool_a']);
  });

  it('routes execute by tool name', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'a',
      isEnabled: () => true,
      getTools: () => [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }],
      execute: async (name, args) => JSON.stringify({ ok: true, name, args }),
    });
    const raw = await reg.execute('echo', { x: 1 }, {});
    assert.deepEqual(JSON.parse(raw), { ok: true, name: 'echo', args: { x: 1 } });
  });

  it('unknown tool returns ok false', async () => {
    const reg = createRegistry();
    const raw = await reg.execute('nope', {}, {});
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /未知|unknown/i);
  });

  it('onRunStart and onRunEnd order', async () => {
    const reg = createRegistry();
    const log = [];
    reg.register({
      id: 'p',
      isEnabled: () => true,
      getTools: () => [],
      execute: async () => '{}',
      onRunStart: async () => { log.push('start'); },
      onRunEnd: async () => { log.push('end'); },
    });
    await reg.onRunStart({});
    await reg.onRunEnd({});
    assert.deepEqual(log, ['start', 'end']);
  });

  it('systemFragments joins non-empty', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'p',
      isEnabled: () => true,
      getTools: () => [],
      execute: async () => '{}',
      getSystemFragment: () => 'FRAG',
    });
    assert.match(await reg.systemFragments({}), /FRAG/);
  });
});
