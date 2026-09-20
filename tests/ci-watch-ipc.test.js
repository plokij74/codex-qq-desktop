'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createWorktreeIpcHandlers } = require('../src/ai/worktree-ipc');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d15-ipc-'));
  const roots = ['first', 'second'].map((name) => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
  const events = []; const aggregate = [];
  const worktrees = createWorktreeIpcHandlers({ manager: {} });
  const ipc = createEngineeringIpcHandlers({
    resolveBinding: (event, payload) => worktrees.resolveBinding(event, payload),
    githubCli: { getCiWatchRepository: () => new Promise(() => {}) },
    onCiWatchEvent: (event, owners) => events.push({ event, owners }), onEvent: (event) => aggregate.push(event),
  });
  const owner = (id) => ({ sender: { id, isDestroyed: () => false } });
  function bind(event, projectId, projectPath) {
    const previous = worktrees.listProjectPaths(event);
    const result = worktrees.bind(event, { projectId, projectPath });
    assert.equal(result.ok, true);
    for (const old of previous) if (!worktrees.hasProjectBinding(event, old)) ipc.dropProject(event, old);
    ipc.syncOwnerBindings(event, worktrees.listProjectPaths(event));
    return { projectBindingId: result.projectBindingId };
  }
  t.after(() => { ipc.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { roots, ipc, worktrees, owner, bind, events, aggregate };
}

describe('D15 watch IPC authorization and lifecycle', () => {
  it('rejects unknown target authority and cross-sender/project access', async (t) => {
    const f = fixture(t); const a = f.owner(7); const b = f.owner(8);
    const first = f.bind(a, 'a', f.roots[0]); const second = f.bind(a, 'b', f.roots[1]);
    for (const extra of [{ projectPath: f.roots[1] }, { headSha: 'a'.repeat(40) }, { runId: '7' }, { approval: true }, { host: 'evil.test' }, { command: 'anything' }]) {
      assert.equal((await f.ipc.ciWatchStart(a, { ...first, prNumber: 7, ...extra })).code, 'CI_WATCH_INVALID');
    }
    assert.equal((await f.ipc.ciWatchStart(b, { ...first, prNumber: 7 })).code, 'CI_WATCH_PROJECT_BINDING_INVALID');
    assert.equal((await f.ipc.ciWatchStart(a, { ...first, prNumber: '7' })).code, 'CI_WATCH_INVALID');
    const started = await f.ipc.ciWatchStart(a, { ...first, prNumber: 7, durationMinutes: 15 });
    assert.equal(started.ok, true);
    for (const action of ['ciWatchGet', 'ciWatchStop', 'ciWatchAck']) {
      assert.equal((await f.ipc[action](a, { ...second, watchRef: started.watchRef })).code, 'CI_WATCH_NOT_FOUND');
      assert.equal((await f.ipc[action](b, { ...first, watchRef: started.watchRef })).code, 'CI_WATCH_PROJECT_BINDING_INVALID');
      assert.equal((await f.ipc[action](a, { ...first, watchRef: '../forged' })).code, 'CI_WATCH_INVALID');
    }
    assert.equal((await f.ipc.ciWatchList(a, second)).watches.length, 0);
  });
  it('rechecks a binding invalidated between dispatch and action', async (t) => {
    const f = fixture(t); const a = f.owner(7); const binding = f.bind(a, 'a', f.roots[0]);
    const pending = f.ipc.ciWatchStart(a, { ...binding, prNumber: 7 });
    f.worktrees.unbind(a, binding);
    assert.equal((await pending).code, 'CI_WATCH_PROJECT_BINDING_INVALID');
    assert.equal(f.events.length, 0);
  });
  it('uses dedicated project-owned events without broadcasting or expensive aggregate refreshes', async (t) => {
    const f = fixture(t); const a = f.owner(7); const b = f.owner(8);
    const first = f.bind(a, 'a', f.roots[0]); f.bind(b, 'b', f.roots[1]);
    const started = await f.ipc.ciWatchStart(a, { ...first, prNumber: 7 });
    assert.equal(f.events[0].event.type, 'engineering:ci-watch:event');
    assert.deepEqual(f.events[0].owners, [7]);
    assert.equal(f.aggregate.length, 0);
    assert.doesNotMatch(JSON.stringify(f.events), /projectPath|repoRoot|runs|stdout|token|command/);
    assert.equal(f.ipc.ciWatchNavigation(8, started.watch.projectKey, started.watchRef), null);
    assert.equal(f.ipc.ciWatchNavigation(7, started.watch.projectKey, started.watchRef).prNumber, 7);
  });
  it('preserves a watch across renderer reload but revokes navigation until rebinding', async (t) => {
    const f = fixture(t); const a = f.owner(7); const binding = f.bind(a, 'a', f.roots[0]);
    const started = await f.ipc.ciWatchStart(a, { ...binding, prNumber: 7 });
    f.worktrees.dropSender(7); f.ipc.dropSender(7);
    assert.equal(f.ipc.ciWatchNavigation(7, started.watch.projectKey, started.watchRef), null);
    const rebound = f.bind(a, 'a', f.roots[0]);
    const next = await f.ipc.ciWatchStart(a, { ...rebound, prNumber: 7 });
    assert.equal(next.watchRef, started.watchRef);
    assert.equal(next.existing, true);
    assert.equal((await f.ipc.ciWatchList(a, rebound)).watches.length, 1);
  });
  it('ends a directory-rebound watch only when its last project owner is gone', async (t) => {
    const f = fixture(t); const a = f.owner(7); const b = f.owner(8);
    const first = f.bind(a, 'a', f.roots[0]); const duplicate = f.bind(b, 'b', f.roots[0]);
    const started = await f.ipc.ciWatchStart(a, { ...first, prNumber: 7 });
    f.bind(a, 'a', f.roots[1]);
    assert.equal((await f.ipc.ciWatchGet(b, { ...duplicate, watchRef: started.watchRef })).watch.status, 'starting');
    assert.deepEqual(f.ipc.ciWatchOwnerIds(started.watch.projectKey), [8]);
    f.worktrees.unbind(b, duplicate); f.ipc.dropProject(b, f.roots[0]);
    const later = f.bind(b, 'b', f.roots[0]);
    const record = (await f.ipc.ciWatchGet(b, { ...later, watchRef: started.watchRef })).watch;
    assert.equal(record.status, 'stopped');
    assert.equal(record.unread, false);
  });
});

describe('D15 preload boundary', () => {
  it('reconstructs narrow payloads and unsubscribes both dedicated listeners', async () => {
    const calls = []; const listeners = new Map(); let api;
    const stub = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: {
      invoke: (channel, payload) => { calls.push([channel, payload]); return Promise.resolve({ ok: true }); },
      on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
    } };
    const original = Module._load;
    try {
      Module._load = function load(request, parent, isMain) { return request === 'electron' ? stub : original.call(this, request, parent, isMain); };
      delete require.cache[require.resolve('../src/preload')]; require('../src/preload');
    } finally { Module._load = original; }
    const payload = { projectBindingId: 'pb_owned', watchRef: 'ciw_owned', prNumber: 7, durationMinutes: 60, projectPath: 'forged', host: 'evil', command: 'forged', headSha: 'forged', sessionId: 'forged' };
    for (const method of ['startCiWatch', 'listCiWatches', 'getCiWatch', 'stopCiWatch', 'ackCiWatch']) await api[method](payload);
    assert.deepEqual(calls, [
      ['engineering:ci-watch:start', { projectBindingId: 'pb_owned', prNumber: 7, durationMinutes: 60 }],
      ['engineering:ci-watch:list', { projectBindingId: 'pb_owned' }],
      ...['get', 'stop', 'ack'].map((method) => [`engineering:ci-watch:${method}`, { projectBindingId: 'pb_owned', watchRef: 'ciw_owned' }]),
    ]);
    const received = [];
    const off = [api.onCiWatchEvent((value) => received.push(value)), api.onCiWatchNavigate((value) => received.push(value))];
    for (const listener of listeners.values()) listener({}, { watchRef: 'public' });
    assert.equal(received.length, 2);
    off.forEach((unsubscribe) => unsubscribe()); assert.equal(listeners.size, 0);
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    for (const action of ['start', 'list', 'get', 'stop', 'ack']) assert.ok(main.includes(`ipcMain.handle('engineering:ci-watch:${action}'`));
    assert.match(main, /previousPaths = worktreeIpc\.listProjectPaths\(event\)/);
    assert.match(main, /engineering\.syncOwnerBindings\(event, worktreeIpc\.listProjectPaths\(event\)\)/);
  });
});
