'use strict';

// Offline, isolated synthetic profiles/projects only. No endpoint or credential is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelRegistry, saveProfile, resolveModelBinding } = require('../src/ai/model-profiles');
const { createRegistry } = require('../src/ai/extensions/registry');
const { runAgentLoop, toolsForSettings, callModelTurn, applyWriteFencesWithGate } = require('../src/ai/agent');
const { filterToolsForMode, shouldUseAgent } = require('../src/ai/agent-mode');
const { createMemoryProvider } = require('../src/ai/providers/memory');
const memoryStore = require('../src/ai/memory-store');
const { createSubagentRuntime } = require('../src/ai/subagent-runtime');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { throw new Error('SYNTHETIC_NETWORK_DISABLED'); }; });
test.after(() => { globalThis.fetch = originalFetch; });

const settings = {
  mode: 'api', model: 'legacy-model-must-not-route', baseUrl: 'https://legacy.invalid/v1',
  maxAgentTurns: 3, terminalEnabled: false, hooksEnabled: false, verifyBeforeDone: false,
  memoryEnabled: false, skillsEnabled: false, mcpEnabled: false, subagentEnabled: false,
};
const definition = (name) => ({ type: 'function', function: { name, description: 'Synthetic ' + name, parameters: { type: 'object', properties: {} } } });
const toolNames = (tools) => (tools || []).map((tool) => tool.name || tool.function?.name);

function binding({ allowedTools = ['read_file'], knowledge = {}, projectId = null, toolMode = 'native', nativeTools = 'supported', systemPrompt = 'SYNTHETIC_ASSISTANT_PROMPT', assistantId = 'assistant_synthetic' } = {}) {
  let registry = createModelRegistry({ baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model' });
  registry = saveProfile(registry, 'model', {
    ...registry.models[0],
    capabilities: { nativeTools: { state: nativeTools, source: 'declared' } },
    compatibility: { toolMode, streamMode: 'off', includeUsage: true },
  });
  registry = saveProfile(registry, 'assistant', {
    id: assistantId, name: 'Synthetic assistant', systemPrompt, projectId,
    knowledge: { projectContext: false, projectMemory: false, ...knowledge },
    toolPolicy: { mode: 'allowlist', allowedTools },
  });
  return resolveModelBinding({ registry, assistantId, projectBindingId: 'pb_synthetic_opaque', runId: 'synthetic-run', sessionId: 'synthetic-session' });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-agent-synthetic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project: { id: 'synthetic-project', name: 'Synthetic project', path: root } };
}

function registryFor(names, overrides = {}) {
  const registry = createRegistry();
  registry.register({
    id: 'synthetic', getTools: () => names.map(definition),
    execute: async () => JSON.stringify({ ok: true, content: 'synthetic result' }),
    ...overrides,
  });
  return registry;
}

const completed = async () => ({ content: 'Synthetic done', turns: 1, agentLog: [], fileChanges: [], terminalReason: 'completed' });

function runArgs(project, modelBinding, extra = {}) {
  return {
    project, modelBinding, settings: { ...settings }, messages: [{ role: 'user', content: 'Synthetic request' }],
    chatFn: async () => ({ content: 'Synthetic answer' }), registry: registryFor(['read_file']),
    ...extra,
  };
}

test('bound tool advertisement preserves the brand and intersects host, mode and assistant tools', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ allowedTools: ['read_file', 'write_file', 'run_terminal', 'mcp_synthetic_ping'] });
  let received;
  const registry = registryFor(['read_file', 'write_file', 'run_terminal', 'submit_plan', 'mcp_synthetic_ping'], {
    getTools(ctx) { received = ctx; return ['read_file', 'write_file', 'run_terminal', 'submit_plan', 'mcp_synthetic_ping'].map(definition); },
  });
  const tools = await toolsForSettings(settings, { project, modelBinding, registry, agentMode: 'plan' });
  assert.deepEqual(toolNames(tools), ['read_file']);
  assert.equal(received.modelBinding, modelBinding);
  assert.equal(received.extensions.modelBinding, modelBinding);
  assert.equal(received.contextPolicy.projectContext, false);
});

test('canonical mode filtering and bound Agent selection do not use a legacy API key', () => {
  const canonical = ['read_file', 'run_terminal', 'mcp_synthetic_ping', 'submit_plan'].map((name) => ({ name }));
  assert.deepEqual(toolNames(filterToolsForMode(canonical, 'plan')), ['read_file', 'submit_plan']);
  assert.deepEqual(toolNames(filterToolsForMode(canonical, 'agent')), ['read_file', 'run_terminal', 'mcp_synthetic_ping']);
  const base = { settings, project: { id: 'synthetic-project', path: 'Z:/synthetic' } };
  assert.equal(shouldUseAgent({ ...base, modelBinding: binding() }), true);
  assert.equal(shouldUseAgent({ ...base, modelBinding: binding({ allowedTools: [] }) }), false);
  assert.equal(shouldUseAgent({ ...base, modelBinding: binding({ nativeTools: 'unknown' }) }), false);
  assert.equal(shouldUseAgent({ ...base, modelBinding: binding({ nativeTools: 'unknown', toolMode: 'text-compat' }) }), true);
});

test('bound run propagates binding/context, assistant prompt and deltas without legacy usage or route fields', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding();
  const events = [];
  const contexts = [];
  let call;
  const registry = registryFor(['read_file', 'write_file'], {
    onRunStart(ctx) { contexts.push(ctx); },
    getSystemFragment(ctx) { contexts.push(ctx); return 'SYNTHETIC_PROVIDER_CONTEXT'; },
    execute: async (_name, _args, ctx) => { contexts.push(ctx); return JSON.stringify({ ok: true }); },
  });
  let turns = 0;
  const result = await runAgentLoop(runArgs(project, modelBinding, {
    registry, onEvent: (event) => events.push(event),
    chatFn: async (opts) => {
      call = opts;
      opts.onDelta?.({ text: 'synthetic delta' });
      turns += 1;
      return turns === 1
        ? { content: '', usage: { prompt_tokens: 7, completion_tokens: 3 }, tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
        : { content: 'Synthetic answer', usage: { prompt_tokens: 8, completion_tokens: 4 } };
    },
  }));
  assert.equal(result.agentLog.length, 1);
  assert.match(call.messages[0].content, /SYNTHETIC_ASSISTANT_PROMPT/);
  assert.equal(call.modelBinding, modelBinding);
  for (const field of ['model', 'baseUrl', 'apiKey']) assert.equal(Object.hasOwn(call, field), false);
  assert.ok(contexts.length >= 2);
  for (const ctx of contexts) {
    assert.equal(ctx.modelBinding, modelBinding);
    assert.equal(ctx.extensions.modelBinding, modelBinding);
    assert.equal(ctx.projectBindingId, modelBinding.projectBindingId);
  }
  assert.equal(events.filter((event) => event.type === AGENT_EVENTS.USAGE).length, 0);
  assert.equal(events.filter((event) => event.type === AGENT_EVENTS.TEXT_DELTA).length, 2);
});

test('knowledge off prevents automatic instructions, tree, verify-config and hook reads while explicit read remains available', async (t) => {
  const { project, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'SYNTHETIC_PRIVATE_INSTRUCTIONS');
  fs.writeFileSync(path.join(root, 'SYNTHETIC_PRIVATE_TREE.txt'), 'Synthetic fixture');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'synthetic-no-execution' } }));
  const readFileSync = fs.readFileSync;
  const readdirSync = fs.readdirSync;
  const reads = [];
  fs.readFileSync = function (file, ...rest) { if (String(file).startsWith(root)) reads.push(String(file)); return readFileSync.call(this, file, ...rest); };
  fs.readdirSync = function (file, ...rest) { if (String(file).startsWith(root)) reads.push(String(file)); return readdirSync.call(this, file, ...rest); };
  t.after(() => { fs.readFileSync = readFileSync; fs.readdirSync = readdirSync; });
  let prompt;
  let supplied;
  await runAgentLoop(runArgs(project, binding(), {
    registry: undefined,
    settings: { ...settings, hooksEnabled: true, verifyBeforeDone: true, terminalEnabled: true, skillsEnabled: true },
    extensions: { userDataPath: root },
    chatFn: async (opts) => { prompt = opts.messages[0].content; supplied = opts.tools; return { content: 'Synthetic done' }; },
  }));
  assert.deepEqual(reads, []);
  assert.doesNotMatch(prompt, /SYNTHETIC_PRIVATE|可用 Skills|Skills 自动匹配|synthetic-no-execution/);
  assert.deepEqual(toolNames(supplied), ['read_file']);
});

test('enabled project context injects instructions and assistant prompt together', async (t) => {
  const { project, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'SYNTHETIC_ALLOWED_INSTRUCTIONS');
  let prompt;
  await runAgentLoop(runArgs(project, binding({ knowledge: { projectContext: true } }), {
    chatFn: async (opts) => { prompt = opts.messages[0].content; return { content: 'Synthetic done' }; },
  }));
  assert.match(prompt, /SYNTHETIC_ALLOWED_INSTRUCTIONS/);
  assert.match(prompt, /SYNTHETIC_ASSISTANT_PROMPT/);
});

test('project mismatch and an unbranded binding fail before providers or model calls', async (t) => {
  const { project } = fixture(t);
  let started = 0;
  let calls = 0;
  const registry = registryFor(['read_file'], { onRunStart() { started += 1; } });
  const chatFn = async () => { calls += 1; return { content: 'Synthetic done' }; };
  await assert.rejects(runAgentLoop(runArgs(project, binding({ projectId: 'another-synthetic-project' }), { registry, chatFn })), { code: 'ASSISTANT_PROJECT_MISMATCH' });
  await assert.rejects(runAgentLoop(runArgs(project, { ...binding() }, { registry, chatFn })), { code: 'MODEL_BINDING_INVALID' });
  assert.equal(started, 0);
  assert.equal(calls, 0);
});

test('bound run requires an explicitly model-bound chat function', async (t) => {
  const { project } = fixture(t);
  await assert.rejects(runAgentLoop(runArgs(project, binding(), { chatFn: undefined })), { code: 'MODEL_BOUND_CHAT_REQUIRED' });
});

test('native dispatch cannot call assistant-forbidden or host-unadvertised tools before Gate or preview', async (t) => {
  const { project } = fixture(t);
  for (const allowedTools of [['read_file'], ['read_file', 'write_file']]) {
    let executions = 0;
    let authorizations = 0;
    const registry = registryFor(['read_file'], { execute: async () => { executions += 1; return '{}'; } });
    await assert.rejects(runAgentLoop(runArgs(project, binding({ allowedTools }), {
      registry, gate: { authorize: async () => { authorizations += 1; return { allowed: true }; } },
      chatFn: async () => ({ tool_calls: [{ id: 'synthetic-denied-call', function: { name: 'write_file', arguments: '{"path":"never-written.txt","content":"synthetic"}' } }] }),
    })), { code: 'ASSISTANT_TOOL_DENIED' });
    assert.equal(executions, 0);
    assert.equal(authorizations, 0);
    assert.equal(fs.existsSync(path.join(project.path, 'never-written.txt')), false);
  }
});

test('native binding leaves ordinary fenced tool examples as text', async (t) => {
  const { project } = fixture(t);
  let executions = 0;
  const content = 'Synthetic example:\n```tool read_file\n{"path":"example.txt"}\n```';
  const result = await runAgentLoop(runArgs(project, binding(), {
    registry: registryFor(['read_file'], { execute: async () => { executions += 1; return '{}'; } }),
    chatFn: async () => ({ content }),
  }));
  assert.equal(executions, 0);
  assert.equal(result.content, content);
});

test('explicit text-compat advertises only filtered schemas and dispatches through the same boundary', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ toolMode: 'text-compat', nativeTools: 'unknown' });
  let executions = 0;
  let calls = 0;
  let prompt;
  await runAgentLoop(runArgs(project, modelBinding, {
    registry: registryFor(['read_file', 'write_file'], { execute: async () => { executions += 1; return JSON.stringify({ ok: true }); } }),
    chatFn: async (opts) => {
      calls += 1;
      prompt = opts.messages[0].content;
      assert.deepEqual(toolNames(opts.tools), ['read_file']);
      return calls === 1 ? { content: '```tool read_file\n{}\n```' } : { content: 'Synthetic done' };
    },
  }));
  assert.equal(executions, 1);
  assert.match(prompt, /text-compat/);
  assert.match(prompt, /"name":"read_file"/);
  assert.doesNotMatch(prompt, /"name":"write_file"/);
  await assert.rejects(runAgentLoop(runArgs(project, modelBinding, {
    chatFn: async () => ({ content: '```tool write_file\n{"path":"never-written.txt"}\n```' }),
  })), { code: 'ASSISTANT_TOOL_DENIED' });
});

test('unknown or unsupported native tools never send a speculative Agent request or switch tool mode', async (t) => {
  const { project } = fixture(t);
  for (const state of ['unknown', 'unsupported']) {
    let calls = 0;
    await assert.rejects(runAgentLoop(runArgs(project, binding({ nativeTools: state }), {
      chatFn: async () => { calls += 1; return { content: 'Synthetic done' }; },
    })), { code: state === 'unknown' ? 'MODEL_CAPABILITY_UNKNOWN' : 'MODEL_CAPABILITY_UNSUPPORTED' });
    assert.equal(calls, 0);
  }
});

test('strict model turns call once and preserve MODEL errors and partial output exactly', async () => {
  const modelBinding = binding();
  for (const [code, message] of [
    ['MODEL_STREAM_INCOMPLETE', 'SSE parse failed mid-stream'],
    ['MODEL_HTTP_ERROR', '400 tools unsupported'],
    ['MODEL_INVALID_REQUEST', 'stream_options unsupported'],
  ]) {
    let calls = 0;
    const error = Object.assign(new Error(message), { code, partialOutput: 'synthetic partial output' });
    await assert.rejects(callModelTurn({
      modelBinding, chatFn: async (opts) => { calls += 1; opts.onDelta?.({ text: 'synthetic delta' }); throw error; },
      settings, working: [], tools: [definition('read_file')], toolsSupported: true,
    }), (actual) => actual === error && actual.partialOutput === 'synthetic partial output');
    assert.equal(calls, 1);
  }
  let strictCalls = 0;
  await assert.rejects(callModelTurn({ strict: true, chatFn: async () => { strictCalls += 1; throw new Error('stream_options unsupported'); }, settings, working: [], tools: [], toolsSupported: true }));
  assert.equal(strictCalls, 1);
});

test('bound loop never retries tools errors or accounts a second usage entry', async (t) => {
  const { project } = fixture(t);
  let calls = 0;
  const error = Object.assign(new Error('400 unsupported tools SSE parse stream_options'), { code: 'MODEL_HTTP_ERROR', partialOutput: 'synthetic partial' });
  const events = [];
  await assert.rejects(runAgentLoop(runArgs(project, binding(), {
    onEvent: (event) => events.push(event),
    chatFn: async () => { calls += 1; throw error; },
  })), (actual) => actual === error);
  assert.equal(calls, 1);
  assert.equal(events.filter((event) => event.type === AGENT_EVENTS.USAGE).length, 0);
});

test('write fences check assistant and advertised write_file before target reads or Gate calls', async (t) => {
  const { project, root } = fixture(t);
  const target = path.join(root, 'synthetic-fence.txt');
  fs.writeFileSync(target, 'before');
  const originalRead = fs.readFileSync;
  let reads = 0;
  let authorized = 0;
  fs.readFileSync = function (file, ...rest) { if (path.resolve(String(file)) === target) reads += 1; return originalRead.call(this, file, ...rest); };
  t.after(() => { fs.readFileSync = originalRead; });
  for (const allowedTools of [['read_file'], ['write_file']]) {
    await assert.rejects(applyWriteFencesWithGate(project.path, '```write:synthetic-fence.txt\nafter\n```', {
      modelBinding: binding({ allowedTools }), advertisedTools: new Set(['read_file']), settings,
      gate: { authorize: async () => { authorized += 1; return { allowed: true }; } },
    }), { code: 'ASSISTANT_TOOL_DENIED' });
  }
  assert.equal(reads, 0);
  assert.equal(authorized, 0);
  assert.equal(originalRead(target, 'utf8'), 'before');
});

test('bound write fences still respect Plan even when a permissive legacy Gate is provided', async (t) => {
  const { project, root } = fixture(t);
  await assert.rejects(applyWriteFencesWithGate(project.path, '```write:synthetic-plan.txt\nsynthetic\n```', {
    modelBinding: binding({ allowedTools: ['write_file'] }), advertisedTools: new Set(['write_file']), settings, agentMode: 'plan',
    gate: { authorize: async () => ({ allowed: true }) },
  }), { code: 'ASSISTANT_TOOL_DENIED' });
  assert.equal(fs.existsSync(path.join(root, 'synthetic-plan.txt')), false);
});

test('automatic memory off performs no store reads but explicit allowlisted memory tools remain usable', async (t) => {
  const { project, root } = fixture(t);
  const provider = createMemoryProvider();
  const modelBinding = binding({ allowedTools: ['recall', 'remember'] });
  const ctx = { project, modelBinding, settings: { ...settings, memoryEnabled: true }, extensions: { userDataPath: root, modelBinding } };
  const originalReadAll = memoryStore.readAll;
  let reads = 0;
  memoryStore.readAll = (...args) => { reads += 1; return originalReadAll(...args); };
  t.after(() => { memoryStore.readAll = originalReadAll; });
  assert.equal(provider.getSystemFragment(ctx), '');
  assert.equal(reads, 0);
  assert.deepEqual(toolNames(provider.getTools(ctx)), ['recall', 'remember']);
  const remembered = JSON.parse(await provider.execute('remember', { text: 'Synthetic stable convention', scope: 'project' }, ctx));
  assert.equal(remembered.ok, true);
  const recalled = JSON.parse(await provider.execute('recall', { query: 'Synthetic' }, ctx));
  assert.equal(recalled.ok, true);
  assert.equal(recalled.entries.length, 1);
  await assert.rejects(provider.execute('forget', { id: 'synthetic-not-allowed' }, ctx), { code: 'ASSISTANT_TOOL_DENIED' });
});

test('bound memory context requires the real project and does not hint unadvertised memory writes', (t) => {
  const { project, root } = fixture(t);
  memoryStore.appendEntry({ scope: 'project', projectPath: root, userDataPath: root, text: 'SYNTHETIC_MEMORY_CONTEXT', source: 'tool' });
  const provider = createMemoryProvider();
  const modelBinding = binding({ allowedTools: ['recall'], knowledge: { projectMemory: true } });
  const ctx = { project, modelBinding, settings: { ...settings, memoryEnabled: true }, advertisedTools: new Set(['recall']), extensions: { userDataPath: root } };
  const fragment = provider.getSystemFragment(ctx);
  assert.match(fragment, /SYNTHETIC_MEMORY_CONTEXT/);
  assert.doesNotMatch(fragment, /remember/);
  assert.equal(provider.getSystemFragment({ ...ctx, project: { path: root } }), '');
});

test('child bindings need a host factory and fail before a model call or worktree creation when it is missing', async (t) => {
  const { project } = fixture(t);
  let runs = 0;
  let creates = 0;
  const runtime = createSubagentRuntime({ runLoop: async () => { runs += 1; return completed(); }, worktreeManager: { create: async () => { creates += 1; return { ok: false }; } } });
  const ctx = { project, modelBinding: binding({ allowedTools: ['spawn_explore', 'spawn_implement', 'read_file'] }), settings, extensions: {} };
  assert.equal((await runtime.runExplore(ctx, { goal: 'Synthetic explore goal' })).code, 'MODEL_BOUND_CHAT_REQUIRED');
  assert.equal((await runtime.runImplement(ctx, { goal: 'Synthetic implement goal' })).code, 'MODEL_BOUND_CHAT_REQUIRED');
  assert.equal(runs, 0);
  assert.equal(creates, 0);
});

test('parallel children preserve one brand but receive independent host-created chat closures and clean extensions', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ allowedTools: ['spawn_explores', 'read_file'] });
  const children = [];
  const created = [];
  const runtime = createSubagentRuntime({ runLoop: async (opts) => { children.push(opts); return completed(); } });
  const ctx = {
    project, modelBinding, projectBindingId: modelBinding.projectBindingId, settings,
    signal: new AbortController().signal, extensions: {
      modelBinding, providerState: { syntheticParentState: true }, toolRoute: new Map(), skillCatalog: ['synthetic-parent-cache'],
      createBoundChat(kind, opts) { const chat = async () => ({ content: kind }); created.push({ kind, opts, chat }); return chat; },
    },
  };
  const result = await runtime.runExplores(ctx, { goals: ['Synthetic first goal', 'Synthetic second goal'] });
  assert.equal(result.ok, true);
  assert.equal(children.length, 2);
  assert.equal(created.length, 2);
  assert.notEqual(children[0].chatFn, children[1].chatFn);
  for (const child of children) {
    assert.equal(child.modelBinding, modelBinding);
    assert.equal(child.extensions.modelBinding, modelBinding);
    assert.equal(child.project.id, project.id);
    assert.equal(child.subagentDepth, 1);
    assert.equal(child.extensions.providerState, undefined);
    assert.equal(child.extensions.toolRoute, undefined);
    assert.equal(child.extensions.skillCatalog, undefined);
  }
  for (const entry of created) { assert.equal(entry.kind, 'explore'); assert.equal(entry.opts.signal, ctx.signal); }
});

test('spawn permission never grants a child unlisted tools and errors retain typed partial output', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ allowedTools: ['spawn_explore', 'read_file'] });
  const runtime = createSubagentRuntime({ runLoop: runAgentLoop });
  let executions = 0;
  const result = await runtime.runExplore({
    project, modelBinding, settings, registry: registryFor(['read_file', 'write_file'], { execute: async () => { executions += 1; return '{}'; } }),
    extensions: { createBoundChat: () => async () => ({ tool_calls: [{ id: 'synthetic-child-call', function: { name: 'write_file', arguments: '{"path":"never-written.txt","content":"synthetic"}' } }] }) },
  }, { goal: 'Synthetic child read goal' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ASSISTANT_TOOL_DENIED');
  assert.equal(executions, 0);
  const error = Object.assign(new Error('synthetic incomplete'), { code: 'MODEL_STREAM_INCOMPLETE', partialOutput: 'synthetic child partial' });
  const failed = await createSubagentRuntime({ runLoop: async () => { throw error; } }).runExplore({
    project, modelBinding, settings, extensions: { createBoundChat: () => async () => ({ content: '' }) },
  }, { goal: 'Synthetic child partial goal' });
  assert.equal(failed.code, error.code);
  assert.equal(failed.partialOutput, error.partialOutput);
});

test('implement child keeps project identity and model brand inside its trusted isolated workspace', async (t) => {
  const { project, root } = fixture(t);
  const childPath = path.join(root, 'synthetic-child');
  fs.mkdirSync(childPath);
  const modelBinding = binding({ allowedTools: ['spawn_implement', 'read_file', 'write_file'], projectId: project.id });
  let received;
  const runtime = createSubagentRuntime({
    runLoop: async (opts) => { received = opts; return completed(); },
    worktreeManager: {
      create: async (input) => { assert.equal(input.projectBindingId, modelBinding.projectBindingId); return { ok: true, handle: { childProjectPath: childPath } }; },
      collect: async () => ({ ok: true, changed: false }),
    },
  });
  const result = await runtime.runImplement({ project, modelBinding, settings, extensions: { createBoundChat: () => async () => ({ content: '' }) } }, { goal: 'Synthetic implement goal' });
  assert.equal(result.ok, true);
  assert.equal(received.modelBinding, modelBinding);
  assert.equal(received.project.path, childPath);
  assert.equal(received.project.id, project.id);
  assert.equal(received.subagentKind, 'implement');
  assert.equal(received.settings.terminalEnabled, false);
});

test('explicit no-tools compatibility never advertises tools or guesses another mode', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ toolMode: 'none' });
  assert.deepEqual(await toolsForSettings(settings, { project, modelBinding, registry: registryFor(['read_file']) }), []);
  let offered;
  const result = await runAgentLoop(runArgs(project, modelBinding, {
    chatFn: async (opts) => { offered = opts.tools; return { content: 'Synthetic text only' }; },
  }));
  assert.deepEqual(offered, []);
  assert.equal(result.content, 'Synthetic text only');
});

test('bound tools respect host feature switches even when a supplied registry offers extra definitions', async (t) => {
  const { project } = fixture(t);
  const names = ['read_file', 'run_terminal', 'recall', 'list_skills', 'mcp_synthetic_ping', 'spawn_explore', 'web_fetch'];
  const tools = await toolsForSettings({ ...settings, webEnabled: false }, {
    project, modelBinding: binding({ allowedTools: names }), registry: registryFor(names),
  });
  assert.deepEqual(toolNames(tools), ['read_file']);
});

test('bound children intersect the original role with the existing host depth allowlists', async (t) => {
  const { project } = fixture(t);
  const names = ['read_file', 'write_file', 'delete_path', 'run_terminal', 'spawn_explore', 'recall', 'use_skill', 'mcp_synthetic_ping', 'code_index_status'];
  const modelBinding = binding({ allowedTools: names });
  const enabled = { ...settings, terminalEnabled: true, subagentEnabled: true, memoryEnabled: true, skillsEnabled: true, mcpEnabled: true };
  const common = { project, modelBinding, registry: registryFor(names), subagentDepth: 1 };
  assert.deepEqual(toolNames(await toolsForSettings(enabled, { ...common, subagentKind: 'explore' })), ['read_file', 'code_index_status']);
  assert.deepEqual(toolNames(await toolsForSettings(enabled, { ...common, subagentKind: 'implement' })), ['read_file', 'write_file']);
});

test('memory rejects explicitly invalid falsy bindings before automatic or explicit store access', async (t) => {
  const { project, root } = fixture(t);
  const provider = createMemoryProvider();
  const readAll = memoryStore.readAll;
  let reads = 0;
  memoryStore.readAll = (...args) => { reads += 1; return readAll(...args); };
  t.after(() => { memoryStore.readAll = readAll; });
  for (const modelBinding of [false, 0, '']) {
    const ctx = { project, modelBinding, settings: { ...settings, memoryEnabled: true }, extensions: { userDataPath: root } };
    assert.equal(provider.getSystemFragment(ctx), '');
    assert.deepEqual(provider.getTools(ctx), []);
    await assert.rejects(provider.execute('recall', { query: 'Synthetic' }, ctx), { code: 'ASSISTANT_TOOL_DENIED' });
  }
  assert.equal(reads, 0);
});

test('remember-only automatic memory has no hidden recall or remember tool footer', (t) => {
  const { project, root } = fixture(t);
  memoryStore.appendEntry({ scope: 'project', projectPath: root, userDataPath: root, text: 'SYNTHETIC_REMEMBER_ONLY', source: 'tool' });
  const fragment = createMemoryProvider().getSystemFragment({
    project, modelBinding: binding({ allowedTools: ['remember'], knowledge: { projectMemory: true } }),
    settings: { ...settings, memoryEnabled: true }, advertisedTools: new Set(['remember']), extensions: { userDataPath: root },
  });
  assert.match(fragment, /SYNTHETIC_REMEMBER_ONLY/);
  assert.doesNotMatch(fragment, /更多条目用 recall|需要记住新事实用 remember/);
});

test('host factory reuse of one chat closure cannot share state across parallel bound children', async (t) => {
  const { project } = fixture(t);
  const modelBinding = binding({ allowedTools: ['spawn_explores', 'read_file'] });
  const sameChat = async () => ({ content: 'Synthetic done' });
  let runs = 0;
  const runtime = createSubagentRuntime({ runLoop: async () => { runs += 1; return completed(); } });
  const result = await runtime.runExplores({ project, modelBinding, settings, extensions: { createBoundChat: () => sameChat } }, {
    goals: ['Synthetic first goal', 'Synthetic second goal'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].code, 'MODEL_BOUND_CHAT_REQUIRED');
  assert.equal(runs, 1);
});

test('automatic terminal helpers require a terminal in the actual advertised set', async (t) => {
  const { project, root } = fixture(t);
  const readFileSync = fs.readFileSync;
  const configReads = [];
  fs.readFileSync = function (file, ...rest) {
    if (String(file).startsWith(root) && /(?:package|hooks)\.json$/i.test(String(file))) configReads.push(String(file));
    return readFileSync.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = readFileSync; });
  await runAgentLoop(runArgs(project, binding({ allowedTools: ['read_file', 'run_terminal'], knowledge: { projectContext: true } }), {
    settings: { ...settings, terminalEnabled: true, verifyBeforeDone: true, hooksEnabled: true },
    extensions: { userDataPath: root }, registry: registryFor(['read_file']),
  }));
  assert.deepEqual(configReads, []);
});

test('text-compat accepts exact advertised canonical tool names with digits and punctuation', async (t) => {
  const { project } = fixture(t);
  const name = 'mcp_synthetic2.echo:v1';
  const modelBinding = binding({ allowedTools: [name], toolMode: 'text-compat', nativeTools: 'unknown' });
  let executed = 0;
  let turns = 0;
  const registry = registryFor([name], { execute: async (received) => { assert.equal(received, name); executed += 1; return JSON.stringify({ ok: true }); } });
  const result = await runAgentLoop(runArgs(project, modelBinding, {
    registry, settings: { ...settings, mcpEnabled: true },
    chatFn: async () => (++turns === 1 ? { content: '```tool ' + name + '\n{}\n```' } : { content: 'Synthetic done' }),
  }));
  assert.equal(executed, 1);
  assert.equal(result.agentLog[0].tool, name);
});

// Legacy behavior is covered by agent.test.js, agent-mode.test.js and subagent-runtime.test.js.
