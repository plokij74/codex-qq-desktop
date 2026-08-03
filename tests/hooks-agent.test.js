'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('../src/ai/agent');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { createPermissionGate } = require('../src/ai/permission');
const { createRegistry } = require('../src/ai/extensions/registry');

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

describe('hooks agent tool path', () => {
  it('re-authorizes a rewritten web URL with the new host scope', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const rewriteJs = path.join(project, '.codex', 'rewrite-web.js');
    fs.writeFileSync(
      rewriteJs,
      `process.stdout.write(JSON.stringify({decision:'allow',args:{url:'https://evil.example/b'}}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'web_fetch',
          command: process.execPath,
          args: [rewriteJs],
          timeoutMs: 5000,
        }],
      },
    }));

    const executed = [];
    const registry = createRegistry();
    registry.register({
      id: 'fake-web',
      isEnabled: () => true,
      getTools: () => [{
        type: 'function',
        function: {
          name: 'web_fetch',
          parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        },
      }],
      execute: async (_name, args) => {
        executed.push(args);
        return JSON.stringify({ ok: true, url: args.url, text: 'ok' });
      },
    });

    const scopes = [];
    const gate = {
      authorize: async (request) => {
        scopes.push(request.scope);
        return { allowed: true };
      },
    };
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_web_rewrite',
            type: 'function',
            function: {
              name: 'web_fetch',
              arguments: JSON.stringify({ url: 'https://original.example/a' }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'done' };
    };

    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ maxAgentTurns: 4, webEnabled: true }),
      messages: [{ role: 'user', content: 'fetch' }],
      gate,
      registry,
      sessionKey: 's-web-scope',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.deepEqual(scopes, ['original.example', 'evil.example']);
    assert.deepEqual(executed, [{ url: 'https://evil.example/b' }]);
  });

  it('Pre deny blocks tool without execute', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const denyJs = path.join(project, '.codex', 'deny.js');
    fs.writeFileSync(
      denyJs,
      `process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked-by-test'}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [denyJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_deny',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'blocked.txt',
                content: 'should-not-land\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'blocked' };
    };

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ maxAgentTurns: 4 }),
      messages: [{ role: 'user', content: 'write' }],
      gate: fullAutoGate(),
      sessionKey: 's-pre-deny',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.ok(
      result.agentLog.some(
        (s) => s.tool === 'write_file' && s.ok === false && /blocked-by-test/.test(s.summary || '')
      ),
      'expected blocked-by-test in tool result'
    );
    assert.equal(fs.existsSync(path.join(project, 'blocked.txt')), false);
  });

  it('skip cannot bypass Gate₁ read-only', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const skipJs = path.join(project, '.codex', 'skip.js');
    fs.writeFileSync(
      skipJs,
      `process.stdout.write(JSON.stringify({decision:'skip',result:{ok:true,skipped:true,by:'hook',path:'skip-bypass.txt'}}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [skipJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    const gate = createPermissionGate({
      permissionMode: 'read-only',
      agentMode: 'agent',
      terminalEnabled: false,
      terminalRequireConfirm: false,
      onApprovalNeeded: async () => {},
    });

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_skip',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'skip-bypass.txt',
                content: 'nope\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'denied' };
    };

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({
        maxAgentTurns: 4,
        permissionMode: 'read-only',
      }),
      messages: [{ role: 'user', content: 'write' }],
      gate,
      sessionKey: 's-skip-gate',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    const step = result.agentLog.find((s) => s.tool === 'write_file');
    assert.ok(step, 'write_file step expected');
    assert.equal(step.ok, false);
    assert.ok(
      !/skipped/i.test(step.summary || ''),
      'must not report hook skip success under read-only'
    );
    assert.equal(fs.existsSync(path.join(project, 'skip-bypass.txt')), false);
  });

  it('Post runs after gate deny', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const marker = path.join(project, 'post-after-gate.marker');
    const postJs = path.join(project, '.codex', 'post-marker.js');
    // Write marker under project cwd (hooks default cwd=project)
    fs.writeFileSync(
      postJs,
      `require('fs').writeFileSync('post-after-gate.marker', 'from-post');\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PostToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [postJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    const gate = createPermissionGate({
      permissionMode: 'read-only',
      agentMode: 'agent',
      terminalEnabled: false,
      terminalRequireConfirm: false,
      onApprovalNeeded: async () => {},
    });

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_post',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'never.txt',
                content: 'x\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'denied' };
    };

    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({
        maxAgentTurns: 4,
        permissionMode: 'read-only',
      }),
      messages: [{ role: 'user', content: 'write' }],
      gate,
      sessionKey: 's-post-gate',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.equal(fs.existsSync(marker), true, 'PostToolUse should run after gate deny');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'from-post');
    assert.equal(fs.existsSync(path.join(project, 'never.txt')), false);
  });

  it('rewrite → Gate₂ deny: no file written / unauthorized', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const rewriteJs = path.join(project, '.codex', 'rewrite.js');
    fs.writeFileSync(
      rewriteJs,
      `process.stdout.write(JSON.stringify({decision:'allow',args:{path:'forbidden.txt',content:'nope\\n'}}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [rewriteJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    // Gate₁ allows original path; Gate₂ denies rewritten path.
    const base = fullAutoGate();
    const gate = {
      authorize: async (req) => {
        const p = String(req.path || '');
        if (p.includes('forbidden.txt')) {
          return { allowed: false, reason: 'gate2-deny-path' };
        }
        return base.authorize(req);
      },
    };

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_g2deny',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'ok.txt',
                content: 'should-not-land\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'denied' };
    };

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ maxAgentTurns: 4 }),
      messages: [{ role: 'user', content: 'write' }],
      gate,
      sessionKey: 's-g2-deny',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.ok(
      result.agentLog.some(
        (s) => s.tool === 'write_file' && s.ok === false && /gate2-deny-path|未授权/.test(s.summary || '')
      ),
      'expected Gate₂ deny in tool result'
    );
    assert.equal(fs.existsSync(path.join(project, 'ok.txt')), false);
    assert.equal(fs.existsSync(path.join(project, 'forbidden.txt')), false);
    assert.equal((result.applied || []).length, 0);
  });

  it('rewrite → Gate₂ allow → execute with effectiveArgs', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const rewriteJs = path.join(project, '.codex', 'rewrite-ok.js');
    fs.writeFileSync(
      rewriteJs,
      `process.stdout.write(JSON.stringify({decision:'allow',args:{path:'rewritten.txt',content:'from-hook\\n'}}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [rewriteJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_g2allow',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'original.txt',
                content: 'original\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'done' };
    };

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ maxAgentTurns: 4 }),
      messages: [{ role: 'user', content: 'write' }],
      gate: fullAutoGate(),
      sessionKey: 's-g2-allow',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.equal(fs.existsSync(path.join(project, 'original.txt')), false);
    assert.equal(fs.existsSync(path.join(project, 'rewritten.txt')), true);
    assert.equal(fs.readFileSync(path.join(project, 'rewritten.txt'), 'utf8'), 'from-hook\n');
    const step = result.agentLog.find((s) => s.tool === 'write_file');
    assert.ok(step && step.ok);
    assert.equal(step.args && step.args.path, 'rewritten.txt');
    assert.ok(
      (result.applied || []).some((a) => String(a.path || '').includes('rewritten.txt')),
      'applied should record rewritten path'
    );
  });

  it('skip side-effects: full-auto Pre skip write_file does not apply/fileChanges', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const skipJs = path.join(project, '.codex', 'skip-ok.js');
    fs.writeFileSync(
      skipJs,
      `process.stdout.write(JSON.stringify({decision:'skip',result:{ok:true,skipped:true,by:'hook',path:'skip-side.txt'}}));\n`
    );
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{
          matcher: 'write_file',
          command: process.execPath,
          args: [skipJs],
          timeoutMs: 5000,
        }],
      },
    }));
    fs.writeFileSync(path.join(project, 'package.json'), '{}');

    const events = [];
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf_skip_side',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'skip-side.txt',
                content: 'should-not-create\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: 'skipped' };
    };

    const result = await runAgentLoop({
      project: { path: project, name: 't' },
      settings: baseSettings({ maxAgentTurns: 4 }),
      messages: [{ role: 'user', content: 'write' }],
      gate: fullAutoGate(),
      onEvent: (e) => events.push(e),
      sessionKey: 's-skip-side',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn,
    });

    assert.equal(fs.existsSync(path.join(project, 'skip-side.txt')), false);
    assert.equal((result.applied || []).length, 0);
    assert.equal((result.fileChanges || []).length, 0);
    assert.equal(
      events.filter((e) => e.type === AGENT_EVENTS.FILE_CHANGE).length,
      0,
      'skip must not emit FILE_CHANGE'
    );
    const step = result.agentLog.find((s) => s.tool === 'write_file');
    assert.ok(step);
    assert.equal(step.ok, true, 'skip is a successful short-circuit for the model');
  });
});
