const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseTextToolCalls,
  executeToolFixed,
  runAgentLoop,
  TOOL_DEFS,
  toolsForSettings,
  createDefaultRegistry,
} = require('../src/ai/agent');
const { createMemoryOnlyRegistry } = require('../src/ai/providers');
const { memoryFilePath, readEntries } = require('../src/ai/memory-store');
const { createPermissionGate } = require('../src/ai/permission');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { isBlockedCommand, runTerminal } = require('../src/ai/terminal');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

function initTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}

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

  it('TOOL_DEFS includes git_status, git_diff, git_commit', () => {
    const names = TOOL_DEFS.map((t) => t.function.name);
    assert.ok(names.includes('git_status'));
    assert.ok(names.includes('git_diff'));
    assert.ok(names.includes('git_commit'));
    const commit = TOOL_DEFS.find((t) => t.function.name === 'git_commit');
    assert.ok(commit.function.parameters.required.includes('message'));
    assert.ok(commit.function.parameters.properties.paths);
  });

  it('executeToolFixed git_status / git_diff / git_commit in temp repo', {
    skip: !gitAvailable,
  }, async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');

    const ctx = {
      project: { name: 't', path: root },
      settings: { terminalEnabled: false },
      gate: fullAutoGate(),
    };

    const st = JSON.parse(await executeToolFixed('git_status', {}, ctx));
    assert.equal(st.ok, true);
    assert.ok(st.entries.some((e) => e.path === 'a.txt' || e.path.endsWith('a.txt')));

    const d = JSON.parse(await executeToolFixed('git_diff', { path: 'a.txt' }, ctx));
    assert.equal(d.ok, true);
    assert.match(d.text, /v2/);

    const c = JSON.parse(await executeToolFixed('git_commit', {
      message: 'update a via agent',
      paths: ['a.txt'],
    }, ctx));
    assert.equal(c.ok, true, c.error);
    assert.ok(c.commit);
  });

  it('runAgentLoop full-auto git_commit via mock model', {
    skip: !gitAvailable,
  }, async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello\n');
    execFileSync('git', ['add', 'note.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello world\n');

    const gate = fullAutoGate();
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_gc',
            type: 'function',
            function: {
              name: 'git_commit',
              arguments: JSON.stringify({
                message: 'agent commit note',
                paths: ['note.txt'],
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '已提交' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        agentEnabled: true,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: 'commit note' }],
      gate,
      chatFn,
      sessionKey: 'git-commit-loop',
    });

    assert.ok(result.agentLog.some((s) => s.tool === 'git_commit' && s.ok === true));
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(log, 'agent commit note');
  });

  it('confirm-writes git_commit authorize detail includes message and paths', {
    skip: !gitAvailable,
  }, async () => {
    const root = initTempRepo();
    fs.writeFileSync(path.join(root, 'x.txt'), 'a\n');
    execFileSync('git', ['add', 'x.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'x.txt'), 'b\n');

    const approvals = [];
    const gate = {
      authorize: async (p) => {
        approvals.push(p);
        return { allowed: false, reason: '用户拒绝' };
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
            id: 'call_gc_deny',
            type: 'function',
            function: {
              name: 'git_commit',
              arguments: JSON.stringify({
                message: 'should not land',
                paths: ['x.txt'],
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '已拒绝' };
    };

    await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        permissionMode: 'confirm-writes',
      },
      messages: [{ role: 'user', content: 'commit' }],
      gate,
      chatFn,
      sessionKey: 'git-commit-detail',
    });

    assert.ok(approvals.length >= 1);
    assert.equal(approvals[0].tool, 'git_commit');
    assert.equal(approvals[0].risk, 'write');
    assert.match(String(approvals[0].detail || ''), /message: should not land/);
    assert.match(String(approvals[0].detail || ''), /paths: x\.txt/);
    // deny before stage/commit: still dirty
    const st = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.match(st, /x\.txt/);
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

  it('confirm-writes search_replace deny leaves disk unchanged and approval has diff shape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-diff-deny-'));
    const filePath = path.join(root, 'a.js');
    const original = 'const x = 1;\n';
    fs.writeFileSync(filePath, original);

    const approvals = [];
    const gate = {
      authorize: async (p) => {
        approvals.push(p);
        return { allowed: false, reason: '用户拒绝' };
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
            id: 'call_sr',
            type: 'function',
            function: {
              name: 'search_replace',
              arguments: JSON.stringify({
                path: 'a.js',
                old_string: 'const x = 1;',
                new_string: 'const x = 2;',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '已拒绝' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        permissionMode: 'confirm-writes',
      },
      messages: [{ role: 'user', content: 'edit' }],
      gate,
      chatFn,
      sessionKey: 'diff-deny',
    });

    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.ok(approvals.length >= 1, 'authorize should be called');
    const payload = approvals[0];
    assert.equal(payload.tool, 'search_replace');
    assert.ok(payload.diff, 'diff payload required');
    assert.ok(payload.diff.stats && typeof payload.diff.stats.additions === 'number');
    assert.ok(
      payload.diff.isBinary === true
        || typeof payload.diff.text === 'string',
      'diff must have text or isBinary'
    );
    assert.ok(result.agentLog.some((s) => s.tool === 'search_replace' && s.ok === false));
    assert.ok(Array.isArray(result.fileChanges));
    assert.equal(result.fileChanges.length, 0);
  });

  it('confirm-writes search_replace allow applies approved preview.after content', async () => {
    // Integrity: after allow, agent writes preview.after (not re-run searchReplace).
    // TOCTOU: external file changes between preview and write are still possible.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sr-allow-'));
    const filePath = path.join(root, 'a.js');
    const original = 'const x = 1;\nconst y = 2;\n';
    fs.writeFileSync(filePath, original);

    const gate = {
      authorize: async () => ({ allowed: true }),
    };

    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_sr_allow',
            type: 'function',
            function: {
              name: 'search_replace',
              arguments: JSON.stringify({
                path: 'a.js',
                old_string: 'const x = 1;',
                new_string: 'const x = 99;',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '已修改' };
    };

    const events = [];
    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        permissionMode: 'confirm-writes',
      },
      messages: [{ role: 'user', content: 'edit' }],
      gate,
      onEvent: (e) => events.push(e),
      chatFn,
      sessionKey: 'sr-allow',
    });

    assert.equal(fs.readFileSync(filePath, 'utf8'), 'const x = 99;\nconst y = 2;\n');
    assert.ok(result.agentLog.some((s) => s.tool === 'search_replace' && s.ok === true));
    assert.ok(result.applied.some((a) => a.path === 'a.js' && a.mode === 'search_replace'));
    const types = events.map((e) => e.type);
    const fcIdx = types.findIndex(
      (t) => t === AGENT_EVENTS.FILE_CHANGE || t === 'file-change'
    );
    const teIdx = types.findIndex(
      (t) => t === AGENT_EVENTS.TOOL_END || t === 'tool-end'
    );
    assert.ok(fcIdx >= 0 && teIdx >= 0, 'FILE_CHANGE and TOOL_END expected');
    assert.ok(fcIdx < teIdx, 'FILE_CHANGE should precede TOOL_END');
  });

  it('full-auto write emits file-change and returns fileChanges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-file-change-'));
    const events = [];
    const gate = fullAutoGate();
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_wf',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'new.txt',
                content: 'hello-phase-b\n',
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '写好了' };
    };

    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        agentEnabled: true,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: 'write' }],
      gate,
      onEvent: (e) => events.push(e),
      chatFn,
      sessionKey: 'file-change',
    });

    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'hello-phase-b\n');
    const fileChangeEvents = events.filter(
      (e) => e.type === AGENT_EVENTS.FILE_CHANGE || e.type === 'file-change'
    );
    assert.ok(fileChangeEvents.length >= 1, 'FILE_CHANGE event expected');
    assert.equal(fileChangeEvents[0].path, 'new.txt');
    assert.ok(['create', 'write'].includes(fileChangeEvents[0].op));
    assert.ok(fileChangeEvents[0].stats);
    assert.ok(Array.isArray(result.fileChanges));
    assert.ok(result.fileChanges.length >= 1);
    assert.equal(result.fileChanges[0].path, 'new.txt');
    assert.ok(result.fileChanges[0].stats);
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

  it('toolsForSettings hides run_terminal when disabled', async () => {
    const off = await toolsForSettings({ terminalEnabled: false });
    assert.ok(!off.some((t) => t.function.name === 'run_terminal'));
    const on = await toolsForSettings({ terminalEnabled: true });
    assert.ok(on.some((t) => t.function.name === 'run_terminal'));
  });

  it('toolsForSettings plan exposes submit_plan not write_file', async () => {
    const plan = (await toolsForSettings({ terminalEnabled: true }, { agentMode: 'plan' }))
      .map((t) => t.function.name);
    assert.ok(plan.includes('submit_plan'));
    assert.ok(plan.includes('read_file'));
    assert.ok(plan.includes('git_status'));
    assert.ok(!plan.includes('write_file'));
    assert.ok(!plan.includes('search_replace'));
    assert.ok(!plan.includes('run_terminal'));
    assert.ok(!plan.includes('git_commit'));
    const agent = (await toolsForSettings({ terminalEnabled: false }, { agentMode: 'agent' }))
      .map((t) => t.function.name);
    assert.ok(!agent.includes('submit_plan'));
    assert.ok(agent.includes('write_file'));
  });

  it('toolsForSettings agent includes builtin reads', async () => {
    const names = (await toolsForSettings({ terminalEnabled: false }, { agentMode: 'agent' }))
      .map((t) => t.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('list_dir'));
    assert.ok(names.includes('grep'));
    assert.ok(!names.includes('run_terminal'));
  });

  it('toolsForSettings exploreReadonly filters to read-only set', async () => {
    const names = (await toolsForSettings(
      { terminalEnabled: true },
      { agentMode: 'agent', subagentDepth: 1 }
    )).map((t) => t.function.name);
    for (const n of ['list_dir', 'read_file', 'grep', 'glob', 'git_status', 'git_diff']) {
      assert.ok(names.includes(n), `expected ${n}`);
    }
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('run_terminal'));
    assert.ok(!names.includes('git_commit'));
  });

  it('toolsForSettings includes list_skills when skills enabled', async () => {
    const names = (await toolsForSettings(
      { terminalEnabled: false, skillsEnabled: true },
      { agentMode: 'agent' },
    )).map((t) => t.function.name);
    assert.ok(names.includes('list_skills'));
    assert.ok(names.includes('use_skill'));
  });

  it('toolsForSettings omits skills when disabled', async () => {
    const names = (await toolsForSettings(
      { terminalEnabled: false, skillsEnabled: false },
      { agentMode: 'agent' },
    )).map((t) => t.function.name);
    assert.ok(!names.includes('list_skills'));
  });

  it('runAgentLoop supports an unbound memory-only chat', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-only-'));
    let turn = 0;
    const chatFn = async (opts) => {
      turn += 1;
      if (turn === 1) {
        const names = (opts.tools || []).map((t) => t.function.name).sort();
        assert.deepEqual(names, ['forget', 'recall', 'remember']);
        const systemText = String((opts.messages || []).find((m) => m.role === 'system')?.content || '');
        assert.match(systemText, /未绑定本地项目目录/);
        assert.match(systemText, /只能使用本轮实际提供的非项目工具/);
        assert.equal(systemText.includes('项目根目录（真实路径）'), false);
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'remember_unbound',
            type: 'function',
            function: {
              name: 'remember',
              arguments: JSON.stringify({ text: '回答一律使用简体中文' }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '已经记住' };
    };

    const result = await runAgentLoop({
      project: null,
      settings: {
        terminalEnabled: false,
        memoryEnabled: true,
        memoryMaxEntries: 200,
        maxAgentTurns: 4,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: '以后请用中文回答' }],
      gate: fullAutoGate(),
      chatFn,
      registry: createMemoryOnlyRegistry(),
      extensions: { userDataPath },
      sessionKey: 'memory-only-unbound',
    });

    const file = memoryFilePath({ scope: 'user', userDataPath });
    const { entries } = readEntries(file, 'user');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, '回答一律使用简体中文');
    assert.match(result.content, /已经记住/);
  });

  it('unbound chats reject a project-capable registry', async () => {
    await assert.rejects(
      () => runAgentLoop({
        project: null,
        settings: { terminalEnabled: false, maxAgentTurns: 1 },
        messages: [{ role: 'user', content: 'hi' }],
        gate: fullAutoGate(),
        chatFn: async () => ({ role: 'assistant', content: 'nope' }),
        registry: createDefaultRegistry(),
        sessionKey: 'unsafe-unbound-registry',
      }),
      /项目目录|memory-only|记忆专用/,
    );
  });

  it('memory write approval summaries preview remember text and forget id', async () => {
    const approvals = [];
    const rawText = `  ${'x'.repeat(40)}   ${'y'.repeat(39)}Z_FORBIDDEN  `;
    const expectedPreview = `${'x'.repeat(40)} ${'y'.repeat(39)}`;
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'remember_preview',
            type: 'function',
            function: { name: 'remember', arguments: JSON.stringify({ text: rawText }) },
          }],
        };
      }
      if (turn === 2) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'forget_preview',
            type: 'function',
            function: { name: 'forget', arguments: JSON.stringify({ id: 'm_forget_123' }) },
          }],
        };
      }
      return { role: 'assistant', content: '未写入' };
    };

    await runAgentLoop({
      project: null,
      settings: {
        terminalEnabled: false,
        hooksEnabled: false,
        verifyBeforeDone: false,
        memoryEnabled: true,
        maxAgentTurns: 4,
        permissionMode: 'confirm-writes',
      },
      messages: [{ role: 'user', content: '记住一条很长的事实' }],
      gate: {
        authorize: async (request) => {
          approvals.push(request);
          return { allowed: false, reason: 'test deny' };
        },
      },
      chatFn,
      registry: createMemoryOnlyRegistry(),
      extensions: { userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-preview-')) },
      sessionKey: 'memory-preview',
    });

    assert.equal(approvals.length, 2);
    assert.equal(approvals[0].tool, 'remember');
    assert.ok(String(approvals[0].summary).includes(expectedPreview));
    assert.equal(String(approvals[0].summary).includes('Z_FORBIDDEN'), false);
    assert.equal(approvals[1].tool, 'forget');
    assert.match(String(approvals[1].summary), /m_forget_123/);
  });

  it('plan mode submit_plan emits plan-ready', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plan-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'x\n');
    const events = [];
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'c1',
            type: 'function',
            function: {
              name: 'submit_plan',
              arguments: JSON.stringify({
                title: '改 a',
                markdown: '1. 修改 a.js\n2. 跑测试\n3. 完成目标说明',
                steps: ['改 a', '测试'],
              }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '计划已交，等待批准' };
    };
    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: '规划一下' }],
      gate: createPermissionGate({
        permissionMode: 'full-auto',
        agentMode: 'plan',
        terminalEnabled: false,
        onApprovalNeeded: async () => {},
      }),
      agentMode: 'plan',
      onEvent: (e) => events.push(e),
      chatFn,
      sessionKey: 'plan1',
    });
    assert.ok(events.some((e) => e.type === AGENT_EVENTS.PLAN_READY || e.type === 'plan-ready'));
    const ready = events.find((e) => e.type === AGENT_EVENTS.PLAN_READY || e.type === 'plan-ready');
    assert.ok(ready.planId);
    assert.match(String(ready.markdown || ''), /修改 a\.js/);
    assert.match(result.content, /计划|批准/);
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'x\n');
  });

  it('plan mode write_file tool_call does not write disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plan-write-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'original\n');
    let turn = 0;
    const chatFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'cw',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.js', content: 'HACKED\n' }),
            },
          }],
        };
      }
      return { role: 'assistant', content: '无法写入' };
    };
    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: false,
        maxAgentTurns: 4,
        permissionMode: 'full-auto',
      },
      messages: [{ role: 'user', content: '改文件' }],
      gate: createPermissionGate({
        permissionMode: 'full-auto',
        agentMode: 'plan',
        terminalEnabled: false,
        onApprovalNeeded: async () => {},
      }),
      agentMode: 'plan',
      chatFn,
      sessionKey: 'plan-write',
    });
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'original\n');
    // write_file is not registered in plan tools; text protocol / unexpected name should fail authorize or unknown
    const writeSteps = result.agentLog.filter((s) => s.tool === 'write_file');
    if (writeSteps.length) {
      assert.ok(writeSteps.every((s) => s.ok === false));
    }
  });

  it('after write, prompts verify before done when verifyCommand set', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-verify-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'v1\n');
    const events = [];
    let turn = 0;
    const chatFn = async (opts) => {
      turn += 1;
      // After write, model tries to finish; loop should inject verify prompt and call again
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'cw',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.js', content: 'v2\n' }),
            },
          }],
        };
      }
      if (turn === 2) {
        // first final without terminal → should be prompted and continue
        return { role: 'assistant', content: '改完了' };
      }
      // After soft-verify user prompt, model answers without running terminal
      return { role: 'assistant', content: '跳过验证说明' };
    };
    const result = await runAgentLoop({
      project: { name: 't', path: root },
      settings: {
        terminalEnabled: true,
        maxAgentTurns: 8,
        permissionMode: 'full-auto',
        verifyCommand: 'npm test',
        verifyBeforeDone: true,
        terminalRequireConfirm: false,
      },
      messages: [{ role: 'user', content: '改 a' }],
      gate: createPermissionGate({
        permissionMode: 'full-auto',
        terminalEnabled: true,
        terminalRequireConfirm: false,
        agentMode: 'agent',
        onApprovalNeeded: async () => {},
      }),
      agentMode: 'agent',
      onEvent: (e) => events.push(e),
      chatFn,
      sessionKey: 'verify1',
    });
    assert.ok(turn >= 3, 'expected verify soft-gate extra turn, turns=' + turn);
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'v2\n');
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.VERIFY_RESULT || e.type === 'verify-result'),
      'expected verify-result event',
    );
    assert.match(result.content, /改完了|跳过|验证/);
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
