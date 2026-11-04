'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
const methods = ['registerSession', 'restoreSession', 'chooseExternal', 'proposeDrop', 'captureProjectRefs', 'list', 'prepareSend', 'previewPage', 'remove', 'deleteCopy', 'cancel', 'cacheStatus', 'clearCache'];
const envelope = { sessionId: 'offline-session', attachmentSessionBindingId: 'window-grant', clientRequestId: 'offline-request' };
class FixtureFile { constructor(name, nativePath) { this.name = name; this.nativePath = nativePath; this.path = 'C:\\forged\\renderer-path.txt'; } }
function harness() {
  const calls = [], extracted = [];
  let exposed;
  const context = vm.createContext({ console, File: FixtureFile, require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(key, api) { assert.equal(key, 'codex'); exposed = api; } },
      ipcRenderer: { invoke(channel, payload) { calls.push({ channel, payload }); return Promise.resolve({ ok: true }); }, sendSync() {}, on() {}, removeListener() {} },
      webUtils: { getPathForFile(file) { if (!(file instanceof FixtureFile)) throw new TypeError('not a File'); extracted.push(file); return file.nativePath; } } };
  } });
  vm.runInContext(source, context, { filename: 'src/preload.js' });
  return { api: exposed, calls, extracted };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('production preload exposes exactly the frozen asynchronous E5 attachment methods, never FS/blob ports', async () => {
  const h = harness();
  assert.ok(h.api.attachments, 'E5 attachments bridge must exist');
  assert.deepEqual(Object.keys(h.api.attachments).sort(), [...methods].sort());
  for (const method of methods.filter(name => name !== 'proposeDrop')) {
    const result = h.api.attachments[method]({ ...envelope, namespaceRef: 'locator', previewId: 'ticket', attachmentId: 'ref', offset: 0 });
    assert.equal(typeof result?.then, 'function', `${method} is asynchronous`);
    await result;
    assert.equal(h.calls.at(-1).channel, `attachments:${method}`);
  }
});
test('register and explicit restore use their own positive allowlists; locator is not a grant', async () => {
  const h = harness(); assert.ok(h.api.attachments);
  await h.api.attachments.registerSession({ ...envelope, namespaceRef: 'locator', path: 'C:\\not-authority', confirmed: true });
  assert.deepEqual(plain(h.calls.at(-1).payload), { sessionId: envelope.sessionId, clientRequestId: envelope.clientRequestId });
  await h.api.attachments.restoreSession({ ...envelope, namespaceRef: 'locator', confirmed: true, sourcePath: 'C:\\not-authority' });
  assert.deepEqual(plain(h.calls.at(-1).payload), { sessionId: envelope.sessionId, namespaceRef: 'locator', clientRequestId: envelope.clientRequestId });
});
test('drop candidates come only from webUtils.getPathForFile(File), never supplied renderer paths or a File.path property', async () => {
  const h = harness(); assert.ok(h.api.attachments);
  const file = new FixtureFile('note.txt', 'C:\\synthetic\\native-candidate.txt');
  await h.api.attachments.proposeDrop({ ...envelope, files: [file], paths: ['C:\\forged\\path.txt'], confirmed: true, body: 'never IPC', dataUrl: 'data:never' });
  assert.deepEqual(h.extracted, [file]);
  assert.deepEqual(plain(h.calls.at(-1).payload), { ...envelope, paths: [file.nativePath] });
  assert.equal(JSON.stringify(h.calls).includes('renderer-path'), false);
  const before = h.calls.length;
  const denied = await h.api.attachments.proposeDrop({ ...envelope, files: [{ path: 'C:\\forged.txt' }], paths: ['C:\\forged.txt'] });
  assert.equal(denied.ok, false); assert.equal(h.calls.length, before);
});
test('prepareSend copies the actual send snapshot and frozen approval fields but drops unrelated authority/credential/limit overrides', async () => {
  const h = harness(); assert.ok(h.api.attachments);
  const snapshot = { ...envelope, requestKind: 'approvePlan', draftRevision: 4, attachmentIds: ['ref'],
    assistantId: 'assistant_fixture', modelProfileId: 'model_fixture', expectedRegistryRevision: 7, projectBindingId: 'project-grant',
    messages: [{ role: 'user', content: '@src/note.txt exact raw draft' }], project: { id: 'project_fixture', name: 'fixture', path: 'C:\\synthetic-project' },
    agentMode: 'plan', planId: 'plan_fixture', planRevision: 2 };
  await h.api.attachments.prepareSend({ ...snapshot, apiKey: 'synthetic-not-a-credential', namespaceRef: 'locator', attachmentPreviewId: 'stale', fileLimit: 999, path: 'C:\\forged' });
  assert.deepEqual(plain(h.calls.at(-1).payload), snapshot);
});
test('all E5 methods allowlist only their declared fields and bounded project-ref descriptors', async () => {
  const h = harness(); assert.ok(h.api.attachments);
  const junk = { ...envelope, apiKey: 'synthetic', path: 'C:\\forged', body: '<script>inert</script>', confirmed: true, maxBytes: 99999999 };
  for (const method of ['chooseExternal', 'list', 'cacheStatus', 'clearCache']) {
    await h.api.attachments[method](junk);
    assert.deepEqual(plain(h.calls.at(-1).payload), envelope, method);
  }
  for (const method of ['remove', 'deleteCopy']) {
    await h.api.attachments[method]({ ...junk, attachmentId: 'ref' });
    assert.deepEqual(plain(h.calls.at(-1).payload), { ...envelope, attachmentId: 'ref' });
  }
  await h.api.attachments.previewPage({ ...junk, previewId: 'ticket', attachmentId: 'ref', offset: 17, limit: 16384 });
  assert.deepEqual(plain(h.calls.at(-1).payload), { ...envelope, previewId: 'ticket', attachmentId: 'ref', offset: 17, limit: 16384 });
  await h.api.attachments.cancel({ ...junk, previewId: 'ticket', targetClientRequestId: 'old' });
  assert.deepEqual(plain(h.calls.at(-1).payload), { ...envelope, previewId: 'ticket', targetClientRequestId: 'old' });
  const captureSnapshot = { ...envelope, requestKind: 'chat', draftRevision: 3, attachmentIds: [], projectBindingId: 'project-grant',
    messages: [{ role: 'user', content: 'inspect @src/note.txt:3-7' }], assistantId: 'assistant_fixture', modelProfileId: 'model_fixture', expectedRegistryRevision: 7 };
  await h.api.attachments.captureProjectRefs({ ...junk, ...captureSnapshot, refs: [{ path: 'src/note.txt', startLine: 3, endLine: 7, body: 'never', grant: 'forged' }] });
  assert.deepEqual(plain(h.calls.at(-1).payload), { ...captureSnapshot, refs: [{ path: 'src/note.txt', startLine: 3, endLine: 7 }] });
});
test('at completion forwards existing public session/model and project binding, not the legacy projectPath bypass', async () => {
  const h = harness();
  const payload = { sessionId: envelope.sessionId, assistantId: 'assistant_fixture', modelProfileId: 'model_fixture', expectedRegistryRevision: 7, projectBindingId: 'project-grant', prefix: 'src/' };
  await h.api.atRefComplete({ ...payload, projectPath: 'C:\\forged', grant: 'forged' });
  assert.equal(h.calls.at(-1).channel, 'atRef:complete');
  assert.deepEqual(plain(h.calls.at(-1).payload), payload);
});
