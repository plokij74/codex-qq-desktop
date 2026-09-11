'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  normalizeSource,
  normalizeRepair,
  publicRepairSummary,
  createRepairRef,
} = require('../src/ai/repair-state');
const { createRepairStore } = require('../src/ai/repair-store');
const { createVerificationManager, profileFingerprint } = require('../src/ai/verification-manager');
const { createWorktreeManager } = require('../src/ai/worktree');
const { createRepairManager } = require('../src/ai/repair-manager');
const { projectKey } = require('../src/ai/project-index');

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.from(String(value), 'utf8'); },
    decryptString(value) { return Buffer.from(value).toString('utf8'); },
  };
}
function record(projectKey = 'a'.repeat(64)) {
  return normalizeRepair({
    repairRef: createRepairRef(), projectKey,
    source: { kind: 'verification', jobRef: 'vfy_job_' + 'b'.repeat(24) },
    profileId: 'vfy_' + 'c'.repeat(8), profileFingerprint: 'd'.repeat(64),
    sourceWorkspaceFingerprint: 'e'.repeat(64), status: 'ready', resultId: 'wt_abcdef12',
    createdAt: new Date(0).toISOString(), diagnosticCount: 1,
  });
}

function repairFixture(root) {
  const jobRef = 'vfy_job_' + 'b'.repeat(24);
  const profileId = 'vfy_' + 'c'.repeat(8);
  const profile = { id: profileId, name: 'Tests', kind: 'test', command: 'node check.js', cwd: '.', timeoutMs: 5000, enabled: true };
  const profileFp = profileFingerprint(profile);
  const workspace = 'e'.repeat(64);
  const state = { profileFingerprint: profileFp, workspace };
  const verification = {
    getRepairSource() {
      return {
        job: {
          jobRef, projectKey: projectKey(root), status: 'failed', profileId,
          profileFingerprint: profileFp, workspaceFingerprintStart: workspace, workspaceFingerprintEnd: workspace,
        },
        profile: { ...profile, fingerprint: state.profileFingerprint },
        result: { diagnostics: [{ path: 'a.js', line: 1, column: 1, message: 'failure', severity: 'error' }], stdout: '', stderr: '' },
      };
    },
  };
  return { jobRef, profileId, profileFingerprint: profileFp, workspace, state, verification };
}

async function eventually(read, predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

describe('D13 repair contracts', () => {
  it('rejects source injection and keeps public summaries opaque', () => {
    assert.throws(() => normalizeSource({ kind: 'verification', jobRef: 'vfy_job_' + 'a'.repeat(24), command: 'whoami' }), /字段无效/);
    const item = record();
    const publicValue = publicRepairSummary({ ...item, note: 'secret', prompt: 'secret', projectPath: 'C:/secret' });
    assert.equal(publicValue.projectKey, undefined);
    assert.equal(publicValue.note, undefined);
    assert.equal(publicValue.prompt, undefined);
    assert.equal(publicValue.projectPath, undefined);
  });

  it('preserves an encrypted corrupt store and refuses writes', () => {
    const dir = tempDir('codex-d13-store-');
    const file = path.join(dir, 'engineering-repairs.json');
    fs.writeFileSync(file, '{not-json', 'utf8');
    const store = createRepairStore({ repairPath: file, safeStorage: safeStorage() });
    assert.equal(store.persistenceStatus().corrupt, true);
    assert.throws(() => store.put(record()), (error) => error.code === 'REPAIR_STORE_CORRUPT');
    assert.equal(fs.readFileSync(file, 'utf8'), '{not-json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a frozen profile without creating a D11 job or event', async () => {
    const root = tempDir('codex-d13-vfy-');
    const executionRoot = tempDir('codex-d13-vfy-child-');
    let calls = 0;
    try {
      const manager = createVerificationManager({ projectPath: root, safeStorage: null, runTerminal: async (cwd, command, options) => {
        calls += 1;
        assert.equal(cwd.toLowerCase(), executionRoot.toLowerCase());
        assert.equal(command, 'node check.js');
        options.onStdout('passed');
        return { ok: true, code: 0 };
      } });
      const profile = { id: 'vfy_' + '1'.repeat(8), name: 'Frozen', kind: 'test', command: 'node check.js', cwd: '.', timeoutMs: 5000, enabled: true };
      manager.replaceProfiles(root, [profile]);
      const result = await manager.runFrozenProfile({ projectPath: root, executionRoot, profileId: profile.id, expectedFingerprint: profileFingerprint(profile), settings: { terminalEnabled: true } });
      assert.equal(result.status, 'passed');
      assert.equal(result.ok, true);
      assert.equal(calls, 1);
      assert.equal(manager.list({ projectPath: root }).jobs.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(executionRoot, { recursive: true, force: true });
    }
  });

  it('restores the D5 patch after advisory validation mutates the checkout', async () => {
    const root = tempDir('codex-d13-wt-');
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      git(['config', 'user.email', 'codex@example.test']);
      git(['config', 'user.name', 'Codex Test']);
      fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
      git(['add', '.']); git(['commit', '-qm', 'init']);
      const worktree = createWorktreeManager();
      const created = await worktree.create({ project: { path: root }, goal: 'repair' });
      assert.equal(created.ok, true, created.error);
      fs.writeFileSync(path.join(created.handle.childProjectPath, 'a.txt'), 'repair\n');
      const collected = await worktree.collect(created.handle);
      assert.equal(collected.ok, true);
      const validated = await worktree.validateFrozenProfile({
        projectPath: root,
        resultId: created.handle.id,
        profileId: 'vfy_' + '1'.repeat(8),
        profileFingerprint: 'a'.repeat(64),
        runProfile: async ({ executionRoot }) => {
          fs.writeFileSync(path.join(executionRoot, 'a.txt'), 'validation changed\n');
          fs.writeFileSync(path.join(executionRoot, 'temporary.txt'), 'remove me\n');
          return { ok: true, status: 'passed' };
        },
      });
      assert.equal(validated.ok, true, validated.error);
      assert.equal(fs.readFileSync(path.join(created.handle.childProjectPath, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'repair\n');
      assert.equal(fs.existsSync(path.join(created.handle.childProjectPath, 'temporary.txt')), false);
      const result = await worktree.get({ projectPath: root, resultId: created.handle.id });
      assert.equal(result.result.state, 'ready');
      await worktree.discard({ projectPath: root, resultId: created.handle.id });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes simultaneous starts while approval is pending', async () => {
    const root = tempDir('codex-d13-manager-start-');
    const fixture = repairFixture(root);
    let approve;
    const gate = { authorize: () => new Promise((resolve) => { approve = () => resolve({ allowed: true }); }) };
    const manager = createRepairManager({
      safeStorage: null, verificationManager: fixture.verification, workspaceFingerprint: () => fixture.state.workspace,
      settings: { permissionMode: 'confirm-writes', terminalEnabled: true }, permissionGate: gate,
    });
    try {
      let runStarted;
      const runReady = new Promise((resolve) => { runStarted = resolve; });
      manager.runImplement = () => new Promise((resolve) => { runStarted(() => resolve({ ok: true, terminalReason: 'completed', result: { id: 'wt_start01', changed: true } })); });
      const first = manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      await eventually(() => approve, Boolean);
      const second = manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      approve();
      const firstResult = await first;
      assert.equal(firstResult.ok, true);
      const secondResult = await second;
      assert.equal(secondResult.ok, false);
      assert.equal(secondResult.code, 'REPAIR_ALREADY_RUNNING');
      const release = await runReady;
      release();
      await eventually(() => manager.get(root, firstResult.repairRef), (value) => value.repair?.status === 'ready');
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rechecks retry source freshness after approval and records no worktree', async () => {
    const root = tempDir('codex-d13-manager-retry-');
    const fixture = repairFixture(root);
    let approve;
    const manager = createRepairManager({
      safeStorage: null, verificationManager: fixture.verification, workspaceFingerprint: () => fixture.state.workspace,
      settings: { permissionMode: 'confirm-writes', terminalEnabled: true },
      permissionGate: { authorize: () => new Promise((resolve) => { approve = () => { fixture.state.workspace = 'f'.repeat(64); resolve({ allowed: true }); }; }) },
      runImplement: async () => ({ ok: true, terminalReason: 'completed', result: { id: 'wt_retry1', changed: true } }),
    });
    const old = normalizeRepair({ ...record(projectKey(root)), source: { kind: 'verification', jobRef: fixture.jobRef }, profileId: fixture.profileId, profileFingerprint: fixture.profileFingerprint, sourceWorkspaceFingerprint: fixture.workspace, status: 'failed', errorCode: 'REPAIR_GENERATION_FAILED' });
    manager.store.put(old);
    try {
      const retry = manager.retry(root, old.repairRef, {});
      await eventually(() => approve, Boolean);
      approve();
      const result = await retry;
      assert.equal(result.ok, false);
      assert.equal(result.code, 'REPAIR_WORKSPACE_CHANGED');
      assert.equal(manager.list(root).repairs.length, 1);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('enforces Agent owner cancellation and preserves partial D5 result on abort', async () => {
    const root = tempDir('codex-d13-manager-cancel-');
    const fixture = repairFixture(root);
    let runEntered;
    const runReady = new Promise((resolve) => { runEntered = resolve; });
    const manager = createRepairManager({
      safeStorage: null, verificationManager: fixture.verification, workspaceFingerprint: () => fixture.state.workspace,
      settings: { permissionMode: 'full-auto', terminalEnabled: true },
    });
    manager.runImplement = ({ signal }) => new Promise((resolve) => {
        runEntered();
        signal.addEventListener('abort', () => resolve({ ok: true, terminalReason: 'aborted', incomplete: true, result: { id: 'wt_abort1', changed: true } }), { once: true });
      });
    try {
      const startPromise = manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } }, { agentRunId: 'agent-1' });
      await runReady;
      const started = await startPromise;
      const foreign = await manager.cancel(root, started.repairRef, { agentRunId: 'agent-2' });
      assert.equal(foreign.ok, false);
      assert.equal(foreign.code, 'REPAIR_CANCEL_FAILED');
      const cancelled = await manager.cancel(root, started.repairRef, { agentRunId: 'agent-1' });
      assert.equal(cancelled.ok, true);
      await eventually(() => manager.get(root, started.repairRef), (value) => value.repair?.status === 'cancelled');
      const final = manager.get(root, started.repairRef).repair;
      assert.equal(final.resultId, 'wt_abort1');
      assert.equal(final.incomplete, true);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('blocks repair start during advisory validation and releases reservation after cancel', async () => {
    const root = tempDir('codex-d13-manager-validate-');
    const fixture = repairFixture(root);
    let finishValidation;
    const manager = createRepairManager({
      safeStorage: null, verificationManager: { ...fixture.verification, runFrozenProfile: async () => new Promise((resolve) => { finishValidation = resolve; }) },
      workspaceFingerprint: () => fixture.state.workspace, settings: { permissionMode: 'full-auto', terminalEnabled: true },
      permissionGate: { authorize: async () => ({ allowed: true }) },
      worktreeManager: { validateFrozenProfile: async ({ runProfile, signal }) => runProfile({ executionRoot: root, signal }) },
      runImplement: async () => ({ ok: true, result: { id: 'wt_validate', changed: true }, terminalReason: 'completed' }),
    });
    try {
      const old = normalizeRepair({ ...record(projectKey(root)), source: { kind: 'verification', jobRef: fixture.jobRef }, profileId: fixture.profileId, profileFingerprint: fixture.profileFingerprint, sourceWorkspaceFingerprint: fixture.workspace, status: 'ready', resultId: 'wt_validate' });
      manager.store.put(old);
      const validating = manager.validate(root, old.repairRef);
      await eventually(() => manager.details.get(old.repairRef)?.validationAbort, Boolean);
      const blocked = await manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'REPAIR_ALREADY_RUNNING');
      assert.equal((await manager.validateCancel(root, old.repairRef)).ok, true);
      finishValidation({ ok: false, status: 'cancelled' });
      const result = await validating;
      assert.equal(result.ok, true);
      assert.equal(result.validation.status, 'cancelled');
      assert.equal(manager.validationByProject.size, 0);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('maps runtime failures to fixed public messages and drops validation extras', async () => {
    const root = tempDir('codex-d13-manager-privacy-');
    const fixture = repairFixture(root);
    const secret = `${root} token=super-secret`;
    const manager = createRepairManager({
      safeStorage: null, verificationManager: { ...fixture.verification, runFrozenProfile: async () => ({ ok: true, status: 'passed' }) },
      workspaceFingerprint: () => fixture.state.workspace, settings: { permissionMode: 'full-auto', terminalEnabled: true },
      permissionGate: { authorize: async () => ({ allowed: true }) },
      worktreeManager: { validateFrozenProfile: async () => ({ ok: true, status: 'passed', stdout: secret, stderr: '', command: secret, cwd: root, token: 'super-secret' }) },
      runImplement: async () => { const error = new Error(secret); error.code = 'PROVIDER_SECRET_FAILURE'; throw error; },
    });
    try {
      const started = await manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      const failed = await eventually(() => manager.get(root, started.repairRef), (value) => value.repair?.status === 'failed');
      assert.equal(failed.repair.errorCode, 'REPAIR_GENERATION_FAILED');
      assert.equal(failed.repair.statusMessage, '修复 Agent 执行失败');
      assert.doesNotMatch(JSON.stringify(failed), /super-secret|PROVIDER_SECRET_FAILURE/);

      const ready = normalizeRepair({ ...record(projectKey(root)), source: { kind: 'verification', jobRef: fixture.jobRef }, profileId: fixture.profileId, profileFingerprint: fixture.profileFingerprint, sourceWorkspaceFingerprint: fixture.workspace, status: 'ready', resultId: 'wt_privacy' });
      manager.store.put(ready);
      const validated = await manager.validate(root, ready.repairRef);
      assert.equal(validated.ok, true);
      const cached = manager.validationResults.get(ready.repairRef);
      assert.equal(cached.command, undefined);
      assert.equal(cached.cwd, undefined);
      assert.equal(cached.token, undefined);
      assert.doesNotMatch(cached.stdout, /super-secret/);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reconciles only interrupted repairs with D5 recovery results', async () => {
    const root = tempDir('codex-d13-reconcile-');
    const fixture = repairFixture(root);
    const store = createRepairStore({ safeStorage: null });
    const repairRef = createRepairRef();
    store.put(normalizeRepair({
      ...record(projectKey(root)), repairRef, source: { kind: 'verification', jobRef: fixture.jobRef },
      profileId: fixture.profileId, profileFingerprint: fixture.profileFingerprint,
      sourceWorkspaceFingerprint: fixture.workspace, status: 'generating', resultId: undefined,
    }));
    let calls = 0;
    const manager = createRepairManager({
      store,
      worktreeManager: {
        recover: async ({ projectPath }) => {
          calls += 1;
          assert.equal(projectPath.toLowerCase(), root.toLowerCase());
          return { ok: true, recovered: [{ id: 'wt_recover1', subagentId: repairRef, canOpen: true, errorCode: null }], results: [], warnings: [] };
        },
      },
    });
    try {
      assert.equal(manager.get(root, repairRef).repair.status, 'interrupted');
      const restored = await manager.restoreAtStartup(root);
      assert.equal(restored.recovery.recovered, 1);
      assert.equal(calls, 1);
      const repaired = manager.get(root, repairRef).repair;
      assert.equal(repaired.status, 'interrupted');
      assert.equal(repaired.resultId, 'wt_recover1');
      assert.equal(repaired.incomplete, true);
      assert.equal(repaired.errorCode, 'REPAIR_INTERRUPTED');
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed for tampered or missing interrupted D5 artifacts', async () => {
    const root = tempDir('codex-d13-reconcile-warning-');
    const fixture = repairFixture(root);
    const tamperedRef = createRepairRef();
    const missingRef = createRepairRef();
    const store = createRepairStore({ safeStorage: null });
    for (const [repairRef, resultId] of [[tamperedRef, undefined], [missingRef, 'wt_missing1']]) {
      store.put(normalizeRepair({
        ...record(projectKey(root)), repairRef, source: { kind: 'verification', jobRef: fixture.jobRef },
        profileId: fixture.profileId, profileFingerprint: fixture.profileFingerprint,
        sourceWorkspaceFingerprint: fixture.workspace, status: 'interrupted', resultId,
      }));
    }
    const manager = createRepairManager({
      store,
      worktreeManager: {
        recover: async () => ({
          ok: true,
          results: [{ id: 'wt_tamper1', subagentId: tamperedRef, errorCode: 'PATCH_INVALID' }],
          recovered: [], warnings: ['wt_missing1: marker 无法验证'],
        }),
      },
    });
    try {
      await manager.restoreAtStartup(root);
      const tampered = manager.get(root, tamperedRef).repair;
      assert.equal(tampered.resultId, 'wt_tamper1');
      assert.equal(tampered.errorCode, 'REPAIR_PATCH_CHANGED');
      assert.equal(tampered.statusMessage, '验证期间隔离补丁无法安全恢复，已保留现场');
      assert.equal(manager.get(root, missingRef).repair.errorCode, 'REPAIR_PATCH_CHANGED');
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects invalid or forged source fingerprints before running an Agent', async () => {
    const root = tempDir('codex-d13-fingerprint-');
    const fixture = repairFixture(root);
    let runs = 0;
    const manager = createRepairManager({
      verificationManager: {
        getRepairSource: () => ({
          job: {
            jobRef: fixture.jobRef, projectKey: projectKey(root), status: 'failed', profileId: fixture.profileId,
            profileFingerprint: 'not-a-fingerprint', workspaceFingerprintStart: fixture.workspace, workspaceFingerprintEnd: fixture.workspace,
          },
          profile: { id: fixture.profileId, name: 'Tests', fingerprint: fixture.state.profileFingerprint, enabled: true },
          result: { diagnostics: [], stdout: '', stderr: '' },
        }),
      },
      workspaceFingerprint: () => fixture.state.workspace,
      runImplement: async () => { runs += 1; return { ok: true, result: { id: 'wt_fp01', changed: true } }; },
      settings: { permissionMode: 'full-auto' },
    });
    try {
      const result = await manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'REPAIR_PROFILE_CHANGED');
      assert.equal(runs, 0);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('does not invoke the runtime or create a result when no Agent is available', async () => {
    const root = tempDir('codex-d13-agent-unavailable-');
    const fixture = repairFixture(root);
    let runs = 0;
    const manager = createRepairManager({
      verificationManager: fixture.verification,
      workspaceFingerprint: () => fixture.state.workspace,
      settings: { permissionMode: 'full-auto', mode: 'api', agentEnabled: false, apiKey: 'x', model: 'y' },
      subagentRuntime: { runIsolatedImplement: async () => { runs += 1; return { ok: true, result: { id: 'wt_unavail', changed: true } }; } },
    });
    try {
      const started = await manager.start(root, { source: { kind: 'verification', jobRef: fixture.jobRef } });
      const failed = await eventually(() => manager.get(root, started.repairRef), (value) => value.repair?.status === 'failed');
      assert.equal(failed.repair.errorCode, 'REPAIR_AGENT_UNAVAILABLE');
      assert.equal(runs, 0);
      assert.equal(failed.repair.resultId, undefined);
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves a failed workflow node to its frozen D11 source', async () => {
    const root = tempDir('codex-d13-workflow-source-');
    const fixture = repairFixture(root);
    const workflowRunRef = 'wf_run_' + 'a'.repeat(24);
    const nodeId = 'unit-tests';
    const manager = createRepairManager({
      verificationManager: fixture.verification,
      workflowManager: {
        getRunForRepair: () => ({
          workflowRunRef,
          projectKey: projectKey(root),
          status: 'failed',
          startWorkspaceFingerprint: fixture.workspace,
          endWorkspaceFingerprint: fixture.workspace,
          profileFingerprints: { [nodeId]: fixture.profileFingerprint },
          nodes: [{ nodeId, status: 'failed', jobRef: fixture.jobRef, profileId: fixture.profileId }],
        }),
      },
      workspaceFingerprint: () => fixture.state.workspace,
      settings: { permissionMode: 'full-auto' },
      runImplement: async () => ({ ok: true, terminalReason: 'completed', result: { changed: false } }),
    });
    try {
      const started = await manager.start(root, { source: { kind: 'workflow', workflowRunRef, nodeId } });
      assert.equal(started.ok, true, JSON.stringify(started));
      const finished = await eventually(() => manager.get(root, started.repairRef), (value) => value.repair?.status === 'no_changes');
      assert.deepEqual(finished.repair.source, { kind: 'workflow', workflowRunRef, nodeId });
    } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
