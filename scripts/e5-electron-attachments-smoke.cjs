'use strict';
// Actual Electron + production main/preload/renderer. Only disposable synthetic
// files, scheduled native-dialog decisions and strictly .invalid wire fixtures.
// Native helper and actual Electron safeStorage are NOT mocked. No live evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, session, safeStorage, ipcMain } = require('electron');
if (!app || !BrowserWindow) throw new Error('E5_REQUIRES_ACTUAL_ELECTRON');
const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e5-electron-'));
const userData = path.join(temp, 'user-data'), sessionData = path.join(temp, 'session-data');
for (const dir of [userData, sessionData, path.join(temp, 'logs')]) fs.mkdirSync(dir);
app.setPath('userData', userData); app.setPath('sessionData', sessionData); app.setAppLogsPath(path.join(temp, 'logs'));
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ mode: 'api', agentEnabled: false, memoryEnabled: false,
  memoryCandidateEnabled: false, skillsEnabled: false, hooksEnabled: false, mcpEnabled: false, mcpServers: [],
  subagentEnabled: false, webEnabled: false, autoCompact: false, terminalEnabled: false, verifyBeforeDone: false, codeIndexEnabled: false }));
const sourceFile = path.join(temp, 'reference.txt');
const original = 'E5 原生文本参考 🚀\napi_key=E5_SYNTHETIC_ATTACHMENT_SECRET_17\n<img src="https://inert.e5.invalid/a" onerror="window.__e5Injected=1">\n';
fs.writeFileSync(sourceFile, original);
const { defaultSecretManager } = require('../src/ai/secret-manager');
defaultSecretManager.registerSecret('E5_SYNTHETIC_ATTACHMENT_SECRET_17', 'E5_SMOKE');
const { redactAttachmentText } = require('../src/ai/attachment-redaction');
const expectedText = redactAttachmentText(original);
const report = { status: 'running', evidence: 'actual Electron, actual native helper and safeStorage; offline synthetic model fixtures',
  liveEndpointEvidence: false, nativeDialogEvidence: 'harness schedules decisions for synthetic files; not an OS user-gesture test',
  temp, userData, sessionData, checks: {}, requests: [], dialogs: [], screenshots: [], attachmentIpc: [] };
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerIpcHandler(channel, async (event, payload) => {
  if (channel.startsWith('attachments:') || channel === 'chat:send' || channel === 'chat:approvePlan') report.attachmentIpc.push({ channel, phase: 'started' });
  const result = await handler(event, payload);
  if (channel.startsWith('attachments:') || channel === 'chat:send' || channel === 'chat:approvePlan') report.attachmentIpc.push({ channel, phase: 'settled', ok: result?.ok,
    code: result?.code, refCount: Array.isArray(result?.refs) ? result.refs.length : undefined });
  return result;
});
const targets = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'].map((protocol, i) => ({
  protocol, tag: ['chat', 'responses', 'anthropic'][i], providerId: `provider_e5_smoke_${i}`, modelId: `model_e5_smoke_${i}`,
  model: `e5-fixture-${i}`, origin: `https://${['chat', 'responses', 'anthropic'][i]}.e5-smoke.invalid` }));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] });
dialog.showMessageBox = async (_parent, options) => {
  if (!options) options = _parent;
  const index = options.buttons?.findIndex(label => !/取消|拒绝|不允许|否/.test(label) && /确认|允许|恢复|继续|读取|确定/.test(label));
  assert.ok(index >= 0, 'Only explicit synthetic attachment consent may be scheduled');
  report.dialogs.push({ title: options.title, response: index }); return { response: index };
};
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, options = {}) => {
  const address = String(input?.url || input), target = targets.find(item => address.startsWith(item.origin + '/'));
  assert.ok(target, 'No real network fallback is permitted');
  const headers = new Headers(options.headers); assert.equal(headers.has('authorization'), false);
  assert.equal(headers.get('x-api-key'), target.tag === 'anthropic' ? 'E5_OFFLINE_SYNTHETIC_CREDENTIAL_53' : null);
  const body = JSON.parse(options.body), encoded = JSON.stringify(body);
  assert.ok(encoded.includes(expectedText.replace(/\n/g, '\\n').replace(/"/g, '\\"')), 'The exact confirmed source text must reach actual wire');
  assert.equal(encoded.includes('E5_SYNTHETIC_ATTACHMENT_SECRET_17'), false);
  assert.equal(encoded.includes('REPLACED_EXTERNAL_SOURCE_CANARY'), false, 'External source must not be reopened');
  report.requests.push({ protocol: target.protocol, requestBytes: Buffer.byteLength(options.body), model: body.model });
  const text = `E5_OFFLINE_${target.tag}_OK`;
  if (target.tag === 'chat') return response({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
  if (target.tag === 'responses') return response({ id: 'resp_e5_fixture', status: 'completed', output: [{ type: 'message', id: 'msg_e5_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 9, output_tokens: 3 } });
  return response({ id: 'msg_e5_fixture', type: 'message', role: 'assistant', model: target.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } });
};
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true })));
require('../src/main.js');
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ui = (fn, value) => win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`);
async function waitFor(label, predicate, milliseconds = 20000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await predicate()) return; await pause(40); }
  throw new Error(`E5_SMOKE_TIMEOUT: ${label}`);
}
const resultPath = path.join(temp, 'result.json');
const guard = setTimeout(() => { report.status = 'failed'; report.error = 'E5_SMOKE_DEADLINE'; fs.writeFileSync(resultPath, JSON.stringify(report, null, 2)); app.exit(1); }, 120000);
async function run() {
  await app.whenReady();
  await waitFor('production window', () => { win = BrowserWindow.getAllWindows()[0]; return !!win; });
  win.show(); win.focus(); win.webContents.setBackgroundThrottling(false);
  await waitFor('production renderer boot', () => ui(() => typeof modelManager !== 'undefined' && !!modelManager?.getState()?.loaded && typeof sendMessage === 'function'));
  const failures = [];
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 2) failures.push(text.slice(0, 500)); });
  report.checks.actualWindow = { electron: process.versions.electron, url: win.webContents.getURL() };
  await ui(async targets => {
    const mutate = async (method, payload) => { const latest = await window.codex.listModels(); const result = await window.codex[method]({ ...payload, expectedRevision: latest.revision }); if (!result.ok) throw new Error(`${method}: ${result.code}`); };
    for (const target of targets) {
      await mutate('saveModelProvider', { provider: { id: target.providerId, name: `E5 ${target.tag}`, protocol: target.protocol, baseUrl: `${target.origin}/v1`, auth: { kind: target.tag === 'anthropic' ? 'api-key' : 'none' } } });
      if (target.tag === 'anthropic') await mutate('setModelCredential', { providerId: target.providerId, credential: 'E5_OFFLINE_SYNTHETIC_CREDENTIAL_53' });
      await mutate('saveModelProfile', { model: { id: target.modelId, name: `E5 ${target.tag}`, providerId: target.providerId, model: target.model,
        request: { maxOutputTokens: 128 }, compatibility: { toolMode: 'none', streamMode: 'off', includeUsage: true }, capabilities: { text: { state: 'supported', source: 'declared' }, usage: { state: 'supported', source: 'declared' } } } });
    }
    await mutate('setDefaultModel', { modelProfileId: targets[0].modelId });
    await mutate('saveAssistant', { assistant: { id: 'assistant_e5_smoke', name: 'E5 离线参考助手', identityType: 'ai', builtIn: false, modelProfileId: null,
      systemPrompt: 'You are an offline reference test assistant. Do not use tools.', knowledge: { projectContext: false, projectMemory: false }, projectId: null, toolPolicy: { mode: 'none', allowedTools: [] } } });
    await modelManager.load();
  }, targets);
  for (const target of targets) {
    fs.writeFileSync(sourceFile, original);
    await ui(title => { document.querySelector('#main-toolbar [data-view="new-task"]').click(); document.getElementById('task-title').value = title; document.getElementById('btn-task-ok').click(); }, `E5 Electron ${target.tag}`);
    await waitFor('new session', () => ui(title => activeSession()?.title === title, `E5 Electron ${target.tag}`));
    for (const [id, field, value] of [['chat-assistant-select', 'assistantId', 'assistant_e5_smoke'], ['chat-model-select', 'modelProfileId', target.modelId]]) {
      await ui(({ id, value }) => { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }, { id, value });
      await waitFor(`selected ${field}`, () => ui(({ field, value }) => activeSession()?.[field] === value, { field, value }));
    }
    report.checks[`beforeImport_${target.tag}`] = await ui(() => ({ disabled: document.getElementById('btn-attach').disabled, blocked: storageWriteBlocked, identityType: activeSession()?.identityType, namespaceRef: activeSession()?.namespaceRef || null }));
    await ui(() => { document.getElementById('btn-attach').click(); });
    await waitFor('native captured draft reference', () => ui(() => pendingAttaches.length === 1 && pendingAttaches[0].refVersion === 1), 45000);
    fs.writeFileSync(sourceFile, 'REPLACED_EXTERNAL_SOURCE_CANARY');
    await ui(() => { const input = document.getElementById('chat-input'); input.value = 'Inspect the confirmed attachment'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btn-send').click(); });
    await waitFor('actual inert preview', () => ui(() => !document.getElementById('attachment-send-preview').classList.contains('hidden') && !document.getElementById('attachment-preview-confirm').disabled));
    const preview = await ui(() => ({ text: document.getElementById('attachment-preview-text').textContent, injected: !!window.__e5Injected,
      target: document.getElementById('attachment-preview-target').textContent, storage: document.getElementById('attachment-preview-storage').textContent }));
    assert.equal(preview.text, expectedText); assert.equal(preview.injected, false); assert.ok(preview.target.includes(target.protocol));
    const image = path.join(temp, `${target.tag}-preview.png`); fs.writeFileSync(image, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(image);
    const before = report.requests.length;
    await ui(() => { document.getElementById('attachment-preview-confirm').click(); });
    await waitFor('actual wire and foreground cleanup', () => report.requests.length === before + 1 && ui(() => !sending && (!chatRun || chatRun.finalized)));
    const final = await ui(() => ({ messages: activeSession().messages, draft: document.getElementById('chat-input').value }));
    assert.equal(final.messages.at(-1).content, `E5_OFFLINE_${target.tag}_OK`); assert.equal(final.draft, '');
    assert.ok(final.messages.find(message => message.role === 'user')?.parts.some(part => part.type === 'attachment_ref' && part.refVersion === 1));
    assert.equal(JSON.stringify(final.messages).includes(expectedText), false, 'Selected body is not persisted in messages');
    report.checks[target.tag] = { exactPreview: true, exactWire: true, inert: true, typedMetadataOnlyHistory: true, storage: preview.storage };
  }
  // Real DPAPI + real managed package IO, near the raw byte boundary, independently
  // of renderer dialog scheduling. No mock encryption or fs backend is admitted.
  const { createAttachmentBudget, LIMITS } = require('../src/ai/attachment-contract');
  const { createAttachmentReader } = require('../src/ai/attachment-reader');
  const { createAttachmentStore, createElectronSafeStorageAdapter } = require('../src/ai/attachment-store');
  const storeProfile = path.join(temp, 'store-profile'); fs.mkdirSync(storeProfile);
  const budget = createAttachmentBudget(), reader = createAttachmentReader({ budget, protectedPaths: [storeProfile, userData] });
  const adapter = createElectronSafeStorageAdapter(safeStorage);
  const store = createAttachmentStore({ cacheRoot: path.join(storeProfile, 'attachments-v1'), profileNamespace: 'e5-actual-electron', safeStorage: adapter, reader, budget });
  await store.initialize();
  assert.equal(store.cacheStatus().storageMode, safeStorage.isEncryptionAvailable() ? 'encrypted' : 'memory');
  const namespace = store.createNamespace({ sessionId: 'e5-near-limit' });
  const nearFile = path.join(temp, 'near-boundary.txt'), nearPrefix = 'NEAR_E5_ENCRYPTED_CANARY_77\n';
  fs.writeFileSync(nearFile, nearPrefix + 'a'.repeat(LIMITS.MAX_FILE_BYTES - Buffer.byteLength(nearPrefix)));
  assert.equal(fs.statSync(nearFile).size, LIMITS.MAX_FILE_BYTES);
  let imported;
  await budget.withWork({}, async work => {
    const captured = await reader.capture(reader.createExternalGrant(nearFile), { work });
    try { imported = await store.importBatch({ namespace, sessionId: namespace.sessionId, captures: [{ name: captured.name, mimeType: 'text/plain', sourceKind: 'user_upload', rawBytes: captured.bytes,
      rawDigest: captured.rawDigest, decodeVersion: 1, extractVersion: 1, extractedChars: LIMITS.MAX_FILE_BYTES, selectedChars: LIMITS.MAX_FILE_TEXT_CODEPOINTS }] }, { work }); } finally { captured.release(); }
  });
  const held = await store.read(imported.refs[0].attachmentId, namespace); assert.equal(held.bytes.length, LIMITS.MAX_FILE_BYTES);
  assert.equal(held.bytes.subarray(0, Buffer.byteLength(nearPrefix)).toString(), nearPrefix); await held.release();
  const status = store.cacheStatus();
  assert.equal(status.storageMode, safeStorage.isEncryptionAvailable() ? 'encrypted' : 'memory');
  if (safeStorage.isEncryptionAvailable()) assert.ok(status.diskBytes > LIMITS.MAX_FILE_BYTES, 'Actual ciphertext packages must exist');
  await store.close(); assert.equal(budget.snapshot().retainedBytes, 0); assert.equal(budget.snapshot().workBytes, 0);
  report.checks.actualSafeStorage = { available: safeStorage.isEncryptionAvailable(), mode: status.storageMode, rawBytes: LIMITS.MAX_FILE_BYTES, diskBytes: status.diskBytes, nearLimitRoundTrip: true, finalCleanup: budget.snapshot() };
  report.status = 'passed'; report.rendererErrors = failures; report.durationMs = Date.now() - startedAt;
}
const startedAt = Date.now();
run().then(() => { clearTimeout(guard); fs.writeFileSync(resultPath, JSON.stringify(report, null, 2)); console.log(`E5_ELECTRON_RESULT ${resultPath}`); app.exit(0); })
  .catch(error => { clearTimeout(guard); report.status = 'failed'; report.error = error.stack; fs.writeFileSync(resultPath, JSON.stringify(report, null, 2)); console.error(`E5_ELECTRON_RESULT ${resultPath}\n${error.stack}`); app.exit(1); });
