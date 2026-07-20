'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHub, sanitizeToolPart } = require('../src/ai/mcp-hub');
const { createMcpProvider } = require('../src/ai/providers/mcp');
const { createDefaultRegistry } = require('../src/ai/providers');

describe('sanitizeToolPart', () => {
  it('replaces non-alnum with underscore', () => {
    assert.equal(sanitizeToolPart('foo.bar-baz'), 'foo_bar_baz');
    assert.equal(sanitizeToolPart('read/file'), 'read_file');
  });

  it('falls back to tool when empty', () => {
    assert.equal(sanitizeToolPart(''), 'tool');
    assert.equal(sanitizeToolPart(null), 'tool');
  });
});

describe('createMcpHub', () => {
  function mockClient({ tools = [], callResult = { ok: true }, failStart = false } = {}) {
    const state = { started: false, closed: false, calls: [] };
    return {
      state,
      createClient() {
        return {
          async start() {
            if (failStart) throw new Error('start failed');
            state.started = true;
          },
          async listTools() {
            return tools;
          },
          async callTool(name, args) {
            state.calls.push({ name, args });
            if (callResult instanceof Error) throw callResult;
            return callResult;
          },
          async close() {
            state.closed = true;
          },
        };
      },
    };
  }

  it('names tools mcp_server_tool and resolves collisions', async () => {
    const mock = mockClient({
      tools: [
        { name: 'status', description: 's', inputSchema: { type: 'object', properties: {} } },
        { name: 'status', description: 'dup' },
      ],
    });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 'git', command: 'echo' }], {});
    const defs = hub.getToolDefs();
    assert.deepEqual(
      defs.map((d) => d.function.name),
      ['mcp_git_status', 'mcp_git_status_2']
    );
    await hub.stopAll();
    assert.equal(mock.state.closed, true);
  });

  it('sanitizes tool name parts', async () => {
    const mock = mockClient({
      tools: [{ name: 'list-files/v1', description: 'x' }],
    });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 'fs', command: 'node' }], {});
    assert.equal(hub.getToolDefs()[0].function.name, 'mcp_fs_list_files_v1');
    await hub.stopAll();
  });

  it('call routes to server and truncates large results', async () => {
    const big = 'x'.repeat(33 * 1024);
    const mock = mockClient({
      tools: [{ name: 'dump' }],
      callResult: big,
    });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 's1', command: 'c' }], {});
    const r = await hub.call('mcp_s1_dump', { a: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(r.result.length, 32 * 1024);
    assert.deepEqual(mock.state.calls[0], { name: 'dump', args: { a: 1 } });
    await hub.stopAll();
  });

  it('skips invalid server config and reports status', async () => {
    const statuses = [];
    const hub = createMcpHub({
      createClient: () => {
        throw new Error('should not create');
      },
    });
    await hub.startAll(
      [{ name: 'bad name!', command: 'x' }, { name: 'ok', command: '' }],
      { onStatus: (s) => statuses.push(s) }
    );
    assert.ok(statuses.every((s) => s.ok === false));
    assert.equal(hub.getToolDefs().length, 0);
  });

  it('stopAll clears route so call fails after stop', async () => {
    const mock = mockClient({ tools: [{ name: 't' }], callResult: 'hi' });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 's', command: 'c' }], {});
    assert.equal((await hub.call('mcp_s_t', {})).ok, true);
    await hub.stopAll();
    const r = await hub.call('mcp_s_t', {});
    assert.equal(r.ok, false);
  });

  it('closes client when listTools fails after start', async () => {
    const state = { started: false, closed: false };
    const hub = createMcpHub({
      createClient() {
        return {
          async start() {
            state.started = true;
          },
          async listTools() {
            throw new Error('listTools boom');
          },
          async callTool() {
            return {};
          },
          async close() {
            state.closed = true;
          },
        };
      },
    });
    const statuses = [];
    await hub.startAll(
      [{ name: 'bad', command: 'c' }],
      { onStatus: (s) => statuses.push(s) }
    );
    assert.equal(state.started, true);
    assert.equal(state.closed, true);
    assert.equal(hub.getToolDefs().length, 0);
    assert.ok(statuses.some((s) => s.server === 'bad' && s.ok === false));
  });
});

describe('createMcpProvider', () => {
  it('isEnabled requires mcpEnabled, servers, depth 0, not plan', () => {
    const p = createMcpProvider();
    assert.equal(p.isEnabled({
      settings: { mcpEnabled: true, mcpServers: [{ name: 'a', command: 'c' }] },
      subagentDepth: 0,
      agentMode: 'agent',
    }), true);
    assert.equal(p.isEnabled({
      settings: { mcpEnabled: false, mcpServers: [{ name: 'a', command: 'c' }] },
      subagentDepth: 0,
      agentMode: 'agent',
    }), false);
    assert.equal(p.isEnabled({
      settings: { mcpEnabled: true, mcpServers: [] },
      subagentDepth: 0,
      agentMode: 'agent',
    }), false);
    assert.equal(p.isEnabled({
      settings: { mcpEnabled: true, mcpServers: [{ name: 'a', command: 'c' }] },
      subagentDepth: 1,
      agentMode: 'agent',
    }), false);
    assert.equal(p.isEnabled({
      settings: { mcpEnabled: true, mcpServers: [{ name: 'a', command: 'c' }] },
      subagentDepth: 0,
      agentMode: 'plan',
    }), false);
  });

  it('onRunStart / getTools / onRunEnd lifecycle with mock hub path via real hub inject', async () => {
    // Provider uses createMcpHub internally; we only assert empty tools when hub not started
    const p = createMcpProvider();
    const ctx = {
      settings: { mcpEnabled: true, mcpServers: [] },
      extensions: {},
      project: { path: '/tmp' },
      onEvent: () => {},
    };
    assert.deepEqual(p.getTools(ctx), []);
    await p.onRunEnd(ctx);
  });

  it('onRunEnd is no-op at subagentDepth >= 1 (does not stop parent hub)', async () => {
    const p = createMcpProvider();
    let stopped = false;
    const hub = {
      async stopAll() {
        stopped = true;
      },
    };
    const ctx = {
      subagentDepth: 1,
      extensions: { mcpHub: hub },
    };
    await p.onRunEnd(ctx);
    assert.equal(stopped, false);
    assert.equal(ctx.extensions.mcpHub, hub);
  });
});

describe('default registry includes mcp', () => {
  it('registers mcp provider', () => {
    const reg = createDefaultRegistry({
      getToolDefs: () => [],
      executeTool: async () => '{}',
      runLoop: async () => ({}),
    });
    const ids = reg.listProviders().map((p) => p.id);
    assert.ok(ids.includes('mcp'));
    assert.ok(ids.includes('builtin'));
    assert.ok(ids.includes('skills'));
    assert.ok(ids.includes('explore'));
  });
});
