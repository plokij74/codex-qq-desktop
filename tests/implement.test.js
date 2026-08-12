'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createImplementProvider } = require('../src/ai/providers/implement');
const { createPermissionGate } = require('../src/ai/permission');
const { createBuiltinProvider, IMPLEMENT_TOOLS } = require('../src/ai/providers/builtin');

describe('implement provider', () => {
  it('rejects nested spawn', async () => {
    const p = createImplementProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [], fileChanges: [] }),
    });
    const raw = await p.execute('spawn_implement', { goal: 'add a feature now' }, {
      subagentDepth: 1,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
      extensions: {},
    });
    assert.equal(JSON.parse(raw).ok, false);
  });

  it('calls runLoop with subagentKind implement', async () => {
    let seen;
    const p = createImplementProvider({
      runLoop: async (opts) => {
        seen = opts;
        return {
          content: 'changed settings',
          turns: 2,
          agentLog: [{ tool: 'search_replace', ok: true, summary: 'ok' }],
          fileChanges: [{ path: 'src/a.js', op: 'search_replace' }],
        };
      },
    });
    const events = [];
    const raw = await p.execute('spawn_implement', { goal: 'fix the bug in a.js', maxTurns: 5 }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
      onEvent: (e) => events.push(e),
      extensions: {
        worktreeManager: {
          async create() {
            return { ok: true, handle: { id: 'wt_testabc123', childProjectPath: process.cwd() } };
          },
          async collect() { return { ok: true, changed: false }; },
        },
      },
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, 'implement');
    assert.equal(seen.subagentKind, 'implement');
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.settings.maxAgentTurns, 5);
    assert.equal(parsed.fileChanges, undefined);
    assert.equal(parsed.isolation, 'worktree');
    assert.ok(events.some((e) => e.type === 'subagent-start' && e.kind === 'implement'));
    assert.ok(events.some((e) => e.type === 'subagent-end' && e.ok));
  });

  it('isEnabled false when subagent disabled or plan', () => {
    const p = createImplementProvider({ runLoop: async () => ({}) });
    assert.equal(p.isEnabled({
      settings: { subagentEnabled: false },
      agentMode: 'agent',
      subagentDepth: 0,
    }), false);
    assert.equal(p.isEnabled({
      settings: { subagentEnabled: true },
      agentMode: 'plan',
      subagentDepth: 0,
    }), false);
  });
});
