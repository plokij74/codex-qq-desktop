'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactSensitive } = require('./network-security');

const STORE_VERSION = 1;
const STORE_FILENAME = 'mcp-tasks.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;
const MAX_ACTIVE_PER_SERVER = 16;
const MAX_ACTIVE = 64;
const MAX_HISTORY = 500;
const MAX_PERSISTED_RESULT_BYTES = 256 * 1024;
const MAX_PUBLIC_RESULT_BYTES = 64 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['working', 'input_required']);
const STATUSES = new Set([...ACTIVE, ...TERMINAL]);

function stopsMonitoring(record) {
  return record?.localDisposition === 'abandoned' || record?.localDisposition === 'claimed';
}

function needsRecovery(record) {
  if (!record || record.kind !== 'tool' || stopsMonitoring(record)) return false;
  return ACTIVE.has(record.status)
    || (record.status === 'completed' && !record.resultStored && record.resultMemory === undefined);
}

function taskError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function clampTtl(value, fallback = DEFAULT_TTL_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, fallback));
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(n)));
}

function clampPoll(value, fallback = DEFAULT_POLL_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, fallback));
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.floor(n)));
}

function hashIdentity(value) {
  const text = String(value || '');
  return text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 32) : '';
}

function randomRef(prefix = 'mcp_task') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function cleanText(value, max = 500) {
  return redactSensitive(String(value || ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max);
}

function boundedJson(value, maxBytes = MAX_PERSISTED_RESULT_BYTES) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = ''; }
  text = String(text || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { value, text, truncated: false };
  }
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return { value: out, text: out, truncated: true };
}

function publicTask(record) {
  if (!record) return null;
  return {
    taskRef: record.localTaskRef,
    server: record.serverName,
    tool: record.toolName || null,
    kind: record.kind,
    transport: record.transport,
    status: record.status,
    statusMessage: record.statusMessage || null,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttl: record.ttl,
    pollIntervalMs: record.pollInterval,
    localDisposition: record.localDisposition || null,
    resultAvailable: Boolean(record.resultStored || record.resultMemory !== undefined),
    resultTruncated: record.resultTruncated === true,
    canCancel: ACTIVE.has(record.status) && !stopsMonitoring(record) && record.cancelUnavailable !== true,
    canAbandon: (ACTIVE.has(record.status) || needsRecovery(record)) && !stopsMonitoring(record),
    canClaim: record.status === 'completed'
      && Boolean(record.resultStored || record.resultMemory !== undefined)
      && (record.localDisposition == null || record.localDisposition === 'orphaned'),
    needsRecovery: needsRecovery(record),
  };
}

function storedRecord(record) {
  return {
    localTaskRef: record.localTaskRef,
    serverName: record.serverName,
    serverConfigFingerprint: record.serverConfigFingerprint || '',
    transport: record.transport || '',
    remoteTaskId: record.remoteTaskId,
    kind: record.kind,
    toolName: record.toolName || '',
    status: record.status,
    statusMessage: record.statusMessage || '',
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttl: record.ttl,
    pollInterval: record.pollInterval,
    sessionBinding: record.sessionBinding || '',
    sourceSessionIdHash: record.sourceSessionIdHash || '',
    sourceProjectPathHash: record.sourceProjectPathHash || '',
    persistedResult: record.persistedResult,
    resultTruncated: record.resultTruncated === true,
    localDisposition: record.localDisposition || null,
  };
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Receiver tasks can contain elicitation input or sampling output and are
  // intentionally process-local. Ignore any such records written by an
  // earlier build instead of reviving them after restart.
  if (raw.kind && raw.kind !== 'tool') return null;
  const localTaskRef = String(raw.localTaskRef || '');
  const remoteTaskId = String(raw.remoteTaskId || '');
  const serverName = String(raw.serverName || '');
  if (!/^mcp_task_[a-f0-9]{16,64}$/.test(localTaskRef) || !remoteTaskId || !serverName) return null;
  const status = STATUSES.has(String(raw.status)) ? String(raw.status) : 'failed';
  const createdAt = Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : new Date().toISOString();
  const lastUpdatedAt = Number.isFinite(Date.parse(raw.lastUpdatedAt)) ? new Date(raw.lastUpdatedAt).toISOString() : createdAt;
  const persisted = raw.persistedResult === undefined ? undefined : boundedJson(raw.persistedResult);
  return {
    localTaskRef,
    serverName: cleanText(serverName, 96),
    serverConfigFingerprint: cleanText(raw.serverConfigFingerprint, 96),
    transport: cleanText(raw.transport, 16),
    remoteTaskId,
    kind: raw.kind === 'receiver' || raw.kind === 'sampling' || raw.kind === 'elicitation' ? raw.kind : 'tool',
    toolName: cleanText(raw.toolName, 160),
    status,
    statusMessage: cleanText(raw.statusMessage, 500),
    createdAt,
    lastUpdatedAt,
    ttl: raw.ttl == null ? null : clampTtl(raw.ttl),
    pollInterval: clampPoll(raw.pollInterval),
    sessionBinding: cleanText(raw.sessionBinding, 96),
    sourceSessionIdHash: cleanText(raw.sourceSessionIdHash, 64),
    sourceProjectPathHash: cleanText(raw.sourceProjectPathHash, 64),
    persistedResult: persisted?.value,
    resultTruncated: raw.resultTruncated === true || persisted?.truncated === true,
    localDisposition: raw.localDisposition === 'abandoned' || raw.localDisposition === 'orphaned' || raw.localDisposition === 'claimed'
      ? raw.localDisposition : null,
    resultStored: raw.persistedResult !== undefined,
    resultMemory: undefined,
    client: null,
    timer: null,
    pollBusy: false,
    cancelUnavailable: true,
  };
}

function getDefaultSafeStorage() {
  try { return require('electron').safeStorage; } catch { return null; }
}

function createMcpTaskManager(options = {}) {
  const fsImpl = options.fs || fs;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const random = typeof options.randomRef === 'function' ? options.randomRef : randomRef;
  const safeStorage = options.safeStorage === undefined ? getDefaultSafeStorage() : options.safeStorage;
  const storePath = options.storePath || (options.userDataPath ? path.join(options.userDataPath, STORE_FILENAME) : '');
  const defaultTtlMs = clampTtl(options.defaultTtlMs);
  const records = new Map();
  const clients = new Map();
  const claims = new Map();
  const receivers = new Map();
  const listeners = new Set();
  let persistenceMode = 'memory';
  let storeError = null;
  let loaded = false;

  function emit(record, reason = 'updated') {
    const event = { type: 'mcp-task-updated', reason, ...publicTask(record) };
    for (const listener of listeners) {
      try { listener(event); } catch { /* listener isolation */ }
    }
    options.onEvent?.(event);
  }

  function persistenceAvailable() {
    try {
      return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
        && typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function');
    } catch { return false; }
  }

  function load() {
    if (loaded) return { ok: true, persistence: persistenceMode, error: storeError };
    loaded = true;
    if (!persistenceAvailable() || !storePath) {
      persistenceMode = 'memory';
      return { ok: true, persistence: persistenceMode };
    }
    persistenceMode = 'encrypted';
    if (!fsImpl.existsSync(storePath)) return { ok: true, persistence: persistenceMode };
    try {
      const envelope = JSON.parse(fsImpl.readFileSync(storePath, 'utf8'));
      if (envelope?.version !== STORE_VERSION || envelope?.cipher !== 'electron-safeStorage' || typeof envelope.payload !== 'string') {
        throw taskError('MCP_TASK_STORE_CORRUPT', 'MCP task store envelope invalid');
      }
      const plaintext = safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
      const parsed = JSON.parse(plaintext);
      if (!Array.isArray(parsed)) throw new Error('task store payload invalid');
      for (const item of parsed.slice(-MAX_HISTORY)) {
        const record = normalizeStored(item);
        if (record) records.set(record.localTaskRef, record);
      }
      return { ok: true, persistence: persistenceMode, count: records.size };
    } catch (error) {
      storeError = error?.code === 'MCP_TASK_STORE_CORRUPT'
        ? error
        : taskError('MCP_TASK_STORE_CORRUPT', 'MCP task store could not be decrypted');
      // Keep the original file untouched. The caller can surface the error and
      // explicitly decide whether to clear it later.
      return { ok: false, code: storeError.code, persistence: 'unavailable' };
    }
  }

  function save() {
    load();
    if (persistenceMode !== 'encrypted' || !storePath) return { ok: true, persistence: persistenceMode };
    const persistentRecords = [...records.values()].filter((record) => record.kind === 'tool');
    const data = JSON.stringify(persistentRecords.slice(-MAX_HISTORY).map(storedRecord));
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(data);
      fsImpl.mkdirSync(path.dirname(storePath), { recursive: true });
      const tempPath = `${storePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fsImpl.writeFileSync(tempPath, JSON.stringify({ version: STORE_VERSION, cipher: 'electron-safeStorage', payload: Buffer.from(encrypted).toString('base64') }), 'utf8');
        fsImpl.renameSync(tempPath, storePath);
      } catch (error) {
        try { fsImpl.unlinkSync(tempPath); } catch { /* best effort */ }
        throw error;
      }
      return { ok: true, persistence: persistenceMode };
    } catch (error) {
      storeError = taskError('MCP_TASK_STORE_UNAVAILABLE', 'MCP task store unavailable');
      options.onError?.(storeError);
      return { ok: false, code: storeError.code, persistence: 'unavailable' };
    }
  }

  function activeCount(serverName) {
    return [...records.values()].filter((record) => ACTIVE.has(record.status)
      && !stopsMonitoring(record) && (!serverName || record.serverName === serverName)).length;
  }

  function connectionHoldCount(serverName) {
    return [...records.values()].filter((record) => !record.connectionReleased
      && typeof record.releaseConnection === 'function'
      && !stopsMonitoring(record)
      && (ACTIVE.has(record.status) || record.status === 'completed')
      && (!serverName || record.serverName === serverName)).length;
  }

  function configBlockCount(serverName) {
    return [...records.values()].filter((record) => !stopsMonitoring(record)
      && (ACTIVE.has(record.status) || needsRecovery(record))
      && (!serverName || record.serverName === serverName)).length;
  }

  function cleanupHistory() {
    if (records.size <= MAX_HISTORY) return;
    const removable = [...records.values()]
      .filter((record) => TERMINAL.has(record.status) || record.localDisposition)
      .sort((a, b) => Date.parse(a.lastUpdatedAt) - Date.parse(b.lastUpdatedAt));
    while (records.size > MAX_HISTORY && removable.length) {
      const record = removable.shift();
      clearTimer(record);
      releaseConnection(record);
      records.delete(record.localTaskRef);
    }
  }

  function clearTimer(record) {
    if (record?.timer) clearTimeout(record.timer);
    if (record) record.timer = null;
  }

  function releaseConnection(record) {
    if (!record || record.connectionReleased) return;
    record.connectionReleased = true;
    Promise.resolve(record.releaseConnection?.()).catch(() => {});
  }

  function updateRecord(record, patch, reason = 'updated') {
    if (!record) throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    const nextStatus = patch.status == null ? record.status : String(patch.status);
    if (!STATUSES.has(nextStatus)) throw taskError('MCP_TASK_STATUS_INVALID', 'MCP task status invalid');
    if (nextStatus !== record.status) {
      const validTransition = ACTIVE.has(record.status) && (ACTIVE.has(nextStatus) || TERMINAL.has(nextStatus));
      if (!validTransition) throw taskError('MCP_TASK_STATUS_INVALID', 'MCP task status transition invalid');
    }
    if (patch.statusMessage !== undefined) record.statusMessage = cleanText(patch.statusMessage, 500);
    if (patch.pollInterval !== undefined) record.pollInterval = clampPoll(patch.pollInterval, record.pollInterval);
    if (patch.localDisposition !== undefined) record.localDisposition = patch.localDisposition || null;
    if (patch.result !== undefined) {
      const bounded = boundedJson(patch.result);
      record.resultMemory = bounded.value;
      record.persistedResult = bounded.value;
      record.resultStored = true;
      record.resultTruncated = bounded.truncated;
    }
    record.status = nextStatus;
    record.lastUpdatedAt = new Date(now()).toISOString();
    if (TERMINAL.has(nextStatus)) {
      clearTimer(record);
      // A completed task still needs its remote result fetched. Failed and
      // cancelled tasks can release their lease as soon as the transition is
      // recorded.
      if (nextStatus !== 'completed' || patch.result !== undefined) releaseConnection(record);
    }
    cleanupHistory();
    save();
    emit(record, reason);
    return record;
  }

  function taskPayload(result, fallbackTtl) {
    const task = result?.task && typeof result.task === 'object' ? result.task : null;
    if (!task || task.taskId == null) return null;
    const ttl = task.ttl == null ? fallbackTtl : clampTtl(task.ttl, fallbackTtl);
    const status = STATUSES.has(String(task.status || 'working')) ? String(task.status || 'working') : 'working';
    return {
      remoteTaskId: String(task.taskId),
      status,
      statusMessage: task.statusMessage,
      ttl,
      pollInterval: clampPoll(task.pollInterval, DEFAULT_POLL_MS),
    };
  }

  function createTask(input = {}) {
    load();
    const serverName = cleanText(input.serverName, 96);
    const remoteTaskId = String(input.remoteTaskId || '');
    if (!serverName || !remoteTaskId) throw taskError('MCP_TASK_INVALID', 'MCP task identity invalid');
    if (activeCount() >= MAX_ACTIVE || activeCount(serverName) >= MAX_ACTIVE_PER_SERVER) throw taskError('MCP_TASK_LIMIT', 'MCP task limit reached');
    const createdAt = new Date(now()).toISOString();
    const record = {
      localTaskRef: String(random('mcp_task')),
      serverName,
      serverConfigFingerprint: cleanText(input.serverConfigFingerprint, 96),
      transport: cleanText(input.transport, 16),
      remoteTaskId,
      kind: input.kind === 'receiver' || input.kind === 'sampling' || input.kind === 'elicitation' ? input.kind : 'tool',
      toolName: cleanText(input.toolName, 160),
      status: STATUSES.has(String(input.status || 'working')) ? String(input.status || 'working') : 'working',
      statusMessage: cleanText(input.statusMessage, 500),
      createdAt,
      lastUpdatedAt: createdAt,
      ttl: input.ttl == null ? defaultTtlMs : clampTtl(input.ttl, defaultTtlMs),
      pollInterval: clampPoll(input.pollInterval),
      sessionBinding: hashIdentity(input.sessionBinding),
      sourceSessionIdHash: hashIdentity(input.sourceSessionId),
      sourceProjectPathHash: hashIdentity(input.sourceProjectPath),
      persistedResult: undefined,
      resultTruncated: false,
      localDisposition: null,
      resultStored: false,
      resultMemory: undefined,
      client: input.client || null,
      execute: typeof input.execute === 'function' ? input.execute : null,
      cancelExecution: typeof input.cancelExecution === 'function' ? input.cancelExecution : null,
      releaseConnection: typeof input.releaseConnection === 'function' ? input.releaseConnection : null,
      connectionReleased: false,
      timer: null,
      pollBusy: false,
      cancelUnavailable: input.receiver !== true && !input.client,
      receiver: input.receiver === true,
    };
    records.set(record.localTaskRef, record);
    cleanupHistory();
    if (record.receiver && record.execute) {
      Promise.resolve().then(() => record.execute(record)).then(
        (result) => {
          if (!records.has(record.localTaskRef) || TERMINAL.has(record.status)) return;
          if (record.status === 'input_required') updateRecord(record, { status: 'working' }, 'receiver-resumed');
          updateRecord(record, { status: 'completed', result }, 'receiver-completed');
        },
        (error) => {
          if (!records.has(record.localTaskRef) || TERMINAL.has(record.status)) return;
          updateRecord(record, { status: 'failed', statusMessage: error?.code || 'MCP receiver failed' }, 'receiver-failed');
        },
      );
    }
    save();
    emit(record, 'created');
    if (!record.receiver && ACTIVE.has(record.status)) schedulePoll(record, 0);
    else if (!record.receiver && record.status === 'completed') Promise.resolve(fetchResult(record)).catch(() => {});
    return { taskRef: record.localTaskRef, task: publicTask(record) };
  }

  function registerToolTask(input = {}) {
    const payload = taskPayload(input.createResult, input.ttl == null ? defaultTtlMs : input.ttl);
    if (!payload) throw taskError('MCP_TASK_INVALID', 'MCP tools/call did not return a task');
    return createTask({ ...input, ...payload, kind: 'tool', receiver: false });
  }

  function registerReceiverTask(input = {}) {
    const remoteTaskId = input.remoteTaskId || input.taskId || random('receiver_task');
    return createTask({ ...input, remoteTaskId, kind: input.kind || 'receiver', receiver: true });
  }

  function receiverResult(input = {}) {
    const created = registerReceiverTask(input);
    const record = find(created.taskRef);
    return {
      taskRef: created.taskRef,
      task: {
        taskId: record.remoteTaskId,
        status: record.status,
        ttl: record.ttl,
        pollInterval: record.pollInterval,
      },
    };
  }

  function find(taskRef) {
    const record = records.get(String(taskRef || ''));
    if (!record) throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    return record;
  }

  function clientFor(record) {
    return record.client || clients.get(record.serverName) || options.getClient?.(record.serverName, record);
  }

  async function poll(record) {
    if (!record || record.pollBusy || !ACTIVE.has(record.status) || stopsMonitoring(record)) return publicTask(record);
    if (record.ttl != null && now() - Date.parse(record.createdAt) >= record.ttl) {
      updateRecord(record, { status: 'failed', statusMessage: 'MCP task TTL expired' }, 'ttl-expired');
      record.lastErrorCode = 'MCP_TASK_TTL_EXPIRED';
      return publicTask(record);
    }
    const client = clientFor(record);
    if (!client || typeof client.getTask !== 'function') {
      markOrphaned(record);
      return publicTask(record);
    }
    record.pollBusy = true;
    try {
      const remote = await client.getTask(record.remoteTaskId);
      const status = String(remote?.status || remote?.task?.status || record.status);
      const statusMessage = remote?.statusMessage || remote?.task?.statusMessage;
      const pollInterval = remote?.pollInterval || remote?.task?.pollInterval;
      if (STATUSES.has(status)) updateRecord(record, { status, statusMessage, pollInterval }, 'polled');
      if (record.status === 'input_required' || TERMINAL.has(record.status)) {
        await fetchResult(record, client);
      }
      if (ACTIVE.has(record.status) && !stopsMonitoring(record)) schedulePoll(record);
    } catch (error) {
      record.statusMessage = cleanText(error?.code || 'MCP task poll failed', 500);
      record.lastErrorCode = 'MCP_TASK_POLL_FAILED';
      record.lastUpdatedAt = new Date(now()).toISOString();
      save();
      emit(record, 'poll-failed');
      if (!stopsMonitoring(record)) schedulePoll(record, Math.min(MAX_POLL_MS, record.pollInterval * 2));
    } finally {
      record.pollBusy = false;
    }
    return publicTask(record);
  }

  async function fetchResult(record, client = clientFor(record)) {
    if (!client || typeof client.getTaskResult !== 'function') {
      if (TERMINAL.has(record?.status)) releaseConnection(record);
      return null;
    }
    try {
      const result = await client.getTaskResult(record.remoteTaskId);
      const bounded = boundedJson(result, MAX_PERSISTED_RESULT_BYTES);
      record.resultMemory = bounded.value;
      record.persistedResult = bounded.value;
      record.resultStored = true;
      record.resultTruncated = bounded.truncated;
      record.lastUpdatedAt = new Date(now()).toISOString();
      save();
      emit(record, 'result-updated');
      return bounded.value;
    } catch (error) {
      record.lastErrorCode = 'MCP_TASK_RESULT_UNAVAILABLE';
      record.statusMessage = cleanText(error?.code || 'MCP task result unavailable', 500);
      save();
      emit(record, 'result-failed');
      return null;
    } finally {
      if (TERMINAL.has(record.status)) releaseConnection(record);
    }
  }

  function schedulePoll(record, delay) {
    clearTimer(record);
    if (!record || !ACTIVE.has(record.status) || stopsMonitoring(record)) return;
    const wait = delay == null ? record.pollInterval : Math.max(0, Number(delay) || 0);
    record.timer = setTimeout(() => { record.timer = null; poll(record).catch(() => {}); }, wait);
    record.timer.unref?.();
  }

  function markOrphaned(record, options = {}) {
    if (!record || stopsMonitoring(record)) return;
    if (options.stopMonitoring !== false) {
      clearTimer(record);
      releaseConnection(record);
    }
    record.localDisposition = 'orphaned';
    record.lastUpdatedAt = new Date(now()).toISOString();
    save();
    emit(record, 'orphaned');
  }

  async function restore(context = {}) {
    load();
    const restored = [];
    for (const record of records.values()) {
      if (!needsRecovery(record)) continue;
      const sameSession = !record.sourceSessionIdHash
        || (context.sessionId && record.sourceSessionIdHash === hashIdentity(context.sessionId));
      const sameProject = !record.sourceProjectPathHash
        || (context.projectPath && record.sourceProjectPathHash === hashIdentity(context.projectPath));
      const resolvesFingerprint = typeof context.getConfigFingerprint === 'function';
      const expectedFingerprint = context.getConfigFingerprint?.(record.serverName, record);
      const sameConfig = resolvesFingerprint
        ? Boolean(expectedFingerprint)
          && (!record.serverConfigFingerprint || record.serverConfigFingerprint === String(expectedFingerprint))
        : true;
      const client = context.getClient?.(record.serverName, record) || clients.get(record.serverName);
      if (!sameConfig) {
        record.cancelUnavailable = true;
        markOrphaned(record);
        continue;
      }
      if (!client) {
        record.cancelUnavailable = true;
        if (!resolvesFingerprint) markOrphaned(record);
        else {
          clearTimer(record);
          record.statusMessage = 'MCP task recovery connection unavailable';
          record.lastUpdatedAt = new Date(now()).toISOString();
          save();
          emit(record, 'recovery-unavailable');
        }
        continue;
      }
      record.client = client;
      record.cancelUnavailable = false;
      if (typeof context.releaseConnection === 'function') {
        record.releaseConnection = () => context.releaseConnection(record.serverName, record);
        record.connectionReleased = false;
      }
      if (!sameSession || !sameProject) markOrphaned(record, { stopMonitoring: false });
      restored.push(record.localTaskRef);
      if (ACTIVE.has(record.status)) schedulePoll(record, 0);
      else Promise.resolve(fetchResult(record, client)).catch(() => {});
    }
    save();
    return restored.map((taskRef) => publicTask(records.get(taskRef)));
  }

  function recoveryServerNames(getConfigFingerprint) {
    load();
    if (typeof getConfigFingerprint !== 'function') return [];
    const names = new Set();
    for (const record of records.values()) {
      if (!needsRecovery(record)) continue;
      const expected = getConfigFingerprint(record.serverName, record);
      if (!expected) continue;
      if (!record.serverConfigFingerprint || record.serverConfigFingerprint === String(expected)) {
        names.add(record.serverName);
      }
    }
    return [...names];
  }

  async function cancel(taskRef, options = {}) {
    const record = find(taskRef);
    if (record.localDisposition === 'abandoned') return publicTask(record);
    if (TERMINAL.has(record.status)) {
      releaseConnection(record);
      return publicTask(record);
    }
    const client = clientFor(record);
    if (!options.localOnly && !record.receiver) {
      if (!client || typeof client.cancelTask !== 'function') {
        throw taskError('MCP_TASK_CANCEL_FAILED', 'MCP task cancellation is unavailable');
      }
      try { await client.cancelTask(record.remoteTaskId); } catch (error) {
        throw taskError('MCP_TASK_CANCEL_FAILED', 'MCP task cancellation failed');
      }
    }
    try { await record.cancelExecution?.(); } catch { /* cancellation remains local */ }
    updateRecord(record, { status: 'cancelled' }, options.localOnly ? 'cancelled-local' : 'cancelled');
    return publicTask(record);
  }

  function abandon(taskRef) {
    const record = find(taskRef);
    clearTimer(record);
    record.localDisposition = 'abandoned';
    releaseConnection(record);
    record.lastUpdatedAt = new Date(now()).toISOString();
    save();
    emit(record, 'abandoned');
    return publicTask(record);
  }

  function matchesContext(record, filter = {}) {
    if (Object.prototype.hasOwnProperty.call(filter, 'sourceSessionId')
      && record.sourceSessionIdHash !== hashIdentity(filter.sourceSessionId)) return false;
    if (Object.prototype.hasOwnProperty.call(filter, 'sourceProjectPath')
      && record.sourceProjectPathHash !== hashIdentity(filter.sourceProjectPath)) return false;
    return true;
  }

  function list(filter = {}) {
    load();
    return [...records.values()]
      .filter((record) => !filter.server || record.serverName === String(filter.server))
      .filter((record) => matchesContext(record, filter))
      .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
      .slice(0, Math.min(MAX_HISTORY, Number(filter.limit) > 0 ? Math.floor(Number(filter.limit)) : MAX_HISTORY))
      .map(publicTask);
  }

  function get(taskRef) { load(); return publicTask(find(taskRef)); }

  function getForContext(taskRef, context = {}) {
    load();
    const record = find(taskRef);
    if (!matchesContext(record, { sourceSessionId: context.sessionId, sourceProjectPath: context.projectPath })) {
      throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    }
    return publicTask(record);
  }

  async function result(taskRef) {
    const record = find(taskRef);
    if (record.resultMemory !== undefined) return boundedJson(record.resultMemory, MAX_PUBLIC_RESULT_BYTES).value;
    if (record.persistedResult !== undefined) return boundedJson(record.persistedResult, MAX_PUBLIC_RESULT_BYTES).value;
    if (record.status === 'completed' || record.status === 'input_required') return fetchResult(record);
    throw taskError('MCP_TASK_RESULT_UNAVAILABLE', 'MCP task result unavailable');
  }

  async function resultForContext(taskRef, context = {}) {
    const record = find(taskRef);
    if (!matchesContext(record, { sourceSessionId: context.sessionId, sourceProjectPath: context.projectPath })) {
      throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    }
    return result(record.localTaskRef);
  }

  async function prepareResultClaim(taskRef, targetSessionId) {
    const record = find(taskRef);
    if (record.status !== 'completed'
      || (record.localDisposition && record.localDisposition !== 'orphaned')) {
      throw taskError('MCP_TASK_CLAIM_INVALID', 'MCP task cannot be claimed');
    }
    const value = await result(taskRef);
    if (value === undefined || value === null) throw taskError('MCP_TASK_RESULT_UNAVAILABLE', 'MCP task result unavailable');
    const claimId = randomRef('mcp_claim');
    claims.set(claimId, { taskRef: record.localTaskRef, targetSessionId: String(targetSessionId || ''), expiresAt: now() + 5 * 60 * 1000 });
    return { ok: true, claimId, task: publicTask(record), targetSessionId: String(targetSessionId || ''), preview: boundedJson(value, MAX_PUBLIC_RESULT_BYTES).value };
  }

  async function commitResultClaim(claimId, targetSessionId) {
    const claim = claims.get(String(claimId || ''));
    claims.delete(String(claimId || ''));
    if (!claim || claim.expiresAt < now() || claim.targetSessionId !== String(targetSessionId || '')) throw taskError('MCP_TASK_CLAIM_INVALID', 'MCP task claim invalid');
    const record = find(claim.taskRef);
    if (record.status !== 'completed'
      || (record.localDisposition && record.localDisposition !== 'orphaned')) {
      throw taskError('MCP_TASK_CLAIM_INVALID', 'MCP task was already claimed');
    }
    const value = await result(record.localTaskRef);
    record.localDisposition = 'claimed';
    record.lastUpdatedAt = new Date(now()).toISOString();
    save();
    emit(record, 'claimed');
    return { ok: true, taskRef: record.localTaskRef, targetSessionId: claim.targetSessionId, result: boundedJson(value, MAX_PUBLIC_RESULT_BYTES).value };
  }

  async function cancelForContext(taskRef, context = {}) {
    const record = find(taskRef);
    if (!matchesContext(record, { sourceSessionId: context.sessionId, sourceProjectPath: context.projectPath })) {
      throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    }
    return cancel(record.localTaskRef);
  }

  function registerClient(serverName, client, options = {}) {
    if (!serverName || !client) return 0;
    const name = String(serverName);
    clients.set(name, client);
    if (options.recover !== true) return 0;
    const expectedFingerprint = options.serverConfigFingerprint == null
      ? '' : String(options.serverConfigFingerprint);
    let attached = 0;
    for (const record of records.values()) {
      if (!needsRecovery(record) || record.serverName !== name) continue;
      if (expectedFingerprint && record.serverConfigFingerprint
        && record.serverConfigFingerprint !== expectedFingerprint) {
        markOrphaned(record);
        continue;
      }
      record.client = client;
      record.cancelUnavailable = false;
      if (typeof options.releaseConnection === 'function') {
        record.releaseConnection = options.releaseConnection;
        record.connectionReleased = false;
      }
      const sameSession = !record.sourceSessionIdHash
        || (options.sessionId && record.sourceSessionIdHash === hashIdentity(options.sessionId));
      const sameProject = !record.sourceProjectPathHash
        || (options.projectPath && record.sourceProjectPathHash === hashIdentity(options.projectPath));
      if (!sameSession || !sameProject) markOrphaned(record, { stopMonitoring: false });
      attached += 1;
      if (ACTIVE.has(record.status)) schedulePoll(record, 0);
      else Promise.resolve(fetchResult(record, client)).catch(() => {});
    }
    if (attached) save();
    return attached;
  }

  function notifyTaskStatus(serverName, params = {}) {
    const remoteId = String(params.taskId || params.task?.taskId || '');
    const record = [...records.values()].find((item) => item.serverName === String(serverName || '') && item.remoteTaskId === remoteId);
    if (!record) return false;
    if (STATUSES.has(String(params.status || ''))) updateRecord(record, { status: String(params.status), statusMessage: params.statusMessage, pollInterval: params.pollInterval }, 'notification');
    if (record.status === 'input_required' || TERMINAL.has(record.status)) Promise.resolve(fetchResult(record)).catch(() => {});
    if (ACTIVE.has(record.status)) schedulePoll(record, 0);
    return true;
  }

  async function handleTaskRequest(serverName, method, params = {}) {
    const remoteId = String(params.taskId || '');
    if (method === 'tasks/list') {
      return { tasks: [...receivers.values()].filter((item) => item.serverName === String(serverName || '')).map((item) => ({ taskId: item.remoteTaskId, status: item.status, statusMessage: item.statusMessage || undefined })) };
    }
    const record = [...receivers.values()].find((item) => item.serverName === String(serverName || '') && item.remoteTaskId === remoteId);
    if (!record) throw taskError('MCP_TASK_NOT_FOUND', 'MCP task not found');
    if (method === 'tasks/get') return { taskId: record.remoteTaskId, status: record.status, statusMessage: record.statusMessage || undefined, ttl: record.ttl, pollInterval: record.pollInterval };
    if (method === 'tasks/result') return { taskId: record.remoteTaskId, status: record.status, result: await result(record.localTaskRef) };
    if (method === 'tasks/cancel') { await cancel(record.localTaskRef, { localOnly: true }); return { taskId: record.remoteTaskId, status: 'cancelled' }; }
    throw taskError('MCP_METHOD_NOT_FOUND', 'MCP method not found');
  }

  function addReceiver(record) { receivers.set(record.localTaskRef, record); }

  load();
  return {
    createTask,
    registerToolTask,
    registerReceiverTask: (input) => { const created = registerReceiverTask(input); addReceiver(find(created.taskRef)); return created; },
    receiverResult: (input) => { const created = receiverResult(input); addReceiver(find(created.taskRef)); return created; },
    get,
    getForContext,
    list,
    result,
    resultForContext,
    poll: (taskRef) => poll(find(taskRef)),
    restore,
    recoveryServerNames,
    cancel,
    cancelForContext,
    abandon,
    prepareResultClaim,
    commitResultClaim,
    registerClient,
    notifyTaskStatus,
    handleTaskRequest,
    onEvent(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    save,
    load,
    close() { for (const record of records.values()) clearTimer(record); claims.clear(); receivers.clear(); clients.clear(); },
    hasActiveTasks(serverName) { return activeCount(serverName); },
    hasConnectionHoldingTasks(serverName) { return connectionHoldCount(serverName) > 0; },
    canChangeServer(serverName) { return configBlockCount(serverName) === 0; },
    persistence: () => ({ mode: persistenceMode, error: storeError?.code || null }),
    constants: { DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, MIN_POLL_MS, MAX_POLL_MS, MAX_ACTIVE_PER_SERVER, MAX_ACTIVE, MAX_HISTORY, MAX_PERSISTED_RESULT_BYTES },
  };
}

module.exports = {
  STORE_VERSION,
  STORE_FILENAME,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  MAX_ACTIVE_PER_SERVER,
  MAX_ACTIVE,
  MAX_HISTORY,
  MAX_PERSISTED_RESULT_BYTES,
  taskError,
  clampTtl,
  clampPoll,
  boundedJson,
  publicTask,
  createMcpTaskManager,
};
