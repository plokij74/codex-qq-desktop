'use strict';

const { LIMITS, assertFields, attachmentError, publicAttachmentError, normalizePublicAttachment, countCodePoints } = require('./attachment-contract');
const { createAttachmentPreviewService } = require('./attachment-preview');
const ENVELOPE = ['sessionId', 'attachmentSessionBindingId', 'clientRequestId'];
const SEND = [...ENVELOPE, 'requestKind', 'draftRevision', 'attachmentIds', 'attachmentSelections', 'messages', 'assistantId', 'modelProfileId',
  'expectedRegistryRevision', 'projectBindingId', 'agentMode', 'mode', 'project', 'projectPath', 'planId', 'planRevision'];
const FIELDS = Object.freeze({
  registerSession: ['sessionId', 'clientRequestId'], restoreSession: ['sessionId', 'namespaceRef', 'clientRequestId'],
  chooseExternal: ENVELOPE, proposeDrop: [...ENVELOPE, 'paths'], captureProjectRefs: [...SEND, 'refs'], list: ENVELOPE,
  prepareSend: SEND, previewPage: [...ENVELOPE, 'previewId', 'attachmentId', 'offset', 'limit'],
  remove: [...ENVELOPE, 'attachmentId', 'draftRevision'], deleteCopy: [...ENVELOPE, 'attachmentId'],
  cancel: [...ENVELOPE, 'previewId', 'targetClientRequestId'], cacheStatus: ENVELOPE, clearCache: ENVELOPE,
});

// Scan the already-delivered IPC object before any model, source, or blob work.
// No stringify/deep-copy and no getters: renderer data is never authority.
function boundedPayload(payload) {
  let nodes = 0, bytes = 0; const stack = [{ value: payload, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++nodes > LIMITS.MAX_PACKAGE_JSON_NODES || depth > 16) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
    if (typeof value === 'string') { bytes += Buffer.byteLength(value, 'utf8'); if (bytes > LIMITS.MAX_REQUEST_BYTES) throw attachmentError('ATTACHMENT_TEXT_LIMIT'); continue; }
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) continue;
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) throw attachmentError();
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw attachmentError();
    const keys = Reflect.ownKeys(value);
    if (keys.length > LIMITS.MAX_PACKAGE_JSON_NODES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
    for (const key of keys) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw attachmentError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw attachmentError();
      bytes += Buffer.byteLength(key, 'utf8'); if (bytes > LIMITS.MAX_REQUEST_BYTES) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}
function validateSend(payload) {
  if (payload.requestKind !== undefined && !['chat', 'approvePlan'].includes(payload.requestKind)) throw attachmentError();
  if (payload.requestKind === 'approvePlan' && !payload.planId || payload.requestKind === 'chat' && payload.planId) throw attachmentError('ATTACHMENT_PREVIEW_STALE');
  if (payload.project !== undefined && payload.project !== null) assertFields(payload.project, ['id', 'name', 'path']);
  if (payload.attachmentSelections !== undefined) {
    if (!Array.isArray(payload.attachmentSelections) || payload.attachmentSelections.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
    for (const selection of payload.attachmentSelections) assertFields(selection, ['attachmentId', 'prefixCodePoints']);
  }
}
const TOP = ['ok', 'success', 'required', 'cancelled', 'deferred', 'deleted', 'dirty', 'status', 'storageMode', 'sessionId', 'namespaceRef',
  'attachmentSessionBindingId', 'previewId', 'expiresAt', 'deduplicated', 'records', 'recordCount', 'diskRecords', 'diskBytes', 'cacheBytes',
  'retainedBytes', 'workBytes', 'activeWork', 'memoryBytes', 'readyRecords', 'removed', 'offset', 'totalCodePoints', 'nextOffset', 'truncated', 'empty', 'done', 'attachmentId'];
const TARGET = ['providerId', 'providerName', 'origin', 'model', 'modelProfileId', 'assistantId', 'assistantName', 'protocol'];
const BUDGET = ['estimatedInputTokens', 'contextLimit', 'maxOutputTokens', 'requestBytes', 'rawBytes', 'selectedBytes', 'selectedChars', 'truncatedCount', 'count'];
function scalars(source, fields) {
  const result = {};
  for (const key of fields) {
    const value = Object.getOwnPropertyDescriptor(source || {}, key)?.value;
    if (typeof value === 'string' && value.length <= 4096 || typeof value === 'boolean' || Number.isSafeInteger(value)) result[key] = value;
  }
  return result;
}
function publicResult(name, value) {
  if (!value || typeof value !== 'object') return {};
  if (Object.getOwnPropertyDescriptor(value, 'refVersion')?.value === 1) return normalizePublicAttachment(value);
  const result = scalars(value, TOP);
  for (const key of ['refs', 'attachments']) {
    const refs = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (Array.isArray(refs)) {
      if (refs.length > LIMITS.MAX_CACHE_RECORDS) throw attachmentError('ATTACHMENT_CACHE_LIMIT');
      result[key] = refs.map(normalizePublicAttachment);
    }
  }
  if (value.target) result.target = scalars(value.target, TARGET);
  if (value.budget) result.budget = scalars(value.budget, BUDGET);
  if (name === 'previewPage') {
    const text = Object.getOwnPropertyDescriptor(value, 'text')?.value;
    if (typeof text !== 'string' || countCodePoints(text) > LIMITS.PREVIEW_PAGE_CODEPOINTS) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
    result.text = text;
  }
  return result;
}
function createAttachmentIpcHandlers(options = {}) {
  const service = options.service || createAttachmentPreviewService(options), handlers = {};
  for (const [name, fields] of Object.entries(FIELDS)) handlers['attachments:' + name] = async (event, payload = {}) => {
    try {
      assertFields(payload, fields); boundedPayload(payload);
      if (name === 'prepareSend' || name === 'captureProjectRefs') validateSend(payload);
      if (name === 'captureProjectRefs' && (!Array.isArray(payload.messages) || !payload.assistantId || !payload.modelProfileId)) throw attachmentError('ATTACHMENT_READ_DENIED');
      return publicResult(name, await service[name](event, payload));
    } catch (error) { return publicAttachmentError(error); }
  };
  return { handlers: Object.freeze(handlers), service };
}
module.exports = { createAttachmentIpcHandlers };
