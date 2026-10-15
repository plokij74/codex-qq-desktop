'use strict';

/**
 * Phase E2 — Unified Versioned Message Architecture and Projections
 *
 * Provides versioned message model (schemaVersion: 2), typed content parts,
 * trajectory storage, sanitization, and three canonical projections:
 * 1. projectToUiModel: For renderer display
 * 2. projectToModelMessages: For LLM chat completions
 * 3. projectToStorageJson: For LocalStorage persistence and export
 */

const SCHEMA_VERSION = 2;

const { DEFAULT_BUDGETS } = require('./task-contract');

const PART_TYPES = Object.freeze({
  TEXT: 'text',
  ATTACHMENT_REF: 'attachment_ref',
  PLAN: 'plan',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
});

const TRAJECTORY_KINDS = Object.freeze({
  TOOL: 'tool',
  APPROVAL: 'approval',
  VERIFY: 'verify',
  SUBAGENT: 'subagent',
  HOOK: 'hook',
  FILE_CHANGE: 'file_change',
});

const ATTACHMENT_SOURCES = Object.freeze({
  USER_UPLOAD: 'user_upload',
  AT_PROJECT_REF: 'at_project_ref',
  TOOL_OUTPUT: 'tool_output',
});

const ATTACHMENT_STATUS = Object.freeze({
  READY: 'ready',
  MISSING: 'missing',
  DELETED: 'deleted',
  EXPIRED: 'expired',
});

const PLAN_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
});

/** Keys stripped from storage and exports to prevent credential leaks. */
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'token',
  'password',
  'secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
]);

/** Hard limits to prevent LocalStorage explosion. */
const LIMITS = Object.freeze({
  MAX_TOOL_ARGS_CHARS: 200,
  MAX_TOOL_RESULT_CHARS: 1000,
  MAX_TRAJECTORY_ITEMS: 50,
  MAX_OUTPUT_LENGTH: 2000,
});

function createMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createAttachmentId() {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Strip sensitive keys recursively from any object or array.
 */
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lowerKey = String(k).toLowerCase();
    if (
      SECRET_KEYS.has(lowerKey) ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('password') ||
      lowerKey.includes('apikey') ||
      lowerKey.includes('api_key')
    ) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v && typeof v === 'object' ? stripSecrets(v) : v;
    }
  }
  return out;
}

/**
 * Safely truncate a string to a maximum length.
 */
function truncateString(str, max = 500) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…（已截断）';
}

/**
 * Normalize an attachment reference object.
 */
function normalizeAttachmentRef(att = {}) {
  return {
    attachmentId: String(att.attachmentId || att.id || createAttachmentId()),
    name: String(att.name || 'unnamed_file'),
    mimeType: String(att.mimeType || att.mime || att.type || 'application/octet-stream'),
    size: typeof att.size === 'number' && Number.isFinite(att.size) ? Math.max(0, att.size) : 0,
    hash: att.hash ? String(att.hash) : null,
    source: Object.values(ATTACHMENT_SOURCES).includes(att.source)
      ? att.source
      : ATTACHMENT_SOURCES.USER_UPLOAD,
    status: Object.values(ATTACHMENT_STATUS).includes(att.status)
      ? att.status
      : ATTACHMENT_STATUS.READY,
    budget: {
      estimatedTokens: typeof att.budget?.estimatedTokens === 'number' ? att.budget.estimatedTokens : 0,
      maxBytes: typeof att.budget?.maxBytes === 'number' ? att.budget.maxBytes : (att.size || 0),
      truncated: Boolean(att.budget?.truncated),
    },
    storagePath: att.storagePath ? String(att.storagePath) : null,
  };
}

/**
 * Normalize a single content part.
 */
function normalizePart(part) {
  if (!part || typeof part !== 'object') {
    return { type: PART_TYPES.TEXT, text: String(part || '') };
  }
  const type = String(part.type || PART_TYPES.TEXT);
  if (type === PART_TYPES.TEXT) {
    return {
      type: PART_TYPES.TEXT,
      text: typeof part.text === 'string' ? part.text : String(part.content || part.text || ''),
    };
  }
  if (type === PART_TYPES.ATTACHMENT_REF) {
    return {
      type: PART_TYPES.ATTACHMENT_REF,
      ...normalizeAttachmentRef(part),
    };
  }
  if (type === PART_TYPES.PLAN) {
    return {
      type: PART_TYPES.PLAN,
      planId: String(part.planId || ''),
      title: part.title ? String(part.title) : '实施计划',
      markdown: String(part.markdown || ''),
      steps: Array.isArray(part.steps) ? part.steps.map(String) : [],
      status: Object.values(PLAN_STATUS).includes(part.status) ? part.status : PLAN_STATUS.PROPOSED,
      createdAt: part.createdAt || Date.now(),
      resolvedAt: part.resolvedAt || null,
      resolutionReason: part.resolutionReason ? String(part.resolutionReason) : null,
    };
  }
  if (type === PART_TYPES.TOOL_CALL) {
    return {
      type: PART_TYPES.TOOL_CALL,
      callId: String(part.callId || ''),
      tool: String(part.tool || ''),
      args: stripSecrets(part.args || {}),
    };
  }
  if (type === PART_TYPES.TOOL_RESULT) {
    return {
      type: PART_TYPES.TOOL_RESULT,
      callId: String(part.callId || ''),
      tool: String(part.tool || ''),
      result: truncateString(typeof part.result === 'string' ? part.result : JSON.stringify(part.result || ''), LIMITS.MAX_TOOL_RESULT_CHARS),
      error: Boolean(part.error),
    };
  }
  // Unknown parts fallback safely to text
  return {
    type: PART_TYPES.TEXT,
    text: typeof part.text === 'string' ? part.text : JSON.stringify(part),
  };
}

/**
 * Normalize a trajectory item.
 */
function normalizeTrajectoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = String(item.kind || TRAJECTORY_KINDS.TOOL);
  const base = {
    id: item.id ? String(item.id) : undefined,
    kind,
    summary: item.summary ? String(item.summary) : (item.argsSummary ? String(item.argsSummary) : undefined),
    status: item.status ? String(item.status) : (item.ok === false ? 'error' : 'success'),
    timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
    durationMs: typeof item.durationMs === 'number' ? Math.max(0, item.durationMs) : undefined,
  };

  // Strip secrets and truncate detail if present
  let detail = item.detail;
  if (detail && typeof detail === 'object') {
    detail = stripSecrets(detail);
    if (typeof detail.output === 'string') {
      detail.output = detail.output.length > LIMITS.MAX_OUTPUT_LENGTH
        ? detail.output.slice(0, LIMITS.MAX_OUTPUT_LENGTH) + '...[TRUNCATED]'
        : detail.output;
    }
  }

  if (kind === TRAJECTORY_KINDS.TOOL) {
    return {
      ...base,
      callId: item.callId ? String(item.callId) : undefined,
      tool: String(item.tool || item.name || 'unknown_tool'),
      argsSummary: truncateString(item.argsSummary || item.summary || '', LIMITS.MAX_TOOL_ARGS_CHARS),
      detail,
    };
  }
  if (kind === TRAJECTORY_KINDS.APPROVAL) {
    return {
      ...base,
      tool: String(item.tool || ''),
      description: truncateString(item.description || item.summary || '', LIMITS.MAX_TOOL_ARGS_CHARS),
      decision: item.decision || (item.status === 'approved' ? 'approved' : 'rejected'),
      detail,
    };
  }
  if (kind === TRAJECTORY_KINDS.VERIFY) {
    return {
      ...base,
      passed: Boolean(item.passed ?? (item.status === 'completed' || item.status === 'success')),
      checks: Array.isArray(item.checks) ? item.checks.map(String) : [],
      failureCount: typeof item.failureCount === 'number' ? item.failureCount : (item.passed ? 0 : 0),
      runId: item.runId ? String(item.runId) : undefined,
      detail,
    };
  }
  if (kind === TRAJECTORY_KINDS.SUBAGENT) {
    return {
      ...base,
      subagentId: String(item.subagentId || ''),
      kindName: String(item.kindName || item.kind || 'explore'),
      goal: truncateString(item.goal || item.summary || '', LIMITS.MAX_TOOL_ARGS_CHARS),
      detail,
    };
  }
  if (kind === TRAJECTORY_KINDS.FILE_CHANGE) {
    return {
      ...base,
      path: String(item.path || ''),
      op: String(item.op || item.action || 'modify'),
      stats: item.stats || null,
      detail,
    };
  }
  return { ...base, detail };
}

/**
 * Create a new V2 Message.
 */
function createMessageV2(roleOrOpts = {}, contentOrParts = null, extraOpts = {}) {
  let opts;
  if (typeof roleOrOpts === 'string') {
    opts = { role: roleOrOpts, ...extraOpts };
    if (Array.isArray(contentOrParts)) {
      opts.parts = contentOrParts;
    } else if (contentOrParts != null) {
      opts.content = contentOrParts;
    }
  } else {
    opts = roleOrOpts || {};
  }

  const parts = Array.isArray(opts.parts) && opts.parts.length
    ? opts.parts.map(normalizePart)
    : (opts.content != null ? [{ type: PART_TYPES.TEXT, text: String(opts.content) }] : []);

  const trajectory = Array.isArray(opts.trajectory)
    ? opts.trajectory.map(normalizeTrajectoryItem).filter(Boolean).slice(-LIMITS.MAX_TRAJECTORY_ITEMS)
    : [];

  const planPart = parts.find((p) => p && p.type === PART_TYPES.PLAN);

  return {
    ...opts,
    id: String(opts.id || createMessageId()),
    sessionId: opts.sessionId ? String(opts.sessionId) : null,
    role: String(opts.role || 'user'),
    createdAt: typeof opts.createdAt === 'number' ? opts.createdAt : Date.now(),
    schemaVersion: SCHEMA_VERSION,
    parts,
    trajectory,
    // Cached fallback text for legacy consumers
    content: opts.content != null ? String(opts.content) : extractTextFromParts(parts),
    applied: Boolean(opts.applied),
    fileChanges: Array.isArray(opts.fileChanges) ? opts.fileChanges.slice() : [],
    error: Boolean(opts.error),
    errorMessage: opts.errorMessage ? String(opts.errorMessage) : null,
    aborted: Boolean(opts.aborted),
    compact: Boolean(opts.compact),
    compactAt: typeof opts.compactAt === 'number' ? opts.compactAt : (opts.compact ? Date.now() : undefined),
    compactedCount: typeof opts.compactedCount === 'number' ? opts.compactedCount : 0,
    // Legacy compatibility fields
    tool: opts.tool ? String(opts.tool) : undefined,
    toolSummary: opts.toolSummary ? String(opts.toolSummary) : undefined,
    planId: opts.planId || planPart?.planId || undefined,
    planTitle: opts.planTitle || planPart?.title || undefined,
    planMarkdown: opts.planMarkdown || planPart?.markdown || undefined,
    planSteps: Array.isArray(opts.planSteps) ? opts.planSteps : (planPart?.steps || undefined),
    planStatus: opts.planStatus || planPart?.status || undefined,
  };
}

/**
 * Extract combined text from parts.
 */
function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  const texts = [];
  for (const part of parts) {
    if (part.type === PART_TYPES.TEXT && part.text) {
      texts.push(part.text);
    } else if (part.type === PART_TYPES.PLAN && part.markdown) {
      texts.push(`【实施计划: ${part.title || '实施计划'}】\n${part.markdown}`);
    } else if (part.type === PART_TYPES.ATTACHMENT_REF) {
      texts.push(`📎 附件：${part.name}${part.size ? ` (${Math.round(part.size / 1024)} KB)` : ''}`);
    }
  }
  return texts.join('\n\n');
}

/**
 * Normalize an existing message, migrating v1 if needed.
 */
function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return createMessageV2({ role: 'user', content: '' });
  }

  // Already v2
  if (msg.schemaVersion === SCHEMA_VERSION && Array.isArray(msg.parts)) {
    return {
      ...msg,
      id: msg.id || createMessageId(),
      parts: msg.parts.map(normalizePart),
      trajectory: Array.isArray(msg.trajectory)
        ? msg.trajectory.map(normalizeTrajectoryItem).filter(Boolean).slice(-LIMITS.MAX_TRAJECTORY_ITEMS)
        : [],
      content: msg.content != null && typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.parts),
    };
  }

  // V1 migration
  const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
  const parts = Array.isArray(msg.parts)
    ? msg.parts.map(normalizePart)
    : (content !== '' ? [{ type: PART_TYPES.TEXT, text: content }] : []);

  // If there's an attached plan in legacy fields
  if (msg.planId && msg.planMarkdown && !parts.some((p) => p && p.type === PART_TYPES.PLAN)) {
    parts.push({
      type: PART_TYPES.PLAN,
      planId: msg.planId,
      title: msg.planTitle || '实施计划',
      markdown: msg.planMarkdown,
      steps: Array.isArray(msg.planSteps) ? msg.planSteps : [],
      status: msg.planStatus || PLAN_STATUS.PROPOSED,
    });
  }

  return createMessageV2({
    ...msg,
    id: msg.id || createMessageId(),
    sessionId: msg.sessionId || null,
    role: msg.role || 'user',
    createdAt: msg.createdAt || Date.now(),
    parts,
    trajectory: Array.isArray(msg.trajectory) ? msg.trajectory : [],
    applied: msg.applied,
    fileChanges: msg.fileChanges,
    error: msg.error,
    errorMessage: msg.errorMessage,
    aborted: msg.aborted,
    compact: msg.compact,
    compactAt: msg.compactAt,
    compactedCount: msg.compactedCount,
    tool: msg.tool,
    toolSummary: msg.toolSummary,
    planId: msg.planId,
    planTitle: msg.planTitle,
    planMarkdown: msg.planMarkdown,
    planSteps: msg.planSteps,
    planStatus: msg.planStatus,
  });
}

/**
 * Migrate an entire array of session messages from v1 to v2.
 */
function migrateSessionMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessage);
}

// =========================================================================
// 1. UI Projection (projectToUiModel)
// =========================================================================

/**
 * Project a message for UI display.
 */
function projectToUiModel(msg) {
  const normalized = normalizeMessage(msg);
  const textParts = [];
  const attachments = [];
  let plan = null;

  for (const part of normalized.parts) {
    if (part.type === PART_TYPES.TEXT) {
      if (part.text) textParts.push(part.text);
    } else if (part.type === PART_TYPES.ATTACHMENT_REF) {
      attachments.push(part);
    } else if (part.type === PART_TYPES.PLAN) {
      plan = part;
    }
  }

  return {
    id: normalized.id,
    sessionId: normalized.sessionId,
    role: normalized.role,
    createdAt: normalized.createdAt,
    displayText: textParts.join('\n\n'),
    content: normalized.content || textParts.join('\n\n'),
    attachments,
    plan,
    trajectory: normalized.trajectory,
    fileChanges: normalized.fileChanges,
    applied: normalized.applied,
    error: normalized.error,
    errorMessage: normalized.errorMessage,
    aborted: normalized.aborted,
    compact: normalized.compact,
    compactAt: normalized.compactAt,
    compactedCount: normalized.compactedCount,
    isUser: normalized.role === 'user',
    isAssistant: normalized.role === 'assistant',
  };
}

// =========================================================================
// 2. Model Projection (projectToModelMessages)
// =========================================================================

/**
 * Project messages into standard OpenAI-compatible format `{ role, content }`.
 * Never leaks raw UI trajectory or sensitive machine-local paths.
 */
function projectToModelMessages(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : (messages && typeof messages === 'object' ? [messages] : []);
  const out = [];

  for (const raw of list) {
    const msg = normalizeMessage(raw);
    const contentParts = [];

    for (const part of msg.parts) {
      if (part.type === PART_TYPES.TEXT) {
        if (part.text) contentParts.push(part.text);
      } else if (part.type === PART_TYPES.PLAN) {
        // Feed plan back to model if present in history
        const title = part.title ? `# ${part.title}\n\n` : '';
        contentParts.push(`已提交计划：\n${title}${part.markdown || ''}`);
      } else if (part.type === PART_TYPES.ATTACHMENT_REF) {
        // In E2, attachments provide metadata description to model
        // (E5/E6 will project real text contents or image payload parts)
        contentParts.push(`[附件: ${part.name} (${part.mimeType || 'application/octet-stream'}, ${part.size} 字节)]`);
      }
    }

    let textContent = contentParts.join('\n\n');

    out.push({
      role: msg.role,
      content: textContent,
    });
  }

  // Handle @refs expansion on the last user message if projectPath and expandAtRefs are provided
  if (opts.projectPath && typeof opts.expandAtRefs === 'function') {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].role !== 'user') continue;
      try {
        const expanded = opts.expandAtRefs(opts.projectPath, out[i].content);
        if (expanded && expanded.contextBlock) {
          out[i] = {
            role: 'user',
            content: `${out[i].content}\n\n${expanded.contextBlock}`,
          };
        }
      } catch {
        // keep original text on failure
      }
      break;
    }
  }

  return out;
}

// =========================================================================
// 3. Storage Projection (projectToStorageJson & fromStorageJson)
// =========================================================================

/**
 * Prepare a message for safe LocalStorage persistence.
 * Strips secrets, bounds trajectory sizes, and truncates long strings.
 */
function projectToStorageJson(msg) {
  const normalized = normalizeMessage(msg);

  const safeParts = normalized.parts.map((p) => {
    if (p.type === PART_TYPES.ATTACHMENT_REF) {
      // Do not store absolute local path in export/storage if sensitive
      const safeAtt = { ...p };
      delete safeAtt.localAbsPath;
      return safeAtt;
    }
    return p;
  });

  const safeTrajectory = normalized.trajectory.slice(-LIMITS.MAX_TRAJECTORY_ITEMS).map((t) => {
    const item = { ...t };
    if (item.argsSummary) item.argsSummary = truncateString(item.argsSummary, LIMITS.MAX_TOOL_ARGS_CHARS);
    if (item.result) item.result = truncateString(item.result, LIMITS.MAX_TOOL_RESULT_CHARS);
    return stripSecrets(item);
  });

  return stripSecrets({
    id: normalized.id,
    sessionId: normalized.sessionId,
    role: normalized.role,
    createdAt: normalized.createdAt,
    schemaVersion: SCHEMA_VERSION,
    parts: safeParts,
    trajectory: safeTrajectory,
    content: normalized.content, // legacy fallback
    applied: normalized.applied,
    fileChanges: stripSecrets(normalized.fileChanges || []),
    error: normalized.error,
    errorMessage: normalized.errorMessage,
    aborted: normalized.aborted,
    compact: normalized.compact,
    compactAt: normalized.compactAt,
    compactedCount: normalized.compactedCount,
    tool: normalized.tool,
    toolSummary: normalized.toolSummary,
    planId: normalized.planId,
    planTitle: normalized.planTitle,
    planMarkdown: normalized.planMarkdown,
    planSteps: normalized.planSteps,
    planStatus: normalized.planStatus,
  });
}

/**
 * Restore a message from storage JSON.
 */
function fromStorageJson(json) {
  return normalizeMessage(json);
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_BUDGETS,
  PART_TYPES,
  TRAJECTORY_KINDS,
  ATTACHMENT_SOURCES,
  ATTACHMENT_STATUS,
  PLAN_STATUS,
  LIMITS,
  SECRET_KEYS,
  createMessageId,
  createAttachmentId,
  stripSecrets,
  truncateString,
  normalizeAttachmentRef,
  normalizePart,
  normalizeTrajectoryItem,
  createMessageV2,
  normalizeMessage,
  migrateV1ToV2: normalizeMessage,
  migrateSessionMessages,
  projectToUiModel,
  projectToUIMessage: projectToUiModel,
  projectToModelMessages,
  projectToStorageJson,
  projectToStorageMessage: projectToStorageJson,
  fromStorageJson,
};
