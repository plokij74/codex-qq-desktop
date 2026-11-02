'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const productionPath = path.join(__dirname, '../src/renderer/e4-models.js');
const production = fs.readFileSync(productionPath, 'utf8');
const registry = (revision = 3) => ({
  schemaVersion: 1, revision, defaultModelProfileId: 'm1',
  providers: [{ id: 'p1', name: 'Local OpenAI', protocol: 'openai-chat-completions', baseUrl: 'http://localhost:1234/v1', revision, auth: { kind: 'bearer' }, credentialState: 'configured' }],
  models: [{ id: 'm1', name: 'Model One', providerId: 'p1', model: 'qwen-local', revision, request: { maxOutputTokens: 1024 }, compatibility: { toolMode: 'native', streamMode: 'auto', includeUsage: false }, capabilities: {} }],
  assistants: [{ id: 'assistant_codex', name: 'Codex', builtIn: true, identityType: 'ai', modelProfileId: null, revision, systemPrompt: '', knowledge: { projectContext: true, projectMemory: true }, projectId: null, toolPolicy: { mode: 'none', allowedTools: [] } }],
});
// Actual settings factory and click/submit ports; no live IPC or network.
function uiHarness(options = {}) {
  let current = registry();
  const calls = [], handlers = new Map(), forms = new Map();
  const response = () => ({ ok: true, mode: 'local', revision: current.revision, registry: current, cleanupState: 'clean', pendingCleanupCount: 0 });
  const api = {
    listModels: async () => response(), listAssistants: async () => ({ ...response(), assistants: current.assistants }),
    saveAssistant: async (payload) => { calls.push(['assistant', payload]); current = { ...current, revision: payload.expectedRevision + 1, assistants: [...current.assistants.filter((item) => item.id !== payload.assistant.id), structuredClone(payload.assistant)] }; return response(); },
    removeModelProfile: async (payload) => { calls.push(['remove', payload]); current = { ...current, revision: payload.expectedRevision + 1, models: current.models.filter((item) => item.id !== payload.id) }; return response(); },
    diagnoseModel: async (payload) => { calls.push(['diagnose', payload]); return { ok: true, accepted: true, diagnosticId: 'diag1', runId: 'run1', sessionId: 'session1', clientRequestId: 'request1', task: { kind: 'model_diagnostic' }, modelSource: { kind: 'api', modelProfileId: payload.modelProfileId } }; },
    onModelDiagnosticEvent: (callback) => { api.emit = callback; return () => {}; },
  };
  const root = { innerHTML: '', addEventListener: (type, callback) => handlers.set(type, callback), querySelector: (selector) => forms.get(selector.match(/data-form="([^"]+)"/)?.[1]) || null };
  class FakeFormData { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.data)[Symbol.iterator](); } }
  const sandbox = { module: { exports: {} }, FormData: FakeFormData, URL, structuredClone, window: { confirm: () => true } };
  vm.runInNewContext(production, sandbox, { filename: productionPath });
  const ui = sandbox.module.exports.createModelSettingsUi({ root, api, getProjects: options.getProjects || (() => []), beforeMutation: options.beforeMutation });
  function form(kind, data, checked = {}, checks = []) {
    const item = { dataset: { form: kind }, data, closest: () => item,
      querySelector: (selector) => { const name = selector.match(/name="([^"]+)"/)?.[1]; return name ? { value: data[name] ?? '', checked: checked[name] === true } : null; },
      querySelectorAll: (selector) => selector === '[name="check"]:checked' ? checks.map((value) => ({ value, checked: true })) : [],
    };
    forms.set(kind, item); return item;
  }
  return { ui, api, root, calls, form, get registry() { return current; }, set registry(value) { current = value; },
    click: async (dataset) => { const button = { dataset }; return handlers.get('click')({ target: { closest: () => button } }); },
    submit: async (item) => handlers.get('submit')({ target: item, preventDefault() {} }),
    input: async (item) => handlers.get('input')?.({ target: item }),
    change: async (item) => handlers.get('change')?.({ target: item }),
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const assistantData = (overrides = {}) => ({ id: 'assistant_custom', name: 'Private Helper', modelProfileId: '', systemPrompt: 'Be concise.', projectId: '', toolMode: 'none', allowedTools: '', ...overrides });
const checks = ['text', 'streaming', 'nativeTools', 'usage'];
function renderedSelect(root, name) { return root.innerHTML.match(new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`))?.[1] || ''; }
function renderedPreview(root) { const from = root.innerHTML.indexOf('class="e4-diagnostic-preview"'); assert.ok(from >= 0, 'actual preview DOM is rendered'); return root.innerHTML.slice(from); }

test('actual factory: public project selector creates a custom isolated assistant without authority leakage', async () => {
  const h = uiHarness({ getProjects: () => [{ id: 'project_public', name: 'Public <Project>', path: 'PRIVATE_PATH_DO_NOT_RENDER', projectBindingId: 'PRIVATE_BINDING_DO_NOT_RENDER' }] });
  await h.ui.refresh(); await h.click({ tab: 'assistants' }); await h.click({ action: 'new-assistant' });
  const html = renderedSelect(h.root, 'projectId');
  assert.match(html, /value="project_public"/); assert.match(html, /Public &lt;Project&gt;/);
  assert.equal(h.root.innerHTML.includes('PRIVATE_PATH_DO_NOT_RENDER'), false); assert.equal(h.root.innerHTML.includes('PRIVATE_BINDING_DO_NOT_RENDER'), false);
  await h.submit(h.form('assistant', assistantData({ projectId: 'project_public' })));
  const payload = h.calls.find(([method]) => method === 'assistant')[1];
  assert.equal(payload.expectedRevision, 3); assert.equal(payload.assistant.projectId, 'project_public'); assert.equal(payload.assistant.builtIn, false); assert.equal(payload.assistant.identityType, 'ai');
  assert.deepEqual(plain(payload.assistant.knowledge), { projectContext: false, projectMemory: false }); assert.deepEqual(plain(payload.assistant.toolPolicy), { mode: 'none', allowedTools: [] });
  assert.equal(/PRIVATE_|projectBindingId|projectPath/.test(JSON.stringify(payload)), false);
});
test('actual factory: unavailable project association survives render and explicit edits can change then clear it', async () => {
  const h = uiHarness({ getProjects: () => [{ id: 'project_available', name: 'Available' }] });
  h.registry.assistants.push({ ...h.registry.assistants[0], id: 'assistant_custom', name: 'Existing', builtIn: false, projectId: 'project_missing', knowledge: { projectContext: false, projectMemory: false } });
  await h.ui.refresh(); await h.click({ tab: 'assistants' }); await h.click({ editAssistant: 'assistant_custom' });
  assert.match(renderedSelect(h.root, 'projectId'), /value="project_missing"\s+selected/);
  await h.submit(h.form('assistant', assistantData({ projectId: 'project_available' })));
  assert.equal(h.calls.at(-1)[1].assistant.projectId, 'project_available');
  await h.click({ editAssistant: 'assistant_custom' }); await h.submit(h.form('assistant', assistantData({ projectId: '' })));
  assert.equal(h.calls.at(-1)[1].assistant.projectId, null);
  assert.deepEqual(plain(h.calls.at(-1)[1].assistant.knowledge), { projectContext: false, projectMemory: false }); assert.deepEqual(plain(h.calls.at(-1)[1].assistant.toolPolicy), { mode: 'none', allowedTools: [] });
});
test('actual factory: user-started preview DOM discloses exact wire target, checks and bounded cost limits', async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ tab: 'diagnostics' });
  h.form('diagnostic', { modelProfileId: 'm1' }, {}, checks); await h.click({ action: 'preview-diagnosis' });
  const preview = renderedPreview(h.root);
  for (const text of ['http://localhost:1234', 'openai-chat-completions', 'qwen-local', ...checks]) assert.ok(preview.includes(text), `preview discloses ${text}`);
  assert.match(preview, /\b5\b/); assert.match(preview, /\b128\b/); assert.match(preview, /15\s*(?:秒|s)|15000\s*(?:ms|毫秒)/i); assert.match(preview, /256\s*KiB|262144\s*(?:bytes|字节)/i);
  assert.match(preview, /合成/); assert.match(preview, /费用|cost/i); assert.equal(h.calls.some(([method]) => method === 'diagnose'), false, 'preview never dispatches a request');
});
for (const change of ['origin', 'model', 'credential-wire']) test(`actual factory: same profile/checks ${change} desync requires fresh preview before any diagnosis`, async () => {
  const h = uiHarness(); h.registry.models[0].bindingRevision = 'wire-a';
  await h.ui.refresh(); await h.click({ tab: 'diagnostics' }); const form = h.form('diagnostic', { modelProfileId: 'm1' }, {}, checks);
  await h.click({ action: 'preview-diagnosis' }); assert.ok(renderedPreview(h.root));
  const changed = structuredClone(h.registry); changed.revision = 4; changed.models[0].bindingRevision = 'wire-b';
  if (change === 'origin') changed.providers[0].baseUrl = 'http://localhost:4321/other';
  if (change === 'model') changed.models[0].model = 'new-wire-model';
  h.registry = changed; h.ui.manager.applyResult({ ok: true, revision: 4, registry: changed }); await h.submit(form);
  assert.equal(h.calls.filter(([method]) => method === 'diagnose').length, 0, 'stale consent cannot authorize current wire config'); assert.match(h.root.innerHTML, /重新预览/);
  await h.click({ action: 'preview-diagnosis' }); await h.submit(form);
  const payload = h.calls.find(([method]) => method === 'diagnose')[1];
  assert.equal(payload.expectedRevision, 4); assert.equal(payload.modelProfileId, 'm1'); assert.deepEqual(plain(payload.checks), checks); assert.equal(h.calls.filter(([method]) => method === 'diagnose').length, 1);
});
test('actual factory: rename/non-wire revisions retain consent and use latest optimistic revision', async () => {
  const h = uiHarness(); h.registry.models[0].bindingRevision = 'wire-a';
  await h.ui.refresh(); await h.click({ tab: 'diagnostics' }); const form = h.form('diagnostic', { modelProfileId: 'm1' }, {}, ['text']); await h.click({ action: 'preview-diagnosis' });
  const renamed = structuredClone(h.registry); renamed.revision = 4; renamed.models[0].name = 'Renamed'; renamed.providers[0].name = 'Renamed Provider';
  h.registry = renamed; h.ui.manager.applyResult({ ok: true, revision: 4, registry: renamed }); await h.submit(form);
  const payload = h.calls.find(([method]) => method === 'diagnose')?.[1]; assert.ok(payload, 'non-wire edits do not require redundant preview');
  assert.equal(payload.expectedRevision, 4); assert.equal(payload.modelProfileId, 'm1'); assert.deepEqual(plain(payload.checks), ['text']);
});
for (const syncOk of [true, false]) test(`actual factory: click removal synchronizes latest session refs first and ${syncOk ? 'then mutates' : 'blocks on ref failure'}`, async () => {
  let latestRefs = [];
  const h = uiHarness({ beforeMutation: async () => { h.calls.push(['refs', { sessions: structuredClone(latestRefs) }]); return syncOk ? { ok: true } : { ok: false, error: 'Synthetic refs failure' }; } });
  h.registry.models.push({ ...h.registry.models[0], id: 'm2', name: 'Model Two', model: 'other-model' });
  await h.ui.refresh(); await h.click({ tab: 'models' }); await h.click({ editModel: 'm2' }); assert.match(h.root.innerHTML, /data-remove-model="m2"/);
  latestRefs = [{ sessionId: 'restored-session', assistantId: 'assistant_codex', modelProfileId: 'm2' }]; await h.click({ removeModel: 'm2' });
  assert.deepEqual(h.calls.map(([method]) => method), syncOk ? ['refs', 'remove'] : ['refs']); assert.deepEqual(h.calls[0][1].sessions, latestRefs);
  if (syncOk) { assert.equal(h.calls[1][1].expectedRevision, 3); assert.equal(h.calls[1][1].kind, 'model'); assert.equal(h.calls[1][1].id, 'm2'); } else assert.match(h.root.innerHTML, /Synthetic refs failure/);
});
test('actual factory: preview repaint retains a non-first model and a subset of checks', async () => {
  const h = uiHarness(); h.registry.models.push({ ...h.registry.models[0], id: 'm2', name: 'Second', model: 'second-model' });
  await h.ui.refresh(); await h.click({ tab: 'diagnostics' });
  const form = h.form('diagnostic', { modelProfileId: 'm2' }, {}, ['text']); await h.click({ action: 'preview-diagnosis' });
  assert.match(renderedSelect(h.root, 'modelProfileId'), /value="m2"\s+selected/);
  assert.match(h.root.innerHTML, /name="check" value="text" checked/);
  assert.doesNotMatch(h.root.innerHTML, /name="check" value="streaming" checked/);
  await h.submit(form);
  assert.equal(h.calls[0][1].modelProfileId, 'm2'); assert.deepEqual(plain(h.calls[0][1].checks), ['text']);
});
test('actual factory: diagnostic status exposes bounded count and explicit start/completion time', async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ tab: 'diagnostics' });
  const form = h.form('diagnostic', { modelProfileId: 'm1' }, {}, ['text']); await h.click({ action: 'preview-diagnosis' }); await h.submit(form);
  h.api.emit({ type: 'done', diagnosticId: 'diag1', modelProfileId: 'm1', sessionId: 'session1', runId: 'run1', clientRequestId: 'request1',
    startedAt: '2026-10-30T01:00:00.000Z', completedAt: '2026-10-30T01:00:01.000Z', requestCount: 1 });
  assert.match(h.root.innerHTML, /2026-10-30T01:00:00.000Z/); assert.match(h.root.innerHTML, /2026-10-30T01:00:01.000Z/); assert.match(h.root.innerHTML, /请求数：1/);
});
test('actual factory: model/persona/name inputs use the documented main-process bounds', async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ tab: 'models' }); await h.click({ editModel: 'm1' });
  assert.match(h.root.innerHTML, /name="model"[^>]*maxlength="256"/); assert.match(h.root.innerHTML, /name="maxOutputTokens"[^>]*max="32768"/);
  assert.match(h.root.innerHTML, /name="name"[^>]*maxlength="128"/);
  await h.click({ tab: 'assistants' }); await h.click({ action: 'new-assistant' });
  assert.match(h.root.innerHTML, /name="systemPrompt"[^>]*maxlength="16384"/);
});

const modelData = (overrides = {}) => ({ id: 'm1', name: 'Edited Model', providerId: 'p1', model: 'qwen-local', maxOutputTokens: '1024', temperature: '', chatTokenLimitField: '', toolMode: 'native', streamMode: 'auto', contextWindowTokens: '', ...overrides });
const providerData = (overrides = {}) => ({ id: 'p1', name: 'Edited Provider', protocol: 'openai-chat-completions', baseUrl: 'http://localhost:1234/v1', authKind: 'bearer', ...overrides });
const conflicts = [
  { kind: 'provider', tab: 'providers', select: { editProvider: 'p1' }, method: 'saveModelProvider', collection: 'providers', data: providerData() },
  { kind: 'model', tab: 'models', select: { editModel: 'm1' }, method: 'saveModelProfile', collection: 'models', data: modelData() },
  { kind: 'assistant', tab: 'assistants', select: { editAssistant: 'assistant_codex' }, method: 'saveAssistant', collection: 'assistants', data: assistantData({ id: 'assistant_codex', name: 'Edited Assistant' }) },
];
for (const fixture of conflicts) test(`actual factory: ${fixture.kind} CONFIG_CONFLICT preserves unsaved form edits and the latest revision`, async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ tab: fixture.tab }); await h.click(fixture.select);
  h.api[fixture.method] = async (payload) => {
    h.calls.push([fixture.kind, payload]); const updated = structuredClone(h.registry); updated.revision = 9;
    const item = updated[fixture.collection].find((entry) => entry.id === fixture.data.id); item.name = 'Server concurrent name'; item.revision = 9; h.registry = updated;
    return { ok: false, code: 'CONFIG_CONFLICT', error: 'Synthetic edit conflict', revision: 9, registry: updated };
  };
  const form = h.form(fixture.kind, fixture.data); await h.submit(form);
  assert.ok(h.root.innerHTML.includes(`name="name" type="text" value="${fixture.data.name}"`), 'user edits stay visible instead of being replaced by fresh server data');
  assert.match(h.root.innerHTML, /Synthetic edit conflict/); assert.equal(h.ui.getState().revision, 9);
  h.api[fixture.method] = async (payload) => { h.calls.push(['retry', payload]); return { ok: true, revision: 10, registry: { ...h.registry, revision: 10 } }; };
  await h.submit(form); assert.equal(h.calls.at(-1)[1].expectedRevision, 9);
});
test('actual factory: registry notifications preserve non-secret typed fields before submission', async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ editProvider: 'p1' });
  await h.input(h.form('provider', providerData({ name: 'Typed before registry notice' })));
  const updated = structuredClone(h.registry); updated.revision = 4; updated.providers[0].name = 'Fresh server name'; h.registry = updated;
  h.ui.manager.applyResult({ ok: true, revision: 4, registry: updated });
  assert.match(h.root.innerHTML, /name="name" type="text" value="Typed before registry notice"/);
});
test('actual factory: blank optional wire fields clear explicitly and untouched observed capabilities remain omitted', async () => {
  const h = uiHarness(); h.registry.models[0].request = { maxOutputTokens: 1024, temperature: 0.4, chatTokenLimitField: 'max_completion_tokens' };
  h.registry.models[0].capabilities = { text: { state: 'supported', source: 'observed', checkedAt: '2026-10-30T00:00:00Z', bindingRevision: 'wire-a' }, temperature: { state: 'unsupported', source: 'declared' }, contextWindow: { tokens: 8192, source: 'declared' } };
  h.api.saveModelProfile = async (payload) => { h.calls.push(['model', payload]); return { ok: true, revision: 4, registry: { ...h.registry, revision: 4 } }; };
  await h.ui.refresh(); await h.click({ tab: 'models' }); await h.click({ editModel: 'm1' });
  await h.submit(h.form('model', modelData({ 'cap-text': 'unknown', 'cap-temperature': 'unknown', 'cap-vision': 'unsupported' })));
  const model = h.calls.find(([kind]) => kind === 'model')[1].model;
  assert.equal(model.request.temperature, null); assert.equal(model.request.chatTokenLimitField, null);
  assert.equal(Object.prototype.hasOwnProperty.call(model.capabilities, 'text'), false);
  assert.deepEqual(plain(model.capabilities.temperature), { state: 'unknown', source: 'unknown', checkedAt: null, bindingRevision: null });
  assert.deepEqual(plain(model.capabilities.vision), { state: 'unsupported', source: 'declared', checkedAt: null, bindingRevision: null });
  assert.deepEqual(plain(model.capabilities.contextWindow), { tokens: null, source: 'unknown', checkedAt: null, bindingRevision: null });
});
test('actual factory: credential input is never retained or echoed when public state changes', async () => {
  const h = uiHarness(); await h.ui.refresh(); await h.click({ editProvider: 'p1' });
  await h.input(h.form('credential', { credential: 'SYNTHETIC_CREDENTIAL_DO_NOT_RETAIN' }));
  const updated = structuredClone(h.registry); updated.revision = 4; updated.providers[0].credentialState = 'unavailable'; h.registry = updated;
  h.ui.manager.applyResult({ ok: true, revision: 4, registry: updated, cleanupState: 'pending', pendingCleanupCount: 1 });
  assert.match(h.root.innerHTML, /unavailable/); assert.match(h.root.innerHTML, /清理待重试/);
  assert.match(h.root.innerHTML, /name="credential"[^>]*value=""/);
  assert.equal(h.root.innerHTML.includes('SYNTHETIC_CREDENTIAL_DO_NOT_RETAIN'), false);
  assert.equal(JSON.stringify(h.ui.getState()).includes('SYNTHETIC_CREDENTIAL_DO_NOT_RETAIN'), false);
  assert.equal(h.calls.length, 0);
});
