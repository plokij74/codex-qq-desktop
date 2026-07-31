'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  handleMemoryCommand,
  deleteResultMessage,
} = require('../src/renderer/memory-commands');

function depsFor(overrides = {}) {
  return {
    session: { id: 's1', messages: [] },
    projectPath: null,
    addMemory: async () => ({ ok: true, scope: 'user' }),
    listMemory: async () => ({
      ok: true,
      entries: [],
      counts: { project: 0, user: 0 },
      skipped: 0,
    }),
    deleteMemory: async () => ({ ok: true, removed: true }),
    toast() {},
    onMessagesChanged() {},
    ...overrides,
  };
}

describe('renderer memory commands', () => {
  it('handles bare remember as a usage error without calling IPC', () => {
    const toasts = [];
    let calls = 0;
    const handled = handleMemoryCommand('/remember', depsFor({
      addMemory: async () => { calls += 1; return { ok: true }; },
      toast: (message) => toasts.push(message),
    }));
    assert.equal(handled, true);
    assert.equal(calls, 0);
    assert.deepEqual(toasts, ['用法：/remember <要记住的事实>']);
  });

  it('handles bare forget as a usage error without calling IPC', () => {
    const toasts = [];
    let calls = 0;
    const handled = handleMemoryCommand('/forget', depsFor({
      deleteMemory: async () => { calls += 1; return { ok: true }; },
      toast: (message) => toasts.push(message),
    }));
    assert.equal(handled, true);
    assert.equal(calls, 0);
    assert.deepEqual(toasts, ['用法：/forget <id>，id 用 /memory 查看']);
  });

  it('forwards remember text with the captured project path', async () => {
    const calls = [];
    const toasts = [];
    handleMemoryCommand('/remember  构建只用 npm test  ', depsFor({
      projectPath: 'D:\\project-a',
      addMemory: async (payload) => {
        calls.push(payload);
        return { ok: true, scope: 'project', deduped: false };
      },
      toast: (message) => toasts.push(message),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ projectPath: 'D:\\project-a', text: '构建只用 npm test' }]);
    assert.deepEqual(toasts, ['已记住（项目级）']);
  });

  it('forwards forget id and reports a missing entry', async () => {
    const calls = [];
    const toasts = [];
    handleMemoryCommand('/forget m_123', depsFor({
      projectPath: 'D:\\project-a',
      deleteMemory: async (payload) => {
        calls.push(payload);
        return { ok: true, removed: false };
      },
      toast: (message) => toasts.push(message),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ projectPath: 'D:\\project-a', id: 'm_123' }]);
    assert.deepEqual(toasts, ['未找到该 id']);
  });

  it('appends an async memory listing to the captured session', async () => {
    const sessionA = { id: 'a', messages: [] };
    const sessionB = { id: 'b', messages: [] };
    let resolveList;
    let changedSession = null;
    const pending = new Promise((resolve) => { resolveList = resolve; });
    assert.equal(handleMemoryCommand('/memory', depsFor({
      session: sessionA,
      listMemory: () => pending,
      onMessagesChanged: (session) => { changedSession = session; },
    })), true);

    const activeSession = sessionB;
    resolveList({
      ok: true,
      entries: [{ id: 'm_1', scope: 'user', text: '回答一律中文' }],
      counts: { project: 0, user: 1 },
      skipped: 0,
    });
    await pending;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(activeSession.messages.length, 0);
    assert.equal(sessionA.messages.length, 1);
    assert.match(sessionA.messages[0].content, /回答一律中文/);
    assert.equal(changedSession, sessionA);
  });

  it('reports removed:false as not found', () => {
    assert.equal(deleteResultMessage({ ok: true, removed: false }), '未找到该 id');
  });

  it('returns false for unrelated slash commands', () => {
    assert.equal(handleMemoryCommand('/skills', depsFor()), false);
  });
});
