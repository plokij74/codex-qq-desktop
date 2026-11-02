'use strict';

(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.E4ChatState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildE4ChatState() {
  const STORAGE_KEY = 'codex-qq-state-v3';
  const LEGACY_STORAGE_KEYS = ['codex-qq-state-v2', 'codex-qq-sessions-v1'];
  const MAX_DRAFT_TEXT_BYTES = 64 * 1024;
  const MAX_DRAFT_ATTACHMENTS = 20;
  const MAX_TOTAL_DRAFT_BYTES = 1024 * 1024;
  const MODEL_SOURCE_KINDS = new Set(['api', 'local-demo', 'legacy-demo', 'unknown']);
  const MODEL_SOURCE_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);

  function utf8Bytes(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(value)).length;
    return unescape(encodeURIComponent(String(value))).length;
  }

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function boundedString(value, max = 200) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : undefined;
  }

  function normalizeModelSource(raw) {
    if (!raw || typeof raw !== 'object' || !MODEL_SOURCE_KINDS.has(raw.kind)) return null;
    const result = { kind: raw.kind };
    for (const key of ['assistantId', 'assistantName', 'providerId', 'modelProfileId', 'model', 'runId', 'clientRequestId']) {
      const value = typeof raw[key] === 'string' ? boundedString(raw[key], key === 'model' ? 256 : 128) : undefined;
      if (value) result[key] = value;
    }
    if (MODEL_SOURCE_PROTOCOLS.has(raw.protocol)) result.protocol = raw.protocol;
    for (const key of ['providerRevision', 'modelRevision', 'assistantRevision']) {
      if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
    }
    return result;
  }

  function normalizeMessageSource(message, legacyDemo = false) {
    if (!message || typeof message !== 'object') return message;
    const modelSource = normalizeModelSource(message.modelSource)
      || (legacyDemo && message.role === 'assistant' ? { kind: 'legacy-demo' } : null);
    const next = { ...message };
    delete next.source;
    delete next.providerState;
    delete next.apiKey;
    delete next.credential;
    if (modelSource) next.modelSource = modelSource;
    else delete next.modelSource;
    return next;
  }

  function normalizeSession(raw = {}) {
    const session = { ...raw };
    const peer = String(raw.peer || 'codex');
    const wasDemoPeer = peer !== 'codex' && raw.identityType !== 'ai';
    const assistantId = boundedString(raw.assistantId, 128)
      || (peer === 'codex' ? 'assistant_codex' : '');
    session.id = String(raw.id || `session_${Date.now().toString(36)}`);
    session.identityType = raw.identityType === 'demo-contact' || wasDemoPeer ? 'demo-contact' : 'ai';
    session.assistantId = session.identityType === 'ai' ? (assistantId || 'assistant_general') : null;
    session.modelProfileId = raw.modelProfileId ? String(raw.modelProfileId) : null;
    session.legacyPeer = session.identityType === 'demo-contact'
      ? String(raw.legacyPeer || peer || 'legacy')
      : (raw.legacyPeer || null);
    session.peer = session.identityType === 'demo-contact' ? 'demo-contact' : 'codex';
    session.messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .map((message) => normalizeMessageSource(message, session.identityType === 'demo-contact'));
    return session;
  }

  function emptyDraft() {
    return { text: '', attachmentRefs: [], revision: 0, updatedAt: 0 };
  }

  function safeAttachmentRef(raw) {
    const ref = {};
    for (const key of ['attachmentId', 'name', 'mimeType']) {
      const value = boundedString(raw?.[key], key === 'name' ? 255 : 160);
      if (value) ref[key] = value;
    }
    if (Number.isFinite(raw?.size) && raw.size >= 0) ref.size = Math.floor(raw.size);
    return ref;
  }

  function normalizeDraft(raw) {
    const draft = raw && typeof raw === 'object' ? raw : {};
    const value = {
      text: typeof draft.text === 'string' ? draft.text : '',
      attachmentRefs: (Array.isArray(draft.attachmentRefs) ? draft.attachmentRefs : []).map(safeAttachmentRef),
      revision: Number.isSafeInteger(draft.revision) && draft.revision >= 0 ? draft.revision : 0,
      updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : 0,
    };
    if (utf8Bytes(value.text) > MAX_DRAFT_TEXT_BYTES || value.attachmentRefs.length > MAX_DRAFT_ATTACHMENTS) {
      return { ok: false, value, code: 'DRAFT_LIMIT', error: '草稿超过 64 KiB 或 20 个附件；完整内容保留在本次应用内，但未持久化' };
    }
    return { ok: true, value };
  }

  function createState(data = {}) {
    const sessions = Array.isArray(data.sessions) ? data.sessions.map(normalizeSession) : [];
    const ids = new Set(sessions.map((session) => session.id));
    const draftsBySession = {};
    if (data.draftsBySession && typeof data.draftsBySession === 'object' && !Array.isArray(data.draftsBySession)) {
      for (const [sessionId, draft] of Object.entries(data.draftsBySession)) {
        if (ids.has(sessionId)) draftsBySession[sessionId] = normalizeDraft(draft).value;
      }
    }
    for (const session of sessions) if (!draftsBySession[session.id]) draftsBySession[session.id] = emptyDraft();
    const activeSessionId = ids.has(data.activeSessionId) ? data.activeSessionId : (sessions[0]?.id || '');
    return {
      schemaVersion: 3, sessions,
      projects: Array.isArray(data.projects) ? clone(data.projects) : [],
      activeSessionId,
      pluginState: data.pluginState && typeof data.pluginState === 'object' ? clone(data.pluginState) : {},
      draftsBySession,
    };
  }

  function migrateState(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.sessions)
      || data.sessions.some((session) => !session || typeof session !== 'object' || Array.isArray(session) || !session.id
        || (session.messages !== undefined && !Array.isArray(session.messages)))) {
      return { ok: false, code: 'INVALID_STATE', error: '会话数据格式无效，原数据不会覆盖' };
    }
    const version = data.schemaVersion == null ? 0 : data.schemaVersion;
    if (!Number.isSafeInteger(version) || version < 0) return { ok: false, code: 'INVALID_STATE', error: '会话版本无效，原数据不会覆盖' };
    if (version > 3) return { ok: false, code: 'UNSUPPORTED_VERSION', error: `不支持的会话数据版本 ${version}` };
    const sessionIds = new Set(data.sessions.map((session) => String(session.id)));
    if (sessionIds.size !== data.sessions.length
      || (data.draftsBySession != null && (typeof data.draftsBySession !== 'object' || Array.isArray(data.draftsBySession)))) {
      return { ok: false, code: 'INVALID_STATE', error: '会话或草稿数据格式无效，原数据不会覆盖' };
    }
    for (const [sessionId, draft] of Object.entries(data.draftsBySession || {})) {
      if (!sessionIds.has(sessionId) || !draft || typeof draft !== 'object' || Array.isArray(draft)
        || (draft.text !== undefined && typeof draft.text !== 'string')
        || (draft.attachmentRefs !== undefined && !Array.isArray(draft.attachmentRefs))) {
        return { ok: false, code: 'INVALID_STATE', error: '会话或草稿数据格式无效，原数据不会覆盖' };
      }
    }
    const state = createState(data);
    const checked = serializeState(state);
    if (!checked.ok) return { ...checked, state };
    return { ok: true, migrated: version < 3, state };
  }

  function updateDraft(state, sessionId, patch) {
    const current = state?.draftsBySession?.[sessionId];
    if (!current) return { ok: false, code: 'SESSION_NOT_FOUND', error: '会话草稿不存在' };
    const normalized = normalizeDraft({ ...current, ...patch });
    const changed = current.text !== normalized.value.text
      || JSON.stringify(current.attachmentRefs) !== JSON.stringify(normalized.value.attachmentRefs);
    state.draftsBySession[sessionId] = {
      ...normalized.value,
      revision: changed ? current.revision + 1 : current.revision,
      updatedAt: changed ? Date.now() : current.updatedAt,
    };
    return { ...normalized, draft: state.draftsBySession[sessionId] };
  }

  function serializeState(state, messageProjector = (message) => message) {
    const drafts = {};
    for (const [sessionId, raw] of Object.entries(state?.draftsBySession || {})) {
      const normalized = normalizeDraft(raw);
      if (!normalized.ok) return normalized;
      drafts[sessionId] = normalized.value;
    }
    if (utf8Bytes(JSON.stringify(drafts)) > MAX_TOTAL_DRAFT_BYTES) {
      return { ok: false, code: 'DRAFT_TOTAL_LIMIT', error: '草稿总量超过 1 MiB，当前草稿保留但未持久化' };
    }
    const source = createState(state || {});
    source.draftsBySession = drafts;
    source.sessions = source.sessions.map((session) => ({
      ...session,
      messages: (session.messages || []).map((message) => messageProjector(normalizeMessageSource(message, false))),
    }));
    return { ok: true, value: source };
  }

  function persistableState(state) {
    return serializeState(state);
  }

  function writeState(storage, key, state, messageProjector) {
    const serialized = serializeState(state, messageProjector);
    if (!serialized.ok) return serialized;
    try {
      storage.setItem(key || STORAGE_KEY, JSON.stringify(serialized.value));
      return { ok: true, value: serialized.value };
    } catch (error) {
      return { ok: false, code: 'STORAGE_WRITE_FAILED', error: error?.message || '本地存储写入失败' };
    }
  }

  function createOutbox({ state, sessionId, assistantId, modelProfileId = null, expectedRegistryRevision, projectBindingId = '', messages = [], text = '' }) {
    const draft = state.draftsBySession[sessionId];
    if (!draft) throw new Error('SESSION_NOT_FOUND');
    const outbox = {
      sessionId,
      assistantId: assistantId || state.sessions.find((item) => item.id === sessionId)?.assistantId || 'assistant_codex',
      modelProfileId: modelProfileId || null,
      clientRequestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      expectedRegistryRevision: Number.isSafeInteger(expectedRegistryRevision) ? expectedRegistryRevision : 0,
      projectBindingId: projectBindingId || '',
      draftRevision: draft.revision,
      draftText: draft.text,
      text: String(text),
      attachmentRefs: clone(draft.attachmentRefs),
      messages: clone(messages),
    };
    return deepFreeze(outbox);
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function finishOutbox(state, outbox, result = {}) {
    const draft = state?.draftsBySession?.[outbox?.sessionId];
    if (!draft || draft.revision !== outbox.draftRevision) return false;
    if (result.accepted === true) {
      state.draftsBySession[outbox.sessionId] = { ...emptyDraft(), revision: draft.revision + 1, updatedAt: Date.now() };
    }
    return true;
  }

  function createRunLedger({ sessionId, clientRequestId, kind = 'chat' }) {
    return { sessionId, clientRequestId, kind, runId: null, accepted: false, terminal: false, task: null, usageKeys: new Set() };
  }

  function applyRunEvent(ledger, event = {}) {
    const ignored = () => ({ accepted: ledger?.accepted || false, terminal: false, ignore: true });
    if (!ledger || !event || typeof event !== 'object'
      || String(event.clientRequestId || '') !== ledger.clientRequestId
      || String(event.sessionId || '') !== ledger.sessionId || !event.runId) return ignored();
    const type = String(event.type || event.event || '');
    if (ledger.runId && String(event.runId) !== ledger.runId) return ignored();
    if (event.task?.kind === 'session_compact' && ledger.kind !== 'session_compact') return ignored();
    const start = ledger.kind === 'session_compact' ? type === 'compact-start' : ['run-start', 'run_start'].includes(type);
    if (start) {
      if (ledger.accepted || ledger.terminal) return ignored();
      ledger.runId = String(event.runId); ledger.accepted = true; ledger.task = event.task || null;
      return { accepted: true, terminal: false, ignore: false };
    }
    if (!ledger.accepted) return ignored();
    if (type === 'usage') {
      const attemptId = typeof event.attemptId === 'string' && event.attemptId.length > 0 && event.attemptId.length <= 160
        ? event.attemptId : null;
      const key = (attemptId && `attempt:${attemptId}`) || event.usageId || event.eventId || event.id
        || JSON.stringify([event.turn ?? event.turnIndex ?? null, event.kind || event.task?.kind || 'chat', event.inputTokens, event.outputTokens, event.cost, event.currency]);
      if (ledger.usageKeys.has(key) || ledger.usageKeys.size >= 512) return ignored();
      ledger.usageKeys.add(key);
      return { accepted: true, terminal: false, ignore: false };
    }
    if (ledger.terminal) return ignored();
    const terminal = (ledger.kind === 'session_compact'
      ? ['compact-done', 'compact-result', 'compact-error', 'compact-cancelled']
      : ['done', 'error', 'aborted', 'cancelled']).includes(type);
    if (terminal) ledger.terminal = true;
    return { accepted: true, terminal, ignore: false };
  }

  function createOutboxStore({ maxEntries = 8, maxBytes = 4 * 1024 * 1024 } = {}) {
    const records = new Map();
    let totalBytes = 0;
    function remove(id) {
      const record = records.get(id);
      if (!record) return false;
      totalBytes -= record.bytes; records.delete(id); return true;
    }
    return {
      add(outbox) {
        const id = outbox.clientRequestId;
        if (records.has(id)) return { ok: true };
        const bytes = utf8Bytes(JSON.stringify(outbox));
        if (records.size >= maxEntries || totalBytes + bytes > maxBytes) return { ok: false, code: 'OUTBOX_LIMIT', error: '未发送快照已达 8 个或 4 MiB 上限；请先查看并处理，不会丢弃已有内容' };
        records.set(id, { outbox, bytes, status: 'pending', error: '' }); totalBytes += bytes;
        return { ok: true };
      },
      replace(outbox) {
        const record = records.get(outbox.clientRequestId);
        if (!record) return { ok: false, code: 'OUTBOX_NOT_FOUND' };
        const bytes = utf8Bytes(JSON.stringify(outbox));
        if (totalBytes - record.bytes + bytes > maxBytes) return { ok: false, code: 'OUTBOX_LIMIT', error: '发送快照超过 4 MiB 上限，未发送内容仍保留' };
        totalBytes += bytes - record.bytes; record.bytes = bytes; record.outbox = deepFreeze(outbox);
        return { ok: true };
      },
      fail(id, error) { const record = records.get(id); if (record) { record.status = 'refused'; record.error = String(error || '请求未被接受').slice(0, 500); } },
      accept: remove,
      remove,
      list(sessionId) { return [...records.values()].filter((record) => !sessionId || record.outbox.sessionId === sessionId).map((record) => ({ outbox: record.outbox, status: record.status, error: record.error })); },
    };
  }

  function sessionReferences(sessions) {
    return (Array.isArray(sessions) ? sessions : []).map((session) => ({
      sessionId: String(session.id || ''),
      assistantId: session.assistantId || null,
      modelProfileId: session.modelProfileId || null,
      identityType: session.identityType === 'demo-contact' ? 'demo-contact' : 'ai',
    })).filter((item) => item.sessionId);
  }

  return {
    STORAGE_KEY, LEGACY_STORAGE_KEYS, MAX_DRAFT_TEXT_BYTES, MAX_DRAFT_ATTACHMENTS,
    MAX_TOTAL_DRAFT_BYTES, normalizeModelSource, normalizeMessageSource, normalizeSession,
    normalizeDraft, createState, migrateState, updateDraft, serializeState, persistableState,
    writeState, createOutbox, createOutboxStore, finishOutbox, createRunLedger, applyRunEvent, sessionReferences,
  };
});
