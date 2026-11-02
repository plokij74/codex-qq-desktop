'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = require('../src/renderer/e4-chat-state');
const schema = require('../src/ai/message-schema');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
function production(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} production function exists`);
  return source.slice(start, end);
}
function element() { return { innerHTML: '', dataset: {}, querySelector: () => element(), appendChild() {} }; }
function harness() {
  const list = element(), session = { id: 'session', peer: 'codex', identityType: 'ai', assistantId: 'assistant_custom', messages: [] };
  const context = vm.createContext({
    sessions: [session], activeSessionId: session.id, activeSession: () => session,
    sending: false, chatRun: null, activeForegroundTask: null,
    modelManager: { getState: () => ({ registry: { assistants: [{ id: 'assistant_custom', name: 'Next general assistant' }] } }) },
    peerName: () => 'Codex 小蓝', document: { getElementById: () => list, createElement: element },
    window: { E4ChatState: chat, codex: { messageSchema: schema } },
    fileChangesStripHtml: () => '', renderAttachmentsHtml: () => '', renderPlanCardHtml: () => '', renderTrajectoryHtml: () => '',
    renderInlineMcpTasks: () => '', renderMarkdownLite: (text) => String(text), renderWorktreeCards() {}, bindFileChangesToggles() {},
    bindPlanCardActions() {}, scrollToBottom() {}, bindInlineStop() {}, renderUsageBar() {}, renderContextMeter() {},
  });
  vm.runInContext(['escapeHtml', 'getAssistantForSession', 'renderMessages', 'createAssistantRunPlaceholder'].map(production).join('\n'), context);
  return { list, session, context };
}
const fixedSource = { kind: 'api', providerId: 'provider_fixture', modelProfileId: 'model_fixture', model: 'fixture-model',
  protocol: 'openai-chat-completions', assistantId: 'assistant_original', assistantName: 'Original API assistant',
  providerRevision: 1, modelRevision: 1, assistantRevision: 1 };

test('completed non-Codex bubble retains its accepted assistant identity after next-target edits', () => {
  const h = harness(); h.session.messages.push({ role: 'assistant', content: 'Complete reply', modelSource: fixedSource });
  h.context.renderMessages();
  assert.match(h.list.innerHTML, /<div class="msg-meta">Original API assistant<\/div>/);
  assert.doesNotMatch(h.list.innerHTML, /Codex 小蓝|Next general assistant/);
});
test('non-Codex bubble without older source metadata falls back to its configured AI identity', () => {
  const h = harness(); h.session.messages.push({ role: 'assistant', content: 'Reply' }); h.context.renderMessages();
  assert.match(h.list.innerHTML, /<div class="msg-meta">Next general assistant<\/div>/); assert.doesNotMatch(h.list.innerHTML, /Codex 小蓝/);
});
test('stored assistant labels are escaped instead of injecting markup', () => {
  const h = harness(); h.session.messages.push({ role: 'assistant', content: 'Reply', modelSource: { ...fixedSource, assistantName: '<img src=x onerror=boom>' } });
  h.context.renderMessages(); assert.match(h.list.innerHTML, /&lt;img src=x onerror=boom&gt;/); assert.doesNotMatch(h.list.innerHTML, /<img src=x/);
});
test('streaming placeholder uses the accepted assistant snapshot rather than the next selection', () => {
  const h = harness(), run = h.context.createAssistantRunPlaceholder(h.session.id, fixedSource);
  assert.match(run.el.innerHTML, /<div class="msg-meta">Original API assistant<\/div>/); assert.doesNotMatch(run.el.innerHTML, /Next general assistant/);
});
for (const kind of ['unaccepted', 'session_compact', 'other-session']) test(`${kind} work never displays a fabricated chat typing indicator`, () => {
  const h = harness(); h.context.sending = true;
  h.context.activeForegroundTask = { kind: kind === 'session_compact' ? kind : 'chat_run',
    sessionId: kind === 'other-session' ? 'other' : h.session.id, runId: kind === 'unaccepted' ? null : 'accepted-run' };
  h.context.renderMessages(); assert.doesNotMatch(h.list.innerHTML, /class="typing"/);
});
test('an accepted current chat typing indicator uses its actual AI name', () => {
  const h = harness(); h.context.sending = true; h.context.activeForegroundTask = { kind: 'chat_run', sessionId: h.session.id, runId: 'accepted-run' };
  h.context.renderMessages(); assert.match(h.list.innerHTML, /Next general assistant 正在输入/); assert.doesNotMatch(h.list.innerHTML, /Codex 小蓝/);
});
test('legacy Codex fallback remains available when no current assistant profile exists', () => {
  const h = harness(); h.session.assistantId = 'assistant_missing'; h.session.messages.push({ role: 'assistant', content: 'Legacy reply' });
  h.context.renderMessages(); assert.match(h.list.innerHTML, /<div class="msg-meta">Codex 小蓝<\/div>/);
});
