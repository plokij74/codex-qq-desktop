'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveSafe } = require('./project-fs');
const { truncateDiff } = require('./diff');

const STATUS_TIMEOUT_MS = 30000;
const DIFF_TIMEOUT_MS = 30000;
const COMMIT_TIMEOUT_MS = 60000;

/**
 * Walk up from startDir until a directory containing `.git` is found.
 * @param {string} startDir
 * @returns {string|null}
 */
function findGitRoot(startDir) {
  let dir = path.resolve(startDir || '.');
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal, allowNonZero?: boolean }} opts
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, timedOut?: boolean, aborted?: boolean, error?: string }>}
 */
function runGit(repo, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? STATUS_TIMEOUT_MS;
  const signal = opts.signal;
  const allowNonZero = opts.allowNonZero === true;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        ok: false,
        code: -1,
        stdout: '',
        stderr: '已停止',
        aborted: true,
        error: '已停止',
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdout = '';
    let stderr = '';

    const child = execFile(
      'git',
      ['-C', repo, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, out, errOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);

        stdout = out == null ? '' : String(out);
        stderr = errOut == null ? '' : String(errOut);

        if (aborted) {
          resolve({
            ok: false,
            code: -1,
            stdout,
            stderr: stderr || '已停止',
            aborted: true,
            error: '已停止',
          });
          return;
        }
        if (timedOut) {
          resolve({
            ok: false,
            code: -1,
            stdout,
            stderr: stderr || 'git 超时',
            timedOut: true,
            error: 'git 超时',
          });
          return;
        }

        if (err) {
          // ENOENT = git binary missing
          if (err.code === 'ENOENT') {
            resolve({
              ok: false,
              code: -1,
              stdout,
              stderr: stderr || err.message,
              error: '未安装 git 或无法执行 git 命令',
            });
            return;
          }
          const code = typeof err.code === 'number' ? err.code : err.status ?? 1;
          if (allowNonZero) {
            resolve({ ok: true, code, stdout, stderr });
            return;
          }
          const msg = (stderr || err.message || 'git 失败').trim();
          resolve({
            ok: false,
            code,
            stdout,
            stderr,
            error: msg,
          });
          return;
        }

        resolve({ ok: true, code: 0, stdout, stderr });
      }
    );

    const onAbort = () => {
      aborted = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  });
}

/**
 * Parse `git status --porcelain=v1 -b` output.
 * @param {string} text
 */
function parseStatusPorcelain(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  let branch = '';
  const entries = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // ## main...origin/main [ahead 1]
      // ## HEAD (no branch)
      // ## feature/v1.2.3
      // ## feature/v1.2.3...origin/feature/v1.2.3 [ahead 1]
      const rest = line.slice(3).trim();
      const noBranch = rest.match(/^HEAD \(no branch\)/i);
      if (noBranch) {
        branch = 'HEAD';
      } else {
        // Branch name may contain dots (e.g. feature/v1.2.3). Stop at "..." or whitespace.
        const tracking = rest.indexOf('...');
        const head = tracking >= 0 ? rest.slice(0, tracking) : rest;
        branch = head.split(/\s/)[0] || '';
      }
      continue;
    }

    // XY PATH or XY ORIG -> PATH (rename)
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    let filePart = line.slice(3);
    // rename/copy: "old -> new"
    if (filePart.includes(' -> ')) {
      const parts = filePart.split(' -> ');
      filePart = parts[parts.length - 1];
    }
    // quoted paths
    if (filePart.startsWith('"') && filePart.endsWith('"')) {
      try {
        filePart = JSON.parse(filePart);
      } catch {
        filePart = filePart.slice(1, -1);
      }
    }
    entries.push({
      path: filePart.replace(/\\/g, '/'),
      xy,
      index: xy[0] || ' ',
      worktree: xy[1] || ' ',
    });
  }

  return { branch, entries };
}

function summaryFromEntries(branch, entries) {
  const n = entries.length;
  if (n === 0) return `分支 ${branch || '?'}：工作区干净`;
  return `分支 ${branch || '?'}：${n} 个变更`;
}

/**
 * @param {string} projectRoot
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function gitStatus(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const repo = findGitRoot(root);
  if (!repo) {
    return { ok: false, branch: '', entries: [], summary: '', error: '不是 git 仓库' };
  }

  const r = await runGit(repo, ['status', '--porcelain=v1', '-b'], {
    timeoutMs: STATUS_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (!r.ok) {
    return {
      ok: false,
      branch: '',
      entries: [],
      summary: '',
      error: r.error || r.stderr || 'git status 失败',
    };
  }

  const { branch, entries } = parseStatusPorcelain(r.stdout);
  return {
    ok: true,
    branch,
    entries,
    summary: summaryFromEntries(branch, entries),
  };
}

/**
 * @param {string} projectRoot
 * @param {{ path?: string, staged?: boolean, maxBytes?: number, signal?: AbortSignal }} [opts]
 */
async function gitDiff(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const repo = findGitRoot(root);
  if (!repo) {
    return { ok: false, text: '', truncated: false, staged: !!opts.staged, error: '不是 git 仓库' };
  }

  const staged = !!opts.staged;
  const maxBytes = opts.maxBytes ?? 32768;
  const args = staged ? ['diff', '--cached', '--'] : ['diff', '--'];

  if (opts.path) {
    try {
      resolveSafe(root, opts.path);
    } catch (e) {
      return {
        ok: false,
        text: '',
        truncated: false,
        staged,
        error: e.message || String(e),
      };
    }
    // Pass path relative to project/repo; git -C uses repo root.
    // Prefer path relative to repo if projectRoot is inside repo.
    const abs = path.resolve(root, opts.path);
    const relToRepo = path.relative(repo, abs).replace(/\\/g, '/');
    if (relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) {
      return {
        ok: false,
        text: '',
        truncated: false,
        staged,
        error: `路径越界，禁止访问项目外文件: ${opts.path}`,
      };
    }
    args.push(relToRepo || opts.path);
  }

  const r = await runGit(repo, args, {
    timeoutMs: DIFF_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (!r.ok) {
    return {
      ok: false,
      text: '',
      truncated: false,
      staged,
      error: r.error || r.stderr || 'git diff 失败',
    };
  }

  const raw = r.stdout || '';
  const { text, truncated } = truncateDiff(raw, { maxBytes, maxLines: 400 });
  return { ok: true, text, truncated, staged };
}

/**
 * @param {string} projectRoot
 * @param {{ message: string, paths?: string[], stage?: boolean, signal?: AbortSignal }} opts
 */
async function gitCommit(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const repo = findGitRoot(root);
  if (!repo) {
    return { ok: false, commit: '', branch: '', summary: '', error: '不是 git 仓库' };
  }

  const message = String(opts.message ?? '').trim();
  if (!message) {
    return { ok: false, commit: '', branch: '', summary: '', error: '提交消息不能为空' };
  }

  const paths = Array.isArray(opts.paths) ? opts.paths : [];
  const stage = opts.stage !== false;
  const signal = opts.signal;

  if (paths.length > 0) {
    if (!stage) {
      return {
        ok: false,
        commit: '',
        branch: '',
        summary: '',
        error: '指定 paths 时 stage 不能为 false',
      };
    }

    const relPaths = [];
    for (const p of paths) {
      try {
        resolveSafe(root, p);
      } catch (e) {
        return {
          ok: false,
          commit: '',
          branch: '',
          summary: '',
          error: e.message || String(e),
        };
      }
      const abs = path.resolve(root, p);
      const relToRepo = path.relative(repo, abs).replace(/\\/g, '/');
      if (relToRepo.startsWith('..') || path.isAbsolute(relToRepo)) {
        return {
          ok: false,
          commit: '',
          branch: '',
          summary: '',
          error: `路径越界，禁止访问项目外文件: ${p}`,
        };
      }
      relPaths.push(relToRepo || p);
    }

    const add = await runGit(repo, ['add', '--', ...relPaths], {
      timeoutMs: COMMIT_TIMEOUT_MS,
      signal,
    });
    if (!add.ok) {
      return {
        ok: false,
        commit: '',
        branch: '',
        summary: '',
        error: add.error || add.stderr || 'git add 失败',
      };
    }
  } else {
    // No paths: only commit already staged; never git add -A
    const check = await runGit(repo, ['diff', '--cached', '--quiet'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      signal,
      allowNonZero: true,
    });
    if (!check.ok && (check.aborted || check.timedOut || check.error === '未安装 git 或无法执行 git 命令')) {
      return {
        ok: false,
        commit: '',
        branch: '',
        summary: '',
        error: check.error || check.stderr || 'git 失败',
      };
    }
    // exit 0 => no staged changes; exit 1 => has staged changes
    if (check.code === 0) {
      return {
        ok: false,
        commit: '',
        branch: '',
        summary: '',
        error: '没有可提交的暂存变更',
      };
    }
  }

  const commit = await runGit(repo, ['commit', '-m', message], {
    timeoutMs: COMMIT_TIMEOUT_MS,
    signal,
  });
  if (!commit.ok) {
    return {
      ok: false,
      commit: '',
      branch: '',
      summary: '',
      error: commit.error || commit.stderr || 'git commit 失败',
    };
  }

  const rev = await runGit(repo, ['rev-parse', '--short', 'HEAD'], {
    timeoutMs: STATUS_TIMEOUT_MS,
    signal,
  });
  const sha = rev.ok ? String(rev.stdout || '').trim() : '';

  const br = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    timeoutMs: STATUS_TIMEOUT_MS,
    signal,
  });
  const branch = br.ok ? String(br.stdout || '').trim() : '';

  return {
    ok: true,
    commit: sha,
    branch,
    summary: `已提交 ${sha}${branch ? ` @ ${branch}` : ''}: ${message}`,
  };
}

module.exports = {
  findGitRoot,
  gitStatus,
  gitDiff,
  gitCommit,
  parseStatusPorcelain,
};
