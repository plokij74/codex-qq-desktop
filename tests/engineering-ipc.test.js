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
});
