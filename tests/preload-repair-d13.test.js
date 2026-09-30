'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

let exposed = null;
const calls = [];
const electronStub = {
  contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
  ipcRenderer: {
    invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
    on: () => {},
    removeListener: () => {},
  },
};
const originalLoad = Module._load;

describe('D13 repair IPC and preload contract', () => {
  it('D14 rebuilds remote payloads without renderer-provided target authority', async () => {
    const payload = { projectBindingId: 'pb_test', prNumber: 7, checkRunId: '90071992547409931', remoteCiRef: 'rci_test', resultId: 'wt_test', subject: 'Fix', log: 'private', repo: 'other/repo', sha: 'forged', approval: true };
    await exposed.snapshotRemoteCi(payload);
    assert.deepEqual(calls.at(-1), ['engineering:remote-ci:snapshot', { projectBindingId: 'pb_test', prNumber: 7, checkRunId: '90071992547409931' }]);
    await exposed.updateRemoteCiPr(payload);
    assert.deepEqual(calls.at(-1), ['engineering:remote-ci:update-pr', { projectBindingId: 'pb_test', resultId: 'wt_test', subject: 'Fix' }]);
    await exposed.startEngineeringRepair({ ...payload, source: { kind: 'remote_ci', remoteCiRef: 'rci_test', log: 'private', headSha: 'forged' }, validationProfileId: 'vfy_test' });
    assert.deepEqual(calls.at(-1)[1], { projectBindingId: 'pb_test', source: { kind: 'remote_ci', remoteCiRef: 'rci_test' }, note: '', sessionId: '', validationProfileId: 'vfy_test' });
  });
  before(() => {
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === 'electron') return electronStub;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/preload')];
    require('../src/preload');
    Module._load = originalLoad;
  });

  after(() => { Module._load = originalLoad; });

  it('registers all repair channels in main', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    for (const channel of [
      'engineering:repair:list', 'engineering:repair:get', 'engineering:repair:result',
      'engineering:repair:start', 'engineering:repair:retry', 'engineering:repair:cancel',
      'engineering:repair:validate', 'engineering:repair:validate-cancel',
      'engineering:pr-audit:repair-snapshot', 'engineering:pr-audit:repair-source', 'engineering:pr-audit:update-pr',
    ]) assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });

  it('reconstructs every repair payload and drops path, command, model, and result injection', async () => {
    const injected = {
      projectBindingId: 7, repairRef: 8, note: 'n'.repeat(2100), sessionId: 9,
      projectPath: 'D:/forged', command: 'whoami', cwd: 'D:/forged', resultId: 'wt_forged',
      model: 'forged', baseUrl: 'https://forged.invalid', token: 'secret', limit: 12,
    };
    await exposed.listEngineeringRepairs(injected);
    await exposed.getEngineeringRepair(injected);
    await exposed.getEngineeringRepairResult(injected);
    await exposed.startEngineeringRepair({ ...injected, source: { kind: 'verification', jobRef: 10, command: 'forged', path: 'D:/forged' } });
    await exposed.startEngineeringRepair({ ...injected, source: { kind: 'workflow', workflowRunRef: 11, nodeId: 'x'.repeat(130), command: 'forged' } });
    await exposed.retryEngineeringRepair(injected);
    await exposed.cancelEngineeringRepair(injected);
    await exposed.validateEngineeringRepair(injected);
    await exposed.cancelEngineeringRepairValidation(injected);

    assert.deepEqual(calls.slice(-9), [
      ['engineering:repair:list', { projectBindingId: '7', limit: 12 }],
      ['engineering:repair:get', { projectBindingId: '7', repairRef: '8' }],
      ['engineering:repair:result', { projectBindingId: '7', repairRef: '8' }],
      ['engineering:repair:start', { projectBindingId: '7', source: { kind: 'verification', jobRef: '10' }, note: 'n'.repeat(2000), sessionId: '9' }],
      ['engineering:repair:start', { projectBindingId: '7', source: { kind: 'workflow', workflowRunRef: '11', nodeId: 'x'.repeat(120) }, note: 'n'.repeat(2000), sessionId: '9' }],
      ['engineering:repair:retry', { projectBindingId: '7', repairRef: '8', note: 'n'.repeat(2001), sessionId: '9' }],
      ['engineering:repair:cancel', { projectBindingId: '7', repairRef: '8' }],
      ['engineering:repair:validate', { projectBindingId: '7', repairRef: '8', sessionId: '9' }],
      ['engineering:repair:validate-cancel', { projectBindingId: '7', repairRef: '8' }],
    ]);
  });

  it('D18 preserves the opaque source and optional profile while rejecting over-limit input in main', async () => {
    const injected = { projectBindingId: 'pb_test', auditRef: 'pra_test', auditRepairRef: 'par_test', repairRevision: 'abc', findingIds: ['paf_1', 'paf_2'],
      resultId: 'wt_test', subject: 'Fix originals', title: 'edited publication', body: 'private body', headSha: 'forged', repo: 'other/repo', approval: true };
    await exposed.snapshotPrAuditRepair(injected);
    assert.deepEqual(calls.at(-1), ['engineering:pr-audit:repair-snapshot', { projectBindingId: 'pb_test', auditRef: 'pra_test', repairRevision: 'abc', findingIds: ['paf_1', 'paf_2'] }]);
    await exposed.getPrAuditRepairSource(injected);
    assert.deepEqual(calls.at(-1), ['engineering:pr-audit:repair-source', { projectBindingId: 'pb_test', auditRepairRef: 'par_test' }]);
    await exposed.updatePrAuditPr(injected);
    assert.deepEqual(calls.at(-1), ['engineering:pr-audit:update-pr', { projectBindingId: 'pb_test', resultId: 'wt_test', subject: 'Fix originals' }]);
    await exposed.startEngineeringRepair({ ...injected, source: { kind: 'pr_audit', auditRepairRef: 'par_test', path: '/forged', body: 'edited' }, validationProfileId: 'vfy_test', note: 'x'.repeat(2100) });
    assert.deepEqual(calls.at(-1)[1], { projectBindingId: 'pb_test', source: { kind: 'pr_audit', auditRepairRef: 'par_test' }, note: 'x'.repeat(2001), validationProfileId: 'vfy_test', sessionId: '' });
    await exposed.snapshotPrAuditRepair({ ...injected, findingIds: Array(100).fill('paf_1') });
    assert.equal(calls.at(-1)[1].findingIds.length, 6, 'retain an over-limit sentinel, never silently accept five');
  });
});
