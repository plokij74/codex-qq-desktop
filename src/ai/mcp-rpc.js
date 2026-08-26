'use strict';

// Shared JSON-RPC 2.0 plumbing used by all MCP transports.  Transport code is
// deliberately responsible only for bytes/HTTP; this module owns request
// multiplexing and the host-side server request policy.

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PENDING = 256;
const MAX_ERROR_MESSAGE = 300;

const RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

function rpcError(message, code = RPC_ERRORS.INTERNAL_ERROR, data) {
  const error = new Error(String(message || 'MCP JSON-RPC error'));
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function isRequestMessage(message) {
  return Boolean(
    message && typeof message === 'object' &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    message.id !== undefined && message.id !== null
  );
}

function isNotificationMessage(message) {
  return Boolean(
    message && typeof message === 'object' &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    (message.id === undefined || message.id === null)
  );
}

function isResponseMessage(message) {
  return Boolean(
    message && typeof message === 'object' &&
    message.jsonrpc === '2.0' &&
    message.id !== undefined && message.id !== null &&
    (Object.prototype.hasOwnProperty.call(message, 'result') ||
      Object.prototype.hasOwnProperty.call(message, 'error'))
  );
}

function normalizeInboundError(error) {
  const numericCode = Number.isFinite(Number(error?.code))
    ? Number(error.code)
    : RPC_ERRORS.INTERNAL_ERROR;
  const message = String(error?.message || error || 'MCP request failed')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|code|state)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_ERROR_MESSAGE);
  const payload = { code: numericCode, message };
  if (typeof error?.code === 'string' && error.code && !/^[-+]?\d+$/.test(error.code)) {
    payload.data = { code: error.code };
  }
  return payload;
}

/**
 * Create a transport-independent JSON-RPC dispatcher.
 *
 * `send` receives an already-serializable JSON-RPC object.  Server requests
 * are answered automatically; only explicitly supplied handlers are exposed,
 * and unknown methods receive the standard -32601 response.
 */
function createMcpRpcDispatcher(options = {}) {
  const send = typeof options.send === 'function' ? options.send : async () => {};
  const requestHandler = typeof options.requestHandler === 'function'
    ? options.requestHandler
    : null;
  const notificationHandler = typeof options.notificationHandler === 'function'
    ? options.notificationHandler
    : null;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.min(300_000, Math.max(250, Math.floor(Number(options.timeoutMs))))
    : DEFAULT_TIMEOUT_MS;
  const maxPending = Number.isFinite(Number(options.maxPending)) && Number(options.maxPending) > 0
    ? Math.min(MAX_PENDING, Math.max(1, Math.floor(Number(options.maxPending))))
    : MAX_PENDING;
  const onError = typeof options.onError === 'function' ? options.onError : null;

  let nextId = Number.isFinite(Number(options.startId)) && Number(options.startId) > 0
    ? Math.floor(Number(options.startId))
    : 1;
  let closed = false;
  const pending = new Map();
  const inbound = new Map();

  function sendMessage(message) {
    if (closed) throw rpcError('MCP RPC session closed', -32000);
    return Promise.resolve(send(message));
  }

  function sendCancellation(id, reason) {
    try {
      Promise.resolve(sendMessage({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, reason },
      })).catch((error) => onError?.(error));
    } catch (error) {
      onError?.(error);
    }
  }

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    entry.reject(error);
    return true;
  }

  function resolvePending(id, result, errorPayload) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    if (errorPayload) {
      const error = rpcError(
        errorPayload.message || 'MCP request failed',
        errorPayload.code,
        errorPayload.data,
      );
      entry.reject(error);
    } else {
      entry.resolve(result);
    }
    return true;
  }

  function request(method, params, requestOptions = {}) {
    if (closed) return Promise.reject(rpcError('MCP RPC session closed', -32000));
    if (pending.size >= maxPending) {
      return Promise.reject(rpcError('MCP request limit exceeded', -32001));
    }
    const name = String(method || '').trim();
    if (!name || name.length > 128) {
      return Promise.reject(rpcError('MCP method invalid', RPC_ERRORS.INVALID_REQUEST));
    }
    if (requestOptions?.signal?.aborted) {
      const error = rpcError('MCP request cancelled', -32800);
      error.code = 'MCP_CANCELLED';
      return Promise.reject(error);
    }
    const id = nextId++;
    const signal = requestOptions?.signal;
    const timeout = Number.isFinite(Number(requestOptions?.timeoutMs)) && Number(requestOptions.timeoutMs) > 0
      ? Math.min(300_000, Math.max(250, Math.floor(Number(requestOptions.timeoutMs))))
      : timeoutMs;
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        method: name,
        params,
        replayable: requestOptions?.replayable === true,
        signal,
        timer: null,
        onAbort: null,
      };
      // Register before inspecting the signal. AbortSignal can already be
      // aborted when an inbound request is forwarded, and the cancellation
      // path must still be able to remove/reject this entry.
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
        sendCancellation(id, 'timeout');
        const error = rpcError(`MCP request timeout: ${name}`, -32002);
        error.code = 'MCP_TIMEOUT';
        reject(error);
      }, timeout);
      if (signal) {
        entry.onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          sendCancellation(id, 'cancelled');
          const error = rpcError('MCP request cancelled', -32800);
          error.code = 'MCP_CANCELLED';
          reject(error);
        };
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      try {
        const message = { jsonrpc: '2.0', id, method: name };
        if (params !== undefined) message.params = params;
        Promise.resolve(sendMessage(message)).catch((error) => {
          rejectPending(id, error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        rejectPending(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function notify(method, params) {
    if (closed) return Promise.reject(rpcError('MCP RPC session closed', -32000));
    const name = String(method || '').trim();
    if (!name || name.length > 128) {
      return Promise.reject(rpcError('MCP method invalid', RPC_ERRORS.INVALID_REQUEST));
    }
    const message = { jsonrpc: '2.0', method: name };
    if (params !== undefined) message.params = params;
    try {
      return Promise.resolve(sendMessage(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function handleServerRequest(message) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const inboundId = String(message.id);
    if (controller) inbound.set(inboundId, controller);
    let result;
    let errorPayload;
    try {
      if (!requestHandler) throw rpcError('Method not found', RPC_ERRORS.METHOD_NOT_FOUND);
      result = await requestHandler(message.method, message.params, message, controller?.signal);
    } catch (error) {
      errorPayload = normalizeInboundError(error);
      if (error?.code === 'MCP_METHOD_NOT_FOUND') errorPayload.code = RPC_ERRORS.METHOD_NOT_FOUND;
    } finally {
      if (inbound.get(inboundId) === controller) inbound.delete(inboundId);
    }
    const response = { jsonrpc: '2.0', id: message.id };
    if (errorPayload) response.error = errorPayload;
    else response.result = result === undefined ? null : result;
    try {
      await sendMessage(response);
    } catch (error) {
      onError?.(error);
    }
  }

  function dispatch(message) {
    if (!message || typeof message !== 'object') return false;
    if (isResponseMessage(message)) {
      return resolvePending(message.id, message.result, message.error);
    }
    if (isRequestMessage(message)) {
      // Do not await here: a transport can continue receiving notifications
      // while a sampling callback is waiting for user approval.
      handleServerRequest(message).catch((error) => onError?.(error));
      return true;
    }
    if (isNotificationMessage(message)) {
      if (message.method === 'notifications/cancelled') {
        const requestId = message.params?.requestId;
        const controller = requestId == null ? null : inbound.get(String(requestId));
        if (controller) controller.abort();
      }
      if (notificationHandler) {
        Promise.resolve(notificationHandler(message.method, message.params, message))
          .catch((error) => onError?.(error));
      }
      return true;
    }
    return false;
  }

  function close(error = rpcError('MCP RPC session closed', -32000)) {
    if (closed) return;
    closed = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      try { entry.reject(error); } catch { /* ignore */ }
      pending.delete(id);
    }
    for (const controller of inbound.values()) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    inbound.clear();
  }

  function getPending() {
    return [...pending.entries()].map(([id, entry]) => ({
      id,
      method: entry.method,
      params: entry.params,
      replayable: entry.replayable,
    }));
  }

  return {
    request,
    notify,
    dispatch,
    close,
    getPending,
    isClosed: () => closed,
    pending,
    getInbound: () => [...inbound.keys()],
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  RPC_ERRORS,
  rpcError,
  isRequestMessage,
  isNotificationMessage,
  isResponseMessage,
  normalizeInboundError,
  createMcpRpcDispatcher,
};
