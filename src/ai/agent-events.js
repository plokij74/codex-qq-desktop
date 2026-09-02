const AGENT_EVENTS = {
  RUN_START: 'run-start',
  TEXT_DELTA: 'text-delta',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
  APPROVAL_NEEDED: 'approval-needed',
  APPROVAL_RESOLVED: 'approval-resolved',
  TURN_END: 'turn-end',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
  FILE_CHANGE: 'file-change',
  TERMINAL_START: 'terminal-start',
  TERMINAL_OUTPUT: 'terminal-output',
  TERMINAL_END: 'terminal-end',
  PLAN_READY: 'plan-ready',
  PLAN_APPROVED: 'plan-approved',
  PLAN_REJECTED: 'plan-rejected',
  VERIFY_RESULT: 'verify-result',
  SUBAGENT_START: 'subagent-start',
  SUBAGENT_END: 'subagent-end',
  WORKTREE_READY: 'worktree-ready',
  WORKTREE_STATE: 'worktree-state',
  WORKTREE_RECOVERED: 'worktree-recovered',
  MCP_STATUS: 'mcp-status',
  HOOK_START: 'hook-start',
  HOOK_END: 'hook-end',
  USAGE: 'usage',
  // D11 engineering job events deliberately have no entry here. They travel on
  // their own IPC channel ('engineering:event') straight to the engineering
  // center, never through the chat event stream, so they cannot reach session
  // history or usage. Adding a constant here would invite wiring them into the
  // chat pipeline that this separation exists to avoid.
};

module.exports = { AGENT_EVENTS };
