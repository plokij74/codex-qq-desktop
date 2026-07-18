const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseTextToolCalls,
  executeToolFixed,
  runAgentLoop,
  TOOL_DEFS,
  toolsForSettings,
} = require('../src/ai/agent');
const { createPermissionGate } = require('../src/ai/permission');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { isBlockedCommand, runTerminal } = require('../src/ai/terminal');

function fullAutoGate(extra = {}) {
  return createPermissionGate({
    permissionMode: 'full-auto',
    terminalEnabled: false,
    terminalRequireConfirm: false,
    onApprovalNeeded: async () => {},
    ...extra,
  });
}

describe('agent tools', () => {
  it('parseTextToolCalls extracts fenced tools', () => {
    const text = '先看目录\n```tool list_dir\n{"path":"."}\n```\n';
    const calls = parseTextToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'list_dir');
  });

  it('TOOL_DEFS includes grep, glob, search_replace and read_file offset/limit', () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    assert.ok(names.includes('grep'));
    assert.ok(names.includes('glob'));
    assert.ok(names.includes('search_replace'));
    const read = TOOL_DEFS.find((t) => t.function.name === 'read_file');
    assert.ok(read.function.parameters.properties.offset);
    assert.ok(read.function.parameters.properties.limit);
  });

  it('executeToolFixed list_dir and write_file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
    const ctx = {
      project: { name: 't', path: root },
      settings: { terminalEnabled: false },
      gate: fullAutoGate(),
    };
    const listed = JSON.parse(await executeToolFixed('list_dir', { path: '.' }, ctx));
    assert.equal(listed.ok, true);
    assert.match(listed.tree, /a\.txt/);

    const written = JSON.parse(await executeToolFixed('write_file', { path: 'b.txt', content: 'x' }, ctx));
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'x');
  });

  it('executeToolFixed search_replace and grep', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
    const gate = fullAutoGate();
    const ctx = { project: { name: 't', path: root }, settings: { terminalEnabled: false }, gate };
    const g = JSON.parse(await executeToolFixed('grep', { pattern: 'const x' }, ctx));
    assert.equal(g.ok, true);
    assert.ok(Array.isArray(g.matches));
    assert.ok(g.matches.some((m) => m.path === 'a.js' || m.path.endsWith('a.js')));

    const s = JSON.parse(await executeToolFixed('search_replace', {
      path: 'a.js',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    }, ctx));
    assert.equal(s.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const x = 2;\n');
  });

  it('executeToolFixed glob and read_file offset/limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'line1\nline2\nline3\n');
    const ctx = {
      project: { name: 't', path: root },
      settings: { terminalEnabled: false },
      gate: fullAutoGate(),
    };
    const gl = JSON.parse(await executeToolFixed('glob', { pattern: '**/*.js' }, ctx));
    assert.equal(gl.ok, true);
    assert.ok(gl.files.some((f) => f.replace(/\\/g, '/').endsWith('src/a.js') || f === 'src/a.js'));

    const rd = JSON.parse(await executeToolFixed('read_file', {
      path: 'src/a.js',
      offset: 2,
      limit: 1,
    }, ctx));
    assert.equal(rd.ok, true);
    assert.match(rd.content, /2\|line2/);
  });

  it('runAgentLoop emits tool events with mock model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
    const gate = fullAutoGate();
    const events = [];
    let turn = 0;
    const chatFn = async (opts) => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'grep',
              arguments: JSON.stringify({ pattern: 'const x' }),
            },
          }],
        };
      }
      if (opts.stream && typeof opts.onDelta === 'function') {
        opts.onDelta({ text: '找到了 const x' });
      }
      return { role: 'assistant', content: '找到了 const x' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 8,
        agentEnabled: true,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: 'grep const x' }],
      gate,
      onEvent: (e) => events.push(e),
      chatFn,
      sessionKey: 's1',
    });

    assert.equal(result.toolsSupported, true);
    assert.ok(result.agentLog.length >= 1);
    assert.equal(result.agentLog[0].tool, 'grep');
    assert.ok(result.agentLog[0].ok);
    assert.match(result.content, /找到了 const x/);

    const types = events.map((e) => e.type);
    assert.ok(types.includes(AGENT_EVENTS.TOOL_START) || types.includes('tool-start'));
    assert.ok(types.includes(AGENT_EVENTS.TOOL_END) || types.includes('tool-end'));
    assert.ok(types.includes(AGENT_EVENTS.TEXT_DELTA) || types.includes('text-delta'));
  });

  it('runAgentLoop denies write when gate rejects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deny-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
    const gate = createPermissionGate({
      permissionMode: 'read-only',
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
            id: 'call_w',
            type: 'function',
            function: {
              name: 'search_replace',
              arguments: JSON.stringify({
                path: 'a.js',
                old_string: 'const x = 1;',
                new_string: 'const x = 9;',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '无法修改' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: { terminalEnabled: false, maxAgentTurns: 4, permissionMode: 'read-only' },
      messages: [{ role: 'user', content: 'edit' }],
      gate,
      chatFn,
      sessionKey: 's2',
    });

    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const x = 1;\n');
    assert.ok(result.agentLog.some((s) => s.tool === 'search_replace' && s.ok === false));
  });

  it('write fence deny does not claim 已写入 and does not write disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fence-deny-'));
    const target = path.join(root, 'secret.txt');
    assert.equal(fs.existsSync(target), false);

    const gate = createPermissionGate({
      permissionMode: 'read-only',
      terminalEnabled: false,
      terminalRequireConfirm: false,
      onApprovalNeeded: async () => {},
    });

    const chatFn = async () => ({
      role: 'assistant',
      content: '将写入：\n```write:secret.txt\nshould-not-land\n```\n完成',
    });

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: { terminalEnabled: false, maxAgentTurns: 2, permissionMode: 'read-only' },
      messages: [{ role: 'user', content: 'write fence' }],
      gate,
      chatFn,
      sessionKey: 'fence-deny',
    });

    assert.equal(fs.existsSync(target), false);
    assert.ok(!/✅\s*已写入/.test(result.content), 'must not claim write success on deny');
    assert.match(result.content, /未写入|未授权/);
    assert.ok(result.applied.some((a) => a.path === 'secret.txt' && a.ok === false));
  });

  it('abort after TOOL_START emits TOOL_END before throw', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-abort-tool-'));
    const events = [];
    const abortErr = new Error('已停止');
    abortErr.code = 'ABORTED';
    const gate = {
      authorize: async () => {
        throw abortErr;
      },
    };
    const chatFn = async () => ({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_abort',
        type: 'function',
        function: {
          name: 'list_dir',
          arguments: JSON.stringify({ path: '.' }),
        },
      }],
    });

    await assert.rejects(
      () => runAgentLoop({
        project: { name: 't', path: root },
        settings: { terminalEnabled: false, maxAgentTurns: 2, permissionMode: 'full-auto' },
        messages: [{ role: 'user', content: 'list' }],
        gate,
        onEvent: (e) => events.push(e),
        chatFn,
        sessionKey: 'abort-tool',
      }),
      (err) => err.code === 'ABORTED'
    );

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf(AGENT_EVENTS.TOOL_START);
    const endIdx = types.indexOf(AGENT_EVENTS.TOOL_END);
    assert.ok(startIdx >= 0, 'TOOL_START expected');
    assert.ok(endIdx >= 0, 'TOOL_END expected after abort');
    assert.ok(endIdx > startIdx, 'TOOL_END must follow TOOL_START');
    const end = events[endIdx];
    assert.equal(end.ok, false);
    assert.match(String(end.summary || ''), /已停止|停止|abort/i);
  });

  it('stream fallback after partial delta does not re-emit full content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stream-fb-'));
    const textDeltas = [];
    let streamAttempt = 0;
    const chatFn = async (opts) => {
      if (opts.stream) {
        streamAttempt += 1;
        if (typeof opts.onDelta === 'function') {
          opts.onDelta({ text: 'partial-' });
        }
        const err = new Error('SSE parse failed mid-stream');
        throw err;
      }
      return { role: 'assistant', content: 'partial-full-answer' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: { terminalEnabled: false, maxAgentTurns: 2, permissionMode: 'full-auto' },
      messages: [{ role: 'user', content: 'hi' }],
      gate: fullAutoGate(),
      onEvent: (e) => {
        if (e.type === AGENT_EVENTS.TEXT_DELTA || e.type === 'text-delta') {
          textDeltas.push(e.text);
        }
      },
      chatFn,
      sessionKey: 'stream-fb',
    });

    assert.equal(streamAttempt, 1);
    // Partial stream delta only; full content must not be re-emitted as another TEXT_DELTA
    assert.deepEqual(textDeltas, ['partial-']);
    assert.match(result.content, /partial-full-answer/);
  });

  it('toolsForSettings hides run_terminal when disabled', () => {
    const off = toolsForSettings({ terminalEnabled: false });
    assert.ok(!off.some((t) => t.function.name === 'run_terminal'));
    const on = toolsForSettings({ terminalEnabled: true });
    assert.ok(on.some((t) => t.function.name === 'run_terminal'));
  });

  it('blocks dangerous terminal patterns', () => {
    assert.equal(isBlockedCommand('rm -rf /'), true);
    assert.equal(isBlockedCommand('npm test'), false);
  });

  it('runTerminal executes in project dir', async (t) => {
    // Product shell is PowerShell (Windows). Skip when powershell.exe is unavailable (e.g. Linux CI).
    const { spawnSync } = require('child_process');
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (probe.error || probe.status === null) {
      t.skip('powershell.exe not available on this host');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-'));
    const r = await runTerminal(root, 'Write-Output "hello-agent"', { timeoutMs: 15000 });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /hello-agent/);
  });
});
