'use strict';

// Loads the real IPC wiring in an isolated VM with synthetic settings, vault and transport.
// It never reads the application's userData or permits an external model request.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const settingsModule = require('../../src/ai/settings');
const profiles = require('../../src/ai/model-profiles');
const router = require('../../src/ai/model-router');

const clone = value => JSON.parse(JSON.stringify(value));
function syntheticRegistry({ authKind = 'none', streamMode = 'off' } = {}) {
  const registry = profiles.createModelRegistry({ baseUrl: 'https://e4.example.invalid/v1', model: 'e4-synthetic-model' });
  registry.providers[0].auth = { kind: authKind, secretRef: '', credentialOrigin: null, credentialRevision: 0 };
  registry.models[0].compatibility = { toolMode: 'native', streamMode, includeUsage: true };
  return profiles.validateModelRegistry(registry);
}
function jsonResponse(content = 'Synthetic model answer', usage = { prompt_tokens: 12, completion_tokens: 3 }) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function loadMainFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e4-main-'));
  const handlers = new Map(); const syncHandlers = new Map(); const events = []; const requests = [];
  const emitter = new EventEmitter(); const appEvents = new EventEmitter(); const secrets = new Map();
  const credentialReads = []; const settingsLoads = [];
  let state = clone({ ...settingsModule.DEFAULT_SETTINGS, mode: 'api', agentEnabled: false, autoCompact: false,
    usageEnabled: true, skillsEnabled: false, hooksEnabled: false, mcpEnabled: false, subagentEnabled: false,
    modelRegistry: options.registry || syntheticRegistry(), ...options.settings });
  const settings = {
    ...settingsModule,
    loadSettings: (_path, loadOptions) => { settingsLoads.push(loadOptions); return clone(state); },
    saveSettings: (_root, partial) => {
      if (partial.modelRegistry) profiles.validateModelRegistry(partial.modelRegistry);
      state = clone({ ...state, ...partial });
      return clone(state);
    },
    getSettingsSecretManager: () => ({ getSecret: id => { credentialReads.push(id); return secrets.get(id); }, setSecret: (id, value) => { secrets.set(id, value); },
      deleteSecret: id => secrets.delete(id), hasSecret: id => secrets.has(id), hadSecret: id => secrets.has(id) }),
  };
  const makeSender = id => {
    const sender = new EventEmitter(); sender.id = id; sender.destroyed = false;
    sender.isDestroyed = () => sender.destroyed;
    sender.send = (channel, event) => { const record = { senderId: id, channel, event: clone(event) }; events.push(record); emitter.emit('event', record); };
    return sender;
  };
  const sender = makeSender(1); const otherSender = makeSender(2);
  const windows = [sender, otherSender].map(webContents => ({ webContents, isDestroyed: () => webContents.destroyed }));
  const BrowserWindow = function BrowserWindow() { throw new Error('Synthetic harness must not create a window'); };
  BrowserWindow.getAllWindows = () => windows.filter(win => !win.isDestroyed());
  BrowserWindow.getFocusedWindow = () => windows[0];
  BrowserWindow.fromWebContents = sender => windows.find(window => window.webContents === sender) || null;
  const electron = {
    app: { getPath: () => root, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
      on: (...args) => appEvents.on(...args), quit() {}, getName: () => 'E4 synthetic application' },
    BrowserWindow, ipcMain: { handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, fn);
    }, on: (channel, fn) => syncHandlers.set(channel, fn) },
    dialog: {}, shell: {}, Menu: { setApplicationMenu() {} }, Notification: { isSupported: () => false },
    safeStorage: { isEncryptionAvailable: () => false }, powerMonitor: new EventEmitter(),
  };
  const fetchFn = async (url, request) => {
    requests.push({ url: String(url), request, body: JSON.parse(request.body) });
    return options.fetchFn ? options.fetchFn(url, request, requests.length) : jsonResponse();
  };
  const mainPath = path.resolve(__dirname, '../../src/main.js');
  const realRequire = createRequire(mainPath);
  const controlledRequire = request => {
    if (request === 'electron') return electron;
    if (options.modules && Object.hasOwn(options.modules, request)) return options.modules[request];
    if (request === './ai/settings') return settings;
    if (request === './ai/model-router') return { ...router, createModelChatFunction: args => router.createModelChatFunction({ ...args, fetchFn }) };
    if (request === './ai/model-diagnostics') {
      const service = realRequire(request);
      return { ...service, createModelDiagnosticService: args => service.createModelDiagnosticService({ ...args,
        invoke: requestArgs => router.invokeModelTurn({ ...requestArgs, fetchFn }) }) };
    }
    if (request === './ai/openai-compatible') return { chatCompletionMessage: () => { throw new Error('E4 forbids the legacy global transport'); } };
    if (request === './ai/agent' && options.agentFn) return { ...realRequire(request), runAgentLoop: options.agentFn };
    if (request === './ai/permission' && options.gateFn) return { ...realRequire(request), createPermissionGate: options.gateFn };
    return realRequire(request);
  };
  const context = vm.createContext({ require: controlledRequire, __dirname: path.dirname(mainPath), __filename: mainPath,
    module: { exports: {} }, exports: {}, process, console, Buffer, URL, Error, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, setImmediate, clearImmediate, structuredClone,
    fetch: () => { throw new Error('Synthetic harness prohibits global network'); } });
  new vm.Script(fs.readFileSync(mainPath, 'utf8'), { filename: mainPath }).runInContext(context);
  const inspect = expression => vm.runInContext(expression, context);
  const invoke = async (channel, payload = {}, owner = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`IPC handler missing: ${channel}`);
    return structuredClone(await handler({ sender: owner }, structuredClone(payload)));
  };
  const waitForEvent = (predicate, timeoutMs = 3000) => {
    const found = events.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { emitter.removeListener('event', listener); reject(new Error('Expected synthetic IPC event did not arrive')); }, timeoutMs);
      const listener = event => { if (predicate(event)) { clearTimeout(timeout); emitter.removeListener('event', listener); resolve(event); } };
      emitter.on('event', listener);
    });
  };
  const completions = new Map();
  // Test-only convenience: observe acceptance without changing the real invoke contract.
  const accept = async (channel, payload = {}, owner = sender) => {
    let listener;
    const accepted = new Promise(resolve => {
      listener = record => {
        if (record.senderId !== owner.id || record.channel !== 'chat:event'
          || record.event.sessionId !== payload.sessionId || record.event.clientRequestId !== payload.clientRequestId
          || !['run-start', 'compact-start'].includes(record.event.type)) return;
        const { runId, sessionId, clientRequestId, modelSource, task } = record.event;
        completions.set(runId, completion);
        resolve({ ok: true, accepted: true, runId, sessionId, clientRequestId, modelSource, task });
      };
      emitter.on('event', listener);
    });
    const completion = invoke(channel, payload, owner);
    try { return await Promise.race([accepted, completion]); }
    finally { emitter.removeListener('event', listener); }
  };
  const settle = async accepted => {
    if (completions.has(accepted?.runId)) return completions.get(accepted.runId);
    const lease = inspect('foregroundModels.current');
    if (lease?.completion && (!accepted?.runId || lease.runId === accepted.runId)) return lease.completion;
    return accepted;
  };
  t.after(async () => {
    await options.beforeClose?.();
    const lease = inspect('foregroundModels.current');
    lease?.abort.abort(); if (lease?.completion) await lease.completion;
    await inspect('modelDiagnostics?.close?.()');
    await inspect('engineeringIpc?.close?.()');
    await inspect('mcpSessionManager?.close?.()');
    await inspect('mcpTaskManager?.close?.()');
    // Only remove the exact temporary root created by this fixture.
    const resolved = path.resolve(root);
    if (resolved !== root || path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codex-e4-main-')) throw new Error('Unsafe synthetic cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, handlers, syncHandlers, electron, events, requests, sender, otherSender, secrets, credentialReads, settingsLoads, appEvents, invoke, accept, inspect, waitForEvent, settle,
    settings: () => clone(state), patchSettings: partial => { state = clone({ ...state, ...partial }); },
    payload: extra => ({ sessionId: 'e4-session', clientRequestId: 'e4-request', assistantId: 'assistant_general',
      messages: [{ role: 'user', content: 'Synthetic question' }], ...extra }) };
}
function loadPreloadFixture(main) {
  let api; const listeners = new Map();
  const context = vm.createContext({ require: request => {
    if (request !== 'electron') throw new Error('Unexpected preload dependency');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: {
      invoke: (channel, payload) => main.invoke(channel, payload), on: (channel, listener) => listeners.set(channel, listener),
      removeListener: channel => listeners.delete(channel), sendSync() {},
    } };
  } });
  const file = path.resolve(__dirname, '../../src/preload.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
  return { api, listeners };
}
module.exports = { loadMainFixture, loadPreloadFixture, syntheticRegistry, jsonResponse, deferred };
