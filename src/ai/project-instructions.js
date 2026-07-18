const fs = require('fs');
const path = require('path');

const MAX_CHARS = 8192;

/**
 * Read a project instruction file if present, capped at MAX_CHARS.
 * @param {string} filePath
 * @returns {string|null}
 */
function readCapped(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.length <= MAX_CHARS) return text;
    return text.slice(0, MAX_CHARS);
  } catch {
    return null;
  }
}

/**
 * Load AGENTS.md (or agents.md) and CLAUDE.md for system prompt injection.
 * @param {string} projectRoot
 * @returns {{ agentsText: string|null, claudeText: string|null, parts: string }}
 */
function loadProjectInstructions(projectRoot) {
  const root = path.resolve(projectRoot);

  let agentsText = readCapped(path.join(root, 'AGENTS.md'));
  let agentsName = 'AGENTS.md';
  if (agentsText == null) {
    agentsText = readCapped(path.join(root, 'agents.md'));
    agentsName = 'agents.md';
  }

  const claudeText = readCapped(path.join(root, 'CLAUDE.md'));

  const sections = [];
  if (agentsText != null) {
    sections.push(`## 项目指令 (${agentsName})\n\n${agentsText}`);
  }
  if (claudeText != null) {
    sections.push(`## 项目指令 (CLAUDE.md)\n\n${claudeText}`);
  }

  const parts = sections.length
    ? sections.join('\n\n')
    : '';

  return {
    agentsText: agentsText ?? null,
    claudeText: claudeText ?? null,
    parts,
  };
}

module.exports = {
  loadProjectInstructions,
  MAX_CHARS,
};
