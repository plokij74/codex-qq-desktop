'use strict';
const { randomUUID } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160 && !value.includes('\0');

/** Public provenance is deliberately not a serialization of a resolved binding. */
function publicModelSource(binding, extra = {}) {
  if (!binding) return null;
  let endpoint = '';
  try { const url = new URL(binding.baseUrl); endpoint = `${url.origin}${url.pathname}`; } catch { /* local model has no remote endpoint */ }
  const source = {
    providerId: binding.providerId || null, providerName: binding.providerName || binding.provider?.name || null,
    modelProfileId: binding.modelProfileId || null, modelProfileName: binding.modelProfileName || binding.modelProfile?.name || null,
    model: binding.model || null, protocol: binding.protocol || null, endpoint,
    assistantId: binding.assistantId || binding.assistant?.id || null,
    assistantName: binding.assistantName || binding.assistant?.name || null,
    providerRevision: Number.isSafeInteger(binding.providerRevision) && binding.providerRevision > 0 ? binding.providerRevision : null,
    modelRevision: Number.isSafeInteger(binding.modelRevision) && binding.modelRevision > 0 ? binding.modelRevision : null,
    assistantRevision: Number.isSafeInteger(binding.assistantRevision) && binding.assistantRevision > 0 ? binding.assistantRevision : null,
    bindingRevision: binding.bindingRevision || null,
    runId: extra.runId || binding.runId || null,
    clientRequestId: extra.clientRequestId || binding.clientRequestId || null,
    // Workload kind (chat/compact/audit/diagnostic) is separate from provenance.
    kind: ['api', 'local-demo', 'legacy-demo', 'unknown'].includes(extra.kind || binding.kind)
      ? (extra.kind || binding.kind) : 'api',
  };
  return Object.freeze(source);
}

/** One foreground slot; abort requests never release it ahead of awaited cleanup. */
function createForegroundRuntime({ newRunId = randomUUID } = {}) {
  let current = null;
  return {
    get current() { return current; },
    acquire(input = {}) {
      if (current) throw fail('BUSY', '已有前台任务运行或清理中，请先等待其结束。');
      if (!Number.isSafeInteger(input.senderId) || input.senderId <= 0 || !validId(input.sessionId) || !validId(input.clientRequestId)
        || (input.runId != null && !validId(input.runId)) || (input.kind != null && !validId(input.kind))) throw fail('INVALID_RUN_TARGET', '运行缺少有效的窗口、会话或请求标识。');
      current = { ...input, runId: input.runId || newRunId(), kind: input.kind || 'chat', abort: input.abort || new AbortController(), released: false };
      return current;
    },
    cancel(target = {}) {
      const run = current;
      if (!run || target.senderId !== run.senderId || target.sessionId !== run.sessionId
        || (!validId(target.runId) && !validId(target.clientRequestId))
        || (target.runId != null && target.runId !== run.runId)
        || (target.clientRequestId != null && target.clientRequestId !== run.clientRequestId)) return { ok: false, code: 'RUN_TARGET_MISMATCH' };
      if (!run.abort.signal.aborted) run.abort.abort();
      return { ok: true, runId: run.runId };
    },
    cancelOwner(senderId) {
      if (!current || current.senderId !== senderId) return false;
      if (!current.abort.signal.aborted) current.abort.abort();
      return true;
    },
    release(lease) {
      if (!lease || current !== lease || lease.released) return false;
      lease.released = true; current = null; return true;
    },
  };
}
module.exports = { createForegroundRuntime, publicModelSource };
