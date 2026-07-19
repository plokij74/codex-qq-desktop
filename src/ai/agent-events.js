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
};

module.exports = { AGENT_EVENTS };
