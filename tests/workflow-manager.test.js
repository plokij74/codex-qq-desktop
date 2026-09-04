'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflowManager } = require('../src/ai/workflow-manager');

function waitFor(manager, root, ref, expected, timeout = 2000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const current = manager.getRun(root, ref)?.run;
      if (current?.status === expected) return resolve(current);
      if (Date.now() > deadline) return reject(new Error(`workflow did not reach ${expected}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function waitForNode(manager, root, ref, expected, timeout = 2000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const current = manager.getRun(root, ref)?.run;
      if (current?.nodes?.some((node) => node.status === expected)) return resolve(current);
      if (Date.now() > deadline) return reject(new Error(`workflow node did not reach ${expected}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('D12 workflow manager', () => {
  it('runs dependencies in order, keeps opaque persisted metadata, and checks the gate', async () => {
    const root = process.cwd();
    const profiles = [
      { id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'a', cwd: '.', timeoutMs: 5000, enabled: true },
      { id: 'vfy_bbbbbbbb', name: 'b', kind: 'build', command: 'b', cwd: '.', timeoutMs: 5000, enabled: true },
    ];
    const order = [];
    const jobs = new Map();
    let serial = 0;
    const verification = {
      start: async ({ profileId }) => {
        order.push(profileId);
        const ref = `vfy_job_${String(++serial).padStart(24, '0')}`;
        jobs.set(ref, { status: 'passed', exitCode: 0, diagnosticCount: 0 });
        return { ok: true, jobRef: ref };
      },
      get: (ref) => jobs.get(ref),
      cancel: async () => ({ ok: true }),
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, { name: 'gate', nodes: [{ nodeId: 'b', profileId: 'vfy_bbbbbbbb', dependsOn: ['a'] }, { nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    assert.equal(saved.ok, true);
    const started = await manager.run(root, saved.workflow.workflowId, { settings: { terminalEnabled: true }, preAuthorized: true });
    const finished = await waitFor(manager, root, started.workflowRunRef, 'passed');
    assert.deepEqual(order, ['vfy_aaaaaaaa', 'vfy_bbbbbbbb']);
    assert.equal(manager.checkGate(root, { workflowRunRef: started.workflowRunRef, expectedFingerprint: 'fp', action: 'apply' }).ok, true);
    assert.equal(finished.nodes.every((node) => node.jobRef?.startsWith('vfy_job_')), true);
    manager.close();
  });

  it('continues independent branches and only runs failed dependencies when the node opts in', async () => {
    const root = process.cwd();
    const profiles = ['a', 'b', 'c', 'd'].map((name, index) => ({
      id: `vfy_${String.fromCharCode(97 + index).repeat(8)}`,
      name,
      kind: 'test',
      command: name,
      cwd: '.',
      timeoutMs: 5000,
      enabled: true,
    }));
    const jobs = new Map();
    let serial = 0;
    const verification = {
      start: async ({ profileId }) => {
        const ref = `vfy_job_${String(++serial).padStart(24, '0')}`;
        jobs.set(ref, { status: profileId === 'vfy_aaaaaaaa' ? 'failed' : 'passed', exitCode: profileId === 'vfy_aaaaaaaa' ? 1 : 0 });
        return { ok: true, jobRef: ref };
      },
      get: (ref) => jobs.get(ref),
      cancel: async () => ({ ok: true }),
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, {
      name: 'continue branches',
      failFast: false,
      maxParallel: 4,
      nodes: [
        { nodeId: 'a', profileId: 'vfy_aaaaaaaa' },
        { nodeId: 'blocked', profileId: 'vfy_bbbbbbbb', dependsOn: ['a'] },
        { nodeId: 'continued', profileId: 'vfy_cccccccc', dependsOn: ['a'], continueOnFailure: true },
        { nodeId: 'independent', profileId: 'vfy_dddddddd' },
      ],
    });
    const started = await manager.run(root, saved.workflow.workflowId, { preAuthorized: true });
    const finished = await waitFor(manager, root, started.workflowRunRef, 'failed');
    const statuses = Object.fromEntries(finished.nodes.map((node) => [node.nodeId, node.status]));
    assert.deepEqual(statuses, { a: 'failed', blocked: 'skipped', continued: 'passed', independent: 'passed' });
    manager.close();
  });

  it('marks unfinished fail-fast siblings as cancelled while preserving the original failure', async () => {
    const root = process.cwd();
    const profiles = [
      { id: 'vfy_aaaaaaaa', name: 'fail', kind: 'test', command: 'fail', cwd: '.', timeoutMs: 5000, enabled: true },
      { id: 'vfy_bbbbbbbb', name: 'wait', kind: 'test', command: 'wait', cwd: '.', timeoutMs: 5000, enabled: true },
      { id: 'vfy_cccccccc', name: 'later', kind: 'test', command: 'later', cwd: '.', timeoutMs: 5000, enabled: true },
    ];
    const jobs = new Map();
    let serial = 0;
    const verification = {
      start: async ({ profileId }) => {
        const ref = `vfy_job_${String(++serial).padStart(24, '0')}`;
        jobs.set(ref, { status: profileId === 'vfy_aaaaaaaa' ? 'failed' : 'running' });
        return { ok: true, jobRef: ref };
      },
      get: (ref) => jobs.get(ref),
      cancel: async (ref) => { jobs.set(ref, { status: 'cancelled' }); return { ok: true }; },
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, {
      name: 'fail fast',
      failFast: true,
      maxParallel: 2,
      nodes: [
        { nodeId: 'fail', profileId: 'vfy_aaaaaaaa' },
        { nodeId: 'sibling', profileId: 'vfy_bbbbbbbb' },
        { nodeId: 'dependent', profileId: 'vfy_cccccccc', dependsOn: ['fail'] },
      ],
    });
    const started = await manager.run(root, saved.workflow.workflowId, { preAuthorized: true });
    const finished = await waitFor(manager, root, started.workflowRunRef, 'failed');
    const statuses = Object.fromEntries(finished.nodes.map((node) => [node.nodeId, node.status]));
    assert.equal(statuses.fail, 'failed');
    assert.equal(statuses.sibling, 'cancelled');
    assert.ok(['skipped', 'cancelled'].includes(statuses.dependent));
    manager.close();
  });

  it('maps workflow timeout and workspace changes onto active node terminal states', async () => {
    const root = process.cwd();
    const profiles = [{ id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'a', cwd: '.', timeoutMs: 5000, enabled: true }];
    const timeoutJobs = new Map();
    const timeoutManager = createWorkflowManager({
      getProfiles: () => profiles,
      verificationManager: {
        start: async () => { const ref = 'vfy_job_aaaaaaaaaaaaaaaaaaaaaaaa'; timeoutJobs.set(ref, { status: 'running' }); return { ok: true, jobRef: ref }; },
        get: (ref) => timeoutJobs.get(ref),
        cancel: async (ref) => { timeoutJobs.set(ref, { status: 'cancelled' }); return { ok: true }; },
      },
      workspaceFingerprint: () => 'fp',
      safeStorage: null,
    });
    const timeoutWorkflow = timeoutManager.saveWorkflow(root, { name: 'timeout', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    timeoutManager.workflows.values().next().value.timeoutMs = 25;
    const timeoutStarted = await timeoutManager.run(root, timeoutWorkflow.workflow.workflowId, { preAuthorized: true });
    const timedOut = await waitFor(timeoutManager, root, timeoutStarted.workflowRunRef, 'timed_out');
    assert.equal(timedOut.nodes[0].status, 'timed_out');
    timeoutManager.close();

    let fingerprintCalls = 0;
    const staleJobs = new Map();
    const staleManager = createWorkflowManager({
      getProfiles: () => profiles,
      verificationManager: {
        start: async () => { const ref = 'vfy_job_bbbbbbbbbbbbbbbbbbbbbbbb'; staleJobs.set(ref, { status: 'passed' }); return { ok: true, jobRef: ref }; },
        get: (ref) => staleJobs.get(ref),
        cancel: async () => ({ ok: true }),
      },
      workspaceFingerprint: () => (++fingerprintCalls <= 2 ? 'before' : 'after'),
      safeStorage: null,
    });
    const staleWorkflow = staleManager.saveWorkflow(root, { name: 'stale', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    const staleStarted = await staleManager.run(root, staleWorkflow.workflow.workflowId, { preAuthorized: true });
    const stale = await waitFor(staleManager, root, staleStarted.workflowRunRef, 'stale');
    assert.equal(stale.nodes[0].status, 'stale');
    assert.equal(stale.workspaceChanged, true);
    staleManager.close();
  });

  it('rejects a second active run for the same project and marks interrupted runs on close', async () => {
    const root = process.cwd();
    const profiles = [{ id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'a', cwd: '.', timeoutMs: 5000, enabled: true }];
    let release;
    const verification = {
      start: async () => ({ ok: true, jobRef: 'vfy_job_aaaaaaaaaaaaaaaaaaaaaaaa' }),
      get: () => ({ status: 'running' }),
      cancel: async () => { release?.(); return { ok: true }; },
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, { name: 'hang', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    const first = await manager.run(root, saved.workflow.workflowId, { settings: { terminalEnabled: true }, preAuthorized: true });
    const second = await manager.run(root, saved.workflow.workflowId, { settings: { terminalEnabled: true }, preAuthorized: true });
    assert.equal(second.code, 'WORKFLOW_ALREADY_RUNNING');
    manager.close();
    assert.equal(manager.getRun(root, first.workflowRunRef).run.status, 'interrupted');
  });

  it('freezes profile fingerprints when saving and refuses a changed profile until the workflow is edited', async () => {
    const root = process.cwd();
    let profiles = [{ id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'node -v', cwd: '.', timeoutMs: 5000, enabled: true }];
    const manager = createWorkflowManager({
      getProfiles: () => profiles,
      verificationManager: { start: async () => ({ ok: false }), get: () => null, cancel: async () => ({ ok: true }) },
      workspaceFingerprint: () => 'fp',
      safeStorage: null,
    });
    const saved = manager.saveWorkflow(root, { name: 'frozen', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    profiles = [{ ...profiles[0], command: 'node --version' }];
    const listed = manager.listWorkflows(root, { includeDisabled: true });
    assert.equal(listed.workflows[0].runnable, false);
    assert.equal(listed.workflows[0].unavailableReason, 'WORKFLOW_PROFILE_CHANGED');
    assert.equal((await manager.run(root, saved.workflow.workflowId)).code, 'WORKFLOW_PROFILE_CHANGED');
    const updated = manager.saveWorkflow(root, { workflowId: saved.workflow.workflowId, name: 'refrozen', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    assert.equal(updated.ok, true);
    assert.equal(updated.workflow.revision, 2);
    assert.equal(updated.workflow.createdAt, saved.workflow.createdAt);
    manager.close();
  });

  it('cancels a node waiting for approval without inheriting the chat abort signal', async () => {
    const root = process.cwd();
    const profiles = [{ id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'a', cwd: '.', timeoutMs: 5000, enabled: true }];
    const external = new AbortController();
    let workflowSignal;
    const verification = {
      start: ({ signal }) => new Promise((resolve) => {
        workflowSignal = signal;
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'ABORTED', error: 'cancelled' }), { once: true });
      }),
      get: () => ({ status: 'running' }),
      cancel: async () => ({ ok: true }),
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, { name: 'approval', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    const started = await manager.run(root, saved.workflow.workflowId, { signal: external.signal, agentRunId: 'agent-1' });
    await waitForNode(manager, root, started.workflowRunRef, 'running');
    assert.notEqual(workflowSignal, external.signal);
    assert.equal(manager.cancelForAgent(root, started.workflowRunRef, 'agent-2').code, 'WORKFLOW_RUN_NOT_FOUND');
    assert.equal(manager.cancelForAgent(root, started.workflowRunRef, 'agent-1').ok, true);
    const finished = await waitFor(manager, root, started.workflowRunRef, 'cancelled');
    assert.equal(finished.nodes[0].status, 'cancelled');
    manager.close();
  });

  it('marks an active run configuration_changed when its workflow definition changes', async () => {
    const root = process.cwd();
    const profiles = [{ id: 'vfy_aaaaaaaa', name: 'a', kind: 'test', command: 'a', cwd: '.', timeoutMs: 5000, enabled: true }];
    const jobs = new Map();
    const verification = {
      start: async () => {
        const ref = 'vfy_job_aaaaaaaaaaaaaaaaaaaaaaaa';
        jobs.set(ref, { status: 'running' });
        return { ok: true, jobRef: ref };
      },
      get: (ref) => jobs.get(ref),
      cancel: async (ref) => { jobs.set(ref, { status: 'cancelled' }); return { ok: true }; },
    };
    const manager = createWorkflowManager({ getProfiles: () => profiles, verificationManager: verification, workspaceFingerprint: () => 'fp', safeStorage: null });
    const saved = manager.saveWorkflow(root, { name: 'original', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] });
    const started = await manager.run(root, saved.workflow.workflowId, { preAuthorized: true });
    await waitForNode(manager, root, started.workflowRunRef, 'running');
    assert.equal(manager.saveWorkflow(root, { workflowId: saved.workflow.workflowId, name: 'changed', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] }).ok, true);
    const finished = await waitFor(manager, root, started.workflowRunRef, 'configuration_changed');
    assert.equal(finished.status, 'configuration_changed');
    manager.close();
  });
});
