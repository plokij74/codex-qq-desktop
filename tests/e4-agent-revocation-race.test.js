'use strict';
// In-memory Agent/module fixtures only: no real project, memory/vault reads, file writes, endpoint or process execution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { createModelRegistry, saveProfile, resolveModelBinding } = require('../src/ai/model-profiles');
const { createRegistry } = require('../src/ai/extensions/registry');
const { createMemoryProvider } = require('../src/ai/providers/memory');
const memoryStore = require('../src/ai/memory-store');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const root = path.join(process.cwd(), '__in_memory_e4_revocation__');
const project = { id: 'in-memory-revocation-project', name: 'Pure in-memory fixture', path: root };
const settings = { mode: 'api', maxAgentTurns: 2, memoryEnabled: false, terminalEnabled: false, hooksEnabled: false,
  verifyBeforeDone: false, skillsEnabled: false, mcpEnabled: false, subagentEnabled: false };
const definition = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
function modelBinding(names, { hooks = false, toolMode = 'native' } = {}) {
  let registry = createModelRegistry({ baseUrl: 'https://revocation-test.invalid/v1', model: 'in-memory-model' });
  registry = saveProfile(registry, 'model', { ...registry.models[0], capabilities: { nativeTools: { state: 'supported', source: 'declared' } },
    compatibility: { toolMode, streamMode: 'off', includeUsage: true } });
  registry = saveProfile(registry, 'assistant', { id: 'assistant_revocation_race', name: 'In-memory test assistant',
    knowledge: { projectContext: hooks, projectMemory: false }, toolPolicy: { mode: 'allowlist', allowedTools: names } });
  return resolveModelBinding({ registry, assistantId: 'assistant_revocation_race', projectBindingId: 'pb_in_memory_only',
    senderId: 1, sessionId: 'in-memory-session', runId: 'in-memory-run', clientRequestId: 'in-memory-request' });
}
function allowThenAbort(controller, abort) {
  // Resolve allowed first, then revoke before the awaiting Agent continuation can execute.
  return new Promise(resolve => { resolve({ allowed: true }); if (abort) controller.abort(); });
}
function fixture({ abortAuthorize = 0, abortValidate = 0, hooks = false, abortPreReturn = false } = {}) {
  const controller = new AbortController(); const events = []; const writes = []; const executions = [];
  let authorizations = 0; let validations = 0; let preCalls = 0; let postCalls = 0;
  const gate = { authorize: () => allowThenAbort(controller, ++authorizations === abortAuthorize),
    validatePath: () => allowThenAbort(controller, ++validations === abortValidate) };
  const agentPath = require.resolve('../src/ai/agent'); const requireFromAgent = createRequire(agentPath);
  const projectFs = requireFromAgent('./project-fs');
  const overrides = {
    fs: { ...fs, existsSync: () => false, statSync: () => { throw new Error('IN_MEMORY_FS_ONLY'); }, readFileSync: () => { throw new Error('IN_MEMORY_FS_ONLY'); } },
    './project-fs': { ...projectFs, resolveSafe: () => path.join(root, 'virtual.txt'),
      listTree: () => ({ count: 0, truncated: false, treeText: '' }),
      previewSearchReplace: () => ({ before: 'before', after: 'after', replacements: 1 }),
      writeFile: (_root, name, content) => { writes.push({ name, content, aborted: controller.signal.aborted }); return { path: name, bytes: String(content).length }; } },
    './project-instructions': { loadProjectInstructions: () => ({ parts: '' }) },
    './gitignore': { loadGitignoreRules: () => null },
    './hooks-loader': { loadHooks: () => ({}) },
    './hooks-runner': { createHooksRunner: () => ({
      runLifecycle: async () => ({}), runPostToolUse: async () => { postCalls++; },
      runPreToolUse: async ({ args, onArgsChanged }) => {
        preCalls++; const rewritten = { ...args, command: 'in-memory rewritten command' };
        if (!abortPreReturn) await onArgsChanged({ args: rewritten });
        if (abortPreReturn) controller.abort();
        return { decision: 'allow', args: rewritten, argsChanged: !abortPreReturn };
      },
    }) },
  };
  const loaded = new Module(agentPath); loaded.filename = agentPath;
  loaded.require = name => Object.hasOwn(overrides, name) ? overrides[name] : requireFromAgent(name);
  loaded._compile(fs.readFileSync(agentPath, 'utf8'), agentPath);
  const registry = createRegistry();
  const run = (name, args = {}) => {
    const names = [...new Set([name, ...(hooks ? ['run_terminal'] : [])])];
    registry.register({ id: 'in-memory-provider', getTools: () => names.map(definition),
      execute: async (tool, toolArgs) => { executions.push({ tool, args: toolArgs, aborted: controller.signal.aborted }); return JSON.stringify({ ok: true, path: toolArgs.path, bytes: 5 }); } });
    let turns = 0;
    return loaded.exports.runAgentLoop({ project, registry, modelBinding: modelBinding(names, { hooks }),
      extensions: { userDataPath: path.join(root, 'virtual-user-data') },
      settings: { ...settings, terminalEnabled: hooks, hooksEnabled: hooks }, messages: [{ role: 'user', content: 'In-memory race fixture' }],
      signal: controller.signal, gate, onEvent: event => events.push(event),
      chatFn: async () => ++turns === 1 ? { content: null, tool_calls: [{ id: 'race-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'In-memory done' } });
  };
  const fence = () => loaded.exports.applyWriteFencesWithGate(root, '```write:virtual.txt\nafter\n```', {
    gate, settings, signal: controller.signal, onEvent: event => events.push(event), modelBinding: modelBinding(['write_file'], { toolMode: 'text-compat' }),
    advertisedTools: new Set(['write_file']), agentMode: 'agent' });
  return { agent: loaded.exports, run, fence, gate, controller, events, writes, executions,
    counts: () => ({ authorizations, validations, preCalls, postCalls }) };
}
async function cancelledWithoutEffects(promise, f) {
  await assert.rejects(promise, { code: 'ABORTED' });
  assert.equal(f.writes.length, 0); assert.equal(f.executions.length, 0);
  const ends = f.events.filter(event => event.type === AGENT_EVENTS.TOOL_END);
  assert.equal(ends.length, 1); assert.equal(ends[0].ok, false);
  assert.equal(f.events.filter(event => event.type === AGENT_EVENTS.FILE_CHANGE).length, 0);
}
test('E4 real memory provider never writes after Gate resolves allowed then the run is revoked', async t => {
  const f = fixture({ abortAuthorize: 1 }); const registry = createRegistry(); registry.register(createMemoryProvider());
  const original = memoryStore.appendEntry; let appended = 0;
  memoryStore.appendEntry = () => { appended++; return { ok: true, id: 'in-memory-entry' }; };
  t.after(() => { memoryStore.appendEntry = original; });
  let turns = 0;
  await cancelledWithoutEffects(f.agent.runAgentLoop({ project: null, registry, modelBinding: modelBinding(['remember']),
    settings: { ...settings, memoryEnabled: true }, messages: [{ role: 'user', content: 'In-memory request' }], signal: f.controller.signal,
    gate: f.gate, onEvent: event => f.events.push(event), chatFn: async () => ++turns === 1
      ? { content: null, tool_calls: [{ id: 'memory-race', type: 'function', function: { name: 'remember', arguments: '{"text":"In-memory fact","scope":"user"}' } }] }
      : { content: 'done' } }), f);
  assert.equal(appended, 0);
});
for (const [label, options] of [['Gate allow', { abortAuthorize: 1 }], ['initial validation', { abortValidate: 1 }], ['final validation', { abortValidate: 2 }]]) {
  test(`E4 write fence rechecks cancellation after ${label} without any physical write`, async () => {
    const f = fixture(options); await cancelledWithoutEffects(f.fence(), f);
  });
}
for (const name of ['write_file', 'search_replace']) {
  test(`E4 ${name} rechecks final mutation validation before registry dispatch or approved-preview write`, async () => {
    const f = fixture({ abortValidate: 2 }); await cancelledWithoutEffects(f.run(name, { path: 'virtual.txt', content: 'after', old_string: 'before', new_string: 'after' }), f);
    assert.equal(f.counts().authorizations, 1);
  });
}
test('E4 hooks Gate2 allow cannot dispatch a tool after revocation', async () => {
  const f = fixture({ hooks: true, abortAuthorize: 2 }); await cancelledWithoutEffects(f.run('run_terminal', { command: 'in-memory original command' }), f);
  assert.equal(f.counts().authorizations, 2); assert.equal(f.counts().preCalls, 1); assert.equal(f.counts().postCalls, 0);
});
test('E4 hooks return allow cannot dispatch a tool after revocation during Pre', async () => {
  const f = fixture({ hooks: true, abortPreReturn: true }); await cancelledWithoutEffects(f.run('run_terminal', { command: 'in-memory original command' }), f);
  assert.equal(f.counts().authorizations, 1); assert.equal(f.counts().postCalls, 0);
});
test('E4 hooks rechecks final mutation validation before writing its approved search_replace preview', async () => {
  const f = fixture({ hooks: true, abortValidate: 3 }); await cancelledWithoutEffects(f.run('search_replace', { path: 'virtual.txt', old_string: 'before', new_string: 'after' }), f);
  assert.equal(f.counts().authorizations, 2); assert.equal(f.counts().postCalls, 0);
});
test('E4 unrevoked tool dispatch and write fence still emit success exactly once', async () => {
  const direct = fixture(); await direct.run('write_file', { path: 'virtual.txt', content: 'after' });
  assert.equal(direct.executions.length, 1); assert.equal(direct.executions[0].aborted, false);
  assert.equal(direct.events.filter(event => event.type === AGENT_EVENTS.TOOL_END && event.ok).length, 1);
  const fenced = fixture(); const out = await fenced.fence(); assert.equal(out.applied[0].ok, true); assert.equal(fenced.writes.length, 1);
  assert.equal(fenced.events.filter(event => event.type === AGENT_EVENTS.TOOL_END && event.ok).length, 1);
});
