const fs = require('fs');
const path = require('path');
const { sanitizeMcpServers } = require('./mcp-config');
const crypto = require('crypto');
const { SecretManager, defaultSecretManager } = require('./secret-manager');
const { createModelRegistry, validateModelRegistry } = require('./model-profiles');

const DEFAULT_SETTINGS = {
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  apiKeyConfigured: false,
  secretRef: '',
  modelCredentialCleanup: [], // Main-owned cleanup journal; never accepted from public settings writes.
  executionPolicy: 'strict-isolated', // strict-isolated | workspace-write | host-unconfined
  model: 'gpt-4o-mini',
  // Agent
  agentEnabled: true,
  maxAgentTurns: 8, // 0 = unlimited
  permissionMode: 'confirm-writes', // read-only | confirm-writes | full-auto
  // Terminal (optional, off by default)
  terminalEnabled: false,
  terminalRequireConfirm: true,
  terminalTimeoutMs: 60000,
  // Phase C.1 orchestration
  defaultAgentMode: 'agent', // plan | agent — only seeds new sessions
  verifyCommand: '', // empty = auto-detect; 'none' or '-' disables
  verifyBeforeDone: true,
  // Phase C.2 platform
  skillsEnabled: true,
  subagentEnabled: true,
  mcpEnabled: false,
  // MCP servers: sanitized on load/save via sanitizeMcpServers
  // shape: { name, transport?, command?, args?, env?, cwd?, url?, headers?, enabled?, timeoutMs? }[]
  mcpServers: [],
  // Phase D.10: protocol tasks and server elicitation are opt-in per server.
  // Phase C.3 hooks
  hooksEnabled: true,
  // Phase C.4
  exploreMaxParallel: 2, // Phase C.4; clamp 1..3 on load
  // Phase D.1 session compact
  autoCompact: false, // send-time auto compact; manual by default
  compactKeepMessages: 24, // clamp 6..80
  compactMaxMessages: 40, // clamp 20..200
  compactMaxApproxTokens: 24000, // clamp 4000..200000; heuristic len/4
  // Phase D.2 long-term memory
  memoryEnabled: true,
  memoryMaxEntries: 200, // clamp 20..2000
  memoryInjectTopN: 8, // clamp 0..30; 0 = 不注入，只保留 recall 工具
  memoryInjectMaxTokens: 1200, // clamp 200..8000; 复用 char/4 估算
  // Phase D.4 reviewed memory candidates
  memoryCandidateEnabled: true,
  // Phase D.3 web fetch
  webEnabled: false,
  webRequireConfirm: true,
  webAllowDomains: [], // 空 = 不限制公网域名；私网硬拦不受此影响
  webDenyDomains: [],
  webTimeoutMs: 15000, // clamp 3000..60000
  webMaxBytes: 524288, // clamp 32768..4194304
  webMaxChars: 15000, // clamp 1000..50000
  // Phase D.3 usage metering
  usageEnabled: true,
  usageMaxRecords: 5000, // clamp 500..50000
  usagePricing: [], // { modelPrefix, inputPerM, outputPerM }[]，上限 20 行
  usageCurrency: '$',
  // Phase D.11 engineering
  codeIndexEnabled: true,
  ciWatchSystemNotifications: false,
  verificationProfiles: [],
};

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function clampExploreMaxParallel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Phase D.1: normalize compact settings in place; shared by load/save and main. */
function clampCompactSettings(s) {
  s.autoCompact = s.autoCompact === true;
  s.compactKeepMessages = clampInt(s.compactKeepMessages, 6, 80, 24);
  s.compactMaxMessages = clampInt(s.compactMaxMessages, 20, 200, 40);
  s.compactMaxApproxTokens = clampInt(s.compactMaxApproxTokens, 4000, 200000, 24000);
  return s;
}

/** Phase D.2: normalize memory settings in place; shared by load/save and main. */
function clampMemorySettings(s) {
  s.memoryEnabled = s.memoryEnabled !== false;
  s.memoryMaxEntries = clampInt(s.memoryMaxEntries, 20, 2000, 200);
  s.memoryInjectTopN = clampInt(s.memoryInjectTopN, 0, 30, 8);
  s.memoryInjectMaxTokens = clampInt(s.memoryInjectMaxTokens, 200, 8000, 1200);
  s.memoryCandidateEnabled = s.memoryCandidateEnabled !== false;
  return s;
}

const DOMAIN_LIST_MAX = 100;
const PRICING_ROWS_MAX = 20;

/** Phase D.3: '  HTTPS://Example.COM/docs ' → 'example.com'；不合法返回 ''。 */
function normalizeDomainEntry(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 剥协议
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/^\[|\]$/g, '').split(':')[0]; // 剥端口与 v6 方括号
  s = s.replace(/^\.+|\.+$/g, '');
  if (!s || /\s/.test(s)) return '';
  return s;
}

function normalizeDomainList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const d = normalizeDomainEntry(item);
    if (d && !out.includes(d)) out.push(d);
    if (out.length >= DOMAIN_LIST_MAX) break;
  }
  return out;
}

function clampFloat(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Legacy prefix rows remain exact; E4 scope/cache fields are bounded and explicit. */
function sanitizePricing(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const scopedId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    // A malformed scope is dropped, never broadened into a legacy/global rate.
    if (row.providerId != null && row.providerId !== '' && !scopedId(row.providerId)
      || row.modelProfileId != null && row.modelProfileId !== '' && !scopedId(row.modelProfileId)) continue;
    const providerId = scopedId(row.providerId) ? row.providerId : null;
    const modelProfileId = scopedId(row.modelProfileId) ? row.modelProfileId : null;
    const modelPrefix = String(row.modelPrefix ?? '').trim();
    if (!modelPrefix && !modelProfileId || (providerId || modelProfileId) && modelPrefix.length > 256) continue;
    const normalized = {
      modelPrefix,
      inputPerM: clampFloat(row.inputPerM, 0, 10000, 0),
      outputPerM: clampFloat(row.outputPerM, 0, 10000, 0),
    };
    if (providerId) normalized.providerId = providerId;
    if (modelProfileId) normalized.modelProfileId = modelProfileId;
    for (const key of ['cachedInputPerM', 'cacheCreationInputPerM']) {
      const raw = row[key];
      const value = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      // Unknown/invalid optional prices must not silently become a free price (0).
      if (Number.isFinite(value) && value >= 0 && value <= 10000) normalized[key] = value;
    }
    out.push(normalized);
    if (out.length >= PRICING_ROWS_MAX) break;
  }
  return out;
}

/** Phase D.3: normalize web settings in place; shared by load/save and main. */
function clampWebSettings(s) {
  s.webEnabled = s.webEnabled === true;
  s.webRequireConfirm = s.webRequireConfirm !== false;
  s.webAllowDomains = normalizeDomainList(s.webAllowDomains);
  s.webDenyDomains = normalizeDomainList(s.webDenyDomains);
  s.webTimeoutMs = clampInt(s.webTimeoutMs, 3000, 60000, 15000);
  s.webMaxBytes = clampInt(s.webMaxBytes, 32768, 4194304, 524288);
  s.webMaxChars = clampInt(s.webMaxChars, 1000, 50000, 15000);
  return s;
}

/** Phase D.3: normalize usage settings in place; shared by load/save and main. */
function clampUsageSettings(s) {
  s.usageEnabled = s.usageEnabled !== false;
  s.usageMaxRecords = clampInt(s.usageMaxRecords, 500, 50000, 5000);
  s.usagePricing = sanitizePricing(s.usagePricing);
  s.usageCurrency = String(s.usageCurrency ?? '$').slice(0, 4) || '$';
  return s;
}

function clampMcpD10Settings(s) {
  s.mcpServers = sanitizeMcpServers(s.mcpServers, { allowRootPaths: true });
  return s;
}

const VERIFICATION_PROFILE_LIMIT = 12;
const VERIFICATION_PROFILE_PROJECT_LIMIT = 100;
const VERIFICATION_KINDS = new Set(['test', 'build', 'typecheck', 'lint', 'custom']);
function normalizeVerificationProfile(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name ?? '').trim().slice(0, 120);
  const command = String(raw.command ?? '').trim().slice(0, 1000);
  const cwdRaw = String(raw.cwd ?? '.').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (!name || !command || /[\u0000\r\n]/.test(command) || cwdRaw.startsWith('/') || /^[A-Za-z]:/.test(cwdRaw) || cwdRaw.split('/').includes('..')) return null;
  const n = Number(raw.timeoutMs);
  const timeoutMs = Number.isFinite(n) ? Math.max(5000, Math.min(15 * 60 * 1000, Math.floor(n))) : 60000;
  const id = /^vfy_[a-f0-9]{8,64}$/.test(String(raw.id || '')) ? String(raw.id) : `vfy_${crypto.randomBytes(8).toString('hex')}`;
  const suppliedProjectKey = options.projectKey ?? raw.projectKey;
  const projectKey = /^[a-f0-9]{32}$/.test(String(suppliedProjectKey || '')) ? String(suppliedProjectKey) : '';
  return {
    id,
    name,
    kind: VERIFICATION_KINDS.has(raw.kind) ? raw.kind : 'custom',
    command,
    cwd: cwdRaw,
    timeoutMs,
    enabled: raw.enabled !== false,
    ...(projectKey ? { projectKey } : {}),
  };
}
function clampVerificationSettings(s) {
  s.codeIndexEnabled = s.codeIndexEnabled !== false;
  s.ciWatchSystemNotifications = s.ciWatchSystemNotifications === true;
  const list = Array.isArray(s.verificationProfiles) ? s.verificationProfiles : [];
  const seen = new Set(); const counts = new Map(); const projects = new Set(); const out = [];
  for (const item of list) {
    const p = normalizeVerificationProfile(item);
    // D11 profiles are project-scoped. Older hand-edited, unscoped entries
    // are ignored instead of becoming commands available to every project.
    if (!p?.projectKey) continue;
    const identity = `${p.projectKey}:${p.id}`;
    if (seen.has(identity)) continue;
    if (!projects.has(p.projectKey) && projects.size >= VERIFICATION_PROFILE_PROJECT_LIMIT) continue;
    const count = counts.get(p.projectKey) || 0;
    if (count >= VERIFICATION_PROFILE_LIMIT) continue;
    projects.add(p.projectKey);
    counts.set(p.projectKey, count + 1);
    seen.add(identity);
    out.push(p);
  }
  s.verificationProfiles = out;
  return s;
}

function registerSettingsSecrets(value, manager, key = '') {
  if (typeof value === 'string') {
    if (/key|token|secret|password|authorization|credential/i.test(key)) {
      manager.registerSecret(value, 'CONFIG_SECRET');
      if (/^Bearer\s+/i.test(value)) manager.registerSecret(value.replace(/^Bearer\s+/i, ''), 'CONFIG_SECRET');
    }
    return;
  }
  if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) registerSettingsSecrets(child, manager, childKey);
}

const MCP_CREDENTIAL_REF = /^mcp_credentials_[a-f0-9]{32}$/;

function mcpCredentialError(cause) {
  const error = new Error('MCP credential storage is unavailable');
  error.code = 'MCP_CREDENTIAL_STORE_UNAVAILABLE';
  error.cause = cause;
  return error;
}

function registerMcpCredentialValues(value, manager) {
  if (typeof value === 'string') {
    manager.registerSecret(value, 'MCP_CREDENTIAL');
    if (/^Bearer\s+/i.test(value)) manager.registerSecret(value.replace(/^Bearer\s+/i, ''), 'MCP_CREDENTIAL');
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) registerMcpCredentialValues(child, manager);
  }
}

function hydrateMcpServers(servers, manager) {
  try {
    return (Array.isArray(servers) ? servers : []).map((server) => {
      if (!server?.credentialsRef) return server;
      if (!MCP_CREDENTIAL_REF.test(server.credentialsRef)) throw new Error('Invalid MCP credential reference');
      const secret = manager.getSecret(server.credentialsRef);
      if (!secret) throw new Error('Missing MCP credentials');
      const credentials = JSON.parse(secret);
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Invalid MCP credentials');
      return { ...server, ...('env' in credentials ? { env: credentials.env } : {}), ...('headers' in credentials ? { headers: credentials.headers } : {}) };
    });
  } catch (error) { throw mcpCredentialError(error); }
}

// References are accepted only from the previous main-owned disk snapshot,
// never from incoming UI/import data. Fresh refs keep a failed settings write
// from replacing credentials still referenced by the previous settings file.
function protectMcpServers(servers, previous, manager) {
  const byName = new Map((Array.isArray(previous) ? previous : []).filter(Boolean).map((server) => [server.name, server]));
  try {
    return servers.map((server) => {
      const disk = { ...server };
      const credentials = {};
      for (const field of ['env', 'headers']) {
        if (server[field] !== undefined) credentials[field] = server[field];
        delete disk[field];
      }
      if (!Object.keys(credentials).length) return disk;
      registerMcpCredentialValues(credentials, manager);
      const payload = JSON.stringify(credentials);
      const old = byName.get(server.name);
      let ref = old?.transport === server.transport && MCP_CREDENTIAL_REF.test(old?.credentialsRef || '') ? old.credentialsRef : '';
      if (!ref || manager.getSecret(ref) !== payload) {
        ref = `mcp_credentials_${crypto.randomBytes(16).toString('hex')}`;
        manager.setSecret(ref, payload, { label: 'MCP credentials' });
      }
      disk.credentialsRef = ref;
      return disk;
    });
  } catch (error) { throw mcpCredentialError(error); }
}

function retireMcpCredentials(previous, next, manager) {
  const retained = new Set(next.map((server) => server.credentialsRef).filter(Boolean));
  for (const server of Array.isArray(previous) ? previous : []) {
    const ref = server?.credentialsRef;
    if (MCP_CREDENTIAL_REF.test(ref || '') && !retained.has(ref)) manager.deleteSecret(ref);
  }
}

function writeSettingsFile(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        // Windows scanners may briefly hold the destination. Keep the atomic
        // rename (never unlink/copy over it), and surface permanent failures.
        if (attempt >= 4 || !['EPERM', 'EBUSY'].includes(error?.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const secretManagersByPath = new Map();
function getOrCreateSecretManager(userDataPath) {
  if (!userDataPath || typeof userDataPath !== 'string') return defaultSecretManager;
  const normalized = path.resolve(userDataPath);
  if (!secretManagersByPath.has(normalized)) {
    secretManagersByPath.set(normalized, new SecretManager({
      vaultPath: path.join(normalized, 'secrets.vault.json'),
    }));
  }
  return secretManagersByPath.get(normalized);
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isSettingsObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function modelSettingsError(message, code = 'MODEL_CONFIG_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.needsRepair = true;
  return error;
}

function getModelRegistryBackupPath(userDataPath) {
  return path.join(userDataPath, 'settings.pre-model-registry-v1.backup.json');
}

function readSettingsDisk(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, parsed: {} };
    throw modelSettingsError('The existing settings file cannot be read; preserve it for recovery');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw modelSettingsError('The existing settings file contains invalid JSON; preserve it for repair'); }
  if (!isSettingsObject(parsed)) throw modelSettingsError('The existing settings file is not an object; preserve it for repair');
  return { exists: true, parsed };
}

function normalizeCleanupJournal(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2048 || value.some((entry) => typeof entry !== 'string' || entry.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(entry))) {
    throw modelSettingsError('The model credential cleanup journal requires repair');
  }
  return [...new Set(value)];
}

function normalizeSettings(settings) {
  settings.exploreMaxParallel = clampExploreMaxParallel(settings.exploreMaxParallel);
  // Only main-owned disk snapshots and picker-validated IPC data can grant roots.
  settings.mcpServers = sanitizeMcpServers(settings.mcpServers, { allowRootPaths: true });
  settings.modelCredentialCleanup = normalizeCleanupJournal(settings.modelCredentialCleanup);
  clampCompactSettings(settings);
  clampMemorySettings(settings);
  clampWebSettings(settings);
  clampUsageSettings(settings);
  clampVerificationSettings(settings);
  return clampMcpD10Settings(settings);
}

function resolveLegacyApiKeyEnabled(options) {
  return options.resolveLegacyApiKey !== false && options.resolveSecrets !== false;
}

// Compatibility aliases are derived from the registry, never the other way
// around once migration completed. New opaque model credentials are not
// decrypted by this legacy compatibility path.
function projectLegacyAliases(settings, manager, options) {
  const registry = settings.modelRegistry;
  const model = registry.models.find((entry) => entry.id === registry.defaultModelProfileId);
  const provider = registry.providers.find((entry) => entry.id === model.providerId);
  settings.baseUrl = provider.baseUrl;
  settings.model = model.model;
  settings.secretRef = provider.auth.secretRef;
  settings.apiKeyConfigured = Boolean(provider.auth.kind !== 'none' && provider.auth.secretRef);
  settings.apiKey = '';
  delete settings.apiKeyUnavailable;
  if (resolveLegacyApiKeyEnabled(options) && provider.auth.secretRef === 'sec_main_api_key') {
    try {
      settings.apiKey = manager.getSecret('main_api_key') || '';
      if (!settings.apiKey) settings.apiKeyUnavailable = true;
    } catch { settings.apiKeyUnavailable = true; }
  }
  return settings;
}

function legacyCredentialReference(settings, manager) {
  if (typeof settings.secretRef === 'string' && settings.secretRef) return settings.secretRef;
  if (settings.apiKeyConfigured === true || (typeof settings.apiKey === 'string' && settings.apiKey.trim())) return 'sec_main_api_key';
  // This metadata-only lookup is performed only during the one-time legacy
  // migration. A cleared reference in an existing registry is never restored.
  try { return manager.hasSecret('main_api_key') ? 'sec_main_api_key' : ''; }
  catch { return ''; }
}

function storeLegacyPlaintext(key, manager) {
  try {
    manager.registerSecret?.(key, 'MODEL_CREDENTIAL');
    manager.setSecret('main_api_key', key, { label: 'Legacy model API key' });
  } catch { throw modelSettingsError('The legacy credential could not be stored; the original settings were preserved', 'MODEL_CREDENTIAL_UNAVAILABLE'); }
}

function sanitizedBackup(settings, diskServers) {
  const omit = Symbol('omit');
  function sanitize(value, key = '') {
    if (typeof value === 'string' && /key|token|secret|password|authorization|credential/i.test(key)
      && !['secretRef', 'credentialsRef', 'credentialOrigin', 'modelCredentialCleanup'].includes(key)) return omit;
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key)).filter((entry) => entry !== omit);
    if (isSettingsObject(value)) {
      const result = {};
      for (const [childKey, child] of Object.entries(value)) {
        const safe = sanitize(child, childKey);
        if (safe !== omit) result[childKey] = safe;
      }
      return result;
    }
    return value;
  }
  const result = sanitize({ ...settings, ...(Array.isArray(settings.mcpServers) ? { mcpServers: diskServers } : {}) });
  delete result.apiKey;
  return result;
}

// The temporary hard link publishes a complete backup without replacing a
// previously captured recovery snapshot. Both files are on the same volume.
function writeModelRegistryBackup(userDataPath, settings) {
  const backup = getModelRegistryBackupPath(userDataPath);
  if (fs.existsSync(backup)) return;
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const temporary = `${backup}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
    try { fs.linkSync(temporary, backup); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function loadSettings(userDataPath, options = {}) {
  const file = getSettingsPath(userDataPath);
  const { exists, parsed } = readSettingsDisk(file);
  const seed = { ...DEFAULT_SETTINGS, ...parsed };
  // Validate before touching any vault, migration backup or on-disk settings.
  let registry = createModelRegistry(seed);
  normalizeCleanupJournal(parsed.modelCredentialCleanup);
  const manager = options.secretManager || getOrCreateSecretManager(userDataPath);
  const registryMigration = exists && (!hasOwn(parsed, 'modelRegistry') || parsed.modelRegistry?.migration?.completed === false);
  if (exists && !hasOwn(parsed, 'modelRegistry')) {
    registry = createModelRegistry({ ...seed, secretRef: legacyCredentialReference(parsed, manager) });
  }
  if (registryMigration && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
    let needsLegacyStore = !hasOwn(parsed, 'modelRegistry');
    if (!needsLegacyStore && registry.providers.some((provider) => provider.auth.secretRef === 'sec_main_api_key')) {
      try { needsLegacyStore = !manager.hasSecret('main_api_key'); }
      catch { throw modelSettingsError('The existing model credential could not be verified; preserve settings for repair', 'MODEL_CREDENTIAL_UNAVAILABLE'); }
    }
    if (needsLegacyStore) storeLegacyPlaintext(parsed.apiKey.trim(), manager);
  }
  const runtimeServers = sanitizeMcpServers(hydrateMcpServers(parsed.mcpServers, manager), { allowRootPaths: true });
  for (const server of runtimeServers) {
    registerMcpCredentialValues(server.env, manager);
    registerMcpCredentialValues(server.headers, manager);
  }
  const diskServers = protectMcpServers(runtimeServers, parsed.mcpServers, manager);
  const mcpChanged = Array.isArray(parsed.mcpServers) && JSON.stringify(diskServers) !== JSON.stringify(parsed.mcpServers);
  const merged = normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed, modelRegistry: registry, mcpServers: runtimeServers });
  if (registryMigration || mcpChanged || (exists && hasOwn(parsed, 'apiKey'))) {
    if (registryMigration) writeModelRegistryBackup(userDataPath, sanitizedBackup(parsed, diskServers));
    const diskCopy = projectLegacyAliases({ ...parsed, modelRegistry: registry, modelCredentialCleanup: merged.modelCredentialCleanup, mcpServers: diskServers }, manager, { resolveLegacyApiKey: false });
    delete diskCopy.apiKey;
    try { writeSettingsFile(file, diskCopy); }
    catch (error) { if (mcpChanged) throw mcpCredentialError(error); throw error; }
    retireMcpCredentials(parsed.mcpServers, diskServers, manager);
  }
  projectLegacyAliases(merged, manager, options);
  registerSettingsSecrets(merged, manager);
  return merged;
}

function saveSettings(userDataPath, partial, options = {}) {
  if (partial !== undefined && !isSettingsObject(partial)) throw modelSettingsError('Settings updates must be an object');
  const file = getSettingsPath(userDataPath);
  const original = readSettingsDisk(file);
  // Unknown/newer or broken existing registries must fail before accepting even
  // unrelated updates, rather than silently downgrading a user's configuration.
  createModelRegistry({ ...DEFAULT_SETTINGS, ...original.parsed });
  const incoming = { ...partial };
  const trusted = options.trustedModelRegistry === true;
  const incomingRegistry = trusted && hasOwn(incoming, 'modelRegistry') ? validateModelRegistry(incoming.modelRegistry) : undefined;
  if (trusted && hasOwn(incoming, 'modelCredentialCleanup')) incoming.modelCredentialCleanup = normalizeCleanupJournal(incoming.modelCredentialCleanup);
  else delete incoming.modelCredentialCleanup;
  delete incoming.modelRegistry;
  const manager = options.secretManager || getOrCreateSecretManager(userDataPath);
  // Propagate the opt-out into the internal load as well as the returned value.
  const current = loadSettings(userDataPath, { ...options, secretManager: manager });
  if (options.expectedRegistryRevision !== undefined && options.expectedRegistryRevision !== current.modelRegistry.revision) throw modelSettingsError('Model configuration changed; reload before saving', 'CONFIG_CONFLICT');
  let registry = incomingRegistry || current.modelRegistry;
  if (original.exists && incomingRegistry) {
    const same = JSON.stringify(incomingRegistry) === JSON.stringify(current.modelRegistry);
    if (!same && incomingRegistry.revision !== current.modelRegistry.revision + 1) throw modelSettingsError('Model configuration changed; reload before saving', 'CONFIG_CONFLICT');
  }
  // Only an initial legacy caller may seed a newly-created settings file. Once
  // a registry exists, all old aliases (including apiKey) are read-only.
  let initialKey = '';
  if (!original.exists && !incomingRegistry) {
    initialKey = resolveLegacyApiKeyEnabled(options) && typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : '';
    registry = createModelRegistry({ ...DEFAULT_SETTINGS, ...incoming, secretRef: initialKey ? 'sec_main_api_key' : '', apiKeyConfigured: Boolean(initialKey), apiKey: initialKey });
  }
  for (const alias of ['baseUrl', 'model', 'apiKey', 'apiKeyConfigured', 'apiKeyUnavailable', 'secretRef']) delete incoming[alias];
  const next = normalizeSettings({ ...current, ...incoming, modelRegistry: registry });
  registerSettingsSecrets(next, manager);
  if (initialKey) storeLegacyPlaintext(initialKey, manager);
  const previousServers = readSettingsDisk(file).parsed.mcpServers;
  const diskCopy = projectLegacyAliases({ ...next, mcpServers: protectMcpServers(next.mcpServers, previousServers, manager) }, manager, { resolveLegacyApiKey: false });
  delete diskCopy.apiKey;
  writeSettingsFile(file, diskCopy);
  retireMcpCredentials(previousServers, diskCopy.mcpServers, manager);
  return projectLegacyAliases(next, manager, options);
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
  getModelRegistryBackupPath,
  getSettingsSecretManager: getOrCreateSecretManager,
  loadSettings,
  saveSettings,
  clampInt,
  clampCompactSettings,
  clampMemorySettings,
  clampWebSettings,
  clampUsageSettings,
  clampMcpD10Settings,
  normalizeVerificationProfile,
  clampVerificationSettings,
  VERIFICATION_PROFILE_LIMIT,
  VERIFICATION_PROFILE_PROJECT_LIMIT,
  sanitizePricing,
  normalizeDomainList,
};
