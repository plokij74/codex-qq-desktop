'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let exposed = null;
const calls = [];
const electronStub = {
  contextBridge: {
    exposeInMainWorld: (_name, value) => { exposed = value; },
  },
  ipcRenderer: {
    invoke: (...args) => {
      calls.push(args);
      return Promise.resolve({ ok: true });
    },
    on: () => {},
    removeListener: () => {},
  },
};
const originalLoad = Module._load;

describe('D10 preload MCP contract', () => {
  before(() => {
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === 'electron') return electronStub;
      return originalLoad.call(this, request, parent, isMain);
    };
    require('../src/preload');
    Module._load = originalLoad;
  });

  after(() => {
    Module._load = originalLoad;
  });

  it('exposes task actions through fixed IPC payloads', async () => {
    await exposed.listMcpTasks({ server: 42, limit: 12, ignored: 'value' });
    await exposed.getMcpTask({ taskRef: 99, remoteTaskId: 'must-not-cross' });
    await exposed.prepareMcpTaskResult({ taskRef: 88, targetSessionId: 77, extra: true });
    await exposed.cancelMcpTask({ taskRef: 66, ignored: 'value' });

    assert.deepEqual(calls.slice(-4), [
      ['mcp:tasks:list', { server: '42', limit: 12 }],
      ['mcp:tasks:get', { taskRef: '99' }],
      ['mcp:tasks:result:prepare', { taskRef: '88', targetSessionId: '77' }],
      ['mcp:tasks:cancel', { taskRef: '66' }],
    ]);
  });

  it('does not pass arbitrary elicitation fields or non-object content', async () => {
    await exposed.respondMcpElicitation({
      elicitationId: 12,
      action: 'accept',
      content: ['not-an-object'],
      url: 'https://must-not-cross.example',
    });
    await exposed.openMcpElicitationUrl({ elicitationId: 13, url: 'https://must-not-cross.example' });

    assert.deepEqual(calls.slice(-2), [
      ['mcp:elicitation:respond', { elicitationId: '12', action: 'accept', content: undefined }],
      ['mcp:elicitation:open-url', { elicitationId: '13' }],
    ]);
  });
});
