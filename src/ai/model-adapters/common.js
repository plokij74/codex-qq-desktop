'use strict';

const { modelErrorMetadata } = require('../model-errors');
const LIMITS = Object.freeze({ maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024, maxFrameBytes: 256 * 1024, maxArgumentsBytes: 64 * 1024, timeoutMs: 120000, maxOutputTokens: 32768 });
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
class ModelError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'ModelError'; this.code = code;
    for (const key of ['status', 'requestId', 'retryAfter', 'attemptId', 'modelSource', 'usage']) if (details[key] !== undefined) this[key] = details[key];
    const metadata = modelErrorMetadata(code, details);
    this.safeMessage = typeof details.safeMessage === 'string' ? details.safeMessage : typeof message === 'string' ? message : metadata.safeMessage;
    this.retryable = metadata.retryable;
    if (metadata.httpStatus !== undefined) { this.httpStatus = metadata.httpStatus; if (this.status === undefined) this.status = metadata.httpStatus; }
    if (metadata.retryAfterMs !== undefined) { this.retryAfterMs = metadata.retryAfterMs; if (this.retryAfter === undefined) this.retryAfter = metadata.retryAfterMs / 1000; }
    // Capability preflight may attach this explicit host-owned classification.
    if (['MODEL_CAPABILITY_UNKNOWN', 'MODEL_CAPABILITY_UNSUPPORTED'].includes(details.publicCode)) this.publicCode = details.publicCode;
    if (['unknown', 'supported', 'unsupported'].includes(details.capabilityState)) this.capabilityState = details.capabilityState;
  }
}
function fail(code, message) { throw new ModelError(code, message); }
function requireValue(condition, code = 'MODEL_PROTOCOL_ERROR', message = 'The model response did not match the selected protocol.') { if (!condition) fail(code, message); }
const bytes = (value) => Buffer.byteLength(value, 'utf8');
function parseJson(value, code = 'MODEL_PROTOCOL_ERROR') { try { return JSON.parse(value); } catch { return fail(code, 'The model returned invalid JSON.'); } }
function boundedInteger(value, fallback, maximum, label) { if (value === undefined) return Math.min(fallback, maximum); requireValue(Number.isSafeInteger(value) && value > 0, 'MODEL_INPUT_INVALID', `Invalid ${label} budget.`); return Math.min(value, maximum); }
const unavailableUsage = () => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, source: 'unavailable' });
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function normalizeUsage(protocol, raw, messages, content, complete = true) {
  const result = unavailableUsage();
  if (record(raw)) {
    if (protocol === 'openai-chat-completions') { result.inputTokens = count(raw.prompt_tokens); result.outputTokens = count(raw.completion_tokens); result.cachedInputTokens = count(raw.prompt_tokens_details?.cached_tokens); }
    else if (protocol === 'openai-responses') { result.inputTokens = count(raw.input_tokens); result.outputTokens = count(raw.output_tokens); result.cachedInputTokens = count(raw.input_tokens_details?.cached_tokens); }
    else { const fresh = count(raw.input_tokens); const read = count(raw.cache_read_input_tokens); const create = count(raw.cache_creation_input_tokens); result.inputTokens = fresh === null ? null : fresh + (read ?? 0) + (create ?? 0); result.outputTokens = count(raw.output_tokens); result.cachedInputTokens = read; result.cacheCreationInputTokens = create; }
    if (result.inputTokens !== null && result.outputTokens !== null) { result.source = 'actual'; return result; }
  }
  if (complete && typeof content === 'string' && content.length > 0) { result.inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4); result.outputTokens = Math.ceil(content.length / 4); result.source = 'estimated'; }
  return result;
}
function assertString(value, max, code = 'MODEL_INPUT_INVALID') { requireValue(typeof value === 'string' && value.length <= max && !value.includes('\0'), code, 'A model input field is invalid or exceeds its limit.'); return value; }
function assertArguments(value, maximum = LIMITS.maxArgumentsBytes, code = 'MODEL_TOOL_INVALID') {
  requireValue(typeof value === 'string', code, 'Tool arguments must be a JSON string.');
  requireValue(bytes(value) <= maximum, 'MODEL_LIMIT_EXCEEDED', 'Tool arguments exceed the permitted byte limit.');
  assertString(value, maximum, code);
  const parsed = parseJson(value, code);
  requireValue(record(parsed), code, 'Tool arguments must be a JSON object.');
  return parsed;
}
function normalizeMessages(messages) {
  requireValue(Array.isArray(messages) && messages.length > 0 && messages.length <= 1024, 'MODEL_INPUT_INVALID', 'Model messages must be a bounded nonempty array.');
  let prefix = true; const pending = new Set(); const seenToolCalls = new Set();
  const normalized = messages.map((raw) => {
    requireValue(record(raw) && ['system', 'user', 'assistant', 'tool'].includes(raw.role), 'MODEL_INPUT_INVALID', 'Invalid model message role.');
    requireValue(raw.role !== 'system' || prefix, 'MODEL_INPUT_INVALID', 'System messages must form the host prefix.'); if (raw.role !== 'system') prefix = false;
    requireValue(pending.size === 0 || raw.role === 'tool', 'MODEL_INPUT_INVALID', 'Tool results must complete before the next model message.');
    const m = { role: raw.role, content: assertString(raw.content === null && raw.role === 'assistant' ? '' : raw.content, LIMITS.maxRequestBytes) };
    if (raw.toolCalls !== undefined) {
      requireValue(raw.role === 'assistant' && Array.isArray(raw.toolCalls) && raw.toolCalls.length <= 256, 'MODEL_INPUT_INVALID', 'Invalid assistant tool calls.');
      m.toolCalls = raw.toolCalls.map((call) => {
        requireValue(record(call), 'MODEL_INPUT_INVALID');
        const id = assertString(call.id, 128); const name = assertString(call.name, 128);
        requireValue(id && !seenToolCalls.has(id), 'MODEL_INPUT_INVALID', 'Duplicate tool call identity.');
        requireValue(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name), 'MODEL_INPUT_INVALID', 'Invalid tool name in model history.');
        assertArguments(call.argumentsJson, LIMITS.maxArgumentsBytes, 'MODEL_INPUT_INVALID');
        seenToolCalls.add(id); pending.add(id);
        return { id, name, argumentsJson: call.argumentsJson };
      });
    }
    if (raw.role === 'tool') { m.toolCallId = assertString(raw.toolCallId, 128); requireValue(pending.has(m.toolCallId), 'MODEL_INPUT_INVALID', 'Tool results must follow a matching assistant tool call.'); pending.delete(m.toolCallId); }
    return m;
  });
  requireValue(pending.size === 0, 'MODEL_INPUT_INVALID', 'A tool result is missing from the model history.');
  return normalized;
}
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'uniqueItems', 'description', 'title', 'default', 'examples', '$schema', '$id', 'deprecated', 'readOnly', 'writeOnly']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
function checkSchema(schema, depth = 0) {
  if (typeof schema === 'boolean') return;
  requireValue(record(schema) && depth <= 32, 'MODEL_SCHEMA_UNSUPPORTED', 'A tool schema is invalid or too deeply nested.');
  requireValue(Object.keys(schema).every((key) => SCHEMA_KEYS.has(key)), 'MODEL_SCHEMA_UNSUPPORTED', 'The tool schema uses an unsupported validation keyword.');
  if (schema.type !== undefined) requireValue((Array.isArray(schema.type) ? schema.type : [schema.type]).every((t) => TYPES.has(t)), 'MODEL_SCHEMA_UNSUPPORTED', 'Unsupported schema type.');
  if (schema.properties !== undefined) { requireValue(record(schema.properties), 'MODEL_SCHEMA_UNSUPPORTED'); for (const child of Object.values(schema.properties)) checkSchema(child, depth + 1); }
  if (schema.required !== undefined) requireValue(Array.isArray(schema.required) && schema.required.every((k) => typeof k === 'string'), 'MODEL_SCHEMA_UNSUPPORTED');
  if (schema.additionalProperties !== undefined) checkSchema(schema.additionalProperties, depth + 1);
  if (schema.items !== undefined) checkSchema(schema.items, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) { requireValue(Array.isArray(schema[key]) && schema[key].length > 0 && schema[key].length <= 64, 'MODEL_SCHEMA_UNSUPPORTED'); for (const child of schema[key]) checkSchema(child, depth + 1); }
  if (schema.enum !== undefined) requireValue(Array.isArray(schema.enum) && schema.enum.length > 0, 'MODEL_SCHEMA_UNSUPPORTED');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (schema[key] !== undefined) requireValue(typeof schema[key] === 'number' && Number.isFinite(schema[key]) && (key === 'multipleOf' ? schema[key] > 0 : /^(min|max)(Length|Items|Properties)$/.test(key) ? Number.isInteger(schema[key]) && schema[key] >= 0 : true), 'MODEL_SCHEMA_UNSUPPORTED');
  if (schema.uniqueItems !== undefined) requireValue(typeof schema.uniqueItems === 'boolean', 'MODEL_SCHEMA_UNSUPPORTED');
}
function jsonKey(value, depth = 0) {
  if (depth > 64) return undefined;
  if (Array.isArray(value)) {
    const values = value.map((entry) => jsonKey(entry, depth + 1));
    return values.includes(undefined) ? undefined : `[${values.join(',')}]`;
  }
  if (record(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      const child = jsonKey(value[key], depth + 1);
      return child === undefined ? undefined : `${JSON.stringify(key)}:${child}`;
    });
    return entries.includes(undefined) ? undefined : `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
function matchesSchema(value, schema, depth = 0) {
  if (typeof schema === 'boolean') return schema; if (depth > 64) return false;
  const same = (a, b) => { const key = jsonKey(a); return key !== undefined && key === jsonKey(b); };
  const isType = (type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? record(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(isType)) return false;
  if (schema.enum && !schema.enum.some((entry) => same(entry, value))) return false;
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const)) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => matchesSchema(value, s, depth + 1))) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => matchesSchema(value, s, depth + 1)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every((s) => matchesSchema(value, s, depth + 1))) return false;
  if (record(value)) { const keys = Object.keys(value); if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false; if (schema.required?.some((k) => !Object.hasOwn(value, k))) return false; for (const key of keys) { const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties; if (child !== undefined && !matchesSchema(value[key], child, depth + 1)) return false; } }
  if (Array.isArray(value)) { if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false; if (schema.items !== undefined && !value.every((v) => matchesSchema(v, schema.items, depth + 1))) return false; if (schema.uniqueItems) { const keys = value.map((v) => jsonKey(v)); if (keys.includes(undefined) || new Set(keys).size !== value.length) return false; } }
  if (typeof value === 'string') { const n = [...value].length; if (schema.minLength !== undefined && n < schema.minLength || schema.maxLength !== undefined && n > schema.maxLength) return false; }
  if (typeof value === 'number') { if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false; if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) return false; }
  return true;
}
function normalizeTools(tools = []) {
  requireValue(Array.isArray(tools) && tools.length <= 256, 'MODEL_INPUT_INVALID', 'Too many model tools.'); const names = new Set();
  return tools.map((raw) => { requireValue(record(raw), 'MODEL_INPUT_INVALID'); const name = assertString(raw.name, 128); requireValue(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name) && !names.has(name), 'MODEL_INPUT_INVALID', 'Invalid or duplicate tool name.'); names.add(name); const parameters = raw.parameters === undefined ? { type: 'object', properties: {} } : raw.parameters; checkSchema(parameters); return { name, ...(raw.description === undefined ? {} : { description: assertString(raw.description, 16384) }), parameters: structuredClone(parameters) }; });
}
function validateToolCalls(calls, tools, finishReason, maxArgumentsBytes = LIMITS.maxArgumentsBytes) {
  requireValue(Array.isArray(calls) && calls.length <= 256, 'MODEL_TOOL_INVALID', 'Invalid model tool calls.'); const ids = new Set();
  if (calls.length) requireValue(finishReason === 'tool_calls', 'MODEL_TOOL_INVALID', 'Incomplete or interrupted tool calls cannot execute.');
  return calls.map((raw) => {
    requireValue(record(raw), 'MODEL_TOOL_INVALID');
    const id = assertString(raw.id, 128, 'MODEL_TOOL_INVALID'); const name = assertString(raw.name, 128, 'MODEL_TOOL_INVALID');
    requireValue(id.length > 0 && !ids.has(id), 'MODEL_TOOL_INVALID', 'Missing or duplicate model tool identity.'); ids.add(id);
    const definition = tools.find((t) => t.name === name);
    requireValue(Boolean(definition), 'MODEL_TOOL_INVALID', 'The model selected a tool not present in this request.');
    const value = assertArguments(raw.argumentsJson, maxArgumentsBytes);
    requireValue(matchesSchema(value, definition.parameters), 'MODEL_TOOL_INVALID', 'Model tool arguments do not match the tool schema.');
    return { id, name, argumentsJson: raw.argumentsJson };
  });
}
function emit(onEvent, delta) { if (!delta) return; if (typeof onEvent === 'function') { try { onEvent({ type: 'text-delta', delta }); } catch { /* UI callback errors do not change the physical request outcome. */ } } }
function safeError(error, signal) { if (signal?.aborted) return signal.reason instanceof ModelError ? signal.reason : new ModelError('ABORTED', 'The model request was cancelled.'); if (error instanceof ModelError) return error; return new ModelError('MODEL_CONNECTION_FAILED', 'The model request could not be completed.'); }
module.exports = { LIMITS, ModelError, fail, requireValue, record, bytes, parseJson, boundedInteger, unavailableUsage, normalizeUsage, normalizeMessages, normalizeTools, validateToolCalls, checkSchema, matchesSchema, emit, safeError };
