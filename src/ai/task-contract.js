'use strict';

/**
 * Phase E2 — Common Task Contract for E9/E10
 *
 * Defines unified task identity, lifecycle states, cancellation reasons,
 * and event envelopes to be shared between Chat Runs, PTY terminals (E9),
 * and Generic Background Tasks & Recovery (E10).
 */

const TASK_KINDS = Object.freeze({
  CHAT_RUN: 'chat_run',
  PTY_SESSION: 'pty_session',
  BACKGROUND_JOB: 'background_job',
  VERIFICATION: 'verification',
  SUBAGENT: 'subagent',
});

const TASK_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const CANCEL_REASONS = Object.freeze({
  USER_REQUEST: 'user_request',
  TIMEOUT: 'timeout',
  SESSION_CLOSED: 'session_closed',
  PROJECT_CHANGED: 'project_changed',
  SYSTEM_SHUTDOWN: 'system_shutdown',
});

// Allowed state transitions
const ALLOWED_TRANSITIONS = new Map([
  [TASK_STATES.IDLE, new Set([TASK_STATES.STARTING, TASK_STATES.CANCELLED])],
  [TASK_STATES.STARTING, new Set([TASK_STATES.RUNNING, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.RUNNING, new Set([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED])],
  [TASK_STATES.COMPLETED, new Set()], // terminal
  [TASK_STATES.FAILED, new Set()], // terminal
  [TASK_STATES.CANCELLED, new Set()], // terminal
]);

function createTaskId(kind = 'task') {
  const prefix = String(kind || 'task').toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validate whether a task state transition is legal.
 */
function isValidTaskTransition(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS.get(fromState);
  if (!allowed) return false;
  return allowed.has(toState);
}

/**
 * Construct a standard Task Event Envelope.
 */
function createTaskEventEnvelope(opts = {}) {
  const taskId = String(opts.taskId || '');
  if (!taskId) {
    throw new Error('createTaskEventEnvelope requires taskId');
  }
  return {
    taskId,
    kind: opts.kind || TASK_KINDS.CHAT_RUN,
    sessionId: opts.sessionId ? String(opts.sessionId) : null,
    projectId: opts.projectId ? String(opts.projectId) : null,
    type: String(opts.type || 'task-event'),
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    data: opts.data || {},
  };
}

/**
 * Universal Task Handle managing abort signals and lifecycle.
 */
class TaskHandle {
  /**
   * @param {object} opts
   * @param {string} [opts.taskId]
   * @param {string} [opts.kind]
   * @param {string} [opts.sessionId]
   * @param {string} [opts.projectId]
   * @param {string|number} [opts.ownerId]
   * @param {AbortController} [opts.abortController]
   * @param {function} [opts.onStatusChange]
   */
  constructor(opts = {}) {
    this.taskId = opts.taskId || createTaskId(opts.kind || TASK_KINDS.CHAT_RUN);
    this.kind = opts.kind || TASK_KINDS.CHAT_RUN;
    this.sessionId = opts.sessionId ? String(opts.sessionId) : null;
    this.projectId = opts.projectId ? String(opts.projectId) : null;
    this.ownerId = opts.ownerId != null ? String(opts.ownerId) : null;
    this.state = TASK_STATES.IDLE;
    this.abortController = opts.abortController || new AbortController();
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.cancelReason = null;
    this.error = null;
    this.onStatusChange = typeof opts.onStatusChange === 'function' ? opts.onStatusChange : null;
  }

  get signal() {
    return this.abortController.signal;
  }

  isTerminal() {
    return (
      this.state === TASK_STATES.COMPLETED ||
      this.state === TASK_STATES.FAILED ||
      this.state === TASK_STATES.CANCELLED
    );
  }

  start() {
    this.transitionTo(TASK_STATES.STARTING);
    this.startedAt = Date.now();
    this.transitionTo(TASK_STATES.RUNNING);
    return this;
  }

  complete() {
    this.completedAt = Date.now();
    this.transitionTo(TASK_STATES.COMPLETED);
    return this;
  }

  fail(error) {
    this.completedAt = Date.now();
    this.error = error instanceof Error ? error.message : String(error || 'Task failed');
    this.transitionTo(TASK_STATES.FAILED);
    return this;
  }

  cancel(reason = CANCEL_REASONS.USER_REQUEST) {
    if (this.isTerminal()) return false;
    this.cancelReason = Object.values(CANCEL_REASONS).includes(reason)
      ? reason
      : CANCEL_REASONS.USER_REQUEST;
    this.completedAt = Date.now();
    try {
      this.abortController.abort(new Error(`Task cancelled: ${this.cancelReason}`));
    } catch {
      // ignore
    }
    this.transitionTo(TASK_STATES.CANCELLED);
    return true;
  }

  transitionTo(nextState) {
    if (this.state === nextState) return;
    if (!isValidTaskTransition(this.state, nextState)) {
      throw new Error(`Illegal task state transition: ${this.state} -> ${nextState} (taskId: ${this.taskId})`);
    }
    const prevState = this.state;
    this.state = nextState;
    if (this.onStatusChange) {
      try {
        this.onStatusChange({
          taskId: this.taskId,
          kind: this.kind,
          prevState,
          state: nextState,
          timestamp: Date.now(),
        });
      } catch {
        // observer failure should not break task execution
      }
    }
  }

  toSummary() {
    return {
      taskId: this.taskId,
      kind: this.kind,
      sessionId: this.sessionId,
      projectId: this.projectId,
      ownerId: this.ownerId,
      state: this.state,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      cancelReason: this.cancelReason,
      error: this.error,
    };
  }
}

const DEFAULT_BUDGETS = Object.freeze({
  maxTurns: 8,
  maxToolCalls: 25,
  maxCostUsd: 2.0,
  maxWallTimeMs: 120000,
});

const TASK_GATE_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  PASSED: 'passed',
  FAILED: 'failed',
});

function buildTaskContract(spec = {}) {
  const taskId = spec.taskId || createTaskId(spec.kind || TASK_KINDS.CHAT_RUN);
  const budgets = {
    ...DEFAULT_BUDGETS,
    ...(spec.budgets || {}),
  };
  return {
    taskId,
    title: spec.title || 'Task',
    instructions: spec.instructions || '',
    verificationCriteria: Array.isArray(spec.verificationCriteria) ? spec.verificationCriteria.slice() : [],
    budgets,
    spent: {
      turns: 0,
      toolCalls: 0,
      costUsd: 0,
      wallTimeMs: 0,
      ...(spec.spent || {}),
    },
    status: TASK_GATE_STATUS.PENDING,
    metadata: spec.metadata || {},
    createdAt: Date.now(),
  };
}

function parseTaskInstructions(prompt = '') {
  const text = String(prompt || '');
  let title = 'Task';
  const titleMatch = text.match(/^#+\s*Task:\s*(.+)$/m) || text.match(/^#+\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  let instructions = text;
  const instMatch = text.match(/Instructions?:\s*([\s\S]+?)(?=\n[A-Z][a-zA-Z0-9_\s]*:|$)/i);
  if (instMatch) {
    instructions = instMatch[1].trim();
  }

  const verificationCriteria = [];
  const verifBlockMatch = text.match(/Verification(?:\s*Criteria)?:\s*([\s\S]+?)(?=\n[A-Z][a-zA-Z0-9_\s]*:|$)/i);
  if (verifBlockMatch) {
    const lines = verifBlockMatch[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/^\s*[-*]\s*(.+)$/);
      if (itemMatch) {
        verificationCriteria.push(itemMatch[1].trim());
      }
    }
  }

  return {
    title,
    instructions,
    verificationCriteria,
  };
}

function recordContractStep(contract, step = {}) {
  if (!contract || !contract.spent) return;
  contract.spent.turns += 1;
  if (step.tool) contract.spent.toolCalls += 1;
  if (typeof step.costUsd === 'number') contract.spent.costUsd += step.costUsd;
  if (typeof step.durationMs === 'number') contract.spent.wallTimeMs += step.durationMs;
  if (contract.status === TASK_GATE_STATUS.PENDING) {
    contract.status = TASK_GATE_STATUS.IN_PROGRESS;
  }
}

function evaluateTaskGate(contract, runContext = {}) {
  if (!contract) return { passed: false, status: TASK_GATE_STATUS.FAILED, reason: 'Invalid contract' };
  const { budgets, spent } = contract;

  if (runContext.verifyPassed === true) {
    contract.status = TASK_GATE_STATUS.PASSED;
    return { passed: true, status: TASK_GATE_STATUS.PASSED, reason: 'Verification passed' };
  }

  if (spent.turns >= budgets.maxTurns) {
    contract.status = TASK_GATE_STATUS.FAILED;
    return { passed: false, status: TASK_GATE_STATUS.FAILED, reason: `Turn budget exceeded (${spent.turns}/${budgets.maxTurns})` };
  }
  if (spent.toolCalls >= budgets.maxToolCalls) {
    contract.status = TASK_GATE_STATUS.FAILED;
    return { passed: false, status: TASK_GATE_STATUS.FAILED, reason: `Tool call budget exceeded (${spent.toolCalls}/${budgets.maxToolCalls})` };
  }
  if (spent.costUsd >= budgets.maxCostUsd) {
    contract.status = TASK_GATE_STATUS.FAILED;
    return { passed: false, status: TASK_GATE_STATUS.FAILED, reason: `Cost budget exceeded ($${spent.costUsd}/$${budgets.maxCostUsd})` };
  }

  contract.status = TASK_GATE_STATUS.IN_PROGRESS;
  return { passed: false, status: TASK_GATE_STATUS.IN_PROGRESS, reason: 'Task in progress' };
}

function isTaskComplete(contract) {
  return contract?.status === TASK_GATE_STATUS.PASSED;
}

module.exports = {
  DEFAULT_BUDGETS,
  TASK_KINDS,
  TASK_STATES,
  CANCEL_REASONS,
  ALLOWED_TRANSITIONS,
  TASK_GATE_STATUS,
  createTaskId,
  isValidTaskTransition,
  createTaskEventEnvelope,
  TaskHandle,
  buildTaskContract,
  parseTaskInstructions,
  recordContractStep,
  evaluateTaskGate,
  isTaskComplete,
};
