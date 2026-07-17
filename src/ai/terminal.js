const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BLOCKED = [
  /^\s*format\s+/i,
  /^\s*shutdown\s+/i,
  /^\s*rm\s+-rf\s+[\\/]/i,
  /^\s*del\s+\/s\s+\/q\s+[a-z]:\\/i,
  /Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\/i,
];

function assertInsideProject(projectRoot, cwd) {
  const root = path.resolve(projectRoot);
  const dir = path.resolve(cwd || root);
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('终端工作目录必须在项目根目录内');
  }
  if (!fs.existsSync(dir)) throw new Error('工作目录不存在: ' + dir);
  return dir;
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

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { cwd, windowsHide: true, env: { ...process.env } }
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
      try { child.kill(); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout: stdout.slice(0, 20000),
        stderr: (stderr + '\n' + err.message).slice(0, 20000),
        cwd,
        command: cmd,
        timedOut: false,
        aborted,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !killed && !aborted && code === 0,
        code: (killed || aborted) ? -1 : code,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 20000),
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
