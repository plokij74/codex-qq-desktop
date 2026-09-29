'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { createPermissionGate, getSessionAllows } = require('../src/ai/permission');

function makeTempProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-audit-bound-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

describe('D17 PR audit preload and main IPC boundaries', () => {
  it('exposes preload audit APIs and registers channels in main', async () => {
    const calls = [];
    let exposedApi;
    const originalLoad = Module._load;
    try {
      Module._load = function loader(request, ...rest) {
        if (request === 'electron') {
          return {
            contextBridge: { exposeInMainWorld: (_name, exposed) => { exposedApi = exposed; } },
            ipcRenderer: {
              invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
              on: () => {},
              removeListener: () => {},
            },
          };
        }
        return originalLoad.call(this, request, ...rest);
      };
      delete require.cache[require.resolve('../src/preload')];
      require('../src/preload');
    } finally {
      Module._load = originalLoad;
    }

    const payload = {
      projectBindingId: 'pb_token',
      prNumber: 7,
      note: 'Focus note',
      auditRef: 'pra_' + '1'.repeat(24),
      findingId: 'paf_' + '2'.repeat(24),
      revision: 'a'.repeat(64),
      summary: 'Summary text',
      selections: [{ findingId: 'paf_' + '2'.repeat(24), title: 'T', body: 'B' }],
      draftRef: 'pad_' + '3'.repeat(24),
    };

    const mainCode = fs.readFileSync(require.resolve('../src/main'), 'utf8');

    const contracts = [
      ['startPrAudit', 'start', ['projectBindingId', 'prNumber', 'note']],
      ['listPrAudits', 'list', ['projectBindingId', 'prNumber']],
      ['getPrAudit', 'get', ['projectBindingId', 'auditRef']],
      ['cancelPrAudit', 'cancel', ['projectBindingId', 'auditRef']],
      ['getPrAuditContext', 'context', ['projectBindingId', 'auditRef', 'findingId']],
      ['preparePrAudit', 'prepare', ['projectBindingId', 'auditRef', 'revision', 'summary', 'selections']],
      ['publishPrAudit', 'publish', ['projectBindingId', 'draftRef']],
      ['reconcilePrAudit', 'reconcile', ['projectBindingId', 'auditRef']],
    ];

    for (const [method, channel, fields] of contracts) {
      assert.ok(typeof exposedApi[method] === 'function', `Missing preload method: ${method}`);
      assert.ok(mainCode.includes(`ipcMain.handle('engineering:pr-audit:${channel}'`), `Missing main handle: ${channel}`);
      await exposedApi[method](payload);
      assert.equal(calls.at(-1)[0], `engineering:pr-audit:${channel}`);
      const invokedPayload = calls.at(-1)[1];
      for (const field of fields) {
        assert.deepEqual(invokedPayload[field], payload[field]);
      }
    }
  });

  it('rejects cross-sender calls and injected parameter authority', async (t) => {
    const projectDir = makeTempProject(t);
    let managerCalls = 0;
    const handlers = createEngineeringIpcHandlers({
      prAuditManager: {
        list: async () => { managerCalls++; return { ok: true }; },
        close() {},
      },
    });
    t.after(() => handlers.close());

    const owner = { sender: { id: 1 } };
    const token = 'pb_' + 'a'.repeat(32);
    handlers.bind(owner, { projectBindingId: token, projectPath: projectDir });

    // Injected parameter rejected
    const badRes = await handlers.prAuditList(owner, {
      projectBindingId: token,
      prNumber: 7,
      injectedRepo: 'evil/repo',
    });
    assert.equal(badRes.code, 'PR_AUDIT_INVALID');
    assert.equal(managerCalls, 0);

    // Cross-sender rejected
    const crossRes = await handlers.prAuditList({ sender: { id: 2 } }, {
      projectBindingId: token,
      prNumber: 7,
    });
    assert.equal(crossRes.code, 'PR_AUDIT_BINDING');
    assert.equal(managerCalls, 0);

    // Valid call dispatches
    const validRes = await handlers.prAuditList(owner, {
      projectBindingId: token,
      prNumber: 7,
    });
    assert.equal(validRes.ok, true);
    assert.equal(managerCalls, 1);
  });

  it('enforces one-shot permission gate for publish, rejecting read-only and plan modes', async () => {
    const pending = [];
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      onApprovalNeeded: (event) => pending.push(event),
    });

    const request = gate.authorize({
      tool: 'pr_audit_publish',
      risk: 'remote-mutation',
      source: 'pr-audit',
      sessionKey: 'd17-test',
    });

    assert.equal(pending.length, 1);
    // Allow single approval
    gate.resolveApproval(pending[0].approvalId, 'allow');
    const result = await request;
    assert.equal(result.allowed, true);

    // Read-only mode rejects immediately
    const readOnly = createPermissionGate({ permissionMode: 'read-only' });
    const roResult = await readOnly.authorize({ tool: 'pr_audit_publish', risk: 'remote-mutation' });
    assert.equal(roResult.allowed, false);

    // Plan mode rejects immediately
    const planGate = createPermissionGate({ agentMode: 'plan' });
    const planResult = await planGate.authorize({ tool: 'pr_audit_publish', risk: 'remote-mutation' });
    assert.equal(planResult.allowed, false);
  });
});
