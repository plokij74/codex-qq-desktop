'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMcpTaskManager,
  MAX_ACTIVE_PER_SERVER,
  MAX_ACTIVE,
  MAX_HISTORY,
} = require('../src/ai/mcp-task-manager');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

describe('mcp task manager', () => {
  it('creates opaque tool refs, polls, bounds result and supports claim', async () => {
    let clock = Date.now();
    let state = 'working';
    const events = [];
    const client = {
      getTask: async () => ({ status: state, pollInterval: 1000 }),
      getTaskResult: async () => ({ content: [{ type: 'text', text: 'done' }] }),
      cancelTask: async () => {},
    };
    const manager = createMcpTaskManager({
      now: () => clock,
      safeStorage: fakeSafeStorage(false),
      onEvent: (event) => events.push(event),
    });
    const created = manager.registerToolTask({
      serverName: 'demo',
      transport: 'http',
      client,
      toolName: 'long_task',
      createResult: { task: { taskId: 'remote-1', status: 'working', ttl: 3600000, pollInterval: 1000 } },
    });
    assert.match(created.taskRef, /^mcp_task_/);
    assert.equal(manager.get(created.taskRef).resultAvailable, false);
    const createdEvent = events.find((event) => event.reason === 'created');
    assert.equal('remoteTaskId' in createdEvent, false);
    assert.equal('result' in createdEvent, false);
    assert.doesNotMatch(JSON.stringify(createdEvent), /remote-1/);
    state = 'completed';
    await manager.poll(created.taskRef);
    assert.equal(manager.get(created.taskRef).status, 'completed');
    assert.equal((await manager.result(created.taskRef)).content[0].text, 'done');
    const prepared = await manager.prepareResultClaim(created.taskRef, 'session-1');
    const committed = await manager.commitResultClaim(prepared.claimId, 'session-1');
    assert.equal(committed.targetSessionId, 'session-1');
    assert.equal(manager.get(created.taskRef).localDisposition, 'claimed');
    clock += 1000;
    manager.close();
  });

  it('fetches a completed result before releasing the task connection', async () => {
    let released = false;
    let resultSawOpenConnection = false;
    const client = {
      getTask: async () => ({ status: 'completed' }),
      getTaskResult: async () => {
        resultSawOpenConnection = !released;
        return { content: [{ type: 'text', text: 'finished' }] };
      },
    };
    const manager = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const created = manager.registerToolTask({
      serverName: 'demo',
      transport: 'stdio',
      client,
      releaseConnection: async () => { released = true; },
      createResult: { task: { taskId: 'remote-complete', status: 'working' } },
    });

    await manager.poll(created.taskRef);
    assert.equal(resultSawOpenConnection, true);
    assert.equal(released, true);
    assert.equal((await manager.result(created.taskRef)).content[0].text, 'finished');
    manager.close();
  });

  it('cancels remotely, abandons locally, expires TTL and marks missing recovery as orphaned', async () => {
    let now = Date.now();
    let cancelled = 0;
    const client = { cancelTask: async () => { cancelled += 1; }, getTask: async () => ({ status: 'working' }) };
    const manager = createMcpTaskManager({ now: () => now, safeStorage: fakeSafeStorage(false), defaultTtlMs: 60000 });
    const a = manager.createTask({ serverName: 'demo', remoteTaskId: 'a', client });
    await manager.cancel(a.taskRef);
    assert.equal(cancelled, 1);
    const b = manager.createTask({ serverName: 'demo', remoteTaskId: 'b', client });
    manager.abandon(b.taskRef);
    assert.equal(manager.get(b.taskRef).localDisposition, 'abandoned');
    const c = manager.createTask({ serverName: 'demo', remoteTaskId: 'c', client, ttl: 60000 });
    now += 60001;
    await manager.poll(c.taskRef);
    assert.equal(manager.get(c.taskRef).status, 'failed');
    assert.equal(manager.get(c.taskRef).statusMessage, 'MCP task TTL expired');
    const d = manager.createTask({ serverName: 'demo', remoteTaskId: 'd', sourceSessionId: 'old' });
    const restored = await manager.restore({ sessionId: 'new', getClient: () => null });
    assert.deepEqual(restored, []);
    assert.equal(manager.get(d.taskRef).localDisposition, 'orphaned');
    manager.close();
  });

  it('enforces the active task limits and keeps terminal history bounded', () => {
    const perServer = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    for (let index = 0; index < MAX_ACTIVE_PER_SERVER; index += 1) {
      perServer.createTask({ serverName: 'one-server', remoteTaskId: `per-server-${index}` });
    }
    assert.throws(
      () => perServer.createTask({ serverName: 'one-server', remoteTaskId: 'per-server-overflow' }),
      { code: 'MCP_TASK_LIMIT' },
    );
    perServer.close();

    const global = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    for (let index = 0; index < MAX_ACTIVE; index += 1) {
      global.createTask({ serverName: `server-${index}`, remoteTaskId: `global-${index}` });
    }
    assert.throws(
      () => global.createTask({ serverName: 'another-server', remoteTaskId: 'global-overflow' }),
      { code: 'MCP_TASK_LIMIT' },
    );
    global.close();

    const history = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const refs = [];
    for (let index = 0; index <= MAX_HISTORY; index += 1) {
      refs.push(history.createTask({
        serverName: 'history',
        remoteTaskId: `terminal-${index}`,
        status: 'completed',
      }).taskRef);
    }
    assert.equal(history.list().length, MAX_HISTORY);
    assert.throws(() => history.get(refs[0]), { code: 'MCP_TASK_NOT_FOUND' });
    assert.equal(history.get(refs.at(-1)).status, 'completed');
    history.close();
  });

  it('allows only MCP task state-machine transitions', async () => {
    const manager = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const task = manager.createTask({
      serverName: 'demo',
      remoteTaskId: 'state-machine',
      client: { getTaskResult: async () => ({ content: [] }) },
    });

    assert.equal(manager.notifyTaskStatus('demo', { taskId: 'state-machine', status: 'input_required' }), true);
    assert.equal(manager.get(task.taskRef).status, 'input_required');
    assert.equal(manager.notifyTaskStatus('demo', { taskId: 'state-machine', status: 'working' }), true);
    assert.equal(manager.get(task.taskRef).status, 'working');
    assert.equal(manager.notifyTaskStatus('demo', { taskId: 'state-machine', status: 'completed' }), true);
    assert.equal(manager.get(task.taskRef).status, 'completed');
    assert.throws(
      () => manager.notifyTaskStatus('demo', { taskId: 'state-machine', status: 'working' }),
      { code: 'MCP_TASK_STATUS_INVALID' },
    );
    manager.close();
  });

  it('restores encrypted tool tasks, keeps orphaned monitoring, and releases after result fetch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-restore-'));
    const file = path.join(root, 'tasks.json');
    const first = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    const created = first.createTask({
      serverName: 'demo',
      serverConfigFingerprint: 'fingerprint-a',
      remoteTaskId: 'remote-restart',
      sourceSessionId: 'session-before-restart',
      sourceProjectPath: 'C:\\project-before-restart',
    });
    first.close();

    let released = 0;
    const client = {
      getTask: async () => ({ status: 'completed' }),
      getTaskResult: async () => ({ content: [{ type: 'text', text: 'restored result' }] }),
    };
    const second = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    assert.equal(second.get(created.taskRef).needsRecovery, true);
    assert.deepEqual(second.recoveryServerNames(() => 'fingerprint-a'), ['demo']);
    assert.deepEqual(second.recoveryServerNames(() => 'fingerprint-b'), []);
    const restored = await second.restore({
      getClient: () => client,
      getConfigFingerprint: () => 'fingerprint-a',
      releaseConnection: async () => { released += 1; },
    });
    assert.equal(restored.length, 1);
    assert.equal(second.get(created.taskRef).localDisposition, 'orphaned');
    await second.poll(created.taskRef);
    assert.equal(second.get(created.taskRef).status, 'completed');
    assert.equal(second.get(created.taskRef).canClaim, true);
    assert.equal(released, 1);
    const prepared = await second.prepareResultClaim(created.taskRef, 'session-after-restart');
    await second.commitResultClaim(prepared.claimId, 'session-after-restart');
    assert.equal(second.get(created.taskRef).localDisposition, 'claimed');
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not orphan a recoverable task when the matching server is temporarily unavailable', async () => {
    const manager = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const created = manager.createTask({
      serverName: 'demo',
      serverConfigFingerprint: 'fingerprint-a',
      remoteTaskId: 'remote-temporary-failure',
    });
    const restored = await manager.restore({
      getClient: () => null,
      getConfigFingerprint: () => 'fingerprint-a',
    });
    assert.deepEqual(restored, []);
    assert.equal(manager.get(created.taskRef).localDisposition, null);
    assert.equal(manager.get(created.taskRef).needsRecovery, true);
    assert.equal(manager.get(created.taskRef).canCancel, false);
    assert.equal(manager.get(created.taskRef).canAbandon, true);
    assert.equal(manager.get(created.taskRef).statusMessage, 'MCP task recovery connection unavailable');
    await assert.rejects(() => manager.cancel(created.taskRef), { code: 'MCP_TASK_CANCEL_FAILED' });
    manager.close();
  });

  it('reattaches temporarily unavailable recovery tasks when a matching client returns', async () => {
    const manager = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const created = manager.createTask({
      serverName: 'demo',
      serverConfigFingerprint: 'fingerprint-a',
      remoteTaskId: 'remote-reconnect',
      sourceSessionId: 'old-session',
      sourceProjectPath: 'C:\\old-project',
    });
    await manager.restore({ getClient: () => null, getConfigFingerprint: () => 'fingerprint-a' });
    assert.equal(manager.get(created.taskRef).needsRecovery, true);

    const client = {
      getTask: async () => ({ status: 'completed' }),
      getTaskResult: async () => ({ value: 'reconnected result' }),
    };
    assert.equal(manager.registerClient('demo', client, {
      recover: true,
      serverConfigFingerprint: 'fingerprint-a',
      sessionId: 'new-session',
      projectPath: 'C:\\new-project',
    }), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.get(created.taskRef).localDisposition, 'orphaned');
    assert.equal(manager.get(created.taskRef).resultAvailable, true);
    assert.deepEqual(await manager.result(created.taskRef), { value: 'reconnected result' });
    manager.close();
  });

  it('recovers a completed tool task whose result was not fetched before restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-result-restore-'));
    const file = path.join(root, 'tasks.json');
    const first = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    const created = first.createTask({
      serverName: 'demo',
      serverConfigFingerprint: 'fingerprint-a',
      remoteTaskId: 'remote-completed',
      status: 'completed',
    });
    first.close();

    const second = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    assert.equal(second.get(created.taskRef).needsRecovery, true);
    assert.equal(second.get(created.taskRef).canAbandon, true);
    assert.equal(second.get(created.taskRef).canClaim, false);
    assert.equal(second.canChangeServer('demo'), false);
    const restored = await second.restore({
      getClient: () => ({ getTaskResult: async () => ({ value: 'late result' }) }),
      getConfigFingerprint: () => 'fingerprint-a',
    });
    assert.equal(restored.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await second.result(created.taskRef), { value: 'late result' });
    assert.equal(second.get(created.taskRef).needsRecovery, false);
    assert.equal(second.get(created.taskRef).canClaim, true);
    assert.equal(second.canChangeServer('demo'), true);
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses encrypted atomic persistence, excludes receiver data, and keeps corrupted files intact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-store-'));
    const file = path.join(root, 'tasks.json');
    const first = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    const task = first.createTask({ serverName: 'demo', remoteTaskId: 'persisted' });
    first.receiverResult({
      serverName: 'demo',
      remoteTaskId: 'receiver-must-not-persist',
      kind: 'elicitation',
      execute: async () => ({ action: 'accept', content: { answer: 'private-form-value' } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    first.save();
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plaintext = Buffer.from(envelope.payload, 'base64').toString('utf8');
    assert.doesNotMatch(plaintext, /receiver-must-not-persist|private-form-value/);
    assert.match(plaintext, /persisted/);
    first.close();
    assert.match(fs.readFileSync(file, 'utf8'), /electron-safeStorage/);
    const second = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    assert.equal(second.get(task.taskRef).server, 'demo');
    second.close();
    fs.writeFileSync(file, '{broken', 'utf8');
    const third = createMcpTaskManager({ storePath: file, safeStorage: fakeSafeStorage(true) });
    assert.equal(third.persistence().error, 'MCP_TASK_STORE_CORRUPT');
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    third.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('filters Agent task access by session/project and exposes only receiver tasks to servers', async () => {
    const manager = createMcpTaskManager({ safeStorage: fakeSafeStorage(false) });
    const tool = manager.createTask({
      serverName: 'demo',
      remoteTaskId: 'tool-remote',
      sourceSessionId: 'session-a',
      sourceProjectPath: 'C:\\project-a',
    });
    const receiver = manager.receiverResult({
      serverName: 'demo',
      remoteTaskId: 'receiver-remote',
      cancelExecution: async () => {},
      execute: async () => ({ content: [{ type: 'text', text: 'receiver result' }] }),
    });

    assert.equal(manager.list({ sourceSessionId: 'session-b', sourceProjectPath: 'C:\\project-a' }).length, 0);
    assert.equal(manager.getForContext(tool.taskRef, { sessionId: 'session-a', projectPath: 'C:\\project-a' }).taskRef, tool.taskRef);
    assert.throws(
      () => manager.getForContext(tool.taskRef, { sessionId: 'session-b', projectPath: 'C:\\project-a' }),
      { code: 'MCP_TASK_NOT_FOUND' },
    );
    const listed = await manager.handleTaskRequest('demo', 'tasks/list');
    assert.deepEqual(listed.tasks.map((item) => item.taskId), ['receiver-remote']);
    assert.equal(manager.get(receiver.taskRef).canCancel, true);
    await manager.handleTaskRequest('demo', 'tasks/cancel', { taskId: receiver.task.taskId });
    manager.close();
  });
});
