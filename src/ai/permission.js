const { normalizeAgentMode, isPlanBlockedRisk } = require('./agent-mode');

const READ_TOOLS = new Set([
  'list_dir', 'read_file', 'grep', 'glob',
  'git_status', 'git_diff',
  'submit_plan',
  'list_skills', 'use_skill', 'spawn_explore', 'spawn_explores',
  'recall',
  'code_index_status', 'code_index_search', 'verification_profiles',
  'verification_get', 'verification_result',
  'engineering_workflows', 'workflow_get', 'workflow_result',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'search_replace', 'git_commit', 'spawn_implement', 'run_skill',
  'remember', 'forget',
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
  if (name === 'sampling/createMessage' || name === 'mcp_sampling') return 'mcp-sampling';
  if (name.startsWith('mcp_')) return 'mcp';
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'web_fetch') return 'network';
  if (name === 'delete_path') return 'delete';
  if (name === 'run_terminal') return 'terminal';
  if (name === 'verification_start') return 'terminal';
  if (name === 'workflow_start' || name === 'workflow_cancel') return 'terminal';
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
  webEnabled = false,
  webRequireConfirm = true,
  // Some capabilities (MCP sampling) are always interactive, including in
  // full-auto mode. The risk branch below also gives them server-scoped
  // allow_session memory without weakening ordinary tool policy.
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

  function cancelPending(reason = '审批已取消') {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      const error = new Error(String(reason || '审批已取消').slice(0, 200));
      error.code = 'ABORTED';
      entry.reject(error);
    }
    return entries.length;
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
          scope: payload.scope,
          diff: payload.diff, // may be undefined
          source: payload.source,
          server: payload.server,
          context: payload.context,
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
    tool, risk, summary, detail, path, scope, sessionKey, signal, diff, source, server, context,
    agentMode: callAgentMode,
  } = {}) {
    const allowedWithDecision = (decision) => {
      const result = { allowed: true };
      if (decision) Object.defineProperty(result, 'decision', { value: decision, enumerable: false });
      return result;
    };
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

    // MCP sampling is an explicit, host-controlled capability. Never let
    // permissionMode=full-auto bypass this approval; allow_session is scoped
    // to the server by the caller's scope string.
    if (effectiveRisk === 'mcp-sampling') {
      const allowKey = scope ? `mcp-sampling:${scope}` : 'mcp-sampling';
      if (isSessionAllowed(sessionKey, allowKey)) return { allowed: true };
      const decision = await waitForApproval(
        { tool, risk: effectiveRisk, summary, detail, path, scope, diff, source, server, context },
        signal,
      );
      if (decision.decision === 'allow_session') {
        rememberSession(sessionKey, allowKey);
        return allowedWithDecision('allow_session');
      }
      if (decision.decision === 'allow') return allowedWithDecision('allow');
      return { allowed: false, reason: '用户拒绝' };
    }

    // Network access has its own switch and approval policy. In particular,
    // read-only protects disk writes but still requires approval for egress.
    if (effectiveRisk === 'network') {
      if (webEnabled === false) {
        return { allowed: false, reason: '网页访问未启用，请在设置中打开' };
      }
      if (permissionMode === 'full-auto' && webRequireConfirm === false) {
        return { allowed: true };
      }
      const allowKey = scope ? `network:${scope}` : 'network';
      if (isSessionAllowed(sessionKey, allowKey)) {
        return { allowed: true };
      }
      const decision = await waitForApproval(
        { tool, risk: effectiveRisk, summary, detail, path, scope, diff },
        signal,
      );
      if (decision.decision === 'allow_session') {
        rememberSession(sessionKey, allowKey);
        return allowedWithDecision('allow_session');
      }
      if (decision.decision === 'allow') return allowedWithDecision('allow');
      return { allowed: false, reason: '用户拒绝' };
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

    // A saved verification profile is executable authority. Full-auto may
    // not bypass its first or changed-fingerprint approval; the verification
    // manager owns the persistent project+profile grant.
    if (tool === 'verification_start') {
      const decision = await waitForApproval(
        { tool, risk: effectiveRisk, summary, detail, path, diff },
        signal,
      );
      if (decision.decision === 'allow_session') return allowedWithDecision('allow_session');
      if (decision.decision === 'allow') return allowedWithDecision('allow');
      return { allowed: false, reason: '用户拒绝' };
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
      return allowedWithDecision('allow_session');
    }
    if (decisionResult.decision === 'allow') {
      return allowedWithDecision('allow');
    }
    return { allowed: false, reason: '用户拒绝' };
  }

  return {
    authorize,
    resolveApproval,
    cancelPending,
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
