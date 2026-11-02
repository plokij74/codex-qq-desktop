'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('E2 window destruction invalidates bindings and cancels only owned work without reading destroyed window', () => {
  const { createForegroundRuntime } = require('../src/ai/model-runtime');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const start = source.indexOf('function dropModelOwner(senderId) {');
  const end = source.indexOf('\nconst hasSingleInstanceLock', start);
  assert.ok(start >= 0 && end > start);
  const callbacks = [], calls = [];
  let destroyed = false;
  const sender = { id: 17, on() {}, once(event, fn) { if (event === 'destroyed') callbacks.push(fn); } };
  const window = { get webContents() { if (destroyed) throw new Error('Object has been destroyed'); return sender; }, loadFile() {} };
  const foreground = createForegroundRuntime();
  const lease = foreground.acquire({ senderId: 17, sessionId: 's', clientRequestId: 'request', runId: 'run', kind: 'chat' });
  const cancelOwner = foreground.cancelOwner;
  foreground.cancelOwner = (id) => { assert.equal(id, 17); calls.push('foreground-stop'); return cancelOwner(id); };
  const chatAbort = new AbortController(), termAbort = new AbortController();
  const ownedRequest = new AbortController(), foreignRequest = new AbortController();
  const context = {
    BrowserWindow: function () { return window; }, __dirname: path.join(__dirname, '../src'), path,
    activeRun: { sender, abort: chatAbort }, manualTerm: { sender, abort: termAbort },
    abortActiveRun: () => { calls.push('chat-stop'); chatAbort.abort(); },
    abortManualTerm: () => { calls.push('terminal-stop'); termAbort.abort(); },
    worktreeIpc: { dropSender(id) { assert.equal(id, 17); calls.push('bindings'); } },
    planState: { expireSender(id) { assert.equal(id, 17); calls.push('plans'); } },
    modelIpc: { dropSender(id) { assert.equal(id, 17); calls.push('model-refs'); } },
    modelDiagnostics: { cancelOwner(id) { assert.equal(id, 17); calls.push('diagnostics'); } },
    foregroundModels: foreground,
    activeModelRequests: new Map([
      [Object.freeze({ senderId: 17 }), new Set([ownedRequest])],
      [Object.freeze({ senderId: 18 }), new Set([foreignRequest])],
    ]),
    engineeringIpc: { dropSender: () => calls.push('engineering') },
    cancelOAuthFlowsForSender: () => calls.push('oauth'),
    mcpElicitationController: { cancelOwner: () => calls.push('elicitation') },
    dropMcpRootTokens: () => calls.push('roots'), mcpProjectBySender: new Map([[17, 'project']]),
  };
  vm.runInNewContext(source.slice(start, end) + '\ncreateWindow();', context);
  destroyed = true;
  assert.doesNotThrow(() => callbacks.forEach((fn) => fn()));
  assert.deepEqual(calls, ['bindings', 'plans', 'chat-stop', 'terminal-stop', 'model-refs', 'diagnostics', 'foreground-stop', 'engineering', 'oauth', 'elicitation', 'roots']);
  assert.equal(context.mcpProjectBySender.has(17), false);
  assert.equal(chatAbort.signal.aborted, true);
  assert.equal(termAbort.signal.aborted, true);
  assert.equal(ownedRequest.signal.aborted, true);
  assert.equal(foreignRequest.signal.aborted, false);
  assert.equal(lease.abort.signal.aborted, true);
  assert.equal(foreground.current, lease);
  assert.equal(lease.released, false);
  assert.throws(() => foreground.acquire({ senderId: 18, sessionId: 'other', clientRequestId: 'other-request' }), { code: 'BUSY' });
  assert.equal(foreground.release(lease), true);
  const other = foreground.acquire({ senderId: 18, sessionId: 'other', clientRequestId: 'other-request' });
  context.dropModelOwner(17);
  assert.equal(other.abort.signal.aborted, false);
  assert.equal(foreignRequest.signal.aborted, false);
});
