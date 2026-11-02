'use strict';
// Exercises real main/engineering IPC, repair consumer, child runtime and router with offline fakes only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { validateModelRegistry, resolveModelBinding, saveProfile } = require('../src/ai/model-profiles');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
const { loadMainFixture, syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');
const worktreeModule = require('../src/ai/worktree');
const protocols = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'];
const source = { kind: 'remote_ci', remoteCiRef: `rci_${'a'.repeat(24)}` };
const metadata = { source, sourceFingerprint: 'b'.repeat(64), sourceLabel: 'Synthetic CI failure', result: {
  diagnostics: [{ path: 'synthetic.js', line: 1, column: 1, severity: 'error', message: 'Synthetic repair diagnostic' }], stdout: '', stderr: '',
} };
function registryFor(protocol, nativeTools = 'supported') {
  const registry = syntheticRegistry(); registry.providers[0].protocol = protocol;
  if (protocol === 'anthropic-messages') registry.providers[0].auth = {
    kind: 'api-key', secretRef: 'repair-private-test-key', credentialRevision: 1, credentialOrigin: 'https://e4.example.invalid' };
  for (const name of ['text', 'nativeTools', 'usage']) registry.models[0].capabilities[name] = {
    state: name === 'nativeTools' ? nativeTools : 'supported', source: name === 'nativeTools' && nativeTools === 'unknown' ? 'unknown' : 'declared' };
  return validateModelRegistry(registry);
}
function wire(protocol) {
  const content = 'Synthetic repair answer. No changes made.';
  const body = protocol === protocols[0]
    ? { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    : protocol === protocols[1]
      ? { id: 'resp_synthetic_repair_main', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 12, output_tokens: 3 } }
      : { id: 'msg_synthetic_repair_main', type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
function fixture(t, options = {}) {
  let f; let handlers; let bound; let inherited; let repaired;
  const children = []; const materializations = []; const created = []; const cleanupStarted = deferred();
  const manager = { recover: async () => ({ ok: true, results: [], warnings: [] }),
    create: async request => { created.push(request); return { ok: true, handle: { childProjectPath: f.root } }; },
    collect: async () => { cleanupStarted.resolve(); await options.beforeCleanup?.(); return { ok: true, changed: false }; } };
  const engineering = { createEngineeringIpcHandlers: args => {
    const resolveBinding = (event, payload) => {
      const project = args.resolveBinding(event, payload); if (!project || !options.inherit) return project;
      inherited ||= resolveModelBinding({ registry: args.getSettings().modelRegistry, senderId: event.sender.id,
        projectBindingId: payload.projectBindingId, sessionId: 'repair-parent-session', runId: 'repair-parent-run',
        clientRequestId: 'repair-parent-request', assistantId: options.inherit });
      return { ...project, modelBinding: inherited };
    };
    handlers = createEngineeringIpcHandlers({ ...args, resolveBinding });
    for (const name of ['repairStart', 'repairRetry']) {
      const original = handlers[name]; handlers[name] = async (event, payload) => {
        await handlers.repairList(event, { projectBindingId: payload.projectBindingId }); repaired = handlers.repairManager;
        repaired.resolveMetadata = async () => structuredClone(metadata);
        repaired.materializeRepairSource = async (_root, resolved, context) => {
          materializations.push(context); await options.beforeMaterialize?.(context); return resolved;
        };
        return original(event, payload);
      };
    }
    return handlers;
  } };
  f = loadMainFixture(t, { registry: options.registry || registryFor(options.protocol || protocols[0], options.nativeTools),
    settings: { agentEnabled: true, permissionMode: 'full-auto', ...options.settings },
    beforeClose: () => options.release?.(), modules: { './ai/engineering-ipc': engineering,
      './ai/worktree': { ...worktreeModule, createWorktreeManager: () => manager } },
    agentFn: async args => {
      children.push(args); const result = await args.chatFn({ messages: args.messages, signal: args.signal });
      return { content: result.content, terminalReason: 'completed', toolsSupported: true };
    }, fetchFn: () => wire(options.protocol || protocols[0]) });
  for (const provider of f.settings().modelRegistry.providers) if (provider.auth.secretRef) f.secrets.set(provider.auth.secretRef, 'not-a-real-provider-key-repair-test');
  async function bind() { const result = await f.invoke('worktree:bind', { projectId: 'synthetic-repair-project', projectPath: f.root });
    assert.equal(result.ok, true); bound = result.projectBindingId; return bound; }
  async function start(extra = {}) { if (!bound) await bind(); return f.invoke('engineering:repair:start', { projectBindingId: bound, source, sessionId: 'repair-session', ...extra }); }
  async function done(out) {
    await repaired.details.get(out.repairRef)?.completion;
    const deadline = Date.now() + 3000;
    while (repaired.activeByProject.size && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(repaired.activeByProject.size, 0); return repaired.get(f.root, out.repairRef).repair;
  }
  return { ...f, start, bind, done, children, materializations, created, cleanupStarted,
    handlers: () => handlers, repairs: () => repaired, inherited: () => inherited, binding: () => bound };
}
for (const protocol of protocols) test(`E4 main repair accepts ${protocol}, fixes provenance and meters one physical attempt`, async t => {
  const f = fixture(t, { protocol }); const out = await f.start(); assert.equal(out.ok, true, out.code);
  const row = await f.done(out); assert.equal(row.status, 'no_changes', row.errorCode); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.model, f.settings().modelRegistry.models[0].model);
  assert.equal(out.modelSource.protocol, protocol); assert.equal(out.modelSource.assistantId, 'assistant_codex');
  assert.deepEqual(row.modelSource, out.modelSource); assert.equal(f.children[0].modelBinding.protocol, protocol);
  for (const key of ['apiKey', 'baseUrl', 'model', 'modelRegistry']) assert.equal(Object.hasOwn(f.children[0].settings, key), false, key);
  const ledger = readRecords(usageFilePath(f.root)).records; assert.equal(ledger.length, 1); assert.equal(ledger[0].kind, 'repair');
  assert.equal(ledger[0].runId, out.modelSource.runId); assert.equal(ledger[0].providerId, out.modelSource.providerId);
  assert.equal(f.settings().apiKey, ''); assert.equal(f.settingsLoads.every(value => value?.resolveLegacyApiKey === false), true);
  assert.equal(f.inspect('backgroundModelBindings.size'), 0); assert.equal(f.inspect('activeModelRequests.size'), 0);
});
test('E4 main repair rejects unknown native capability before source materialization or a worktree', async t => {
  const f = fixture(t, { nativeTools: 'unknown' }); const out = await f.start();
  assert.equal(out.ok, false); assert.equal(out.code, 'MODEL_CAPABILITY_UNKNOWN');
  assert.equal(f.materializations.length, 0); assert.equal(f.created.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.inspect('backgroundModelBindings.size'), 0);
});
test('E4 main repair blocks transport changes until cancellation has awaited child collection', async t => {
  const cleanup = deferred(); const f = fixture(t, { beforeCleanup: () => cleanup.promise, release: () => cleanup.resolve() });
  const out = await f.start(); assert.equal(out.ok, true); assert.equal(out.modelSource?.protocol, protocols[0]);
  await f.cleanupStarted.promise;
  const draft = { id: out.modelSource.providerId, baseUrl: 'https://new-repair.example.invalid/v1' };
  let result = await f.invoke('models:saveProvider', { provider: draft, expectedRevision: f.settings().modelRegistry.revision });
  assert.equal(result.code, 'CONFIG_IN_USE');
  const cancelled = await f.invoke('engineering:repair:cancel', { projectBindingId: f.binding(), repairRef: out.repairRef });
  assert.equal(cancelled.pending, true);
  result = await f.invoke('models:saveProvider', { provider: draft, expectedRevision: f.settings().modelRegistry.revision });
  assert.equal(result.code, 'CONFIG_IN_USE');
  cleanup.resolve(); assert.equal((await f.done(out)).status, 'cancelled');
  result = await f.invoke('models:saveProvider', { provider: draft, expectedRevision: f.settings().modelRegistry.revision }); assert.equal(result.ok, true, result.code);
});
test('E4 main repair inherits the exact host-resolved assistant target without returning to the global default', async t => {
  let registry = registryFor(protocols[1]);
  registry = saveProfile(registry, 'assistant', { id: 'assistant_repair_custom', name: 'Synthetic repair role',
    modelProfileId: registry.models[0].id, toolPolicy: { mode: 'allowlist', allowedTools: ['read_file', 'write_file'] } });
  const f = fixture(t, { registry, protocol: protocols[1], inherit: 'assistant_repair_custom' });
  const out = await f.start(); assert.equal(out.ok, true, out.code); await f.done(out);
  assert.equal(f.children[0].modelBinding, f.inherited()); assert.equal(out.modelSource.assistantId, 'assistant_repair_custom');
});
test('E4 main repair rejects renderer target/controller injection and never creates model work', async t => {
  const f = fixture(t); const out = await f.start({ modelProfileId: 'forged-model', abortController: {} });
  assert.equal(out.ok, false); assert.equal(out.code, 'REPAIR_INVALID');
  assert.equal(f.materializations.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.created.length, 0);
});
