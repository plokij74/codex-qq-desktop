'use strict';

// A small newline-framed MCP 2025-11-25 server used by the D10 integration
// test. It deliberately exercises both directions of the JSON-RPC channel:
// the host handles tool tasks while this process sends elicitation requests
// and queries receiver tasks.
const MAX_MESSAGE_BYTES = 1024 * 1024;
let input = Buffer.alloc(0);
let nextRequestId = 1000;
let nextTaskId = 1;
const pending = new Map();
const tasks = new Map();

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  else process.exit(5);
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(body);
  process.stdout.write('\n');
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function requestHost(method, params, onResponse) {
  const id = nextRequestId++;
  pending.set(String(id), onResponse);
  send({ jsonrpc: '2.0', id, method, params });
}

function taskResult(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    result: task.result,
  };
}

function queryReceiverTask(remoteTaskId) {
  requestHost('tasks/get', { taskId: remoteTaskId }, (message) => {
    if (message.error) return;
    const remote = message.result || {};
    if (remote.status === 'completed' || remote.status === 'failed' || remote.status === 'cancelled') {
      requestHost('tasks/result', { taskId: remoteTaskId }, (resultMessage) => {
        notify('notifications/d10/receiver-result', {
          taskId: remoteTaskId,
          status: remote.status,
          result: resultMessage.result,
        });
      });
      return;
    }
    setTimeout(() => queryReceiverTask(remoteTaskId), 15).unref?.();
  });
}

function startReceiverElicitation(originalId) {
  const remoteTaskId = 'd10-receiver-1';
  requestHost('elicitation/create', {
    mode: 'form',
    message: 'D10 receiver input',
    title: 'D10 receiver form',
    requestedSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 2 },
      },
      required: ['answer'],
    },
    task: { taskId: remoteTaskId, ttl: 60_000, pollInterval: 1_000 },
  }, (message) => {
    if (message.error) {
      result(originalId, { isError: true, content: [{ type: 'text', text: 'receiver error' }] });
      return;
    }
    notify('notifications/d10/receiver-created', { taskId: remoteTaskId, task: message.result });
    queryReceiverTask(remoteTaskId);
  });
  result(originalId, { content: [{ type: 'text', text: 'receiver started' }] });
}

function startReceiverSampling(originalId) {
  const remoteTaskId = 'd10-sampling-1';
  requestHost('sampling/createMessage', {
    messages: [{ role: 'user', content: { type: 'text', text: 'D10 sampling task' } }],
    maxTokens: 16,
    includeContext: 'none',
    task: { taskId: remoteTaskId, ttl: 60_000, pollInterval: 1_000 },
  }, (message) => {
    if (message.error) {
      result(originalId, { isError: true, content: [{ type: 'text', text: 'sampling error' }] });
      return;
    }
    notify('notifications/d10/receiver-created', { taskId: remoteTaskId, task: message.result });
    queryReceiverTask(remoteTaskId);
  });
  result(originalId, { content: [{ type: 'text', text: 'sampling started' }] });
}

function startFormElicitation(originalId) {
  requestHost('elicitation/create', {
    mode: 'form',
    message: 'D10 form input',
    title: 'D10 form',
    requestedSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', minLength: 3 },
      },
      required: ['answer'],
    },
  }, (message) => {
    if (message.error) {
      result(originalId, { isError: true, content: [{ type: 'text', text: 'form error' }] });
      return;
    }
    result(originalId, {
      content: [{ type: 'text', text: JSON.stringify(message.result) }],
    });
  });
}

function createToolTask(toolName) {
  const taskId = `d10-tool-${nextTaskId++}`;
  const task = {
    taskId,
    toolName,
    status: 'working',
    polls: 0,
    result: { content: [{ type: 'text', text: `completed:${toolName}` }] },
  };
  tasks.set(taskId, task);
  return task;
}

function handleTaskRequest(message) {
  const task = tasks.get(String(message.params?.taskId || ''));
  if (message.method === 'tasks/list') {
    result(message.id, {
      tasks: [...tasks.values()].map((item) => ({ taskId: item.taskId, status: item.status })),
    });
    return;
  }
  if (!task) {
    result(message.id, { error: { code: -32004, message: 'task not found' } });
    return;
  }
  if (message.method === 'tasks/cancel') {
    task.status = 'cancelled';
    notify('notifications/tasks/status', { taskId: task.taskId, status: task.status });
    result(message.id, { taskId: task.taskId, status: task.status });
    return;
  }
  if (message.method === 'tasks/get') {
    if (task.status === 'working' && task.toolName === 'long_task') {
      task.polls += 1;
      if (task.polls >= 1) task.status = 'completed';
    }
    if (task.status !== 'working') notify('notifications/tasks/status', { taskId: task.taskId, status: task.status });
    result(message.id, {
      taskId: task.taskId,
      status: task.status,
      pollInterval: 1_000,
      ttl: 60_000,
    });
    return;
  }
  if (message.method === 'tasks/result') {
    result(message.id, taskResult(task));
    return;
  }
  result(message.id, { error: { code: -32601, message: 'method not found' } });
}

function handleRequest(message) {
  const method = String(message.method || '');
  if (method === 'initialize') {
    result(message.id, {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
        sampling: {},
        elicitation: { form: {} },
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      serverInfo: { name: 'd10-stdio-smoke', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    result(message.id, {
      tools: [
        {
          name: 'long_task',
          description: 'Completes through the MCP task API',
          execution: { taskSupport: 'optional' },
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'cancelable_task',
          description: 'Stays active until cancelled',
          execution: { taskSupport: 'optional' },
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'ask_form',
          description: 'Requests a foreground form',
          execution: { taskSupport: 'forbidden' },
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'ask_task_form',
          description: 'Requests a task-augmented foreground form',
          execution: { taskSupport: 'forbidden' },
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'ask_url',
          description: 'Requests a public HTTPS URL confirmation',
          execution: { taskSupport: 'forbidden' },
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'ask_sampling_task',
          description: 'Requests a task-augmented sampling response',
          execution: { taskSupport: 'forbidden' },
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/call') {
    const name = String(message.params?.name || '');
    if (name === 'long_task' || name === 'cancelable_task') {
      const task = createToolTask(name);
      if (name === 'cancelable_task') task.result = { content: [{ type: 'text', text: 'should-not-complete' }] };
      result(message.id, {
        task: { taskId: task.taskId, status: task.status, ttl: 60_000, pollInterval: 1_000 },
      });
      return;
    }
    if (name === 'ask_form') {
      startFormElicitation(message.id);
      return;
    }
    if (name === 'ask_task_form') {
      startReceiverElicitation(message.id);
      return;
    }
    if (name === 'ask_sampling_task') {
      startReceiverSampling(message.id);
      return;
    }
    if (name === 'ask_url') {
      requestHost('elicitation/create', {
        mode: 'url',
        message: 'D10 URL input',
        title: 'D10 URL',
        url: 'https://example.com/connect?request=d10',
      }, (response) => {
        result(message.id, { content: [{ type: 'text', text: JSON.stringify(response.result || response.error) }] });
      });
      return;
    }
  }
  if (['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'].includes(method)) {
    handleTaskRequest(message);
    return;
  }
  result(message.id, { error: { code: -32601, message: 'method not found' } });
}

function handleMessage(message) {
  if (message && message.id !== undefined && !message.method) {
    const handler = pending.get(String(message.id));
    if (handler) {
      pending.delete(String(message.id));
      handler(message);
    }
    return;
  }
  if (message?.method && message.id !== undefined) handleRequest(message);
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > MAX_MESSAGE_BYTES * 2) process.exit(2);
  while (true) {
    const end = input.indexOf('\n');
    if (end < 0) break;
    const line = input.slice(0, end).toString('utf8').replace(/\r$/, '').trim();
    input = input.slice(end + 1);
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) process.exit(3);
    try { handleMessage(JSON.parse(line)); } catch { process.exit(4); }
  }
});
