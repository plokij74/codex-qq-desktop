'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { saveSettings, loadSettings } = require('../src/ai/settings');
const { createMcpElicitationController } = require('../src/ai/mcp-elicitation');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-main-mcp-d10-'));
const handlers = new Map();
const elicitation = createMcpElicitationController({ openExternal: async () => {} });
const taskManager = {
  persistence: () => ({ mode: 'memory', error: null }),
  canChangeServer: () => false,
  list: () => [{
    taskRef: 'mcp_task_1234567890abcdef',
    server: 'locked',
    kind: 'tool',
    status: 'working',
    canCancel: true,
    canAbandon: true,
  }],
};
const app = {
  getPath: () => userData,
  requestSingleInstanceLock: () => true,
  whenReady: () => new Promise(() => {}),
  on: () => {},
  quit: () => {},
};
const BrowserWindow = function BrowserWindow() {};
BrowserWindow.getAllWindows = () => [];
BrowserWindow.getFocusedWindow = () => null;
const electronStub = {
  app,
  BrowserWindow,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  dialog: {},
  shell: { openExternal: async () => {} },
};
const originalLoad = Module._load;

function eventFor(id) {
  return { sender: { id, isDestroyed: () => false, send: () => {} } };
}

describe('D10 main IPC task protections', () => {
  before(() => {
    Module._load = function loadWithD10Stubs(request, parent, isMain) {
      if (request === 'electron') return electronStub;
      if (request === './ai/mcp-task-manager' || request === './mcp-task-manager') {
        return { createMcpTaskManager: () => taskManager };
      }
      if (request === './ai/mcp-elicitation' || request === './mcp-elicitation') {
        return { createMcpElicitationController: () => elicitation };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    require('../src/main');
    Module._load = originalLoad;
  });

  after(() => {
    Module._load = originalLoad;
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('locks server changes, roots, logout, and named or global session reset while tasks are active', async () => {
    saveSettings(userData, {
      mcpServers: [{ name: 'locked', command: 'node', tasks: { enabled: true } }],
    });
    const save = await handlers.get('settings:save')(eventFor(1), { mcpServers: [] });
    assert.equal(save.code, 'MCP_TASKS_CONFIG_LOCKED');
    assert.equal(save.locked[0].server, 'locked');
    assert.equal(loadSettings(userData).mcpServers[0].name, 'locked');

    const root = await handlers.get('mcp:roots:choose')(eventFor(1), { name: 'locked' });
    assert.equal(root.code, 'MCP_TASKS_CONFIG_LOCKED');
    const namedReset = await handlers.get('mcp:session:reset')(eventFor(1), { name: 'locked' });
    const globalReset = await handlers.get('mcp:session:reset')(eventFor(1), {});
    assert.equal(namedReset.code, 'MCP_TASKS_CONFIG_LOCKED');
    assert.equal(globalReset.code, 'MCP_TASKS_CONFIG_LOCKED');

    saveSettings(userData, {
      mcpServers: [{ name: 'locked', transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' }],
    });
    const logout = await handlers.get('mcp:oauth:logout')(eventFor(1), { name: 'locked' });
    assert.equal(logout.code, 'MCP_TASKS_CONFIG_LOCKED');
  });

  it('passes the sender identity to elicitation ownership checks', async () => {
    const pending = elicitation.create('locked', {
      message: 'Enter a display name',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    }, 101);
    const elicitationId = pending.elicitationId;

    const rejected = await handlers.get('mcp:elicitation:respond')(eventFor(202), {
      elicitationId,
      action: 'accept',
      content: { name: 'wrong window' },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'MCP_ELICITATION_CANCELLED');

    const accepted = await handlers.get('mcp:elicitation:respond')(eventFor(101), {
      elicitationId,
      action: 'accept',
      content: { name: 'owner window' },
    });
    assert.equal(accepted.ok, true);
    assert.deepEqual(await pending, { action: 'accept', content: { name: 'owner window' } });
  });

  it('protects elicitation cancel and URL opening with the sender identity', async () => {
    const pending = elicitation.create('locked', {
      mode: 'url',
      url: 'https://example.com/connect?request=owner-check',
      message: 'Open the page',
    }, 303);
    const id = pending.elicitationId;

    const openRejected = await handlers.get('mcp:elicitation:open-url')(eventFor(404), { elicitationId: id });
    const cancelRejected = await handlers.get('mcp:elicitation:cancel')(eventFor(404), { elicitationId: id });
    assert.equal(openRejected.code, 'MCP_ELICITATION_CANCELLED');
    assert.equal(cancelRejected.code, 'MCP_ELICITATION_CANCELLED');
    assert.equal((await handlers.get('mcp:elicitation:open-url')(eventFor(303), { elicitationId: id })).ok, true);
    assert.equal((await handlers.get('mcp:elicitation:cancel')(eventFor(303), { elicitationId: id })).cancelled, true);
    assert.deepEqual(await pending, { action: 'cancel' });
  });
});
