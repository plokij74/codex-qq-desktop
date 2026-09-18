'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPermissionGate, getSessionAllows } = require('../src/ai/permission');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { toolsForSettings } = require('../src/ai/agent');

it('D14 remote mutation rejects session grants and always prompts in full-auto', async () => {
  const pending = [];
  const gate = createPermissionGate({ permissionMode: 'full-auto', onApprovalNeeded: (event) => pending.push(event) });
  const request = () => gate.authorize({ tool: 'remote_ci_rerun', risk: 'remote-mutation', sessionKey: 'd14-test' });
  const first = request();
  gate.resolveApproval(pending[0].approvalId, 'allow_session');
  assert.equal((await first).allowed, false);
  assert.equal(getSessionAllows('d14-test').size, 0);
  const second = request();
  gate.resolveApproval(pending[1].approvalId, 'allow');
  assert.equal((await second).allowed, true);
  const third = request();
  gate.resolveApproval(pending[2].approvalId, 'deny');
  assert.equal((await third).allowed, false);
  assert.equal(pending.length, 3);
});

it('D14 IPC enforces sender ownership, rejects injected authority, and invalidates pending mutation on unbind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d14-ipc-'));
  const owner = { sender: { id: 1, isDestroyed: () => false } };
  const token = 'pb_' + 'a'.repeat(32);
  let resume;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const calls = [];
  const handlers = createEngineeringIpcHandlers({ remoteCiManager: {
    failures: async (...args) => { calls.push(args); return { ok: true }; },
    rerun: async (_root, _ref, context) => {
      started();
      await new Promise((resolve) => { resume = resolve; });
      return { ok: context.isCurrent() };
    },
  } });
  try {
    handlers.bind(owner, { projectBindingId: token, projectPath: root });
    assert.equal((await handlers.remoteCiFailures({ sender: { id: 2 } }, { projectBindingId: token, prNumber: 7 })).ok, false);
    for (const key of ['repo', 'projectPath', 'sha', 'log', 'refspec', 'approval', 'jobId', 'url']) {
      assert.equal((await handlers.remoteCiFailures(owner, { projectBindingId: token, prNumber: 7, [key]: 'injected' })).code, 'REMOTE_CI_INVALID');
    }
    assert.equal(calls.length, 0);
    assert.equal((await handlers.remoteCiFailures(owner, { projectBindingId: token, prNumber: 7 })).ok, true);
    const pending = handlers.remoteCiRerun(owner, { projectBindingId: token, remoteCiRef: 'rci_' + 'b'.repeat(24) });
    await waiting;
    handlers.unbind(owner, { projectBindingId: token });
    resume();
    assert.equal((await pending).ok, false);
  } finally { handlers.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('D14 Agent tools are read-only except ref-based repair and absent from child agents and plan mode', async () => {
  for (const options of [{ agentMode: 'plan' }, { subagentDepth: 1, subagentKind: 'explore' }, { subagentDepth: 1, subagentKind: 'implement' }]) {
    const names = (await toolsForSettings({}, options)).map((tool) => tool.function.name);
    assert.equal(names.includes('remote_ci_sources'), false);
    assert.equal(names.includes('remote_ci_get'), false);
  }
  const names = (await toolsForSettings({})).map((tool) => tool.function.name);
  assert.ok(names.includes('remote_ci_sources'));
  assert.ok(names.includes('remote_ci_get'));
  assert.equal(names.includes('remote_ci_rerun'), false);
  assert.equal(names.includes('remote_ci_update_pr'), false);
});
