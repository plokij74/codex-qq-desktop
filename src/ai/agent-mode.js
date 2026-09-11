/** Phase C.1 plan | agent mode helpers */

const PLAN_BLOCKED_RISKS = new Set(['write', 'delete', 'terminal', 'mcp']);

const PLAN_HIDDEN_TOOLS = new Set([
  'search_replace',
  'write_file',
  'delete_path',
  'git_commit',
  'run_terminal',
  'verification_start',
  'workflow_start',
  'workflow_cancel',
  'repair_start',
  'repair_cancel',
  'spawn_explore',
  'spawn_explores',
  'spawn_implement',
  'run_skill',
]);

const PLAN_MARKDOWN_MAX = 32 * 1024;

/**
 * @param {unknown} value
 * @returns {'plan' | 'agent'}
 */
function normalizeAgentMode(value) {
  return value === 'plan' ? 'plan' : 'agent';
}

function shouldUseAgent({ settings, project } = {}) {
  return Boolean(
    settings?.mode === 'api'
      && settings?.agentEnabled !== false
      && settings?.apiKey
      && (project?.path || settings?.memoryEnabled !== false)
  );
}

/**
 * @param {string} risk
 * @returns {boolean}
 */
function isPlanBlockedRisk(risk) {
  return PLAN_BLOCKED_RISKS.has(risk);
}

/**
 * Filter tool defs for plan/agent mode.
 * plan: hide write/delete/terminal/git_commit; keep submit_plan
 * agent: drop submit_plan
 * @param {Array<{ function?: { name?: string } }>} toolDefs
 * @param {string} agentMode
 */
function filterToolsForMode(toolDefs, agentMode) {
  const mode = normalizeAgentMode(agentMode);
  const list = Array.isArray(toolDefs) ? toolDefs : [];
  if (mode === 'plan') {
    return list.filter((t) => {
      const name = t?.function?.name;
      if (!name) return false;
      if (PLAN_HIDDEN_TOOLS.has(name)) return false;
      if (String(name).startsWith('mcp_')) return false;
      return true;
    });
  }
  return list.filter((t) => t?.function?.name !== 'submit_plan');
}

function makePlanId() {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Synthetic user message after approve-exec.
 * @param {{ title?: string, markdown?: string }} opts
 */
function buildApproveExecutionMessage({ title, markdown } = {}) {
  const head = title ? `# ${title}\n\n` : '';
  return [
    '请严格按以下已批准计划执行。不要重新规划，除非发现计划不可行。',
    '',
    head + String(markdown || '').trim(),
  ].join('\n');
}

/**
 * @param {string} md
 * @returns {{ text: string, truncated: boolean }}
 */
function truncatePlanMarkdown(md) {
  const raw = String(md ?? '');
  if (raw.length <= PLAN_MARKDOWN_MAX) {
    return { text: raw, truncated: false };
  }
  const note = '\n\n…（计划正文已截断）';
  const keep = Math.max(0, PLAN_MARKDOWN_MAX - note.length);
  return { text: raw.slice(0, keep) + note, truncated: true };
}

module.exports = {
  PLAN_BLOCKED_RISKS,
  PLAN_HIDDEN_TOOLS,
  PLAN_MARKDOWN_MAX,
  normalizeAgentMode,
  shouldUseAgent,
  isPlanBlockedRisk,
  filterToolsForMode,
  makePlanId,
  buildApproveExecutionMessage,
  truncatePlanMarkdown,
};
