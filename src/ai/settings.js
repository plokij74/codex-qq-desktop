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
};

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function clampExploreMaxParallel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    merged.exploreMaxParallel = clampExploreMaxParallel(merged.exploreMaxParallel);
    merged.mcpServers = sanitizeMcpServers(merged.mcpServers);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
  next.exploreMaxParallel = clampExploreMaxParallel(next.exploreMaxParallel);
  next.mcpServers = sanitizeMcpServers(next.mcpServers);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(getSettingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
  loadSettings,
  saveSettings,
};
