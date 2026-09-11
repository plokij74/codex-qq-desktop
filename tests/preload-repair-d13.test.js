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
      ['engineering:repair:retry', { projectBindingId: '7', repairRef: '8', note: 'n'.repeat(2000), sessionId: '9' }],
      ['engineering:repair:cancel', { projectBindingId: '7', repairRef: '8' }],
      ['engineering:repair:validate', { projectBindingId: '7', repairRef: '8', sessionId: '9' }],
      ['engineering:repair:validate-cancel', { projectBindingId: '7', repairRef: '8' }],
    ]);
  });
});
