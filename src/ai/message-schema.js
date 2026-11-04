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
const { normalizePublicAttachment, newAttachmentId, sanitizeName, LIMITS: ATTACHMENT_LIMITS } = require('./attachment-contract');
const { redactSecrets } = require('./secret-manager');

const MODEL_SOURCE_KINDS = new Set(['api', 'local-demo', 'legacy-demo', 'unknown']);
const MODEL_SOURCE_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);

function normalizeModelSource(raw) {
  if (!raw || typeof raw !== 'object' || !MODEL_SOURCE_KINDS.has(raw.kind)) return undefined;
  const result = { kind: raw.kind };
  for (const key of ['assistantId', 'assistantName', 'providerId', 'modelProfileId', 'model', 'runId', 'clientRequestId']) {
    const value = typeof raw[key] === 'string' ? raw[key].trim().slice(0, key === 'model' ? 256 : 128) : '';
    if (value) result[key] = value;
  }
  if (MODEL_SOURCE_PROTOCOLS.has(raw.protocol)) result.protocol = raw.protocol;
  for (const key of ['providerRevision', 'modelRevision', 'assistantRevision']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
  }
  return result;
}

function normalizeMessageModelSource(message) {
  const next = { ...message };
  delete next.source;
  delete next.providerState;
  delete next.apiKey;
  delete next.credential;
  const modelSource = normalizeModelSource(next.modelSource);
  if (modelSource) next.modelSource = modelSource;
  else delete next.modelSource;
  return next;
}

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
  CORRUPT: 'corrupt',
  DELETED: 'deleted',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  LEGACY_UNAVAILABLE: 'legacy_unavailable',
  UNSUPPORTED: 'unsupported',
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
  return newAttachmentId();
}

/**
 * Strip sensitive keys recursively from any object or array.
 */
function stripSecrets(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return truncateString(require('./secret-manager').redactSecrets(value), 65536);
  if (Array.isArray(value)) return value.slice(0, 256).map((v) => stripSecrets(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 256)) {
    const lowerKey = k.toLowerCase();
    if (SECRET_KEYS.has(lowerKey) || /(?:secret|password|apikey|api_key)/i.test(k) || /(?:^|_)token$/i.test(k)) out[k] = '[REDACTED]';
    else out[k] = stripSecrets(v, depth + 1);
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
function ownValue(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function attachmentProjectionError(code) {
  const message = code === 'ATTACHMENT_LEGACY_REQUIRES_MIGRATION'
    ? '历史附件需要显式迁移；未读取或导出原件。'
    : '附件引用数量超限；未替换会话。';
  return Object.assign(new Error(message), { code, safeMessage: message });
}

function normalizeAttachmentRef(att = {}) {
  const mime = ownValue(att, 'mimeType') || ownValue(att, 'mime') || ownValue(att, 'type');
  const mimeType = typeof mime === 'string' && mime !== PART_TYPES.ATTACHMENT_REF ? mime : 'application/octet-stream';
  const oldPayload = ownValue(att, 'refVersion') !== 1 &&
    (typeof ownValue(att, 'dataUrl') === 'string' || typeof ownValue(att, 'base64') === 'string' || mimeType.startsWith('image/'));
  return normalizePublicAttachment({
    refVersion: ownValue(att, 'refVersion'),
    attachmentId: ownValue(att, 'attachmentId') || ownValue(att, 'id'),
    name: ownValue(att, 'name'), mimeType, size: ownValue(att, 'size'),
    source: ownValue(att, 'source'),
    status: oldPayload ? ATTACHMENT_STATUS.UNSUPPORTED : ownValue(att, 'status'),
    storageMode: ownValue(att, 'storageMode'), budget: ownValue(att, 'budget'),
  });
}

/** A ref is metadata, never proof that the current model has received bytes. */
function attachmentMetadataText(raw) {
  const ref = normalizeAttachmentRef(raw);
  return `[附件: ${ref.name} (${ref.mimeType}, ${ref.size} 字节)] ` +
    `（仅元信息；状态: ${ref.status}；存储: ${ref.storageMode}；` +
    `截断: ${ref.budget.truncated ? '是' : '否'}；未提供正文、未读取原件）`;
}

function assertAttachmentPartsLimit(parts) {
  if (Array.isArray(parts) && parts.length > 256 && parts.slice(256).some(p => p && p.type === PART_TYPES.ATTACHMENT_REF)) {
    throw attachmentProjectionError('ATTACHMENT_PARTS_LIMIT');
  }
}

function normalizeAttachmentManifest(value) {
  if (!Array.isArray(value)) return undefined;
  const refs = [], seen = new Set();
  for (const raw of value) {
    const ref = { type: PART_TYPES.ATTACHMENT_REF, ...normalizeAttachmentRef(raw) };
    const key = ref.attachmentId || JSON.stringify([ref.name, ref.mimeType, ref.size, ref.source]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length > ATTACHMENT_LIMITS.MAX_COMPACT_ATTACHMENT_REFS) throw attachmentProjectionError('ATTACHMENT_COMPACT_MANIFEST_LIMIT');
  }
  return refs;
}

function appendAttachmentParts(parts, attachments, manifest) {
  for (const list of [attachments, manifest]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const ref = { type: PART_TYPES.ATTACHMENT_REF, ...normalizeAttachmentRef(raw) };
      if (!parts.some(p => p.type === PART_TYPES.ATTACHMENT_REF && (ref.attachmentId
        ? p.attachmentId === ref.attachmentId : p.name === ref.name && p.mimeType === ref.mimeType && p.size === ref.size))) parts.push(ref);
    }
  }
  return parts;
}

/**
 * Normalize a single content part.
 */
function sanitizeManagedLegacyMessage(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
  const carriers = [...rawParts.filter(p => ownValue(p, 'type') === PART_TYPES.ATTACHMENT_REF), ...(Array.isArray(raw.attachments) ? raw.attachments : [])];
  const unsupported = new Set();
  const sanitizeText = text => {
    if (typeof text !== 'string' || (raw.role || 'user') !== 'user') return text;
    const lines = text.split(/\r?\n/);
    let fence = '', changed = false;
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = ''; output.push(line); continue; }
      const image = !fence && /^\s{0,3}!\[([^\]\r\n]*)\]\((data:image\/[^\s)]*;base64,[^\s)]*)\)\s*$/.exec(line);
      const standalone = (i === 0 || !lines[i - 1].trim()) && (i === lines.length - 1 || !lines[i + 1].trim());
      if (!image || !standalone) { output.push(line); continue; }
      const matches = carriers.filter(c => ownValue(c, 'refVersion') !== 1 &&
        (ownValue(c, 'dataUrl') === image[2] || sanitizeName(ownValue(c, 'name')) === sanitizeName(image[1]) &&
          String(ownValue(c, 'mimeType') || ownValue(c, 'mime') || ownValue(c, 'type') || '').startsWith('image/')));
      if (!matches.length) throw attachmentProjectionError('ATTACHMENT_LEGACY_REQUIRES_MIGRATION');
      for (const carrier of matches) unsupported.add(carrier);
      changed = true;
    }
    return changed ? output.join('\n').replace(/\n{3,}/g, '\n\n').trim() : text;
  };
  const content = sanitizeText(raw.content);
  const parts = rawParts.map(part => ownValue(part, 'type') === PART_TYPES.TEXT ? { ...part, text: sanitizeText(part.text) } : part);
  const safeRef = ref => ({ type: PART_TYPES.ATTACHMENT_REF, ...normalizeAttachmentRef(unsupported.has(ref)
    ? { attachmentId: ownValue(ref, 'attachmentId') || ownValue(ref, 'id'), name: ownValue(ref, 'name'), mimeType: ownValue(ref, 'mimeType') || ownValue(ref, 'type'), size: ownValue(ref, 'size'), source: ownValue(ref, 'source'), status: 'unsupported' } : ref) });
  const safeParts = parts.map(p => ownValue(p, 'type') === PART_TYPES.ATTACHMENT_REF ? safeRef(p) : p);
  const result = { ...raw, content };
  if (Array.isArray(raw.parts)) result.parts = safeParts;
  if (Array.isArray(raw.attachments)) result.attachments = raw.attachments.map(safeRef);
  if (Array.isArray(raw.attachmentManifest)) result.attachmentManifest = normalizeAttachmentManifest(raw.attachmentManifest);
  return result;
}

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

  opts = sanitizeManagedLegacyMessage(opts);
  const parts = appendAttachmentParts(Array.isArray(opts.parts) && opts.parts.length
    ? opts.parts.map(normalizePart)
    : (opts.content != null ? [{ type: PART_TYPES.TEXT, text: String(opts.content) }] : []), opts.attachments, opts.attachmentManifest);
  assertAttachmentPartsLimit(parts);

  const trajectory = Array.isArray(opts.trajectory)
    ? opts.trajectory.map(normalizeTrajectoryItem).filter(Boolean).slice(-LIMITS.MAX_TRAJECTORY_ITEMS)
    : [];

  const planPart = parts.find((p) => p && p.type === PART_TYPES.PLAN);

  return normalizeMessageModelSource({
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
  });
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

  msg = sanitizeManagedLegacyMessage(msg);
  // Already v2
  if (msg.schemaVersion === SCHEMA_VERSION && Array.isArray(msg.parts)) {
    const parts = appendAttachmentParts(msg.parts.map(normalizePart), msg.attachments, msg.attachmentManifest);
    assertAttachmentPartsLimit(parts);
    return normalizeMessageModelSource({
      ...msg,
      id: msg.id || createMessageId(),
      parts,
      trajectory: Array.isArray(msg.trajectory)
        ? msg.trajectory.map(normalizeTrajectoryItem).filter(Boolean).slice(-LIMITS.MAX_TRAJECTORY_ITEMS)
        : [],
      content: msg.content != null && typeof msg.content === 'string' ? msg.content : extractTextFromParts(msg.parts),
    });
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
  const normalized = projectToStorageJson(msg);
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
    modelSource: normalizeModelSource(normalized.modelSource),
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
function projectToModelMessagesWithoutStorageTruncation(messages) {
  const list = Array.isArray(messages) ? messages : (messages && typeof messages === 'object' ? [messages] : []);
  return list.map(raw => {
    const msg = normalizeMessage(raw);
    const contentParts = [];
    for (const part of msg.parts) {
      if (part.type === PART_TYPES.TEXT && part.text) contentParts.push(part.text);
      else if (part.type === PART_TYPES.PLAN) contentParts.push(`已提交计划：\n${part.title ? `# ${part.title}\n\n` : ''}${part.markdown || ''}`);
      else if (part.type === PART_TYPES.ATTACHMENT_REF) contentParts.push(attachmentMetadataText(part));
    }
    // Main-process caller owns context/wire limits. Storage sanitization is not
    // a model budget and must never silently slice the independently bounded run.
    return { role: redactSecrets(String(msg.role)), content: redactSecrets(contentParts.join('\n\n')) };
  });
}

function projectToModelMessages(messages) {
  // Intentionally no opts, projectPath, expander, body map, or file access.
  return stripSecrets(projectToModelMessagesWithoutStorageTruncation(messages));
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
    if (p.type === PART_TYPES.ATTACHMENT_REF) return { type: PART_TYPES.ATTACHMENT_REF, ...normalizeAttachmentRef(p) };
    if (p.type === PART_TYPES.TOOL_CALL) return { ...p, args: truncateString(JSON.stringify(stripSecrets(p.args)), LIMITS.MAX_TOOL_ARGS_CHARS) };
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
    ...(normalized.attachmentManifest ? { attachmentManifest: normalizeAttachmentManifest(normalized.attachmentManifest) } : {}),
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
    modelSource: normalizeModelSource(normalized.modelSource),
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
  normalizeModelSource,
  migrateV1ToV2: normalizeMessage,
  migrateSessionMessages,
  projectToUiModel,
  projectToUIMessage: projectToUiModel,
  projectToModelMessages,
  projectToModelMessagesWithoutStorageTruncation,
  attachmentMetadataText,
  normalizeAttachmentManifest,
  assertAttachmentPartsLimit,
  attachmentProjectionError,
  projectToStorageJson,
  projectToStorageMessage: projectToStorageJson,
  fromStorageJson,
};
