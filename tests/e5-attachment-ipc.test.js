'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadMainFixture } = require('./helpers/e4-main-fixture');

const CHANNELS = ['registerSession', 'restoreSession', 'chooseExternal', 'proposeDrop', 'list', 'captureProjectRefs',
  'prepareSend', 'previewPage', 'remove', 'deleteCopy', 'cancel', 'cacheStatus', 'clearCache'];

test('E5 real main registers every bounded attachment IPC without replacing preload authority', async t => {
  const main = loadMainFixture(t);
  for (const method of CHANNELS) assert.equal(typeof main.handlers.get(`attachments:${method}`), 'function', method);
  const registered = await main.invoke('attachments:registerSession', { sessionId: 'e5-session', clientRequestId: 'register' });
  assert.equal(registered.ok, true);
  assert.match(registered.attachmentSessionBindingId, /^asb_[a-f0-9]{32}$/);
  assert.equal(registered.storageMode, 'memory');
  assert.equal(main.credentialReads.length, 0);
  assert.equal(main.requests.length, 0);
});

test('E5 real main refuses a sender object spoofing a live webContents id', async t => {
  const main = loadMainFixture(t);
  const spoof = new EventEmitter(); spoof.id = main.sender.id; spoof.isDestroyed = () => false; spoof.send = () => {};
  const result = await main.invoke('attachments:registerSession', { sessionId: 'e5-session', clientRequestId: 'spoof' }, spoof);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ATTACHMENT_REFERENCE_INVALID');
  assert.equal(main.requests.length, 0);
});

test('E5 current typed @ inventory cannot omit a preview or become a plain text dispatch', async t => {
  const main = loadMainFixture(t);
  const result = await main.invoke('chat:send', main.payload({ messages: [{ role: 'user', content: 'Review @secret.txt' }] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ATTACHMENT_PREVIEW_REQUIRED');
  assert.equal(main.credentialReads.length, 0);
  assert.equal(main.requests.length, 0);
  assert.equal(main.events.filter(r => r.event.type === 'run-start').length, 0);
  assert.equal(main.inspect('Boolean(foregroundModels.current)'), false);
});

test('E5 explicit current attachment_ref and omitted attachmentIds require preview before acceptance', async t => {
  const main = loadMainFixture(t);
  const result = await main.invoke('chat:send', main.payload({ messages: [{ version: 3, role: 'user', content: '', parts: [
    { type: 'attachment_ref', attachmentId: `att_${'a'.repeat(32)}`, name: 'fake.txt', mimeType: 'text/plain', sourceKind: 'user_upload', status: 'ready' },
  ] }] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ATTACHMENT_PREVIEW_REQUIRED');
  assert.equal(main.requests.length, 0);
  assert.equal(main.events.filter(r => r.event.type === 'run-start').length, 0);
});

test('E5 old project raw-path read/expand IPC cannot bypass sender/binding/preview', async t => {
  const main = loadMainFixture(t);
  const project = path.join(main.root, 'synthetic-project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'synthetic.txt'), 'MUST_NOT_LEAK_E5');
  const read = await main.handlers.get('project:readFile')({ sender: main.otherSender }, project, 'synthetic.txt');
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ATTACHMENT_READ_DENIED');
  assert.equal(JSON.stringify(read).includes('MUST_NOT_LEAK_E5'), false);
  const expanded = await main.invoke('atRef:expand', { projectPath: project, text: '@synthetic.txt' });
  assert.equal(expanded.ok, false);
  assert.equal(expanded.code, 'ATTACHMENT_PREVIEW_REQUIRED');
  assert.equal(JSON.stringify(expanded).includes('MUST_NOT_LEAK_E5'), false);
});

module.exports = { CHANNELS };
