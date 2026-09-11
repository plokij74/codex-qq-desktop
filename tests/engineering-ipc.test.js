'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-ipc-'));
  fs.writeFileSync(path.join(root, 'index.js'), 'export function ipcSymbol() {}\n', 'utf8');
  return root;
}

function event(id) {
  return { sender: { id, isDestroyed: () => false, send: () => {} } };
}

function makeToken(suffix) {
  return `pb_${String(suffix).padStart(32, '0').slice(-32)}`;
}

describe('D11 engineering IPC boundary', () => {
  it('requires sender-owned binding tokens and isolates index queries by sender', async () => {
    const root = tempProject();
    try {
      const handlers = createEngineeringIpcHandlers();
      const owner = event(10);
      const token = handlers.bind(owner, { projectPath: root, projectId: 'project-1', projectBindingId: makeToken('1') });
      assert.equal(token.ok, true);
      assert.equal((await handlers.ensure(owner, { projectBindingId: token.projectBindingId })).ok, true);
      const found = await handlers.search(owner, { projectBindingId: token.projectBindingId, mode: 'definitions', query: 'ipcSymbol' });
      assert.equal(found.results[0].path, 'index.js');

      const foreign = await handlers.status(event(11), { projectBindingId: token.projectBindingId });
      assert.equal(foreign.code, 'ENGINEERING_PROJECT_BINDING_INVALID');
      const malformed = await handlers.search(owner, { projectBindingId: 'pb_bad', mode: 'text', query: 'ipcSymbol' });
      assert.equal(malformed.code, 'ENGINEERING_PROJECT_BINDING_INVALID');
      assert.equal((await handlers.unbind(owner, { projectBindingId: token.projectBindingId })).ok, true);
      assert.equal((await handlers.status(owner, { projectBindingId: token.projectBindingId })).code, 'ENGINEERING_PROJECT_BINDING_INVALID');
      handlers.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns INDEX_DISABLED for agent status reads when indexing is switched off', () => {
    const root = tempProject();
    try {
      const handlers = createEngineeringIpcHandlers({ isIndexEnabled: () => false });
      assert.equal(handlers.indexStatus(root).code, 'INDEX_DISABLED');
      handlers.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('releases only the unbound project watcher for a sender', async () => {
    const firstRoot = tempProject();
    const secondRoot = tempProject();
    try {
      const handlers = createEngineeringIpcHandlers();
      const owner = event(18);
      const first = handlers.bind(owner, { projectPath: firstRoot, projectBindingId: makeToken('9') });
      const second = handlers.bind(owner, { projectPath: secondRoot, projectBindingId: makeToken('10') });
      await handlers.ensure(owner, { projectBindingId: first.projectBindingId });
      await handlers.ensure(owner, { projectBindingId: second.projectBindingId });
      assert.equal(handlers.indexes.size, 2);
      assert.equal(handlers.dropProject(owner, firstRoot), true);
      assert.equal(handlers.indexes.size, 1);
      assert.equal((await handlers.status(owner, { projectBindingId: second.projectBindingId })).ok, true);
      handlers.close();
    } finally {
      fs.rmSync(firstRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it('enforces the index switch and keeps location bounded to project-relative files', async () => {
    const root = tempProject();
    try {
      const handlers = createEngineeringIpcHandlers({ isIndexEnabled: () => false });
      const owner = event(12);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('2') });
      const disabled = await handlers.ensure(owner, { projectBindingId: token.projectBindingId });
      assert.equal(disabled.code, 'INDEX_DISABLED');

      const enabled = createEngineeringIpcHandlers({ isIndexEnabled: () => true });
      const enabledToken = enabled.bind(owner, { projectPath: root, projectBindingId: makeToken('3') });
      await enabled.ensure(owner, { projectBindingId: enabledToken.projectBindingId });
      const outside = await enabled.location(owner, { projectBindingId: enabledToken.projectBindingId, path: '../secret.txt', line: 1 });
      assert.equal(outside.code, 'INDEX_LOCATION_INVALID');
      const bounded = await enabled.location(owner, { projectBindingId: enabledToken.projectBindingId, path: 'index.js', line: 1, context: 0 });
      assert.equal(bounded.ok, true);
      assert.equal(bounded.path, 'index.js');
      enabled.close();
      handlers.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('saves profiles through main normalization and never executes renderer command/path fields', async () => {
    const root = tempProject();
    const calls = [];
    const events = [];
    let storedProfiles = [];
    try {
      const handlers = createEngineeringIpcHandlers({
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; calls.push(['persist', profiles]); },
        getSettings: () => ({ terminalEnabled: true }),
        createPermissionGate: () => ({ authorize: async () => ({ allowed: true, decision: 'allow_session' }) }),
        runTerminal: async (projectRoot, command, options) => {
          calls.push(['run', projectRoot, command, options.cwd]);
          return { ok: true, code: 0, stdout: 'passed', stderr: '' };
        },
        onEvent: (item, owners) => events.push({ item, owners }),
      });
      const owner = event(13);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('4') });
      const saved = await handlers.saveProfile(owner, {
        projectBindingId: token.projectBindingId,
        profile: {
          id: 'not-main-generated',
          name: '  Tests  ',
          kind: 'test',
          command: 'node -e "process.stdout.write(\'ok\')"',
          cwd: '.',
          timeoutMs: 30000,
          enabled: true,
          projectPath: 'D:/injected',
          environment: { SECRET: 'must-not-cross' },
        },
      });
      assert.equal(saved.ok, true);
      assert.match(saved.profile.id, /^vfy_[a-f0-9]{16}$/);
      assert.equal(calls[0][0], 'persist');
      assert.equal('projectPath' in calls[0][1][0], false);
      assert.equal('environment' in calls[0][1][0], false);

      const run = await handlers.run(owner, {
        projectBindingId: token.projectBindingId,
        profileId: saved.profile.id,
        sessionId: 'session-1',
        command: 'del /s /q C:\\',
        cwd: 'D:/injected',
      });
      assert.equal(run.ok, true);
      assert.equal(calls.find((item) => item[0] === 'run')[1], root.toLowerCase());
      assert.equal(calls.find((item) => item[0] === 'run')[2], saved.profile.command);
      assert.equal(calls.find((item) => item[0] === 'run')[3], root.toLowerCase());
      assert.ok(events.some((entry) => entry.item.reason === 'finished' && entry.owners.includes(13)));
      handlers.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('revokes only the named profile grant and refuses a missing or forged profileId', async () => {
    const root = tempProject();
    let storedProfiles = [];
    const authorized = [];
    try {
      const handlers = createEngineeringIpcHandlers({
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; },
        getSettings: () => ({ terminalEnabled: true }),
        createPermissionGate: () => ({
          authorize: async (request) => {
            authorized.push(request.summary);
            return { allowed: true, decision: 'allow_session' };
          },
        }),
        runTerminal: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      });
      const owner = event(15);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('6') });
      const bindingId = token.projectBindingId;
      const keep = await handlers.saveProfile(owner, { projectBindingId: bindingId, profile: { name: 'Keep', kind: 'test', command: 'node -v', cwd: '.', timeoutMs: 30000, enabled: true } });
      const drop = await handlers.saveProfile(owner, { projectBindingId: bindingId, profile: { name: 'Drop', kind: 'lint', command: 'node -e 0', cwd: '.', timeoutMs: 30000, enabled: true } });

      // First run of each profile persists a project+fingerprint grant.
      await handlers.run(owner, { projectBindingId: bindingId, profileId: keep.profile.id });
      await handlers.run(owner, { projectBindingId: bindingId, profileId: drop.profile.id });
      assert.equal(authorized.length, 2);

      // An absent profileId must not be read as "revoke everything": preload
      // always sends a string, so '' would otherwise clear the whole project.
      const blank = await handlers.revokeGrant(owner, { projectBindingId: bindingId });
      assert.equal(blank.ok, false);
      assert.equal(blank.code, 'VERIFICATION_PROFILE_NOT_FOUND');
      const forged = await handlers.revokeGrant(owner, { projectBindingId: bindingId, profileId: 'internal-profile' });
      assert.equal(forged.code, 'VERIFICATION_PROFILE_NOT_FOUND');

      await handlers.run(owner, { projectBindingId: bindingId, profileId: keep.profile.id });
      await handlers.run(owner, { projectBindingId: bindingId, profileId: drop.profile.id });
      assert.equal(authorized.length, 2, '既有授权不应被空 profileId 清空');

      assert.equal((await handlers.revokeGrant(owner, { projectBindingId: bindingId, profileId: drop.profile.id })).ok, true);
      await handlers.run(owner, { projectBindingId: bindingId, profileId: keep.profile.id });
      assert.equal(authorized.length, 2, '未撤销的档案仍复用授权');
      await handlers.run(owner, { projectBindingId: bindingId, profileId: drop.profile.id });
      assert.equal(authorized.length, 3, '撤销后的档案必须重新审批');
      handlers.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores unfinished jobs as interrupted at startup without running a command', async () => {
    const root = tempProject();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-restore-'));
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text, 'utf8'),
      decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
    };
    let storedProfiles = [];
    try {
      let released = () => {};
      const first = createEngineeringIpcHandlers({
        userDataPath: userData,
        safeStorage,
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; },
        getSettings: () => ({ terminalEnabled: true }),
        createPermissionGate: () => ({ authorize: async () => ({ allowed: true, decision: 'allow_session' }) }),
        // Never settles, so the job is still 'running' when the app quits.
        runTerminal: () => new Promise((resolve) => { released = () => resolve({ ok: true, code: 0, stdout: '', stderr: '' }); }),
      });
      const owner = event(16);
      const token = first.bind(owner, { projectPath: root, projectBindingId: makeToken('7') });
      const profile = await first.saveProfile(owner, { projectBindingId: token.projectBindingId, profile: { name: 'Hang', kind: 'test', command: 'node -v', cwd: '.', timeoutMs: 300000, enabled: true } });
      const started = await first.run(owner, { projectBindingId: token.projectBindingId, profileId: profile.profile.id });
      assert.equal(started.ok, true);
      first.close();
      released();

      const runs = [];
      const second = createEngineeringIpcHandlers({
        userDataPath: userData,
        safeStorage,
        getProfiles: () => storedProfiles,
        setProfiles: () => {},
        getSettings: () => ({ terminalEnabled: true }),
        runTerminal: async () => { runs.push('ran'); return { ok: true, code: 0, stdout: '', stderr: '' }; },
      });
      const restored = second.restoreAtStartup();
      assert.equal(restored.ok, true);
      assert.equal(restored.interrupted, 1);
      assert.deepEqual(runs, [], '恢复不得自动执行命令');

      const reader = event(17);
      const reboundToken = second.bind(reader, { projectPath: root, projectBindingId: makeToken('8') });
      const listed = await second.list(reader, { projectBindingId: reboundToken.projectBindingId });
      assert.equal(listed.jobs.length, 1);
      assert.equal(listed.jobs[0].status, 'interrupted');
      assert.equal(listed.jobs[0].jobRef, started.job.jobRef);
      second.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('rejects forged profile/job references and preserves opaque public results', async () => {
    const root = tempProject();
    try {
      const handlers = createEngineeringIpcHandlers();
      const owner = event(14);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('5') });
      assert.equal((await handlers.get(owner, { projectBindingId: token.projectBindingId, jobRef: 'internal-id' })).code, 'VERIFICATION_JOB_NOT_FOUND');
      assert.equal((await handlers.result(owner, { projectBindingId: token.projectBindingId, jobRef: 'internal-id' })).code, 'VERIFICATION_JOB_NOT_FOUND');
      assert.equal((await handlers.deleteProfile(owner, { projectBindingId: token.projectBindingId, profileId: 'internal-profile' })).code, 'VERIFICATION_PROFILE_NOT_FOUND');
      const listed = await handlers.profiles(owner, { projectBindingId: token.projectBindingId });
      assert.equal(listed.ok, true);
      assert.ok(Array.isArray(listed.profiles));
      handlers.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('owns D12 workflow definitions and runs by sender binding and broadcasts project-scoped events', async () => {
    const root = tempProject();
    let storedProfiles = [];
    const events = [];
    try {
      const handlers = createEngineeringIpcHandlers({
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; },
        getSettings: () => ({ terminalEnabled: true }),
        workspaceFingerprint: () => 'workspace-fp',
        createPermissionGate: () => ({ authorize: async () => ({ allowed: true, decision: 'allow_session' }), cancelPending: () => 0 }),
        runTerminal: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
        onEvent: (item, owners) => events.push({ item, owners }),
      });
      const owner = event(21);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('11') });
      const profile = await handlers.saveProfile(owner, {
        projectBindingId: token.projectBindingId,
        profile: { name: 'Tests', kind: 'test', command: 'node -v', cwd: '.', timeoutMs: 30000, enabled: true },
      });
      const saved = await handlers.workflowSave(owner, {
        projectBindingId: token.projectBindingId,
        workflow: {
          name: 'Gate',
          command: 'renderer-command-must-be-ignored',
          projectPath: 'D:/forged',
          nodes: [{ nodeId: 'test', profileId: profile.profile.id, dependsOn: [], command: 'ignored' }],
        },
      });
      assert.equal(saved.ok, true);
      assert.match(saved.workflow.workflowId, /^wf_[a-f0-9]{16}$/);
      assert.equal('command' in saved.workflow, false);
      assert.equal('projectPath' in saved.workflow, false);

      const forgedCreate = await handlers.workflowSave(owner, {
        projectBindingId: token.projectBindingId,
        workflow: { workflowId: 'wf_' + 'a'.repeat(16), name: 'Forged', nodes: [{ nodeId: 'test', profileId: profile.profile.id }] },
      });
      assert.equal(forgedCreate.code, 'WORKFLOW_RUN_NOT_FOUND');
      assert.equal((await handlers.workflows(event(22), { projectBindingId: token.projectBindingId })).code, 'ENGINEERING_PROJECT_BINDING_INVALID');

      const started = await handlers.workflowRun(owner, { projectBindingId: token.projectBindingId, workflowId: saved.workflow.workflowId });
      assert.equal(started.ok, true);
      const deadline = Date.now() + 2000;
      let run;
      do {
        run = await handlers.workflowResult(owner, { projectBindingId: token.projectBindingId, workflowRunRef: started.workflowRunRef });
        if (run?.run?.status === 'passed') break;
        if (Date.now() > deadline) throw new Error('workflow did not finish');
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (true);
      assert.ok(events.some((entry) => entry.item.type === 'engineering:workflow:event'
        && entry.item.reason === 'finished' && entry.owners.includes(21)));
      const gate = await handlers.workflowGateCheck(owner, {
        projectBindingId: token.projectBindingId,
        workflowRunRef: started.workflowRunRef,
        action: 'apply',
        expectedFingerprint: 'workspace-fp',
      });
      assert.equal(gate.ok, true);
      assert.equal(gate.summary.completedAt, run.run.finishedAt);
      handlers.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('routes D13 repair channels through sender bindings and rejects forged source fields', async () => {
    const root = tempProject();
    let storedProfiles = [];
    try {
      const handlers = createEngineeringIpcHandlers({
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; },
        getSettings: () => ({ terminalEnabled: true, permissionMode: 'full-auto' }),
        createPermissionGate: () => ({ authorize: async () => ({ allowed: true, decision: 'allow_session' }) }),
        runTerminal: async () => ({ ok: false, code: 1, stdout: 'failure', stderr: '' }),
        subagentRuntime: {
          runIsolatedImplement: async () => ({ ok: true, terminalReason: 'completed', result: { id: 'wt_ipc01', changed: false } }),
        },
      });
      const owner = event(31);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('31') });
      const profile = await handlers.saveProfile(owner, { projectBindingId: token.projectBindingId, profile: { name: 'Repair source', kind: 'test', command: 'node -e "process.exit(1)"', cwd: '.', timeoutMs: 30000, enabled: true } });
      const failed = await handlers.run(owner, { projectBindingId: token.projectBindingId, profileId: profile.profile.id });
      assert.equal(failed.ok, true);
      let failedJob;
      for (let i = 0; i < 100; i += 1) {
        const jobs = await handlers.list(owner, { projectBindingId: token.projectBindingId, limit: 10 });
        failedJob = jobs.jobs?.find((job) => job.jobRef === failed.job.jobRef);
        if (failedJob?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(failedJob?.status, 'failed');
      const started = await handlers.repairStart(owner, {
        projectBindingId: token.projectBindingId,
        source: { kind: 'verification', jobRef: failed.job.jobRef, command: 'forged', projectPath: 'D:/forged' },
        note: 'user note', sessionId: 'session-31',
      });
      assert.equal(started.ok, false);
      assert.equal(started.code, 'REPAIR_SOURCE_INVALID');

      const valid = await handlers.repairStart(owner, {
        projectBindingId: token.projectBindingId,
        source: { kind: 'verification', jobRef: failed.job.jobRef },
        note: 'user note', sessionId: 'session-31',
      });
      assert.equal(valid.ok, true, JSON.stringify(valid));
      assert.match(valid.repairRef, /^rpr_[a-f0-9]{24}$/);
      const foreign = await handlers.repairGet(event(32), { projectBindingId: token.projectBindingId, repairRef: valid.repairRef });
      assert.equal(foreign.code, 'ENGINEERING_PROJECT_BINDING_INVALID');
      const listed = await handlers.repairList(owner, { projectBindingId: token.projectBindingId, limit: 10 });
      assert.equal(listed.ok, true);
      assert.equal(listed.repairs[0].repairRef, valid.repairRef);
      const result = await handlers.repairResult(owner, { projectBindingId: token.projectBindingId, repairRef: valid.repairRef });
      assert.equal(result.ok, true);
      assert.equal(result.repair.note, undefined);
      assert.equal(result.repair.prompt, undefined);
      handlers.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('limits Agent repair cancellation to the creating run owner', async () => {
    const root = tempProject();
    let storedProfiles = [];
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    try {
      const handlers = createEngineeringIpcHandlers({
        getProfiles: () => storedProfiles,
        setProfiles: (_root, profiles) => { storedProfiles = profiles; },
        getSettings: () => ({ terminalEnabled: true, permissionMode: 'full-auto' }),
        createPermissionGate: () => ({ authorize: async () => ({ allowed: true, decision: 'allow_session' }) }),
        runTerminal: async () => ({ ok: false, code: 1, stdout: '', stderr: '' }),
        subagentRuntime: {
          runIsolatedImplement: async ({ signal }) => new Promise((resolve) => {
            entered();
            signal.addEventListener('abort', () => resolve({ ok: true, terminalReason: 'aborted', incomplete: true, result: { id: 'wt_ipc02', changed: true } }), { once: true });
          }),
        },
      });
      const owner = event(33);
      const token = handlers.bind(owner, { projectPath: root, projectBindingId: makeToken('33') });
      const profile = await handlers.saveProfile(owner, { projectBindingId: token.projectBindingId, profile: { name: 'Repair owner', kind: 'test', command: 'node -e "process.exit(1)"', cwd: '.', timeoutMs: 30000, enabled: true } });
      const failed = await handlers.run(owner, { projectBindingId: token.projectBindingId, profileId: profile.profile.id });
      let failedJob;
      for (let i = 0; i < 100; i += 1) {
        const jobs = await handlers.list(owner, { projectBindingId: token.projectBindingId, limit: 10 });
        failedJob = jobs.jobs?.find((job) => job.jobRef === failed.job.jobRef);
        if (failedJob?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const agentStart = handlers.repairStartForAgent(root, { source: { kind: 'verification', jobRef: failed.job.jobRef } }, { agentRunId: 'run-a', ownerId: 33 });
      await enteredPromise;
      const repairList = await handlers.repairListForAgent(root, 10);
      const repairRef = repairList.repairs[0].repairRef;
      const foreign = await handlers.repairCancelForAgent(root, repairRef, { agentRunId: 'run-b' });
      assert.equal(foreign.ok, false);
      assert.equal(foreign.code, 'REPAIR_CANCEL_FAILED');
      const own = await handlers.repairCancelForAgent(root, repairRef, { agentRunId: 'run-a' });
      assert.equal(own.ok, true);
      await agentStart;
      handlers.close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
