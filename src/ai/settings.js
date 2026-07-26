const fs = require('fs');
const path = require('path');
const { sanitizeMcpServers } = require('./mcp-config');

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
  return s;
}

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    merged.exploreMaxParallel = clampExploreMaxParallel(merged.exploreMaxParallel);
    merged.mcpServers = sanitizeMcpServers(merged.mcpServers);
    clampCompactSettings(merged);
    return clampMemorySettings(merged);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
  next.exploreMaxParallel = clampExploreMaxParallel(next.exploreMaxParallel);
  next.mcpServers = sanitizeMcpServers(next.mcpServers);
  clampCompactSettings(next);
  clampMemorySettings(next);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(getSettingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
  loadSettings,
  saveSettings,
  clampInt,
  clampCompactSettings,
  clampMemorySettings,
};
