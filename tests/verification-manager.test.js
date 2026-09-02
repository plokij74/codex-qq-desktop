'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createVerificationManager,
  normalizeProfile,
  detectVerificationProfiles,
  MAX_OUTPUT_BYTES,
} = require('../src/ai/verification-manager');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function profile(overrides = {}) {
  return {
    id: 'vfy_12345678',
    name: 'Project tests',
    kind: 'test',
    command: 'npm test',
    cwd: '.',
    timeoutMs: 30000,
    enabled: true,
    ...overrides,
  };
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(Buffer.from(String(value), 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
    },
    decryptString(value) {
      const encoded = Buffer.from(value).toString('utf8').split('').reverse().join('');
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
  };
}

async function waitFor(manager, jobRef, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = manager.get(jobRef);
    if (current?.status === expected) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`job ${jobRef} did not reach ${expected}; current=${manager.get(jobRef)?.status}`);
}

describe('D11 verification manager', () => {
  it('normalizes profiles, rejects unsafe commands/cwd, and only detects known project files', () => {
    const root = tempDir('codex-d11-vfy-profile-');
    try {
      const normalized = normalizeProfile(profile({ timeoutMs: 1 }), root);
      assert.equal(normalized.timeoutMs, 5000);
      assert.throws(() => normalizeProfile(profile({ cwd: '../outside' }), root), (error) => error.code === 'VERIFICATION_PROFILE_INVALID');
      assert.throws(() => normalizeProfile(profile({ command: 'npm test\nwhoami' }), root), (error) => error.code === 'VERIFICATION_PROFILE_INVALID');
      assert.throws(() => normalizeProfile(profile({ command: 'rm -rf /' }), root), (error) => error.code === 'VERIFICATION_PROFILE_INVALID');
      assert.throws(() => normalizeProfile(profile({ command: 'echo before; rm -rf /' }), root), (error) => error.code === 'VERIFICATION_PROFILE_INVALID');

      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js', lint: 'eslint .' } }), 'utf8');
      fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/demo\n', 'utf8');
      const candidates = detectVerificationProfiles(root);
      assert.deepEqual(candidates.map((item) => item.command), ['npm test', 'npm run lint', 'go test ./...']);
      assert.ok(candidates.every((item) => item.candidate === true));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires first approval, persists allow_session by profile fingerprint, and skips repeat approval after restart', async () => {
    const root = tempDir('codex-d11-vfy-grant-project-');
    const userData = tempDir('codex-d11-vfy-grant-data-');
    const safeStorage = fakeSafeStorage();
    let approvals = 0;
    const runner = async () => ({ ok: true, code: 0, stdout: 'ok', stderr: '' });
    try {
      const first = createVerificationManager({ projectPath: root, userDataPath: userData, safeStorage, runTerminal: runner });
      first.replaceProfiles(root, [profile()]);
      const started = await first.start({
        projectPath: root,
        profileId: profile().id,
        settings: { terminalEnabled: true },
        permissionGate: {
          authorize: async () => {
            approvals += 1;
            return { allowed: true, decision: 'allow_session' };
          },
        },
      });
      assert.equal(started.ok, true);
      await waitFor(first, started.jobRef, 'passed');
      assert.equal(approvals, 1);
      first.close();

      const grantsDisk = fs.readFileSync(path.join(userData, 'engineering-verification-grants.json'), 'utf8');
      assert.doesNotMatch(grantsDisk, /npm test|Project tests|vfy_12345678/);

      const second = createVerificationManager({ projectPath: root, userDataPath: userData, safeStorage, runTerminal: runner });
      second.replaceProfiles(root, [profile()]);
      const repeated = await second.start({
        projectPath: root,
        profileId: profile().id,
        settings: { terminalEnabled: true },
        permissionGate: { authorize: async () => { approvals += 1; return { allowed: false }; } },
      });
      assert.equal(repeated.ok, true);
      await waitFor(second, repeated.jobRef, 'passed');
      assert.equal(approvals, 1);
      second.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('keeps one running job per project and supports queued and running cancellation', async () => {
    const root = tempDir('codex-d11-vfy-cancel-');
    let active = 0;
    let maxActive = 0;
    const runner = (_root, _command, options) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const finish = () => {
        active -= 1;
        resolve({ ok: false, code: -1, stdout: '', stderr: '', aborted: true });
      };
      if (options.signal.aborted) finish();
      else options.signal.addEventListener('abort', finish, { once: true });
    });
    try {
      const manager = createVerificationManager({ projectPath: root, safeStorage: null, runTerminal: runner });
      manager.replaceProfiles(root, [profile()]);
      const args = { projectPath: root, profileId: profile().id, settings: { terminalEnabled: true }, preAuthorized: true };
      const first = await manager.start(args);
      const second = await manager.start(args);
      await waitFor(manager, first.jobRef, 'running');
      assert.equal(manager.get(second.jobRef).status, 'queued');
      assert.equal((await manager.cancel(second.jobRef, root)).job.status, 'cancelled');
      assert.equal((await manager.cancel(first.jobRef, root)).ok, true);
      await waitFor(manager, first.jobRef, 'cancelled');
      assert.equal(maxActive, 1);
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies timed out and stale runs without claiming success', async () => {
    const timeoutRoot = tempDir('codex-d11-vfy-timeout-');
    const staleRoot = tempDir('codex-d11-vfy-stale-');
    try {
      fs.writeFileSync(path.join(staleRoot, 'tracked.txt'), 'before', 'utf8');
      const timed = createVerificationManager({
        projectPath: timeoutRoot,
        safeStorage: null,
        runTerminal: async () => ({ ok: false, code: -1, timedOut: true, stdout: '', stderr: '' }),
      });
      timed.replaceProfiles(timeoutRoot, [profile()]);
      const timedJob = await timed.start({ projectPath: timeoutRoot, profileId: profile().id, settings: { terminalEnabled: true }, preAuthorized: true });
      await waitFor(timed, timedJob.jobRef, 'timed_out');
      timed.close();

      const stale = createVerificationManager({
        projectPath: staleRoot,
        safeStorage: null,
        runTerminal: async () => {
          fs.writeFileSync(path.join(staleRoot, 'tracked.txt'), 'after', 'utf8');
          return { ok: true, code: 0, stdout: 'passed', stderr: '' };
        },
      });
      stale.replaceProfiles(staleRoot, [profile()]);
      const staleJob = await stale.start({ projectPath: staleRoot, profileId: profile().id, settings: { terminalEnabled: true }, preAuthorized: true });
      const finished = await waitFor(stale, staleJob.jobRef, 'stale');
      assert.equal(finished.exitCode, 0);
      assert.match(finished.statusMessage, /工作区/);
      stale.close();
    } finally {
      fs.rmSync(timeoutRoot, { recursive: true, force: true });
      fs.rmSync(staleRoot, { recursive: true, force: true });
    }
  });

  it('bounds and redacts output, then exposes normalized diagnostics only', async () => {
    const root = tempDir('codex-d11-vfy-output-');
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'app.ts'), '', 'utf8');
      const manager = createVerificationManager({
        projectPath: root,
        safeStorage: null,
        runTerminal: async (_project, _command, options) => {
          options.onStdout(`${path.join(root, 'src', 'app.ts')}:2:4: error TS2322: bad token sk-abcdefghijklmnop\n`);
          options.onStdout('x'.repeat(MAX_OUTPUT_BYTES + 4096));
          options.onStderr('Authorization: Bearer top-secret-value');
          return { ok: false, code: 1, stdout: '', stderr: '' };
        },
      });
      manager.replaceProfiles(root, [profile()]);
      const started = await manager.start({ projectPath: root, profileId: profile().id, settings: { terminalEnabled: true }, preAuthorized: true });
      await waitFor(manager, started.jobRef, 'failed');
      const result = manager.result(started.jobRef, root);
      assert.equal(result.ok, true);
      assert.equal(result.job.outputTruncated, true);
      assert.ok(Buffer.byteLength(result.job.stdout, 'utf8') <= MAX_OUTPUT_BYTES);
      assert.doesNotMatch(`${result.job.stdout}\n${result.job.stderr}`, /top-secret-value|sk-abcdefghijklmnop/);
      assert.doesNotMatch(`${result.job.stdout}\n${result.job.stderr}`, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.equal(result.job.diagnostics[0].path, 'src/app.ts');
      assert.equal(result.job.diagnostics[0].code, 'TS2322');
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to start when the terminal switch is off and never touches runTerminal', async () => {
    const root = tempDir('codex-d11-vfy-terminal-');
    let executions = 0;
    try {
      const manager = createVerificationManager({
        projectPath: root,
        safeStorage: null,
        runTerminal: async () => { executions += 1; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      });
      manager.replaceProfiles(root, [profile()]);
      const denied = await manager.start({ projectPath: root, profileId: profile().id, settings: { terminalEnabled: false }, preAuthorized: true });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, 'VERIFICATION_TERMINAL_DISABLED');
      const missing = await manager.start({ projectPath: root, profileId: profile().id, settings: {}, preAuthorized: true });
      assert.equal(missing.code, 'VERIFICATION_TERMINAL_DISABLED');
      assert.equal(executions, 0);
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a dangerous command that reaches it from a hand-edited settings file', () => {
    const root = tempDir('codex-d11-vfy-blocked-');
    try {
      const manager = createVerificationManager({ projectPath: root, safeStorage: null, runTerminal: async () => ({ ok: true, code: 0 }) });
      // Defense in depth: settings.js normalization does not apply the terminal
      // blocklist, so replaceProfiles must reject it rather than surface a
      // runnable profile.
      manager.replaceProfiles(root, [
        profile({ id: 'vfy_aaaaaaaa', name: 'Wipe', command: 'rm -rf /' }),
        profile({ id: 'vfy_bbbbbbbb', name: 'Format', command: 'format C: /y' }),
        profile({ id: 'vfy_cccccccc', name: 'Safe', command: 'npm test' }),
      ]);
      const kept = manager.listProfiles(root, { includeDisabled: true, includeCommand: true });
      assert.deepEqual(kept.map((item) => item.name), ['Safe']);
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a fresh approval after its grant is revoked', async () => {
    const root = tempDir('codex-d11-vfy-revoke-');
    const approvals = [];
    try {
      const manager = createVerificationManager({
        projectPath: root,
        safeStorage: null,
        runTerminal: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      });
      manager.replaceProfiles(root, [profile()]);
      const gate = { authorize: async () => { approvals.push('asked'); return { allowed: true, decision: 'allow_session' }; } };
      const options = { projectPath: root, profileId: profile().id, settings: { terminalEnabled: true }, permissionGate: gate };

      const first = await manager.start(options);
      await waitFor(manager, first.jobRef, 'passed');
      const second = await manager.start(options);
      await waitFor(manager, second.jobRef, 'passed');
      assert.equal(approvals.length, 1, '持久授权应抑制重复审批');

      assert.equal(manager.revokeGrant(root, profile().id).ok, true);
      const third = await manager.start(options);
      await waitFor(manager, third.jobRef, 'passed');
      assert.equal(approvals.length, 2, '撤销后必须重新审批');

      // Without a gate the manager fails closed instead of running unauthorized.
      manager.revokeGrant(root, profile().id);
      const blocked = await manager.start({ projectPath: root, profileId: profile().id, settings: { terminalEnabled: true } });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'VERIFICATION_APPROVAL_REQUIRED');
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to rerun an old job after its saved profile fingerprint changes', async () => {
    const root = tempDir('codex-d11-vfy-rerun-');
    try {
      const manager = createVerificationManager({
        projectPath: root,
        safeStorage: null,
        runTerminal: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      });
      manager.replaceProfiles(root, [profile()]);
      const started = await manager.start({ projectPath: root, profileId: profile().id, settings: { terminalEnabled: true }, preAuthorized: true });
      await waitFor(manager, started.jobRef, 'passed');
      manager.replaceProfiles(root, [profile({ command: 'npm run test:changed' })]);
      const rerun = await manager.rerun(started.jobRef, {
        projectPath: root,
        settings: { terminalEnabled: true },
        preAuthorized: true,
      });
      assert.equal(rerun.ok, false);
      assert.equal(rerun.code, 'VERIFICATION_PROFILE_CHANGED');
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores queued or running persisted jobs as interrupted without executing them', () => {
    const root = tempDir('codex-d11-vfy-recover-project-');
    const userData = tempDir('codex-d11-vfy-recover-data-');
    const safeStorage = fakeSafeStorage();
    const jobsPath = path.join(userData, 'engineering-jobs.json');
    let executions = 0;
    try {
      const stored = [{
        jobRef: 'vfy_job_1234567890abcdef12345678',
        projectKey: require('../src/ai/project-index').projectKey(root),
        projectBindingFingerprint: 'binding',
        profileId: profile().id,
        profileName: profile().name,
        profileFingerprint: 'f'.repeat(64),
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
        stdout: '', stderr: '', diagnostics: [], outputTruncated: false,
      }];
      const encrypted = safeStorage.encryptString(JSON.stringify(stored));
      fs.writeFileSync(jobsPath, JSON.stringify({ version: 1, cipher: 'electron-safeStorage', payload: Buffer.from(encrypted).toString('base64') }), 'utf8');

      const manager = createVerificationManager({
        projectPath: root,
        userDataPath: userData,
        safeStorage,
        runTerminal: async () => { executions += 1; return { ok: true, code: 0 }; },
      });
      const restored = manager.get(stored[0].jobRef, root);
      assert.equal(restored.status, 'interrupted');
      assert.equal(executions, 0);
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('restores persisted diagnostics without crashing or exposing absolute paths', () => {
    const root = tempDir('codex-d11-vfy-diagnostic-recover-project-');
    const userData = tempDir('codex-d11-vfy-diagnostic-recover-data-');
    const safeStorage = fakeSafeStorage();
    const jobsPath = path.join(userData, 'engineering-jobs.json');
    try {
      const stored = [{
        jobRef: 'vfy_job_abcdefabcdefabcdefabcdef',
        projectKey: require('../src/ai/project-index').projectKey(root),
        projectBindingFingerprint: 'binding',
        profileId: profile().id,
        profileName: profile().name,
        profileFingerprint: 'f'.repeat(64),
        status: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:02.000Z',
        stdout: '', stderr: '', outputTruncated: false,
        diagnostics: [{
          path: 'src/app.ts', line: 2, column: 4, severity: 'error',
          code: 'TS2322', message: `${root}\\src\\app.ts: bad secret`, source: 'tsc',
        }],
      }];
      const encrypted = safeStorage.encryptString(JSON.stringify(stored));
      fs.writeFileSync(jobsPath, JSON.stringify({
        version: 1, cipher: 'electron-safeStorage',
        payload: Buffer.from(encrypted).toString('base64'),
      }), 'utf8');

      const manager = createVerificationManager({ projectPath: root, userDataPath: userData, safeStorage });
      const result = manager.result(stored[0].jobRef, root);
      assert.equal(result.ok, true);
      assert.equal(result.job.diagnostics[0].path, 'src/app.ts');
      assert.doesNotMatch(result.job.diagnostics[0].message, new RegExp(root.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'i'));
      manager.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
