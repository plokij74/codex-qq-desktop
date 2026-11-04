'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAttachmentPreviewService, getAttachmentRunData } = require('../src/ai/attachment-preview');
const { createPreviewFixture } = require('./helpers/e5-preview-fixture');

async function setup() {
  const fixture = createPreviewFixture();
  const service = createAttachmentPreviewService(fixture.options);
  const event = fixture.sender(1);
  const registered = await service.registerSession(event, { sessionId: 's', clientRequestId: 'register' });
  const envelope = { sessionId: 's', attachmentSessionBindingId: registered.attachmentSessionBindingId, clientRequestId: 'send' };
  const payload = (text = 'Use the file', ids = []) => ({ ...envelope, messages: [{ role: 'user', content: text, parts: [{ type: 'text', text }] }], attachmentIds: ids, draftRevision: 1, projectBindingId: 'pb_project' });
  const upload = async () => (await service.chooseExternal(event, { ...envelope, clientRequestId: 'choose' })).refs[0];
  return { ...fixture, service, event, registered, envelope, payload, upload };
}
test('accepted compact link synchronization preserves current refs without reading historical bytes', async () => {
  const f = await setup(), ref = await f.upload(), updates = [];
  f.store.syncMessageLinks = async (_namespace, links) => { updates.push(links.ids); };
  const payload = f.payload('Use the file', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload);
  const run = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId });
  f.service.consume(run); await run.ready(); const reads = f.counters.sourceReads;
  await run.syncMessageLinks([{ role: 'system', parts: [{ type: 'attachment_ref', attachmentId: 'att_00000000000000000000000000000000' }] }]);
  assert.equal(updates.length, 2); assert.deepEqual(updates[1], [ref.attachmentId]);
  assert.equal(f.counters.sourceReads, reads); await run.check(); await run.release(); await f.service.close();
});
test('dispatch checks borrow the exact wire work brand without rereading source bytes', async () => {
  const f = await setup(), payload = f.payload('@code.js');
  const preview = await f.service.prepareSend(f.event, payload);
  const run = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId });
  f.service.consume(run); await run.ready(); const reads = f.counters.sourceReads;
  await f.budget.withWork({}, async work => { await run.check({ work }); assert.equal(f.budget.snapshot().activeWork, 1); });
  assert.equal(f.counters.sourceReads, reads); await run.release(); await f.service.close();
});

test('registered secret generations invalidate prepared text without reading credentials or sources', async () => {
  const secrets = require('../src/ai/secret-manager');
  assert.equal(typeof secrets.getSecretRedactionGeneration, 'function');
  const fixture = createPreviewFixture(); fixture.options.getRedactionGeneration = secrets.getSecretRedactionGeneration;
  const service = createAttachmentPreviewService(fixture.options), event = fixture.sender(1);
  const registration = await service.registerSession(event, { sessionId: 'redaction', clientRequestId: 'register' });
  const envelope = { sessionId: 'redaction', attachmentSessionBindingId: registration.attachmentSessionBindingId, clientRequestId: 'send' };
  const imported = await service.chooseExternal(event, envelope);
  const payload = { ...envelope, messages: [{ role: 'user', content: 'inspect' }], attachmentIds: [imported.refs[0].attachmentId] };
  const preview = await service.prepareSend(event, payload), reads = fixture.counters.storeReads;
  const manager = new secrets.SecretManager({ useSafeStorage: false });
  manager.registerSecret('E5_REDACTION_VERSION_CANARY_93af', 'E5_UNIT');
  await assert.rejects(service.claimSend(event, { ...payload, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
  assert.equal(fixture.counters.storeReads, reads); await service.close();
});

test('E5 redaction has bounded neutral replacements even with huge registered labels', async () => {
  const { redactAttachmentText } = require('../src/ai/attachment-redaction');
  const { SecretManager } = require('../src/ai/secret-manager');
  new SecretManager({ useSafeStorage: false }).registerSecret('ABCD', 'X'.repeat(4096));
  const input = 'ABCD'.repeat(2000), output = redactAttachmentText(input);
  assert.equal(output, '[REDACTED]'.repeat(2000)); assert.equal(output.includes('ABCD'), false);
  assert.equal(output.length < input.length * 3, true);
  const { extractText } = require('../src/ai/attachment-reader');
  const { createAttachmentBudget, LIMITS } = require('../src/ai/attachment-contract');
  const budget = createAttachmentBudget();
  await budget.withWork({}, async work => {
    const bytes = Buffer.allocUnsafeSlow(LIMITS.MAX_FILE_BYTES); bytes.write('ABCD'.repeat(LIMITS.MAX_FILE_BYTES / 4));
    const selected = extractText({ bytes, name: 'bounded.txt', sourceKind: 'user_upload' }, { work, redact: redactAttachmentText });
    assert.equal(selected.selectedChars, LIMITS.MAX_FILE_TEXT_CODEPOINTS);
    assert.equal(selected.rawByteLength, LIMITS.MAX_FILE_BYTES); assert.equal(selected.truncated, true); bytes.fill(0);
  });
  assert.equal(budget.snapshot().workBytes, 0);
});

test('automatic project prefix selections survive fresh IDs but never authorize absent current tokens', async () => {
  const f = await setup(), payload = f.payload('@code.js');
  const first = await f.service.prepareSend(f.event, payload), oldId = first.attachments[0].attachmentId;
  await f.service.cancel(f.event, { ...f.envelope, previewId: first.previewId });
  const shrunk = { ...payload, attachmentSelections: [{ attachmentId: oldId, prefixCodePoints: 3 }] };
  const second = await f.service.prepareSend(f.event, shrunk), newId = second.attachments[0].attachmentId;
  assert.notEqual(newId, oldId); assert.equal(second.attachments[0].budget.selectedChars, 3);
  const run = await f.service.claimSend(f.event, { ...shrunk, attachmentPreviewId: second.previewId,
    attachmentSelections: [{ attachmentId: newId, prefixCodePoints: 3 }] });
  f.service.consume(run); await run.ready(); await run.release();
  const reads = f.counters.sourceReads;
  await assert.rejects(f.service.prepareSend(f.event, { ...shrunk, messages: [{ role: 'user', content: 'no current reference' }] }), code('ATTACHMENT_TEXT_LIMIT'));
  assert.equal(f.counters.sourceReads, reads); await f.service.close();
});

const code = expected => error => error?.code === expected;

test('namespace locator does not grant another window or session read authority', async () => {
  const f = await setup(); await f.upload();
  await assert.rejects(f.service.list(f.sender(2), f.envelope), code('ATTACHMENT_REFERENCE_INVALID'));
  await assert.rejects(f.service.list(f.event, { ...f.envelope, sessionId: 'other' }), code('ATTACHMENT_REFERENCE_INVALID'));
  await assert.rejects(f.service.restoreSession(f.sender(2), { sessionId: 's', namespaceRef: f.registered.namespaceRef, clientRequestId: 'restore' }), code('ATTACHMENT_REFERENCE_INVALID'));
  assert.equal(f.counters.storeReads, 0);
});

test('raw source path cannot be smuggled into chooser and rejected drop never reads', async () => {
  const f = await setup();
  await assert.rejects(f.service.chooseExternal(f.event, { ...f.envelope, path: 'C:\\private' }), code('ATTACHMENT_REFERENCE_INVALID'));
  f.state.allowDrop = false;
  await assert.rejects(f.service.proposeDrop(f.event, { ...f.envelope, paths: ['C:\\outside\\note.txt'] }), code('ATTACHMENT_READ_DENIED'));
  assert.equal(f.counters.sourceReads, 0); assert.equal(f.counters.picker, 0);
});

test('upload returns only public refs and the later source is not reopened', async () => {
  const f = await setup(); const ref = await f.upload(); const serialized = JSON.stringify(ref);
  assert.equal(ref.refVersion, 1); assert.equal(ref.source, 'user_upload');
  assert.ok(!/CANARY|outside|rawDigest|rawBytes|sourceInfo|storagePath/.test(serialized));
  const payload = f.payload('Use it', [ref.attachmentId]); const preview = await f.service.prepareSend(f.event, payload);
  assert.equal(preview.required, true); assert.ok(!JSON.stringify(preview).includes('EXTERNAL_CANARY'));
  const page = await f.service.previewPage(f.event, { ...f.envelope, previewId: preview.previewId, attachmentId: ref.attachmentId, offset: 0 });
  assert.equal(page.text, 'EXTERNAL_CANARY\n');
  f.sources.set('C:\\outside\\note.txt', Buffer.from('REPLACED'));
  const lease = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId });
  assert.equal(getAttachmentRunData(lease).entries[0].text, page.text); assert.equal(f.counters.sourceReads, 1);
  f.service.consume(lease); await lease.release(); assert.equal(f.counters.holds, 0);
});

test('host current-message reference inventory requires preview before blob or source reads', async () => {
  const f = await setup(); const ref = await f.upload(); const payload = f.payload();
  payload.messages[0].parts.push({ type: 'attachment_ref', ...ref }); payload.attachmentIds = [];
  await assert.rejects(f.service.claimSend(f.event, payload), code('ATTACHMENT_PREVIEW_REQUIRED'));
  assert.equal(f.counters.storeReads, 0); assert.equal(f.counters.sourceReads, 1);
  await assert.rejects(f.service.claimSend(f.event, f.payload('@code.js')), code('ATTACHMENT_PREVIEW_REQUIRED'));
  assert.equal(f.counters.projectResolves, 0);
});

test('current @ tokens alone are captured; attachment body and code examples are not parsed', async () => {
  const f = await setup(); f.sources.set('C:\\outside\\note.txt', Buffer.from('@secret.txt\n'));
  const ref = await f.upload(); const payload = f.payload('`@not-a-ref` @code.js:1', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload);
  assert.equal(preview.attachments.length, 2); assert.equal(f.counters.sourceReads, 2);
  const lease = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId });
  const data = getAttachmentRunData(lease);
  assert.equal(data.entries[1].text, 'const x = 7;\n'); assert.equal(data.inventory.length, 1);
  assert.ok(data.userMessage.parts.some(part => part.type === 'attachment_ref' && part.source === 'at_project_ref'));
  await lease.release(); await f.service.cancel(f.event, { ...f.envelope, previewId: preview.previewId });
});

test('changed current @ source fails claim, while source changes after claim use the confirmed snapshot', async () => {
  const f = await setup(); const payload = f.payload('@code.js');
  const preview = await f.service.prepareSend(f.event, payload); f.sources.set('C:\\project\\code.js', Buffer.from('NEW_BYTES'));
  await assert.rejects(f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_SOURCE_CHANGED'));
  const next = await f.service.prepareSend(f.event, { ...payload, clientRequestId: 'next' });
  const lease = await f.service.claimSend(f.event, { ...payload, clientRequestId: 'next', attachmentPreviewId: next.previewId });
  f.service.consume(lease); f.sources.set('C:\\project\\code.js', Buffer.from('AFTER_CLAIM'));
  await lease.check(); assert.equal(getAttachmentRunData(lease).entries[0].text, 'NEW_BYTES');
  assert.ok(getAttachmentRunData(lease).sourceValidatedAt > 0); await lease.release();
});

test('binding, draft, target or redaction changes invalidate a preview without consumption', async () => {
  const f = await setup(); const ref = await f.upload(); const payload = f.payload('SECRET_VALUE', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload);
  await assert.rejects(f.service.claimSend(f.event, { ...payload, draftRevision: 2, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
  f.state.revision++;
  await assert.rejects(f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
  f.state.revision--; f.state.redactionGeneration++;
  await assert.rejects(f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
});

test('previews are single-use only after actual foreground admission and cleanup releases reservations', async () => {
  const f = await setup(); const ref = await f.upload(); const payload = f.payload('Use it', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload); const request = { ...payload, attachmentPreviewId: preview.previewId };
  const rejectedAdmission = await f.service.claimSend(f.event, request); await rejectedAdmission.release();
  const accepted = await f.service.claimSend(f.event, request); f.service.consume(accepted);
  await assert.rejects(f.service.claimSend(f.event, request), code('ATTACHMENT_PREVIEW_USED'));
  await accepted.release(); assert.equal(f.budget.snapshot().retainedBytes, 0); assert.equal(f.budget.snapshot().workBytes, 0); assert.equal(f.counters.holds, 0);
  assert.throws(() => getAttachmentRunData({}), code('ATTACHMENT_REFERENCE_INVALID'));
});

test('expired, removed or cancelled references cannot quietly fall back to metadata or raw @ reads', async () => {
  const f = await setup(); const ref = await f.upload(); const payload = f.payload('Use', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload); f.state.now += 300001;
  await assert.rejects(f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
  f.state.now = 100; const next = await f.service.prepareSend(f.event, payload);
  await f.service.remove(f.event, { ...f.envelope, attachmentId: ref.attachmentId });
  await assert.rejects(f.service.claimSend(f.event, { ...payload, attachmentPreviewId: next.previewId }), code('ATTACHMENT_PREVIEW_STALE'));
  assert.equal(f.budget.snapshot().retainedBytes, 0);
});

test('accepted run observes removal and owner revocation without cancelling unrelated pending requests', async () => {
  const f = await setup(); const ref = await f.upload(); const payload = f.payload('Use', [ref.attachmentId]);
  const preview = await f.service.prepareSend(f.event, payload); const lease = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId }); f.service.consume(lease);
  await f.service.cancel(f.event, f.envelope); await lease.check();
  await f.service.deleteCopy(f.event, { ...f.envelope, attachmentId: ref.attachmentId });
  await assert.rejects(lease.check(), code('ATTACHMENT_DELETED')); await lease.release();
  assert.equal(f.budget.snapshot().retainedBytes, 0);
});

test('UTF8 Unicode prefix pages are the exact redacted projected text and never split surrogates', async () => {
  const f = await setup(); f.sources.set('C:\\outside\\note.txt', Buffer.from('SECRET_VALUE🙂🙂🙂'));
  const ref = await f.upload(); const payload = { ...f.payload('Use', [ref.attachmentId]), attachmentSelections: [{ attachmentId: ref.attachmentId, prefixCodePoints: 12 }] };
  const preview = await f.service.prepareSend(f.event, payload);
  const a = await f.service.previewPage(f.event, { ...f.envelope, previewId: preview.previewId, attachmentId: ref.attachmentId, offset: 0, limit: 10 });
  const b = await f.service.previewPage(f.event, { ...f.envelope, previewId: preview.previewId, attachmentId: ref.attachmentId, offset: 10, limit: 10 });
  const lease = await f.service.claimSend(f.event, { ...payload, attachmentPreviewId: preview.previewId });
  assert.equal(a.text + b.text, '[REDACTED]🙂🙂'); assert.equal(getAttachmentRunData(lease).entries[0].text, a.text + b.text);
  assert.equal(preview.attachments[0].budget.selectedChars, 12); await lease.release(); await f.service.close();
});

test('pure text prepare and claim do not create namespaces, consent or read any byte source', async () => {
  const f = createPreviewFixture(); const service = createAttachmentPreviewService(f.options); const event = f.sender(1);
  const payload = { sessionId: 'text', clientRequestId: 'text', messages: [{ role: 'user', content: 'Explain `@example.txt`' }], attachmentIds: [], draftRevision: 1 };
  assert.equal((await service.prepareSend(event, payload)).required, false);
  assert.equal(await service.claimSend(event, payload), null); assert.equal(f.namespaces.size, 0); assert.equal(f.counters.sourceReads + f.counters.storeReads + f.counters.consent, 0);
});

test('pending capture cancellation waits actual cleanup and cannot cancel an accepted other run', async () => {
  const f = await setup(); let resolve; f.state.paused = new Promise(r => { resolve = r; });
  const pending = f.service.chooseExternal(f.event, { ...f.envelope, clientRequestId: 'slow' });
  await new Promise(r => setImmediate(r)); let cancelled = false;
  const rejected = assert.rejects(pending, code('ABORTED'));
  const cancellation = f.service.cancel(f.event, { ...f.envelope, targetClientRequestId: 'slow' }).then(() => { cancelled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, false); assert.equal(f.budget.snapshot().activeWork, 1); resolve();
  await Promise.all([cancellation, rejected]);
  assert.equal(cancelled, true); assert.equal(f.budget.snapshot().activeWork, 0); assert.equal(f.budget.snapshot().workBytes, 0);
});
