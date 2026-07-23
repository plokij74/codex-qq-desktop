const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createExploreProvider } = require('../src/ai/providers/explore');
const { createPermissionGate } = require('../src/ai/permission');

describe('explore provider', () => {
  it('rejects short goal', async () => {
    const p = createExploreProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const raw = await p.execute('spawn_explore', { goal: 'ab' }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
      extensions: {},
    });
    assert.equal(JSON.parse(raw).ok, false);
  });

  it('rejects nested spawn', async () => {
    const p = createExploreProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const raw = await p.execute('spawn_explore', { goal: 'find auth module' }, {
      subagentDepth: 1,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
      extensions: {},
    });
    assert.match(JSON.parse(raw).error, /禁止|子 Agent/);
  });

  it('calls runLoop with depth 1 and readonly tools only', async () => {
    let seen;
    const p = createExploreProvider({
      runLoop: async (opts) => {
        seen = opts;
        return { content: 'summary here', turns: 2, agentLog: [{ tool: 'grep', ok: true, summary: '1' }] };
      },
    });
    const events = [];
    const gate = createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' });
    const raw = await p.execute('spawn_explore', { goal: 'find auth module', maxTurns: 3 }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true, maxAgentTurns: 8 },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate,
      onEvent: (e) => events.push(e),
      extensions: {},
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, 'explore');
    assert.ok(parsed.subagentId);
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.settings.maxAgentTurns, 3);
    assert.ok(events.some((e) => e.type === 'subagent-start'));
    assert.ok(events.some((e) => e.type === 'subagent-end'));
  });

  it('spawn_explore result includes kind and subagentId', async () => {
    const p = createExploreProvider({
      runLoop: async () => ({ content: 'done', turns: 1, agentLog: [] }),
    });
    const raw = await p.execute('spawn_explore', { goal: 'find auth module' }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
      onEvent: () => {},
      extensions: {},
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, 'explore');
    assert.ok(parsed.subagentId);
    assert.ok(parsed.summary);
  });

  it('spawn_explores returns ordered results', async () => {
    const p = createExploreProvider({
      runLoop: async (opts) => ({
        content: 'out:' + opts.messages[0].content,
        turns: 1,
        agentLog: [],
      }),
    });
    const raw = await p.execute('spawn_explores', {
      goals: ['goal one value', 'goal two value'],
    }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true, exploreMaxParallel: 2 },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
      onEvent: () => {},
      extensions: {},
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.parallel, true);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].kind, 'explore');
    assert.ok(parsed.results[0].subagentId);
    assert.equal(parsed.results[0].summary, 'out:goal one value');
    assert.equal(parsed.results[1].summary, 'out:goal two value');
  });

  it('does not pass parent mcpHub to child extensions', async () => {
    let seen;
    const parentHub = { stopAll: async () => {} };
    const p = createExploreProvider({
      runLoop: async (opts) => {
        seen = opts;
        return { content: 'ok', turns: 1, agentLog: [] };
      },
    });
    await p.execute('spawn_explore', { goal: 'find auth module' }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
      onEvent: () => {},
      extensions: { mcpHub: parentHub, other: 1 },
    });
    assert.ok(seen);
    assert.equal(seen.extensions.mcpHub, undefined);
    assert.equal(seen.extensions.other, 1);
    assert.equal(seen.subagentDepth, 1);
  });

  it('exposes spawn_explore and spawn_explores tools', () => {
    const p = createExploreProvider({ runLoop: async () => ({}) });
    const names = p.getTools().map((t) => t.function.name);
    assert.deepEqual(names, ['spawn_explore', 'spawn_explores']);
  });
});
