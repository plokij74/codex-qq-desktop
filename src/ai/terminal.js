'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { verifyPathSandbox, buildSanitizedEnv, terminateProcessTree } = require('./os-isolation');
const { redactSecrets, defaultSecretManager, createSecretOutputBuffer } = require('./secret-manager');
const { consumeHostExecutionGrant } = require('./host-execution');
const BLOCKED = [/^\s*format\s+/i, /^\s*shutdown\s+/i, /^\s*rm\s+-rf\s+[\\/]/i, /^\s*del\s+\/s\s+\/q\s+[a-z]:\\/i, /Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\/i];
function assertInsideProject(projectRoot, cwd) {
  return verifyPathSandbox(projectRoot, cwd || projectRoot, { mode: 'read' }).canonicalTarget;
}
function isBlockedCommand(command) { return BLOCKED.some((re) => re.test(String(command || ''))); }
function runTerminal(projectRoot, command, opts = {}) {
  const cwd = assertInsideProject(projectRoot, opts.cwd || projectRoot);
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('命令为空');
  if (isBlockedCommand(cmd)) throw new Error('命令被安全策略拦截');
  if (opts.signal?.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  const native = require('./windows-isolation');
  const isolatedScope = native.consumeIsolatedExecutionGrant(opts.hostExecutionGrant, { projectRoot, cwd, command: cmd, sessionKey: opts.sessionKey });
  if (isolatedScope) return native.runWindowsIsolated(isolatedScope, opts);
  const injected = consumeHostExecutionGrant(opts.hostExecutionGrant, { projectRoot, cwd, command: cmd, sessionKey: opts.sessionKey });
  const env = buildSanitizedEnv(opts.env);
  for (const [key, value] of Object.entries(injected)) { env[key] = value; defaultSecretManager.registerSecret(value, key); }
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || 60000);
  return new Promise((resolve) => {
    const executable = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', cmd] : ['-c', cmd];
    const child = spawn(executable, args, { cwd, windowsHide: true, env, detached: process.platform !== 'win32' });
    let aborted = false; let timedOut = false; let settled = false;
    const stdout = createSecretOutputBuffer(opts.onStdout);
    const stderr = createSecretOutputBuffer(opts.onStderr);
    const stop = () => { if (child.pid) terminateProcessTree(child.pid); };
    const onAbort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout.on('data', (chunk) => stdout.write(chunk));
    child.stderr.on('data', (chunk) => stderr.write(chunk));
    const finish = (code, error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
      if (error) stderr.write(redactSecrets(error.message));
      let out = ''; let err = '';
      try { out = stdout.flush(); } catch (_) {}
      try { err = stderr.flush(); } catch (_) {}
      resolve({ ok: !error && !aborted && !timedOut && code === 0, code: aborted || timedOut ? -1 : code, stdout: out, stderr: err,
        cwd, command: redactSecrets(cmd), timedOut, aborted, executionMode: 'host-unconfined', isolated: false, outputBuffered: true });
    };
    child.once('error', (error) => finish(-1, error));
    child.once('close', (code) => finish(code));
    if (typeof opts.onSpawn === 'function') { try { opts.onSpawn(child); } catch (_) {} }
  });
}
module.exports = { runTerminal, isBlockedCommand, assertInsideProject };
