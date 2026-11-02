'use strict';

// These tests use only synthetic profiles, host tool schemas and project tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRegistry, saveProfile, resolveModelBinding } = require('../src/ai/model-profiles');
const { filterAssistantTools, assertAssistantToolAllowed, assistantContextPolicy } = require('../src/ai/assistant-policy');

function binding(assistant = {}, context = {}) {
  let registry = createModelRegistry();
  const assistantId = assistant.id || 'assistant_synthetic';
  registry = saveProfile(registry, 'assistant', { name: 'Synthetic assistant', ...assistant, id: assistantId });
  return resolveModelBinding({ registry, senderId: 1, sessionId: 'synthetic-session', assistantId, ...context });
}
const exact = (allowedTools) => ({ mode: 'allowlist', allowedTools });
const project = { id: 'synthetic-project', path: 'Z:/synthetic-only' };
const tools = [
  { name: 'read_file', description: 'Synthetic canonical tool' },
  { type: 'function', function: { name: 'write_file', description: 'Synthetic legacy tool' } },
  { name: 'memory_list', parameters: { type: 'object', properties: {} } },
];
const denied = (fn) => assert.throws(fn, { code: 'ASSISTANT_TOOL_DENIED' });

test('custom and general assistants start with no tools or automatic project knowledge', () => {
  for (const b of [binding(), binding({ id: 'assistant_general' })]) {
    assert.deepEqual(filterAssistantTools(tools, b), []);
    denied(() => assertAssistantToolAllowed('read_file', b));
    assert.deepEqual(assistantContextPolicy(b, project), { projectContext: false, projectMemory: false, toolsAllowed: false });
  }
});

test('canonical and legacy tool schemas are filtered by the same exact allowlist', () => {
  const b = binding({ toolPolicy: exact(['read_file', 'write_file']) });
  const selected = filterAssistantTools(tools, b);
  assert.deepEqual(selected, tools.slice(0, 2));
  assert.notEqual(selected, tools);
  assert.equal(selected[0], tools[0]);
  assert.equal(selected[1], tools[1]);
  assert.equal(assertAssistantToolAllowed('read_file', b), true);
  assert.equal(assertAssistantToolAllowed('write_file', b), true);
  denied(() => assertAssistantToolAllowed('memory_list', b));
  denied(() => assertAssistantToolAllowed('read_file_extra', b));
  denied(() => assertAssistantToolAllowed('READ_FILE', b));
});

test('empty allowlist never means all tools', () => {
  const b = binding({ toolPolicy: exact([]) });
  assert.deepEqual(filterAssistantTools(tools, b), []);
  assert.equal(assistantContextPolicy(b, project).toolsAllowed, false);
  denied(() => assertAssistantToolAllowed('read_file', b));
});

test('only the branded built-in Codex host selector includes the supplied authorized tool directory', () => {
  const b = resolveModelBinding({ registry: createModelRegistry() });
  const selected = filterAssistantTools(tools, b);
  assert.deepEqual(selected, tools);
  assert.notEqual(selected, tools);
  assert.equal(assertAssistantToolAllowed('read_file', b), true);
  assert.equal(assistantContextPolicy(b, null).toolsAllowed, true);
  assert.deepEqual(filterAssistantTools([], b), []);
  denied(() => assertAssistantToolAllowed('@host-authorized', b));
});

test('built-in Codex can narrow the host directory to none or exact names', () => {
  const none = binding({ id: 'assistant_codex', toolPolicy: { mode: 'none', allowedTools: [] } });
  assert.deepEqual(filterAssistantTools(tools, none), []);
  denied(() => assertAssistantToolAllowed('read_file', none));
  const restricted = binding({ id: 'assistant_codex', toolPolicy: exact(['read_file']) });
  assert.deepEqual(filterAssistantTools(tools, restricted), [tools[0]]);
  denied(() => assertAssistantToolAllowed('write_file', restricted));
});

test('missing or unbranded binding DTOs fail closed even when they claim built-in authority', () => {
  const real = resolveModelBinding({ registry: createModelRegistry(), projectBindingId: 'synthetic-project-token' });
  for (const b of [undefined, null, {}, JSON.parse(JSON.stringify(real)), { ...real }, { assistantId: 'assistant_codex', assistant: { id: 'assistant_codex', builtIn: true, toolPolicy: exact(['@host-authorized']), knowledge: { projectContext: true, projectMemory: true } } }]) {
    assert.deepEqual(filterAssistantTools(tools, b), []);
    denied(() => assertAssistantToolAllowed('read_file', b));
    assert.deepEqual(assistantContextPolicy(b, project), { projectContext: false, projectMemory: false, toolsAllowed: false });
  }
});

test('invalid or ambiguous schemas cannot be advertised by the role filter', () => {
  const b = resolveModelBinding({ registry: createModelRegistry() });
  const malformed = [null, undefined, 'read_file', {}, { name: '' }, { name: '*' }, { name: 'read_*' }, { name: '@host-authorized' }, { name: 'read file' }, { name: 'read_file', function: { name: 'write_file' } }, { name: 'x'.repeat(129) }];
  assert.deepEqual(filterAssistantTools(malformed, b), []);
  assert.deepEqual(filterAssistantTools(null, b), []);
  for (const name of ['', '*', 'read_*', '@host-authorized', 'read file', 'x'.repeat(129), null, 4]) denied(() => assertAssistantToolAllowed(name, b));
  assert.deepEqual(filterAssistantTools([{ name: 'read_file', function: { name: 'read_file' } }], b), [{ name: 'read_file', function: { name: 'read_file' } }]);
});

test('knowledge requires a real bound project rather than assistant association or a path alone', () => {
  const configured = { knowledge: { projectContext: true, projectMemory: true }, projectId: project.id };
  for (const [b, currentProject] of [
    [binding(configured), project],
    [binding(configured, { projectBindingId: 'synthetic-token' }), null],
    [binding(configured, { projectBindingId: 'synthetic-token' }), { path: project.path }],
  ]) {
    assert.deepEqual(assistantContextPolicy(b, currentProject), { projectContext: false, projectMemory: false, toolsAllowed: false });
  }
});

test('bound knowledge flags are independent and project-binding tokens need not equal project IDs', () => {
  const context = { projectBindingId: 'pb_synthetic-opaque-token-not-project-id' };
  const both = binding({ knowledge: { projectContext: true, projectMemory: true }, projectId: project.id }, context);
  assert.deepEqual(assistantContextPolicy(both, project), { projectContext: true, projectMemory: true, toolsAllowed: false });
  const memoryOnly = binding({ knowledge: { projectContext: false, projectMemory: true } }, context);
  assert.deepEqual(assistantContextPolicy(memoryOnly, project), { projectContext: false, projectMemory: true, toolsAllowed: false });
  const contextOnly = binding({ knowledge: { projectContext: true, projectMemory: false } }, context);
  assert.deepEqual(assistantContextPolicy(contextOnly, project), { projectContext: true, projectMemory: false, toolsAllowed: false });
});

test('explicit project association mismatch is a typed failure before context injection', () => {
  const b = binding({ knowledge: { projectContext: true, projectMemory: true }, projectId: 'another-synthetic-project' }, { projectBindingId: 'synthetic-token' });
  assert.throws(() => assistantContextPolicy(b, project), { code: 'ASSISTANT_PROJECT_MISMATCH' });
  const withoutKnowledge = binding({ projectId: 'another-synthetic-project' }, { projectBindingId: 'synthetic-token' });
  assert.throws(() => assistantContextPolicy(withoutKnowledge, project), { code: 'ASSISTANT_PROJECT_MISMATCH' });
});

test('explicit memory tools are not disabled just because automatic memory injection is off', () => {
  const b = binding({ knowledge: { projectContext: false, projectMemory: false }, toolPolicy: exact(['memory_list']) });
  assert.deepEqual(filterAssistantTools(tools, b), [tools[2]]);
  assert.equal(assertAssistantToolAllowed('memory_list', b), true);
  assert.deepEqual(assistantContextPolicy(b, project), { projectContext: false, projectMemory: false, toolsAllowed: true });
});

test('filtering and dispatch decisions remain identical and cannot mutate binding or host tools', () => {
  const b = binding({ toolPolicy: exact(['read_file', 'memory_list']) });
  const beforeTools = JSON.stringify(tools);
  const beforeBinding = JSON.stringify(b);
  const selected = filterAssistantTools(tools, b);
  for (const tool of tools) {
    const name = tool.name || tool.function.name;
    if (selected.includes(tool)) assert.equal(assertAssistantToolAllowed(name, b), true);
    else denied(() => assertAssistantToolAllowed(name, b));
  }
  assert.equal(JSON.stringify(tools), beforeTools);
  assert.equal(JSON.stringify(b), beforeBinding);
  assert.ok(Object.isFrozen(b));
});
