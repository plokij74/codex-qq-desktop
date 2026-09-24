'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createPermissionGate, getSessionAllows } = require('../src/ai/permission');
const { toolsForSettings } = require('../src/ai/agent');
const { fixture, deferred } = require('./helpers/pr-review-fixture');

describe('D16 preload and main boundaries', () => {
  it('allowlists seven review APIs, preserves reply newlines/length, and registers all channels', async () => {
    const calls = []; let api;
    const originalLoad = Module._load;
    try {
      Module._load = function loader(request, ...rest) {
        if (request === 'electron') return { contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
          ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} } };
        return originalLoad.call(this, request, ...rest);
      };
      delete require.cache[require.resolve('../src/preload')]; require('../src/preload');
    } finally { Module._load = originalLoad; }
    const payload = { projectBindingId: 'pb_example', prNumber: 7, threadRef: 'prt_ref', reviewRef: 'prv_ref', revision: 'abc',
      resultId: 'wt_ref', subject: 'Fix', body: 'line 1\n' + 'x'.repeat(5000), path: '/evil', repo: 'evil', headSha: 'forged', threadId: 'forged', approval: true };
    const contracts = [
      ['getPrReviewThreads', 'threads', ['projectBindingId', 'prNumber']], ['getPrReviewThread', 'get', ['projectBindingId', 'threadRef']],
      ['snapshotPrReview', 'snapshot', ['projectBindingId', 'threadRef', 'revision']], ['getPrReviewSource', 'source', ['projectBindingId', 'reviewRef']],
      ['replyPrReview', 'reply', ['projectBindingId', 'threadRef', 'revision', 'body']], ['resolvePrReview', 'resolve', ['projectBindingId', 'threadRef', 'revision']],
      ['updatePrReviewPr', 'update-pr', ['projectBindingId', 'resultId', 'subject']],
    ];
    const main = fs.readFileSync(require.resolve('../src/main'), 'utf8');
    for (const [method, channel, fields] of contracts) {
      await api[method](payload);
      assert.deepEqual(calls.at(-1), [`engineering:pr-review:${channel}`, Object.fromEntries(fields.map((key) => [key, payload[key]]))]);
      assert.ok(main.includes(`ipcMain.handle('engineering:pr-review:${channel}'`));
    }
    await api.startEngineeringRepair({ ...payload, source: { kind: 'pr_review', reviewRef: 'prv_ref', body: 'secret', threadId: 'forged' } });
    assert.deepEqual(calls.at(-1)[1].source, { kind: 'pr_review', reviewRef: 'prv_ref' });
    assert.doesNotMatch(JSON.stringify(calls.at(-1)), /secret|forged|\/evil/);
  });
  it('rejects cross-sender calls and injected target authority before dispatch', async (t) => {
    const f = fixture(t); let calls = 0;
    const handlers = createEngineeringIpcHandlers({ prReviewManager: { threads: async () => { calls++; return { ok: true }; }, close() {} } }); t.after(() => handlers.close());
    const owner = { sender: { id: 1 } }; const token = 'pb_' + 'a'.repeat(32);
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root });
    for (const key of ['projectPath', 'repo', 'host', 'headSha', 'threadId', 'body', 'approval', 'refspec']) {
      assert.equal((await handlers.prReviewThreads(owner, { projectBindingId: token, prNumber: 7, [key]: 'injected' })).code, 'PR_REVIEW_INVALID');
    }
    assert.equal((await handlers.prReviewThreads({ sender: { id: 2 } }, { projectBindingId: token, prNumber: 7 })).code, 'PR_REVIEW_PROJECT_BINDING_INVALID');
    assert.equal(calls, 0);
    assert.equal((await handlers.prReviewThreads(owner, { projectBindingId: token, prNumber: 7 })).ok, true); assert.equal(calls, 1);
  });
  it('invalidates late reads and pending actions on unbind or sender destruction', async (t) => {
    const f = fixture(t); const pending = deferred(); const entered = deferred(); let signal;
    const handlers = createEngineeringIpcHandlers({ prReviewManager: { get: async (_root, _ref, context) => { signal = context.signal; entered.resolve(); return pending.promise; }, close() {} } }); t.after(() => handlers.close());
    const owner = { sender: { id: 1 } }; const token = 'pb_' + 'a'.repeat(32);
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root });
    const read = handlers.prReviewGet(owner, { projectBindingId: token, threadRef: 'prt_' + 'a'.repeat(24) }); await entered.promise;
    handlers.unbind(owner, { projectBindingId: token }); assert.equal(signal.aborted, true);
    pending.resolve({ ok: true, thread: { body: 'late private body' } });
    assert.equal((await read).code, 'PR_REVIEW_PROJECT_BINDING_INVALID');
    handlers.bind(owner, { projectBindingId: token, projectPath: f.root }); handlers.dropSender(owner);
    assert.equal((await handlers.prReviewThreads(owner, { projectBindingId: token, prNumber: 7 })).ok, false);
  });
  it('requires one-shot approvals for reply/resolve/update even in full-auto, rejects read-only and plan', async () => {
    const pending = []; const gate = createPermissionGate({ permissionMode: 'full-auto', onApprovalNeeded: (event) => pending.push(event) });
    for (const tool of ['pr_review_reply', 'pr_review_resolve', 'pr_review_update_pr']) {
      const request = gate.authorize({ tool, risk: 'remote-mutation', source: 'pr-review', sessionKey: 'd16-test' });
      gate.resolveApproval(pending.at(-1).approvalId, 'allow_session'); assert.equal((await request).allowed, false);
      const one = gate.authorize({ tool, risk: 'remote-mutation', source: 'pr-review', sessionKey: 'd16-test' });
      gate.resolveApproval(pending.at(-1).approvalId, 'allow'); assert.equal((await one).allowed, true);
    }
    assert.equal(pending.length, 6); assert.equal(getSessionAllows('d16-test').size, 0);
    const readOnly = createPermissionGate({ permissionMode: 'read-only' });
    assert.equal((await readOnly.authorize({ tool: 'pr_review_reply', risk: 'remote-mutation' })).allowed, false);
    const plan = createPermissionGate({ agentMode: 'plan' });
    assert.equal((await plan.authorize({ tool: 'pr_review_reply', risk: 'remote-mutation' })).allowed, false);
  });
  it('adds no review Agent tools and refuses review source repair via the Agent bridge', async () => {
    for (const context of [{}, { agentMode: 'plan' }, { subagentDepth: 1, subagentKind: 'implement' }]) {
      const tools = await toolsForSettings({}, context); assert.equal(tools.some((tool) => /pr_review/.test(tool.function.name)), false);
    }
    const handlers = createEngineeringIpcHandlers();
    try { assert.equal((await handlers.repairStartForAgent('D:/repo', { source: { kind: 'pr_review', reviewRef: 'prv_' + 'a'.repeat(24) } })).code, 'REPAIR_SOURCE_INVALID'); }
    finally { handlers.close(); }
  });
});
