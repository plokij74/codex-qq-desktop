'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runTerminal: defaultRunTerminal, isBlockedCommand } = require('./terminal');
const { canonicalProjectPath, projectKey } = require('./project-index');
const { walkFiles } = require('./search');
const { loadGitignoreRules } = require('./gitignore');
const { parseDiagnostics, MAX_DIAGNOSTICS, MAX_MESSAGE } = require('./verification-diagnostics');

const STORE_VERSION = 1;
const MAX_PROFILES = 12;
const MAX_HISTORY = 200;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_GLOBAL_RUNNING = 4;
const MAX_FINGERPRINT_FILES = 25000;
const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024;
const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 15 * 60 * 1000;
const TERMINAL = new Set(['passed', 'failed', 'timed_out', 'cancelled', 'stale', 'interrupted', 'error']);
const ACTIVE = new Set(['queued', 'running']);

function codeError(code, message) {
  const error = new Error(String(message || code).slice(0, MAX_MESSAGE));
  error.code = code;
  return error;
}

function clean(value, max = MAX_MESSAGE) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// terminal.js intentionally keeps its legacy checks conservative and mostly
// command-anchored. A saved verification profile is reusable authority, so
// also reject destructive commands after shell separators/pipelines.
function isBlockedVerificationCommand(command) {
  const value = String(command || '');
  if (isBlockedCommand(value)) return true;
  return /(?:\bformat\b|\bshutdown\b|\brm\s+-rf\s+[\\/]|\bdel\s+\/s\s+\/q\s+[a-z]:[\\/]|\bremove-item\s+-recurse\s+-force\s+[a-z]:[\\/])/i.test(value);
}

function boundUtf8(value, maxBytes = MAX_OUTPUT_BYTES) {
  const raw = String(value || '');
  const buffer = Buffer.from(raw, 'utf8');
  if (buffer.length <= maxBytes) return { text: raw, truncated: false };
  const marker = '\n...[truncated]...\n';
  const markerBytes = Buffer.byteLength(marker);
  const side = Math.max(0, Math.floor((maxBytes - markerBytes) / 2));
  let text = buffer.subarray(0, side).toString('utf8') + marker
    + buffer.subarray(Math.max(side, buffer.length - side)).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

function redact(value, root) {
  let text = String(value || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  if (root) {
    const normalizedRoot = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    text = text.replace(/\\/g, '/');
    text = text.replace(new RegExp(`${escapeRegExp(normalizedRoot)}/`, 'gi'), '');
    text = text.replace(new RegExp(escapeRegExp(normalizedRoot), 'gi'), '.');
  }
  text = text.replace(/(?:[A-Za-z]:[\\/]|\/[A-Za-z0-9_.-]+\/)[^\s\r\n]*/g, '<path>');
  text = text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]');
  return boundUtf8(text);
}

function normalizeTimeout(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.floor(n))) : 60000;
}

function normalizeCwd(value) {
  const cwd = String(value == null || value === '' ? '.' : value)
    .trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd) || cwd.split('/').includes('..')) {
    throw codeError('VERIFICATION_PROFILE_INVALID', 'cwd 必须是项目内相对目录');
  }
  return cwd;
}

function normalizeProfile(raw, projectRoot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw codeError('VERIFICATION_PROFILE_INVALID', 'profile 无效');
  }
  const name = clean(raw.name, 120);
  const command = String(raw.command == null ? '' : raw.command).trim();
  if (!name || !command || command.length > 1000 || /[\u0000\r\n]/.test(command) || isBlockedVerificationCommand(command)) {
    throw codeError('VERIFICATION_PROFILE_INVALID', 'profile 名称或命令无效');
  }
  const cwd = normalizeCwd(raw.cwd);
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    const target = path.resolve(root, cwd);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw codeError('VERIFICATION_PROFILE_INVALID', 'cwd 越界');
  }
  const kind = ['test', 'build', 'typecheck', 'lint', 'custom'].includes(raw.kind) ? raw.kind : 'custom';
  return {
    id: /^vfy_[a-f0-9]{8,64}$/.test(String(raw.id || ''))
      ? String(raw.id)
      : `vfy_${crypto.randomBytes(8).toString('hex')}`,
    name,
    kind,
    command,
    cwd,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    enabled: raw.enabled !== false,
  };
}

function profileFingerprint(profile) {
  return crypto.createHash('sha256').update(JSON.stringify({
    name: profile.name,
    kind: profile.kind,
    command: profile.command,
    cwd: profile.cwd,
    timeoutMs: profile.timeoutMs,
    enabled: profile.enabled !== false,
  })).digest('hex');
}

function workspaceFingerprint(projectRoot) {
  const root = canonicalProjectPath(projectRoot);
  if (!root) return '';
  const rows = [];
  let files = 0;
  let bytes = 0;
  const rules = loadGitignoreRules(root);
  walkFiles(root, {
    ignoreRules: rules,
    onFile(rel, full, stat) {
      if (files >= MAX_FINGERPRINT_FILES || bytes + stat.size > MAX_FINGERPRINT_BYTES) return false;
      files += 1;
      bytes += stat.size;
      let hash = '';
      try { hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch {}
      rows.push(`${rel}\0${stat.size}\0${hash || Number(stat.mtimeMs) || 0}`);
      return true;
    },
  });
  rows.sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function publicProfile(profile, { includeCommand = false } = {}) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    cwd: profile.cwd,
    timeoutMs: profile.timeoutMs,
    enabled: profile.enabled !== false,
    ...(includeCommand ? { command: profile.command } : {}),
  };
}

function jobSummary(job) {
  if (!job) return null;
  return {
    jobRef: job.jobRef,
    profileId: /^vfy_[a-f0-9]{8,64}$/.test(String(job.profileId || '')) ? String(job.profileId) : '',
    profileName: clean(job.profileName || job.profile?.name, 120),
    kind: clean(job.kind || job.profile?.kind || 'custom', 20),
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: Number.isFinite(job.exitCode) ? job.exitCode : undefined,
    timedOut: job.timedOut === true,
    diagnosticCount: Array.isArray(job.diagnostics) ? job.diagnostics.length : 0,
    diagnosticsTruncated: job.diagnosticsTruncated === true,
    outputTruncated: job.outputTruncated === true,
    statusMessage: job.statusMessage ? clean(job.statusMessage, 500) : undefined,
  };
}

function publicJob(job) {
  const summary = jobSummary(job);
  if (!summary) return null;
  return {
    ...summary,
    stdout: String(job.stdout || ''),
    stderr: String(job.stderr || ''),
    diagnostics: Array.isArray(job.diagnostics) ? job.diagnostics.slice(0, MAX_DIAGNOSTICS) : [],
  };
}

function storedJob(job) {
  return {
    ...publicJob(job),
    projectKey: job.projectKey,
    projectBindingFingerprint: job.projectBindingFingerprint,
    profileFingerprint: job.profileFingerprint,
    workspaceFingerprintStart: job.workspaceFingerprintStart,
    workspaceFingerprintEnd: job.workspaceFingerprintEnd,
  };
}

function sanitizeLoadedDiagnostic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawPath = String(raw.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  // Persisted diagnostics are already project-relative. On restart the
  // manager may not yet know the project root, so validate the relative form
  // without resolving it against process.cwd(). Absolute/traversal paths are
  // rejected rather than guessed.
  if (!rawPath || rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath) || rawPath.split('/').includes('..')) return null;
  const pathValue = rawPath;
  const line = Number(raw.line); const column = Number(raw.column);
  if (!pathValue || !Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null;
  const severity = ['error', 'warning', 'info'].includes(raw.severity) ? raw.severity : 'error';
  // Persisted diagnostics are already normalized and redacted before they
  // reach disk. At startup there is no trusted project root available yet,
  // so do not attempt to resolve or reference one here.
  const redacted = redact(raw.message || '').text;
  return {
    path: pathValue,
    line: Math.floor(line),
    column: Math.floor(column),
    severity,
    code: raw.code == null ? null : clean(raw.code, 120),
    message: clean(redacted, MAX_MESSAGE),
    source: clean(raw.source || 'verification', 80),
  };
}

function detectVerificationProfiles(projectRoot) {
  const root = canonicalProjectPath(projectRoot);
  const out = [];
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  for (const kind of ['test', 'build', 'typecheck', 'lint']) {
    if (pkg?.scripts?.[kind]) out.push({ name: `npm ${kind}`, kind, command: kind === 'test' ? 'npm test' : `npm run ${kind}`, cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) out.push({ name: 'pytest', kind: 'test', command: 'python -m pytest', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  if (fs.existsSync(path.join(root, 'go.mod'))) out.push({ name: 'go test', kind: 'test', command: 'go test ./...', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) out.push({ name: 'cargo test', kind: 'test', command: 'cargo test', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  if (fs.existsSync(path.join(root, 'pom.xml'))) out.push({ name: 'maven test', kind: 'test', command: 'mvn test', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'))) out.push({ name: 'gradle test', kind: 'test', command: 'gradle test', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  if (fs.existsSync(path.join(root, 'Makefile'))) out.push({ name: 'make test', kind: 'test', command: 'make test', cwd: '.', timeoutMs: 600000, enabled: true, candidate: true });
  return out.slice(0, MAX_PROFILES);
}

class VerificationManager {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.runTerminal = options.runTerminal || defaultRunTerminal;
    this.now = options.now || (() => Date.now());
    this.root = options.projectPath ? canonicalProjectPath(options.projectPath) : '';
    this.jobs = new Map();
    this.profiles = new Map();
    this.grants = new Map();
    this.queue = [];
    this.running = 0;
    this.closing = false;
    this.listeners = new Set();
    this.onJobEvent = typeof options.onJobEvent === 'function' ? options.onJobEvent : null;
    this.storeError = null;
    this.corruptStores = new Set();
    this.safeStorage = options.safeStorage === undefined
      ? (() => { try { return require('electron').safeStorage; } catch { return null; } })()
      : options.safeStorage;
    this.jobsStorePath = options.jobsStorePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-jobs.json') : '');
    this.grantsStorePath = options.grantsStorePath || (options.userDataPath ? path.join(options.userDataPath, 'engineering-verification-grants.json') : '');
    this.persistenceMode = this.canEncrypt() ? 'encrypted' : 'memory';
    if (Array.isArray(options.profiles) && this.root) this.replaceProfiles(this.root, options.profiles);
    this._load();
  }

  canEncrypt() {
    try { return !!(this.safeStorage?.isEncryptionAvailable?.() && this.safeStorage.encryptString && this.safeStorage.decryptString); } catch { return false; }
  }

  onEvent(fn) {
    if (typeof fn === 'function') this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(job, reason = 'updated') {
    const event = { type: 'engineering:verification:event', reason, ...jobSummary(job) };
    Object.defineProperty(event, 'projectKey', { value: job.projectKey, enumerable: false });
    for (const fn of this.listeners) { try { fn(event); } catch {} }
    try { this.onJobEvent?.(event); } catch {}
  }

  _readStore(file) {
    if (!file || !this.fs.existsSync(file)) return null;
    try {
      const envelope = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      if (envelope.version !== STORE_VERSION || envelope.cipher !== 'electron-safeStorage') throw new Error('invalid envelope');
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(String(envelope.payload || ''), 'base64')));
    } catch {
      this.corruptStores.add(file);
      this.storeError = 'VERIFICATION_STORE_CORRUPT';
      return null;
    }
  }

  _load() {
    if (this.persistenceMode !== 'encrypted') return;
    let recovered = false;
    const jobs = this._readStore(this.jobsStorePath);
    if (Array.isArray(jobs)) {
      for (const raw of jobs.slice(-MAX_HISTORY)) {
        if (!/^vfy_job_[a-f0-9]{24}$/.test(String(raw?.jobRef || '')) || !/^[a-f0-9]{32}$/.test(String(raw?.projectKey || ''))) continue;
        const status = ACTIVE.has(raw.status) || TERMINAL.has(raw.status) ? raw.status : 'error';
        const job = {
          ...raw,
          status,
          stdout: redact(raw.stdout).text,
          stderr: redact(raw.stderr).text,
          diagnostics: Array.isArray(raw.diagnostics)
            ? raw.diagnostics.map((item) => sanitizeLoadedDiagnostic(item)).filter(Boolean).slice(0, MAX_DIAGNOSTICS)
            : [],
          outputTruncated: raw.outputTruncated === true,
        };
        if (ACTIVE.has(job.status)) {
          job.status = 'interrupted';
          job.statusMessage = '应用退出时验证尚未结束';
          job.finishedAt = new Date(this.now()).toISOString();
          recovered = true;
        }
        this.jobs.set(job.jobRef, job);
      }
    }
    const grants = this._readStore(this.grantsStorePath);
    if (grants && typeof grants === 'object' && !Array.isArray(grants)) {
      for (const [key, grant] of Object.entries(grants)) {
        if (/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(key) && grant && typeof grant === 'object') this.grants.set(key, grant);
      }
    }
    if (recovered) this._save();
  }

  _writeStore(file, value) {
    if (!file || this.corruptStores.has(file)) return;
    let temp = '';
    try {
      const encrypted = this.safeStorage.encryptString(JSON.stringify(value));
      this.fs.mkdirSync(path.dirname(file), { recursive: true });
      temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(temp, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(encrypted).toString('base64') }), 'utf8');
      this.fs.renameSync(temp, file);
    } catch {
      this.storeError = 'VERIFICATION_STORE_UNAVAILABLE';
      if (temp) { try { this.fs.unlinkSync(temp); } catch {} }
    }
  }

  _save() {
    if (this.persistenceMode !== 'encrypted') return;
    this._writeStore(this.jobsStorePath, [...this.jobs.values()].slice(-MAX_HISTORY).map(storedJob));
    this._writeStore(this.grantsStorePath, Object.fromEntries(this.grants));
  }

  setProject(projectPath) {
    this.root = canonicalProjectPath(projectPath);
    return this.root;
  }

  _profileKey(projectPath, profileId) { return `${projectKey(projectPath)}:${String(profileId || '')}`; }

  _dropProfileGrants(projectPath, profileId, keepFingerprint = '') {
    const key = projectKey(projectPath);
    for (const [grantKey, grant] of this.grants) {
      if (grant?.projectKey !== key || grant?.profileId !== String(profileId || '')) continue;
      if (keepFingerprint && grant?.profileFingerprint === keepFingerprint) continue;
      this.grants.delete(grantKey);
    }
  }

  listProfiles(projectPath = this.root, options = {}) {
    const key = projectKey(projectPath);
    return [...this.profiles.values()]
      .filter((profile) => profile.projectKey === key && (options.includeDisabled || profile.enabled !== false))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((profile) => publicProfile(profile, options));
  }

  saveProfile(projectPath, raw) {
    if (raw === undefined && projectPath && typeof projectPath === 'object') { raw = projectPath; projectPath = this.root; }
    const root = canonicalProjectPath(projectPath || this.root);
    if (!root) throw codeError('ENGINEERING_PROJECT_BINDING_INVALID', '项目绑定无效');
    const profile = normalizeProfile(raw, root);
    const key = projectKey(root);
    const existing = [...this.profiles.values()].filter((item) => item.projectKey === key && item.id !== profile.id);
    if (existing.length >= MAX_PROFILES) throw codeError('VERIFICATION_PROFILE_LIMIT', '验证 profile 数量已达上限');
    const fingerprint = profileFingerprint(profile);
    this._dropProfileGrants(root, profile.id, fingerprint);
    this.profiles.set(`${key}:${profile.id}`, { ...profile, projectKey: key });
    this._save();
    return { ...publicProfile(profile, { includeCommand: true }), fingerprint };
  }

  replaceProfiles(projectPath, list) {
    if (!Array.isArray(list)) throw codeError('VERIFICATION_PROFILE_INVALID', 'profiles 无效');
    const root = canonicalProjectPath(projectPath);
    const key = projectKey(root);
    const normalized = [];
    const seen = new Set();
    for (const raw of list) {
      // Batch load from settings: a single hand-edited or blocked entry must be
      // skipped on its own. Letting normalizeProfile throw here would drop every
      // other valid profile in the same project. saveProfile still throws so an
      // explicit single save reports the reason back to the user.
      let profile;
      try {
        profile = normalizeProfile(raw, root);
      } catch { continue; }
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      normalized.push(profile);
      if (normalized.length >= MAX_PROFILES) break;
    }
    const nextIds = new Set(normalized.map((profile) => profile.id));
    for (const [mapKey, profile] of this.profiles) {
      if (profile.projectKey === key && !nextIds.has(profile.id)) {
        this.profiles.delete(mapKey);
        this._dropProfileGrants(root, profile.id);
      }
    }
    for (const profile of normalized) {
      const fingerprint = profileFingerprint(profile);
      this._dropProfileGrants(root, profile.id, fingerprint);
      this.profiles.set(`${key}:${profile.id}`, { ...profile, projectKey: key });
    }
    this._save();
    return this.listProfiles(root, { includeDisabled: true, includeCommand: true });
  }

  getProfile(projectPath, profileId) {
    const profile = this.profiles.get(this._profileKey(projectPath, profileId));
    return profile ? { ...publicProfile(profile, { includeCommand: true }), fingerprint: profileFingerprint(profile) } : null;
  }

  removeProfile(projectPath, profileId) {
    const removed = this.profiles.delete(this._profileKey(projectPath, profileId));
    this._dropProfileGrants(projectPath, profileId);
    this._save();
    return removed;
  }

  detectProfiles(projectPath = this.root) { return detectVerificationProfiles(projectPath); }

  revokeGrant(projectPath, profileId) {
    const key = projectKey(projectPath);
    for (const [grantKey, grant] of this.grants) {
      if (grant?.projectKey === key && (!profileId || grant?.profileId === String(profileId))) this.grants.delete(grantKey);
    }
    this._save();
    return { ok: true };
  }

  _findProfile(projectPath, profileId) {
    const profile = this.profiles.get(this._profileKey(projectPath, profileId));
    if (!profile || profile.enabled === false) throw codeError('VERIFICATION_PROFILE_NOT_FOUND', '验证 profile 不存在或已禁用');
    return profile;
  }

  _owns(job, projectPath) { return !!job && (!projectPath || job.projectKey === projectKey(projectPath)); }

  async start(options = {}, profileIdArg) {
    if (typeof options === 'string') options = { projectPath: options, profileId: profileIdArg };
    if (this.closing) return { ok: false, code: 'VERIFICATION_JOB_LIMIT', error: '验证管理器正在关闭' };
    const root = canonicalProjectPath(options.projectPath || this.root);
    try {
      if (!root || !this.fs.statSync(root).isDirectory()) throw new Error('invalid root');
    } catch { return { ok: false, code: 'ENGINEERING_PROJECT_BINDING_INVALID', error: '项目绑定无效' }; }
    let profile;
    try { profile = this._findProfile(root, options.profileId); } catch (error) { return { ok: false, code: error.code, error: error.message }; }
    let cwdResolved;
    try {
      cwdResolved = this.fs.realpathSync(path.resolve(root, profile.cwd));
      const rel = path.relative(root, cwdResolved);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !this.fs.statSync(cwdResolved).isDirectory()) throw new Error('unsafe cwd');
    } catch { return { ok: false, code: 'VERIFICATION_PROFILE_INVALID', error: 'cwd 不存在或越界' }; }
    if (options.settings?.terminalEnabled !== true) return { ok: false, code: 'VERIFICATION_TERMINAL_DISABLED', error: '终端未启用' };

    const fingerprint = profileFingerprint(profile);
    const key = projectKey(root);
    const grantKey = `${key}:${fingerprint}`;
    let allowed = options.preAuthorized === true || this.grants.has(grantKey);
    if (!allowed && options.permissionGate?.authorize) {
      try {
        const authorization = await options.permissionGate.authorize({
          tool: 'verification_start', risk: 'terminal', summary: `运行验证: ${profile.name}`,
          detail: `${profile.name} (${profile.kind})`, path: profile.cwd,
          sessionKey: options.sessionKey, signal: options.signal,
        });
        if (!authorization.allowed) return { ok: false, code: 'VERIFICATION_APPROVAL_CANCELLED', error: authorization.reason || '用户拒绝' };
        if (authorization.decision === 'allow_session' || options.persistGrant) {
          this.grants.set(grantKey, { projectKey: key, profileId: profile.id, profileFingerprint: fingerprint, grantedAt: new Date(this.now()).toISOString() });
          this._save();
        }
        allowed = true;
      } catch (error) {
        return { ok: false, code: error.code || 'VERIFICATION_APPROVAL_REQUIRED', error: clean(error.message || error, 500) };
      }
    }
    if (!allowed && options.requireApproval !== false) return { ok: false, code: 'VERIFICATION_APPROVAL_REQUIRED', error: '需要验证授权' };
    if (this.jobs.size >= MAX_HISTORY && [...this.jobs.values()].filter((job) => TERMINAL.has(job.status)).length === 0) {
      return { ok: false, code: 'VERIFICATION_JOB_LIMIT', error: '验证作业数量已达上限' };
    }

    const job = {
      jobRef: `vfy_job_${crypto.randomBytes(12).toString('hex')}`,
      projectKey: key,
      projectBindingFingerprint: key,
      projectPath: root,
      profileId: profile.id,
      profileName: profile.name,
      kind: profile.kind,
      profileFingerprint: fingerprint,
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      workspaceFingerprintStart: '',
      stdout: '', stderr: '', diagnostics: [], outputTruncated: false,
      abort: new AbortController(), profile: { ...profile }, cwdResolved,
    };
    this.jobs.set(job.jobRef, job);
    this.queue.push(job);
    this._pruneHistory();
    this._save();
    this.emit(job, 'queued');
    this._drain();
    return { ok: true, jobRef: job.jobRef, job: jobSummary(job) };
  }

  _drain() {
    if (this.closing) return;
    while (this.running < MAX_GLOBAL_RUNNING && this.queue.length) {
      const runningProjects = new Set([...this.jobs.values()].filter((job) => job.status === 'running').map((job) => job.projectKey));
      const index = this.queue.findIndex((job) => job?.status === 'queued' && !runningProjects.has(job.projectKey));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      void this._execute(job);
    }
  }

  _appendOutput(job, stream, chunk) {
    const next = redact(String(job[stream] || '') + String(chunk || ''), job.projectPath);
    job[stream] = next.text;
    job.outputTruncated ||= next.truncated;
  }

  async _execute(job) {
    this.running += 1;
    job.status = 'running';
    job.startedAt = new Date(this.now()).toISOString();
    job.workspaceFingerprintStart = workspaceFingerprint(job.projectPath);
    this._save();
    this.emit(job, 'started');
    let result;
    let internalError = false;
    try {
      result = await this.runTerminal(job.projectPath, job.profile.command, {
        cwd: job.cwdResolved,
        timeoutMs: job.profile.timeoutMs,
        signal: job.abort.signal,
        onStdout: (chunk) => this._appendOutput(job, 'stdout', chunk),
        onStderr: (chunk) => this._appendOutput(job, 'stderr', chunk),
      });
    } catch (error) {
      internalError = true;
      result = { ok: false, code: -1, stderr: clean(error.message || error, 1000) };
    }
    if (!job.stdout && result?.stdout) this._appendOutput(job, 'stdout', result.stdout);
    if (!job.stderr && result?.stderr) this._appendOutput(job, 'stderr', result.stderr);
    job.exitCode = Number.isFinite(result?.code) ? result.code : -1;
    job.timedOut = result?.timedOut === true;
    job.workspaceFingerprintEnd = workspaceFingerprint(job.projectPath);
    const changed = job.workspaceFingerprintEnd !== job.workspaceFingerprintStart;

    if (this.closing || job.status === 'interrupted') {
      job.status = 'interrupted'; job.statusMessage = '应用退出时验证尚未结束';
    } else if (job.abort.signal.aborted || result?.aborted) {
      job.status = 'cancelled'; job.statusMessage = '已取消';
    } else if (job.timedOut) {
      job.status = 'timed_out'; job.statusMessage = '验证超时';
    } else if (changed) {
      job.status = 'stale'; job.statusMessage = '验证期间工作区发生变化';
    } else if (internalError) {
      job.status = 'error'; job.statusMessage = '验证执行失败';
    } else if (result?.ok) {
      job.status = 'passed';
    } else {
      job.status = 'failed'; job.statusMessage = '验证命令失败';
    }
    if (['failed', 'stale', 'timed_out', 'error'].includes(job.status)) {
      const parsed = parseDiagnostics(`${job.stdout}\n${job.stderr}`, { projectRoot: job.projectPath });
      job.diagnostics = parsed.diagnostics.slice(0, MAX_DIAGNOSTICS);
      job.diagnosticsTruncated = parsed.truncated;
    }
    job.finishedAt = new Date(this.now()).toISOString();
    this.running = Math.max(0, this.running - 1);
    this._pruneHistory();
    this._save();
    this.emit(job, 'finished');
    this._drain();
  }

  _pruneHistory() {
    const all = [...this.jobs.values()];
    if (all.length <= MAX_HISTORY) return;
    const removable = all.filter((job) => TERMINAL.has(job.status))
      .sort((a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt)));
    for (const job of removable.slice(0, Math.max(0, all.length - MAX_HISTORY))) this.jobs.delete(job.jobRef);
  }

  get(jobRef, projectPath) {
    const job = this.jobs.get(String(jobRef || ''));
    return this._owns(job, projectPath) ? jobSummary(job) : null;
  }

  result(jobRef, projectPath) {
    const job = this.jobs.get(String(jobRef || ''));
    if (!this._owns(job, projectPath)) return { ok: false, code: 'VERIFICATION_JOB_NOT_FOUND', error: '作业不存在' };
    return { ok: true, job: publicJob(job) };
  }

  list(options = {}) {
    if (typeof options === 'string') options = { projectPath: options };
    const jobs = [...this.jobs.values()]
      .filter((job) => !options.projectPath || job.projectKey === projectKey(options.projectPath))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, jobs: jobs.slice(0, Math.min(MAX_HISTORY, Number(options.limit) || MAX_HISTORY)).map(jobSummary) };
  }

  async cancel(jobRef, projectPath) {
    const job = this.jobs.get(String(jobRef || ''));
    if (!this._owns(job, projectPath)) return { ok: false, code: 'VERIFICATION_JOB_NOT_FOUND', error: '作业不存在' };
    if (job.status === 'queued') {
      job.status = 'cancelled';
      this.queue = this.queue.filter((item) => item !== job);
      job.finishedAt = new Date(this.now()).toISOString();
      this._save(); this.emit(job, 'cancelled');
      return { ok: true, job: jobSummary(job) };
    }
    if (job.status !== 'running') return { ok: true, job: jobSummary(job) };
    try { job.abort?.abort(); } catch { return { ok: false, code: 'VERIFICATION_JOB_CANCEL_FAILED', error: '无法取消验证作业' }; }
    return { ok: true, job: jobSummary(job) };
  }

  async rerun(jobRef, options = {}) {
    const old = this.jobs.get(String(jobRef || ''));
    if (!this._owns(old, options.projectPath)) return { ok: false, code: 'VERIFICATION_JOB_NOT_FOUND', error: '作业不存在' };
    const projectPath = options.projectPath || old.projectPath || this.root;
    const current = this.profiles.get(this._profileKey(projectPath, old.profileId));
    if (!current || profileFingerprint(current) !== old.profileFingerprint) {
      return { ok: false, code: 'VERIFICATION_PROFILE_CHANGED', error: '验证 profile 已修改或删除，请重新确认' };
    }
    return this.start({ ...options, projectPath, profileId: old.profileId });
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    const finishedAt = new Date(this.now()).toISOString();
    for (const job of this.jobs.values()) {
      if (!ACTIVE.has(job.status)) continue;
      job.status = 'interrupted'; job.statusMessage = '应用退出时验证尚未结束'; job.finishedAt = finishedAt;
      try { job.abort?.abort(); } catch {}
      this.emit(job, 'interrupted');
    }
    this.queue = [];
    this._save();
  }

  persistenceStatus() { return { persistence: this.persistenceMode, error: this.storeError }; }
  getJob(ref, projectPath) { return this.get(ref, projectPath); }
  getResult(ref, projectPath) { return this.result(ref, projectPath); }
  run(options) { return this.start(options); }
  startJob(options) { return this.start(options); }
  stop(ref, projectPath) { return this.cancel(ref, projectPath); }
}

function createVerificationManager(options) { return new VerificationManager(options); }

module.exports = {
  VerificationManager,
  createVerificationManager,
  normalizeProfile,
  profileFingerprint,
  computeProfileFingerprint: profileFingerprint,
  workspaceFingerprint,
  computeWorkspaceFingerprint: workspaceFingerprint,
  detectVerificationProfiles,
  publicProfile,
  jobSummary,
  publicJob,
  redactVerificationOutput: redact,
  isBlockedVerificationCommand,
  MAX_PROFILES,
  MAX_HISTORY,
  MAX_OUTPUT_BYTES,
  MAX_GLOBAL_RUNNING,
  MIN_TIMEOUT,
  MAX_TIMEOUT,
};
