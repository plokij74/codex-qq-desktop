'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newAttachmentId, countCodePoints } = require('../src/ai/attachment-contract');
const { buildAttachmentSelectionMessages, projectAttachmentRunMessages, attachmentRunSummary } = require('../src/ai/attachment-projection');
const { createPreviewFixture } = require('./helpers/e5-preview-fixture');
const { createAttachmentPreviewService } = require('../src/ai/attachment-preview');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAgentLoop } = require('../src/ai/agent');
const { createModelRegistry, saveProfile, resolveModelBinding } = require('../src/ai/model-profiles');
const { createRegistry } = require('../src/ai/extensions/registry');

function entry(text, name = 'note.txt') {
  const attachmentId = newAttachmentId();
  return { record: { attachmentId, name, sourceKind: 'user_upload', byteLength: Buffer.byteLength(text) }, ref: { attachmentId, name }, text,
    selected: { rawByteLength: Buffer.byteLength(text), selectedChars: countCodePoints(text), selectedBytes: Buffer.byteLength(text), truncated: false } };
}
test('projection adds exact confirmed Unicode text after pure metadata without storage truncation', () => {
  const value = entry('😀'.repeat(40000));
  const messages = [{ role: 'user', content: 'inspect', parts: [{ type: 'text', text: 'inspect' }] }];
  const projected = buildAttachmentSelectionMessages(messages, [value]);
  assert.equal(projected.length, 1); assert.equal(typeof projected[0].content, 'string');
  assert.ok(projected[0].content.endsWith(value.text)); assert.equal(projected[0].content.length > 65536, true);
  assert.equal(messages[0].content, 'inspect');
});
test('history refs are metadata only and no historical attachment body is promoted', () => {
  const current = entry('current @not-a-cap.txt');
  const messages = [{ role: 'user', content: 'past', parts: [{ type: 'text', text: 'past' }, { type: 'attachment_ref', attachmentId: newAttachmentId(), name: 'past.txt', refVersion: 1, source: 'user_upload', status: 'ready' }] },
    { role: 'assistant', content: 'conclusion' }, { role: 'user', content: 'now' }];
  const projected = buildAttachmentSelectionMessages(messages, [current]);
  assert.match(projected[0].content, /past/); assert.ok(!projected[0].content.includes(current.text));
  assert.equal(projected[2].content.endsWith(current.text), true);
});
test('projection rejects forged leases and selection count/text limits instead of truncating', () => {
  assert.throws(() => projectAttachmentRunMessages([], {}), error => error.code === 'ATTACHMENT_REFERENCE_INVALID');
  assert.throws(() => attachmentRunSummary({}), error => error.code === 'ATTACHMENT_REFERENCE_INVALID');
  assert.throws(() => buildAttachmentSelectionMessages([{ role: 'user', content: 'x' }], Array.from({ length: 9 }, () => entry('x'))), error => error.code === 'ATTACHMENT_SELECTION_LIMIT');
  assert.throws(() => buildAttachmentSelectionMessages([{ role: 'user', content: 'x' }], [entry('a'.repeat(65537))]), error => error.code === 'ATTACHMENT_TEXT_LIMIT');
});
test('branded accepted lease projects the host typed user message and exposes only usage counters', async () => {
  const f = createPreviewFixture(), service = createAttachmentPreviewService(f.options), event = f.sender(1);
  const registered = await service.registerSession(event, { sessionId: 's', clientRequestId: 'register' });
  const envelope = { sessionId: 's', attachmentSessionBindingId: registered.attachmentSessionBindingId, clientRequestId: 'send' };
  const imported = await service.chooseExternal(event, envelope);
  const payload = { ...envelope, messages: [{ role: 'user', content: 'inspect' }], attachmentIds: [imported.refs[0].attachmentId], draftRevision: 1 };
  const prepared = await service.prepareSend(event, payload);
  const run = await service.claimSend(event, { ...payload, attachmentPreviewId: prepared.previewId });
  assert.throws(() => projectAttachmentRunMessages(payload.messages, run), error => error.code === 'ATTACHMENT_REFERENCE_INVALID');
  service.consume(run); await run.ready();
  const result = projectAttachmentRunMessages(payload.messages, run);
  assert.ok(result.at(-1).content.includes('EXTERNAL_CANARY'));
  const summary = attachmentRunSummary(run);
  assert.equal(summary.count, 1); assert.equal(summary.selectedChars, countCodePoints('EXTERNAL_CANARY\n'));
  assert.ok(!JSON.stringify(summary).includes(imported.refs[0].attachmentId));
  await run.release(); assert.throws(() => projectAttachmentRunMessages([], run), error => error.code === 'ATTACHMENT_REFERENCE_INVALID');
  await service.close();
});

test('confirmed attachment native Agent keeps authorized tools without implicit project context', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-agent-context-'));
  const ownedRoot = fs.realpathSync(root);
  t.after(() => { assert.equal(fs.realpathSync(root), ownedRoot); fs.rmSync(ownedRoot, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'IMPLICIT_UNCONFIRMED_PROJECT_CANARY');
  let profiles = createModelRegistry({ baseUrl: 'https://e5-agent.invalid/v1', model: 'e5-native' });
  profiles = saveProfile(profiles, 'model', { ...profiles.models[0], capabilities: { nativeTools: { state: 'supported', source: 'declared' } },
    compatibility: { toolMode: 'native', streamMode: 'off', includeUsage: true } });
  profiles = saveProfile(profiles, 'assistant', { id: 'assistant_e5_native', name: 'E5 native', systemPrompt: 'Synthetic assistant',
    knowledge: { projectContext: true, projectMemory: false }, toolPolicy: { mode: 'allowlist', allowedTools: ['read_file'] } });
  const binding = resolveModelBinding({ registry: profiles, assistantId: 'assistant_e5_native', projectBindingId: 'pb_synthetic', runId: 'e5-native', sessionId: 's' });
  const registry = createRegistry(); let executions = 0, turns = 0;
  registry.register({ id: 'e5-synthetic', getTools: () => [{ type: 'function', function: { name: 'read_file', description: 'Synthetic allowed read', parameters: { type: 'object', properties: {} } } }],
    execute: async () => { executions++; return JSON.stringify({ ok: true, content: 'EXPLICIT_TOOL_RESULT' }); } });
  const f = createPreviewFixture(), service = createAttachmentPreviewService(f.options), event = f.sender(1);
  t.after(() => service.close());
  const registered = await service.registerSession(event, { sessionId: 's', clientRequestId: 'register-native' });
  const envelope = { sessionId: 's', attachmentSessionBindingId: registered.attachmentSessionBindingId, clientRequestId: 'native-send' };
  const imported = await service.chooseExternal(event, envelope);
  const payload = { ...envelope, messages: [{ role: 'user', content: 'inspect' }], attachmentIds: [imported.refs[0].attachmentId], draftRevision: 1 };
  const prepared = await service.prepareSend(event, payload);
  const run = await service.claimSend(event, { ...payload, attachmentPreviewId: prepared.previewId });
  service.consume(run); await run.ready();
  t.after(() => run.release());
  const result = await runAgentLoop({ project: { id: 'e5-project', name: 'Synthetic', path: root }, modelBinding: binding,
    settings: { mode: 'api', maxAgentTurns: 3, terminalEnabled: false, hooksEnabled: false, verifyBeforeDone: false,
      memoryEnabled: false, skillsEnabled: false, mcpEnabled: false, subagentEnabled: false },
    messages: projectAttachmentRunMessages(payload.messages, run), automaticProjectContext: false, registry,
    chatFn: async options => {
      turns++;
      assert.equal(options.messages[0].content.includes('IMPLICIT_UNCONFIRMED_PROJECT_CANARY'), false);
      assert.ok(options.messages.find(message => message.role === 'user').content.endsWith('EXTERNAL_CANARY\n'));
      assert.deepEqual(options.tools.map(tool => tool.name || tool.function?.name), ['read_file']);
      return turns === 1 ? { content: '', tool_calls: [{ id: 'e5-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } : { content: 'E5_NATIVE_DONE', tool_calls: [] };
    } });
  assert.ok(result.content.startsWith('E5_NATIVE_DONE')); assert.equal(turns, 2); assert.equal(executions, 1);
});
