'use strict';
// E4 engineering repairs use synthetic metadata, transport and isolated worktree handles only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepairManager } = require('../src/ai/repair-manager');
const { createSubagentRuntime } = require('../src/ai/subagent-runtime');
const { createModelChatFunction } = require('../src/ai/model-router');
const { resolveModelBinding, validateModelRegistry } = require('../src/ai/model-profiles');
const { publicModelSource } = require('../src/ai/model-runtime');
const { publicRepairSummary, normalizeRepair } = require('../src/ai/repair-state');
const { syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');
const source = { kind: 'remote_ci', remoteCiRef: `rci_${'a'.repeat(24)}` };
const metadata = { source, sourceFingerprint: 'b'.repeat(64), sourceLabel: 'Synthetic CI failure', result: {
  diagnostics: [{ path: 'synthetic.js', line: 1, column: 1, severity: 'error', message: 'Synthetic diagnostic' }], stdout: '', stderr: '',
} };
function registry(protocol = 'openai-chat-completions') {
  const value = syntheticRegistry(); value.providers[0].protocol = protocol;
  value.models[0].capabilities.text = { state: 'supported', source: 'declared' };
  value.models[0].capabilities.nativeTools = { state: 'supported', source: 'declared' };
  return validateModelRegistry(value);
}
function binding(protocol = 'openai-chat-completions') {
  return resolveModelBinding({ registry: registry(protocol), senderId: 1, sessionId: 'repair-session',
    projectBindingId: `pb_${'c'.repeat(32)}`, runId: 'repair-parent-run', clientRequestId: 'repair-parent-request' });
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e4-repair-'));
  const events = []; const materializations = [];
  const manager = createRepairManager({ userDataPath: root, safeStorage: null,
    settings: { mode: 'api', agentEnabled: true, apiKey: '', model: '', permissionMode: 'full-auto' },
    ...options, onEvent: event => { events.push(event); options.onEvent?.(event); } });
  manager.resolveMetadata = async () => structuredClone(metadata);
  manager.materializeRepairSource = async (_root, resolved, context) => {
    materializations.push(context); await options.beforeMaterialize?.(context); return resolved;
  };
  t.after(async () => {
    await options.release?.(); await manager.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^codex-e4-repair-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function done(out) {
    const deadline = Date.now() + 3000;
    while (manager.activeByProject.size && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.activeByProject.size, 0, 'repair cleanup must settle');
    return manager.get(root, out.repairRef).repair;
  }
  return { root, manager, events, materializations, done };
}
for (const protocol of ['openai-chat-completions', 'openai-responses']) {
  test(`E4 repair pins no-auth ${protocol}, passes a branded child closure and never forwards legacy credentials`, async t => {
    const acceptedBinding = binding(protocol); const requests = []; const children = []; let releases = 0;
    const worktree = { create: async () => ({ ok: true, handle: { childProjectPath: f.root } }),
      collect: async () => ({ ok: true, changed: false }) };
    const runtime = createSubagentRuntime({ worktreeManager: worktree, runLoop: async args => {
      children.push(args);
      const out = await args.chatFn({ messages: args.messages, signal: args.signal });
      return { content: out.content, terminalReason: 'completed', toolsSupported: true };
    } });
    const f = fixture(t, { subagentRuntime: runtime, worktreeManager: worktree, acceptBoundModel: request => {
      assert.equal(request.kind, 'repair'); assert.equal(request.context.signal, request.context.abortController.signal);
      const chatFn = createModelChatFunction({ binding: acceptedBinding, signal: request.context.signal, fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        const body = protocol === 'openai-responses'
          ? { id: 'resp_synthetic_repair', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic repair answer' }] }] }
          : { choices: [{ message: { role: 'assistant', content: 'Synthetic repair answer' }, finish_reason: 'stop' }] };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      } });
      return { binding: acceptedBinding, chatFn, modelSource: publicModelSource(acceptedBinding), release: () => { releases += 1; } };
    } });
    const out = await f.manager.start(f.root, { source }, { projectBindingId: acceptedBinding.projectBindingId,
      project: { id: 'synthetic-project', path: f.root }, modelBinding: acceptedBinding });
    assert.equal(out.ok, true, out.code); const row = await f.done(out);
    assert.equal(row.status, 'no_changes'); assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, acceptedBinding.model);
    assert.ok(requests[0].url.endsWith(protocol === 'openai-responses' ? '/responses' : '/chat/completions'));
    assert.equal(children.length, 1); assert.equal(children[0].modelBinding, acceptedBinding);
    for (const key of ['apiKey', 'baseUrl', 'model', 'modelRegistry']) assert.equal(Object.hasOwn(children[0].settings, key), false, key);
    assert.equal(row.modelSource.modelProfileId, acceptedBinding.modelProfileId); assert.deepEqual(out.modelSource, row.modelSource);
    assert.equal(releases, 1); assert.equal(f.events.every(event => event.modelSource?.modelProfileId === acceptedBinding.modelProfileId), true);
    assert.equal(JSON.stringify(f.materializations).includes('apiKey'), false);
  });
}
test('E4 repair rejects a failed model acceptance before private source materialization or record creation', async t => {
  let calls = 0;
  const f = fixture(t, { runImplement: async () => { calls += 1; return { result: { changed: false } }; },
    acceptBoundModel: () => { throw Object.assign(new Error('Synthetic credential failure'), { code: 'MODEL_CREDENTIAL_UNAVAILABLE' }); } });
  const out = await f.manager.start(f.root, { source });
  assert.equal(out.ok, false); assert.equal(out.code, 'MODEL_CREDENTIAL_UNAVAILABLE');
  assert.equal(f.materializations.length, 0); assert.equal(f.manager.store.list().length, 0); assert.equal(calls, 0);
});
test('E4 repair cannot replace an inherited binding with a branded but different target', async t => {
  const original = binding(); const replacement = binding('openai-responses'); let releases = 0;
  const f = fixture(t, { runImplement: async () => ({ result: { changed: false } }), acceptBoundModel: () => ({
    binding: replacement, chatFn: async () => ({}), modelSource: publicModelSource(replacement), release: () => { releases += 1; },
  }) });
  const out = await f.manager.start(f.root, { source }, { modelBinding: original });
  assert.equal(out.ok, false); assert.equal(out.code, 'MODEL_BINDING_INVALID'); assert.equal(releases, 1);
  assert.equal(f.materializations.length, 0); assert.equal(f.manager.store.list().length, 0);
});
test('E4 repair requires host acceptance for inherited bindings rather than a legacy runner fallback', async t => {
  const f = fixture(t, { runImplement: async () => ({ result: { changed: false } }) });
  const out = await f.manager.start(f.root, { source }, { modelBinding: binding() });
  assert.equal(out.ok, false); assert.equal(out.code, 'MODEL_BOUND_CHAT_REQUIRED'); assert.equal(f.materializations.length, 0);
});
test('E4 repair holds accepted binding through cancellation and awaited isolated cleanup', async t => {
  const started = deferred(); const cleanup = deferred(); const acceptedBinding = binding(); let releases = 0;
  const f = fixture(t, { release: () => cleanup.resolve(), acceptBoundModel: () => ({ binding: acceptedBinding,
    chatFn: async () => ({}), modelSource: publicModelSource(acceptedBinding), release: () => { releases += 1; } }),
  runImplement: async request => {
    started.resolve(request); await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise; return { result: { changed: false }, terminalReason: 'aborted' };
  } });
  const out = await f.manager.start(f.root, { source }); const request = await started.promise;
  assert.equal(request.context.modelBinding, acceptedBinding);
  const cancelled = await f.manager.cancel(f.root, out.repairRef); assert.equal(cancelled.pending, true);
  assert.equal(releases, 0); assert.equal(f.manager.activeByProject.size, 1);
  cleanup.resolve(); const row = await f.done(out); assert.equal(row.status, 'cancelled'); assert.equal(releases, 1);
});
test('E4 repair modelSource persists as an explicit safe allowlist without raw continuation or secrets', () => {
  const acceptedBinding = binding(); const modelSource = { ...publicModelSource(acceptedBinding), apiKey: 'synthetic-private-value',
    secretRef: 'synthetic-private-ref', providerState: { responseId: 'private-continuation' } };
  const item = normalizeRepair({ repairRef: `rpr_${'d'.repeat(24)}`, projectKey: 'e'.repeat(64), source,
    sourceFingerprint: metadata.sourceFingerprint, status: 'queued', modelSource });
  const dto = publicRepairSummary(item); assert.equal(dto.modelSource.modelProfileId, acceptedBinding.modelProfileId);
  for (const key of ['apiKey', 'secretRef', 'providerState']) assert.equal(Object.hasOwn(dto.modelSource, key), false);
});
