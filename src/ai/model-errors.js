'use strict';

// These bounds are presentation limits, not transport budgets or retry policy.
const PUBLIC_MODEL_ERROR_LIMITS = Object.freeze({ messageChars: 2048, partialBytes: 65536, requestIdChars: 128, retryAfterMs: 86400000 });
const SAFE_MESSAGES = Object.freeze({
  MODEL_CONFIG_INVALID: 'The selected model configuration is invalid.',
  MODEL_CREDENTIAL_UNAVAILABLE: 'A required model credential is unavailable.',
  MODEL_AUTH_FAILED: 'The model provider rejected authentication.',
  MODEL_PERMISSION_DENIED: 'The model provider denied permission.',
  MODEL_NOT_FOUND: 'The requested model was not found.',
  MODEL_CAPABILITY_UNSUPPORTED: 'The selected model does not support the required capability.',
  MODEL_CAPABILITY_UNKNOWN: 'The required model capability has not been confirmed.',
  MODEL_CONTEXT_LIMIT: 'The model context exceeds the permitted limit.',
  MODEL_LIMIT: 'The model request exceeded a permitted limit.',
  MODEL_RATE_LIMIT: 'The model provider is rate limiting requests.',
  MODEL_TIMEOUT: 'The model request exceeded its deadline.',
  MODEL_NETWORK: 'The model request could not be completed.',
  MODEL_PROTOCOL: 'The model response did not match the selected protocol.',
  MODEL_EMPTY_RESPONSE: 'The model returned no usable output.',
  MODEL_CANCELLED: 'The model request was cancelled.',
});
const CODE_ALIASES = Object.freeze({
  MODEL_FORBIDDEN: 'MODEL_PERMISSION_DENIED',
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMIT',
  MODEL_CONNECTION_FAILED: 'MODEL_NETWORK',
  MODEL_UPSTREAM_ERROR: 'MODEL_NETWORK',
  MODEL_UPSTREAM: 'MODEL_NETWORK',
  MODEL_REDIRECT_REFUSED: 'MODEL_NETWORK',
  MODEL_PROTOCOL_ERROR: 'MODEL_PROTOCOL',
  MODEL_BAD_REQUEST: 'MODEL_PROTOCOL',
  MODEL_TOOL_INVALID: 'MODEL_PROTOCOL',
  MODEL_SCHEMA_UNSUPPORTED: 'MODEL_CAPABILITY_UNSUPPORTED',
  MODEL_FEATURE_UNSUPPORTED: 'MODEL_CAPABILITY_UNSUPPORTED',
  MODEL_ADAPTER_UNSUPPORTED: 'MODEL_CAPABILITY_UNSUPPORTED',
  MODEL_LIMIT_EXCEEDED: 'MODEL_LIMIT',
  MODEL_AUTH_REQUIRED: 'MODEL_CREDENTIAL_UNAVAILABLE',
  MODEL_INPUT_INVALID: 'MODEL_CONFIG_INVALID',
  MODEL_MESSAGE_ROLE_INVALID: 'MODEL_CONFIG_INVALID',
  MODEL_SENDER_INVALID: 'MODEL_CONFIG_INVALID',
  MODEL_BINDING_INVALID: 'MODEL_CONFIG_INVALID',
  MODEL_TOOL_POLICY_DENIED: 'MODEL_PERMISSION_DENIED',
  ABORTED: 'MODEL_CANCELLED',
});
const SOURCE_KINDS = new Set(['api', 'local-demo', 'legacy-demo', 'unknown']);
const SOURCE_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);
const SOURCE_IDS = ['providerId', 'modelProfileId', 'assistantId', 'runId', 'clientRequestId'];
const SOURCE_NAMES = ['providerName', 'modelProfileName', 'assistantName', 'model'];
const SOURCE_REVISIONS = ['providerRevision', 'modelRevision', 'assistantRevision'];

// Read only own data properties. No caller/body/getter/toJSON is consulted by a
// public projection; even hostile accessor/proxy failures produce a fixed DTO.
function ownValue(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  } catch { return undefined; }
}
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
  catch { return false; }
}
function safeHttpStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined; }
function safeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}
// RFC Retry-After delay-seconds only. HTTP dates and body hints are deliberately
// not classified or parsed; oversized values are omitted instead of shortened.
function safeRetryAfterMs(value, milliseconds = false) {
  if (milliseconds) return Number.isSafeInteger(value) && value >= 0 && value <= PUBLIC_MODEL_ERROR_LIMITS.retryAfterMs ? value : undefined;
  if (typeof value === 'string') {
    if (!/^\d{1,8}$/.test(value)) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 && value <= PUBLIC_MODEL_ERROR_LIMITS.retryAfterMs / 1000 ? value * 1000 : undefined;
}
function classify(code, details = {}, options = {}) {
  if (code === 'MODEL_CAPABILITY_REQUIRED') {
    const requestedCode = ownValue(options, 'publicCode') ?? ownValue(details, 'publicCode');
    if (requestedCode === 'MODEL_CAPABILITY_UNKNOWN' || requestedCode === 'MODEL_CAPABILITY_UNSUPPORTED') return { code: requestedCode, known: true };
    const state = ownValue(options, 'capabilityState') ?? ownValue(details, 'capabilityState');
    return { code: state === 'unsupported' ? 'MODEL_CAPABILITY_UNSUPPORTED' : 'MODEL_CAPABILITY_UNKNOWN', known: true };
  }
  if (typeof code === 'string' && Object.hasOwn(SAFE_MESSAGES, code)) return { code, known: true };
  if (typeof code === 'string' && Object.hasOwn(CODE_ALIASES, code)) return { code: CODE_ALIASES[code], known: true };
  return { code: 'MODEL_NETWORK', known: false };
}
function retrySuggestion(code, classification, httpStatus, explicit) {
  if (!classification.known || explicit === false || code === 'MODEL_REDIRECT_REFUSED') return false;
  if (classification.code === 'MODEL_TIMEOUT') return true;
  if (classification.code === 'MODEL_RATE_LIMIT') return httpStatus === undefined || httpStatus === 429;
  if (classification.code !== 'MODEL_NETWORK') return false;
  if (httpStatus !== undefined) return httpStatus === 429 || httpStatus >= 500;
  return code !== 'MODEL_UPSTREAM_ERROR' && code !== 'MODEL_UPSTREAM';
}
// Shared by the internal ModelError constructor. Legacy codes/aliases stay on
// the internal error; the canonical code is only used to derive safe metadata.
function modelErrorMetadata(code, details = {}) {
  const classification = classify(code, details);
  const httpStatus = safeHttpStatus(ownValue(details, 'httpStatus')) ?? safeHttpStatus(ownValue(details, 'status'));
  const retryAfterMs = safeRetryAfterMs(ownValue(details, 'retryAfterMs'), true) ?? safeRetryAfterMs(ownValue(details, 'retryAfter'));
  return {
    safeMessage: SAFE_MESSAGES[classification.code],
    retryable: retrySuggestion(code, classification, httpStatus, ownValue(details, 'retryable')),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
function defaultRedact(text) { return require('./model-text-redaction').redactModelPartialOutput(text); }
function redactor(options, key) {
  const option = ownValue(options, key);
  return option === undefined ? defaultRedact : typeof option === 'function' ? option : null;
}
function redactText(value, redact, maxChars, maxBytes) {
  if (typeof value !== 'string' || value.length > maxChars || Buffer.byteLength(value, 'utf8') > maxBytes || !redact) return undefined;
  try {
    const result = redact(value);
    return typeof result === 'string' && result.length <= maxChars && Buffer.byteLength(result, 'utf8') <= maxBytes && !result.includes('\0') ? result : undefined;
  } catch { return undefined; }
}
function safeSource(source, redact) {
  if (!plainRecord(source)) return undefined;
  const kind = ownValue(source, 'kind'); if (!SOURCE_KINDS.has(kind)) return undefined;
  const output = { kind };
  for (const key of SOURCE_IDS) {
    const value = ownValue(source, key);
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) continue;
    if (redactText(value, redact, 160, 640) === value) output[key] = value;
  }
  for (const key of SOURCE_NAMES) {
    const maximum = key === 'model' ? 256 : 128;
    const value = ownValue(source, key);
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) continue;
    const safe = redactText(value, redact, maximum, maximum * 4);
    if (safe) output[key] = safe;
  }
  const protocol = ownValue(source, 'protocol'); if (SOURCE_PROTOCOLS.has(protocol)) output.protocol = protocol;
  for (const key of SOURCE_REVISIONS) {
    const revision = ownValue(source, key);
    if (Number.isSafeInteger(revision) && revision > 0) output[key] = revision;
  }
  const bindingRevision = ownValue(source, 'bindingRevision');
  if (typeof bindingRevision === 'string' && /^[a-f0-9]{64}$/.test(bindingRevision) && redactText(bindingRevision, redact, 64, 64) === bindingRevision) output.bindingRevision = bindingRevision;
  // Provenance is a fresh record. Endpoint/baseUrl, owner, credentials, provider
  // configuration/state, functions and toJSON are intentionally never copied.
  return output;
}
function preservedBusinessCode(code, options) {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || code.startsWith('MODEL_')) return undefined;
  const allow = ownValue(options, 'preserveCodes');
  try {
    if (Array.isArray(allow) && allow.length <= 200 && allow.includes(code) || allow instanceof Set && allow.size <= 200 && Set.prototype.has.call(allow, code)) return code;
  } catch { /* Only an explicit trusted allow-list may preserve business codes. */ }
  return undefined;
}

/**
 * Public JSON only; never return/spread/serialize the original error or binding.
 *
 * options.redactMessage / redactPartial: synchronous string -> safe string,
 * defaulting to the existing prefix-withholding model redactor. Failure closes.
 * options.modelSource / partialOutput: explicit caller-selected provenance/text,
 * still validated/redacted. No private resolved binding is ever forwarded.
 * options.preserveCodes: trusted business-code Array/Set; options.safeMessage:
 * caller-owned fixed business text (not error.message). Unlisted errors fail
 * closed. Capability REQUIRED uses only explicit publicCode/capabilityState.
 * retryable only suggests a new user-authorized attempt; it never retries.
 */
function publicModelError(error, options = {}) {
  const rawCode = ownValue(error, 'code');
  const classification = classify(rawCode, error, options);
  const businessCode = !classification.known ? preservedBusinessCode(rawCode, options) : undefined;
  const code = businessCode || classification.code;
  const fallback = businessCode ? 'The request could not be completed.' : SAFE_MESSAGES[code];
  const redactMessage = redactor(options, 'redactMessage');
  const redactPartial = redactor(options, 'redactPartial');
  // Lazy import avoids a cycle: common uses modelErrorMetadata at construction.
  let controlled = false;
  try { controlled = error instanceof require('./model-adapters/common').ModelError; } catch { /* Non-model thrown values remain fixed. */ }
  const candidate = businessCode ? ownValue(options, 'safeMessage') : controlled && classification.known ? ownValue(error, 'safeMessage') : undefined;
  const safeMessage = redactText(candidate, redactMessage, PUBLIC_MODEL_ERROR_LIMITS.messageChars, PUBLIC_MODEL_ERROR_LIMITS.messageChars * 4) || fallback;
  const httpStatus = classification.known ? safeHttpStatus(ownValue(error, 'httpStatus')) ?? safeHttpStatus(ownValue(error, 'status')) : undefined;
  const retryable = retrySuggestion(rawCode, classification, httpStatus, ownValue(error, 'retryable'));
  const output = { code, safeMessage, message: safeMessage, retryable };
  if (httpStatus !== undefined) output.httpStatus = httpStatus;
  if (classification.known) {
    const requestId = safeRequestId(ownValue(error, 'requestId'));
    if (requestId !== undefined && redactText(requestId, redactMessage, PUBLIC_MODEL_ERROR_LIMITS.requestIdChars, PUBLIC_MODEL_ERROR_LIMITS.requestIdChars) === requestId) output.requestId = requestId;
    const retryAfterMs = safeRetryAfterMs(ownValue(error, 'retryAfterMs'), true) ?? safeRetryAfterMs(ownValue(error, 'retryAfter'));
    if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
  }
  const partialCandidate = ownValue(options, 'partialOutput') ?? (controlled && classification.known ? ownValue(error, 'partialOutput') : undefined);
  const partialOutput = redactText(partialCandidate, redactPartial, PUBLIC_MODEL_ERROR_LIMITS.partialBytes, PUBLIC_MODEL_ERROR_LIMITS.partialBytes);
  if (partialOutput) output.partialOutput = partialOutput;
  const sourceCandidate = ownValue(options, 'modelSource') ?? (classification.known ? ownValue(error, 'modelSource') : undefined);
  const modelSource = safeSource(sourceCandidate, redactMessage);
  if (modelSource) output.modelSource = modelSource;
  return output;
}

module.exports = { publicModelError, modelErrorMetadata, safeHttpStatus, safeRequestId, safeRetryAfterMs, PUBLIC_MODEL_ERROR_LIMITS };
