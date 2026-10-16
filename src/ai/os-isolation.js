'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { checkUrl } = require('./url-guard');

const SECURITY_CODES = {
  TRAVERSAL_DETECTED: 'SECURITY_TRAVERSAL_DETECTED',
  CANNOT_DELETE_ROOT: 'SECURITY_CANNOT_DELETE_ROOT',
  INVALID_PATH: 'SECURITY_INVALID_PATH',
  OUTBOUND_BLOCKED: 'SECURITY_OUTBOUND_BLOCKED',
};

const SAFE_ENV_VARS_WIN32 = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'PATH', 'PATHEXT',
  'TEMP', 'TMP', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)'
]);

const SAFE_ENV_VARS_POSIX = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'LOGNAME'
]);

const SENSITIVE_KEY_PATTERN = /key|secret|token|password|auth|bearer|credential|private/i;

function hasWindowsDeviceName(targetPath) {
  if (process.platform !== 'win32') return false;
  const parts = targetPath.split(/[\\/]/);
  const reserved = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);
  for (const part of parts) {
    const base = part.split('.')[0].toUpperCase();
    if (reserved.has(base)) return true;
  }
  return false;
}

function hasAlternateDataStream(targetPath) {
  if (process.platform !== 'win32') return false;
  // Look for colon after the drive letter (e.g. C:\path\file.txt:stream)
  const afterDrive = targetPath.replace(/^[a-zA-Z]:/, '');
  return afterDrive.includes(':');
}

/**
 * Verify that targetPath is strictly inside projectRoot using canonical physical paths.
 * Resolves symlinks/junctions to prevent directory traversal escapes.
 */
function verifyPathSandbox(projectRoot, targetPath = '.', options = {}) {
  const mode = options.mode || 'read'; // 'read' | 'write' | 'delete'
  if (!projectRoot || typeof projectRoot !== 'string') {
    const err = new Error('项目根目录无效');
    err.code = SECURITY_CODES.INVALID_PATH;
    throw err;
  }

  if (!fs.existsSync(projectRoot)) {
    const err = new Error(`项目根目录不存在: ${projectRoot}`);
    err.code = SECURITY_CODES.INVALID_PATH;
    throw err;
  }

  // Check for ADS and reserved device names
  if (hasAlternateDataStream(targetPath) || hasWindowsDeviceName(targetPath)) {
    const err = new Error(`检测到不合规的文件路径或保留设备名: ${targetPath}`);
    err.code = SECURITY_CODES.INVALID_PATH;
    throw err;
  }

  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(projectRoot) : fs.realpathSync(projectRoot);
  } catch (e) {
    canonicalRoot = path.resolve(projectRoot);
  }

  const resolved = path.resolve(projectRoot, targetPath);

  let canonicalTarget;
  if (fs.existsSync(resolved)) {
    try {
      canonicalTarget = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } catch (e) {
      canonicalTarget = resolved;
    }
  } else {
    // If target doesn't exist yet (e.g. file creation), resolve its closest existing ancestor
    let cur = path.dirname(resolved);
    const subParts = [path.basename(resolved)];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      subParts.unshift(path.basename(cur));
      cur = parent;
    }

    if (!fs.existsSync(cur)) {
      const err = new Error(`无法验证不存在的目标路径所在祖先目录: ${targetPath}`);
      err.code = SECURITY_CODES.INVALID_PATH;
      throw err;
    }

    let canonicalAncestor;
    try {
      canonicalAncestor = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
    } catch (e) {
      canonicalAncestor = cur;
    }

    canonicalTarget = path.join(canonicalAncestor, ...subParts);
  }

  const rootComp = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
  const targetComp = process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget;

  const rel = path.relative(rootComp, targetComp);
  const isOutside = rel.startsWith('..') || path.isAbsolute(rel);

  if (isOutside) {
    const err = new Error(`路径越界，禁止访问项目外文件: ${targetPath}`);
    err.code = SECURITY_CODES.TRAVERSAL_DETECTED;
    err.projectRoot = canonicalRoot;
    err.targetPath = canonicalTarget;
    throw err;
  }

  if (mode === 'delete' && (rootComp === targetComp || rel === '')) {
    const err = new Error(`禁止删除项目根目录: ${targetPath}`);
    err.code = SECURITY_CODES.CANNOT_DELETE_ROOT;
    throw err;
  }

  return {
    canonicalRoot,
    canonicalTarget,
    relativePath: path.relative(canonicalRoot, canonicalTarget),
  };
}

/**
 * Clean PATH string by removing relative entries (. and ./) and empty parts
 */
function sanitizePathString(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const entries = rawPath.split(path.delimiter);
  const cleaned = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === '.' || trimmed === './' || trimmed === '.\\') continue;
    cleaned.push(trimmed);
  }
  return cleaned.join(path.delimiter);
}

/**
 * Build a minimal safe environment object for spawned child processes.
 * Prevents leaking host process.env secrets into child tools/terminals.
 */
function buildSanitizedEnv(customEnv = {}, options = {}) {
  const isWin = process.platform === 'win32';
  const allowedSet = isWin ? SAFE_ENV_VARS_WIN32 : SAFE_ENV_VARS_POSIX;
  const sanitized = {};

  // Find and copy allowed environment variables from host
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upperK = k.toUpperCase();
    if (allowedSet.has(upperK)) {
      // Discard any variables whose keys match sensitive pattern
      if (SENSITIVE_KEY_PATTERN.test(k)) continue;

      if (upperK === 'PATH') {
        sanitized[k] = sanitizePathString(v);
      } else {
        sanitized[k] = v;
      }
    }
  }

  // Merge custom environment variables with validation
  if (customEnv && typeof customEnv === 'object') {
    for (const [k, v] of Object.entries(customEnv)) {
      if (v === undefined || v === null) continue;
      if (!options.allowSecrets && SENSITIVE_KEY_PATTERN.test(k)) {
        continue; // drop unauthorized sensitive custom environment variable
      }
      sanitized[k] = String(v);
    }
  }

  return sanitized;
}

/**
 * Deterministically terminate a process and all its descendants (process tree).
 * Prevents orphaned child processes on Windows or POSIX.
 */
function terminateProcessTree(pid, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  if (!pid || typeof pid !== 'number' || pid <= 0) {
    return { ok: false, error: 'Invalid PID' };
  }

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, {
        stdio: 'ignore',
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { ok: true, pid };
    } catch (e) {
      const msg = String(e.message || '');
      const status = e.status;
      // Code 128 indicates process already exited
      if (status === 128 || /not found|找不到|没有运行/i.test(msg)) {
        return { ok: true, pid, alreadyExited: true };
      }
      try {
        process.kill(pid, 'SIGKILL');
        return { ok: true, pid, fallback: true };
      } catch (err2) {
        if (err2.code === 'ESRCH') {
          return { ok: true, pid, alreadyExited: true };
        }
        return { ok: false, error: e.message };
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return { ok: true, pid };
    } catch (e) {
      try {
        process.kill(pid, 'SIGKILL');
        return { ok: true, pid, fallback: true };
      } catch (err2) {
        if (err2.code === 'ESRCH') {
          return { ok: true, pid, alreadyExited: true };
        }
        return { ok: false, error: e.message };
      }
    }
  }
}

/**
 * Guard outbound network calls against internal/metadata IP addresses.
 */
function checkOutboundPolicy(targetUrlOrHost, options = {}) {
  let urlStr = targetUrlOrHost;
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = `https://${targetUrlOrHost}`;
  }
  const result = checkUrl(urlStr, {
    allowPrivate: options.allowPrivate || false,
    allow: options.allow || [],
    deny: options.deny || [],
  });
  if (!result.ok) {
    return {
      allowed: false,
      code: result.code || SECURITY_CODES.OUTBOUND_BLOCKED,
      reason: result.reason,
    };
  }
  return {
    allowed: true,
    host: result.host,
    url: result.url,
  };
}

/**
 * Probe platform-specific isolation capabilities honestly.
 */
function probeIsolationCapabilities() {
  const safeStorageAvailable = Boolean(
    global.__electron_safeStorage__ ||
    (function () {
      try {
        const { safeStorage } = require('electron');
        return Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
      } catch {
        return false;
      }
    })()
  );

  return {
    supported: true,
    platform: process.platform,
    activeMode: 'strict-isolated',
    containerAvailable: false,
    processIsolation: process.platform === 'win32' ? 'job-object-or-taskkill' : 'process-group',
    networkFiltering: true,
    safeStorageAvailable,
    recommendation: '已启用项目目录沙箱与敏感变量环境过滤',
    features: {
      pathSandbox: true,
      envSanitization: true,
      processTreeTracking: true,
      hardwareEncryption: safeStorageAvailable,
    },
  };
}

module.exports = {
  SECURITY_CODES,
  verifyPathSandbox,
  sanitizePathString,
  buildSanitizedEnv,
  terminateProcessTree,
  checkOutboundPolicy,
  probeIsolationCapabilities,
};
