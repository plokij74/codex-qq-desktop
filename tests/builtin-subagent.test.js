'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBuiltinProvider, EXPLORE_READONLY, IMPLEMENT_TOOLS } = require('../src/ai/providers/builtin');

describe('builtin subagent tool filter', () => {
  const allDefs = [
    'list_dir', 'read_file', 'grep', 'glob', 'git_status', 'git_diff',
    'write_file', 'search_replace', 'delete_path', 'run_terminal', 'git_commit', 'submit_plan',
  ].map((name) => ({ type: 'function', function: { name } }));

  function names(defs) {
    return defs.map((t) => t.function.name).sort();
  }

  it('exports IMPLEMENT_TOOLS including writes', () => {
    assert.ok(IMPLEMENT_TOOLS.has('write_file'));
    assert.ok(IMPLEMENT_TOOLS.has('search_replace'));
    assert.ok(!IMPLEMENT_TOOLS.has('run_terminal'));
    assert.ok(!IMPLEMENT_TOOLS.has('delete_path'));
  });

  it('explore depth filters to readonly', () => {
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async () => '{}',
    });
    const tools = p.getTools({
      subagentDepth: 1,
      subagentKind: 'explore',
      settings: { terminalEnabled: true },
    });
    assert.deepEqual(names(tools), [...EXPLORE_READONLY].sort());
  });

  it('implement depth allows write_file and search_replace', () => {
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async () => '{}',
    });
    const tools = p.getTools({
      subagentDepth: 1,
      subagentKind: 'implement',
      settings: { terminalEnabled: true },
    });
    const set = new Set(names(tools));
    assert.ok(set.has('write_file'));
    assert.ok(set.has('search_replace'));
    assert.ok(set.has('read_file'));
    assert.ok(!set.has('run_terminal'));
    assert.ok(!set.has('delete_path'));
    assert.ok(!set.has('git_commit'));
  });

  it('execute rejects tools outside explore allowlist at depth>=1', async () => {
    let called = null;
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async (name) => {
        called = name;
        return JSON.stringify({ ok: true });
      },
    });
    const raw = await p.execute('run_terminal', { cmd: 'echo hi' }, {
      subagentDepth: 1,
      subagentKind: 'explore',
      settings: { terminalEnabled: true },
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, false);
    assert.match(String(parsed.error || ''), /未知|unknown/i);
    assert.equal(called, null);
  });

  it('execute rejects delete_path for implement depth', async () => {
    let called = null;
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async (name) => {
        called = name;
        return JSON.stringify({ ok: true });
      },
    });
    const raw = await p.execute('delete_path', { path: 'x' }, {
      subagentDepth: 1,
      subagentKind: 'implement',
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, false);
    assert.match(String(parsed.error || ''), /未知|unknown/i);
    assert.equal(called, null);
  });

  it('execute allows read_file at explore depth', async () => {
    let called = null;
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async (name) => {
        called = name;
        return JSON.stringify({ ok: true, name });
      },
    });
    const raw = await p.execute('read_file', { path: 'a.js' }, {
      subagentDepth: 1,
      subagentKind: 'explore',
    });
    assert.equal(called, 'read_file');
    assert.equal(JSON.parse(raw).ok, true);
  });

  it('allows engineering reads to explore but never verification or workflow mutations', async () => {
    const defs = [
      'code_index_status', 'code_index_search', 'verification_profiles',
      'verification_get', 'verification_result', 'verification_start',
      'engineering_workflows', 'workflow_get', 'workflow_result', 'workflow_start', 'workflow_cancel',
    ].map((name) => ({ type: 'function', function: { name } }));
    const p = createBuiltinProvider({
      getToolDefs: () => defs,
      executeTool: async (name) => JSON.stringify({ ok: true, name }),
    });
    const explore = p.getTools({ subagentDepth: 1, subagentKind: 'explore', settings: { terminalEnabled: true } });
    assert.deepEqual(names(explore), [
      'code_index_search', 'code_index_status', 'engineering_workflows',
      'verification_get', 'verification_profiles', 'verification_result',
      'workflow_get', 'workflow_result',
    ]);
    const denied = JSON.parse(await p.execute('verification_start', { profileId: 'vfy_12345678' }, {
      subagentDepth: 1, subagentKind: 'explore', settings: { terminalEnabled: true },
    }));
    assert.equal(denied.ok, false);
    const workflowDenied = JSON.parse(await p.execute('workflow_start', { workflowId: 'wf_aaaaaaaaaaaaaaaa' }, {
      subagentDepth: 1, subagentKind: 'explore', settings: { terminalEnabled: true },
    }));
    assert.equal(workflowDenied.ok, false);
    const implement = p.getTools({ subagentDepth: 1, subagentKind: 'implement', settings: { terminalEnabled: true } });
    assert.ok(!implement.some((tool) => tool.function.name === 'verification_start'));
    assert.ok(!implement.some((tool) => tool.function.name.startsWith('workflow_')));
  });

  it('keeps engineering tools out of implement subagents that run in an isolated worktree', async () => {
    // An implement child's project.path is the temporary worktree, so an index
    // or profile lookup would target the worktree instead of the bound project
    // and the isolated gate denies these names anyway.
    const defs = [
      'read_file', 'write_file', 'code_index_status', 'code_index_search',
      'verification_profiles', 'verification_get', 'verification_result',
    ].map((name) => ({ type: 'function', function: { name } }));
    const p = createBuiltinProvider({
      getToolDefs: () => defs,
      executeTool: async (name) => JSON.stringify({ ok: true, name }),
    });
    const ctx = { subagentDepth: 1, subagentKind: 'implement', settings: { terminalEnabled: true } };
    assert.deepEqual(names(p.getTools(ctx)), ['read_file', 'write_file']);
    for (const name of ['code_index_status', 'code_index_search', 'verification_profiles', 'verification_get', 'verification_result']) {
      assert.equal(JSON.parse(await p.execute(name, {}, ctx)).ok, false, `${name} 必须被拒绝`);
    }
  });

  it('strips code index tools when the index switch is off', () => {
    const defs = ['read_file', 'code_index_status', 'code_index_search', 'verification_profiles']
      .map((name) => ({ type: 'function', function: { name } }));
    const p = createBuiltinProvider({ getToolDefs: () => defs, executeTool: async () => '{}' });
    const off = names(p.getTools({ settings: { codeIndexEnabled: false } }));
    assert.deepEqual(off, ['read_file', 'verification_profiles']);
    assert.ok(names(p.getTools({ settings: {} })).includes('code_index_search'));
  });
});
