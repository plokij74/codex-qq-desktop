'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { verifyPathSandbox, buildSanitizedEnv, terminateProcessTree } = require('./os-isolation');
const { redactSecrets } = require('./secret-manager');

const BLOCKED = [
  /^\s*format\s+/i,
  /^\s*shutdown\s+/i,
  /^\s*rm\s+-rf\s+[\\/]/i,
  /^\s*del\s+\/s\s+\/q\s+[a-z]:\\/i,
  /Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\/i,
];

function assertInsideProject(projectRoot, cwd) {
  const verified = verifyPathSandbox(projectRoot, cwd || projectRoot, { mode: 'read' });
  return verified.canonicalTarget;
}

function isBlockedCommand(command) {
  const c = String(command || '');
  return BLOCKED.some((re) => re.test(c));
}

function runTerminal(projectRoot, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const cwd = assertInsideProject(projectRoot, opts.cwd || projectRoot);
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('命令为空');
  if (isBlockedCommand(cmd)) throw new Error('命令被安全策略拦截: ' + cmd);

  const sanitizedEnv = buildSanitizedEnv(opts.env, { allowSecrets: opts.allowSecrets === true });

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { cwd, windowsHide: true, env: sanitizedEnv }
    );

    if (typeof opts.onSpawn === 'function') {
      try { opts.onSpawn(child); } catch { /* ignore */ }
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      killed = true;
      try {
        if (child.pid) terminateProcessTree(child.pid);
        child.kill();
      } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (child.pid) terminateProcessTree(child.pid);
        child.kill();
      } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const chunk = redactSecrets(d.toString('utf8'));
      stdout += chunk;
      if (typeof opts.onStdout === 'function') {
        try { opts.onStdout(chunk); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', (d) => {
      const chunk = redactSecrets(d.toString('utf8'));
      stderr += chunk;
      if (typeof opts.onStderr === 'function') {
        try { opts.onStderr(chunk); } catch { /* ignore */ }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (child.pid) {
        try { terminateProcessTree(child.pid); } catch (_) {}
      }
      resolve({
        ok: false,
        code: -1,
        stdout: redactSecrets(stdout.slice(0, 20000)),
        stderr: redactSecrets((stderr + '\n' + err.message).slice(0, 20000)),
        cwd,
        command: cmd,
        timedOut: false,
        aborted,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed || aborted) {
        if (child.pid) {
          try { terminateProcessTree(child.pid); } catch (_) {}
        }
      }
      resolve({
        ok: !killed && !aborted && code === 0,
        code: (killed || aborted) ? -1 : code,
        stdout: redactSecrets(stdout.slice(0, 20000)),
        stderr: redactSecrets(stderr.slice(0, 20000)),
        cwd,
        command: cmd,
        timedOut: killed && !aborted,
        aborted,
      });
    });
  });
}

module.exports = {
  runTerminal,
  isBlockedCommand,
  assertInsideProject,
};
