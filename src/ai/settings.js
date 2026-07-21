const fs = require('fs');
const path = require('path');

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
  mcpServers: [], // { name, command, args?, env?, cwd? }[]
  // Phase C.3 hooks
  hooksEnabled: true,
};

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
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
