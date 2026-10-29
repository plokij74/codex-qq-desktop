'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('E2 window destruction invalidates bindings and cancels runs without reading destroyed window', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const start = source.indexOf('function createWindow() {');
  const end = source.indexOf('\nconst hasSingleInstanceLock', start);
  assert.ok(start >= 0 && end > start);
  const callbacks = []; const calls = [];
  let destroyed = false;
  const sender = { id: 17, on() {}, once(event, fn) { if (event === 'destroyed') callbacks.push(fn); } };
  const window = { get webContents() { if (destroyed) throw new Error('Object has been destroyed'); return sender; }, loadFile() {} };
  const context = {
    BrowserWindow: function () { return window; }, __dirname: path.join(__dirname, '../src'), path,
    activeRun: { sender }, manualTerm: { sender },
    abortActiveRun: () => calls.push('chat-stop'), abortManualTerm: () => calls.push('terminal-stop'),
    worktreeIpc: { dropSender(id) { assert.equal(id, 17); calls.push('bindings'); } },
    planState: { expireSender(id) { assert.equal(id, 17); calls.push('plans'); } },
    engineeringIpc: { dropSender: () => calls.push('engineering') },
    cancelOAuthFlowsForSender: () => calls.push('oauth'),
    mcpElicitationController: { cancelOwner: () => calls.push('elicitation') },
    dropMcpRootTokens: () => calls.push('roots'), mcpProjectBySender: new Map([[17, 'project']]),
  };
  vm.runInNewContext(`${source.slice(start, end)}\ncreateWindow();`, context);
  destroyed = true;
  assert.doesNotThrow(() => callbacks.forEach((fn) => fn()));
  assert.deepEqual(calls, ['bindings', 'plans', 'chat-stop', 'terminal-stop', 'engineering', 'oauth', 'elicitation', 'roots']);
  assert.equal(context.mcpProjectBySender.has(17), false);
});
