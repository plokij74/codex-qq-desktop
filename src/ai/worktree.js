'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const {
  PATCH_MAX_BYTES,
  PENDING_LIMIT,
  FILE_SUMMARY_LIMIT,
  createMarker,
  normalizeMarker,
  transitionMarker,
  publicSummary,
  isResultId,
  isUnresolved,
} = require('./worktree-state');
const { createGithubCli } = require('./github-cli');

const GIT_TIMEOUT_MS = 60000;
const PATCH_DIFF_ARGS = Object.freeze([
  '-c', 'core.quotePath=true',
  '-c', 'color.ui=false',
  '-c', 'diff.suppressBlankEmpty=false',
  '--literal-pathspecs', 'diff', '--cached', '--binary', '--full-index',
  '--find-renames=50%', '--diff-algorithm=myers', '--no-indent-heuristic',
  '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--inter-hunk-context=0',
  '--src-prefix=a/', '--dst-prefix=b/', '--',
]);

function worktreeError(code, error, extra = {}) {
  return { ...extra, ok: false, code, error: String(error || code) };
}

function shortError(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
}

function normPath(value) {
  const out = path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:$/.test(out) ? `${out}/` : out;
}

function samePath(left, right) {
  const a = normPath(left);
  const b = normPath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function toPosixRel(root, target) {
  const rel = path.relative(root, target).replace(/\\/g, '/');
  if (!pathInside(root, target) || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

function projectIdentity(realProject) {
  const normalized = normPath(realProject);
  return process.platform === 'win32'
    ? `windows:${normalized.toLowerCase()}`
    : `posix:${normalized}`;
}

function makeResultId() {
  return `wt_${crypto.randomBytes(8).toString('hex')}`;
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(buffer, code = 'PATCH_INVALID') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw Object.assign(new Error('Git 变更清单包含无效 UTF-8 路径'), { code });
  }
}

function git(cwd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    try {
      child = execFile('git', args, {
        cwd,
        encoding: 'buffer',
        maxBuffer: opts.maxBuffer ?? (20 * 1024 * 1024),
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      }, (err, stdout, stderr) => {
        clearTimeout(timer);
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        const errOut = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '');
        if (timedOut) {
          resolve({ ok: false, code: -1, stdout: out, stderr: errOut, error: 'git 超时' });
          return;
        }
        if (!err) {
          resolve({ ok: true, code: 0, stdout: out, stderr: errOut });
          return;
        }
        if (err.code === 'ENOENT') {
          resolve({ ok: false, code: -1, stdout: out, stderr: errOut, error: '未安装 git 或无法执行 git 命令' });
          return;
        }
        const code = typeof err.code === 'number' ? err.code : 1;
        if (opts.allowNonZero) {
          resolve({ ok: true, code, stdout: out, stderr: errOut });
          return;
        }
        resolve({
          ok: false,
          code,
          stdout: out,
          stderr: errOut,
          error: shortError(errOut.toString('utf8') || err.message || 'git 失败'),
        });
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: shortError(err.message) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
  });
}

// Patch output is attacker-controlled repository data. Keep the bounded
// prefix in memory while draining the child process so a large diff cannot
// turn the collect path into an unbounded buffer allocation.
function gitStream(cwd, args, { maxBytes = PATCH_MAX_BYTES + 1, timeoutMs = GIT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    let totalBytes = 0;
    let keptBytes = 0;
    const chunks = [];
    let stderr = Buffer.alloc(0);
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr, outputBytes: 0, error: shortError(err.message) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + value.length);
      const remaining = Math.max(0, maxBytes - keptBytes);
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        chunks.push(kept);
        keptBytes += kept.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, value]).subarray(-64 * 1024);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: Buffer.concat(chunks), stderr, outputBytes: totalBytes, error: shortError(err.code === 'ENOENT' ? '未安装 git 或无法执行 git 命令' : err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      if (timedOut) {
        resolve({ ok: false, code: -1, stdout, stderr, outputBytes: totalBytes, error: 'git 超时' });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, code: typeof code === 'number' ? code : 1, stdout, stderr, outputBytes: totalBytes, error: shortError(stderr.toString('utf8') || 'git 失败') });
        return;
      }
      resolve({ ok: true, code: 0, stdout, stderr, outputBytes: totalBytes, tooLarge: totalBytes > maxBytes });
    });
  });
}

async function realDirectory(input) {
  const absolute = path.resolve(String(input || ''));
  let stat;
  try {
    stat = await fsp.lstat(absolute);
  } catch {
    throw Object.assign(new Error('项目路径不存在'), { code: 'PATH_UNSAFE' });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('项目路径必须是非链接目录'), { code: 'PATH_UNSAFE' });
  }
  const real = await fsp.realpath(absolute);
  if (!samePath(absolute, real)) {
    throw Object.assign(new Error('项目路径不能经过符号链接或重解析点'), { code: 'PATH_UNSAFE' });
  }
  return real;
}

async function assertSafeExistingPath(target, { directory = false } = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch {
      throw Object.assign(new Error(`路径不存在: ${current}`), { code: 'PATH_UNSAFE' });
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error('路径包含符号链接'), { code: 'PATH_UNSAFE' });
    }
  }
  if (directory) {
    const st = await fsp.stat(absolute);
    if (!st.isDirectory()) throw Object.assign(new Error('路径不是目录'), { code: 'PATH_UNSAFE' });
  }
  return absolute;
}

async function assertSafeChildPath(root, relPath, { allowMissing = false } = {}) {
  const raw = String(relPath ?? '').replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!raw || path.isAbsolute(raw) || /(^|\/)\.\.(?:\/|$)/.test(raw) || raw.includes('\0')
    || parts.some((part) => part.toLowerCase() === '.git')) {
    throw Object.assign(new Error('隔离项目路径不安全'), { code: 'PATH_UNSAFE' });
  }
  const safeRoot = await realDirectory(root);
  const target = path.resolve(safeRoot, ...parts);
  if (!pathInside(safeRoot, target)) {
    throw Object.assign(new Error('隔离项目路径越界'), { code: 'PATH_UNSAFE' });
  }
  let current = safeRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (allowMissing && err.code === 'ENOENT') return target;
      throw Object.assign(new Error('隔离项目路径不存在'), { code: 'PATH_UNSAFE' });
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error('隔离项目路径包含符号链接'), { code: 'PATH_UNSAFE' });
    }
    const real = await fsp.realpath(current);
    if (!samePath(current, real)) {
      throw Object.assign(new Error('隔离项目路径包含 junction 或重解析点'), { code: 'PATH_UNSAFE' });
    }
  }
  return target;
}

async function atomicWrite(filePath, content, validateTemp) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof validateTemp === 'function') await validateTemp(tmp);
    await fsp.rename(tmp, filePath);
    try {
      const parent = await fsp.open(dir, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch {
      // Some Windows filesystems do not permit opening directories for fsync.
    }
  } finally {
    if (handle) try { await handle.close(); } catch { /* ignore */ }
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
  }
}

function encodeGitignoreLiteral(value) {
  const input = String(value || '').replace(/\\/g, '/');
  if (!input || /[\r\n\0]/.test(input)) return null;
  return input.replace(/([\\#!*?\[\]])/g, '\\$1').replace(/^ /, '\\ ').replace(/ $/, '\\ ');
}

async function ensureExclude({ repoRoot, commonDir, projectRel, prospectivePath }) {
  await assertSafeExistingPath(commonDir, { directory: true });
  const info = path.join(commonDir, 'info');
  if (!fs.existsSync(info)) await fsp.mkdir(info, { recursive: true });
  await assertSafeExistingPath(info, { directory: true });
  const exclude = path.join(info, 'exclude');
  if (fs.existsSync(exclude)) await assertSafeExistingPath(exclude);
  const encodedRel = projectRel ? encodeGitignoreLiteral(projectRel) : '';
  if (projectRel && !encodedRel) throw Object.assign(new Error('项目路径不能安全写入 Git exclude'), { code: 'EXCLUDE_FAILED' });
  const rule = `/${encodedRel ? `${encodedRel}/` : ''}.codex/worktrees/`;
  let previous = '';
  try { previous = await fsp.readFile(exclude, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const lines = previous.replace(/\r\n/g, '\n').split('\n');
  if (!lines.includes(rule)) {
    const next = `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${rule}\n`;
    await atomicWrite(exclude, next);
  }
  const rel = toPosixRel(repoRoot, prospectivePath);
  if (rel == null) throw Object.assign(new Error('临时 worktree 路径越界'), { code: 'EXCLUDE_FAILED' });
  const verified = await git(repoRoot, ['check-ignore', '-q', '--no-index', '--', rel], { allowNonZero: true });
  if (!verified.ok || verified.code !== 0) {
    throw Object.assign(new Error('无法验证 Git exclude 规则'), { code: 'EXCLUDE_FAILED' });
  }
  return rule;
}

function pathspecFor(projectRel) {
  return projectRel || '.';
}

function validScopedPath(filePath, projectRel) {
  const p = String(filePath || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /(^|\/)\.\.(?:\/|$)/.test(p) || p.includes('\0')) return false;
  return !projectRel || p === projectRel || p.startsWith(`${projectRel}/`);
}

function parseNameStatus(buffer, projectRel) {
  const tokens = decodeUtf8(buffer).split('\0');
  const files = [];
  for (let index = 0; index < tokens.length - 1;) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;
    const status = statusToken[0];
    const renamed = status === 'R' || status === 'C';
    const oldPath = renamed ? tokens[index++] : null;
    const newPath = tokens[index++];
    if (!/^[ACDMRTUXB]$/.test(status) || !newPath || (renamed && !oldPath)
      || !validScopedPath(newPath, projectRel) || (oldPath && !validScopedPath(oldPath, projectRel))) {
      throw Object.assign(new Error('Git 变更清单包含不安全路径'), { code: 'PATCH_INVALID' });
    }
    files.push({ path: newPath, status, binary: false, ...(oldPath ? { previousPath: oldPath } : {}) });
  }
  return files;
}

function parseNumstat(buffer, files) {
  const map = new Map(files.map((item) => [item.path, item]));
  const tokens = decodeUtf8(buffer).split('\0');
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const add = token.slice(0, firstTab);
    const del = token.slice(firstTab + 1, secondTab);
    let rawPath = token.slice(secondTab + 1);
    // With --numstat -z, rename/copy records emit an empty path field
    // followed by old and new path tokens. Attribute stats to the new path.
    if (!rawPath && index + 2 < tokens.length) {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (oldPath && newPath) {
        rawPath = newPath;
        index += 2;
      }
    }
    const file = map.get(rawPath) || files.find((entry) => entry.path.endsWith(rawPath.replace(/^\{.* => /, '').replace(/\}$/, '')));
    if (add === '-' || del === '-') {
      binaryFiles += 1;
      if (file) file.binary = true;
      continue;
    }
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { files: files.length, additions, deletions, binaryFiles };
}

function parseTrackedModes(buffer, projectRel) {
  const tokens = decodeUtf8(buffer).split('\0');
  for (const token of tokens) {
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab < 0) throw Object.assign(new Error('Git stage 清单格式无效'), { code: 'PATCH_INVALID' });
    const mode = token.slice(0, tab).split(/\s+/)[0];
    const filePath = token.slice(tab + 1).replace(/\\/g, '/');
    if (!validScopedPath(filePath, projectRel)) throw Object.assign(new Error('Git stage 清单路径越界'), { code: 'PATCH_INVALID' });
    if (mode === '120000') throw Object.assign(new Error('D5 不支持 symlink 变更'), { code: 'PATH_UNSAFE' });
    if (mode === '160000') throw Object.assign(new Error('绑定项目包含 nested submodule/gitlink'), { code: 'UNSUPPORTED_GITLINK' });
  }
}

async function readMarker(resultRoot) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(resultRoot, 'meta.json'), 'utf8'));
    return normalizeMarker(raw);
  } catch {
    return null;
  }
}

async function writeMarker(resultRoot, marker) {
  const normalized = normalizeMarker(marker);
  if (!normalized) throw Object.assign(new Error('worktree marker 无效'), { code: 'PATH_UNSAFE' });
  await atomicWrite(path.join(resultRoot, 'meta.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

async function resolveRepo(projectPath) {
  const projectRoot = await realDirectory(projectPath);
  const inside = await git(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.toString('utf8').trim() !== 'true') {
    throw Object.assign(new Error('绑定目录不在 Git 工作树内'), { code: 'NOT_GIT_REPO' });
  }
  const top = await git(projectRoot, ['rev-parse', '--show-toplevel']);
  const common = await git(projectRoot, ['rev-parse', '--git-common-dir']);
  const head = await git(projectRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!top.ok || !common.ok) throw Object.assign(new Error('无法读取 Git 仓库信息'), { code: 'NOT_GIT_REPO' });
  if (!head.ok || !/^[a-f0-9]{40}$/i.test(head.stdout.toString('utf8').trim())) {
    throw Object.assign(new Error('Git 仓库没有可用 HEAD'), { code: 'NO_HEAD' });
  }
  const repoRoot = await realDirectory(top.stdout.toString('utf8').trim());
  const commonText = common.stdout.toString('utf8').trim();
  const commonDir = await realDirectory(path.isAbsolute(commonText) ? commonText : path.resolve(projectRoot, commonText));
  if (!pathInside(repoRoot, projectRoot)) throw Object.assign(new Error('绑定目录不在仓库根内'), { code: 'PATH_UNSAFE' });
  const projectRel = toPosixRel(repoRoot, projectRoot);
  if (projectRel == null) throw Object.assign(new Error('绑定目录相对路径无效'), { code: 'PATH_UNSAFE' });
  return {
    projectRoot,
    repoRoot,
    commonDir,
    projectRel,
    projectIdentity: projectIdentity(projectRoot),
    baseHead: head.stdout.toString('utf8').trim().toLowerCase(),
  };
}

async function statusIsClean(repoRoot) {
  const result = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) throw Object.assign(new Error(result.error || 'git status 失败'), { code: 'NOT_GIT_REPO' });
  return result.stdout.length === 0;
}

async function listResultRoots(projectRoot) {
  const root = path.join(projectRoot, '.codex', 'worktrees');
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isResultId(entry.name))
      .map((entry) => path.join(root, entry.name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function resultById(projectRoot, id) {
  if (!isResultId(id)) return null;
  const root = path.join(projectRoot, '.codex', 'worktrees', id);
  if (!pathInside(path.join(projectRoot, '.codex', 'worktrees'), root)) return null;
  try {
    await assertSafeExistingPath(root, { directory: true });
  } catch {
    return null;
  }
  const marker = await readMarker(root);
  if (!marker || marker.id !== id) return null;
  return { root, marker, checkout: path.join(root, 'checkout'), patch: path.join(root, 'result.patch') };
}

async function worktreeRecords(repoRoot) {
  const list = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return [];
  return list.stdout.toString('utf8').split(/\r?\n\r?\n/).map((block) => {
    const record = { path: '', head: '', detached: false, locked: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) record.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) record.head = line.slice(5).trim().toLowerCase();
      else if (line === 'detached') record.detached = true;
      else if (line === 'locked' || line.startsWith('locked ')) record.locked = true;
    }
    return record;
  }).filter((record) => record.path);
}

async function worktreeRegistration(checkout, repoRoot) {
  const records = await worktreeRecords(repoRoot);
  return records.some((record) => samePath(record.path, checkout));
}

async function validateWorktreeMetadata(result, repo) {
  const record = (await worktreeRecords(repo.repoRoot)).find((entry) => samePath(entry.path, result.checkout));
  if (!record || record.head !== result.marker.baseHead || !record.detached || !record.locked) {
    throw Object.assign(new Error('隔离 worktree 注册、HEAD 或锁状态已变化'), { code: 'GIT_METADATA_CHANGED' });
  }
  const [head, top, gitDir, common] = await Promise.all([
    git(result.checkout, ['rev-parse', 'HEAD']),
    git(result.checkout, ['rev-parse', '--show-toplevel']),
    git(result.checkout, ['rev-parse', '--git-dir']),
    git(result.checkout, ['rev-parse', '--git-common-dir']),
  ]);
  if (![head, top, gitDir, common].every((item) => item.ok)) {
    throw Object.assign(new Error('无法读取隔离 worktree 元数据'), { code: 'GIT_METADATA_CHANGED' });
  }
  const resolveGitPath = (value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(result.checkout, value);
  const actualGitDir = resolveGitPath(gitDir.stdout.toString('utf8').trim());
  const actualCommon = resolveGitPath(common.stdout.toString('utf8').trim());
  if (head.stdout.toString('utf8').trim().toLowerCase() !== result.marker.baseHead
    || !samePath(top.stdout.toString('utf8').trim(), result.checkout)
    || !samePath(actualGitDir, result.marker.worktreeGitDir)
    || !samePath(actualCommon, repo.commonDir)) {
    throw Object.assign(new Error('隔离 worktree Git 元数据对账失败'), { code: 'GIT_METADATA_CHANGED' });
  }
  return true;
}

async function validateScopedModes(cwd, projectRel) {
  const scope = pathspecFor(projectRel);
  const result = await git(cwd, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', scope]);
  if (!result.ok) throw Object.assign(new Error(result.error || '无法读取 Git stage 清单'), { code: 'PATCH_INVALID' });
  parseTrackedModes(result.stdout, projectRel);
}

async function validateAffectedParents(repoRoot, files) {
  for (const item of Array.isArray(files) ? files : []) {
    for (const filePath of [item.path, item.previousPath].filter(Boolean)) {
      const target = path.join(repoRoot, String(filePath).replace(/\//g, path.sep));
      const parent = fs.existsSync(target) ? target : path.dirname(target);
      await assertSafeExistingPath(parent, { directory: fs.existsSync(parent) && fs.statSync(parent).isDirectory() });
    }
  }
}

async function removeArtifact(result) {
  const root = result.root;
  const containing = path.dirname(root);
  await assertSafeExistingPath(containing, { directory: true });
  await assertSafeExistingPath(root, { directory: true });
  if (!pathInside(containing, root) || path.basename(root) !== result.marker.id) {
    throw Object.assign(new Error('worktree 结果目录校验失败'), { code: 'PATH_UNSAFE' });
  }
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 1 });
}

async function updateState(result, state, patch) {
  const next = transitionMarker(result.marker, state, patch);
  if (!next) throw Object.assign(new Error(`非法 worktree 状态转换: ${result.marker.state} -> ${state}`), { code: 'PATH_UNSAFE' });
  result.marker = await writeMarker(result.root, next);
  return result.marker;
}

async function writeTree(cwd, env, errorCode = 'COLLECT_FAILED') {
  const result = await git(cwd, ['write-tree'], { env });
  const value = result.ok ? result.stdout.toString('utf8').trim().toLowerCase() : '';
  if (!/^[a-f0-9]{40}$/.test(value)) throw Object.assign(new Error(result.error || '无法计算 Git tree'), { code: errorCode });
  return value;
}

async function withTemporaryIndex(repoRoot, errorCode, fn) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-qq-worktree-'));
  const indexPath = path.join(tempDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await assertSafeExistingPath(tempDir, { directory: true });
    if (fs.existsSync(indexPath) || fs.existsSync(`${indexPath}.lock`)) {
      throw Object.assign(new Error('临时 Git index 已存在'), { code: errorCode });
    }
    return await fn(env);
  } finally {
    try { await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 1 }); } catch { /* ignore */ }
  }
}

async function replayPatchTree(repoRoot, baseHead, patchPath, errorCode = 'PATCH_INVALID') {
  return withTemporaryIndex(repoRoot, errorCode, async (env) => {
    const read = await git(repoRoot, ['read-tree', baseHead], { env });
    if (!read.ok) throw Object.assign(new Error(read.error || '无法初始化补丁验证 index'), { code: errorCode });
    const applied = await git(repoRoot, ['apply', '--cached', '--binary', '-p1', patchPath], { env });
    if (!applied.ok) throw Object.assign(new Error(applied.error || '隔离补丁无法从基线重放'), { code: errorCode });
    return writeTree(repoRoot, env, errorCode);
  });
}

async function canonicalPatchFor(result, repo) {
  await validateScopedModes(result.checkout, repo.projectRel);
  const scope = pathspecFor(repo.projectRel);
  const patch = await gitStream(result.checkout, [...PATCH_DIFF_ARGS, scope], { maxBytes: PATCH_MAX_BYTES });
  if (!patch.ok || patch.tooLarge) throw Object.assign(new Error(patch.error || '无法重新生成隔离补丁'), { code: 'PATCH_INVALID' });
  const nameStatus = await git(result.checkout, ['--literal-pathspecs', 'diff', '--cached', '--name-status', '-z', '--find-renames=50%', '--', scope]);
  if (!nameStatus.ok) throw Object.assign(new Error(nameStatus.error || '无法重新生成变更清单'), { code: 'PATCH_INVALID' });
  const files = parseNameStatus(nameStatus.stdout, repo.projectRel);
  const expectedTree = await writeTree(result.checkout, undefined, 'PATCH_INVALID');
  const replayedTree = await replayPatchTree(repo.repoRoot, result.marker.baseHead, result.patch);
  if (replayedTree !== expectedTree) {
    throw Object.assign(new Error('隔离补丁重放结果与 worktree index 不一致'), { code: 'PATCH_INVALID' });
  }
  return { bytes: patch.stdout, expectedTree, files, replayedTree };
}

async function validateReadyResult(result, repo) {
  try {
    await assertSafeExistingPath(result.patch);
  } catch {
    throw Object.assign(new Error('隔离补丁不存在或无法读取'), { code: 'PATCH_INVALID' });
  }
  await validateWorktreeMetadata(result, repo);
  const bytes = await fsp.readFile(result.patch);
  if (bytes.length !== result.marker.patchBytes || hashBytes(bytes) !== result.marker.patchSha256) {
    throw Object.assign(new Error('隔离补丁校验失败'), { code: 'PATCH_INVALID' });
  }
  const canonical = await canonicalPatchFor(result, repo);
  if (canonical.expectedTree !== result.marker.expectedTree
    || !Buffer.isBuffer(canonical.bytes)
    || !canonical.bytes.equals(bytes)
    || canonical.bytes.length > PATCH_MAX_BYTES) {
    throw Object.assign(new Error('隔离补丁与 worktree index 对账失败'), { code: 'PATCH_INVALID' });
  }
  return { bytes, canonical };
}

async function validatePrWorktreeMetadata(result, repo) {
  const record = (await worktreeRecords(repo.repoRoot)).find((entry) => samePath(entry.path, result.checkout));
  if (!record || !record.locked) {
    throw Object.assign(new Error('PR 隔离 worktree 注册或锁状态已变化'), { code: 'GIT_METADATA_CHANGED' });
  }
  const [top, gitDir, common] = await Promise.all([
    git(result.checkout, ['rev-parse', '--show-toplevel']),
    git(result.checkout, ['rev-parse', '--git-dir']),
    git(result.checkout, ['rev-parse', '--git-common-dir']),
  ]);
  if (![top, gitDir, common].every((item) => item.ok)) {
    throw Object.assign(new Error('无法读取 PR 隔离 worktree 元数据'), { code: 'GIT_METADATA_CHANGED' });
  }
  const resolveGitPath = (value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(result.checkout, value);
  if (!samePath(top.stdout.toString('utf8').trim(), result.checkout)
    || !samePath(resolveGitPath(gitDir.stdout.toString('utf8').trim()), result.marker.worktreeGitDir)
    || !samePath(resolveGitPath(common.stdout.toString('utf8').trim()), repo.commonDir)) {
    throw Object.assign(new Error('PR 隔离 worktree Git 元数据对账失败'), { code: 'GIT_METADATA_CHANGED' });
  }
}

async function removeUnregisteredCreatingArtifact(result, repo) {
  if (await worktreeRegistration(result.checkout, repo.repoRoot) || fs.existsSync(result.checkout)) return false;
  const entries = await fsp.readdir(result.root);
  if (entries.some((name) => name !== 'meta.json')) return false;
  await removeArtifact(result);
  return true;
}

async function cleanupFailedCreate(result, repo) {
  if (await worktreeRegistration(result.checkout, repo.repoRoot)) {
    await assertSafeExistingPath(result.checkout, { directory: true });
    await git(repo.repoRoot, ['worktree', 'unlock', result.checkout], { allowNonZero: true });
    const removed = await git(repo.repoRoot, ['worktree', 'remove', '--force', result.checkout]);
    if (!removed.ok || await worktreeRegistration(result.checkout, repo.repoRoot)) return false;
  }
  return removeUnregisteredCreatingArtifact(result, repo);
}

async function withAlternateTree(repoRoot, baseHead) {
  return withTemporaryIndex(repoRoot, 'APPLY_UNCERTAIN', async (env) => {
    const read = await git(repoRoot, ['read-tree', baseHead], { env });
    if (!read.ok) throw Object.assign(new Error(read.error || '无法初始化临时 Git index'), { code: 'APPLY_UNCERTAIN' });
    const add = await git(repoRoot, ['--literal-pathspecs', 'add', '-A', '--', '.'], { env });
    if (!add.ok) throw Object.assign(new Error(add.error || '无法验证应用结果'), { code: 'APPLY_UNCERTAIN' });
    return writeTree(repoRoot, env, 'APPLY_UNCERTAIN');
  });
}

function createWorktreeManager(opts = {}) {
  const projectLocks = new Map();
  const github = opts.githubCli || createGithubCli(opts.github || {});

  async function withProjectLock(identity, fn) {
    const previous = projectLocks.get(identity) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    projectLocks.set(identity, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (projectLocks.get(identity) === tail) projectLocks.delete(identity);
    }
  }

  async function list({ projectPath }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const results = [];
    const warnings = [];
    for (const root of await listResultRoots(repo.projectRoot)) {
      const marker = await readMarker(root);
      const result = marker ? await resultById(repo.projectRoot, marker.id) : null;
      if (!marker || !result || !samePath(result.root, root)
        || marker.projectIdentity !== repo.projectIdentity || !samePath(marker.projectRoot, repo.projectRoot)) {
        warnings.push(`忽略无效 worktree marker: ${path.basename(root)}`);
        continue;
      }
      let summary = publicSummary(marker);
      if (summary && ['ready', 'conflict'].includes(marker.state)) {
        try {
          await validateReadyResult(result, repo);
        } catch (err) {
          warnings.push(`${marker.id}: ${shortError(err.message || '隔离结果验证失败')}`);
          summary = {
            ...summary,
            errorCode: err.code || 'PATCH_INVALID',
            error: shortError(err.message || '隔离结果验证失败'),
            canApply: false,
            canDiscard: false,
            canRetryCollect: false,
            canCleanup: false,
            canOpen: false,
            canPreview: false,
            canCreatePr: false,
            canRetryPr: false,
            canCleanupPr: false,
            canOpenPr: false,
          };
        }
      }
      if (summary) results.push(summary);
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, results, warnings };
  }

  async function recover({ projectPath }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const recovered = [];
    const warnings = [];
    for (const root of await listResultRoots(repo.projectRoot)) {
      let marker = await readMarker(root);
      if (!marker || marker.projectIdentity !== repo.projectIdentity) continue;
      const checkout = path.join(root, 'checkout');
      if (marker.state === 'applying') {
        const result = await resultById(repo.projectRoot, marker.id);
        if (!result) {
          warnings.push(`${marker.id}: applying marker 无法验证`);
          continue;
        }
        try {
          await validateReadyResult(result, repo);
          const actualTree = await withAlternateTree(repo.repoRoot, marker.baseHead);
          const indexTree = await writeTree(repo.repoRoot);
          const base = await git(repo.repoRoot, ['rev-parse', `${marker.baseHead}^{tree}`]);
          const baseTree = base.ok ? base.stdout.toString('utf8').trim().toLowerCase() : '';
          if (actualTree === marker.expectedTree && indexTree === baseTree) {
            await updateState(result, 'applied_cleanup_pending', { errorCode: null, error: null });
            recovered.push(publicSummary(result.marker));
          } else if (actualTree === baseTree && indexTree === baseTree && await statusIsClean(repo.repoRoot)) {
            let patchCheck = { ok: false, code: -1 };
            if (fs.existsSync(result.patch)) {
              patchCheck = await git(repo.repoRoot, ['apply', '--check', '--binary', result.patch], { allowNonZero: true });
            }
            if (patchCheck.ok && patchCheck.code === 0) {
              await updateState(result, 'ready', { errorCode: null, error: null });
              recovered.push(publicSummary(result.marker));
            } else {
              await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: '恢复时无法证明补丁仍可应用' });
              recovered.push(publicSummary(result.marker));
            }
          } else {
            await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: '恢复时主工作区既非基线也非精确结果' });
            recovered.push(publicSummary(result.marker));
          }
        } catch (err) {
          try {
            await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: shortError(err.message) });
            recovered.push(publicSummary(result.marker));
          } catch { warnings.push(`${marker.id}: ${err.message || '应用恢复失败'}`); }
        }
        continue;
      }
      if (['pr_preparing', 'pr_committing', 'pr_pushing', 'pr_creating'].includes(marker.state)) {
        const result = await resultById(repo.projectRoot, marker.id);
        if (!result) {
          warnings.push(`${marker.id}: PR 中间状态无法恢复`);
          continue;
        }
        try {
          await updateState(result, 'pr_failed', {
            errorCode: 'PR_INTERRUPTED',
            error: marker.pr?.pushed
              ? '应用在创建 PR 期间退出；重试时会先查询已存在的 PR'
              : '应用在准备或推送 PR 期间退出；可安全重试',
          });
          recovered.push(publicSummary(result.marker));
        } catch (err) {
          warnings.push(`${marker.id}: ${shortError(err.message || 'PR 恢复失败')}`);
        }
        continue;
      }
      if (marker.state === 'creating') {
        if (!await worktreeRegistration(checkout, repo.repoRoot)) {
          const result = await resultById(repo.projectRoot, marker.id);
          try {
            if (result && await removeUnregisteredCreatingArtifact(result, repo)) continue;
          } catch (err) {
            warnings.push(`${marker.id}: ${shortError(err.message || '无法清理创建失败的结果')}`);
            continue;
          }
          warnings.push(`${marker.id}: creating 状态缺少 worktree 注册，结果已保留`);
          continue;
        }
        const result = await resultById(repo.projectRoot, marker.id);
        const gitDir = await git(checkout, ['rev-parse', '--git-dir']);
        if (!result || !gitDir.ok) {
          warnings.push(`${marker.id}: creating 状态无法恢复 worktree 元数据`);
          continue;
        }
        const raw = gitDir.stdout.toString('utf8').trim();
        const worktreeGitDir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(checkout, raw);
        marker = await updateState(result, 'running', { worktreeGitDir, incomplete: true });
      }
      if (['applied_cleanup_pending', 'discarded_cleanup_pending'].includes(marker.state)) {
        const cleaned = await withProjectLock(repo.projectIdentity, () => cleanupResult(repo, marker.id));
        if (!cleaned.ok) warnings.push(`${marker.id}: ${cleaned.error || '恢复清理失败'}`);
        continue;
      }
      if (!['running', 'collecting'].includes(marker.state)) continue;
      if (!await worktreeRegistration(checkout, repo.repoRoot)) {
        warnings.push(`${marker.id}: 无法确认 worktree 注册，结果已保留`);
        continue;
      }
      const collected = await collect({
        id: marker.id,
        projectPath: repo.projectRoot,
        projectIdentity: repo.projectIdentity,
        repoRoot: repo.repoRoot,
        projectRel: repo.projectRel,
        resultRoot: root,
        checkout,
        childProjectPath: path.join(checkout, repo.projectRel),
        baseHead: marker.baseHead,
      }, { incomplete: true });
      if (collected.ok && collected.changed) recovered.push(collected.result);
      else if (!collected.ok) warnings.push(`${marker.id}: ${collected.error || '恢复收集失败'}`);
    }
    const listed = await list({ projectPath: repo.projectRoot });
    return listed.ok ? { ...listed, recovered, warnings: [...(listed.warnings || []), ...warnings] } : listed;
  }

  async function create({ project, sessionId, subagentId, goal }) {
    let repo;
    try { repo = await resolveRepo(project?.path); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      let createdResult = null;
      try {
        const artifactsRoot = path.join(repo.projectRoot, '.codex', 'worktrees');
        const prospective = path.join(artifactsRoot, 'prospective', 'checkout');
        try {
          await ensureExclude({ ...repo, prospectivePath: prospective });
        } catch (err) {
          return worktreeError(err.code || 'EXCLUDE_FAILED', err.message || '无法配置 Git exclude');
        }
        try {
          await validateScopedModes(repo.repoRoot, repo.projectRel);
        } catch (err) {
          return worktreeError(err.code || 'PATCH_INVALID', err.message);
        }
        if (!await statusIsClean(repo.repoRoot)) return worktreeError('DIRTY_BASE', 'Git 工作区存在未提交变更，无法创建隔离任务');
        const existing = await listResultRoots(repo.projectRoot);
        let unresolved = 0;
        for (const root of existing) {
          const marker = await readMarker(root);
          if (marker && marker.projectIdentity === repo.projectIdentity && isUnresolved(marker)) unresolved += 1;
        }
        if (unresolved >= PENDING_LIMIT) return worktreeError('PENDING_LIMIT', '待处理的隔离改动已达到 3 个，请先处理已有卡片');

        let id = makeResultId();
        let resultRoot = path.join(artifactsRoot, id);
        while (fs.existsSync(resultRoot)) {
          id = makeResultId();
          resultRoot = path.join(artifactsRoot, id);
        }
        await fsp.mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
        await assertSafeExistingPath(artifactsRoot, { directory: true });
        await fsp.mkdir(resultRoot, { recursive: false, mode: 0o700 });
        const checkout = path.join(resultRoot, 'checkout');
        const marker = createMarker({
          id,
          sessionId: String(sessionId || ''),
          subagentId: String(subagentId || ''),
          goal: String(goal || ''),
          repoRoot: repo.repoRoot,
          projectRoot: repo.projectRoot,
          projectIdentity: repo.projectIdentity,
          projectRel: repo.projectRel,
          baseHead: repo.baseHead,
          worktreeGitDir: '',
        });
        if (!marker) return worktreeError('PATH_UNSAFE', '无法创建 worktree marker');
        await writeMarker(resultRoot, marker);
        const added = await git(repo.repoRoot, [
          'worktree', 'add', '--detach', '--lock', '--reason', `codex-qq:${id}`, checkout, repo.baseHead,
        ]);
        if (!added.ok) {
          const current = await resultById(repo.projectRoot, id);
          if (current) {
            try { await cleanupFailedCreate(current, repo); } catch { /* recovery will retain unsafe leftovers */ }
          }
          return worktreeError('WORKTREE_CREATE_FAILED', added.error || 'git worktree add 失败');
        }
        const gitDirResult = await git(checkout, ['rev-parse', '--git-dir']);
        const childTop = await git(checkout, ['rev-parse', '--show-toplevel']);
        if (!gitDirResult.ok || !childTop.ok || !samePath(childTop.stdout.toString('utf8').trim(), checkout)) {
          const current = await resultById(repo.projectRoot, id);
          if (current) {
            try { await cleanupFailedCreate(current, repo); } catch { /* recovery will retain unsafe leftovers */ }
          }
          return worktreeError('WORKTREE_CREATE_FAILED', '无法验证新建的隔离 worktree');
        }
        const gitDirRaw = gitDirResult.stdout.toString('utf8').trim();
        const worktreeGitDir = path.isAbsolute(gitDirRaw) ? path.resolve(gitDirRaw) : path.resolve(checkout, gitDirRaw);
        createdResult = await resultById(repo.projectRoot, id);
        if (!createdResult) return worktreeError('WORKTREE_CREATE_FAILED', '无法读取新建 worktree marker');
        await updateState(createdResult, 'running', { worktreeGitDir });
        const childProjectPath = path.join(checkout, repo.projectRel);
        if (!pathInside(checkout, childProjectPath) || !fs.existsSync(childProjectPath)) {
          return worktreeError('WORKTREE_CREATE_FAILED', '隔离 worktree 中找不到绑定项目目录');
        }
        return {
          ok: true,
          handle: {
            id,
            projectPath: repo.projectRoot,
            projectIdentity: repo.projectIdentity,
            repoRoot: repo.repoRoot,
            projectRel: repo.projectRel,
            resultRoot,
            checkout,
            childProjectPath,
            baseHead: repo.baseHead,
          },
        };
      } catch (err) {
        if (createdResult) {
          try { await cleanupFailedCreate(createdResult, repo); } catch { /* recovery retains unverifiable artifacts */ }
        }
        return worktreeError(err.code || 'WORKTREE_CREATE_FAILED', err.message || '创建隔离 worktree 失败');
      }
    });
  }

  async function collect(handle, { incomplete = false } = {}) {
    const repo = await resolveRepo(handle?.projectPath);
    return withProjectLock(repo.projectIdentity, async () => {
      const result = await resultById(repo.projectRoot, handle?.id);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (!['running', 'collect_failed', 'collecting'].includes(result.marker.state)) return worktreeError('COLLECT_FAILED', '当前结果不能收集');
      try {
        if (result.marker.state !== 'collecting') await updateState(result, 'collecting', { incomplete: incomplete === true, error: null, errorCode: null });
        await validateWorktreeMetadata(result, repo);
        await validateScopedModes(result.checkout, repo.projectRel);
        const scope = pathspecFor(repo.projectRel);
        const add = await git(result.checkout, ['--literal-pathspecs', 'add', '-A', '--', scope]);
        if (!add.ok) throw Object.assign(new Error(add.error || '无法收集隔离改动'), { code: 'COLLECT_FAILED' });
        // A child may create a symlink or gitlink after the initial preflight.
        // Validate the staged index, which is the actual patch source.
        await validateScopedModes(result.checkout, repo.projectRel);
        const changed = await git(result.checkout, ['--literal-pathspecs', 'diff', '--cached', '--quiet', '--', scope], { allowNonZero: true });
        if (!changed.ok) throw Object.assign(new Error(changed.error || '无法检查隔离改动'), { code: 'COLLECT_FAILED' });
        if (changed.code === 0) {
          await updateState(result, 'discarded_cleanup_pending', { errorCode: null, error: null });
          await cleanupResult(repo, result.marker.id);
          return { ok: true, changed: false };
        }
        const patch = await gitStream(result.checkout, [...PATCH_DIFF_ARGS, scope], { maxBytes: PATCH_MAX_BYTES });
        if (!patch.ok) throw Object.assign(new Error(patch.error || '无法生成 Git patch'), { code: 'COLLECT_FAILED' });
        const nameStatus = await git(result.checkout, ['--literal-pathspecs', 'diff', '--cached', '--name-status', '-z', '--find-renames=50%', '--', scope]);
        const numstat = await git(result.checkout, ['--literal-pathspecs', 'diff', '--cached', '--numstat', '-z', '--find-renames=50%', '--', scope]);
        if (!nameStatus.ok || !numstat.ok) throw Object.assign(new Error('无法生成变更摘要'), { code: 'COLLECT_FAILED' });
        const files = parseNameStatus(nameStatus.stdout, repo.projectRel);
        const stats = parseNumstat(numstat.stdout, files);
        const expectedTree = await writeTree(result.checkout);
        if (patch.tooLarge) {
          await updateState(result, 'oversize', {
            incomplete: incomplete === true,
            expectedTree,
            patchSha256: null,
            patchBytes: patch.outputBytes,
            files: files.slice(0, FILE_SUMMARY_LIMIT),
            filesTruncated: files.length > FILE_SUMMARY_LIMIT,
            stats,
            errorCode: 'PATCH_TOO_LARGE',
            error: '完整补丁超过 16 MiB，不能直接应用',
          });
          return { ok: false, code: 'PATCH_TOO_LARGE', error: '完整补丁超过 16 MiB，不能直接应用', result: publicSummary(result.marker) };
        }
        const patchPath = path.join(result.root, 'result.patch');
        await atomicWrite(patchPath, patch.stdout, async (tempPatchPath) => {
          const replayedTree = await replayPatchTree(repo.repoRoot, result.marker.baseHead, tempPatchPath);
          if (replayedTree !== expectedTree) {
            throw Object.assign(new Error('隔离补丁无法精确重放为 worktree index'), { code: 'PATCH_INVALID' });
          }
        });
        await updateState(result, 'ready', {
          incomplete: incomplete === true,
          expectedTree,
          patchSha256: hashBytes(patch.stdout),
          patchBytes: patch.stdout.length,
          files: files.slice(0, FILE_SUMMARY_LIMIT),
          filesTruncated: files.length > FILE_SUMMARY_LIMIT,
          stats,
          errorCode: null,
          error: null,
        });
        return { ok: true, changed: true, result: publicSummary(result.marker) };
      } catch (err) {
        try {
          if (result.marker.state === 'collecting') await updateState(result, 'collect_failed', {
            errorCode: err.code || 'COLLECT_FAILED', error: shortError(err.message), incomplete: incomplete === true,
          });
        } catch { /* preserve the original failure */ }
        return worktreeError(err.code || 'COLLECT_FAILED', err.message || '收集隔离改动失败');
      }
    });
  }

  async function get({ projectPath, resultId, preview = false }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const result = await resultById(repo.projectRoot, resultId);
    if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
    const summary = publicSummary(result.marker);
    if (!preview || !summary.canPreview) return { ok: true, result: summary };
    try {
      const validated = await validateReadyResult(result, repo);
      const bytes = validated.bytes;
      const text = bytes.toString('utf8');
      const lines = text.split(/\r?\n/);
      const bounded = lines.length > 800 || bytes.length > 64 * 1024;
      const previewText = bounded
        ? `${lines.slice(0, 400).join('\n')}\n\n... diff preview truncated ...\n\n${lines.slice(-400).join('\n')}`.slice(0, 64 * 1024)
        : text;
      return { ok: true, result: summary, preview: previewText, previewTruncated: bounded };
    } catch (err) {
      return worktreeError(err.code || 'PATCH_INVALID', err.message || '隔离补丁不存在或无法读取');
    }
  }

  async function retryCollect({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const result = await resultById(repo.projectRoot, resultId);
    if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
    if (result.marker.state !== 'collect_failed') return worktreeError('COLLECT_FAILED', '当前结果不需要重试收集');
    return collect({
      id: result.marker.id,
      projectPath: repo.projectRoot,
      projectIdentity: repo.projectIdentity,
      repoRoot: repo.repoRoot,
      projectRel: repo.projectRel,
      resultRoot: result.root,
      checkout: result.checkout,
      childProjectPath: path.join(result.checkout, repo.projectRel),
      baseHead: result.marker.baseHead,
    }, { incomplete: result.marker.incomplete });
  }

  async function open({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const result = await resultById(repo.projectRoot, resultId);
    if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
    try { await validateWorktreeMetadata(result, repo); } catch (err) { return worktreeError(err.code || 'GIT_METADATA_CHANGED', err.message); }
    const target = path.join(result.checkout, repo.projectRel);
    if (!pathInside(result.checkout, target)) return worktreeError('PATH_UNSAFE', '隔离项目路径越界');
    try { await assertSafeExistingPath(target, { directory: true }); } catch (err) { return worktreeError('PATH_UNSAFE', err.message); }
    return { ok: true, path: target };
  }

  async function cleanup({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, () => cleanupResult(repo, resultId));
  }

  async function cleanupResult(repo, resultId) {
    const result = await resultById(repo.projectRoot, resultId);
    if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
    if (!['applied_cleanup_pending', 'discarded_cleanup_pending'].includes(result.marker.state)) {
      return worktreeError('CLEANUP_FAILED', '当前结果不处于待清理状态');
    }
    try {
      const registered = await worktreeRegistration(result.checkout, repo.repoRoot);
      if (registered) {
        await validateWorktreeMetadata(result, repo);
        await git(repo.repoRoot, ['worktree', 'unlock', result.checkout], { allowNonZero: true });
        const removed = await git(repo.repoRoot, ['worktree', 'remove', '--force', result.checkout]);
        if (!removed.ok) throw Object.assign(new Error(removed.error || '无法移除隔离 worktree'), { code: 'CLEANUP_FAILED' });
        if (await worktreeRegistration(result.checkout, repo.repoRoot)) {
          throw Object.assign(new Error('隔离 worktree 移除后仍在 Git 中登记'), { code: 'CLEANUP_FAILED' });
        }
      } else if (fs.existsSync(result.checkout)) {
        throw Object.assign(new Error('隔离 worktree 未登记但目录仍存在，拒绝删除'), { code: 'GIT_METADATA_CHANGED' });
      }
      await removeArtifact(result);
      return { ok: true, cleaned: true };
    } catch (err) {
      return worktreeError('CLEANUP_FAILED', err.message || '清理隔离 worktree 失败');
    }
  }

  async function discard({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      const result = await resultById(repo.projectRoot, resultId);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (result.marker.state === 'applied_cleanup_pending') return worktreeError('CLEANUP_FAILED', '已应用的结果只能重试清理');
      if (result.marker.state === 'pr_failed') {
        const cleaned = await cleanupPrCheckout(repo, result, result.marker.pr.head);
        if (!cleaned.ok) return cleaned;
        await updateState(result, 'discarded_cleanup_pending');
        await removeArtifact(result);
        return { ok: true, cleaned: true, remoteBranchRetained: result.marker.pr.pushed === true };
      }
      if (result.marker.state !== 'discarded_cleanup_pending') {
        try { await updateState(result, 'discarded_cleanup_pending'); } catch (err) { return worktreeError(err.code || 'CLEANUP_FAILED', err.message); }
      }
      return cleanupResult(repo, result.marker.id);
    });
  }

  async function apply({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      const result = await resultById(repo.projectRoot, resultId);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (!['ready', 'conflict'].includes(result.marker.state)) return worktreeError('PATCH_INVALID', '当前隔离结果不能应用');
      const conflict = async (code, error) => {
        try { await updateState(result, 'conflict', { errorCode: code, error }); } catch { /* preserve response */ }
        return worktreeError(code, error, { result: publicSummary(result.marker) });
      };
      if (repo.baseHead !== result.marker.baseHead) return conflict('BASE_CHANGED', '主分支 HEAD 已变化，不能直接应用该隔离结果');
      if (!await statusIsClean(repo.repoRoot)) return conflict('WORKTREE_DIRTY', '主工作区存在变更，不能直接应用该隔离结果');
      let applyStarted = false;
      try {
        const { canonical } = await validateReadyResult(result, repo);
        await validateAffectedParents(repo.repoRoot, canonical.files);
        const baseTreeResult = await git(repo.repoRoot, ['rev-parse', `${result.marker.baseHead}^{tree}`]);
        const baseTree = baseTreeResult.ok ? baseTreeResult.stdout.toString('utf8').trim().toLowerCase() : '';
        if (!/^[a-f0-9]{40}$/.test(baseTree)) return worktreeError('PATCH_INVALID', '无法解析隔离结果的基线 tree');
        const mainIndexTree = await writeTree(repo.repoRoot, undefined, 'PATCH_INVALID');
        if (mainIndexTree !== baseTree) return conflict('WORKTREE_DIRTY', '主工作区 index 已变化，不能直接应用该隔离结果');
        const check = await git(repo.repoRoot, ['apply', '--check', '--binary', result.patch], { allowNonZero: true });
        if (!check.ok || check.code !== 0) return conflict('PATCH_CONFLICT', shortError(check.stderr.toString('utf8') || '补丁与当前主工作区冲突'));

        const [currentHead] = await Promise.all([
          git(repo.repoRoot, ['rev-parse', '--verify', 'HEAD']),
          validateWorktreeMetadata(result, repo),
          validateAffectedParents(repo.repoRoot, canonical.files),
        ]);
        if (!currentHead.ok || currentHead.stdout.toString('utf8').trim().toLowerCase() !== result.marker.baseHead) {
          return conflict('BASE_CHANGED', '主分支 HEAD 已变化，不能直接应用该隔离结果');
        }
        if (!await statusIsClean(repo.repoRoot)
          || await writeTree(repo.repoRoot, undefined, 'PATCH_INVALID') !== baseTree) {
          return conflict('WORKTREE_DIRTY', '主工作区在应用前发生变化，不能直接应用该隔离结果');
        }

        await updateState(result, 'applying', { errorCode: null, error: null });
        applyStarted = true;
        const applied = await git(repo.repoRoot, ['apply', '--binary', result.patch]);
        if (!applied.ok) {
          try {
            const tree = await withAlternateTree(repo.repoRoot, result.marker.baseHead);
            if (tree === baseTree) return conflict('PATCH_CONFLICT', applied.error || '应用补丁失败');
          } catch { /* uncertain below */ }
          await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: '补丁应用后无法确认主工作区状态' });
          return worktreeError('APPLY_UNCERTAIN', '补丁应用后无法确认主工作区状态');
        }
        const actualTree = await withAlternateTree(repo.repoRoot, result.marker.baseHead);
        const indexTree = await writeTree(repo.repoRoot);
        if (actualTree !== result.marker.expectedTree || indexTree !== baseTree) {
          await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: '补丁已运行但 Git tree 校验不一致' });
          return worktreeError('APPLY_UNCERTAIN', '补丁已运行但无法确认完整结果');
        }
        await updateState(result, 'applied_cleanup_pending');
        const cleaned = await cleanupResult(repo, result.marker.id);
        return { ok: true, applied: true, cleanupWarning: cleaned.ok ? null : cleaned.error, result: publicSummary(result.marker) };
      } catch (err) {
        if (!applyStarted) {
          return worktreeError(err.code || 'PATCH_INVALID', err.message || '隔离补丁应用前校验失败', {
            result: publicSummary(result.marker),
          });
        }
        try { await updateState(result, 'apply_uncertain', { errorCode: 'APPLY_UNCERTAIN', error: shortError(err.message) }); } catch { /* ignore */ }
        return worktreeError('APPLY_UNCERTAIN', err.message || '应用隔离补丁失败');
      }
    });
  }

  function normalizePrInput(raw = {}) {
    const title = String(raw.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
    const body = String(raw.body || '').trim().slice(0, 10000);
    if (!title) return { ok: false, code: 'PR_INVALID', error: 'PR 标题不能为空' };
    if (!body) return { ok: false, code: 'PR_INVALID', error: 'PR 正文不能为空' };
    return { ok: true, title, body, draft: raw.draft !== false };
  }

  async function cleanupPrCheckout(repo, result, branch) {
    try {
      const registered = await worktreeRegistration(result.checkout, repo.repoRoot);
      if (registered) {
        await git(repo.repoRoot, ['worktree', 'unlock', result.checkout], { allowNonZero: true });
        const removed = await git(repo.repoRoot, ['worktree', 'remove', '--force', result.checkout]);
        if (!removed.ok || await worktreeRegistration(result.checkout, repo.repoRoot)) {
          throw Object.assign(new Error(removed.error || '无法清理 PR 隔离 worktree'), { code: 'CLEANUP_FAILED' });
        }
      }
      if (branch) {
        const deleted = await git(repo.repoRoot, ['branch', '-D', '--', branch], { allowNonZero: true });
        if (deleted.code !== 0 && await branchExists(repo.repoRoot, branch)) {
          throw Object.assign(new Error(deleted.error || '无法清理 PR 临时分支'), { code: 'CLEANUP_FAILED' });
        }
      }
      const patchPath = path.join(result.root, 'result.patch');
      try { await fsp.unlink(patchPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      return { ok: true };
    } catch (err) {
      return worktreeError('CLEANUP_FAILED', shortError(err.message || err));
    }
  }

  async function branchExists(repoRoot, branch) {
    const check = await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowNonZero: true });
    return check.code === 0;
  }

  function publicPrSummary(marker) {
    const summary = publicSummary(marker);
    if (!summary) return null;
    return summary;
  }

  async function validateStoredPatch(result, repo) {
    await validatePrWorktreeMetadata(result, repo);
    await assertSafeExistingPath(result.patch);
    const bytes = await fsp.readFile(result.patch);
    if (bytes.length !== result.marker.patchBytes || hashBytes(bytes) !== result.marker.patchSha256) {
      throw Object.assign(new Error('隔离补丁校验失败'), { code: 'PATCH_INVALID' });
    }
    const replayedTree = await replayPatchTree(repo.repoRoot, result.marker.baseHead, result.patch);
    if (replayedTree !== result.marker.expectedTree) {
      throw Object.assign(new Error('隔离补丁重放结果不一致'), { code: 'PATCH_INVALID' });
    }
  }

  async function preparePrCommit(result, repo, branch, title) {
    await validateStoredPatch(result, repo);
    const detached = await git(result.checkout, ['checkout', '--detach', result.marker.baseHead]);
    if (!detached.ok) throw Object.assign(new Error(detached.error || '无法恢复 PR 隔离基线'), { code: 'BRANCH_CREATE_FAILED' });
    const reset = await git(result.checkout, ['reset', '--hard', result.marker.baseHead]);
    if (!reset.ok) throw Object.assign(new Error(reset.error || '无法恢复 PR 隔离基线'), { code: 'BRANCH_CREATE_FAILED' });
    const clean = await git(result.checkout, ['clean', '-fd']);
    if (!clean.ok) throw Object.assign(new Error(clean.error || '无法清理 PR 隔离目录'), { code: 'BRANCH_CREATE_FAILED' });
    const existing = await git(repo.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowNonZero: true });
    if (existing.code === 0) {
      const removed = await git(repo.repoRoot, ['branch', '-D', '--', branch]);
      if (!removed.ok) throw Object.assign(new Error(removed.error || 'PR 临时分支已存在且无法替换'), { code: 'BRANCH_EXISTS' });
    }
    const checkoutBranch = await git(result.checkout, ['checkout', '-b', branch]);
    if (!checkoutBranch.ok) throw Object.assign(new Error(checkoutBranch.error || '无法创建 PR 临时分支'), { code: 'BRANCH_CREATE_FAILED' });
    const applied = await git(result.checkout, ['apply', '--index', '--binary', result.patch]);
    if (!applied.ok) throw Object.assign(new Error(applied.error || '无法恢复隔离补丁'), { code: 'PATCH_INVALID' });
    if (await writeTree(result.checkout, undefined, 'COMMIT_INVALID') !== result.marker.expectedTree) {
      throw Object.assign(new Error('PR commit tree 与隔离结果不一致'), { code: 'COMMIT_INVALID' });
    }
    const commit = await git(result.checkout, ['commit', '--no-verify', '--no-gpg-sign', '-m', title]);
    if (!commit.ok) throw Object.assign(new Error(commit.error || '无法提交隔离改动'), { code: 'COMMIT_FAILED' });
    const commitShaResult = await git(result.checkout, ['rev-parse', 'HEAD']);
    const commitSha = commitShaResult.ok ? commitShaResult.stdout.toString('utf8').trim().toLowerCase() : '';
    const commitTree = await git(result.checkout, ['rev-parse', 'HEAD^{tree}']);
    if (!/^[a-f0-9]{40}$/.test(commitSha)
      || !commitTree.ok
      || commitTree.stdout.toString('utf8').trim().toLowerCase() !== result.marker.expectedTree) {
      throw Object.assign(new Error('无法确认 PR commit'), { code: 'COMMIT_UNCERTAIN' });
    }
    return commitSha;
  }

  async function confirmStoredCommit(repo, result, commit) {
    if (!/^[a-f0-9]{40}$/.test(String(commit || ''))) return false;
    const tree = await git(repo.repoRoot, ['rev-parse', `${commit}^{tree}`]);
    return tree.ok && tree.stdout.toString('utf8').trim().toLowerCase() === result.marker.expectedTree;
  }

  async function finishCreatedPr(repo, result, branch, pr, input, commitSha) {
    await updateState(result, 'pr_cleanup_pending', {
      error: null,
      errorCode: null,
      pr: {
        ...result.marker.pr,
        commit: commitSha,
        url: String(pr?.url || '').slice(0, 2000),
        number: Number(pr?.number) || 0,
        draft: pr?.isDraft !== false && input.draft,
        title: input.title,
        pushed: true,
      },
    });
    const cleaned = await cleanupPrCheckout(repo, result, branch);
    if (!cleaned.ok) {
      await writeMarker(result.root, { ...result.marker, errorCode: cleaned.code, error: cleaned.error, updatedAt: Date.now() });
      result.marker = await readMarker(result.root);
      return { ok: true, created: true, cleanupWarning: cleaned.error, result: publicPrSummary(result.marker) };
    }
    await updateState(result, 'pr_created', { error: null, errorCode: null });
    return { ok: true, created: true, result: publicPrSummary(result.marker) };
  }

  async function preflightPr({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const result = await resultById(repo.projectRoot, resultId);
    if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
    if (!['ready', 'conflict', 'pr_failed'].includes(result.marker.state)) return worktreeError('PR_INVALID', '当前隔离结果不能创建 PR');
    try {
      if (['ready', 'conflict'].includes(result.marker.state)) await validateReadyResult(result, repo);
      else await validateStoredPatch(result, repo);
      if (!await statusIsClean(repo.repoRoot)) return worktreeError('WORKTREE_DIRTY', '主工作区存在变更，不能创建 PR');
      const checked = await github.preflight({ repoRoot: repo.repoRoot, baseHead: result.marker.baseHead });
      return checked.ok ? { ...checked, result: publicPrSummary(result.marker) } : checked;
    } catch (err) {
      return worktreeError(err.code || 'PR_INVALID', shortError(err.message || err));
    }
  }

  async function createPr({ projectPath, resultId, title, body, draft = true }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      const result = await resultById(repo.projectRoot, resultId);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (!['ready', 'conflict', 'pr_failed'].includes(result.marker.state)) return worktreeError('PR_INVALID', '当前隔离结果不能创建 PR', { result: publicPrSummary(result.marker) });
      const input = normalizePrInput({ title, body, draft });
      if (!input.ok) return input;
      const priorPr = { ...result.marker.pr };
      await updateState(result, 'pr_preparing', { error: null, errorCode: null, pr: { ...priorPr, title: input.title, draft: input.draft } });
      const branch = `codex/${result.marker.id}`;
      try {
        if (!await statusIsClean(repo.repoRoot)) throw Object.assign(new Error('主工作区存在变更，不能创建 PR'), { code: 'WORKTREE_DIRTY' });
        const preflight = await github.preflight({ repoRoot: repo.repoRoot, baseHead: result.marker.baseHead });
        if (!preflight.ok) throw Object.assign(new Error(preflight.error), { code: preflight.code });
        const remotePr = { host: preflight.remote.host, owner: preflight.remote.owner, repo: preflight.remote.repo, base: preflight.base, head: branch, title: input.title, draft: input.draft };
        let commitSha = await confirmStoredCommit(repo, result, priorPr.commit) ? priorPr.commit : '';
        if (priorPr.pushed) {
          const existing = await github.findExistingPr({ repoRoot: repo.repoRoot, ...remotePr });
          if (!existing.ok) throw Object.assign(new Error(existing.error), { code: existing.code });
          if (existing.count > 1) throw Object.assign(new Error('同一分支存在多个 PR，无法安全继续'), { code: 'PR_AMBIGUOUS' });
          if (existing.pr) {
            await updateState(result, 'pr_creating', { pr: { ...result.marker.pr, ...remotePr, commit: commitSha, pushed: true } });
            return finishCreatedPr(repo, result, branch, existing.pr, input, commitSha);
          }
          if (!commitSha) throw Object.assign(new Error('已推送提交无法在本地验证'), { code: 'COMMIT_UNCERTAIN' });
        }
        if (!commitSha) {
          await updateState(result, 'pr_committing', { pr: { ...result.marker.pr, ...remotePr, pushed: false } });
          commitSha = await preparePrCommit(result, repo, branch, input.title);
        }
        if (!priorPr.pushed) {
          if (result.marker.state !== 'pr_pushing') await updateState(result, 'pr_pushing', { pr: { ...result.marker.pr, ...remotePr, commit: commitSha, pushed: false } });
          const pushed = await github.pushBranch({ repoRoot: repo.repoRoot, branch, source: commitSha });
          if (!pushed.ok) throw Object.assign(new Error(pushed.error), { code: pushed.code });
        }
        await updateState(result, 'pr_creating', { pr: { ...result.marker.pr, ...remotePr, commit: commitSha, pushed: true } });
        const created = await github.createPr({ repoRoot: repo.repoRoot, ...remotePr, title: input.title, body: input.body, draft: input.draft });
        if (!created.ok) throw Object.assign(new Error(created.error), { code: created.code });
        return finishCreatedPr(repo, result, branch, created.pr, input, commitSha);
      } catch (err) {
        if (!['pr_cleanup_pending', 'pr_created'].includes(result.marker.state)) {
          try { await updateState(result, 'pr_failed', { errorCode: err.code || 'PR_FAILED', error: shortError(err.message), pr: { ...result.marker.pr, head: branch, title: input.title, draft: input.draft } }); } catch { /* preserve response */ }
        }
        return worktreeError(err.code || 'PR_FAILED', shortError(err.message || err), { result: publicPrSummary(result.marker) });
      }
    });
  }

  async function retryPr(args) { return createPr(args); }

  async function cleanupPr({ projectPath, resultId }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      const result = await resultById(repo.projectRoot, resultId);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) return worktreeError('RESULT_NOT_FOUND', '隔离结果不存在');
      if (result.marker.state !== 'pr_cleanup_pending') return worktreeError('CLEANUP_FAILED', '当前 PR 结果不需要清理');
      const cleaned = await cleanupPrCheckout(repo, result, result.marker.pr.head);
      if (!cleaned.ok) return cleaned;
      await updateState(result, 'pr_created');
      return { ok: true, cleaned: true, result: publicPrSummary(result.marker) };
    });
  }

  function normalizePrNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 && number <= 0x7fffffff ? number : 0;
  }

  function publicPrRepo(context) {
    return {
      host: String(context?.remote?.host || '').slice(0, 255),
      owner: String(context?.remote?.owner || '').slice(0, 255),
      repo: String(context?.remote?.repo || '').slice(0, 255),
      base: String(context?.base || '').slice(0, 255),
      nameWithOwner: String(context?.nameWithOwner || '').slice(0, 600),
    };
  }

  async function resolvePrContext(repo) {
    if (typeof github.repository !== 'function') return worktreeError('GH_REPO_FAILED', 'GitHub CLI 适配器不支持 PR 管理');
    const context = await github.repository({ repoRoot: repo.repoRoot });
    if (!context?.ok) return context || worktreeError('GH_REPO_FAILED', '无法读取 GitHub 仓库信息');
    return context;
  }

  async function resolvePrTarget(repo, context, args = {}) {
    let result = null;
    let number = normalizePrNumber(args.number);
    if (args.resultId) {
      result = await resultById(repo.projectRoot, args.resultId);
      if (!result || result.marker.projectIdentity !== repo.projectIdentity) {
        return worktreeError('RESULT_NOT_FOUND', 'PR 结果不存在');
      }
      number = normalizePrNumber(result.marker.pr?.number);
      const markerRepo = result.marker.pr || {};
      const same = (left, right) => String(left || '').toLowerCase() === String(right || '').toLowerCase();
      if (!number || !same(markerRepo.host, context.remote.host)
        || !same(markerRepo.owner, context.remote.owner)
        || !same(markerRepo.repo, context.remote.repo)) {
        return worktreeError('PR_INVALID', 'PR marker 与当前 origin 不一致', { result: publicPrSummary(result.marker) });
      }
    }
    if (!number) return worktreeError('PR_INVALID', 'PR 编号无效');
    return { ok: true, number, result };
  }

  async function loadPrDetails(repo, context, target) {
    const viewed = await github.getPr({
      repoRoot: repo.repoRoot,
      host: context.remote.host,
      owner: context.remote.owner,
      repo: context.remote.repo,
      number: target.number,
    });
    if (!viewed?.ok || !viewed.pr) return viewed || worktreeError('PR_LOOKUP_FAILED', '无法读取 PR 详情');
    const checks = typeof github.getChecks === 'function'
      ? await github.getChecks({
        repoRoot: repo.repoRoot,
        host: context.remote.host,
        owner: context.remote.owner,
        repo: context.remote.repo,
        number: target.number,
      })
      : { ok: false, code: 'PR_CHECKS_FAILED', error: 'GitHub CLI 不支持 checks' };
    const pr = {
      ...viewed.pr,
      checks: checks.ok ? checks.checks : [],
      checksSummary: checks.ok ? checks.summary : { total: 0, passed: 0, pending: 0, failed: 0, skipped: 0, unknown: 0 },
    };
    return {
      ok: true,
      repo: publicPrRepo(context),
      pr,
      checksOk: checks.ok,
      warnings: checks.ok ? [] : [checks.code || 'PR_CHECKS_FAILED'],
      checksError: checks.ok ? null : checks.error,
      result: target.result ? publicSummary(target.result.marker) : null,
    };
  }

  async function syncPrMarker(target, detail) {
    if (!target?.result || !detail?.pr) return null;
    const existing = target.result.marker.pr || {};
    const nextPr = {
      ...existing,
      host: detail.repo.host,
      owner: detail.repo.owner,
      repo: detail.repo.repo,
      base: detail.repo.base || existing.base,
      number: detail.pr.number,
      url: detail.pr.url,
      title: detail.pr.title,
      draft: detail.pr.isDraft,
      state: detail.pr.state,
      headSha: detail.pr.headSha || existing.headSha || existing.commit,
      mergeable: detail.pr.mergeable,
      mergeStateStatus: detail.pr.mergeStateStatus,
      updatedAt: detail.pr.updatedAt,
      checksSummary: detail.pr.checksSummary,
    };
    target.result.marker = await writeMarker(target.result.root, {
      ...target.result.marker,
      pr: nextPr,
      updatedAt: Date.now(),
    });
    detail.result = publicSummary(target.result.marker);
    return detail.result;
  }

  async function listPrs({ projectPath, state = 'open' }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const context = await resolvePrContext(repo);
    if (!context.ok) return context;
    const listed = await github.listPrs({
      repoRoot: repo.repoRoot,
      host: context.remote.host,
      owner: context.remote.owner,
      repo: context.remote.repo,
      state,
      limit: 51,
    });
    if (!listed?.ok) return listed || worktreeError('PR_LOOKUP_FAILED', '无法读取 PR 列表');
    return { ok: true, repo: publicPrRepo(context), prs: listed.prs, truncated: listed.truncated === true, state: listed.state };
  }

  async function getPr({ projectPath, number, resultId, syncMarker = true }) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    const context = await resolvePrContext(repo);
    if (!context.ok) return context;
    const target = await resolvePrTarget(repo, context, { number, resultId });
    if (!target.ok) return target;
    const detail = await loadPrDetails(repo, context, target);
    if (!detail.ok) return detail;
    if (syncMarker !== false) {
      try { await syncPrMarker(target, detail); } catch (err) { return worktreeError(err.code || 'PR_INVALID', shortError(err.message), { ...detail }); }
    }
    return detail;
  }

  async function runPrMutation({ projectPath, number, resultId }, action) {
    let repo;
    try { repo = await resolveRepo(projectPath); } catch (err) { return worktreeError(err.code || 'NOT_GIT_REPO', err.message); }
    return withProjectLock(repo.projectIdentity, async () => {
      const context = await resolvePrContext(repo);
      if (!context.ok) return context;
      const target = await resolvePrTarget(repo, context, { number, resultId });
      if (!target.ok) return target;
      const before = await loadPrDetails(repo, context, target);
      if (!before.ok) return before;
      const outcome = await action({ repo, context, target, before });
      if (!outcome?.ok && !outcome?.uncertain) return outcome || worktreeError('PR_ACTION_FAILED', 'PR 操作失败');
      const after = await loadPrDetails(repo, context, target);
      if (!after.ok) return worktreeError('PR_ACTION_UNCERTAIN', '操作已发出，但无法刷新确认 PR 状态', { before: before.pr, result: before.result });
      try { await syncPrMarker(target, after); } catch (err) { return worktreeError(err.code || 'PR_INVALID', shortError(err.message), { ...after }); }
      if (outcome.uncertain && typeof outcome.verify !== 'function') {
        return worktreeError('PR_ACTION_UNCERTAIN', '操作可能已完成，但无法自动证明不会重复副作用', { ...after });
      }
      if (typeof outcome.verify === 'function' && !outcome.verify(after.pr)) {
        return worktreeError('PR_ACTION_UNCERTAIN', '操作已发出，但刷新后的 PR 状态不符合预期', { ...after });
      }
      return { ...after, action: outcome.action || null, commentPosted: outcome.commentPosted === true, recoveredAfterUncertain: outcome.uncertain === true };
    });
  }

  async function editPr(args = {}) {
    const title = String(args.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
    const body = String(args.body || '').slice(0, 10000);
    if (!title) return worktreeError('PR_INVALID', 'PR 标题不能为空');
    return runPrMutation(args, async ({ context, target, repo, before }) => {
      if (before.pr.state === 'MERGED') return worktreeError('PR_INVALID', '已合并的 PR 不能编辑');
      const result = await github.editPr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number, title, body });
      return { ...result, action: 'edit', verify: (pr) => pr.title === title && pr.body === body };
    });
  }

  async function commentPr(args = {}) {
    const body = String(args.body || '').trim().slice(0, 10000);
    if (!body) return worktreeError('PR_INVALID', '评论不能为空');
    return runPrMutation(args, async ({ context, target, repo }) => {
      const result = await github.commentPr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number, body });
      return result.ok ? { ok: true, action: 'comment', commentPosted: true } : { ...result, action: 'comment', code: result.code || 'PR_ACTION_FAILED' };
    });
  }

  async function closePr(args = {}) {
    return runPrMutation(args, async ({ context, target, repo, before }) => {
      if (before.pr.state !== 'OPEN') return worktreeError('PR_INVALID', '只有打开状态的 PR 才能关闭');
      const result = await github.closePr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number });
      return { ...result, action: 'close', verify: (pr) => pr.state === 'CLOSED' };
    });
  }

  async function reopenPr(args = {}) {
    return runPrMutation(args, async ({ context, target, repo, before }) => {
      if (before.pr.state !== 'CLOSED') return worktreeError('PR_INVALID', '只有关闭状态的 PR 才能重开');
      const result = await github.reopenPr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number });
      return { ...result, action: 'reopen', verify: (pr) => pr.state === 'OPEN' };
    });
  }

  async function readyPr(args = {}) {
    return runPrMutation(args, async ({ context, target, repo, before }) => {
      if (before.pr.state !== 'OPEN' || before.pr.isDraft !== true) return worktreeError('PR_INVALID', '只有打开状态的 Draft PR 才能转为 Ready');
      const result = await github.readyPr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number });
      return { ...result, action: 'ready', verify: (pr) => pr.state === 'OPEN' && pr.isDraft === false };
    });
  }

  async function mergePr(args = {}) {
    const method = ['merge', 'squash', 'rebase'].includes(String(args.method || '')) ? String(args.method) : 'squash';
    return runPrMutation(args, async ({ context, target, repo, before }) => {
      const checks = before.pr.checksSummary || {};
      if (before.pr.state !== 'OPEN' || before.pr.isDraft) return worktreeError('PR_MERGE_BLOCKED', 'Draft 或非打开状态的 PR 不能合并');
      if (before.pr.mergeable !== 'MERGEABLE') return worktreeError('PR_MERGE_BLOCKED', 'GitHub 尚未确认 PR 可合并');
      if (!checks.total) return worktreeError('PR_NO_CHECKS', '没有可用 checks，不能合并');
      if (checks.pending || checks.failed || checks.unknown || checks.passed + checks.skipped !== checks.total) {
        return worktreeError('PR_CHECKS_FAILED', 'checks 尚未全部通过，不能合并');
      }
      if (!/^[a-f0-9]{40}$/i.test(before.pr.headSha || '')) return worktreeError('PR_HEAD_CHANGED', '无法确认 PR head SHA');
      const result = await github.mergePr({ repoRoot: repo.repoRoot, host: context.remote.host, owner: context.remote.owner, repo: context.remote.repo, number: target.number, method, headSha: before.pr.headSha });
      return { ...result, action: `merge:${method}`, verify: (pr) => pr.state === 'MERGED' };
    });
  }

  return {
    create, collect, retryCollect, list, recover, get, open, apply, discard, cleanup,
    preflightPr, createPr, retryPr, cleanupPr,
    listPrs, getPr, editPr, commentPr, closePr, reopenPr, readyPr, mergePr,
  };
}

module.exports = {
  PATCH_DIFF_ARGS,
  createWorktreeManager,
  encodeGitignoreLiteral,
  ensureExclude,
  parseNameStatus,
  parseNumstat,
  projectIdentity,
  assertSafeChildPath,
};
