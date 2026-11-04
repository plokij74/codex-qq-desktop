'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const compact = require('../src/ai/session-compact');
const exportsApi = require('../src/ai/session-export');
const stateApi = require('../src/renderer/e4-chat-state');
const schema = require('../src/ai/message-schema');
const { publicAttachmentRef } = require('../src/ai/attachment-contract');
const { buildModelUsageEvent } = require('../src/ai/model-usage');

function ref(n = 1, extra = {}) {
  return { type: 'attachment_ref', ...publicAttachmentRef({ attachmentId: `att_${n.toString(16).padStart(32, '0')}`, name: `sample-${n}.txt`, mimeType: 'text/plain', size: 40,
    source: 'user_upload', status: 'ready', storageMode: 'encrypted', budget: { extractedChars: 40, selectedChars: 10, selectedBytes: 10, estimatedTokens: 3, truncated: true } }), ...extra };
}
function message(n, parts, extra = {}) { return { id: `message-${n}`, schemaVersion: 2, role: n % 2 ? 'user' : 'assistant', createdAt: n, parts, content: `conclusion-${n}`, ...extra }; }
const privateFields = { hash: 'PRIVATE_HASH', storagePath: 'C:\\private\\stored', localAbsPath: 'C:\\private\\source', base64: 'PRIVATE_BASE64', body: 'PRIVATE_ORIGINAL', windowGrant: 'PRIVATE_GRANT', previewId: 'PRIVATE_TICKET' };

 test('compact manifests dedupe public refs and preserve locators in summary parts and storage', () => {
  const history = [message(1, [ref(1, privateFields), ref(1)]), message(2, [ref(2)]), message(3, [{ type: 'text', text: 'recent' }])];
  const original = JSON.stringify(history);
  const manifest = compact.gatherAttachmentManifest(history.slice(0, 2));
  assert.equal(manifest.length, 2);
  for (const marker of Object.values(privateFields)) assert.equal(JSON.stringify(manifest).includes(marker), false);
  const plan = compact.planCompact(history, { force: true, keepMessages: 1 });
  assert.deepEqual(plan.attachmentManifest, manifest);
  const output = compact.applyCompact(history, { ...plan, attachmentManifest: [] }, 'Existing safe conclusion');
  assert.equal(output[0].schemaVersion, 2);
  assert.deepEqual(output[0].attachmentManifest, manifest);
  assert.deepEqual(output[0].parts.filter(p => p.type === 'attachment_ref'), manifest);
  assert.deepEqual(schema.projectToStorageJson(output[0]).attachmentManifest, manifest);
  assert.equal(output[1].id, 'message-3');
  assert.equal(JSON.stringify(history), original);
});

test('compact must derive source refs rather than accepting an omitted renderer older manifest', () => {
  const history = [message(1, [ref(1)]), message(2, [{ type: 'text', text: 'keep' }])];
  const output = compact.applyCompact(history, { older: [], keep: [history[1]], attachmentManifest: [] }, 'safe conclusion');
  assert.equal(output[0].attachmentManifest[0].attachmentId, ref(1).attachmentId);
  assert.equal(output[0].compactedCount, 1);
});

test('129 compact refs fail explicitly before any replacement and 128 refs remain complete', () => {
  const history = Array.from({ length: 129 }, (_, i) => message(i + 1, [ref(i + 1)]));
  const keep = message(130, [{ type: 'text', text: 'keep' }]);
  const original = JSON.stringify(history);
  assert.throws(() => compact.gatherAttachmentManifest(history), e => e.code === 'ATTACHMENT_COMPACT_MANIFEST_LIMIT');
  assert.throws(() => compact.planCompact([...history, keep], { force: true, keepMessages: 1 }), e => e.code === 'ATTACHMENT_COMPACT_MANIFEST_LIMIT');
  assert.throws(() => compact.applyCompact([...history, keep], { older: history, keep: [keep] }, 'summary'), e => e.code === 'ATTACHMENT_COMPACT_MANIFEST_LIMIT');
  const output = compact.applyCompact([...history.slice(0, 128), keep], { older: history.slice(0, 128), keep: [keep] }, 'summary');
  assert.equal(output[0].parts.length, 129);
  assert.equal(schema.projectToStorageJson(output[0]).parts.filter(p => p.type === 'attachment_ref').length, 128);
  assert.equal(JSON.stringify(history), original);
});

test('compact and memory transcript contains only metadata and saved conclusions, not managed image bytes', () => {
  const url = 'data:image/png;base64,U1lOVEhFVElD';
  const history = [message(1, [{ type: 'text', text: `look\n\n![old.png](${url})` }, { type: 'attachment_ref', name: 'old.png', mimeType: 'image/png', dataUrl: url }], { content: `look\n\n![old.png](${url})` }), message(2, [ref(2, privateFields)])];
  const text = compact.serializeOlderTranscript(history);
  assert.equal(text.includes(url), false);
  assert.equal(text.includes('PRIVATE_ORIGINAL'), false);
  assert.match(text, /unsupported/);
  assert.match(text, /sample-2.txt/);
  assert.match(text, /仅元信息|未读取|未提供正文/);
});

test('default MD and JSON export explain metadata/status/truncation and cannot restore original attachments', () => {
  const session = { id: 'session-e5', title: 'synthetic export', namespaceRef: 'ans_' + '1'.repeat(32), windowGrant: 'PRIVATE_GRANT', messages: [message(1, [ref(1, privateFields)], { content: 'User text', attachmentManifest: [ref(1, privateFields)] }), message(2, [{ type: 'text', text: 'A historical model answer may quote user content.' }], { content: 'A historical model answer may quote user content.' })] };
  const md = exportsApi.exportSessionMarkdown(session);
  const json = exportsApi.exportSessionJson(session);
  for (const text of [md, json]) {
    for (const marker of Object.values(privateFields)) assert.equal(text.includes(marker), false, marker);
    assert.equal(text.includes(session.namespaceRef), false);
    assert.match(text, /仅.*元信息|metadata/);
    assert.match(text, /原件|原文|original/);
    assert.match(text, /ready/);
    assert.match(text, /截断|truncated/);
    assert.match(text, /A historical model answer may quote user content/);
  }
  assert.equal(JSON.parse(json).version, 1);
  assert.equal(JSON.parse(json).session.messages[0].schemaVersion, 2);
});

test('export blocks ambiguous legacy payload and preserves the historical container', () => {
  const session = { id: 'old', messages: [{ role: 'user', content: '![old.png](data:image/png;base64,U1lOVEhFVElD)' }] };
  const original = JSON.stringify(session);
  for (const fn of [exportsApi.exportSessionMarkdown, exportsApi.exportSessionJson]) assert.throws(() => fn(session), e => e.code === 'ATTACHMENT_LEGACY_REQUIRES_MIGRATION');
  assert.equal(JSON.stringify(session), original);
});

test('draft V1 fields and the session namespace locator survive safely while legacy four fields stay exact', () => {
  const state = stateApi.createState({ sessions: [{ id: 'session-e5', namespaceRef: 'ans_' + '1'.repeat(32), windowGrant: 'PRIVATE_GRANT', previewId: 'PRIVATE_TICKET', body: 'PRIVATE_ORIGINAL', messages: [] }] });
  const legacy = { attachmentId: 'old', name: 'old.txt', mimeType: 'text/plain', size: 1, ...privateFields };
  stateApi.updateDraft(state, 'session-e5', { text: 'safe draft', attachmentRefs: [ref(1, privateFields), legacy], windowGrant: 'PRIVATE_GRANT' });
  const result = stateApi.serializeState(state, schema.projectToStorageJson);
  assert.equal(result.ok, true);
  const [v1, old] = result.value.draftsBySession['session-e5'].attachmentRefs;
  assert.equal(v1.refVersion, 1);
  assert.equal(v1.storageMode, 'encrypted');
  assert.equal(v1.budget.selectedChars, 10);
  assert.equal(v1.status, 'ready');
  assert.equal(v1.type, undefined);
  assert.deepEqual(Object.keys(old).sort(), ['attachmentId', 'mimeType', 'name', 'size']);
  assert.equal(result.value.sessions[0].namespaceRef, 'ans_' + '1'.repeat(32));
  for (const marker of Object.values(privateFields)) assert.equal(JSON.stringify(result.value).includes(marker), false, marker);
  assert.equal(result.value.schemaVersion, 3);
});

test('invalid namespace path and live grants are not serialized; old alias is locator-only', () => {
  const state = stateApi.createState({ sessions: [{ id: 'bad', namespaceRef: 'C:\\private', windowGrant: 'PRIVATE_GRANT', messages: [] }, { id: 'alias', attachmentNamespaceRef: 'ans_' + '2'.repeat(32), messages: [] }] });
  const value = stateApi.serializeState(state).value;
  assert.equal(value.sessions[0].namespaceRef, undefined);
  assert.equal(value.sessions[0].windowGrant, undefined);
  assert.equal(value.sessions[1].namespaceRef, 'ans_' + '2'.repeat(32));
  assert.equal(value.sessions[1].attachmentNamespaceRef, undefined);
});

test('cold memory refs expire without destroying original bytes or automatically writing restored state', () => {
  const payload = { schemaVersion: 3, sessions: [{ id: 'memory-session', namespaceRef: 'ans_' + '3'.repeat(32), messages: [{ role: 'user', content: 'historical', parts: [{ type: 'text', text: 'historical' }, ref(1, { storageMode: 'memory' })], attachmentManifest: [ref(1, { storageMode: 'memory' })] }] }], draftsBySession: { 'memory-session': { text: 'draft', attachmentRefs: [ref(1, { storageMode: 'memory' })], revision: 2, updatedAt: 1 } } };
  const original = JSON.stringify(payload);
  assert.equal(stateApi.createState(payload).draftsBySession['memory-session'].attachmentRefs[0].status, 'ready');
  const migrated = stateApi.migrateState(payload);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrated, false);
  assert.equal(migrated.state.draftsBySession['memory-session'].attachmentRefs[0].status, 'expired');
  assert.equal(migrated.state.draftsBySession['memory-session'].attachmentRefs[0].storageMode, 'unavailable');
  assert.equal(migrated.state.sessions[0].messages[0].parts[1].status, 'expired');
  assert.equal(migrated.state.sessions[0].messages[0].attachmentManifest[0].storageMode, 'unavailable');
  assert.equal(migrated.state.sessions[0].namespaceRef, payload.sessions[0].namespaceRef);
  assert.equal(JSON.stringify(payload), original);
  const blocked = { ...payload, sessions: [{ ...payload.sessions[0], messages: [{ role: 'user', content: 'historical', attachments: [{ dataUrl: 'synthetic-old-original' }] }] }] };
  const blockedOriginal = JSON.stringify(blocked);
  const restored = stateApi.migrateState(blocked);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, 'ATTACHMENT_LEGACY_REQUIRES_MIGRATION');
  assert.equal(restored.state.draftsBySession['memory-session'].attachmentRefs[0].status, 'expired');
  assert.equal(JSON.stringify(blocked), blockedOriginal);
});

test('usage attachment aggregate stays public and cannot turn unavailable into actual consumption', () => {
  const event = buildModelUsageEvent({ binding: { model: 'synthetic-e5-model', kind: 'chat', sessionId: 'synthetic-e5-session', protocol: 'openai-chat-completions' }, settings: { usageEnabled: true }, attempt: { attemptId: 'physical-e5', status: 'failed', usage: { source: 'unavailable' }, ...privateFields },
    attachmentSummary: { count: 2, rawBytes: 80, selectedBytes: 20, selectedChars: 20, truncatedCount: 2, contextLimit: 32000, ...privateFields } });
  assert.deepEqual(event.attachmentSummary, { count: 2, rawBytes: 80, selectedBytes: 20, selectedChars: 20, truncatedCount: 2, contextLimit: 32000 });
  assert.equal(event.attemptId, 'physical-e5');
  assert.equal(event.source, 'unavailable');
  assert.equal(event.inputTokens, null);
  assert.equal(event.cost, null);
  const stored = require('../src/ai/usage-store').normalizeRecord({ ...event, ts: 1, attachmentSummary: { ...event.attachmentSummary, ...privateFields } });
  assert.deepEqual(stored.attachmentSummary, event.attachmentSummary);
  assert.equal(stored.source, 'unavailable');
  for (const marker of Object.values(privateFields)) assert.equal(JSON.stringify(stored).includes(marker), false);
  for (const marker of Object.values(privateFields)) assert.equal(JSON.stringify(event).includes(marker), false);
  const noSummary = buildModelUsageEvent({ binding: { model: 'synthetic-e5-model' }, attempt: { attemptId: 'physical-2', status: 'completed', usage: { source: 'estimated', inputTokens: 10, outputTokens: 2 } } });
  assert.equal(Object.hasOwn(noSummary, 'attachmentSummary'), false);
  assert.equal(noSummary.source, 'estimated');
});
