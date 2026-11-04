'use strict';

// Main-only authority. Serialized/spread descriptors cannot acquire this brand.
const { isResolvedModelBinding } = require('./model-profiles');
const { LIMITS, ModelError, requireValue, record } = require('./model-adapters/common');
const BUDGETS = new WeakSet();
const CALLBACKS = new WeakMap();
const UNKNOWN_CONTEXT_LIMIT = 32000;
const SUMMARY_KEYS = ['count', 'rawBytes', 'selectedBytes', 'selectedChars', 'truncatedCount'];
const ATTACHMENT_CODES = new Set([
  'ATTACHMENT_TYPE_UNSUPPORTED', 'ATTACHMENT_ENCODING_INVALID', 'ATTACHMENT_FILE_LIMIT',
  'ATTACHMENT_SELECTION_LIMIT', 'ATTACHMENT_TEXT_LIMIT', 'ATTACHMENT_CAPTURE_BUSY',
  'ATTACHMENT_WORK_BUSY', 'ATTACHMENT_CAPTURE_TIMEOUT', 'ATTACHMENT_READ_DENIED',
  'ATTACHMENT_SOURCE_CHANGED', 'ATTACHMENT_REFERENCE_INVALID', 'ATTACHMENT_SESSION_IN_USE',
  'ATTACHMENT_PREVIEW_REQUIRED', 'ATTACHMENT_PREVIEW_STALE', 'ATTACHMENT_PREVIEW_EXPIRED',
  'ATTACHMENT_PREVIEW_USED', 'ATTACHMENT_MISSING', 'ATTACHMENT_CORRUPT', 'ATTACHMENT_EXPIRED',
  'ATTACHMENT_DELETED', 'ATTACHMENT_CACHE_LIMIT', 'ATTACHMENT_STORAGE_UNAVAILABLE',
  'ATTACHMENT_COMPACT_MANIFEST_LIMIT',
]);
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function isModelOperationBudget(value) { return Boolean(value && typeof value === 'object' && BUDGETS.has(value)); }
function assertModelOperationBudget(value) {
  requireValue(value === undefined || isModelOperationBudget(value), 'MODEL_INPUT_INVALID', 'A main-process model operation budget is required.');
}
function modelOperationContextLimit(operationBudget, binding) {
  assertModelOperationBudget(operationBudget);
  if (operationBudget === undefined) return undefined;
  requireValue(isResolvedModelBinding(binding), 'MODEL_BINDING_INVALID', 'A main-process resolved model binding is required.');
  const declared = binding.capabilities?.contextWindow?.tokens;
  return Math.min(operationBudget.contextLimit, positive(declared) ? declared : UNKNOWN_CONTEXT_LIMIT);
}
/**
 * contextLimit is the accepted main-computed ceiling, or supply a resolved binding
 * and optional explicit compactMaxApproxTokens to derive it. Neither is renderer authority.
 * reserveWire receives exact allocation counts before transport JSON.stringify and
 * returns a release function. It covers only that string copy, not parent attachment
 * work, normalized/protocol clones, fetch implementation copies or process RSS.
 */
function createModelOperationBudget(options = {}) {
  requireValue(record(options), 'MODEL_INPUT_INVALID', 'Invalid model operation budget.');
  const { contextLimit, binding, compactMaxApproxTokens, check, onDispatch, attachmentSummary, reserveWire } = options;
  requireValue(contextLimit === undefined || positive(contextLimit), 'MODEL_INPUT_INVALID', 'Invalid operation context limit.');
  requireValue(compactMaxApproxTokens === undefined || positive(compactMaxApproxTokens), 'MODEL_INPUT_INVALID', 'Invalid explicit operation context limit.');
  requireValue(binding === undefined || isResolvedModelBinding(binding), 'MODEL_BINDING_INVALID', 'A main-process resolved model binding is required.');
  requireValue(typeof check === 'function', 'MODEL_INPUT_INVALID', 'An operation dispatch guard is required.');
  requireValue(onDispatch === undefined || typeof onDispatch === 'function', 'MODEL_INPUT_INVALID', 'Invalid operation dispatch observer.');
  requireValue(reserveWire === undefined || typeof reserveWire === 'function', 'MODEL_INPUT_INVALID', 'Invalid operation wire reservation.');
  const ceilings = [contextLimit, compactMaxApproxTokens].filter((value) => value !== undefined);
  if (binding) ceilings.push(positive(binding.capabilities?.contextWindow?.tokens) ? binding.capabilities.contextWindow.tokens : UNKNOWN_CONTEXT_LIMIT);
  requireValue(ceilings.length > 0, 'MODEL_INPUT_INVALID', 'An operation context limit or resolved binding is required.');
  let summary;
  if (attachmentSummary !== undefined) {
    requireValue(record(attachmentSummary) && Object.keys(attachmentSummary).every((key) => SUMMARY_KEYS.includes(key)) && SUMMARY_KEYS.every((key) => Number.isSafeInteger(attachmentSummary[key]) && attachmentSummary[key] >= 0), 'MODEL_INPUT_INVALID', 'Invalid attachment input summary.');
    summary = Object.freeze(Object.fromEntries(SUMMARY_KEYS.map((key) => [key, attachmentSummary[key]])));
  }
  const result = Object.freeze({ contextLimit: Math.min(...ceilings), ...(summary ? { attachmentSummary: summary } : {}) });
  BUDGETS.add(result); CALLBACKS.set(result, { check, onDispatch, reserveWire }); return result;
}
function operationError(error) {
  const code = ATTACHMENT_CODES.has(error?.publicCode) ? error.publicCode : error?.code;
  // Never carry raw parent path/text/stack into a public model failure.
  if (ATTACHMENT_CODES.has(code)) return new ModelError(code, 'The accepted attachment operation is no longer available.');
  if (error instanceof ModelError) return error;
  return new ModelError('MODEL_INPUT_INVALID', 'The accepted model operation could not be validated.');
}
function descriptor(operationBudget, info) {
  return Object.freeze({ ...info, ...(operationBudget.attachmentSummary ? { attachmentSummary: operationBudget.attachmentSummary } : {}) });
}
async function checkModelOperationBudget(operationBudget, info) {
  assertModelOperationBudget(operationBudget);
  try { await CALLBACKS.get(operationBudget).check(descriptor(operationBudget, info)); }
  catch (error) { throw operationError(error); }
}
async function reserveModelOperationWire(operationBudget, info) {
  const reserve = CALLBACKS.get(operationBudget)?.reserveWire;
  if (!reserve) return undefined;
  try {
    const release = await reserve(descriptor(operationBudget, info));
    requireValue(typeof release === 'function', 'MODEL_INPUT_INVALID', 'A wire reservation must provide awaited release.');
    return release;
  } catch (error) { throw operationError(error); }
}
function notifyModelOperationDispatch(operationBudget, info) {
  const notify = CALLBACKS.get(operationBudget)?.onDispatch;
  if (typeof notify === 'function') { try { Promise.resolve(notify(descriptor(operationBudget, info))).catch(() => {}); } catch {} }
}
/** Count ordinary adapter JSON without allocating an encoded body; cap before copy. */
function measureModelJson(value, { maxRequestBytes = LIMITS.maxRequestBytes, contextLimit, maxOutputTokens = 0 } = {}) {
  let jsonCodeUnits = 0; let requestBytes = 0; const active = new WeakSet();
  function add(units, size = units) {
    jsonCodeUnits += units; requestBytes += size;
    requireValue(requestBytes <= maxRequestBytes, 'MODEL_LIMIT_EXCEEDED', 'The model request exceeds its encoded body limit.');
  }
  function string(text) {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) add(2);
      else if (unit < 32) add(6);
      else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(2, 4); i++; }
      else if (unit >= 0xd800 && unit <= 0xdfff) add(6); // well-formed JSON.stringify lone-surrogate escape
      else add(1, unit < 128 ? 1 : unit < 2048 ? 2 : 3);
    }
  }
  function visit(node, depth = 0) {
    if (node === null) { add(4); return; }
    if (typeof node === 'string') { string(node); return; }
    if (typeof node === 'boolean' || typeof node === 'number') { add(JSON.stringify(node).length); return; }
    requireValue(typeof node === 'object' && depth <= 512 && !active.has(node) && typeof node.toJSON !== 'function', 'MODEL_INPUT_INVALID', 'The model wire must contain ordinary bounded JSON.');
    const array = Array.isArray(node); const prototype = Object.getPrototypeOf(node);
    requireValue(array || prototype === Object.prototype || prototype === null, 'MODEL_INPUT_INVALID', 'The model wire must contain ordinary JSON.');
    active.add(node); add(2); let entries = 0;
    const keys = array ? undefined : Object.keys(node);
    const length = array ? node.length : keys.length;
    for (let index = 0; index < length; index++) {
      const key = array ? String(index) : keys[index];
      const property = Object.getOwnPropertyDescriptor(node, key);
      requireValue(!property || 'value' in property, 'MODEL_INPUT_INVALID', 'The model wire must not invoke getters.');
      const item = property?.value; const omitted = item === undefined || typeof item === 'function' || typeof item === 'symbol';
      if (!array && omitted) continue;
      if (entries++) add(1);
      if (!array) { string(key); add(1); }
      if (omitted) add(4); else visit(item, depth + 1);
    }
    active.delete(node);
  }
  visit(value);
  const approxInputTokens = Math.ceil(jsonCodeUnits / 4);
  if (contextLimit !== undefined) requireValue(approxInputTokens + maxOutputTokens <= contextLimit, 'MODEL_CONTEXT_LIMIT', 'The request and reserved output exceed the accepted operation context window.');
  return Object.freeze({ requestBytes, jsonCodeUnits, approxInputTokens });
}
module.exports = { createModelOperationBudget, isModelOperationBudget, assertModelOperationBudget, modelOperationContextLimit, checkModelOperationBudget, reserveModelOperationWire, notifyModelOperationDispatch, measureModelJson };
