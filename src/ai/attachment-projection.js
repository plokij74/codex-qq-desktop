'use strict';

const schema = require('./message-schema');
const { LIMITS, attachmentError, countCodePoints, sanitizeName } = require('./attachment-contract');
const { getAttachmentRunData } = require('./attachment-preview');

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > LIMITS.MAX_SELECTION_FILES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
  let chars = 0, raw = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.text !== 'string' || !entry.record) throw attachmentError();
    const count = countCodePoints(entry.text);
    if (count > LIMITS.MAX_FILE_TEXT_CODEPOINTS) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
    chars += count; raw += entry.record.byteLength ?? entry.record.rawByteLength ?? entry.selected?.rawByteLength ?? 0;
  }
  if (chars > LIMITS.MAX_SELECTION_TEXT_CODEPOINTS) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
  if (!Number.isSafeInteger(raw) || raw < 0 || raw > LIMITS.MAX_SELECTION_RAW_BYTES) throw attachmentError('ATTACHMENT_SELECTION_LIMIT');
}

/** Pure preflight projection. Entries are main-only confirmed selections, never IPC DTOs. */
function buildAttachmentSelectionMessages(messages, entries, { work } = {}) {
  validateEntries(entries);
  if (typeof schema.projectToModelMessagesWithoutStorageTruncation !== 'function') throw attachmentError();
  let reservation;
  try {
    // Covers the bounded model projection and JSON/adapter copies. This is a
    // reservation, not a process-RSS claim. The transport reserves its copy too.
    if (work) reservation = work.reserve(LIMITS.MAX_REQUEST_BYTES * 6);
    const result = schema.projectToModelMessagesWithoutStorageTruncation(messages);
    if (!Array.isArray(result) || result.some(message => typeof message.content !== 'string')) throw attachmentError();
    let index = -1;
    for (let position = result.length - 1; position >= 0; position--) if (result[position].role === 'user') { index = position; break; }
    if (entries.length && index < 0) throw attachmentError();
    let bytes = result.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0);
    const blocks = [];
    for (const entry of entries) {
      const selected = entry.selected || {};
      const label = `附件正文（已确认${selected.truncated ? '，截断选段' : ''}）：${JSON.stringify(sanitizeName(entry.record.name))}\n`;
      bytes += Buffer.byteLength(label, 'utf8') + Buffer.byteLength(entry.text, 'utf8') + 2;
      if (bytes > LIMITS.MAX_REQUEST_BYTES) throw attachmentError('ATTACHMENT_TEXT_LIMIT');
      blocks.push(label + entry.text);
    }
    if (blocks.length) result[index] = { ...result[index], content: result[index].content + '\n\n' + blocks.join('\n\n') };
    return result;
  } finally { reservation?.release(); }
}

/** Only a consumed main-created lease can replace the current user projection. */
function projectAttachmentRunMessages(messages, run, options = {}) {
  const data = getAttachmentRunData(run);
  if (!data.consumed || data.released || data.invalidated) throw attachmentError();
  const source = Array.isArray(messages) ? messages.slice() : [];
  let index = -1;
  for (let position = source.length - 1; position >= 0; position--) if (source[position]?.role === 'user') { index = position; break; }
  if (index < 0) throw attachmentError();
  source[index] = data.userMessage;
  return buildAttachmentSelectionMessages(source, data.entries, options);
}

function attachmentRunSummary(run) {
  const data = getAttachmentRunData(run);
  if (!data.consumed || data.released) throw attachmentError();
  const result = { count: data.entries.length, rawBytes: 0, selectedBytes: 0, selectedChars: 0, truncatedCount: 0 };
  for (const entry of data.entries) {
    result.rawBytes += entry.record.byteLength ?? entry.record.rawByteLength ?? entry.selected.rawByteLength ?? 0;
    result.selectedBytes += entry.selected.selectedBytes;
    result.selectedChars += entry.selected.selectedChars;
    if (entry.selected.truncated) result.truncatedCount++;
  }
  const contextLimit = data.ticket?.budget?.contextLimit;
  if (Number.isSafeInteger(contextLimit) && contextLimit > 0) result.contextLimit = contextLimit;
  return Object.freeze(result);
}

module.exports = { buildAttachmentSelectionMessages, projectAttachmentRunMessages, attachmentRunSummary };
