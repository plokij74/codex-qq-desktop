const fs = require('fs');
const path = require('path');
const { sanitizeMcpServers } = require('./mcp-config');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
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

/** Phase D.3: 价格行归一化；modelPrefix 为空的行整行丢弃。 */
function sanitizePricing(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    const modelPrefix = String(row?.modelPrefix ?? '').trim();
    if (!modelPrefix) continue;
    out.push({
      modelPrefix,
      inputPerM: clampFloat(row?.inputPerM, 0, 10000, 0),
      outputPerM: clampFloat(row?.outputPerM, 0, 10000, 0),
    });
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

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    merged.exploreMaxParallel = clampExploreMaxParallel(merged.exploreMaxParallel);
    // Paths are retained only from the settings file written by main. JSON
    // imports are sanitized before they reach this loader and cannot grant a
    // new root without a picker-issued token.
    merged.mcpServers = sanitizeMcpServers(merged.mcpServers, { allowRootPaths: true });
    clampCompactSettings(merged);
    clampMemorySettings(merged);
    clampWebSettings(merged);
    clampVerificationSettings(merged);
    return clampMcpD10Settings(clampUsageSettings(merged));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
  next.exploreMaxParallel = clampExploreMaxParallel(next.exploreMaxParallel);
  next.mcpServers = sanitizeMcpServers(next.mcpServers, { allowRootPaths: true });
  clampCompactSettings(next);
  clampMemorySettings(next);
  clampWebSettings(next);
  clampUsageSettings(next);
  clampVerificationSettings(next);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(getSettingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return clampMcpD10Settings(next);
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
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
