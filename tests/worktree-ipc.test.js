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

  it('routes PR mutations through the binding and validates opened URLs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-pr-ipc-'));
    const seen = [];
    const opened = [];
    const result = {
      id: 'wt_ab12cd34', canOpenPr: true,
      pr: { host: 'github.com', owner: 'acme', repo: 'widget', number: 7, url: 'https://github.com/acme/widget/pull/7' },
    };
    const manager = {
      createPr: async (args) => { seen.push(args); return { ok: true, result }; },
      getPr: async () => ({
        ok: true,
        repo: { host: result.pr.host, owner: result.pr.owner, repo: result.pr.repo },
        pr: { number: result.pr.number, url: result.pr.url },
      }),
    };
    const handlers = createWorktreeIpcHandlers({ manager, openExternal: async (url) => opened.push(url) });
    const event = { sender: { id: 77 } };
    const token = handlers.bind(event, { projectId: 'p1', projectPath: root }).projectBindingId;
    const created = await handlers.createPr(event, {
      projectBindingId: token,
      resultId: 'wt_ab12cd34',
      projectPath: 'D:/injected',
      title: 'Title',
      body: 'Body',
      draft: true,
    });
    assert.equal(created.ok, true);
    assert.equal(seen[0].projectPath, root);
    assert.equal(seen[0].title, 'Title');
    const openedResult = await handlers.openPr(event, { projectBindingId: token, resultId: 'wt_ab12cd34' });
    assert.equal(openedResult.ok, true);
    assert.deepEqual(opened, ['https://github.com/acme/widget/pull/7']);

    result.pr.url = 'https://evil.example/acme/widget/pull/7';
    const rejected = await handlers.openPr(event, { projectBindingId: token, resultId: 'wt_ab12cd34' });
    assert.equal(rejected.code, 'PR_INVALID');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('routes lifecycle PR reads and writes without accepting repository authority', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-pr-life-ipc-'));
    const calls = [];
    let busy = false;
    const manager = {
      listPrs: async (args) => { calls.push(['listPrs', args]); return { ok: true, prs: [] }; },
      getPr: async (args) => { calls.push(['getPr', args]); return { ok: true, pr: { number: args.number } }; },
      editPr: async (args) => { calls.push(['editPr', args]); return { ok: true, pr: { number: args.number } }; },
      mergePr: async (args) => { calls.push(['mergePr', args]); return { ok: true, pr: { number: args.number } }; },
    };
    const handlers = createWorktreeIpcHandlers({ manager, isBusy: () => busy, withMutation: async (fn) => fn() });
    const event = { sender: { id: 91 } };
    const token = handlers.bind(event, { projectId: 'p1', projectPath: root }).projectBindingId;
    await handlers.listPrs(event, { projectBindingId: token, state: 'merged', repo: 'evil/repo' });
    await handlers.getPr(event, { projectBindingId: token, number: 12, host: 'evil.example' });
    await handlers.editPr(event, { projectBindingId: token, number: 12, title: 'Title', body: 'Body', repo: 'evil/repo' });
    await handlers.mergePr(event, { projectBindingId: token, number: 12, method: 'rebase', url: 'https://evil.example/x' });
    assert.equal(calls[0][1].projectPath, root);
    assert.equal(calls[0][1].state, 'merged');
    assert.deepEqual(calls[1][1], { projectPath: root, number: 12 });
    assert.equal(calls[2][1].title, 'Title');
    assert.equal('repo' in calls[2][1], false);
    assert.equal(calls[3][1].method, 'rebase');
    assert.equal('url' in calls[3][1], false);
    assert.equal((await handlers.getPr(event, { projectBindingId: token, number: 12, resultId: 'wt_ab12cd34' })).code, 'PR_INVALID');
    busy = true;
    assert.equal((await handlers.editPr(event, { projectBindingId: token, number: 12, title: 'x', body: 'y' })).code, 'BUSY');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
