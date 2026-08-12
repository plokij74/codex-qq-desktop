'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorktreeIpcHandlers } = require('../src/ai/worktree-ipc');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-ipc-'));
  const calls = [];
  const manager = new Proxy({}, { get: (_target, name) => async (args) => {
    calls.push([name, args]);
    return { ok: true, results: [], result: { id: args.resultId } };
  } });
  const handlers = createWorktreeIpcHandlers({ manager });
  const event = { sender: { id: 42 } };
  return { root, calls, handlers, event };
}

describe('D5 worktree IPC boundary', () => {
  it('binds a canonical project and requires the sender-scoped opaque token', async () => {
    const { root, calls, handlers, event } = setup();
    const bound = handlers.bind(event, { projectId: 'p1', projectPath: root });
    assert.equal(bound.ok, true);
    assert.match(bound.projectBindingId, /^pb_[a-f0-9]{32}$/);
    const listed = await handlers.list(event, { projectBindingId: bound.projectBindingId });
    assert.equal(listed.ok, true);
    const listCall = calls.find((entry) => entry[0] === 'list');
    assert.ok(listCall);
    assert.equal(listCall[1].projectPath, root);
    assert.equal(await handlers.list(event, { projectBindingId: 'pb_bad' }).then((r) => r.code), 'RESULT_NOT_FOUND');
    assert.equal(await handlers.get(event, { projectBindingId: bound.projectBindingId, resultId: '../x' }).then((r) => r.code), 'RESULT_NOT_FOUND');
    assert.equal(handlers.unbind(event, { projectBindingId: bound.projectBindingId }).ok, true);
    assert.equal(await handlers.list(event, { projectBindingId: bound.projectBindingId }).then((r) => r.code), 'RESULT_NOT_FOUND');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not accept renderer paths on result mutation and enforces busy gate', async () => {
    const { root, handlers, event } = setup();
    const bound = handlers.bind(event, { projectId: 'p1', projectPath: root });
    const injectedPath = await handlers.apply(event, {
      projectBindingId: bound.projectBindingId,
      resultId: 'wt_ab12cd34',
      projectPath: path.join(root, 'other'),
    });
    assert.equal(injectedPath.ok, true);

    let busy = true;
    const guarded = createWorktreeIpcHandlers({
      manager: { apply: async () => ({ ok: true }) },
      isBusy: () => busy,
      withMutation: async (fn) => fn(),
    });
    const token = guarded.bind(event, { projectId: 'p1', projectPath: root }).projectBindingId;
    const result = await guarded.apply(event, { projectBindingId: token, resultId: 'wt_ab12cd34' });
    assert.equal(result.code, 'BUSY');
    busy = false;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports deferred recovery while the app is busy', async () => {
    const { root, event } = setup();
    let recoveryCalls = 0;
    const handlers = createWorktreeIpcHandlers({
      manager: {
        recover: async () => { recoveryCalls += 1; return { ok: true }; },
        list: async () => ({ ok: true, results: [], warnings: ['existing'] }),
      },
      isBusy: () => true,
    });
    const token = handlers.bind(event, { projectId: 'p1', projectPath: root }).projectBindingId;
    const listed = await handlers.list(event, { projectBindingId: token });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.warnings, ['existing', 'RECOVERY_DEFERRED_BUSY']);
    assert.equal(recoveryCalls, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
