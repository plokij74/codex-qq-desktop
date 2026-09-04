const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPermissionGate,
  riskForTool,
  clearSessionAllows,
  getSessionAllows,
} = require('../src/ai/permission');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

describe('permission', () => {
  beforeEach(() => {
    // Module-level session memory survives gate instances; isolate tests.
    clearSessionAllows();
  });

  it('riskForTool maps tools', () => {
    assert.equal(riskForTool('grep'), 'read');
    assert.equal(riskForTool('search_replace'), 'write');
    assert.equal(riskForTool('delete_path'), 'delete');
    assert.equal(riskForTool('run_terminal'), 'terminal');
  });

  it('riskForTool classifies git tools', () => {
    assert.equal(riskForTool('git_status'), 'read');
    assert.equal(riskForTool('git_diff'), 'read');
    assert.equal(riskForTool('git_commit'), 'write');
  });

  it('riskForTool submit_plan is read', () => {
    assert.equal(riskForTool('submit_plan'), 'read');
  });

  it('riskForTool maps skills and spawn_explore to read', () => {
    assert.equal(riskForTool('list_skills'), 'read');
    assert.equal(riskForTool('use_skill'), 'read');
    assert.equal(riskForTool('spawn_explore'), 'read');
  });

  it('riskForTool run_skill is write', () => {
    assert.equal(riskForTool('run_skill'), 'write');
  });

  it('spawn_implement is write risk; spawn_explores is read', () => {
    assert.equal(riskForTool('spawn_implement'), 'write');
    assert.equal(riskForTool('spawn_explores'), 'read');
    assert.equal(riskForTool('spawn_explore'), 'read');
  });

  it('riskForTool maps mcp_ prefix to mcp', () => {
    assert.equal(riskForTool('mcp_git_status'), 'mcp');
    assert.equal(riskForTool('mcp_server_tool_name'), 'mcp');
  });

  it('plan mode denies mcp risk even in full-auto', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      agentMode: 'plan',
      onApprovalNeeded: async () => {},
    });
    const r = await gate.authorize({ tool: 'mcp_x_y', risk: 'mcp', sessionKey: 's' });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /计划模式/);
  });

  it('confirm-writes treats mcp like write (needs approval)', async () => {
    let called = false;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      agentMode: 'agent',
      onApprovalNeeded: async (p) => {
        called = true;
        gate.resolveApproval(p.approvalId, 'allow');
      },
    });
    const r = await gate.authorize({ tool: 'mcp_a_b', risk: 'mcp', sessionKey: 's-mcp' });
    assert.equal(r.allowed, true);
    assert.equal(called, true);
  });

  it('plan mode denies write even in full-auto', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      terminalEnabled: true,
      agentMode: 'plan',
      onApprovalNeeded: async () => {},
    });
    const r = await gate.authorize({ tool: 'write_file', risk: 'write', sessionKey: 's' });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /计划模式/);
  });

  it('plan mode allows read', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      agentMode: 'plan',
      onApprovalNeeded: async () => {},
    });
    const r = await gate.authorize({ tool: 'read_file', risk: 'read', sessionKey: 's' });
    assert.equal(r.allowed, true);
  });

  it('per-call agentMode plan overrides gate default agent', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      agentMode: 'agent',
      onApprovalNeeded: async () => {},
    });
    const r = await gate.authorize({
      tool: 'write_file', risk: 'write', sessionKey: 's', agentMode: 'plan',
    });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /计划模式/);
  });

  it('AGENT_EVENTS includes Phase B event names', () => {
    assert.equal(AGENT_EVENTS.FILE_CHANGE, 'file-change');
    assert.equal(AGENT_EVENTS.TERMINAL_START, 'terminal-start');
    assert.equal(AGENT_EVENTS.TERMINAL_OUTPUT, 'terminal-output');
    assert.equal(AGENT_EVENTS.TERMINAL_END, 'terminal-end');
  });

  it('read-only denies write', async () => {
    const gate = createPermissionGate({
      permissionMode: 'read-only',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { throw new Error('should not approve'); },
    });
    const r = await gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1',
    });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /只读|read-only|不允许/i);
  });

  it('confirm-writes auto-allows read', async () => {
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: false,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { throw new Error('no'); },
    });
    const r = await gate.authorize({ tool: 'grep', risk: 'read', summary: 'g', sessionKey: 's1' });
    assert.equal(r.allowed, true);
  });

  it('confirm-writes waits for allow', async () => {
    let pendingId;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate.authorize({
      tool: 'search_replace', risk: 'write', summary: 'edit', path: 'a.js', sessionKey: 's1',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(pendingId);
    gate.resolveApproval(pendingId, 'allow');
    const r = await p;
    assert.equal(r.allowed, true);
  });

  it('onApprovalNeeded receives diff when provided', async () => {
    let payload;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { payload = p; },
    });
    const diff = { path: 'a.js', before: 'old', after: 'new' };
    const p = gate.authorize({
      tool: 'search_replace',
      risk: 'write',
      summary: 'edit',
      path: 'a.js',
      sessionKey: 's1',
      diff,
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(payload);
    assert.deepEqual(payload.diff, diff);
    assert.equal(payload.path, 'a.js');
    assert.equal(payload.tool, 'search_replace');
    gate.resolveApproval(payload.approvalId, 'allow');
    assert.equal((await p).allowed, true);
  });

  it('allow_session skips later same risk', async () => {
    const ids = [];
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { ids.push(p.approvalId); },
    });
    const p1 = gate.authorize({ tool: 'write_file', risk: 'write', summary: '1', sessionKey: 's1' });
    await new Promise((r) => setImmediate(r));
    gate.resolveApproval(ids[0], 'allow_session');
    assert.equal((await p1).allowed, true);
    const r2 = await gate.authorize({ tool: 'write_file', risk: 'write', summary: '2', sessionKey: 's1' });
    assert.equal(r2.allowed, true);
    assert.equal(ids.length, 1);
  });

  it('abort during approval throws ABORTED', async () => {
    const ac = new AbortController();
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => {},
    });
    const p = gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'x', sessionKey: 's1', signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(p, (err) => err.code === 'ABORTED' && err.message === '已停止');
  });

  it('full-auto allows write without onApprovalNeeded', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      terminalEnabled: true,
      terminalRequireConfirm: false,
      onApprovalNeeded: async () => { throw new Error('should not approve'); },
    });
    const r = await gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1',
    });
    assert.equal(r.allowed, true);
  });

  it('confirm-writes terminalEnabled false denies run_terminal without approval', async () => {
    let called = false;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: false,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { called = true; },
    });
    const r = await gate.authorize({
      tool: 'run_terminal', risk: 'terminal', summary: 'ls', sessionKey: 's1',
    });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /终端|未启用|不允许/i);
    assert.equal(called, false);
  });

  it('cancelPending rejects detached background approvals', async () => {
    let requested = false;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      onApprovalNeeded: async () => { requested = true; },
    });
    const pending = gate.authorize({ tool: 'verification_start', risk: 'terminal' });
    while (!requested) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(gate.cancelPending('窗口已关闭'), 1);
    await assert.rejects(pending, (error) => error.code === 'ABORTED' && error.message === '窗口已关闭');
    assert.equal(gate.cancelPending(), 0);
  });

  it('verification_start always asks for first approval even in full-auto', async () => {
    let called = 0;
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      terminalEnabled: true,
      terminalRequireConfirm: false,
      onApprovalNeeded: async (payload) => {
        called += 1;
        gate.resolveApproval(payload.approvalId, 'allow');
      },
    });
    const result = await gate.authorize({
      tool: 'verification_start',
      risk: 'terminal',
      summary: 'run saved tests',
      sessionKey: 'verification-session',
    });
    assert.equal(result.allowed, true);
    assert.equal(called, 1);
  });

  it('resolveApproval deny returns allowed false with Chinese reason', async () => {
    let pendingId;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(pendingId);
    gate.resolveApproval(pendingId, 'deny');
    const r = await p;
    assert.equal(r.allowed, false);
    assert.equal(r.reason, '用户拒绝');
  });

  it('full-auto with terminalRequireConfirm still needs approval for terminal', async () => {
    let pendingId;
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate.authorize({
      tool: 'run_terminal', risk: 'terminal', summary: 'ls', sessionKey: 's1',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(pendingId, 'should request approval for terminal');
    gate.resolveApproval(pendingId, 'allow');
    const r = await p;
    assert.equal(r.allowed, true);
  });

  it('resolveApproval returns true when pending, false when missing', async () => {
    let pendingId;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(pendingId);
    assert.equal(gate.resolveApproval('missing-id', 'allow'), false);
    assert.equal(gate.resolveApproval(pendingId, 'allow'), true);
    assert.equal(gate.resolveApproval(pendingId, 'allow'), false);
    assert.equal((await p).allowed, true);
  });

  it('onApprovalNeeded throw cleans pending and rethrows', async () => {
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { throw new Error('ui failed'); },
    });
    await assert.rejects(
      gate.authorize({ tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1' }),
      (err) => err.message === 'ui failed',
    );
    // Second authorize should still work (no stuck pending / no leak side effects)
    let pendingId;
    const gate2 = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate2.authorize({ tool: 'write_file', risk: 'write', summary: 'w2', sessionKey: 's1' });
    await new Promise((r) => setImmediate(r));
    gate2.resolveApproval(pendingId, 'allow');
    assert.equal((await p).allowed, true);
  });

  it('allow_session is shared across gate instances with same sessionKey', async () => {
    let called = 0;
    const gate1 = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => {
        called += 1;
        gate1.resolveApproval(p.approvalId, 'allow_session');
      },
    });
    const r1 = await gate1.authorize({
      tool: 'write_file', risk: 'write', summary: '1', sessionKey: 'shared-sess',
    });
    assert.equal(r1.allowed, true);
    assert.equal(called, 1);
    assert.ok(getSessionAllows('shared-sess').has('write'));

    let called2 = 0;
    const gate2 = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { called2 += 1; },
    });
    const r2 = await gate2.authorize({
      tool: 'search_replace', risk: 'write', summary: '2', sessionKey: 'shared-sess',
    });
    assert.equal(r2.allowed, true);
    assert.equal(called2, 0, 'second gate must not prompt when session already allows write');

    // Different session still prompts
    let called3 = 0;
    let pendingId;
    const gate3 = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      onApprovalNeeded: async (p) => {
        called3 += 1;
        pendingId = p.approvalId;
      },
    });
    const p3 = gate3.authorize({
      tool: 'write_file', risk: 'write', summary: '3', sessionKey: 'other-sess',
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(called3, 1);
    gate3.resolveApproval(pendingId, 'allow');
    assert.equal((await p3).allowed, true);

    clearSessionAllows('shared-sess');
    assert.equal(getSessionAllows('shared-sess').size, 0);
  });

  it('riskForTool maps Phase D.2 memory tools', () => {
    assert.equal(riskForTool('recall'), 'read');
    assert.equal(riskForTool('remember'), 'write');
    assert.equal(riskForTool('forget'), 'write');
  });

  it('read-only mode allows recall but refuses remember and forget', async () => {
    const gate = createPermissionGate({ permissionMode: 'read-only' });
    assert.equal((await gate.authorize({ tool: 'recall' })).allowed, true);
    const w = await gate.authorize({ tool: 'remember' });
    assert.equal(w.allowed, false);
    assert.match(w.reason, /只读模式/);
    assert.equal((await gate.authorize({ tool: 'forget' })).allowed, false);
  });

  it('plan mode blocks remember and forget at the second gate', async () => {
    const gate = createPermissionGate({ permissionMode: 'full-auto', agentMode: 'plan' });
    assert.equal((await gate.authorize({ tool: 'recall' })).allowed, true);
    const r = await gate.authorize({ tool: 'remember' });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /计划模式/);
    const f = await gate.authorize({ tool: 'forget' });
    assert.equal(f.allowed, false);
    assert.match(f.reason, /计划模式/);
  });
});

describe('D.3 network risk', () => {
  beforeEach(() => {
    clearSessionAllows();
  });

  it('classifies web_fetch as network', () => {
    assert.equal(riskForTool('web_fetch'), 'network');
  });

  it('denies when webEnabled is false, regardless of permission mode', async () => {
    for (const permissionMode of ['read-only', 'confirm-writes', 'full-auto']) {
      const gate = createPermissionGate({ permissionMode, webEnabled: false });
      const r = await gate.authorize({ tool: 'web_fetch', scope: 'example.com' });
      assert.equal(r.allowed, false, permissionMode);
      assert.match(r.reason, /网页访问未启用/);
    }
  });

  it('requires approval in read-only mode instead of auto-deny', async () => {
    let asked = null;
    const gate = createPermissionGate({
      permissionMode: 'read-only',
      webEnabled: true,
      onApprovalNeeded: async (p) => {
        asked = p;
        gate.resolveApproval(p.approvalId, 'allow');
      },
    });
    const r = await gate.authorize({
      tool: 'web_fetch',
      scope: 'example.com',
      summary: '读取网页 example.com',
    });
    assert.equal(r.allowed, true);
    assert.equal(asked.risk, 'network');
    assert.equal(asked.scope, 'example.com');
  });

  it('full-auto with webRequireConfirm=false allows directly', async () => {
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      webEnabled: true,
      webRequireConfirm: false,
      onApprovalNeeded: async () => { throw new Error('不应弹审批'); },
    });
    const r = await gate.authorize({ tool: 'web_fetch', scope: 'example.com' });
    assert.equal(r.allowed, true);
  });

  it('full-auto with webRequireConfirm=true still asks', async () => {
    let asked = false;
    const gate = createPermissionGate({
      permissionMode: 'full-auto',
      webEnabled: true,
      webRequireConfirm: true,
      onApprovalNeeded: async (p) => {
        asked = true;
        gate.resolveApproval(p.approvalId, 'deny');
      },
    });
    const r = await gate.authorize({ tool: 'web_fetch', scope: 'example.com' });
    assert.equal(asked, true);
    assert.equal(r.allowed, false);
  });

  it('allow_session is scoped per host: example.com does not unlock evil.com', async () => {
    let asks = 0;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      webEnabled: true,
      onApprovalNeeded: async (p) => {
        asks += 1;
        gate.resolveApproval(p.approvalId, 'allow_session');
      },
    });
    const sessionKey = 'sess-net-1';
    await gate.authorize({ tool: 'web_fetch', scope: 'example.com', sessionKey });
    const again = await gate.authorize({ tool: 'web_fetch', scope: 'example.com', sessionKey });
    assert.equal(again.allowed, true);
    assert.equal(asks, 1);
    await gate.authorize({ tool: 'web_fetch', scope: 'evil.com', sessionKey });
    assert.equal(asks, 2);
  });

  it('plan mode does not block network', async () => {
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      webEnabled: true,
      agentMode: 'plan',
      onApprovalNeeded: async (p) => gate.resolveApproval(p.approvalId, 'allow'),
    });
    const r = await gate.authorize({ tool: 'web_fetch', scope: 'example.com' });
    assert.equal(r.allowed, true);
  });

  it('unscoped write allow_session keeps the bare risk key', async () => {
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      onApprovalNeeded: async (p) => gate.resolveApproval(p.approvalId, 'allow_session'),
    });
    const sessionKey = 'sess-w-1';
    await gate.authorize({ tool: 'write_file', sessionKey });
    assert.ok(getSessionAllows(sessionKey).has('write'));
  });
});
