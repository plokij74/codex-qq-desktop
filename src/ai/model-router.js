'use strict';

const { randomUUID } = require('node:crypto');
const { isResolvedModelBinding, normalizeModelEndpoint } = require('./model-profiles');
const { getModelAdapter } = require('./model-adapters');
const { LIMITS, ModelError, requireValue, record, bytes, boundedInteger, unavailableUsage, normalizeUsage, normalizeMessages, normalizeTools, validateToolCalls, safeError } = require('./model-adapters/common');
const { createRequestContext } = require('./model-adapters/transport');
const { publicModelSource } = require('./model-runtime');
const { createModelOperationBudget, assertModelOperationBudget, modelOperationContextLimit, measureModelJson } = require('./model-operation-budget');
const capability = (binding, name) => binding.capabilities?.[name]?.state || 'unknown';

function requireCapability(condition, binding, name, message, forcedState) {
  if (condition) return;
  const state = forcedState || capability(binding, name);
  const error = new ModelError('MODEL_CAPABILITY_REQUIRED', message);
  error.capabilityState = state === 'unsupported' ? 'unsupported' : 'unknown';
  error.publicCode = error.capabilityState === 'unsupported' ? 'MODEL_CAPABILITY_UNSUPPORTED' : 'MODEL_CAPABILITY_UNKNOWN';
  throw error;
}

function prepareRequest(binding, raw, purpose, diagnosticCheck) {
  requireValue(record(raw), 'MODEL_INPUT_INVALID', 'Model request options must be an object.');
  for (const key of ['reasoning', 'reasoningEffort', 'background', 'hostedTools', 'previousResponseId', 'previous_response_id']) {
    if (raw[key] !== undefined && raw[key] !== false && raw[key] !== null) requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'A required model feature is not implemented by this adapter.');
  }
  const allowed = new Set(['maxOutputTokens', 'maxTokens', 'temperature', 'temperaturePreference', 'timeoutMs', 'deadlineAt', 'deadlineMs', 'maxRequestBytes', 'maxResponseBytes', 'maxFrameBytes', 'maxArgumentsBytes', 'stream', 'stop']);
  requireValue(Object.keys(raw).every((key) => allowed.has(key)), 'MODEL_INPUT_INVALID', 'Unsupported model request option.');
  requireValue(purpose === 'workload' || purpose === 'diagnostic', 'MODEL_INPUT_INVALID', 'Unsupported model request purpose.');
  const diagnostic = purpose === 'diagnostic';
  requireValue(diagnostic ? binding.kind === 'model-diagnostic' : binding.kind !== 'model-diagnostic', 'MODEL_INPUT_INVALID', 'The accepted run purpose does not match this model request.');
  requireValue(!diagnostic || ['text', 'nativeTools', 'streaming', 'usage'].includes(diagnosticCheck), 'MODEL_INPUT_INVALID', 'Unsupported model diagnostic check.');
  requireValue(diagnostic || diagnosticCheck === undefined, 'MODEL_INPUT_INVALID', 'Diagnostic checks require an internal diagnostic call.');
  const bypass = (name) => diagnostic && diagnosticCheck === name;
  requireCapability(capability(binding, 'text') !== 'unsupported' || bypass('text'), binding, 'text', 'This model does not support ordinary text requests.');
  let maxOutputTokens = Math.min(binding.request.maxOutputTokens, LIMITS.maxOutputTokens);
  if (raw.maxOutputTokens !== undefined) maxOutputTokens = boundedInteger(raw.maxOutputTokens, maxOutputTokens, maxOutputTokens, 'output');
  if (raw.maxTokens !== undefined) maxOutputTokens = boundedInteger(raw.maxTokens, maxOutputTokens, maxOutputTokens, 'output');
  let timeoutMs = boundedInteger(raw.timeoutMs, LIMITS.timeoutMs, LIMITS.timeoutMs, 'timeout');
  if (raw.deadlineAt !== undefined || raw.deadlineMs !== undefined) {
    const deadline = raw.deadlineAt ?? raw.deadlineMs;
    requireValue(typeof deadline === 'number' && Number.isFinite(deadline), 'MODEL_INPUT_INVALID', 'Invalid request deadline.');
    timeoutMs = Math.min(timeoutMs, Math.max(0, deadline - Date.now()));
    requireValue(timeoutMs > 0, 'MODEL_TIMEOUT', 'The model request deadline has passed.');
  }
  const limits = {
    maxRequestBytes: boundedInteger(raw.maxRequestBytes, LIMITS.maxRequestBytes, LIMITS.maxRequestBytes, 'request bytes'),
    maxResponseBytes: boundedInteger(raw.maxResponseBytes, LIMITS.maxResponseBytes, LIMITS.maxResponseBytes, 'response bytes'),
    maxFrameBytes: boundedInteger(raw.maxFrameBytes, LIMITS.maxFrameBytes, LIMITS.maxFrameBytes, 'frame bytes'),
    maxArgumentsBytes: boundedInteger(raw.maxArgumentsBytes, LIMITS.maxArgumentsBytes, LIMITS.maxArgumentsBytes, 'tool arguments'),
  };
  let temperature = binding.request.temperature;
  if (temperature !== undefined) requireCapability(capability(binding, 'temperature') === 'supported', binding, 'temperature', 'An explicitly configured temperature is not supported or verified.');
  if (raw.temperature !== undefined) {
    requireValue(Number.isFinite(raw.temperature), 'MODEL_INPUT_INVALID', 'Temperature must be a finite number.');
    requireCapability(capability(binding, 'temperature') === 'supported', binding, 'temperature', 'The requested temperature is not supported or verified.');
    if (temperature === undefined) temperature = raw.temperature;
  }
  if (temperature === undefined && raw.temperaturePreference !== undefined && capability(binding, 'temperature') === 'supported') {
    requireValue(Number.isFinite(raw.temperaturePreference), 'MODEL_INPUT_INVALID');
    temperature = raw.temperaturePreference;
  }
  const mode = binding.compatibility.streamMode;
  requireValue(raw.stream === undefined || typeof raw.stream === 'boolean', 'MODEL_INPUT_INVALID', 'Invalid streaming preference.');
  // Diagnostic checks own their wire mode; workload streaming preferences must
  // not force text/usage/native-tool probes into a different capability check.
  let stream = !diagnostic && (mode === 'on' || mode === 'auto' && capability(binding, 'streaming') === 'supported' && raw.stream !== false);
  if (bypass('streaming')) stream = true;
  requireCapability(!stream || capability(binding, 'streaming') === 'supported' || bypass('streaming'), binding, 'streaming', 'Streaming must be supported or explicitly diagnosed.');
  let stop;
  if (raw.stop !== undefined) {
    requireCapability(capability(binding, 'stop') === 'supported', binding, 'stop', 'Stop sequences are not supported or verified.');
    stop = typeof raw.stop === 'string' ? [raw.stop] : raw.stop;
    requireValue(Array.isArray(stop) && stop.length > 0 && stop.length <= 16 && stop.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 1024), 'MODEL_INPUT_INVALID', 'Invalid stop sequences.');
    requireValue(binding.protocol !== 'openai-responses', 'MODEL_FEATURE_UNSUPPORTED', 'Responses stop sequences are not supported by this adapter.');
  }
  const includeUsage = binding.compatibility.includeUsage && capability(binding, 'usage') === 'supported' || bypass('usage');
  return { request: { maxOutputTokens, temperature, stream, includeUsage, ...(stop === undefined ? {} : { stop }) }, timeoutMs, limits, bypass };
}

/** Pure acceptance checks: no credential resolution, network, callbacks or physical attempt. */
function preflightModelRequest({ binding, messages: inputMessages, tools: inputTools = [], request: rawRequest = {}, purpose = 'workload', diagnosticCheck, operationBudget } = {}) {
  requireValue(isResolvedModelBinding(binding), 'MODEL_BINDING_INVALID', 'A main-process resolved model binding is required.');
  assertModelOperationBudget(operationBudget);
  const prepared = prepareRequest(binding, rawRequest, purpose, diagnosticCheck);
  const messages = normalizeMessages(inputMessages);
  const tools = normalizeTools(inputTools);
  if (purpose === 'diagnostic') {
    requireValue(tools.length === 0 || diagnosticCheck === 'nativeTools' && tools.length === 1 && tools[0].name === 'synthetic_echo', 'MODEL_INPUT_INVALID', 'Only the internal synthetic tool is accepted by a native-tools diagnosis.');
    requireValue(messages.every((message) => !message.toolCalls?.some((call) => call.name !== 'synthetic_echo')), 'MODEL_INPUT_INVALID', 'Diagnostic tool history must contain only the internal synthetic tool.');
  }
  const native = binding.compatibility.toolMode === 'native';
  const hasNativeHistory = messages.some((message) => message.role === 'tool' || message.toolCalls?.length);
  if (hasNativeHistory) requireCapability(native && capability(binding, 'nativeTools') === 'supported' || prepared.bypass('nativeTools'), binding, 'nativeTools', 'Native tool history requires verified native tools and native compatibility mode.', native ? undefined : 'unsupported');
  if (tools.length && native) requireCapability(capability(binding, 'nativeTools') === 'supported' || prepared.bypass('nativeTools'), binding, 'nativeTools', 'Native tools must be supported or explicitly diagnosed.');
  if (tools.length && binding.compatibility.toolMode === 'none') requireCapability(prepared.bypass('nativeTools'), binding, 'nativeTools', 'Tools are disabled for this model.', 'unsupported');
  if (tools.length && purpose !== 'diagnostic') {
    const policy = binding.toolPolicy;
    requireValue(policy?.mode === 'allowlist' && tools.every((tool) => policy.allowedTools.includes('@host-authorized') || policy.allowedTools.includes(tool.name)), 'MODEL_TOOL_POLICY_DENIED', 'Tools are outside the accepted assistant policy.');
  }
  const wireTools = native || prepared.bypass('nativeTools') ? tools : [];
  let operation;
  if (operationBudget !== undefined) {
    const contextLimit = modelOperationContextLimit(operationBudget, binding);
    const measured = measureModelJson({ messages, tools: wireTools }, { maxRequestBytes: prepared.limits.maxRequestBytes, contextLimit, maxOutputTokens: prepared.request.maxOutputTokens });
    operation = { contextLimit, requestBytes: measured.requestBytes, approxInputTokens: measured.approxInputTokens };
  } else {
    const projection = JSON.stringify({ messages, tools: wireTools });
    requireValue(bytes(projection) <= prepared.limits.maxRequestBytes, 'MODEL_LIMIT_EXCEEDED', 'The model request exceeds its body limit.');
    const window = binding.capabilities.contextWindow?.tokens;
    if (window !== null && window !== undefined) requireValue(Math.ceil(projection.length / 4) + prepared.request.maxOutputTokens <= window, 'MODEL_CONTEXT_LIMIT', 'The request and reserved output exceed the configured context window.');
  }
  const url = normalizeModelEndpoint(binding.protocol, binding.baseUrl);
  if (binding.auth.kind !== 'none') requireValue(binding.auth.secretRef && binding.auth.credentialOrigin === new URL(url).origin, 'MODEL_AUTH_REQUIRED', 'A usable credential is required for the selected provider.');
  return { messages, tools: wireTools, request: prepared.request, timeoutMs: prepared.timeoutMs, limits: prepared.limits, url, ...(operation ? { operation } : {}) };
}

async function invokeModelTurn({ binding, messages: inputMessages, tools: inputTools = [], request: rawRequest = {}, signal, onEvent, fetchFn, resolveCredential, purpose = 'workload', diagnosticCheck, providerState, operationBudget } = {}) {
  requireValue(isResolvedModelBinding(binding), 'MODEL_BINDING_INVALID', 'A main-process resolved model binding is required.');
  const adapter = getModelAdapter(binding.protocol);
  let nextState; let context; let attemptId;
  const modelSource = publicModelSource(binding);
  try {
    const prepared = preflightModelRequest({ binding, messages: inputMessages, tools: inputTools, request: rawRequest, purpose, diagnosticCheck, operationBudget });
    const { messages, tools, url } = prepared;
    const auth = binding.auth;
    const resolveHeaders = async () => {
      const headers = {}; context.check();
      if (auth.kind !== 'none') {
        requireValue(typeof resolveCredential === 'function', 'MODEL_AUTH_REQUIRED', 'A usable credential is required for the selected provider.');
        let value;
        try { value = await context.wait(Promise.resolve().then(() => { if (operationBudget !== undefined) context.check(); return resolveCredential(binding); })); }
        catch { if (context.signal.aborted) throw context.signal.reason; throw new ModelError('MODEL_CREDENTIAL_UNAVAILABLE', 'The selected provider credential is unavailable.'); }
        requireValue(typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\r\n\0]/.test(value), 'MODEL_AUTH_REQUIRED', 'A usable credential is required for the selected provider.');
        if (auth.kind === 'bearer') headers.Authorization = `Bearer ${value}`;
        else if (auth.kind === 'api-key') headers['x-api-key'] = value;
        else requireValue(false, 'MODEL_AUTH_REQUIRED');
      }
      return headers;
    };
    context = createRequestContext({ signal, timeoutMs: prepared.timeoutMs, limits: prepared.limits, onEvent,
      ...(operationBudget === undefined ? {} : { operationBudget, operationInfo: { protocol: binding.protocol, model: binding.model, contextLimit: prepared.operation.contextLimit, maxOutputTokens: prepared.request.maxOutputTokens }, resolveHeaders, deadlineAt: rawRequest.deadlineAt ?? rawRequest.deadlineMs }) });
    context.check();
    if (operationBudget !== undefined) await context.check({ stage: 'prepare', requestBytes: prepared.operation.requestBytes, approxInputTokens: prepared.operation.approxInputTokens });
    context.check();
    const headers = operationBudget === undefined ? await resolveHeaders() : {};
    const result = await adapter.invoke({ binding, messages, tools, request: prepared.request, headers, url, context, fetchFn, providerState,
      onAttempt: () => { requireValue(!attemptId, 'MODEL_PROTOCOL_ERROR', 'Automatic model retries are disabled.'); attemptId = randomUUID(); return attemptId; } });
    nextState = result.providerState; context.check();
    const toolCalls = validateToolCalls(result.toolCalls, tools, result.finishReason, prepared.limits.maxArgumentsBytes);
    const usage = normalizeUsage(binding.protocol, result.rawUsage, messages, result.content, true);
    // Do not publish success or executable tools until cleanup has completed.
    // A parent abort/deadline during cleanup must pass through the same error
    // normalization, usage attribution and continuation invalidation path.
    await context.dispose(); context.check();
    return { content: result.content, toolCalls, finishReason: result.finishReason, usage, attemptId, modelSource, ...(nextState === undefined ? {} : { providerState: nextState }) };
  } catch (error) {
    adapter.invalidate?.(providerState); adapter.invalidate?.(nextState);
    // Cancellation/deadline during failed-turn cleanup also owns the final outcome.
    await context?.dispose();
    const normalized = safeError(error, context?.signal || signal);
    if (attemptId) {
      normalized.attemptId = attemptId; normalized.modelSource = modelSource;
      normalized.usage = normalized.code === 'MODEL_EMPTY_RESPONSE' && context?.validatedUsage !== undefined
        ? normalizeUsage(binding.protocol, context.validatedUsage, [], '', false) : unavailableUsage();
    }
    if (context?.partialOutput) normalized.partialOutput = context.partialOutput;
    throw normalized;
  } finally { await context?.dispose(); }
}

// The sole snake_case boundary lives in llm-client; keep this main-process integration export lazy.
function createModelChatFunction(options) { return require('./llm-client').createModelChatFunction(options); }
module.exports = { invokeModelTurn, preflightModelRequest, createModelChatFunction, createModelOperationBudget, publicModelSource, ModelError, MODEL_LIMITS: LIMITS };
