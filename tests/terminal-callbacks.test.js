const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runTerminal } = require('../src/ai/terminal');
const { executeToolFixed } = require('../src/ai/agent');
const { createPermissionGate } = require('../src/ai/permission');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

function hasPowerShell() {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
  return !(probe.error || probe.status === null);
}

describe('terminal chunk callbacks', () => {
  it('runTerminal accepts onStdout/onStderr options without throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-cb-opts-'));
    // Even if powershell is missing, spawn error path should resolve (not throw)
    // and optional callbacks must be tolerated when no data arrives.
    let stdoutCalls = 0;
    let stderrCalls = 0;
    const r = await runTerminal(root, 'Write-Output "opt-ok"', {
      timeoutMs: 5000,
      onStdout: () => { stdoutCalls += 1; },
      onStderr: () => { stderrCalls += 1; },
    });
    assert.ok(r && typeof r === 'object');
    assert.ok('ok' in r);
    assert.ok('stdout' in r);
    // callbacks only fire on data; count is non-negative regardless of host
    assert.ok(stdoutCalls >= 0);
    assert.ok(stderrCalls >= 0);
  });

  it('runTerminal invokes onStdout when available', async (t) => {
    if (!hasPowerShell()) {
      t.skip('powershell.exe not available on this host');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-cb-'));
    const chunks = [];
    const r = await runTerminal(root, 'Write-Output "hello-chunk"', {
      timeoutMs: 15000,
      onStdout: (chunk) => { chunks.push(String(chunk)); },
    });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /hello-chunk/);
    assert.ok(chunks.length >= 1, 'onStdout should receive at least one chunk');
    assert.match(chunks.join(''), /hello-chunk/);
  });
});

describe('agent run_terminal terminal events', () => {
  it('executeToolFixed emits TERMINAL_START/END with source agent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-ev-'));
    const events = [];
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      terminalEnabled: true,
      terminalRequireConfirm: false,
      onApprovalNeeded: async () => {},
    });
    const resultStr = await executeToolFixed('run_terminal', {
      command: hasPowerShell() ? 'Write-Output "agent-term"' : 'Write-Output "agent-term"',
    }, {
      project: { name: 't', path: root },
      settings: { terminalEnabled: true, terminalTimeoutMs: 15000 },
      gate,
      onEvent: (e) => events.push(e),
    });

    const parsed = JSON.parse(resultStr);
    assert.ok(parsed && typeof parsed === 'object');

    const types = events.map((e) => e.type);
    assert.ok(types.includes(AGENT_EVENTS.TERMINAL_START), 'TERMINAL_START expected');
    assert.ok(types.includes(AGENT_EVENTS.TERMINAL_END), 'TERMINAL_END expected');

    const start = events.find((e) => e.type === AGENT_EVENTS.TERMINAL_START);
    assert.ok(start.termId);
    assert.match(String(start.termId), /^term_/);
    assert.equal(start.source, 'agent');
    assert.equal(start.command, 'Write-Output "agent-term"');
    assert.equal(start.cwd, root);

    const end = events.find((e) => e.type === AGENT_EVENTS.TERMINAL_END);
    assert.equal(end.termId, start.termId);
    assert.equal(end.ok, parsed.ok);
    assert.equal(end.code, parsed.code);
    assert.equal(end.summary, `exit=${parsed.code}`);
    assert.ok('timedOut' in end);
    assert.ok('aborted' in end);

    if (hasPowerShell() && parsed.ok) {
      const outs = events.filter((e) => e.type === AGENT_EVENTS.TERMINAL_OUTPUT);
      assert.ok(outs.some((e) => e.stream === 'stdout' && /agent-term/.test(e.chunk)));
      for (const o of outs) {
        assert.equal(o.termId, start.termId);
      }
    }
  });

  it('emits TERMINAL_END even when runTerminal throws (blocked command)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-term-block-'));
    const events = [];
    const resultStr = await executeToolFixed('run_terminal', {
      command: 'rm -rf /',
    }, {
      project: { name: 't', path: root },
      settings: { terminalEnabled: true, terminalTimeoutMs: 5000 },
      onEvent: (e) => events.push(e),
    });
    const parsed = JSON.parse(resultStr);
    assert.equal(parsed.ok, false);
    assert.match(String(parsed.error || ''), /拦截|安全/);

    const types = events.map((e) => e.type);
    assert.ok(types.includes(AGENT_EVENTS.TERMINAL_START));
    assert.ok(types.includes(AGENT_EVENTS.TERMINAL_END));
    const start = events.find((e) => e.type === AGENT_EVENTS.TERMINAL_START);
    const end = events.find((e) => e.type === AGENT_EVENTS.TERMINAL_END);
    assert.equal(end.termId, start.termId);
    assert.equal(end.ok, false);
    assert.ok(String(end.summary || '').length > 0);
  });
});
