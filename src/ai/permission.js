const { normalizeAgentMode, isPlanBlockedRisk } = require('./agent-mode');

const READ_TOOLS = new Set([
  'list_dir', 'read_file', 'grep', 'glob',
  'git_status', 'git_diff',
  'submit_plan',
  'list_skills', 'use_skill', 'spawn_explore', 'spawn_explores',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'search_replace', 'git_commit', 'spawn_implement',
]);

/**
 * Session-scoped allow_session memory shared across PermissionGate instances.
 * Keyed by sessionKey → Set of remembered risk strings.
 * Survives gate recreate on each chat:send so allow_session lasts for the session.
 * Use clearSessionAllows(sessionKey) to reset one session, or clearSessionAllows() for all.
 * @type {Map<string, Set<string>>}
 */
const globalSessionAllows = new Map();

function riskForTool(toolName) {
  const name = String(toolName || '');
  if (name.startsWith('mcp_')) return 'mcp';
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'delete_path') return 'delete';
  if (name === 'run_terminal') return 'terminal';
  return 'write';
}

function makeAbortedError() {
  const err = new Error('已停止');
  err.code = 'ABORTED';
  return err;
}

function rememberSessionRisk(sessionKey, risk) {
  if (!sessionKey || !risk) return;
  let set = globalSessionAllows.get(sessionKey);
  if (!set) {
    set = new Set();
    globalSessionAllows.set(sessionKey, set);
  }
  set.add(risk);
}

function isSessionRiskAllowed(sessionKey, risk) {
  if (!sessionKey) return false;
  const set = globalSessionAllows.get(sessionKey);
  return !!(set && set.has(risk));
}

/**
 * Clear session allow_session memory.
 * @param {string} [sessionKey] - when omitted, clears all sessions
 */
function clearSessionAllows(sessionKey) {
  if (sessionKey == null || sessionKey === '') {
    globalSessionAllows.clear();
    return;
  }
  globalSessionAllows.delete(sessionKey);
}

/**
 * Snapshot of remembered risks for a session (for tests/debug).
 * @param {string} sessionKey
 * @returns {Set<string>}
 */
function getSessionAllows(sessionKey) {
  const set = globalSessionAllows.get(sessionKey);
  return set ? new Set(set) : new Set();
}

function createPermissionGate({
  permissionMode = 'confirm-writes',
  terminalEnabled = false,
  terminalRequireConfirm = true,
  agentMode = 'agent',
  onApprovalNeeded,
} = {}) {
  const gateAgentMode = normalizeAgentMode(agentMode);
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();

  function rememberSession(sessionKey, risk) {
    rememberSessionRisk(sessionKey, risk);
  }

  function isSessionAllowed(sessionKey, risk) {
    return isSessionRiskAllowed(sessionKey, risk);
  }

  function nextApprovalId() {
    return `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function resolveApproval(approvalId, decision) {
    const entry = pending.get(approvalId);
    if (!entry) return false;
    pending.delete(approvalId);
    if (decision === 'allow' || decision === 'allow_session') {
      entry.resolve({ decision });
    } else {
      entry.resolve({ decision: 'deny' });
    }
    return true;
  }

  async function waitForApproval(payload, signal) {
    const approvalId = nextApprovalId();
    const waitPromise = new Promise((resolve, reject) => {
      pending.set(approvalId, { resolve, reject });
    });

    const onAbort = () => {
      const entry = pending.get(approvalId);
      if (!entry) return;
      pending.delete(approvalId);
      entry.reject(makeAbortedError());
    };

    if (signal) {
      if (signal.aborted) {
        pending.delete(approvalId);
        throw makeAbortedError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      if (typeof onApprovalNeeded === 'function') {
        await onApprovalNeeded({
          approvalId,
          tool: payload.tool,
          risk: payload.risk,
          summary: payload.summary,
          detail: payload.detail,
          path: payload.path,
          diff: payload.diff, // may be undefined
        });
      }
      const result = await waitPromise;
      return result;
    } catch (err) {
      // Cleanup pending on any exit without resolveApproval (e.g. onApprovalNeeded throw, abort).
      const entry = pending.get(approvalId);
      if (entry) {
        pending.delete(approvalId);
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async function authorize({
    tool, risk, summary, detail, path, sessionKey, signal, diff, agentMode: callAgentMode,
  } = {}) {
    const effectiveRisk = risk || riskForTool(tool);
    const mode = normalizeAgentMode(
      callAgentMode != null ? callAgentMode : gateAgentMode,
    );

    if (signal?.aborted) {
      throw makeAbortedError();
    }

    // Plan mode second gate: never write/delete/terminal
    if (mode === 'plan' && isPlanBlockedRisk(effectiveRisk)) {
      return { allowed: false, reason: '当前为计划模式，仅允许只读与提交计划' };
    }

    // Terminal disabled always denies terminal tools
    if (effectiveRisk === 'terminal' && terminalEnabled === false) {
      return { allowed: false, reason: '终端未启用，不允许执行终端命令' };
    }

    if (permissionMode === 'read-only') {
      if (effectiveRisk === 'read') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: '当前为只读模式，不允许写/删/终端操作',
      };
    }

    if (permissionMode === 'full-auto') {
      if (effectiveRisk === 'terminal' && terminalRequireConfirm === true) {
        // fall through to approval
      } else {
        return { allowed: true };
      }
    }

    // confirm-writes (default path) and full-auto terminal-with-confirm
    if (effectiveRisk === 'read') {
      return { allowed: true };
    }

    if (isSessionAllowed(sessionKey, effectiveRisk)) {
      return { allowed: true };
    }

    const decisionResult = await waitForApproval(
      { tool, risk: effectiveRisk, summary, detail, path, diff },
      signal,
    );

    if (decisionResult.decision === 'allow_session') {
      rememberSession(sessionKey, effectiveRisk);
      return { allowed: true };
    }
    if (decisionResult.decision === 'allow') {
      return { allowed: true };
    }
    return { allowed: false, reason: '用户拒绝' };
  }

  return {
    authorize,
    resolveApproval,
    rememberSession,
    riskForTool,
  };
}

module.exports = {
  riskForTool,
  createPermissionGate,
  clearSessionAllows,
  getSessionAllows,
};
