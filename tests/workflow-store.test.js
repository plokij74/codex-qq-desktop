'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowStore, MAX_PROJECT_RUNS, MAX_RUNS } = require('../src/ai/workflow-store');
const { createWorkflowManager } = require('../src/ai/workflow-manager');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d12-store-'));
}

function readEnvelope(file) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
}

describe('D12 workflow store', () => {
  it('uses encrypted envelopes and keeps memory-only mode off disk when safeStorage is unavailable', () => {
    const dir = tempDir();
    try {
      const encrypted = createWorkflowStore({ userDataPath: dir, safeStorage });
      encrypted.putWorkflow({ projectKey: 'a'.repeat(32), workflowId: 'wf_' + 'a'.repeat(16), name: 'gate' });
      assert.equal(encrypted.persistenceStatus().persistence, 'encrypted');
      const workflowPath = path.join(dir, 'engineering-workflows.json');
      const envelope = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
      assert.equal(envelope.version, 1);
      assert.equal(envelope.cipher, 'electron-safeStorage');
      assert.equal(readEnvelope(workflowPath)[0].name, 'gate');

      const memoryDir = path.join(dir, 'memory');
      const memory = createWorkflowStore({ userDataPath: memoryDir, safeStorage: null });
      memory.putWorkflow({ projectKey: 'b'.repeat(32), workflowId: 'wf_' + 'b'.repeat(16), name: 'memory' });
      assert.equal(memory.persistenceStatus().persistence, 'memory');
      assert.equal(fs.existsSync(path.join(memoryDir, 'engineering-workflows.json')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves a corrupt envelope and refuses to overwrite it', () => {
    const dir = tempDir();
    const file = path.join(dir, 'engineering-workflows.json');
    try {
      fs.writeFileSync(file, '{broken', 'utf8');
      const store = createWorkflowStore({ userDataPath: dir, safeStorage });
      assert.equal(store.persistenceStatus().error, 'WORKFLOW_STORE_CORRUPT');
      store.putWorkflow({ projectKey: 'a'.repeat(32), workflowId: 'wf_' + 'a'.repeat(16), name: 'must-not-write' });
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('prunes terminal history per project and globally without removing active runs', () => {
    const store = createWorkflowStore({ safeStorage: null });
    const runs = [];
    for (let index = 0; index < MAX_RUNS + 20; index += 1) {
      const projectKey = String(index % 5).repeat(32);
      runs.push({
        workflowRunRef: `wf_run_${String(index).padStart(24, '0')}`,
        projectKey,
        status: 'passed',
        createdAt: new Date(index * 1000).toISOString(),
        finishedAt: new Date(index * 1000 + 1).toISOString(),
      });
    }
    const active = {
      workflowRunRef: 'wf_run_' + 'f'.repeat(24),
      projectKey: '0'.repeat(32),
      status: 'running',
      createdAt: new Date(0).toISOString(),
    };
    store.saveRuns([...runs, active]);
    assert.ok(store.listRuns().length <= MAX_RUNS);
    assert.ok(store.getRun(active.workflowRunRef));
    for (const key of ['0', '1', '2', '3', '4'].map((value) => value.repeat(32))) {
      assert.ok(store.listRuns(key).length <= MAX_PROJECT_RUNS);
    }
  });

  it('persists only opaque run metadata and never writes project paths, commands, or permission context', async () => {
    const dir = tempDir();
    const root = process.cwd();
    const profiles = [{
      id: 'vfy_aaaaaaaa', name: 'test', kind: 'test', command: 'SECRET_COMMAND --token abc', cwd: '.', timeoutMs: 5000, enabled: true,
    }];
    const jobs = new Map();
    try {
      const manager = createWorkflowManager({
        userDataPath: dir,
        safeStorage,
        getProfiles: () => profiles,
        workspaceFingerprint: () => 'workspace-fingerprint',
        verificationManager: {
          start: async () => {
            const ref = 'vfy_job_aaaaaaaaaaaaaaaaaaaaaaaa';
            jobs.set(ref, { status: 'passed', exitCode: 0, diagnosticCount: 0 });
            return { ok: true, jobRef: ref };
          },
          get: (ref) => jobs.get(ref),
          cancel: async () => ({ ok: true }),
        },
      });
      const saved = manager.saveWorkflow(root, { name: 'gate', nodes: [{ nodeId: 'test', profileId: 'vfy_aaaaaaaa' }] });
      const started = await manager.run(root, saved.workflow.workflowId, {
        settings: { terminalEnabled: true, apiKey: 'SECRET_API_KEY' },
        permissionGate: { authorize: async () => ({ allowed: true }) },
        preAuthorized: true,
      });
      const deadline = Date.now() + 2000;
      while (manager.getRun(root, started.workflowRunRef).run.status !== 'passed') {
        if (Date.now() > deadline) throw new Error('workflow did not finish');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const workflowData = JSON.stringify(readEnvelope(path.join(dir, 'engineering-workflows.json')));
      const runData = JSON.stringify(readEnvelope(path.join(dir, 'engineering-workflow-runs.json')));
      for (const text of [workflowData, runData]) {
        assert.doesNotMatch(text, /SECRET_COMMAND|SECRET_API_KEY|--token abc/);
        assert.equal(text.includes(root), false);
      }
      assert.match(runData, /wf_run_[a-f0-9]{24}/);
      manager.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
