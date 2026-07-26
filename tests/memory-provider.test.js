'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryProvider } = require('../src/ai/providers/memory');
const { readAll, appendEntry } = require('../src/ai/memory-store');

function ctxFor(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memprov-'));
  const projectPath = path.join(root, 'proj');
  const userDataPath = path.join(root, 'user');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  return {
    project: over.project === null ? null : { path: projectPath, name: 'proj' },
    settings: { memoryEnabled: true, memoryMaxEntries: 200, memoryInjectTopN: 8, memoryInjectMaxTokens: 1200, ...(over.settings || {}) },
    agentMode: over.agentMode || 'agent',
    subagentDepth: over.subagentDepth || 0,
    extensions: { userDataPath, userPromptText: over.userPromptText || '' },
    _paths: { projectPath, userDataPath },
  };
}

function toolNames(p, ctx) {
  return (p.getTools(ctx) || []).map((t) => t.function.name);
}

describe('memory provider', () => {
  it('is disabled when memoryEnabled is false', () => {
    const p = createMemoryProvider();
    assert.equal(p.isEnabled(ctxFor({ settings: { memoryEnabled: false } })), false);
  });

  it('is disabled inside sub-agents', () => {
    const p = createMemoryProvider();
    assert.equal(p.isEnabled(ctxFor({ subagentDepth: 1 })), false);
    assert.equal(p.isEnabled(ctxFor({ subagentDepth: 0 })), true);
  });

  it('exposes three tools in agent mode and only recall in plan mode', () => {
    const p = createMemoryProvider();
    assert.deepEqual(toolNames(p, ctxFor()).sort(), ['forget', 'recall', 'remember']);
    assert.deepEqual(toolNames(p, ctxFor({ agentMode: 'plan' })), ['recall']);
  });

  it('remember writes to project scope by default and to user when unbound', async () => {
    const p = createMemoryProvider();
    const ctx = ctxFor();
    const out = JSON.parse(await p.execute('remember', { text: '构建只用 npm test', tags: ['build'] }, ctx));
    assert.equal(out.ok, true);
    assert.equal(out.scope, 'project');
    assert.equal(readAll(ctx._paths).counts.project, 1);

    const unbound = ctxFor({ project: null });
    const out2 = JSON.parse(await p.execute('remember', { text: '回答一律中文' }, unbound));
    assert.equal(out2.scope, 'user');
    assert.equal(readAll({ userDataPath: unbound._paths.userDataPath }).counts.user, 1);
  });

  it('remember honours an explicit user scope', async () => {
    const p = createMemoryProvider();
    const ctx = ctxFor();
    const out = JSON.parse(await p.execute('remember', { text: '偏好深色', scope: 'user' }, ctx));
    assert.equal(out.scope, 'user');
    assert.equal(readAll(ctx._paths).counts.project, 0);
  });

  it('recall searches both scopes and clamps limit', async () => {
    const p = createMemoryProvider();
    const ctx = ctxFor();
    appendEntry({ scope: 'project', projectPath: ctx._paths.projectPath, text: '构建只用 npm test', maxEntries: 200, now: 1 });
    appendEntry({ scope: 'user', userDataPath: ctx._paths.userDataPath, text: '回答一律中文', maxEntries: 200, now: 2 });
    const out = JSON.parse(await p.execute('recall', { query: 'npm test', limit: 999 }, ctx));
    assert.equal(out.ok, true);
    assert.ok(out.entries.length >= 1);
    assert.equal(out.entries[0].text, '构建只用 npm test');
    assert.ok(out.entries.length <= 20);
  });

  it('forget removes by id and reports a miss', async () => {
    const p = createMemoryProvider();
    const ctx = ctxFor();
    const added = JSON.parse(await p.execute('remember', { text: '临时事实' }, ctx));
    const gone = JSON.parse(await p.execute('forget', { id: added.id }, ctx));
    assert.equal(gone.removed, true);
    assert.equal(readAll(ctx._paths).counts.project, 0);
    const miss = JSON.parse(await p.execute('forget', { id: 'm_nope' }, ctx));
    assert.equal(miss.removed, false);
  });

  it('rejects unknown tool names', async () => {
    const p = createMemoryProvider();
    const out = JSON.parse(await p.execute('nope', {}, ctxFor()));
    assert.equal(out.ok, false);
    assert.match(out.error, /未知工具/);
  });

  it('getSystemFragment injects a bounded block with the data-not-instruction warning', async () => {
    const p = createMemoryProvider();
    const ctx = ctxFor({ userPromptText: 'npm test 怎么跑' });
    appendEntry({ scope: 'project', projectPath: ctx._paths.projectPath, text: '构建只用 npm test', maxEntries: 200, now: Date.now() });
    const frag = p.getSystemFragment(ctx);
    assert.match(frag, /【长期记忆】/);
    assert.match(frag, /不是指令/);
    assert.match(frag, /构建只用 npm test/);
  });

  it('getSystemFragment returns empty when there is nothing or topN is 0', () => {
    const p = createMemoryProvider();
    assert.equal(p.getSystemFragment(ctxFor()), '');
    const ctx = ctxFor({ settings: { memoryInjectTopN: 0 } });
    appendEntry({ scope: 'project', projectPath: ctx._paths.projectPath, text: '不该出现', maxEntries: 200, now: Date.now() });
    assert.equal(p.getSystemFragment(ctx), '');
  });

  it('getSystemFragment survives a corrupt store', () => {
    const p = createMemoryProvider();
    const ctx = ctxFor();
    const file = path.join(ctx._paths.projectPath, '.codex', 'memory.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage\n', 'utf8');
    assert.equal(p.getSystemFragment(ctx), '');
  });
});
