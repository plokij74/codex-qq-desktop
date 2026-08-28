'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMcpHub } = require('../src/ai/mcp-hub');
const { createMcpTaskManager } = require('../src/ai/mcp-task-manager');
const { createMcpElicitationController } = require('../src/ai/mcp-elicitation');

function waitFor(predicate, timeoutMs = 5_000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      let matched = false;
      try { matched = Boolean(predicate()); } catch { /* wait for the next state */ }
      if (matched) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`D10 integration condition timed out: ${label}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe('D10 real newline stdio MCP integration', () => {
  it('negotiates tasks, polls results, cancels, and round-trips form receiver tasks', { timeout: 20_000 }, async () => {
    const serverPath = path.join(__dirname, 'fixtures', 'mcp-d10-stdio-server.js');
    const taskManager = createMcpTaskManager({ defaultTtlMs: 60_000 });
    const events = [];
    let foregroundElicitation = null;
    const openedUrls = [];
    const elicitation = createMcpElicitationController({
      onEvent: (event) => { foregroundElicitation = event; },
      openExternal: async (url) => { openedUrls.push(url); },
    });
    const hub = createMcpHub({ taskManager });
    const config = {
      name: 'd10',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      tasks: { enabled: true, defaultTtlMs: 60_000 },
      sampling: { enabled: true },
      elicitation: { enabled: true },
    };
    const context = {
      cwd: process.cwd(),
      project: { name: 'D10 test', path: process.cwd() },
      sessionId: 'd10-test-session',
      samplingEnabled: true,
      samplingHandler: (_server, params) => {
        const response = Promise.resolve({ role: 'assistant', content: 'sampling answer' });
        if (!params?.task) return response;
        const created = taskManager.receiverResult({
          serverName: 'd10',
          transport: 'stdio',
          kind: 'sampling',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          execute: () => response,
        });
        return created.task;
      },
      elicitationHandler: (_server, params) => {
        const response = elicitation.create('d10', params);
        if (!params?.task) return response;
        const created = taskManager.receiverResult({
          serverName: 'd10',
          transport: 'stdio',
          kind: 'elicitation',
          remoteTaskId: params.task.taskId,
          ttl: params.task.ttl,
          status: 'input_required',
          execute: () => response,
        });
        return created.task;
      },
      elicitationComplete: (_server, params) => {
        const id = String(params?.elicitationId || '');
        try { return elicitation.complete(id); } catch { return false; }
      },
      taskHandler: (_server, method, params) => taskManager.handleTaskRequest('d10', method, params),
      notificationHandler: (method, params) => events.push({ method, params }),
    };

    try {
      await hub.startAll([config], context);
      assert.equal(hub.taskManager, taskManager);
      assert.equal(hub.sessionStatus('d10')[0].state, 'connected');
      const toolNames = hub.getToolDefs().map((item) => item.function.name);
      assert.ok(toolNames.includes('mcp_d10_long_task'));
      assert.ok(toolNames.includes('mcp_d10_ask_form'));
      assert.ok(toolNames.includes('mcp_d10_ask_url'));
      assert.equal(hub.sessionStatus('d10')[0].state, 'connected');

      const created = await hub.call('mcp_d10_long_task', {});
      assert.equal(created.ok, true);
      assert.equal(created.task.status, 'working');
      assert.match(created.task.taskRef, /^mcp_task_/);
      await waitFor(() => {
        const task = taskManager.get(created.task.taskRef);
        return task.status === 'completed' && task.resultAvailable;
      }, 5_000, 'tool task result');
      const completed = taskManager.get(created.task.taskRef);
      assert.equal(completed.resultAvailable, true);
      const completedResult = await taskManager.result(created.task.taskRef);
      assert.match(JSON.stringify(completedResult), /completed:long_task/);

      const formCall = hub.call('mcp_d10_ask_form', {});
      await waitFor(() => foregroundElicitation?.mode === 'form', 5_000, 'form elicitation');
      assert.equal(foregroundElicitation.server, 'd10');
      assert.match(foregroundElicitation.message, /form input/);
      const formId = foregroundElicitation.elicitationId;
      assert.throws(
        () => elicitation.respond(formId, 'accept', { answer: 'x' }),
        (error) => error.code === 'MCP_ELICITATION_SCHEMA_INVALID',
      );
      assert.equal(elicitation.respond(formId, 'accept', { answer: 'accepted' }), true);
      const formResult = await formCall;
      assert.equal(formResult.ok, true);
      assert.match(formResult.result, /accepted/);

      const urlCall = hub.call('mcp_d10_ask_url', {});
      await waitFor(() => foregroundElicitation?.mode === 'url', 5_000, 'url elicitation');
      const urlId = foregroundElicitation.elicitationId;
      assert.equal(foregroundElicitation.url, 'https://example.com/connect?request=d10');
      assert.deepEqual(await elicitation.openUrl(urlId), { ok: true });
      assert.deepEqual(openedUrls, ['https://example.com/connect?request=d10']);
      assert.equal(elicitation.respond(urlId, 'accept'), true);
      const urlResult = await urlCall;
      assert.equal(urlResult.ok, true);
      assert.match(urlResult.result, /accept/);

      const receiverCall = await hub.call('mcp_d10_ask_task_form', {});
      assert.equal(receiverCall.ok, true);
      assert.equal(receiverCall.result.includes('receiver started'), true);
      await waitFor(() => foregroundElicitation?.mode === 'form' && foregroundElicitation.message.includes('receiver input'), 5_000, 'receiver elicitation');
      const receiverId = foregroundElicitation.elicitationId;
      assert.equal(elicitation.respond(receiverId, 'accept', { answer: 'receiver answer' }), true);
      await waitFor(() => events.some((event) => event.method === 'notifications/d10/receiver-result'), 5_000, 'receiver result');
      const receiverEvent = events.find((event) => event.method === 'notifications/d10/receiver-result');
      assert.equal(receiverEvent.params.status, 'completed');
      assert.match(JSON.stringify(receiverEvent.params.result), /receiver answer/);

      const samplingCall = await hub.call('mcp_d10_ask_sampling_task', {});
      assert.equal(samplingCall.ok, true);
      assert.equal(samplingCall.result.includes('sampling started'), true);
      await waitFor(() => events.some((event) => event.method === 'notifications/d10/receiver-result' && event.params.taskId === 'd10-sampling-1'), 5_000, 'sampling receiver result');
      const samplingEvent = events.find((event) => event.method === 'notifications/d10/receiver-result' && event.params.taskId === 'd10-sampling-1');
      assert.equal(samplingEvent.params.status, 'completed');
      assert.match(JSON.stringify(samplingEvent.params.result), /sampling answer/);

      const cancelCreated = await hub.call('mcp_d10_cancelable_task', {});
      assert.equal(cancelCreated.ok, true);
      const cancelled = await hub.call('mcp_task_cancel', { taskRef: cancelCreated.task.taskRef });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.task.status, 'cancelled');
      assert.equal(taskManager.get(cancelCreated.task.taskRef).status, 'cancelled');
    } finally {
      elicitation.cancelAll();
      for (const task of taskManager.list()) {
        if (task.canCancel) {
          try { await taskManager.cancel(task.taskRef); } catch { /* cleanup only */ }
        }
      }
      await hub.close();
      taskManager.close();
    }
  });
});
