'use strict';

const { randomBytes } = require('node:crypto');

const LIMITS = Object.freeze({
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_SELECTION_FILES: 8,
  MAX_SELECTION_RAW_BYTES: 8 * 1024 * 1024,
  MAX_FILE_TEXT_CODEPOINTS: 64 * 1024,
  MAX_SELECTION_TEXT_CODEPOINTS: 256 * 1024,
  MAX_REQUEST_BYTES: 4 * 1024 * 1024,
  UNKNOWN_CONTEXT_APPROX_LIMIT: 32000,
  MAX_CACHE_DISK_BYTES: 64 * 1024 * 1024,
  MAX_CACHE_RECORDS: 512,
  MAX_CACHE_MEMORY_BYTES: 16 * 1024 * 1024,
  MAX_ATTACHMENT_WORK_BYTES: 48 * 1024 * 1024,
  MAX_BYTE_OPERATION_CONCURRENCY: 1,
  CACHE_IDLE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  MAX_CAPTURE_CONCURRENCY: 1,
  CAPTURE_TIMEOUT_MS: 30000,
  PREVIEW_TTL_MS: 5 * 60 * 1000,
  MAX_PREVIEWS: 16,
  PREVIEW_PAGE_CODEPOINTS: 16 * 1024,
  MAX_COMPACT_ATTACHMENT_REFS: 128,
  MAX_BLOB_PACKAGE_BYTES: 4 * 1024 * 1024,
  MAX_BLOB_CIPHER_BYTES: 3 * 1024 * 1024,
  MAX_BLOB_PLAIN_BYTES: 3 * 1024 * 1024,
  MAX_MANIFEST_PACKAGE_BYTES: 4 * 1024 * 1024,
  MAX_MANIFEST_CIPHER_BYTES: 3 * 1024 * 1024,
  MAX_MANIFEST_PLAIN_BYTES: 2 * 1024 * 1024,
  MAX_PACKAGE_JSON_DEPTH: 8,
  MAX_PACKAGE_JSON_NODES: 65536,
  MAX_EXPLICIT_RANGE_LINES: 500,
  MAX_DEFAULT_RANGE_LINES: 2000,
  MAX_DEFAULT_PROJECT_LINES: 2000,
  MAX_PUBLIC_ID_CHARS: 256,
  MAX_NAME_CODEPOINTS: 255,
  MAX_DIRECTORY_LIST_ENTRIES: 100,
  MAX_DIRECTORY_SCAN_ENTRIES: 512,
});

const ATTACHMENT_ERRORS = Object.freeze({
  ATTACHMENT_TYPE_UNSUPPORTED: '仅支持 E5 白名单中的 UTF-8 文本文件；图片和复杂文档尚未支持。',
  ATTACHMENT_ENCODING_INVALID: '文件不是有效 UTF-8 文本，或含不支持的编码、二进制或控制字符。',
  ATTACHMENT_FILE_LIMIT: '文件超过 2 MiB 硬读取上限，请选择较小文本文件。',
  ATTACHMENT_SELECTION_LIMIT: '本次最多选择 8 个文件、合计 8 MiB，请减少附件。',
  ATTACHMENT_TEXT_LIMIT: '本次文本超过上限，请缩小预览前缀或范围后重新确认。',
  ATTACHMENT_CAPTURE_BUSY: '已有文件读取正在执行或清理，请稍后再试。',
  ATTACHMENT_WORK_BUSY: '附件工作槽正在使用或清理，请稍后再试。',
  ATTACHMENT_CAPTURE_TIMEOUT: '文件读取超时，已取消；请等待清理后重新选择。',
  ATTACHMENT_READ_DENIED: '未获得本次安全读取授权，或文件类型、路径、链接不符合要求。',
  ATTACHMENT_SOURCE_CHANGED: '项目根、源文件身份、权限或内容已变化，请重新准备并查看附件。',
  ATTACHMENT_REFERENCE_INVALID: '附件引用或会话授权无效，请在当前窗口重新选择或恢复附件。',
  ATTACHMENT_SESSION_IN_USE: '该附件会话仍由其他窗口持有，不能自动接管。',
  ATTACHMENT_PREVIEW_REQUIRED: '附件或项目引用必须先查看实际文本及目标，再确认发送。',
  ATTACHMENT_PREVIEW_STALE: '草稿、附件、目标或权限已改变，请重新查看并确认。',
  ATTACHMENT_PREVIEW_EXPIRED: '附件预览已过期，请重新查看并确认。',
  ATTACHMENT_PREVIEW_USED: '该预览已用于一次发送，重试需要新的预览。',
  ATTACHMENT_MISSING: '应用附件副本缺失，请重新选择；不会自动重读原件。',
  ATTACHMENT_CORRUPT: '附件密文包不可读取或校验失败，原包已保留；请重新选择或恢复。',
  ATTACHMENT_EXPIRED: '附件副本已闲置过期，请重新选择。',
  ATTACHMENT_DELETED: '该附件应用副本已删除，请重新选择。',
  ATTACHMENT_CACHE_LIMIT: '附件缓存或临时内存达到硬上限，请移除未使用的附件后重试。',
  ATTACHMENT_STORAGE_UNAVAILABLE: '安全附件存储不可用；仅允许明确标注的内存副本。',
  ATTACHMENT_COMPACT_MANIFEST_LIMIT: '压缩后的附件引用超过 128 项，未提交压缩或修改原历史。',
  ABORTED: '附件操作已取消或窗口/授权已失效。',
});
const RECORD_STATUSES = Object.freeze(['ready', 'missing', 'corrupt', 'expired', 'deleted', 'revoked', 'legacy_unavailable', 'unsupported']);
const SOURCE_KINDS = Object.freeze(['user_upload', 'at_project_ref']);
const workBrands = new WeakMap();

function attachmentError(code = 'ATTACHMENT_REFERENCE_INVALID') {
  const safe = Object.hasOwn(ATTACHMENT_ERRORS, code) ? code : 'ATTACHMENT_REFERENCE_INVALID';
  return Object.assign(new Error(ATTACHMENT_ERRORS[safe]), { code: safe });
}
function publicAttachmentError(error) {
  let code;
  try { code = Object.getOwnPropertyDescriptor(error || {}, 'code')?.value; } catch { /* no getter or foreign message */ }
  const safe = Object.hasOwn(ATTACHMENT_ERRORS, code) ? code : 'ATTACHMENT_REFERENCE_INVALID';
  return { ok: false, code: safe, safeMessage: ATTACHMENT_ERRORS[safe], error: ATTACHMENT_ERRORS[safe] };
}
function checkAbort(signal) { if (signal?.aborted) throw attachmentError('ABORTED'); }
function checkedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, code = 'ATTACHMENT_REFERENCE_INVALID' } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw attachmentError(code);
  return value;
}
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null; }
  catch { return false; }
}
function assertFields(value, allowed, code = 'ATTACHMENT_REFERENCE_INVALID') {
  if (!isPlainObject(value)) throw attachmentError(code);
  const keys = new Set(allowed);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length > 256 || Reflect.ownKeys(descriptors).some(k => typeof k !== 'string' || !keys.has(k) || !Object.hasOwn(descriptors[k], 'value'))) throw attachmentError(code);
  } catch { throw attachmentError(code); }
  return value;
}
function checkedId(value, { optional = false, prefix, code = 'ATTACHMENT_REFERENCE_INVALID' } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.length || value.length > LIMITS.MAX_PUBLIC_ID_CHARS || /[\u0000-\u001f\u007f]/.test(value) || prefix && !new RegExp('^' + prefix + '_[a-f0-9]{32}$').test(value)) throw attachmentError(code);
  return value;
}
function randomOpaqueId(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9]{1,20}$/.test(prefix)) throw attachmentError();
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}
function newAttachmentId() { return randomOpaqueId('att'); }
function countCodePoints(text) {
  if (typeof text !== 'string') throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  let count = 0; for (const _point of text) count++; return count;
}
function prefixCodePoints(text, max) {
  checkedInteger(max, { code: 'ATTACHMENT_TEXT_LIMIT' });
  if (typeof text !== 'string') throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  let points = 0, end = 0;
  for (const point of text) { if (points === max) break; points++; end += point.length; }
  return text.slice(0, end);
}
function sanitizeName(value) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, '') : '';
  if (!name) return 'unnamed_file';
  return countCodePoints(name) > LIMITS.MAX_NAME_CODEPOINTS ? prefixCodePoints(name, LIMITS.MAX_NAME_CODEPOINTS - 1) + '…' : name;
}
function data(value, key, fallback) {
  try { const d = Object.getOwnPropertyDescriptor(value || {}, key); return d && Object.hasOwn(d, 'value') ? d.value : fallback; }
  catch { return fallback; }
}
function nonnegative(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : 0; }
function publicBudget(value = {}) {
  return {
    extractedChars: nonnegative(data(value, 'extractedChars', 0), LIMITS.MAX_FILE_BYTES),
    selectedChars: nonnegative(data(value, 'selectedChars', 0), LIMITS.MAX_FILE_TEXT_CODEPOINTS),
    selectedBytes: nonnegative(data(value, 'selectedBytes', 0), LIMITS.MAX_FILE_BYTES),
    estimatedTokens: nonnegative(data(value, 'estimatedTokens', 0), LIMITS.MAX_FILE_BYTES),
    truncated: data(value, 'truncated', false) === true,
  };
}
/** This is only a DTO projection. No DTO, even one marked ready, grants bytes. */
function publicAttachmentRef(record = {}) {
  const source = data(record, 'sourceKind', data(record, 'source', 'user_upload'));
  const status = data(record, 'status', 'ready');
  const mode = data(record, 'storageMode', 'unavailable');
  const mime = data(record, 'mimeType', 'application/octet-stream');
  return {
    refVersion: 1,
    attachmentId: typeof data(record, 'attachmentId', '') === 'string' ? data(record, 'attachmentId', '').slice(0, LIMITS.MAX_PUBLIC_ID_CHARS) : '',
    name: sanitizeName(data(record, 'name', '')),
    mimeType: typeof mime === 'string' && mime.length <= 128 && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime) ? mime : 'application/octet-stream',
    size: nonnegative(data(record, 'rawByteLength', data(record, 'byteLength', data(record, 'size', 0))), LIMITS.MAX_FILE_BYTES),
    source: SOURCE_KINDS.includes(source) ? source : 'tool_output',
    status: RECORD_STATUSES.includes(status) ? status : 'legacy_unavailable',
    storageMode: ['encrypted', 'memory'].includes(mode) ? mode : 'unavailable',
    budget: publicBudget(data(record, 'budget', {})),
  };
}
function normalizePublicAttachment(raw = {}) {
  const result = publicAttachmentRef(raw);
  const version = data(raw, 'refVersion', 0);
  if (version !== 1 || !/^att_[a-f0-9]{32}$/.test(result.attachmentId) || !SOURCE_KINDS.includes(result.source)) {
    result.status = data(raw, 'status', '') === 'unsupported' ? 'unsupported' : 'legacy_unavailable';
    result.storageMode = 'unavailable';
  }
  return result;
}
function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || /^[\\/]/.test(value) || /^[a-zA-Z]:/.test(value) || /[:\u0000-\u001f\u007f]/.test(value)) throw attachmentError('ATTACHMENT_READ_DENIED');
  let normalized = value.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  const components = normalized.split('/');
  if (!normalized || components.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw attachmentError('ATTACHMENT_READ_DENIED');
  return normalized;
}
function normalizeLineRange(raw = {}) {
  assertFields(raw, ['startLine', 'endLine']);
  if (raw.startLine === undefined && raw.endLine === undefined) return {};
  const startLine = checkedInteger(raw.startLine, { min: 1, max: LIMITS.MAX_FILE_BYTES + 1 });
  const endLine = checkedInteger(raw.endLine ?? startLine, { min: startLine, max: LIMITS.MAX_FILE_BYTES + 1 });
  if (endLine - startLine + 1 > LIMITS.MAX_EXPLICIT_RANGE_LINES) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  return { startLine, endLine };
}

/** Predict canonical decoded size without allocating a decoded buffer. */
function canonicalBase64Length(value, maxBytes = LIMITS.MAX_BLOB_CIPHER_BYTES) {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || value.length % 4 || value.length > 4 * Math.ceil(maxBytes / 3)) throw attachmentError('ATTACHMENT_CORRUPT');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bodyLength = value.length - padding;
  for (let index = 0; index < bodyLength; index++) {
    const ch = value.charCodeAt(index);
    if (!(ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122 || ch >= 48 && ch <= 57 || ch === 43 || ch === 47)) throw attachmentError('ATTACHMENT_CORRUPT');
  }
  if (padding && bodyLength < 2) throw attachmentError('ATTACHMENT_CORRUPT');
  const length = value.length / 4 * 3 - padding;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (length > maxBytes || padding === 2 && (alphabet.indexOf(value.at(-3)) & 15) || padding === 1 && (alphabet.indexOf(value.at(-2)) & 3)) throw attachmentError('ATTACHMENT_CORRUPT');
  return length;
}

/** Scan bytes/depth/nodes before constructing an AST. Strings are scanned, not copied. */
function parseBoundedJson(text, { maxBytes = LIMITS.MAX_MANIFEST_PLAIN_BYTES, maxDepth = LIMITS.MAX_PACKAGE_JSON_DEPTH, maxNodes = LIMITS.MAX_PACKAGE_JSON_NODES } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw attachmentError('ATTACHMENT_CORRUPT');
  let depth = 0, nodes = 0, index = 0;
  const add = () => { if (++nodes > maxNodes) throw attachmentError('ATTACHMENT_CORRUPT'); };
  while (index < text.length) {
    const ch = text[index];
    if (/\s/.test(ch) || ch === ',' || ch === ':') { index++; continue; }
    if (ch === '{' || ch === '[') { add(); if (++depth > maxDepth) throw attachmentError('ATTACHMENT_CORRUPT'); index++; continue; }
    if (ch === '}' || ch === ']') { if (--depth < 0) throw attachmentError('ATTACHMENT_CORRUPT'); index++; continue; }
    if (ch === '"') {
      add(); const start = index++; let closed = false;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index++] === '"') { closed = true; break; }
      }
      if (!closed) throw attachmentError('ATTACHMENT_CORRUPT');
      let next = index; while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (text[next] === ':') {
        if (index - start > 258) throw attachmentError('ATTACHMENT_CORRUPT');
        let key; try { key = JSON.parse(text.slice(start, index)); } catch { throw attachmentError('ATTACHMENT_CORRUPT'); }
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw attachmentError('ATTACHMENT_CORRUPT');
      }
      continue;
    }
    add();
    const start = index; while (index < text.length && !/[\s,}\]:]/.test(text[index])) index++;
    if (index === start) throw attachmentError('ATTACHMENT_CORRUPT');
  }
  if (depth !== 0) throw attachmentError('ATTACHMENT_CORRUPT');
  try { return JSON.parse(text); } catch { throw attachmentError('ATTACHMENT_CORRUPT'); }
}

function createAttachmentBudget() {
  let retainedBytes = 0, workBytes = 0, active = null;
  const reservations = new Set();
  function reservation(size, work) {
    checkedInteger(size, { code: 'ATTACHMENT_CACHE_LIMIT' });
    if (work ? workBytes + size > LIMITS.MAX_ATTACHMENT_WORK_BYTES : retainedBytes + size > LIMITS.MAX_CACHE_MEMORY_BYTES) throw attachmentError('ATTACHMENT_CACHE_LIMIT');
    if (work) workBytes += size; else retainedBytes += size;
    let released = false;
    const handle = Object.freeze({ bytes: size, release() {
      if (released) return; released = true;
      if (work) { workBytes -= size; reservations.delete(handle); } else retainedBytes -= size;
    } });
    if (work) reservations.add(handle);
    return handle;
  }
  const budget = {
    reserveRetained(size) { return reservation(size, false); },
    snapshot() { return { retainedBytes, workBytes, activeWork: active ? 1 : 0 }; },
    // Cleanup borrows the existing admission slot; it cannot create a slot,
    // outlive its root, or weaken cancellation on ordinary read/dispatch work.
    // Only trusted managed-delete/rollback code receives this private lease.
    async withCleanupWork({ work } = {}, callback) {
      const brand = workBrands.get(work);
      if (!brand || brand.budget !== budget || !active || brand.work !== active) throw attachmentError();
      const root = active, local = new Set(); let valid = true;
      const cleanup = Object.freeze({
        check() { if (!valid || active !== root) throw attachmentError(); },
        reserve(size) {
          cleanup.check(); const handle = reservation(size, true); local.add(handle); return handle;
        },
      });
      workBrands.set(cleanup, { budget, work: root, cleanup: true });
      try { return await callback(cleanup); }
      finally {
        valid = false; workBrands.delete(cleanup);
        for (const handle of local) handle.release();
      }
    },
    async withWork({ signal, work } = {}, callback) {
      if (work !== undefined && work !== null) {
        const brand = workBrands.get(work);
        if (!brand || brand.budget !== budget || brand.work !== active) throw attachmentError();
        checkAbort(signal); work.check(); return callback(work);
      }
      checkAbort(signal);
      if (active) throw attachmentError('ATTACHMENT_WORK_BUSY');
      const lease = Object.freeze({
        reserve(size) {
          if (active !== lease) throw attachmentError();
          checkAbort(signal); return reservation(size, true);
        },
        check() { if (active !== lease) throw attachmentError(); checkAbort(signal); },
      });
      active = lease; workBrands.set(lease, { budget, work: lease });
      try { return await callback(lease); }
      finally {
        for (const handle of [...reservations]) handle.release();
        workBrands.delete(lease); active = null;
      }
    },
  };
  return Object.freeze(budget);
}

module.exports = {
  LIMITS, ATTACHMENT_ERRORS, RECORD_STATUSES, SOURCE_KINDS,
  attachmentError, publicAttachmentError, checkAbort, checkedInteger, checkedId, isPlainObject, assertFields,
  randomOpaqueId, newAttachmentId, countCodePoints, prefixCodePoints, sanitizeName,
  publicAttachmentRef, normalizePublicAttachment, publicBudget, normalizeRelativePath, normalizeLineRange,
  canonicalBase64Length, parseBoundedJson, createAttachmentBudget,
};
