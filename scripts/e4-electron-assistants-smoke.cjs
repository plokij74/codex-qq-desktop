'use strict';
/**
 * Actual Electron E4 assistants smoke -- OFFLINE WIRE FIXTURES ONLY.
 * Run with the already-installed Electron executable, not node / a VM / a web server.
 * The production main/preload/renderer/IPC/adapters/ledger/settings files are used without edits.
 * Only this harness supplies fixture fetch/crypto, IPC observations, and native capture scheduling.
 * On Windows clear ELECTRON_RUN_AS_NODE only in the invoking shell, then launch the installed
 * electron.exe with Start-Process -WindowStyle Normal -Wait; native non-empty captures are required.
 * Every Node fetch is a strict *.invalid fixture; Electron HTTP(S) is denied.
 * Disposable userData/sessionData and synthetic in-memory AES-GCM credentials isolate this
 * run from normal profiles, real vaults, safeStorage/machine keys, .env and paid endpoints.
 * Success is Electron + fixture integration evidence, NOT live-provider support evidence.
 * Screenshots and result.json remain in the printed temporary directory; nothing is deleted.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, session } = require('electron');
if (!app || !BrowserWindow) throw new Error('E4_SMOKE_REQUIRES_ACTUAL_ELECTRON: clear ELECTRON_RUN_AS_NODE in the invoking shell');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e4-electron-'));
const userData = path.join(temp, 'user-data');
const sessionData = path.join(temp, 'session-data');
for (const dir of [userData, sessionData, path.join(temp, 'crash-dumps'), path.join(temp, 'logs')]) fs.mkdirSync(dir);
app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.setPath('crashDumps', path.join(temp, 'crash-dumps'));
app.setAppLogsPath(path.join(temp, 'logs'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const FAKE_CREDENTIAL = 'e4-electron-fixture-only-not-a-real-key';
const fixtureEncryptionKey = crypto.randomBytes(32);
const startedAt = Date.now();
const report = {
  status: 'running', evidence: 'actual Electron; strictly offline synthetic provider wire fixtures',
  liveEndpointEvidence: false, temp, userData, sessionData,
  credentialEncryption: 'synthetic in-memory AES-GCM key; no safeStorage or machine-derived key',
  checks: {}, screenshots: [], requests: [], invocations: [], blockedBrowserRequests: [],
};
const tracked = new Set(['chat:send', 'session:compact', 'models:diagnose', 'models:syncSessionReferences']);
const allChatEvents = [], allDiagnosticEvents = [];
let win, held, finishing = false;
const sourceFiles = ['src/main.js', 'src/preload.js', 'src/renderer/app.js', 'src/renderer/e4-models.js',
  'src/renderer/e4-chat-state.js', 'src/renderer/index.html', 'src/ai/model-router.js',
  'src/ai/model-ipc.js', 'src/ai/model-diagnostics.js', 'src/ai/secret-manager.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
report.sourceHashesBefore = hashes();
const safeText = value => String(value ?? '').split(FAKE_CREDENTIAL).join('[SYNTHETIC CREDENTIAL REDACTED]');
const note = (key, value = true) => { report.checks[key] = value; console.log(`E4_SMOKE_CHECK ${key}`); };

fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  mode: 'api', agentEnabled: false, memoryEnabled: false, memoryCandidateEnabled: false,
  skillsEnabled: false, hooksEnabled: false, mcpEnabled: false, mcpServers: [], subagentEnabled: false,
  webEnabled: false, autoCompact: false, terminalEnabled: false, verifyBeforeDone: false,
  codeIndexEnabled: false, compactKeepMessages: 6, usageEnabled: true,
}), 'utf8');

// Do not ever fall through to deriveMachineKey or native safeStorage, even on this account.
const { SecretManager } = require('../src/ai/secret-manager');
const inIsolatedVault = manager => assert.ok(manager.vaultPath &&
  !path.relative(userData, path.resolve(manager.vaultPath)).startsWith('..'), 'Only isolated fixture vaults are allowed');
SecretManager.prototype._encryptValue = function encryptFixture(value) {
  inIsolatedVault(this);
  assert.ok(value === FAKE_CREDENTIAL, 'Only the fictitious Anthropic credential may be stored');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fixtureEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
};
SecretManager.prototype._decryptValue = function decryptFixture(record) {
  inIsolatedVault(this);
  assert.ok(record.cipher === 'aes-256-gcm', 'No native or ordinary credential may be decrypted');
  const decipher = crypto.createDecipheriv('aes-256-gcm', fixtureEncryptionKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
};

// Transparent native IPC audit: original listener, arguments, return value and errors survive.
const nativeHandle = ipcMain.handle;
ipcMain.handle = function auditHandle(channel, listener) {
  return nativeHandle.call(this, channel, async (event, ...args) => {
    if (!tracked.has(channel)) return listener(event, ...args);
    const payload = args[0] || {};
    const item = { channel, sessionId: payload.sessionId || null, clientRequestId: payload.clientRequestId || null,
      assistantId: payload.assistantId || null, modelProfileId: payload.modelProfileId || null, startedMs: Date.now() - startedAt };
    if (channel === 'models:syncSessionReferences') item.sessionCount = Array.isArray(payload.sessions) ? payload.sessions.length : 0;
    report.invocations.push(item);
    try { const result = await listener(event, ...args); item.result = result; item.finishedMs = Date.now() - startedAt; return result; }
    catch (error) { item.error = safeText(error?.code || error?.message); item.finishedMs = Date.now() - startedAt; throw error; }
  });
};

const targets = [
  { tag: 'chat', protocol: 'openai-chat-completions', endpoint: 'chat/completions' },
  { tag: 'responses', protocol: 'openai-responses', endpoint: 'responses' },
  { tag: 'anthropic', protocol: 'anthropic-messages', endpoint: 'messages' },
].map(item => ({ ...item, origin: `https://${item.tag}.e4-smoke.invalid`, providerId: `provider_e4_smoke_${item.tag}`,
  modelId: `model_e4_smoke_${item.tag}`, remoteModel: `e4-electron-${item.tag}-fixture` }));
let diagnosticText;
const usage = { input: 10, output: 4, cache: 2 };
const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sseFrame = event => `data: ${JSON.stringify(event)}\n\n`;
function sseResponse(events) {
  const bytes = new TextEncoder().encode(events.map(sseFrame).join(''));
  return new Response(new ReadableStream({ start(controller) {
    // UTF-8 and SSE boundaries deliberately do not align with chunks.
    for (let i = 0; i < bytes.length; i += 31) controller.enqueue(bytes.slice(i, i + 31));
    controller.close();
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function chatWire(text, tool) {
  return { choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : text,
    ...(tool ? { tool_calls: [{ id: `call_fixture_${report.requests.length}`, type: 'function',
      function: { name: tool, arguments: JSON.stringify({ text: diagnosticText }) } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, prompt_tokens_details: { cached_tokens: usage.cache } } };
}
function chatStream(text) {
  const response = sseResponse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, 5) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text.slice(5) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: chatWire(text).usage },
  ]);
  // Chat's mandatory terminal sentinel is not JSON.
  const prefix = response.body;
  return new Response(new ReadableStream({ async start(controller) {
    const reader = prefix.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; controller.enqueue(next.value); }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
    finally { reader.releaseLock(); }
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function responsesWire(text) {
  const item = { id: `msg_fixture_${report.requests.length}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  return { id: `resp_fixture_${report.requests.length}`, status: 'completed', output: [item],
    usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cache } } };
}
function responsesStream(text) {
  const response = responsesWire(text), item = response.output[0];
  return sseResponse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]);
}
function anthropicWire(text) {
  return { id: `msg_fixture_${report.requests.length}`, type: 'message', role: 'assistant', model: targets[2].remoteModel,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: usage.output, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } };
}
function anthropicStream(text) {
  return sseResponse([
    { type: 'message_start', message: { ...anthropicWire(text), content: [], stop_reason: null,
      usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } },
    { type: 'message_stop' },
  ]);
}
function holdResponse(url) {
  held = { cancelStarted: false, cancelSettled: false, lockReleased: false };
  let reads = 0;
  const reader = {
    read() {
      if (reads++ === 0) return Promise.resolve({ done: false, value: new TextEncoder().encode(sseFrame({
        choices: [{ index: 0, delta: { role: 'assistant', content: 'E4_FIXTURE_WAITING_STOP' }, finish_reason: null }] })) });
      return new Promise(resolve => { held.resolveRead = resolve; });
    },
    cancel() {
      held.cancelStarted = true;
      return new Promise(resolve => { held.releaseCleanup = () => { held.cancelSettled = true; held.resolveRead?.({ done: true }); resolve(); }; });
    },
    releaseLock() { held.lockReleased = true; },
  };
  return { ok: true, status: 200, url, redirected: false, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader() { return reader; } } };
}

globalThis.fetch = async function strictlyOfflineFetch(input, options = {}) {
  const url = String(input?.url || input);
  const target = targets.find(item => url === `${item.origin}/v1/${item.endpoint}`);
  assert.ok(target, 'E4_SMOKE_UNKNOWN_URL: no network fallback is allowed');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  const headers = new Headers(options.headers);
  assert.ok(target.tag === 'anthropic' ? headers.get('x-api-key') === FAKE_CREDENTIAL : !headers.has('authorization'),
    'Only the explicit synthetic credential / no-auth fixture may leave the router');
  const body = JSON.parse(options.body);
  assert.equal(body.model, target.remoteModel);
  if (target.tag === 'responses') { assert.equal(body.store, false); assert.equal(body.previous_response_id, undefined); }
  const messages = body.messages || body.input || [];
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
  const projection = JSON.stringify({ instructions: body.instructions, system: body.system, messages });
  const category = diagnosticText && projection.includes(diagnosticText) ? 'diagnostic'
    : projection.includes('你是会话压缩助手') ? 'compact' : lastText.includes('E4_HOLD_UNTIL_STOP') ? 'hold' : 'chat';
  const maxOutputTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  const item = { index: report.requests.length + 1, protocol: target.protocol, model: body.model,
    origin: target.origin, category, stream: body.stream === true, maxOutputTokens, tools: body.tools?.length || 0,
    credentialPresent: target.tag === 'anthropic', encodedRequestBytes: Buffer.byteLength(options.body) };
  report.requests.push(item);
  assert.ok(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= (category === 'diagnostic' ? 128 : 256));
  if (category !== 'diagnostic') assert.equal(item.tools, 0, 'Custom general assistant never gets tools');
  if (category === 'hold') return holdResponse(url);
  const toolReceipt = messages.some(message => message.role === 'tool');
  const tool = category === 'diagnostic' && item.tools && !toolReceipt ? body.tools[0]?.function?.name : null;
  const text = category === 'diagnostic' ? diagnosticText : category === 'compact' ? 'E4_FIXTURE_COMPACT_SUMMARY'
    : `离线 E4_FIXTURE_${target.tag.toUpperCase()}_TURN_${item.index}`;
  item.responseText = tool ? null : text;
  if (target.tag === 'chat') return body.stream ? chatStream(text) : jsonResponse(chatWire(text, tool));
  if (target.tag === 'responses') return body.stream ? responsesStream(text) : jsonResponse(responsesWire(text));
  return body.stream ? anthropicStream(text) : jsonResponse(anthropicWire(text));
};

// Registered before production whenReady; default BrowserWindow never has HTTP(S) access.
app.whenReady().then(() => {
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    report.blockedBrowserRequests.push({ resourceType: details.resourceType, origin: (() => { try { return new URL(details.url).origin; } catch { return 'invalid'; } })() });
    callback({ cancel: true });
  });
});
require('../src/main');
({ DIAGNOSTIC_SYNTHETIC_TEXT: diagnosticText } = require('../src/ai/model-diagnostics'));

const ui = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value) ?? 'undefined'})`, true);
async function waitFor(label, check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error(`E4_SMOKE_WAIT_TIMEOUT: ${label}`);
}
async function ready() {
  await waitFor('production renderer + model manager', () => ui(() =>
    !!window.codex && typeof modelManager !== 'undefined' && modelManager?.getState().loaded && !!document.getElementById('btn-send')));
  await ui(() => {
    window.__e4Smoke = { chatEvents: [], diagnosticEvents: [] };
    window.codex.onChatEvent(event => window.__e4Smoke.chatEvents.push(event));
    window.codex.onModelDiagnosticEvent(event => window.__e4Smoke.diagnosticEvents.push(event));
    return true;
  });
}
async function drainEvents() {
  if (!win || win.isDestroyed()) return;
  const events = await ui(() => ({ chat: window.__e4Smoke?.chatEvents.splice(0) || [], diagnostic: window.__e4Smoke?.diagnosticEvents.splice(0) || [] }));
  allChatEvents.push(...events.chat); allDiagnosticEvents.push(...events.diagnostic);
}
async function screenshot(name) {
  const file = path.join(temp, `${name}.png`);
  win.restore(); win.show(); win.webContents.setBackgroundThrottling(false);
  let image;
  await waitFor('non-empty native Electron page capture', async () => {
    image = await win.webContents.capturePage(); return !image.isEmpty();
  }, 3000);
  const png = image.toPNG(); assert.ok(png.length > 8, 'A screenshot must contain actual Electron pixels');
  fs.writeFileSync(file, png);
  report.screenshots.push(file); return file;
}
async function state() {
  return ui(() => ({ activeSessionId, sending, input: document.getElementById('chat-input').value,
    session: JSON.parse(JSON.stringify(activeSession())), source: document.getElementById('chat-model-source')?.textContent || '',
    drafts: JSON.parse(JSON.stringify(chatState.draftsBySession)), persisted: JSON.parse(localStorage.getItem(window.E4ChatState.STORAGE_KEY)) }));
}
async function input(text) {
  return ui(value => { const input = document.getElementById('chat-input'); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; }, text);
}
async function selectSession(sessionId) {
  await ui(id => { const row = [...document.querySelectorAll('.task-item[data-session]')].find(item => item.dataset.session === id);
    if (!row) throw new Error('Session row not rendered'); row.click(); return true; }, sessionId);
  await waitFor('selected session', async () => (await state()).activeSessionId === sessionId);
}
async function createSession(title, modelId, assistantId = 'assistant_e4_smoke_general') {
  await ui(name => { const button = document.querySelector('#main-toolbar [data-view="new-task"]');
    if (!button) throw new Error('New task button not rendered'); button.click();
    document.getElementById('task-title').value = name; document.getElementById('task-brief').value = '';
    document.getElementById('btn-task-ok').click(); return true; }, title);
  await waitFor('new empty AI session', async () => { const current = await state(); return current.session.title === title && current.session.messages.length === 0; });
  // Target changes intentionally reject stale async confirmations. Drive each
  // control like a user: await its committed session value before the next one.
  for (const [id, field, value] of [
    ['chat-assistant-select', 'assistantId', assistantId],
    ['chat-model-select', 'modelProfileId', modelId],
  ]) {
    await ui(({ id, value }) => {
      const select = document.getElementById(id);
      if (![...select.options].some(option => option.value === value)) throw new Error('Expected model/assistant option missing');
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { id, value });
    await waitFor(`session ${field} binding`, async () => (await state()).session[field] === value);
  }
  await waitFor('session model binding', async () => { const current = await state(); return current.session.assistantId === assistantId && current.session.modelProfileId === modelId; });
  const current = await state(); assert.equal(current.session.identityType, 'ai'); assert.equal(current.session.projectId, null);
  return current.activeSessionId;
}
async function send(text) {
  await input(text);
  const before = report.invocations.length;
  await ui(() => { document.getElementById('btn-send').click(); return true; });
  await waitFor('chat entered native IPC', () => report.invocations.slice(before).some(item => item.channel === 'chat:send'));
  const invocation = report.invocations.slice(before).find(item => item.channel === 'chat:send');
  await waitFor('chat final response + renderer cleanup', () => !!invocation.result && ui(() =>
    !sending && (!chatRun || chatRun.finalized) && !document.querySelector('.typing')));
  await drainEvents();
  assert.equal(invocation.result.ok, true, safeText(invocation.result.error));
  const matching = allChatEvents.filter(event => event.sessionId === invocation.sessionId && event.clientRequestId === invocation.clientRequestId);
  const start = matching.find(event => event.type === 'run-start'), done = matching.find(event => event.type === 'done');
  assert.ok(start && done, 'Accepted run-start and terminal done must reach actual preload/renderer');
  for (const event of matching) assert.equal(event.runId, start.runId);
  assert.equal(invocation.result.runId, start.runId); assert.equal(invocation.result.sessionId, start.sessionId);
  assert.equal(invocation.result.clientRequestId, start.clientRequestId);
  const source = invocation.result.modelSource;
  assert.equal(source.kind, 'api'); assert.equal(source.modelProfileId, invocation.modelProfileId);
  assert.equal(source.assistantId, invocation.assistantId);
  assert.equal(start.modelSource.assistantId, source.assistantId); assert.equal(done.modelSource.assistantId, source.assistantId);
  assert.equal(start.modelSource.modelProfileId, source.modelProfileId); assert.equal(done.modelSource.modelProfileId, source.modelProfileId);
  assert.equal(matching.filter(event => event.type === 'usage').length, 1, 'One paid attempt yields exactly one usage event');
  const current = await state(), lastAssistant = [...current.session.messages].reverse().find(message => message.role === 'assistant');
  assert.equal(lastAssistant.modelSource.protocol, source.protocol); assert.equal(lastAssistant.content, invocation.result.content);
  assert.equal(lastAssistant.modelSource.assistantId, source.assistantId);
  assert.ok(current.source.includes(source.protocol) && current.source.includes(source.model), 'Actual source header must display accepted API provenance');
  const assistantLabel = await ui(() => [...document.querySelectorAll('#message-list .msg-assistant:not(.msg-compact) .msg-meta')].at(-1)?.textContent || '');
  assert.equal(assistantLabel, source.assistantName, 'Final assistant bubble must use the accepted source assistant identity');
  assert.equal(/codex/i.test(assistantLabel), false, 'Custom General persona must not be relabelled Codex');
  assert.equal(current.input, '', 'Acceptance consumes only its unchanged draft');
  return invocation;
}

async function run() {
  await app.whenReady();
  await waitFor('production BrowserWindow', () => { win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed()); return !!win; });
  win.restore(); win.show(); win.focus(); win.webContents.setBackgroundThrottling(false);
  report.windowCaptureState = { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds() };
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log('E4_RENDERER', safeText(message).slice(0, 1000)); });
  await ready();
  assert.equal(app.getPath('userData'), userData); assert.equal(app.getPath('sessionData'), sessionData);
  assert.equal(win.webContents.getURL().startsWith('file:'), true);
  note('actual_electron_production_window', { electron: process.versions.electron, url: win.webContents.getURL(), contextIsolation: true });

  const config = await ui(async ({ targets, credential }) => {
    let result = await window.codex.listModels();
    const mutate = async (method, payload) => { const latest = await window.codex.listModels();
      const saved = await window.codex[method]({ ...payload, expectedRevision: latest.revision });
      if (!saved.ok) throw new Error(`${method}: ${saved.code || saved.error}`); return saved; };
    for (const target of targets) {
      await mutate('saveModelProvider', { provider: { id: target.providerId, name: `E4 fixture ${target.tag}`, protocol: target.protocol,
        baseUrl: `${target.origin}/v1`, auth: { kind: target.tag === 'anthropic' ? 'api-key' : 'none' } } });
      if (target.tag === 'anthropic') await mutate('setModelCredential', { providerId: target.providerId, credential });
      await mutate('saveModelProfile', { model: { id: target.modelId, name: `E4 ${target.tag} fixture`, providerId: target.providerId,
        model: target.remoteModel, request: { maxOutputTokens: 256 }, compatibility: { toolMode: 'none', streamMode: 'auto', includeUsage: true },
        capabilities: Object.fromEntries(['text', 'streaming', 'usage'].map(name => [name, { state: 'supported', source: 'declared' }])) } });
    }
    await mutate('setDefaultModel', { modelProfileId: targets[0].modelId });
    for (const id of ['assistant_e4_smoke_general', 'assistant_e4_smoke_restore']) await mutate('saveAssistant', {
      assistant: { id, name: id.endsWith('restore') ? 'E4 restored fixture assistant' : 'E4 fixture general assistant', identityType: 'ai', builtIn: false,
        modelProfileId: null, systemPrompt: 'You are an offline E4 fixture general assistant. Do not use tools.',
        knowledge: { projectContext: false, projectMemory: false }, projectId: null, toolPolicy: { mode: 'none', allowedTools: [] } } });
    await mutate('saveModelProfile', { model: { id: 'model_e4_smoke_restore', name: 'E4 startup-only nondefault model',
      providerId: targets[1].providerId, model: targets[1].remoteModel, request: { maxOutputTokens: 256 },
      compatibility: { toolMode: 'none', streamMode: 'off', includeUsage: false }, capabilities: { text: { state: 'supported', source: 'declared' } } } });
    result = await window.codex.listModels();
    await modelManager.load();
    const settings = await window.codex.getSettings();
    return { mode: settings.mode, registry: result.registry, revision: result.revision, apiKey: settings.apiKey };
  }, { targets, credential: FAKE_CREDENTIAL });
  assert.equal(config.mode, 'api'); assert.equal(config.apiKey, '');
  assert.equal(JSON.stringify(config.registry).includes(FAKE_CREDENTIAL), false);
  assert.equal(JSON.stringify(config.registry).includes('secretRef'), false);
  const general = config.registry.assistants.find(item => item.id === 'assistant_e4_smoke_general');
  assert.deepEqual(general.knowledge, { projectContext: false, projectMemory: false }); assert.equal(general.toolPolicy.mode, 'none');
  note('public_ipc_three_protocols_custom_general_no_tools', { revision: config.revision });

  const requestsBeforeEntry = report.requests.length;
  const generalEntry = await ui(() => {
    const beforeId = activeSessionId, beforeCount = sessions.length;
    const button = document.getElementById('btn-general-ai');
    if (!button?.isConnected || !button.getBoundingClientRect().width) throw new Error('The explicit general AI entry must be rendered');
    renderFriends(); renderFriends();
    if (document.getElementById('btn-general-ai') !== button) throw new Error('Contact refresh must preserve the original AI entry');
    button.click();
    const created = activeSession();
    return { beforeId, beforeCount, count: sessions.length, id: created?.id, assistantId: created?.assistantId,
      identityType: created?.identityType, modelProfileId: created?.modelProfileId, projectId: created?.projectId,
      messages: created?.messages?.length, input: document.getElementById('chat-input').value,
      contacts: document.getElementById('friend-list').textContent,
      label: document.getElementById('friend-list-label').textContent };
  });
  assert.notEqual(generalEntry.id, generalEntry.beforeId); assert.equal(generalEntry.count, generalEntry.beforeCount + 1);
  assert.equal(generalEntry.assistantId, 'assistant_general'); assert.equal(generalEntry.identityType, 'ai');
  assert.equal(generalEntry.modelProfileId, null); assert.equal(generalEntry.projectId, null);
  assert.equal(generalEntry.messages, 0); assert.equal(generalEntry.input, '');
  assert.match(generalEntry.label, /AI.*示例/); assert.doesNotMatch(generalEntry.contacts, /在线/);
  assert.equal(report.requests.length, requestsBeforeEntry, 'Creating an empty AI session must never send history');
  note('general_ai_entry_actual_render_refresh_click_empty_no_requests', { sessionId: generalEntry.id });
  await screenshot('00-general-ai-contact-entry');

  const sessionIds = {}, acceptedSources = {};
  for (const target of targets) {
    const assistantId = target.tag === 'responses' ? 'assistant_e4_smoke_restore' : 'assistant_e4_smoke_general';
    sessionIds[target.tag] = await createSession(`E4 Electron ${target.tag}`, target.modelId, assistantId);
    const invocation = await send(`E4_FIRST_${target.tag.toUpperCase()}`);
    assert.equal(invocation.result.modelSource.protocol, target.protocol);
    assert.equal(invocation.result.modelSource.assistantId, assistantId);
    acceptedSources[target.tag] = invocation.result.modelSource;
    await screenshot(`01-${target.tag}-api-source`);
  }
  const activeAssistantIds = [...new Set(Object.values(acceptedSources).map(source => source.assistantId))];
  assert.ok(activeAssistantIds.length >= 2, 'At least two different custom assistants must complete actual UI chat sends');
  note('three_protocol_final_event_identity_source_usage_once', { sessionIds });
  note('two_custom_assistants_actual_ui_send', { assistantIds: activeAssistantIds });

  const drafts = { chat: 'E4 chat 草稿 🚀', responses: 'E4 responses 草稿', anthropic: 'E4 anthropic 草稿' };
  for (const target of targets) { await selectSession(sessionIds[target.tag]); await input(drafts[target.tag]); }
  const restoredSessionId = await createSession('E4 startup-only unsent AI', 'model_e4_smoke_restore', 'assistant_e4_smoke_restore');
  await input('E4 restored unsent draft');
  await selectSession(sessionIds.chat);
  assert.equal((await state()).input, drafts.chat);
  await drainEvents();
  const beforeReload = await state();
  for (const target of targets) assert.equal(beforeReload.persisted.draftsBySession[sessionIds[target.tag]].text, drafts[target.tag]);
  report.draftCheckpoint = { beforeReload: { activeSessionId: beforeReload.activeSessionId, input: beforeReload.input,
    drafts: beforeReload.drafts, persistedDrafts: beforeReload.persisted.draftsBySession } };
  const requestsBeforeReload = report.requests.length, syncBeforeReload = report.invocations.length;
  const reloadFinished = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload(); await reloadFinished; await ready();
  const afterReload = await state();
  report.draftCheckpoint.afterReload = { activeSessionId: afterReload.activeSessionId, input: afterReload.input,
    drafts: afterReload.drafts, persistedDrafts: afterReload.persisted.draftsBySession };
  assert.equal(afterReload.input, drafts.chat, 'Reload must paint its persisted active-session draft before any switch can overwrite it');
  await waitFor('startup session references restored by production boot', () => report.invocations.slice(syncBeforeReload)
    .some(item => item.channel === 'models:syncSessionReferences' && item.result?.ok && item.sessionCount >= 4));
  for (const target of targets) {
    await selectSession(sessionIds[target.tag]); const current = await state(); assert.equal(current.input, drafts[target.tag]);
    assert.equal(current.persisted.draftsBySession[sessionIds[target.tag]].text, drafts[target.tag]);
  }
  await selectSession(restoredSessionId); const restored = await state();
  assert.equal(restored.session.messages.length, 0); assert.equal(restored.input, 'E4 restored unsent draft');
  const protection = await ui(async () => {
    const before = await window.codex.listModels();
    const model = await window.codex.removeModelProfile({ kind: 'model', id: 'model_e4_smoke_restore', expectedRevision: before.revision });
    const latest = await window.codex.listModels();
    const assistant = await window.codex.deleteAssistant({ assistantId: 'assistant_e4_smoke_restore', expectedRevision: latest.revision });
    return { model, assistant };
  });
  assert.equal(protection.model.code, 'PROFILE_IN_USE'); assert.equal(protection.assistant.ok, true);
  assert.equal(protection.assistant.registry.assistants.find(item => item.id === 'assistant_e4_smoke_restore').archived, true);
  await selectSession(sessionIds.responses);
  const archivedHistory = await state(), historicalAssistant = [...archivedHistory.session.messages].reverse().find(message => message.role === 'assistant');
  assert.equal(archivedHistory.session.assistantId, acceptedSources.responses.assistantId);
  assert.ok(historicalAssistant?.modelSource, 'Actually sent Responses history must survive reload and assistant archival');
  for (const key of ['assistantId', 'assistantName', 'modelProfileId', 'protocol', 'model'])
    assert.equal(historicalAssistant.modelSource[key], acceptedSources.responses[key], 'Archiving must preserve accepted historical source');
  const historicalLabel = await ui(() => [...document.querySelectorAll('#message-list .msg-assistant:not(.msg-compact) .msg-meta')].at(-1)?.textContent || '');
  assert.equal(historicalLabel, acceptedSources.responses.assistantName, 'Archived assistant history must retain its original bubble label');
  assert.ok(archivedHistory.source.includes(acceptedSources.responses.protocol) && archivedHistory.source.includes(acceptedSources.responses.model));
  assert.equal(report.requests.length, requestsBeforeReload);
  note('archived_assistant_retains_historical_source', { sessionId: sessionIds.responses, assistantId: acceptedSources.responses.assistantId });
  note('startup_unsent_nondefault_model_reference_delete_protection', { restoredSessionId, model: protection.model.code, assistant: 'archived' });
  await selectSession(sessionIds.chat); await screenshot('02-restored-session-drafts');
  note('per_session_drafts_switch_actual_reload_preserved', { drafts: Object.keys(drafts) });

  // Build enough real accepted history to exercise one physical manual compact request.
  for (let i = 0; i < 3; i++) {
    const continued = await send(`E4_CHAT_HISTORY_${i + 2}`);
    assert.equal(continued.result.modelSource.assistantId, acceptedSources.chat.assistantId);
  }
  note('first_assistant_continues_after_second_archived', { assistantId: acceptedSources.chat.assistantId });
  await input('E4 manual compact must not consume this draft');
  const beforeCompact = await state(), compactIndex = report.invocations.length;
  await ui(() => { document.getElementById('btn-compact').click(); return true; });
  await waitFor('manual compact entered IPC', () => report.invocations.slice(compactIndex).some(item => item.channel === 'session:compact'));
  const compact = report.invocations.slice(compactIndex).find(item => item.channel === 'session:compact');
  await waitFor('manual compact final', async () => !!compact.result && !(await state()).sending);
  await drainEvents();
  assert.equal(compact.result.ok, true, safeText(compact.result.error));
  assert.equal(compact.result.needed, true);
  const afterCompact = await state(); assert.equal(afterCompact.input, beforeCompact.input);
  assert.equal(afterCompact.drafts[sessionIds.chat].text, beforeCompact.drafts[sessionIds.chat].text);
  assert.equal(afterCompact.session.messages.some(message => message.role === 'user' && message.content === beforeCompact.input), false);
  assert.ok(afterCompact.session.messages.length < beforeCompact.session.messages.length, 'Only summary compaction, not new user/assistant placeholders');
  const compactEvents = allChatEvents.filter(event => event.clientRequestId === compact.clientRequestId);
  assert.ok(compactEvents.some(event => event.type === 'compact-start')); assert.ok(compactEvents.some(event => event.type === 'compact-done'));
  assert.equal(compactEvents.some(event => event.type === 'run-start'), false);
  assert.equal(compactEvents.filter(event => event.type === 'usage').length, 1);
  note('manual_compact_actual_model_call_independent_ledger_draft_no_send_bubbles'); await screenshot('03-manual-compact-draft');

  // Accepted owner holds a real adapter reader; cancellation ACK must NOT release its lease.
  const holdIndex = report.invocations.length;
  await input('E4_HOLD_UNTIL_STOP'); await ui(() => { document.getElementById('btn-send').click(); return true; });
  await waitFor('held adapter reader', () => !!held && report.invocations.slice(holdIndex).some(item => item.channel === 'chat:send'));
  const hold = report.invocations.slice(holdIndex).find(item => item.channel === 'chat:send');
  await waitFor('owner run-start', async () => { await drainEvents(); return allChatEvents.some(event => event.clientRequestId === hold.clientRequestId && event.type === 'run-start'); });
  const owner = allChatEvents.find(event => event.clientRequestId === hold.clientRequestId && event.type === 'run-start');
  await selectSession(sessionIds.responses); await input('E4 BUSY draft must survive'); const busyBefore = await state();
  await ui(() => { document.getElementById('chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; });
  const busyAfter = await state(); assert.equal(busyAfter.input, busyBefore.input); assert.deepEqual(busyAfter.session.messages, busyBefore.session.messages);
  const busyPayload = { sessionId: sessionIds.responses, assistantId: 'assistant_e4_smoke_general', modelProfileId: targets[1].modelId,
    clientRequestId: 'e4-smoke-busy-probe', messages: [{ role: 'user', content: 'E4 busy probe' }] };
  const busy = await ui(async payload => window.codex.sendChat({ ...payload, expectedRegistryRevision: (await window.codex.listModels()).revision }), busyPayload);
  assert.equal(busy.code, 'BUSY');
  const wrongStop = await ui(async target => window.codex.stopChat({ sessionId: target.otherSessionId, runId: target.runId }),
    { otherSessionId: sessionIds.responses, runId: owner.runId });
  assert.equal(wrongStop.ok, false); assert.equal(held.cancelStarted, false);
  await selectSession(sessionIds.chat);
  const stop = await ui(async target => window.codex.stopChat(target), { sessionId: owner.sessionId, runId: owner.runId });
  assert.equal(stop.ok, true); await waitFor('cancel enters deferred reader cleanup', () => held.cancelStarted);
  assert.equal(held.cancelSettled, false);
  const duringCleanup = await ui(async payload => window.codex.sendChat({ ...payload, clientRequestId: 'e4-smoke-cleanup-busy',
    expectedRegistryRevision: (await window.codex.listModels()).revision }), busyPayload);
  assert.equal(duringCleanup.code, 'BUSY'); assert.equal(hold.result, undefined);
  await screenshot('04-owner-stop-cleanup-busy'); held.releaseCleanup();
  await waitFor('abort response after awaited cleanup', async () => !!hold.result && !(await state()).sending);
  assert.equal(held.cancelSettled, true); assert.equal(held.lockReleased, true); assert.equal(hold.result.aborted, true);
  await drainEvents(); assert.equal(allChatEvents.filter(event => event.clientRequestId === hold.clientRequestId && event.type === 'usage').length, 1);
  await selectSession(sessionIds.responses); assert.equal((await state()).input, busyBefore.input);
  await selectSession(sessionIds.chat); await send('E4_AFTER_STOP_ACCEPTED');
  note('busy_preserves_draft_history_targeted_stop_awaits_reader_cleanup');

  // Real production settings dialog, explicit preview then actual diagnostic submit.
  const diagnosticRequestIndex = report.requests.length;
  await ui(modelId => {
    document.getElementById('btn-open-model-manager').click();
    const root = document.getElementById('e4-model-manager-root'); root.querySelector('[data-tab="diagnostics"]').click();
    const form = root.querySelector('[data-form="diagnostic"]'); form.querySelector('[name="modelProfileId"]').value = modelId;
    form.querySelector('[name="modelProfileId"]').dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector('[data-action="preview-diagnosis"]').click(); return true;
  }, targets[0].modelId);
  await waitFor('diagnostic explicit preview enabled', () => ui(() => !document.querySelector('[data-form="diagnostic"] button[type="submit"]').disabled));
  await screenshot('05-diagnostic-explicit-preview');
  await ui(() => { document.querySelector('[data-form="diagnostic"] button[type="submit"]').click(); return true; });
  await waitFor('diagnostic terminal', async () => { await drainEvents(); return allDiagnosticEvents.some(event => event.type === 'done' || event.type === 'error'); }, 20000);
  const diagnostic = [...allDiagnosticEvents].reverse().find(event => event.type === 'done' || event.type === 'error');
  assert.equal(diagnostic.type, 'done'); assert.equal(diagnostic.state, 'passed');
  const diagnosticRequests = report.requests.slice(diagnosticRequestIndex);
  assert.equal(diagnosticRequests.length, 5); assert.equal(diagnosticRequests.every(item => item.category === 'diagnostic' && item.maxOutputTokens <= 128), true);
  assert.equal(diagnosticRequests.filter(item => item.stream).length, 1);
  assert.equal(allDiagnosticEvents.filter(event => event.type === 'usage' && event.runId === diagnostic.runId).length, 5);
  note('settings_diagnostics_explicit_preview_fixed_five_requests', { diagnosticId: diagnostic.diagnosticId, checks: diagnostic.checks || diagnostic.results });
  await screenshot('06-diagnostic-fixture-result');

  const usagePath = path.join(userData, 'usage.jsonl');
  const rows = fs.readFileSync(usagePath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(rows.length, report.requests.length, 'Every physical attempt, including abort and diagnostic, is persisted exactly once');
  assert.equal(new Set(rows.map(row => row.attemptId)).size, rows.length);
  report.usage = { rows: rows.length, uniqueAttempts: rows.length, summary: await ui(() => window.codex.usageSummary({})) };
  assert.equal(rows.filter(row => row.kind === 'model-diagnostic').length, 5);
  note('durable_usage_once_per_physical_attempt', { rows: rows.length });
  const vaultPath = path.join(userData, 'secrets.vault.json');
  const vaultText = fs.readFileSync(vaultPath, 'utf8');
  assert.equal(vaultText.includes(FAKE_CREDENTIAL), false);
  report.isolatedVault = { exists: true, plaintextAbsent: true, credentialCount: Object.keys(JSON.parse(vaultText).secrets).length };
  report.sourceHashesAfter = hashes(); assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore, 'Production sources changed while smoke was running');
  note('production_sources_stable_all_io_isolated_no_live_endpoints');
}

async function finish(code, error) {
  if (finishing) return; finishing = true; clearTimeout(guard);
  if (held?.releaseCleanup && !held.cancelSettled) held.releaseCleanup();
  report.status = code === 0 ? 'passed' : 'failed'; report.elapsedMs = Date.now() - startedAt;
  if (error) report.error = { code: safeText(error.code || error.name), message: safeText(error.message), stack: safeText(error.stack) };
  try {
    await drainEvents();
    report.chatEvents = allChatEvents; report.diagnosticEvents = allDiagnosticEvents;
    if (code && win && !win.isDestroyed()) await screenshot('99-failure');
    let output = JSON.stringify(report, null, 2);
    assert.equal(output.includes(FAKE_CREDENTIAL), false, 'Never publish even the fictitious credential');
    fs.writeFileSync(path.join(temp, 'result.json'), output, 'utf8');
    console.log(`E4_ELECTRON_SMOKE_${report.status.toUpperCase()} ${path.join(temp, 'result.json')}`);
    console.log(`E4_ELECTRON_SMOKE_COUNTS checks=${Object.keys(report.checks).length} requests=${report.requests.length} elapsedMs=${report.elapsedMs}`);
  } catch (writeError) { console.error('E4_ELECTRON_SMOKE_REPORT_FAILED', safeText(writeError.message)); code = 1; }
  app.exit(code);
}
const guard = setTimeout(() => finish(1, new Error('E4_SMOKE_TIMEOUT_90_SECONDS')), 90000);
run().then(() => finish(0)).catch(error => finish(1, error));
