'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpSessionManager, configFingerprint } = require('../src/ai/mcp-session-manager');

function mockClient(state) {
  return {
    async start() { state.starts += 1; },
    async close() { state.closes += 1; },
    async reconnect() { state.reconnects += 1; },
  };
}

describe('mcp session manager', () => {
  it('reuses recovery sessions and closes non-recovery sessions on release', async () => {
    let now = 1000;
    const state = { starts: 0, closes: 0, reconnects: 0 };
    const manager = createMcpSessionManager({ now: () => now, createClient: () => mockClient(state), idleMs: 100 });
    const cfg = { name: 'srv', transport: 'stdio', command: 'mock', sessionRecovery: true };
    const first = await manager.acquire(cfg);
    await first.release();
    const second = await manager.acquire(cfg);
    assert.equal(state.starts, 1);
    assert.equal(second.status().reusable, true);
    await second.release();
    now += 101;
    await manager.sweep();
    assert.equal(state.closes, 1);

    const nonRecovery = await manager.acquire({ ...cfg, name: 'one-shot', sessionRecovery: false });
    await nonRecovery.release();
    assert.equal(state.closes, 2);
  });

  it('fingerprint excludes authorization secrets and preserves transport identity', () => {
    assert.equal(configFingerprint({ name: 'a', transport: 'http', url: 'https://example.com', headers: { Authorization: 'a' } }), configFingerprint({ name: 'a', transport: 'http', url: 'https://example.com', headers: { Authorization: 'b' } }));
    assert.notEqual(configFingerprint({ name: 'a', transport: 'http', url: 'https://example.com' }), configFingerprint({ name: 'a', transport: 'sse', url: 'https://example.com' }));
  });

  it('keeps concurrent recovery acquires isolated by run context', async () => {
    let resolveStart;
    const startGate = new Promise((resolve) => { resolveStart = resolve; });
    let starts = 0;
    const created = [];
    const manager = createMcpSessionManager({
      createClient: (opts) => {
        created.push(opts);
        return {
          async start() { starts += 1; await startGate; },
          async close() {},
        };
      },
    });
    const cfg = { name: 'srv', transport: 'stdio', command: 'mock', sessionRecovery: true };
    const firstPromise = manager.acquire(cfg, {
      projectPath: 'project-a',
      rootsProvider: () => ({ roots: [{ name: 'old' }] }),
      samplingHandler: () => ({ content: 'old' }),
    });
    const secondPromise = manager.acquire(cfg, {
      projectPath: 'project-a',
      rootsProvider: () => ({ roots: [{ name: 'current' }] }),
      samplingHandler: () => ({ content: 'current' }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 2);
    resolveStart();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.notEqual(first.client, second.client);
    assert.equal(created.length, 2);
    assert.deepEqual(created[0].rootsProvider().roots, [{ name: 'old' }]);
    assert.deepEqual(created[0].samplingHandler().content, 'old');
    assert.deepEqual(created[1].rootsProvider().roots, [{ name: 'current' }]);
    assert.deepEqual(created[1].samplingHandler().content, 'current');
    await first.release();
    await second.release();
    assert.throws(() => created[0].rootsProvider(), (error) => error.code === 'MCP_METHOD_NOT_FOUND');
    assert.throws(() => created[1].rootsProvider(), (error) => error.code === 'MCP_METHOD_NOT_FOUND');
  });

  it('keeps overlapping non-recovery acquires isolated', async () => {
    const clients = [];
    const manager = createMcpSessionManager({
      createClient: () => {
        const client = { async start() {}, async close() {} };
        clients.push(client);
        return client;
      },
    });
    const cfg = { name: 'srv', transport: 'stdio', command: 'mock', sessionRecovery: false };
    const first = await manager.acquire(cfg, { projectPath: 'project-a' });
    const second = await manager.acquire(cfg, { projectPath: 'project-a' });
    assert.equal(clients.length, 2);
    assert.notEqual(first.client, second.client);
    await first.release();
    await second.release();
  });

  it('invalidates retained sessions from previous project bindings', async () => {
    const state = { closes: 0 };
    const manager = createMcpSessionManager({
      createClient: () => ({ async start() {}, async close() { state.closes += 1; } }),
    });
    const cfg = { name: 'srv', transport: 'stdio', command: 'mock', sessionRecovery: true };
    const first = await manager.acquire(cfg, { projectPath: 'project-a' });
    await first.release();
    const second = await manager.acquire(cfg, { projectPath: 'project-b' });
    await second.release();
    assert.equal(await manager.invalidateOtherProjects('project-b'), 1);
    assert.equal(state.closes, 1);
  });

  it('keeps a leased startup task recovery session across project switches', async () => {
    const state = { closes: 0 };
    const manager = createMcpSessionManager({
      createClient: () => ({ async start() {}, async close() { state.closes += 1; } }),
    });
    const cfg = { name: 'tasks', transport: 'stdio', command: 'mock', sessionRecovery: false };
    const lease = await manager.acquire(cfg, { taskRecovery: true });
    assert.equal(await manager.invalidateOtherProjects('project-a'), 0);
    assert.equal(state.closes, 0);
    await lease.release();
    assert.equal(state.closes, 1);
  });
});
