'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHub, sanitizeToolPart } = require('../src/ai/mcp-hub');
const { createMcpTaskManager } = require('../src/ai/mcp-task-manager');
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
  function mockClient({
    tools = [],
    resources = [],
    callResult = { ok: true },
    readResult = { contents: [] },
    failStart = false,
  } = {}) {
    const state = { started: false, closed: false, calls: [], reads: [], createArgs: [] };
    return {
      state,
      createClient(cfg) {
        state.createArgs.push(cfg);
        return {
          async start() {
            if (failStart) throw new Error('start failed');
            state.started = true;
          },
          async listTools() {
            return tools;
          },
          async listResources() {
            return resources;
          },
          async readResource(uri) {
            state.reads.push(uri);
            if (readResult instanceof Error) throw readResult;
            return readResult;
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
    const names = defs.map((d) => d.function.name);
    assert.ok(names.includes('mcp_git_status'));
    assert.ok(names.includes('mcp_git_status_2'));
    assert.ok(names.includes('mcp_resources_list'));
    assert.ok(names.includes('mcp_resource_read'));
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

  it('rejects non-http url for http/sse transport', async () => {
    const statuses = [];
    let createCount = 0;
    const hub = createMcpHub({
      createClient() {
        createCount += 1;
        throw new Error('should not create for file url');
      },
    });
    await hub.startAll(
      [
        { name: 'filehttp', transport: 'http', url: 'file:///etc/passwd' },
        { name: 'filesse', transport: 'sse', url: 'file:///tmp/x' },
        { name: 'noturl', transport: 'http', url: 'not-a-url' },
      ],
      { onStatus: (s) => statuses.push(s) }
    );
    assert.equal(createCount, 0);
    assert.ok(statuses.length >= 3);
    assert.ok(statuses.every((s) => s.ok === false && s.error === 'invalid config'));
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

  it('skips disabled servers', async () => {
    let createCount = 0;
    const hub = createMcpHub({
      createClient(cfg) {
        createCount += 1;
        return {
          async start() {},
          async listTools() {
            return [{ name: 't' }];
          },
          async listResources() {
            return [];
          },
          async readResource() {
            return {};
          },
          async callTool() {
            return {};
          },
          async close() {},
        };
      },
    });
    await hub.startAll(
      [
        { name: 'off', command: 'c', enabled: false },
        { name: 'on', command: 'c', enabled: true },
      ],
      {}
    );
    assert.equal(createCount, 1);
    const names = hub.getToolDefs().map((d) => d.function.name);
    assert.ok(names.includes('mcp_on_t'));
    assert.ok(!names.some((n) => n.startsWith('mcp_off_')));
    await hub.stopAll();
  });

  it('registers resource tools when connected', async () => {
    const mock = mockClient({
      tools: [{ name: 'ping' }],
      resources: [{ uri: 'file://a', name: 'a', description: 'A', mimeType: 'text/plain' }],
    });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 's1', command: 'c', transport: 'stdio' }], {});
    assert.deepEqual(mock.state.createArgs[0].transport, 'stdio');
    const names = hub.getToolDefs().map((d) => d.function.name);
    assert.ok(names.includes('mcp_s1_ping'));
    assert.ok(names.includes('mcp_resources_list'));
    assert.ok(names.includes('mcp_resource_read'));
    const listed = await hub.call('mcp_resources_list', {});
    assert.equal(listed.ok, true);
    assert.equal(listed.resources.length, 1);
    assert.equal(listed.resources[0].server, 's1');
    assert.equal(listed.resources[0].uri, 'file://a');
    await hub.stopAll();
    assert.equal(hub.getToolDefs().length, 0);
  });

  it('mcp_resource_read returns truncated content', async () => {
    const big = 'y'.repeat(33 * 1024);
    const mock = mockClient({
      tools: [],
      resources: [{ uri: 'mem://big' }],
      readResult: { contents: [{ text: big }] },
    });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll([{ name: 'rs', command: 'c' }], {});
    const r = await hub.call('mcp_resource_read', { server: 'rs', uri: 'mem://big' });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(typeof r.contents, 'string');
    assert.equal(r.contents.length, 32 * 1024);
    assert.deepEqual(mock.state.reads, ['mem://big']);
    await hub.stopAll();
  });

  it('does not register dynamic tools with reserved resource names', async () => {
    const mock = mockClient({
      tools: [
        { name: 'list' },
        { name: 'read' },
      ],
    });
    // server name "resources" + tool "list" → mcp_resources_list (reserved)
    // server name "resource" + tool "read" → mcp_resource_read (reserved)
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll(
      [
        { name: 'resources', command: 'c' },
        { name: 'resource', command: 'c' },
      ],
      {}
    );
    const names = hub.getToolDefs().map((d) => d.function.name);
    assert.ok(names.includes('mcp_resources_list'));
    assert.ok(names.includes('mcp_resource_read'));
    // reserved fixed tools present once; dynamic collisions renamed or skipped
    assert.equal(names.filter((n) => n === 'mcp_resources_list').length, 1);
    assert.equal(names.filter((n) => n === 'mcp_resource_read').length, 1);
    // dynamic tools should still be reachable under non-reserved names
    assert.ok(names.some((n) => n.startsWith('mcp_resources_') && n !== 'mcp_resources_list'));
    assert.ok(names.some((n) => n.startsWith('mcp_resource_') && n !== 'mcp_resource_read'));
    await hub.stopAll();
  });

  it('passes full cfg including transport to createClient', async () => {
    const mock = mockClient({ tools: [] });
    const hub = createMcpHub({ createClient: mock.createClient });
    await hub.startAll(
      [{ name: 'http1', transport: 'http', url: 'http://127.0.0.1:9', headers: { a: '1' } }],
      { cwd: '/proj' }
    );
    assert.equal(mock.state.createArgs.length, 1);
    const arg = mock.state.createArgs[0];
    assert.equal(arg.transport, 'http');
    assert.equal(arg.url, 'http://127.0.0.1:9');
    assert.deepEqual(arg.headers, { a: '1' });
    await hub.stopAll();
  });

  it('passes project cwd to the session manager unless the server overrides it', async () => {
    const acquired = [];
    const client = {
      async listTools() { return []; },
      async listResources() { return []; },
      async listPrompts() { return []; },
    };
    const sessionManager = {
      async acquire(cfg) {
        acquired.push(cfg);
        return {
          client,
          async release() {},
          status: () => ({ server: cfg.name, state: 'connected', reusable: true }),
        };
      },
      status() { return []; },
    };
    const hub = createMcpHub({ sessionManager });

    await hub.startAll([{ name: 'project-cwd', command: 'node' }], { cwd: '/project' });
    assert.equal(acquired[0].cwd, '/project');
    assert.equal(acquired[0].transport, 'stdio');

    await hub.startAll([{ name: 'server-cwd', command: 'node', cwd: '/server' }], { cwd: '/project' });
    assert.equal(acquired[1].cwd, '/server');
    await hub.stopAll();
  });
  it('routes optional and required task-support tools only when server capability is declared', async () => {
    const taskManager = createMcpTaskManager({ safeStorage: { isEncryptionAvailable: () => false } });
    const calls = [];
    const client = {
      async start() {},
      async close() {},
      async listTools() {
        return [
          { name: 'required', execution: { taskSupport: 'required' }, inputSchema: { type: 'object' } },
          { name: 'optional', execution: { taskSupport: 'optional' }, inputSchema: { type: 'object' } },
          { name: 'sync', execution: { taskSupport: 'forbidden' }, inputSchema: { type: 'object' } },
        ];
      },
      async listResources() { return []; },
      async listPrompts() { return []; },
      getServerCapabilities() { return { tasks: { requests: { tools: { call: {} } } } }; },
      async callTool(name, args, options) { calls.push({ name, args, options }); return { task: { taskId: 'remote-optional', status: 'working' } }; },
    };
    const hub = createMcpHub({ taskManager, createClient: () => client });
    await hub.startAll([{ name: 'demo', command: 'x', transport: 'stdio', tasks: { enabled: true } }], {});
    const names = hub.getToolDefs().map((item) => item.function.name);
    assert.ok(names.includes('mcp_demo_required'));
    assert.ok(names.includes('mcp_demo_optional'));
    assert.ok(names.includes('mcp_demo_sync'));
    const result = await hub.call('mcp_demo_optional', {});
    assert.equal(result.task.status, 'working');
    assert.equal(calls[0].options.task.ttl > 0, true);
    await hub.stopAll();
    taskManager.close();
  });

  it('runs persisted task restoration only for the startup recovery hub', async () => {
    let restoreCalls = 0;
    let releaseCalls = 0;
    const client = {
      async start() {},
      async close() {},
      async listTools() { return []; },
      async listResources() { return []; },
      async listPrompts() { return []; },
      getServerCapabilities() { return {}; },
    };
    const taskManager = {
      async restore() { restoreCalls += 1; },
      registerClient() {},
      hasConnectionHoldingTasks() { return false; },
      hasActiveTasks() { return false; },
    };
    const sessionManager = {
      async acquire() {
        return {
          client,
          async release() { releaseCalls += 1; },
          status: () => ({ state: 'connected' }),
        };
      },
      status() { return []; },
    };
    const hub = createMcpHub({ sessionManager, taskManager });
    const config = [{ name: 'demo', command: 'node', tasks: { enabled: true } }];

    await hub.startAll(config, { sessionId: 'ordinary-run' });
    assert.equal(restoreCalls, 0);
    await hub.stopAll();

    await hub.startAll(config, { taskRecovery: true });
    assert.equal(restoreCalls, 1);
    assert.equal(releaseCalls, 2);
    await hub.stopAll();
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
