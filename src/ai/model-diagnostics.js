'use strict';

const { isResolvedModelBinding } = require('./model-profiles');
const { invokeModelTurn } = require('./model-router');
const { publicModelSource } = require('./model-runtime');
const { normalizeModelUsage } = require('./usage');
const { TaskHandle, TASK_KINDS } = require('./task-contract');
const { publicModelError } = require('./model-errors');
const { ModelError } = require('./model-adapters/common');

const DIAGNOSTIC_LIMITS = Object.freeze({ timeoutMs: 15000, maxOutputTokens: 128, maxResponseBytes: 262144, maxRequests: 5 });
const DIAGNOSTIC_CHECKS = Object.freeze(['text', 'streaming', 'usage', 'nativeTools']);
const DIAGNOSTIC_SYNTHETIC_TEXT = 'SYNTHETIC_DIAGNOSTIC_OK';
const DIAGNOSTIC_MESSAGES = Object.freeze({
  DIAGNOSTIC_TIMEOUT: 'The model diagnostic exceeded its deadline.',
  DIAGNOSTIC_RESPONSE_LIMIT: 'The model diagnostic exceeded its response limit.',
  DIAGNOSTIC_REQUEST_LIMIT: 'The model diagnostic exceeded its request limit.',
  DIAGNOSTIC_PROTOCOL_ERROR: 'The model diagnostic response could not be validated.',
  DIAGNOSTIC_INCONCLUSIVE: 'The model diagnostic did not confirm the selected capabilities.',
  DIAGNOSTIC_APPLY_FAILED: 'The model diagnostic observations could not be saved.',
  DIAGNOSTIC_REQUEST_FAILED: 'The model diagnostic request could not be completed.',
  DIAGNOSTIC_STALE: 'The model diagnostic result belongs to a different model configuration.',
});
const PUBLIC_ERROR_FIELDS = Object.freeze(['code', 'safeMessage', 'retryable', 'httpStatus', 'requestId', 'retryAfterMs']);
const ERROR_PROJECTIONS = new WeakMap();
const STOP_CODES = new Set(['MODEL_TIMEOUT', 'MODEL_LIMIT_EXCEEDED', 'DIAGNOSTIC_TIMEOUT', 'DIAGNOSTIC_RESPONSE_LIMIT', 'DIAGNOSTIC_REQUEST_LIMIT']);
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'filtered', 'unknown']);

function fail(code) { return Object.assign(new Error(code), { code }); }
function ownValue(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { const property = Object.getOwnPropertyDescriptor(value, key); return property && Object.hasOwn(property, 'value') ? property.value : undefined; }
  catch { return undefined; }
}
function safeCode(error) {
  const code = ownValue(error, 'code');
  // Internal aliases own cancellation/stop decisions only. Every public code is
  // independently canonicalized below, including previously unlisted adapters.
  return typeof code === 'string' && (code === 'ABORTED' || /^MODEL_[A-Z0-9_]{1,58}$/.test(code) || Object.hasOwn(DIAGNOSTIC_MESSAGES, code)) ? code : 'DIAGNOSTIC_REQUEST_FAILED';
}
function diagnosticPublicError(error, overrideCode) {
  const code = overrideCode || safeCode(error);
  const saved = ERROR_PROJECTIONS.get(error);
  if (saved && code === safeCode(error)) return saved;
  const input = code === ownValue(error, 'code') ? error : fail(code);
  const business = Object.hasOwn(DIAGNOSTIC_MESSAGES, code) ? { preserveCodes: [code], safeMessage: DIAGNOSTIC_MESSAGES[code] } : {};
  // Diagnostic requests never expose upstream output or error-owned provenance,
  // even when the general public model DTO permits these fields for chat runs.
  const projected = publicModelError(input, { ...business, partialOutput: '', modelSource: {} });
  return Object.fromEntries(PUBLIC_ERROR_FIELDS.filter(key => projected[key] !== undefined).map(key => [key, projected[key]]));
}
function diagnosticFailure(code, error) {
  const failure = fail(code);
  ERROR_PROJECTIONS.set(failure, diagnosticPublicError(error || failure, code));
  return failure;
}
function identity(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function observe(callback, ...args) {
  if (typeof callback !== 'function') return;
  try { Promise.resolve(callback(...args)).catch(() => {}); } catch { /* Observers cannot own task cleanup. */ }
}
function blankChecks() {
  return Object.fromEntries(DIAGNOSTIC_CHECKS.map(check => [check, { state: 'not-tested', capability: 'unknown', checkedAt: null, code: null }]));
}
function copyChecks(checks, stale = false) {
  return Object.fromEntries(DIAGNOSTIC_CHECKS.map(check => {
    const entry = checks[check];
    return [check, stale && entry.capability === 'supported'
      ? { ...entry, state: 'unknown', capability: 'unknown', code: 'DIAGNOSTIC_STALE' }
      : { ...entry }];
  }));
}
function publicChecks(checks, stale = false) {
  return Object.fromEntries(Object.entries(copyChecks(checks, stale)).map(([check, entry]) => {
    const error = entry.code ? (entry.code === 'DIAGNOSTIC_STALE' ? diagnosticPublicError(fail(entry.code)) : entry.publicError || diagnosticPublicError(fail(entry.code))) : null;
    return [check, { state: entry.state, capability: entry.capability, checkedAt: entry.checkedAt, code: null, ...(error || {}) }];
  }));
}
function reliableEmptyUsage(error) {
  try { if (!(error instanceof ModelError) || ownValue(error, 'code') !== 'MODEL_EMPTY_RESPONSE') return null; }
  catch { return null; }
  const raw = ownValue(error, 'usage');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ownValue(raw, 'source') !== 'actual') return null;
  const usage = { source: 'actual' };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens']) {
    const value = ownValue(raw, key);
    if ((key === 'cachedInputTokens' || key === 'cacheCreationInputTokens') && value == null) usage[key] = null;
    else if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    else return null;
  }
  if ((usage.cachedInputTokens || 0) + (usage.cacheCreationInputTokens || 0) > usage.inputTokens) return null;
  return usage;
}
function messagesFor(check) {
  return [
    { role: 'system', content: 'This is an isolated synthetic model capability check. Do not access files, projects, memory, services or other tools.' },
    { role: 'user', content: check === 'nativeTools'
      ? `Call synthetic_echo exactly once with text ${DIAGNOSTIC_SYNTHETIC_TEXT}. After its result, reply with exactly that text.`
      : `Reply with exactly ${DIAGNOSTIC_SYNTHETIC_TEXT}.` }
  ];
}
function syntheticTools(check) {
  return check === 'nativeTools' ? [{
    name: 'synthetic_echo', description: 'Return the fixed synthetic diagnostic token; no external effects.',
    parameters: { type: 'object', properties: { text: { type: 'string', enum: [DIAGNOSTIC_SYNTHETIC_TEXT] } }, required: ['text'], additionalProperties: false }
  }] : [];
}
function completeText(result) {
  return result?.finishReason === 'stop' && typeof result.content === 'string' && result.content.trim().length > 0
    && (!result.toolCalls || (Array.isArray(result.toolCalls) && result.toolCalls.length === 0));
}
function validEchoCall(result) {
  if (result?.finishReason !== 'tool_calls' || !Array.isArray(result.toolCalls) || result.toolCalls.length !== 1) return null;
  const call = result.toolCalls[0];
  if (typeof result.content !== 'string' || typeof call?.id !== 'string' || !call.id.length || call.id.length > 128 || call.name !== 'synthetic_echo' || typeof call.argumentsJson !== 'string' || Buffer.byteLength(call.argumentsJson) > 1024) return null;
  try {
    const args = JSON.parse(call.argumentsJson);
    if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length !== 1 || args.text !== DIAGNOSTIC_SYNTHETIC_TEXT) return null;
  } catch { return null; }
  // The schema is validated above; preserve accepted bytes for Responses' private
  // continuation history. Re-serializing valid JSON would invalidate that token.
  return { id: call.id, name: 'synthetic_echo', argumentsJson: call.argumentsJson };
}

/** Explicit, background-only diagnosis. It never owns foreground chat or executes host tools. */
function createModelDiagnosticService(options = {}) {
  if (!options || typeof options !== 'object' || (options.invoke !== undefined && typeof options.invoke !== 'function')) throw fail('MODEL_DIAGNOSTIC_INPUT_INVALID');
  const invoke = options.invoke || invokeModelTurn;
  const records = new Map();
  const active = new Map();
  const latest = new Map();
  let closed = false;
  let closing;

  function publicTaskSummary(record) {
    const summary = record.task.toSummary();
    if (summary.error) summary.error = summary.error === record.code && record.publicError ? record.publicError.code : diagnosticPublicError(fail(summary.error)).code;
    return summary;
  }
  function snapshot(record, type, extra = {}) {
    const code = Object.hasOwn(extra, 'code') ? extra.code : record.code;
    const error = code ? (code === record.code && record.publicError ? record.publicError : diagnosticPublicError(fail(code))) : null;
    return freeze({
      ...(type ? { type } : {}), state: record.state, diagnosticId: record.binding.runId,
      runId: record.binding.runId, sessionId: record.binding.sessionId, clientRequestId: record.binding.clientRequestId,
      modelProfileId: record.binding.modelProfileId, bindingRevision: record.binding.bindingRevision,
      modelSource: record.modelSource, startedAt: record.startedAt, completedAt: record.completedAt, requestCount: record.attempts.size,
      ...extra, task: publicTaskSummary(record), checks: publicChecks(extra.checks || record.checks, record.state === 'stale'), code: null, ...(error || {})
    });
  }
  function emit(record, type, extra) { observe(options.onEvent, record.sender, snapshot(record, type, extra)); }
  function stop(record, code) {
    record.stopCode = record.stopCode || code;
    if (!record.task.signal.aborted) record.task.abortController.abort(fail(record.stopCode));
  }
  function checkStopped(record) {
    if (record.cancelRequested) throw fail('ABORTED');
    if (record.stopCode) throw fail(record.stopCode);
  }
  function attempt(record, raw, status) {
    const attemptId = ownValue(raw, 'attemptId');
    if (!identity(attemptId) || record.attempts.has(attemptId)) return false;
    record.attempts.add(attemptId);
    const failedActual = status === 'failed' && !record.cancelRequested && !record.stopCode ? reliableEmptyUsage(raw) : null;
    const item = freeze({
      attemptId, status, finishReason: status === 'completed' && FINISH_REASONS.has(raw.finishReason) ? raw.finishReason : null,
      usage: normalizeModelUsage(status === 'completed' ? raw.usage : failedActual || { source: 'unavailable' }), modelSource: record.modelSource
    });
    observe(options.onUsage, { binding: record.binding, attempt: item });
    emit(record, 'usage', { attempt: item });
    return true;
  }
  async function request(record, check, deadlineAt, messages, providerState) {
    checkStopped(record);
    if (++record.invocations > DIAGNOSTIC_LIMITS.maxRequests) { stop(record, 'DIAGNOSTIC_REQUEST_LIMIT'); checkStopped(record); }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) { stop(record, 'DIAGNOSTIC_TIMEOUT'); checkStopped(record); }
    let delta = false;
    let deltaBytes = 0;
    let result;
    try {
      result = await invoke({
        binding: record.binding, purpose: 'diagnostic', diagnosticCheck: check,
        request: { maxOutputTokens: DIAGNOSTIC_LIMITS.maxOutputTokens, timeoutMs: Math.min(DIAGNOSTIC_LIMITS.timeoutMs, remaining), deadlineAt,
          maxResponseBytes: DIAGNOSTIC_LIMITS.maxResponseBytes, maxFrameBytes: DIAGNOSTIC_LIMITS.maxResponseBytes },
        messages, tools: syntheticTools(check), signal: record.task.signal, resolveCredential: options.resolveCredential,
        ...(providerState === undefined ? {} : { providerState }),
        onEvent(event) {
          if (record.cancelRequested || record.stopCode || event?.type !== 'text-delta' || typeof event.delta !== 'string') return;
          deltaBytes += Buffer.byteLength(event.delta);
          if (deltaBytes > DIAGNOSTIC_LIMITS.maxResponseBytes) { stop(record, 'DIAGNOSTIC_RESPONSE_LIMIT'); return; }
          if (event.delta.length) delta = true;
        }
      });
      if (typeof result?.content === 'string' && Buffer.byteLength(result.content) > DIAGNOSTIC_LIMITS.maxResponseBytes) stop(record, 'DIAGNOSTIC_RESPONSE_LIMIT');
      checkStopped(record);
      if (!identity(result?.attemptId) || record.attempts.has(result.attemptId)) throw fail('DIAGNOSTIC_PROTOCOL_ERROR');
      attempt(record, result, 'completed');
      return { result, delta };
    } catch (error) {
      attempt(record, result || error, record.cancelRequested ? 'cancelled' : 'failed');
      const code = record.cancelRequested ? 'ABORTED' : record.stopCode || safeCode(error);
      if (STOP_CODES.has(code)) stop(record, code);
      throw diagnosticFailure(code, error);
    }
  }
  async function runCheck(record, check) {
    const deadlineAt = Date.now() + DIAGNOSTIC_LIMITS.timeoutMs;
    const timer = setTimeout(() => stop(record, 'DIAGNOSTIC_TIMEOUT'), DIAGNOSTIC_LIMITS.timeoutMs);
    record.checks[check] = { state: 'running', capability: 'unknown', checkedAt: null, code: null };
    emit(record, 'check', { check });
    try {
      const first = await request(record, check, deadlineAt, messagesFor(check));
      let supported = false;
      if (check === 'nativeTools') {
        const call = validEchoCall(first.result);
        if (call) {
          checkStopped(record);
          const second = await request(record, check, deadlineAt, [
            ...messagesFor(check),
            { role: 'assistant', content: first.result.content, toolCalls: [call] },
            { role: 'tool', content: DIAGNOSTIC_SYNTHETIC_TEXT, toolCallId: call.id }
          ], first.result.providerState);
          supported = completeText(second.result) && second.result.content.trim() === DIAGNOSTIC_SYNTHETIC_TEXT;
        }
      } else if (check === 'usage') {
        const usage = normalizeModelUsage(first.result.usage);
        supported = completeText(first.result) && usage.source === 'actual' && usage.inputTokens !== null && usage.outputTokens !== null;
      } else supported = completeText(first.result) && (check !== 'streaming' || first.delta);
      checkStopped(record);
      record.checks[check] = { state: supported ? 'passed' : 'unknown', capability: supported ? 'supported' : 'unknown', checkedAt: new Date().toISOString(), code: supported ? null : 'DIAGNOSTIC_INCONCLUSIVE' };
    } catch (error) {
      const code = record.cancelRequested ? 'ABORTED' : record.stopCode || safeCode(error);
      const failure = diagnosticFailure(code, error);
      record.checks[check] = { state: record.cancelRequested ? 'cancelled' : 'failed', capability: 'unknown', checkedAt: new Date().toISOString(), code, publicError: ERROR_PROJECTIONS.get(failure) };
      if (record.cancelRequested || STOP_CODES.has(code)) throw failure;
      // No current router error proves upstream capability rejection. HTTP 400 and
      // MODEL_CAPABILITY_REQUIRED are deliberately not converted to unsupported.
    } finally { clearTimeout(timer); }
    emit(record, 'check', { check });
  }
  async function execute(record) {
    let terminalType = 'done';
    try {
      checkStopped(record);
      emit(record, 'start');
      for (const check of record.selected) { checkStopped(record); await runCheck(record, check); }
      checkStopped(record);
      const observations = Object.fromEntries(record.selected.filter(check => record.checks[check].capability === 'supported')
        .map(check => [check, { state: 'supported', checkedAt: record.checks[check].checkedAt }]));
      let applied;
      if (Object.keys(observations).length && typeof options.applyResult === 'function') {
        try {
          applied = await options.applyResult({ modelProfileId: record.binding.modelProfileId, bindingRevision: record.binding.bindingRevision,
            observations: freeze(observations), startedAt: record.startedAt, expectedDeclarations: record.binding.modelProfile.capabilities });
        } catch { throw fail('DIAGNOSTIC_APPLY_FAILED'); }
      }
      checkStopped(record);
      if (applied?.stale === true || applied?.state === 'stale' || (applied?.applied === false && applied?.reason === 'stale')) {
        record.state = 'stale'; record.code = 'DIAGNOSTIC_STALE'; record.task.complete();
      } else if (record.selected.every(check => record.checks[check].capability === 'supported')) {
        record.state = 'passed'; record.task.complete();
      } else {
        record.state = 'failed'; record.code = 'DIAGNOSTIC_INCONCLUSIVE'; record.task.fail(fail(record.code));
      }
    } catch (error) {
      if (record.cancelRequested) {
        record.state = 'cancelled'; record.code = 'ABORTED'; terminalType = 'cancelled';
        record.publicError = diagnosticPublicError(fail(record.code));
        if (!record.task.isTerminal()) record.task.cancel();
      } else {
        record.state = 'failed'; record.code = record.stopCode || safeCode(error); terminalType = 'error';
        record.publicError = diagnosticPublicError(error, record.code);
        if (!record.task.isTerminal()) record.task.fail(fail(record.code));
      }
    } finally {
      record.completedAt = new Date().toISOString();
      active.delete(record.binding.runId);
      observe(options.onRelease, record.binding);
      emit(record, terminalType);
      record.resolve(snapshot(record));
    }
  }

  function start(input = {}) {
    if (closed) throw fail('DIAGNOSTIC_SERVICE_CLOSED');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['binding', 'sender', 'checks'].includes(key))) throw fail('MODEL_DIAGNOSTIC_INPUT_INVALID');
    const { binding, sender, checks = DIAGNOSTIC_CHECKS } = input;
    if (!isResolvedModelBinding(binding)) throw fail('MODEL_BINDING_INVALID');
    if (binding.kind !== 'model-diagnostic' || !identity(binding.runId) || !identity(binding.sessionId) || !identity(binding.clientRequestId)) throw fail('MODEL_DIAGNOSTIC_INPUT_INVALID');
    let destroyed = false;
    try { destroyed = typeof sender?.isDestroyed === 'function' && sender.isDestroyed(); } catch { destroyed = true; }
    if (!sender || sender.id == null || sender.id !== binding.senderId || destroyed) throw fail('MODEL_SENDER_MISMATCH');
    if (!Array.isArray(checks) || !checks.length || checks.some(check => !DIAGNOSTIC_CHECKS.includes(check)) || new Set(checks).size !== checks.length) throw fail('MODEL_DIAGNOSTIC_INPUT_INVALID');
    if (active.has(binding.runId) || [...active.values()].some(record => record.binding.modelProfileId === binding.modelProfileId)) throw fail('CONFIG_IN_USE');
    if (records.has(binding.runId)) throw fail('DIAGNOSTIC_ID_CONFLICT');
    const task = new TaskHandle({ taskId: binding.runId, kind: TASK_KINDS.MODEL_DIAGNOSTIC, sessionId: binding.sessionId, ownerId: binding.senderId }).start();
    const record = { binding, sender, task, modelSource: publicModelSource(binding), selected: DIAGNOSTIC_CHECKS.filter(check => checks.includes(check)), checks: blankChecks(),
      state: 'running', code: null, publicError: null, cancelRequested: false, stopCode: null, attempts: new Set(), invocations: 0, startedAt: new Date().toISOString(), completedAt: null };
    record.done = new Promise(resolve => { record.resolve = resolve; });
    records.set(binding.runId, record); active.set(binding.runId, record); latest.set(binding.modelProfileId, record);
    observe(options.onRetain, binding);
    setImmediate(() => { void execute(record); });
    return freeze({ ok: true, accepted: true, diagnosticId: binding.runId, runId: binding.runId, sessionId: binding.sessionId,
      clientRequestId: binding.clientRequestId, task: task.toSummary(), modelSource: record.modelSource });
  }
  function cancel(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return freeze({ ok: false, code: 'DIAGNOSTIC_NOT_RUNNING' });
    const { senderId, diagnosticId, sessionId, runId, clientRequestId } = input;
    const record = active.get(diagnosticId);
    if (!record || senderId !== record.binding.senderId || (sessionId !== undefined && sessionId !== record.binding.sessionId)
      || (runId !== undefined && runId !== record.binding.runId) || (clientRequestId !== undefined && clientRequestId !== record.binding.clientRequestId)) return freeze({ ok: false, code: 'DIAGNOSTIC_NOT_RUNNING' });
    record.cancelRequested = true; record.state = 'cancelled'; record.code = 'ABORTED'; record.publicError = diagnosticPublicError(fail(record.code)); record.task.cancel();
    return freeze({ ok: true, cancelled: true, diagnosticId, runId: record.binding.runId, sessionId: record.binding.sessionId, clientRequestId: record.binding.clientRequestId, task: record.task.toSummary() });
  }
  function cancelWhere(predicate) {
    let count = 0;
    for (const record of active.values()) if (predicate(record.binding)) { cancel({ senderId: record.binding.senderId, diagnosticId: record.binding.runId }); count++; }
    return count;
  }
  function getState(modelProfileId, bindingRevision) {
    const record = latest.get(modelProfileId);
    if (!record) return freeze({ state: 'not-tested', modelProfileId, bindingRevision, diagnosticId: null, runId: null, sessionId: null, clientRequestId: null, modelSource: null, task: null, checks: blankChecks(), code: null });
    if (bindingRevision !== undefined && bindingRevision !== record.binding.bindingRevision) return snapshot(record, undefined,
      { state: 'stale', code: 'DIAGNOSTIC_STALE', checks: copyChecks(record.checks, true), requestedBindingRevision: bindingRevision });
    return snapshot(record);
  }
  function isInUse(query = {}) {
    const keys = ['providerId', 'modelProfileId', 'assistantId', 'senderId', 'sessionId', 'runId', 'clientRequestId'];
    const selected = keys.filter(key => query && Object.prototype.hasOwnProperty.call(query, key));
    return selected.length > 0 && [...active.values()].some(record => selected.every(key => record.binding[key] === query[key]));
  }
  return Object.freeze({
    start, cancel, getState, isInUse,
    cancelOwner: id => cancelWhere(binding => binding.senderId === id),
    cancelProvider: id => cancelWhere(binding => binding.providerId === id),
    wait(diagnosticId) { const record = records.get(diagnosticId); return record ? record.done : Promise.resolve(null); },
    close() {
      if (!closing) { closed = true; cancelWhere(() => true); closing = Promise.all([...active.values()].map(record => record.done)); }
      return closing;
    },
    get activeBindings() { return Object.freeze([...active.values()].map(record => record.binding)); }
  });
}

module.exports = { createModelDiagnosticService, DIAGNOSTIC_LIMITS, DIAGNOSTIC_CHECKS, DIAGNOSTIC_SYNTHETIC_TEXT };
