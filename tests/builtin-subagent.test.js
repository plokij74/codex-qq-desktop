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
});
