'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('../src/ai/agent');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { createPermissionGate } = require('../src/ai/permission');

function setupProjectWithStopHook() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const hookJs = path.join(project, '.codex', 'stop-hook.js');
  fs.writeFileSync(hookJs, 'process.exit(0);\n');
  fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: {
      SessionStart: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
      UserPromptSubmit: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
      Stop: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
    },
  }));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"t"}');
  return { project, user };
}

function fullAutoGate() {
  return createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' });
}

function baseSettings(extra = {}) {
  return {
    mode: 'api',
    agentEnabled: true,
    maxAgentTurns: 1,
    hooksEnabled: true,
    permissionMode: 'full-auto',
    model: 'test',
    apiKey: 'x',
    baseUrl: 'http://127.0.0.1:9/v1',
    ...extra,
  };
}

describe('hooks agent lifecycle', () => {
  it('emits SessionStart UserPromptSubmit Stop on short local-like loop', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    const gate = fullAutoGate();
    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings(),
      messages: [{ role: 'user', content: 'hello' }],
      gate,
      onEvent: (e) => events.push(e),
      sessionKey: 's',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn: async () => ({ role: 'assistant', content: 'done', tool_calls: null }),
    });
    const types = events.map((e) => e.type);
    assert.ok(types.includes(AGENT_EVENTS.HOOK_START), 'expected hook-start');
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'SessionStart'),
      'SessionStart'
    );
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'UserPromptSubmit'),
      'UserPromptSubmit'
    );
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'Stop'),
      'Stop'
    );
  });

  it('does not run lifecycle hooks when subagentDepth > 0', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings(),
      messages: [{ role: 'user', content: 'hello' }],
      gate: fullAutoGate(),
      onEvent: (e) => events.push(e),
      sessionKey: 's-depth',
      agentMode: 'agent',
      subagentDepth: 1,
      extensions: { userDataPath: user },
      chatFn: async () => ({ role: 'assistant', content: 'done', tool_calls: null }),
    });
    assert.equal(
      events.filter((e) => e.type === AGENT_EVENTS.HOOK_START || e.type === AGENT_EVENTS.HOOK_END).length,
      0,
      'no hooks at depth>0'
    );
  });

  it('does not run lifecycle hooks when hooksEnabled is false', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ hooksEnabled: false }),
      messages: [{ role: 'user', content: 'hello' }],
      gate: fullAutoGate(),
      onEvent: (e) => events.push(e),
      sessionKey: 's-off',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn: async () => ({ role: 'assistant', content: 'done', tool_calls: null }),
    });
    assert.equal(
      events.filter((e) => e.type === AGENT_EVENTS.HOOK_START || e.type === AGENT_EVENTS.HOOK_END).length,
      0,
      'no hooks when disabled'
    );
  });

  it('Stop still runs with reason aborted when loop throws ABORTED', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    const ac = new AbortController();
    let err;
    try {
      await runAgentLoop({
        project: { path: project, name: 't' },
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'hello' }],
        gate: fullAutoGate(),
        onEvent: (e) => events.push(e),
        sessionKey: 's-abort',
        agentMode: 'agent',
        subagentDepth: 0,
        signal: ac.signal,
        extensions: { userDataPath: user },
        chatFn: async () => {
          ac.abort();
          const e = new Error('已停止');
          e.code = 'ABORTED';
          throw e;
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw');
    assert.equal(err.code, 'ABORTED');
    assert.match(err.message, /已停止/);
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'SessionStart'),
      'SessionStart before abort'
    );
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'Stop'),
      'Stop after abort'
    );
  });

  it('Stop still runs with reason error when chatFn throws non-abort error', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    let err;
    try {
      await runAgentLoop({
        project: { path: project, name: 't' },
        settings: baseSettings(),
        messages: [{ role: 'user', content: 'hello' }],
        gate: fullAutoGate(),
        onEvent: (e) => events.push(e),
        sessionKey: 's-err',
        agentMode: 'agent',
        subagentDepth: 0,
        extensions: { userDataPath: user },
        chatFn: async () => {
          throw new Error('model boom');
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected throw');
    assert.match(err.message, /model boom/);
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'Stop'),
      'Stop after error'
    );
  });
});
