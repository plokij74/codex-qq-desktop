'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { inspectNativeBuild, hash } = require('./native-isolation-build');
const { redactSecrets, createSecretOutputBuffer } = require('./secret-manager');
const grants = new WeakMap();
const ttlMs = 60_000;
let pinnedBuild = null;
const cacheBase = path.join(os.tmpdir(), `codex-qq-native-${hash(Buffer.from(os.userInfo().username)).slice(0, 16)}`);
const journalDirectory = path.join(cacheBase, 'jobs');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function getWindowsIsolationStatus() {
  const build = inspectNativeBuild();
  if (!build.available) return { available: false, reason: build.reason };
  if (pinnedBuild && pinnedBuild.executableHash !== build.executableHash) return { available: false, reason: 'Native launcher changed while the application was running; restart is required' };
  pinnedBuild ||= build;
  return { available: true, backend: 'windows-appcontainer-job', version: 1, networkPolicy: 'deny-all', maxProcesses: 16, maxProcessMemoryBytes: 512 * 1024 * 1024, maxJobMemoryBytes: 1024 * 1024 * 1024, maxTimeoutMs: 120_000, maxOutputBytes: 20_000, maxWorkspaceObjects: 65_536 };
}
function identityOf(request = {}) {
  const { verifyPathSandbox } = require('./os-isolation');
  const command = String(request.command || '').trim();
  if (!command || command.length > 16_384 || command.includes('\0')) throw failure('INVALID_COMMAND', '终端命令为空或超出隔离预算');
  const checked = verifyPathSandbox(request.projectRoot, request.cwd || '.');
  const canonical = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const objectIdentity = (value) => { const stat = fs.statSync(value, { bigint: true }); return stat.dev.toString() + ':' + stat.ino.toString(); };
  const scope = { projectRoot: checked.canonicalRoot, cwd: checked.canonicalTarget, command, sessionKey: String(request.sessionKey || ''), rootObject: objectIdentity(checked.canonicalRoot), cwdObject: objectIdentity(checked.canonicalTarget) };
  if (!scope.sessionKey) throw failure('INVALID_SESSION', '隔离终端缺少会话绑定');
  const physicalCache = fs.existsSync(cacheBase) ? fs.realpathSync.native(cacheBase) : path.resolve(cacheBase);
  const a = canonical(scope.projectRoot), b = canonical(physicalCache);
  if (a === b || b.startsWith(a + path.sep) || a.startsWith(b + path.sep)) throw failure('ISOLATION_BOUNDARY_OVERLAP', '工作区不能包含隔离运行时的私有目录');
  return scope;
}
async function authorizeIsolatedExecution(options = {}) {
  if (!getWindowsIsolationStatus().available) throw failure('OS_ISOLATION_UNAVAILABLE', 'Windows 原生隔离后端不可用；不能静默退回宿主执行');
  const scope = identityOf(options);
  const selectedPolicy = String(options.policyLevel || 'strict-isolated').toLowerCase().replace(/_/g, '-');
  if (!['strict-isolated', 'workspace-write'].includes(selectedPolicy)) throw failure('INVALID_EXECUTION_POLICY', '隔离授权只接受只读或工作区写入策略');
  const workspacePolicy = selectedPolicy === 'workspace-write' ? 'workspace-write' : 'read-only';
  if (options.signal?.aborted) throw failure('ABORTED', '已停止');
  if (typeof options.confirm !== 'function' || !(await options.confirm(Object.freeze({ ...scope, workspacePolicy, executionMode: 'strict-isolated', isolated: true, networkPolicy: 'deny-all' })))) throw failure('ISOLATED_EXECUTION_REQUIRES_CONFIRMATION', '未获得本次隔离执行授权');
  if (options.signal?.aborted) throw failure('ABORTED', '已停止');
  // Never accept renderer/model booleans or serialized permission history.
  const grant = Object.freeze({});
  grants.set(grant, { scope, workspacePolicy, expiresAt: Date.now() + ttlMs });
  return grant;
}
function isIsolatedExecutionGrant(grant) { return !!grant && grants.has(grant); }
function consumeIsolatedExecutionGrant(grant, request) {
  if (!grant || !grants.has(grant)) return null;
  const record = grants.get(grant); grants.delete(grant);
  const scope = identityOf(request);
  if (Date.now() >= record.expiresAt || Object.keys(scope).some((key) => scope[key] !== record.scope[key])) throw failure('INVALID_ISOLATED_EXECUTION_GRANT', '隔离执行授权已失效或与本次命令不匹配');
  return { ...record.scope, workspacePolicy: record.workspacePolicy };
}
function helperEnvironment() {
  const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return { SystemRoot: windows, WINDIR: windows, PATH: path.join(windows, 'System32'), TEMP: os.tmpdir(), TMP: os.tmpdir() };
}
function prepareLauncher() {
  const status = getWindowsIsolationStatus();
  if (!status.available) throw failure('OS_ISOLATION_UNAVAILABLE', status.reason);
  const directory = path.join(cacheBase, 'bin'); fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, `${pinnedBuild.executableHash}.exe`);
  if (!fs.existsSync(executable)) fs.copyFileSync(pinnedBuild.executablePath, executable, fs.constants.COPYFILE_EXCL);
  if (hash(fs.readFileSync(executable)) !== pinnedBuild.executableHash) throw failure('NATIVE_ISOLATION_INTEGRITY_FAILED', '私有启动器完整性检查失败');
  fs.mkdirSync(journalDirectory, { recursive: true });
  return executable;
}
function recoverNativeIsolation() {
  const executable = prepareLauncher();
  const result = spawnSync(executable, ['--recover', journalDirectory], { windowsHide: true, env: helperEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 128_000 });
  if (result.error || result.status !== 0) throw failure('ISOLATION_CLEANUP_FAILED', redactSecrets(result.error?.message || result.stdout || result.stderr || '隔离恢复失败'));
  const record = JSON.parse(result.stdout.trim());
  if (record.type !== 'recovered' || record.ok !== true) throw failure('ISOLATION_CLEANUP_FAILED', '隔离恢复未确认完成');
  return { ok: true };
}
function runWindowsIsolated(scope, opts = {}) {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, code: 'ABORTED', aborted: true, isolated: false, executionMode: 'not-started', stdout: '', stderr: '' });
  const executable = prepareLauncher();
  const timeoutMs = Math.max(100, Math.min(120_000, Number(opts.timeoutMs) || 60_000));
  if (Object.keys(opts.secretEnv || {}).length) throw failure('ISOLATED_SECRET_INJECTION_UNSUPPORTED', '网络全拒绝的隔离命令不接受秘密注入；需要单独的定向授权通道');
  const temp = fs.mkdtempSync(path.join(journalDirectory, 'work-'));
  const { buildSanitizedEnv } = require('./os-isolation');
  const request = { root: scope.projectRoot, cwd: scope.cwd, rootObject: scope.rootObject, cwdObject: scope.cwdObject, command: scope.command, cache: journalDirectory, temp, timeoutMs, policy: scope.workspacePolicy, env: buildSanitizedEnv(opts.env || {}) };
  return new Promise((resolve) => {
    let child, frame = '', frameBytes = 0, diagnostic = '', final = null, started = false, startedProfile = null, settled = false, aborted = false, timedOut = false, protocolError = '';
    const stdout = createSecretOutputBuffer(), stderr = createSecretOutputBuffer();
    const sendCancel = (reason) => { try { child?.stdin.write(reason + '\n'); } catch { /* close handler owns cleanup */ } };
    const onAbort = () => { aborted = true; sendCancel('aborted'); };
    const timer = setTimeout(() => { timedOut = true; sendCancel('timeout'); }, timeoutMs);
    // If the helper is wedged, killing it closes its Job and kills every child.
    // Recovery removes its single-use ACL entries before we return failure.
    const watchdog = setTimeout(() => { protocolError ||= 'Native isolation helper did not stop within its cleanup budget'; child?.kill(); }, timeoutMs + 30_000);
    const finish = (exit, error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(watchdog); opts.signal?.removeEventListener('abort', onAbort);
      let cleanupComplete = final?.cleanupComplete === true, recoveredProfileDeleted = false;
      if (!cleanupComplete) {
        try {
          const journal = startedProfile && path.join(journalDirectory, startedProfile + '.json');
          const hadJournal = !!journal && fs.existsSync(journal);
          recoverNativeIsolation(); cleanupComplete = true;
          recoveredProfileDeleted = hadJournal && !fs.existsSync(journal);
        } catch (cleanupError) { protocolError ||= cleanupError.message; }
      }
      if (final?.outputTruncated) {
        stdout.write('[隔离输出超出预算，已整体省略以避免截断秘密泄露]');
      } else if (final && !protocolError) {
        stdout.write(Buffer.from(final.stdoutBase64 || '', 'base64'));
        stderr.write(Buffer.from(final.stderrBase64 || '', 'base64'));
      }
      const out = stdout.flush(), err = stderr.flush();
      try { if (out) opts.onStdout?.(out); } catch { /* UI callbacks cannot bypass cleanup */ }
      try { if (err) opts.onStderr?.(err); } catch { /* UI callbacks cannot bypass cleanup */ }
      if (cleanupComplete) {
        try {
          const physical = fs.realpathSync.native(temp);
          if (physical !== temp || path.dirname(temp) !== journalDirectory || !path.basename(temp).startsWith('work-')) throw new Error('Private temporary directory identity changed');
          fs.rmSync(temp, { recursive: true, force: true });
        } catch (cleanupError) { cleanupComplete = false; protocolError ||= cleanupError.message; }
      }
      const detail = redactSecrets(protocolError || error?.message || final?.error || diagnostic || '');
      resolve({ ok: final?.ok === true && exit === 0 && !protocolError && !aborted && !timedOut && cleanupComplete,
        code: protocolError || timedOut || aborted || final?.aborted || final?.timedOut ? -1 : final?.exitCode ?? -1,
        errorCode: protocolError ? 'NATIVE_ISOLATION_FAILED' : timedOut || final?.timedOut ? 'TIMEOUT' : aborted || final?.aborted ? 'ABORTED' : final?.ok ? undefined : 'ISOLATED_COMMAND_FAILED',
        error: detail || undefined, exitCode: final?.exitCode ?? null, stdout: out, stderr: err,
        cwd: scope.cwd, command: redactSecrets(scope.command), timedOut: timedOut || final?.timedOut === true, aborted: aborted || final?.aborted === true,
        executionMode: started ? 'strict-isolated' : 'not-started', isolated: started,
        backend: 'windows-appcontainer-job', networkPolicy: 'deny-all', outputBuffered: true, outputTruncated: final?.outputTruncated === true,
        cleanupComplete, profileDeleted: final?.profileDeleted === true || recoveredProfileDeleted, profile: final?.profile || startedProfile || null });
    };
    try {
      child = spawn(executable, [], { cwd: path.dirname(executable), env: helperEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        frameBytes += chunk.length;
        if (frameBytes > 128_000) { protocolError = 'Native protocol exceeded its bounded output budget'; sendCancel('aborted'); return; }
        frame += chunk.toString('utf8');
        let newline;
        while ((newline = frame.indexOf('\n')) >= 0) {
          const line = frame.slice(0, newline).trim(); frame = frame.slice(newline + 1);
          if (!line) continue;
          try {
            const value = JSON.parse(line);
            if (value.type === 'started' && !started && !final && value.isolated === true && Number.isSafeInteger(value.pid) && value.pid > 0) {
              started = true;
              if (!/^CodexE3Exec\.[a-f0-9]{32}$/.test(value.profile || '')) throw new Error('Invalid native profile identity');
              startedProfile = value.profile;
              opts.onSpawn?.({ pid: value.pid, helperPid: child.pid, profile: startedProfile, kill: () => sendCancel('aborted') });
            } else if (value.type === 'result' && !final) final = value;
            else throw new Error('Unexpected native protocol frame');
          } catch (error) { protocolError = error.message; sendCancel('aborted'); }
        }
      });
      child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, 20_000); });
      child.on('error', (error) => finish(null, error));
      child.on('close', (exit) => { if (!final) protocolError ||= 'Native launcher exited without a verified result'; finish(exit); });
      child.stdin.write(JSON.stringify(request) + '\n');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    } catch (error) { finish(null, error); }
  });
}
module.exports = { getWindowsIsolationStatus, authorizeIsolatedExecution, isIsolatedExecutionGrant, consumeIsolatedExecutionGrant, runWindowsIsolated, recoverNativeIsolation };
