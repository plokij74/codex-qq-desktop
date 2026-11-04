'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../src/ai/message-schema');
const { publicAttachmentRef } = require('../src/ai/attachment-contract');

function ref(n = 1, extra = {}) {
  return { type: 'attachment_ref', ...publicAttachmentRef({ attachmentId: `att_${n.toString(16).padStart(32, '0')}`, name: 'sample.txt', mimeType: 'text/plain', size: 40,
    source: 'user_upload', status: 'ready', storageMode: 'encrypted', budget: { extractedChars: 40, selectedChars: 10, selectedBytes: 10, estimatedTokens: 3, truncated: true } }), ...extra };
}
function msg(parts, extra = {}) { return { id: 'e5-message', schemaVersion: 2, role: 'user', createdAt: 1, parts, ...extra }; }
const privateFields = { hash: 'private-hash', storagePath: 'C:\\private\\stored', localAbsPath: 'C:\\private\\original', base64: 'private-base64', body: 'PRIVATE_BODY', grants: 'private-grant', previewId: 'private-ticket', windowGrant: 'private-window' };

 test('E5 RefV1 normalization, UI and new storage have the exact public allowlist', () => {
  const raw = ref(1, { ...privateFields, budget: { selectedChars: 10, selectedBytes: 10, extractedChars: 40, estimatedTokens: 3, truncated: true, body: 'PRIVATE_BUDGET' } });
  for (const value of [schema.normalizeAttachmentRef(raw), schema.projectToStorageJson(msg([raw])).parts[0], schema.projectToUiModel(msg([raw])).attachments[0]]) {
    assert.deepEqual(Object.keys(value).filter(k => k !== 'type').sort(), ['refVersion', 'attachmentId', 'name', 'mimeType', 'size', 'source', 'status', 'storageMode', 'budget'].sort());
    assert.deepEqual(Object.keys(value.budget).sort(), ['extractedChars', 'selectedChars', 'selectedBytes', 'estimatedTokens', 'truncated'].sort());
    for (const marker of Object.values(privateFields)) assert.equal(JSON.stringify(value).includes(marker), false, marker);
  }
  assert.equal(schema.projectToStorageJson(msg([raw])).schemaVersion, 2);
});

test('old refs keep an existing locator but never synthesize a ready attachment', () => {
  const raw = { id: 'old-locator', name: 'old.txt', status: 'ready', storagePath: 'C:\\private' };
  assert.deepEqual(schema.normalizeAttachmentRef(raw), schema.normalizeAttachmentRef(raw));
  assert.equal(schema.normalizeAttachmentRef(raw).attachmentId, 'old-locator');
  assert.equal(schema.normalizeAttachmentRef(raw).status, 'legacy_unavailable');
  assert.equal(schema.normalizeAttachmentRef({ name: 'no-id' }).attachmentId, '');
  assert.equal(schema.normalizeAttachmentRef({ name: 'no-id' }).storageMode, 'unavailable');
});

test('attachment normalization does not execute private property getters', () => {
  const raw = ref();
  Object.defineProperty(raw, 'body', { enumerable: true, get() { throw new Error('body getter must not execute'); } });
  Object.defineProperty(raw, 'localAbsPath', { enumerable: true, get() { throw new Error('path getter must not execute'); } });
  assert.equal(schema.normalizeAttachmentRef(raw).status, 'ready');
});

test('model metadata projection cannot call renderer expander opts or claim it read bytes', () => {
  let called = 0;
  const output = schema.projectToModelMessages([msg([{ type: 'text', text: 'see @sample.txt' }, ref()])], {
    projectPath: 'C:\\private', expandAtRefs() { called++; return { contextBlock: 'PRIVATE_ORIGINAL' }; }, bodyMap: { sample: 'PRIVATE_BODY' },
  });
  assert.equal(called, 0);
  assert.equal(output[0].content.includes('PRIVATE_ORIGINAL'), false);
  assert.match(output[0].content, /仅元信息|metadata/);
  assert.match(output[0].content, /未读取|未提供正文/);
  assert.match(output[0].content, /状态.*ready/);
  assert.match(output[0].content, /截断/);
});

test('main-only pure model projection avoids storage slice without loosening storage caps', () => {
  const text = 'x'.repeat(70000) + ' tail sk-' + 'A'.repeat(32);
  const raw = msg([{ type: 'text', text }, ref()]);
  const model = schema.projectToModelMessagesWithoutStorageTruncation([raw]);
  assert.ok(model[0].content.length > 70000);
  assert.match(model[0].content, /tail/);
  assert.equal(model[0].content.includes('sk-' + 'A'.repeat(32)), false);
  assert.ok(schema.projectToStorageJson(raw).parts[0].text.length < 66000);
  assert.ok(schema.projectToModelMessages([raw])[0].content.length < 66000);
});

test('identified legacy image paragraphs and old dataUrl carriers become unsupported metadata without mutating history', () => {
  const url = 'data:image/png;base64,U1lOVEhFVElD';
  const raw = msg([{ type: 'text', text: `look\n\n![old.png](${url})` }, { type: 'attachment_ref', id: 'old-image', name: 'old.png', mimeType: 'image/png', dataUrl: url }], { content: `look\n\n![old.png](${url})` });
  const original = JSON.stringify(raw);
  for (const value of [schema.normalizeMessage(raw), schema.projectToStorageJson(raw), schema.projectToUiModel(raw), schema.projectToModelMessages([raw])]) {
    assert.equal(JSON.stringify(value).includes(url), false);
    assert.match(JSON.stringify(value), /unsupported/);
  }
  assert.equal(JSON.stringify(raw), original);
  const legacy = { role: 'user', content: `![old.png](${url})`, attachments: [{ name: 'old.png', mimeType: 'image/png', dataUrl: url }] };
  assert.equal(schema.projectToStorageJson(legacy).parts.find(p => p.type === 'attachment_ref').status, 'unsupported');
});

test('ordinary data URL examples and fenced Markdown examples are not erased', () => {
  const text = 'Use data:image/png;base64,U1lOVEhFVElD as a string.\n\n```md\n![old.png](data:image/png;base64,U1lOVEhFVElD)\n```';
  const raw = msg([{ type: 'text', text }, { type: 'attachment_ref', id: 'old-image', name: 'old.png', mimeType: 'image/png' }]);
  assert.equal(schema.projectToStorageJson(raw).parts[0].text, text);
});

test('ambiguous standalone legacy image payload fails closed with a safe code and no original mutation', () => {
  const raw = { role: 'user', content: '![old.png](data:image/png;base64,U1lOVEhFVElD)' };
  const original = JSON.stringify(raw);
  for (const fn of [schema.projectToStorageJson, schema.projectToUiModel, value => schema.projectToModelMessages([value])]) {
    assert.throws(() => fn(raw), e => e.code === 'ATTACHMENT_LEGACY_REQUIRES_MIGRATION' && !e.message.includes('U1lOVEhFVElD'));
  }
  assert.equal(JSON.stringify(raw), original);
});

test('storage must explicitly reject attachment parts that its 256 part cap would lose', () => {
  const raw = msg([...Array.from({ length: 256 }, () => ({ type: 'text', text: 'safe' })), ref()]);
  assert.throws(() => schema.projectToStorageJson(raw), e => e.code === 'ATTACHMENT_PARTS_LIMIT');
});

module.exports = { ref, msg };
