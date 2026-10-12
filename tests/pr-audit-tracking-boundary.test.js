'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
const { fixture } = require('./helpers/pr-audit-repair-fixture');
const { createGithubCli } = require('../src/ai/github-cli');

it('D21 local repository identity makes no gh/network calls', async () => {
  const calls = [];
  const cli = createGithubCli({ execFileImpl: (command, args, _opts, callback) => {
    calls.push([command, args]);
    const stdout = args.includes('--show-toplevel') ? process.cwd() : 'https://github.com/acme/widget.git';
    callback(null, stdout, ''); return { kill() {} };
  } });
  const out = await cli.getCiWatchRepository({ projectPath: process.cwd(), localOnly: true });
  assert.equal(out.ok, true); assert.equal(out.repository.nameWithOwner, 'acme/widget');
  assert.equal(calls.length, 2); assert.ok(calls.every(([command]) => command === 'git'));
});

it('D21 exposes only list/get authority through preload and main', async () => {
  const calls = []; let api; const original = Module._load;
  try {
    Module._load = function (request, ...args) {
      return request === 'electron' ? { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: { invoke: (...a) => { calls.push(a); }, on() {}, removeListener() {} } } : original.call(this, request, ...args);
    };
    delete require.cache[require.resolve('../src/preload')]; require('../src/preload');
  } finally { Module._load = original; }
  const p = { projectBindingId: 'pb_token', auditRef: 'pra_' + 'a'.repeat(24), prNumber: 7, headSha: 'evil', path: '../escape', conclusion: 'resolved' };
  await api.listPrAuditTracking(p); await api.getPrAuditTracking(p);
  assert.deepEqual(calls, [['engineering:pr-audit:tracking:list', { projectBindingId: p.projectBindingId, prNumber: 7 }],
    ['engineering:pr-audit:tracking:get', { projectBindingId: p.projectBindingId, auditRef: p.auditRef }]]);
  const main = fs.readFileSync(require.resolve('../src/main'), 'utf8');
  for (const [channel] of calls) assert.ok(main.includes(`ipcMain.handle('${channel}'`));
});
it('D21 IPC rejects other senders and injected authority and fences unbound responses', async (t) => {
  const f = fixture(t); const h = createEngineeringIpcHandlers({ prAuditManager: f.audits, prAuditRepairManager: f.manager, githubCli: f.github, worktreeManager: f.worktree });
  t.after(() => h.close()); const owner = { sender: { id: 1 } }; const token = 'pb_' + 'a'.repeat(32);
  h.bind(owner, { projectBindingId: token, projectPath: f.root });
  const p = { projectBindingId: token, auditRef: f.row.auditRef };
  assert.equal((await h.prAuditTrackingGet({ sender: { id: 2 } }, p)).code, 'PR_AUDIT_BINDING');
  assert.equal((await h.prAuditTrackingGet(owner, { ...p, headSha: 'evil' })).code, 'PR_AUDIT_INVALID');
  assert.equal((await h.prAuditTrackingList(owner, { projectBindingId: token, prNumber: -1 })).ok, false);
  assert.equal((await h.prAuditTrackingGet(owner, p)).ok, true);
  const before = [...f.calls]; assert.equal((await h.prAuditTrackingList(owner, { projectBindingId: token })).ok, true); assert.deepEqual(f.calls, before);
  f.github.getAuditPr = async () => { owner.sender.isDestroyed = () => true; return f.state.pr; };
  assert.equal((await h.prAuditTrackingGet(owner, p)).code, 'PR_AUDIT_BINDING');
});
