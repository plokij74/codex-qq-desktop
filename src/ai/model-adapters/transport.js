'use strict';

const { ModelError, requireValue, bytes, parseJson, safeError } = require('./common');
const { assertModelOperationBudget, checkModelOperationBudget, reserveModelOperationWire, notifyModelOperationDispatch, measureModelJson } = require('../model-operation-budget');
function createRequestContext({ signal, timeoutMs, limits, onEvent, operationBudget, operationInfo, resolveHeaders, deadlineAt }) {
  assertModelOperationBudget(operationBudget);
  const controller = new AbortController(); let reader = null; let readerClosed = false; let response = null; let cleanup; let disposal; let fetchCleanup;
  const releases = [];
  let partialOutput = ''; let partialBytes = 0; const partialLimit = Math.min(limits.maxResponseBytes, 64 * 1024);
  const abort = () => controller.abort(new ModelError('ABORTED', 'The model request was cancelled.'));
  const timeout = () => controller.abort(new ModelError('MODEL_TIMEOUT', 'The model request exceeded its deadline.'));
  const deadline = Math.min(Date.now() + timeoutMs, Number.isFinite(deadlineAt) ? deadlineAt : Infinity);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
  const checkSignal = () => { if (!controller.signal.aborted && Date.now() >= deadline) timeout(); if (controller.signal.aborted) throw controller.signal.reason; };
  const info = (fields) => ({ ...operationInfo, ...fields, signal: controller.signal });
  const context = {
    signal: controller.signal, limits, checkSignal,
    get partialOutput() { return partialOutput; },
    onEvent(event) {
      context.check();
      if (event?.type === 'text-delta' && typeof event.delta === 'string' && partialBytes < partialLimit) {
        for (const character of event.delta) { const size = bytes(character); if (partialBytes + size > partialLimit) break; partialOutput += character; partialBytes += size; }
      }
      if (typeof onEvent === 'function') onEvent(event);
    },
    // Existing adapter checks remain synchronous; only explicit operation stages await main.
    check(fields) {
      checkSignal();
      if (operationBudget !== undefined && ['prepare', 'dispatch'].includes(fields?.stage)) return (async () => {
        await checkModelOperationBudget(operationBudget, info(fields)); checkSignal();
      })();
    },
    wait(promise) {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      return new Promise((resolve, reject) => {
        const stopped = () => { controller.signal.removeEventListener('abort', stopped); reject(controller.signal.reason); };
        controller.signal.addEventListener('abort', stopped, { once: true });
        Promise.resolve(promise).then((value) => { controller.signal.removeEventListener('abort', stopped); if (controller.signal.aborted) reject(controller.signal.reason); else resolve(value); }, (error) => { controller.signal.removeEventListener('abort', stopped); reject(error); });
      });
    },
    setResponse(value) {
      response = value;
      if (readerClosed) { try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {} }
    },
    getReader(res) {
      requireValue(!reader && !readerClosed, 'MODEL_PROTOCOL_ERROR', 'The response body cannot be read twice.');
      reader = res?.body?.getReader?.(); requireValue(reader, 'MODEL_PROTOCOL_ERROR', 'The model response has no readable body.'); return reader;
    },
    closeReader() {
      if (readerClosed) return cleanup; readerClosed = true;
      cleanup = (async () => {
        try { if (reader) await reader.cancel?.(); else await response?.body?.cancel?.(); } catch { /* Cancellation must not replace the original request outcome. */ }
        finally { if (reader) { try { reader.releaseLock?.(); } catch {} } }
      })();
      return cleanup;
    },
    dispose() {
      if (!disposal) disposal = (async () => {
        // Guard/reservation calls are awaited directly, never raced against abort.
        // E5 also waits for the aborted physical fetch before releasing its lease/copy.
        try { await fetchCleanup; await context.closeReader(); }
        finally {
          try { while (releases.length) { try { await releases.pop()(); } catch { /* Cleanup cannot replace the original outcome. */ } } }
          finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        }
      })();
      return disposal;
    },
  };
  if (operationBudget !== undefined) {
    context.resolveHeaders = resolveHeaders;
    context.prepareWire = async (body) => {
      checkSignal();
      const measured = measureModelJson(body, { maxRequestBytes: limits.maxRequestBytes, contextLimit: operationInfo.contextLimit, maxOutputTokens: operationInfo.maxOutputTokens });
      const release = await reserveModelOperationWire(operationBudget, info({ stage: 'wire', ...measured, stringBytes: 2 * measured.jsonCodeUnits }));
      if (release) releases.push(release);
      checkSignal(); return measured;
    };
    context.validateWire = ({ approxInputTokens }) => requireValue(approxInputTokens + operationInfo.maxOutputTokens <= operationInfo.contextLimit, 'MODEL_CONTEXT_LIMIT', 'The request and reserved output exceed the accepted operation context window.');
    context.trackFetch = (promise) => { fetchCleanup = Promise.resolve(promise).then(() => {}, () => {}); };
    context.onDispatch = (fields) => notifyModelOperationDispatch(operationBudget, info(fields));
  }
  return context;
}
function header(response, name) { if (typeof response?.headers?.get === 'function') return response.headers.get(name); return response?.headers?.[name] || null; }
function safeHeaders(response, sentHeaders = {}) {
  const { safeRequestId, safeRetryAfterMs } = require('../model-errors');
  const credentials = Object.entries(sentHeaders).filter(([name]) => /^(authorization|x-api-key)$/i.test(name)).map(([, value]) => String(value).replace(/^Bearer /i, '')).filter(Boolean);
  const safe = (value) => typeof value === 'string' && !credentials.some((credential) => value.includes(credential));
  const rawRequestId = header(response, 'x-request-id') || header(response, 'request-id'); const retryAfter = header(response, 'retry-after');
  const requestId = safe(rawRequestId) ? safeRequestId(rawRequestId) : undefined;
  const retryAfterMs = safe(retryAfter) ? safeRetryAfterMs(retryAfter) : undefined;
  return { ...(requestId !== undefined ? { requestId } : {}), ...(retryAfterMs !== undefined ? { retryAfter: retryAfterMs / 1000, retryAfterMs } : {}) };
}
async function postJson({ url, body, headers, fetchFn, context, onAttempt }) {
  if (context.prepareWire) await context.prepareWire(body);
  const encoded = JSON.stringify(body); const requestBytes = bytes(encoded);
  requireValue(requestBytes <= context.limits.maxRequestBytes, 'MODEL_LIMIT_EXCEEDED', 'The model request exceeds the encoded body limit.');
  const wire = { requestBytes, approxInputTokens: Math.ceil(encoded.length / 4) };
  context.validateWire?.(wire); context.checkSignal();
  const fetchImpl = fetchFn || globalThis.fetch; requireValue(typeof fetchImpl === 'function', 'MODEL_CONNECTION_FAILED', 'No model transport is available.');
  const sentHeaders = context.resolveHeaders ? { ...headers, ...await context.resolveHeaders() } : headers;
  // Do not race this await with cancellation: main guard cleanup owns the lease.
  await context.check({ stage: 'dispatch', ...wire });
  // A stop/deadline can occur while main's async check is waiting (or block its timer).
  // No await or notification is allowed between this independent check and fetch.
  context.checkSignal();
  let physical; const attemptId = onAttempt();
  try { physical = Promise.resolve(fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...sentHeaders }, body: encoded, redirect: 'error', signal: context.signal })); }
  catch (error) { physical = Promise.reject(error); }
  finally { context.onDispatch?.({ stage: 'dispatch', ...wire, attemptId }); }
  const pendingFetch = physical.then((response) => { context.setResponse(response); return response; });
  context.trackFetch?.(pendingFetch);
  const response = await context.wait(pendingFetch); context.check();
  if (response?.redirected || response?.url && new URL(response.url).href !== new URL(url).href || response?.status >= 300 && response?.status < 400) throw new ModelError('MODEL_REDIRECT_REFUSED', 'The model endpoint redirected the request.');
  requireValue(response && Number.isInteger(response.status), 'MODEL_PROTOCOL_ERROR', 'The model endpoint returned no response.');
  if (response.status < 200 || response.status >= 300) {
    const status = response.status; const code = ({ 400: 'MODEL_BAD_REQUEST', 401: 'MODEL_AUTH_FAILED', 403: 'MODEL_FORBIDDEN', 404: 'MODEL_NOT_FOUND', 429: 'MODEL_RATE_LIMITED' })[status] || 'MODEL_UPSTREAM_ERROR';
    throw new ModelError(code, `The model endpoint returned HTTP ${status}.`, { status, ...safeHeaders(response, sentHeaders) });
  }
  const length = header(response, 'content-length'); if (length && /^\d+$/.test(length)) requireValue(Number(length) <= context.limits.maxResponseBytes, 'MODEL_LIMIT_EXCEEDED', 'The model response exceeds its byte limit.');
  return response;
}
function decodeUtf8(decoder, value, stream = false) { try { return decoder.decode(value, { stream }); } catch { throw new ModelError('MODEL_PROTOCOL_ERROR', 'The model response contains invalid UTF-8.'); } }
async function readJson(response, context) {
  let text = ''; let total = 0;
  if (!response?.body?.getReader) { requireValue(typeof response?.text === 'function', 'MODEL_PROTOCOL_ERROR'); text = await context.wait(response.text()); requireValue(typeof text === 'string' && bytes(text) <= context.limits.maxResponseBytes, 'MODEL_LIMIT_EXCEEDED', 'The model response exceeds its byte limit.'); }
  else { const reader = context.getReader(response); const decoder = new TextDecoder('utf-8', { fatal: true }); for (;;) { const { done, value } = await context.wait(reader.read()); if (done) break; requireValue(value instanceof Uint8Array, 'MODEL_PROTOCOL_ERROR'); total += value.byteLength; requireValue(total <= context.limits.maxResponseBytes, 'MODEL_LIMIT_EXCEEDED', 'The model response exceeds its byte limit.'); text += decodeUtf8(decoder, value, true); } text += decodeUtf8(decoder); }
  context.check(); requireValue(text.trim().length > 0, 'MODEL_PROTOCOL_ERROR', 'The model endpoint returned an empty body.'); return parseJson(text);
}
async function* readSse(response, context) {
  const reader = context.getReader(response); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = ''; let total = 0; let lineStart = 0; let scanned = 0;
  function nextBoundary(eof) {
    const newline = /\r\n|\n|\r/g; newline.lastIndex = scanned; let match;
    while ((match = newline.exec(buffer))) {
      if (match[0] === '\r' && match.index === buffer.length - 1 && !eof) { scanned = match.index; return null; }
      if (match.index === lineStart) { lineStart = 0; scanned = 0; return { position: match.index, length: match[0].length }; }
      lineStart = newline.lastIndex;
    }
    scanned = buffer.length; return null;
  }
  function frame(value) { requireValue(bytes(value) <= context.limits.maxFrameBytes, 'MODEL_LIMIT_EXCEEDED', 'The model event frame exceeds its byte limit.'); let event = ''; const data = []; for (const line of value.split(/\r\n|\n|\r/)) { if (line.startsWith(':')) continue; const colon = line.indexOf(':'); const name = colon < 0 ? line : line.slice(0, colon); const content = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, ''); if (name === 'event') event = content; if (name === 'data') data.push(content); } return data.length ? { event, data: data.join('\n') } : null; }
  for (;;) {
    context.check(); const { done, value } = await context.wait(reader.read());
    if (!done) { requireValue(value instanceof Uint8Array, 'MODEL_PROTOCOL_ERROR'); total += value.byteLength; requireValue(total <= context.limits.maxResponseBytes, 'MODEL_LIMIT_EXCEEDED', 'The model response exceeds its byte limit.'); buffer += decodeUtf8(decoder, value, true); } else buffer += decodeUtf8(decoder);
    let boundary; while ((boundary = nextBoundary(done))) { const current = buffer.slice(0, boundary.position); buffer = buffer.slice(boundary.position + boundary.length); const parsed = frame(current); if (parsed) yield parsed; context.check(); }
    // A split CRLF blank-line delimiter is framing, not part of the event.
    const pendingDelimiterBytes = buffer.endsWith('\r') && lineStart === buffer.length - 1 ? 1 : 0;
    requireValue(bytes(buffer) - pendingDelimiterBytes <= context.limits.maxFrameBytes, 'MODEL_LIMIT_EXCEEDED', 'The model event frame exceeds its byte limit.');
    if (done) { requireValue(!buffer.trim(), 'MODEL_PROTOCOL_ERROR', 'The model stream ended inside an event frame.'); return; }
  }
}
module.exports = { createRequestContext, postJson, readJson, readSse, safeHeaders, safeError };
