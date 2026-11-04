'use strict';

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.E5Attachments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildE5Attachments() {
  const STATUSES = new Set(['ready', 'missing', 'corrupt', 'expired', 'deleted', 'revoked', 'legacy_unavailable', 'unsupported']);
  const SOURCES = new Set(['user_upload', 'at_project_ref', 'tool_output']);
  const MODES = new Set(['encrypted', 'memory']);
  const STATUS_LABELS = Object.freeze({ ready: '可用', missing: '副本缺失', corrupt: '副本损坏', expired: '已过期', deleted: '副本已删除', revoked: '授权已撤销', legacy_unavailable: '旧引用不可用', unsupported: '类型未支持' });
  const PUBLIC_NUMBERS = ['extractedChars', 'selectedChars', 'selectedBytes', 'estimatedTokens'];
  const string = (value, max = 160) => typeof value === 'string' ? Array.from(value.trim()).slice(0, max).join('') : '';
  function safeRef(raw = {}) {
    const result = { attachmentId: string(raw.attachmentId || raw.id),
      name: string(raw.name, 255).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '') || '附件',
      mimeType: string(raw.mimeType || raw.type) || 'text/plain' };
    if (raw.refVersion === 1) result.refVersion = 1;
    if (SOURCES.has(raw.source)) result.source = raw.source;
    if (MODES.has(raw.storageMode)) result.storageMode = raw.storageMode;
    result.status = STATUSES.has(raw.status) ? raw.status : 'legacy_unavailable';
    if (result.mimeType.startsWith('image/') || raw.source === 'tool_output') result.status = 'unsupported';
    if (Number.isSafeInteger(raw.size) && raw.size >= 0) result.size = raw.size;
    const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : raw;
    const publicBudget = {};
    for (const key of PUBLIC_NUMBERS) if (Number.isSafeInteger(budget[key]) && budget[key] >= 0) publicBudget[key] = budget[key];
    if (typeof budget.truncated === 'boolean') publicBudget.truncated = budget.truncated;
    if (Object.keys(publicBudget).length) result.budget = publicBudget;
    return result;
  }
  function publicRefs(refs) { return (Array.isArray(refs) ? refs : []).map(safeRef); }
  function pendingRef(raw, cold = false) {
    const result = safeRef(raw);
    // Aliases support the existing draft chip code only; they never persist.
    result.id = result.attachmentId; result.type = result.mimeType;
    if (cold && result.storageMode === 'memory') result.status = 'expired';
    if (cold || raw?.unavailableAfterRestart || result.status !== 'ready') result.unavailableAfterRestart = true;
    return result;
  }
  function statusLabel(raw, cold = false) {
    const ref = safeRef(raw);
    const label = STATUS_LABELS[ref.status] || STATUS_LABELS.legacy_unavailable;
    if ((cold || raw?.unavailableAfterRestart) && ref.status === 'ready') return '待原生确认恢复';
    return label + (ref.storageMode === 'memory' ? ' · 仅内存' : ref.storageMode === 'encrypted' ? ' · 加密副本' : '');
  }
  function attachmentIds(refs) { return publicRefs(refs).map(ref => ref.attachmentId); }
  function possibleProjectRef(messages) {
    const user = [...(Array.isArray(messages) ? messages : [])].reverse().find(message => message?.role === 'user');
    // This is only a UI hint to acquire a namespace, never an @ authorization
    // decision. Every send still goes through main's prepareSend parser.
    return typeof user?.content === 'string' && user.content.includes('@')
      || (Array.isArray(user?.parts) && user.parts.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.includes('@')));
  }
  function selections(values) {
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const id = string(value?.attachmentId);
      if (id && Number.isSafeInteger(value.prefixCodePoints) && value.prefixCodePoints >= 0 && value.prefixCodePoints <= 65536) {
        result.push({ attachmentId: id, prefixCodePoints: value.prefixCodePoints });
      }
    }
    return result;
  }
  function freezeSnapshot(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value); Object.values(value).forEach(freezeSnapshot); return value;
  }
  return Object.freeze({ safeRef, publicRefs, pendingRef, statusLabel, attachmentIds, possibleProjectRef, selections, freezeSnapshot });
});
