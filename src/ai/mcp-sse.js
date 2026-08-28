'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
  assertMcpUrl,
  parseMessages,
  defaultRequestFn,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} = require('./mcp-http');
const { makeSafeLookup, sameOrigin, redactSensitive } = require('./network-security');
const { createMcpRpcDispatcher } = require('./mcp-rpc');
const { LATEST_PROTOCOL_VERSION, buildClientCapabilities, validateNegotiatedVersion } = require('./mcp-protocol');

const BODY_MAX = 1024 * 1024;

function parseEndpointEvent(bodyText) {
  const text = String(bodyText || '');
  if (!text) return null;
  let eventName = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
    if (line.startsWith('data:') && eventName === 'endpoint') {
      const data = line.slice(5).trim();
      if (data) return data;
    }
    if (!line.trim()) eventName = '';
  }
  return null;
}

function resolveEndpointUrl(baseUrl, endpoint) {
  const data = String(endpoint || '').trim();
  if (!data) return baseUrl;
  try { return new URL(data, baseUrl).href; } catch { return data; }
}

function mergeHeaders(staticHeaders, dynamicHeaders, hasAuthProvider) {
  const out = { ...(staticHeaders || {}) };
  if (hasAuthProvider) for (const key of Object.keys(out)) if (String(key).toLowerCase() === 'authorization') delete out[key];
  for (const [key, value] of Object.entries(dynamicHeaders || {})) {
    if (String(key).toLowerCase() === 'authorization') for (const existing of Object.keys(out)) if (String(existing).toLowerCase() === 'authorization') delete out[existing];
    out[key] = String(value);
  }
  return out;
}

function httpStatusError(status, bodyText) {
  const error = new Error(`MCP SSE HTTP ${status}`);
  error.code = Number(status) === 401 ? 'MCP_AUTH_REQUIRED' : `MCP_HTTP_${status}`;
  if (Number(status) === 404 || Number(status) === 410) error.code = 'MCP_SESSION_EXPIRED';
  error.detail = redactSensitive(String(bodyText || '').slice(0, 200));
  return error;
}

/** Open an SSE stream and resolve once the endpoint event (or a bounded wait) arrives. */
function defaultOpenSseFn(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { reject(error); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { ...(opts.headers || {}) };
    if (!headers.Accept && !headers.accept) headers.Accept = 'text/event-stream';
    const waitMs = Number.isFinite(Number(opts.endpointWaitMs)) && Number(opts.endpointWaitMs) > 0 ? Number(opts.endpointWaitMs) : 5_000;
    let settled = false;
    let closed = false;
    let chunks = [];
    let bodyBytes = 0;
    let pendingText = '';
    let req;
    let timer;
    let onAbort = null;
    const listeners = new Set();
    const errorListeners = new Set();
    const closeListeners = new Set();
    const emitError = (error) => {
      for (const listener of errorListeners) {
        try { listener(error); } catch { /* ignore listener errors */ }
      }
    };
    const emitClose = () => {
      for (const listener of closeListeners) {
        try { listener(); } catch { /* ignore listener errors */ }
      }
    };
    const emitData = (chunk) => {
      pendingText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      pendingText = pendingText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const parts = pendingText.split('\n\n');
      pendingText = parts.pop() || '';
      for (const part of parts) {
        const messages = parseMessages(part, { 'content-type': 'text/event-stream' });
        for (const message of messages) for (const listener of listeners) listener(message);
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      resolve({
        bodyText: Buffer.concat(chunks).toString('utf8'),
        close: () => { if (!closed) { closed = true; try { req.destroy(); } catch { /* ignore */ } } },
        onMessage: (listener) => { if (typeof listener === 'function') listeners.add(listener); return () => listeners.delete(listener); },
        onError: (listener) => { if (typeof listener === 'function') errorListeners.add(listener); return () => errorListeners.delete(listener); },
        onClose: (listener) => { if (typeof listener === 'function') closeListeners.add(listener); return () => closeListeners.delete(listener); },
      });
    };
    req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
      lookup: opts.lookup || makeSafeLookup(opts.dnsLookup, { allowPrivate: opts.allowPrivate === true }),
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 400) {
        const bad = [];
        res.on('data', (c) => bad.push(c));
        res.on('end', () => { if (!settled) { settled = true; reject(httpStatusError(status, Buffer.concat(bad).toString('utf8'))); } });
        return;
      }
      timer = setTimeout(finish, waitMs);
      res.on('data', (chunk) => {
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > BODY_MAX) {
          const error = new Error('MCP SSE response too large');
          error.code = 'MCP_RESPONSE_TOO_LARGE';
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            req.destroy(error);
            reject(error);
          } else {
            emitError(error);
          }
          return;
        }
        chunks.push(chunk);
        emitData(chunk);
        if (parseEndpointEvent(Buffer.concat(chunks).toString('utf8'))) finish();
      });
      res.on('end', () => { if (!settled) finish(); else emitClose(); });
      res.on('error', (error) => { if (!settled) { settled = true; reject(error); } else emitError(error); });
    });
    onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      try { req.destroy(error); } catch { /* ignore */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); reject(new Error('aborted')); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } else emitError(error); });
    req.end();
  });
}

function createMcpSseClient(opts = {}) {
  const url = String(opts.url || '').trim();
  const sseUrl = String(opts.sseUrl || opts.url || '').trim();
  const extraHeaders = opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers) ? { ...opts.headers } : {};
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS;
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequestFn;
  const openSseFn = typeof opts.openSseFn === 'function' ? opts.openSseFn : defaultOpenSseFn;
  const allowPrivate = opts.allowPrivate === true;
  const authProvider = opts.authProvider && typeof opts.authProvider === 'object' ? opts.authProvider : null;
  let closed = false;
  let started = false;
  let messageUrl = url;
  let sseHandle = null;
  let sseUnsubscribe = null;
  let rpc = null;
  let serverCapabilities = {};
  let negotiatedProtocolVersion = '';
  let reconnecting = null;
  let sseErrorUnsubscribe = null;
  let sseCloseUnsubscribe = null;
  let transportErrorReported = false;

  function reportTransportError(error) {
    if (closed || reconnecting || transportErrorReported) return;
    transportErrorReported = true;
    started = false;
    try { rpc?.close(error instanceof Error ? error : new Error(String(error))); } catch { /* ignore */ }
    opts.onTransportError?.(error);
  }

  function baseHeaders(dynamicHeaders) {
    const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...mergeHeaders(extraHeaders, dynamicHeaders, Boolean(authProvider)) };
    if (negotiatedProtocolVersion) headers['MCP-Protocol-Version'] = negotiatedProtocolVersion;
    return headers;
  }

  async function rawPost(message, { expectResponse = true } = {}) {
    if (closed) throw new Error('MCP client closed');
    assertMcpUrl(messageUrl, { allowPrivate });
    let retried = false;
    while (true) {
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized, 'utf8') > BODY_MAX) {
        const error = new Error('MCP request too large');
        error.code = 'MCP_REQUEST_TOO_LARGE';
        throw error;
      }
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort?.(), timeoutMs);
      try {
        const dynamicHeaders = authProvider?.getHeaders ? await authProvider.getHeaders() : {};
        const res = await requestFn(messageUrl, { method: 'POST', headers: baseHeaders(dynamicHeaders), body: serialized, signal: controller?.signal, allowPrivate, lookup: opts.lookup, dnsLookup: opts.dnsLookup, onMessage: expectResponse ? (inbound) => rpc?.dispatch(inbound) : undefined });
        if (Number(res?.status) === 401 && !retried) {
          if (!authProvider?.refresh) throw httpStatusError(401, res?.bodyText);
          retried = true;
          if (await authProvider.refresh() === false) throw httpStatusError(401, res?.bodyText);
          continue;
        }
        if (Number(res?.status) === 401) throw httpStatusError(401, res?.bodyText);
        if (Number(res?.status) === 404 || Number(res?.status) === 410) throw httpStatusError(res.status, res.bodyText);
        if (Number(res?.status) >= 400) throw httpStatusError(res.status, res.bodyText);
        if (expectResponse && res?.streamedMessages !== true) for (const inbound of parseMessages(res?.bodyText, res?.headers || {})) rpc?.dispatch(inbound);
        return res;
      } catch (error) {
        if (closed) throw new Error('MCP client closed');
        if (error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))) { const timeoutError = new Error(`MCP request timeout: ${message.method || 'request'}`); timeoutError.code = 'MCP_TIMEOUT'; reportTransportError(timeoutError); throw timeoutError; }
        reportTransportError(error);
        throw error;
      } finally { clearTimeout(timer); }
    }
  }

  function makeDispatcher() {
    rpc = createMcpRpcDispatcher({
      timeoutMs,
      send: (message) => rawPost(message, { expectResponse: true }),
      requestHandler: async (method, params, _message, signal) => {
        if (method === 'roots/list') {
          const provider = opts.rootsProvider || opts.getRoots;
          if (!provider) { const e = new Error('roots unavailable'); e.code = 'MCP_METHOD_NOT_FOUND'; throw e; }
          return provider(params, signal);
        }
        if (method === 'sampling/createMessage' && typeof opts.samplingHandler === 'function') {
          if (params?.task && (negotiatedProtocolVersion !== LATEST_PROTOCOL_VERSION || opts.tasksEnabled !== true)) {
            const error = new Error('MCP Tasks require protocol 2025-11-25');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          if (!serverCapabilities || typeof serverCapabilities.sampling !== 'object') {
            const error = new Error('MCP server did not declare sampling capability');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          return opts.samplingHandler(params, signal);
        }
        if (method === 'elicitation/create' && typeof opts.elicitationHandler === 'function') {
          if (negotiatedProtocolVersion !== LATEST_PROTOCOL_VERSION) {
            const error = new Error('MCP Elicitation requires protocol 2025-11-25');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          return opts.elicitationHandler(params, signal);
        }
        if (['tasks/get', 'tasks/result', 'tasks/list', 'tasks/cancel'].includes(method)
          && typeof opts.taskHandler === 'function') {
          if (negotiatedProtocolVersion !== LATEST_PROTOCOL_VERSION || opts.tasksEnabled !== true) {
            const error = new Error('MCP Tasks require protocol 2025-11-25');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          return opts.taskHandler(method, params, signal);
        }
        const error = new Error(`MCP method not found: ${method}`); error.code = 'MCP_METHOD_NOT_FOUND'; throw error;
      },
      notificationHandler: (method, params, message) => {
        if (method === 'notifications/elicitation/complete') opts.elicitationComplete?.(params, message);
        opts.notificationHandler?.(method, params, message);
      },
      onError: opts.onError,
    });
  }

  async function openStream() {
    let retried = false;
    while (true) {
      try {
        const dynamicHeaders = authProvider?.getHeaders ? await authProvider.getHeaders() : {};
        return await openSseFn(sseUrl || url, { headers: mergeHeaders({ Accept: 'text/event-stream', ...extraHeaders }, dynamicHeaders, Boolean(authProvider)), allowPrivate, lookup: opts.lookup, dnsLookup: opts.dnsLookup });
      } catch (error) {
        if (error?.code === 'MCP_AUTH_REQUIRED' && !retried && authProvider?.refresh) {
          retried = true;
          if (await authProvider.refresh() !== false) continue;
        }
        throw error;
      }
    }
  }

  function bindSse(handle) {
    sseHandle = handle && typeof handle === 'object' ? handle : null;
    const bodyText = String(handle?.bodyText || handle || '');
    for (const inbound of parseMessages(bodyText, { 'content-type': 'text/event-stream' })) rpc?.dispatch(inbound);
    if (typeof handle?.onMessage === 'function') sseUnsubscribe = handle.onMessage((message) => rpc?.dispatch(message));
    else if (typeof handle?.onData === 'function') sseUnsubscribe = handle.onData((chunk) => { for (const message of parseMessages(chunk, { 'content-type': 'text/event-stream' })) rpc?.dispatch(message); });
    if (typeof handle?.onError === 'function') sseErrorUnsubscribe = handle.onError((error) => reportTransportError(error || new Error('MCP SSE stream error')));
    if (typeof handle?.onClose === 'function') sseCloseUnsubscribe = handle.onClose(() => reportTransportError(Object.assign(new Error('MCP SSE stream closed'), { code: 'MCP_SSE_CLOSED' })));
    const endpoint = parseEndpointEvent(bodyText);
    messageUrl = endpoint ? resolveEndpointUrl(sseUrl || url, endpoint) : url;
    assertMcpUrl(messageUrl, { allowPrivate });
    if (!sameOrigin(url, messageUrl)) { const e = new Error('MCP SSE endpoint must use the same origin'); e.code = 'MCP_ENDPOINT_ORIGIN'; throw e; }
  }

  async function start() {
    if (started) return;
    if (closed) throw new Error('MCP client closed');
    if (!url) throw new Error('MCP url required');
    assertMcpUrl(url, { allowPrivate });
    assertMcpUrl(sseUrl || url, { allowPrivate });
    if (!sameOrigin(url, sseUrl || url)) { const e = new Error('MCP SSE endpoint must use the same origin'); e.code = 'MCP_ENDPOINT_ORIGIN'; throw e; }
    makeDispatcher();
    transportErrorReported = false;
    try {
      bindSse(await openStream());
      const result = await rpc.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: buildClientCapabilities({
          ...opts,
          elicitation: opts.elicitation || { form: true, url: true },
          tasksEnabled: opts.tasksEnabled === true,
        }),
        clientInfo: { name: 'codex-qq', version: '1.0.0' },
      }, { replayable: true });
      negotiatedProtocolVersion = validateNegotiatedVersion(result?.protocolVersion);
      serverCapabilities = result?.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
      await rpc.notify('notifications/initialized', {});
      started = true;
    } catch (error) {
      try { rpc?.close(error); } catch { /* ignore */ }
      try { sseHandle?.close?.(); } catch { /* ignore */ }
      sseHandle = null;
      throw error;
    }
  }

  async function reconnect(reason) {
    if (closed) throw new Error('MCP client closed');
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      started = false;
      try { sseUnsubscribe?.(); } catch { /* ignore */ }
      try { sseErrorUnsubscribe?.(); } catch { /* ignore */ }
      try { sseCloseUnsubscribe?.(); } catch { /* ignore */ }
      sseUnsubscribe = null;
      sseErrorUnsubscribe = null;
      sseCloseUnsubscribe = null;
      try { sseHandle?.close?.(); } catch { /* ignore */ }
      sseHandle = null;
      try { rpc?.close(new Error(`MCP reconnect: ${reason || 'transport error'}`)); } catch { /* ignore */ }
      serverCapabilities = {};
      messageUrl = url;
      await start();
    })();
    try { await reconnecting; } finally { reconnecting = null; }
  }
  function request(method, params, requestOptions) { if (closed) return Promise.reject(new Error('MCP client closed')); if (!rpc || !started) return Promise.reject(new Error('MCP client not started')); return rpc.request(method, params, requestOptions); }
  function notify(method, params) { if (closed) return Promise.reject(new Error('MCP client closed')); if (!rpc || !started) return Promise.reject(new Error('MCP client not started')); return rpc.notify(method, params); }
  async function listTools() { const result = await request('tools/list', {}, { replayable: true }); return Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []); }
  async function callTool(name, args, requestOptions = {}) {
    const params = { name: String(name || ''), arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
    if (requestOptions.task && negotiatedProtocolVersion === LATEST_PROTOCOL_VERSION) params.task = {
      ttl: Number.isFinite(Number(requestOptions.task.ttl)) ? Math.floor(Number(requestOptions.task.ttl)) : undefined,
    };
    if (params.task && params.task.ttl == null) delete params.task.ttl;
    return request('tools/call', params, { ...requestOptions, replayable: false });
  }
  function getTask(taskId, requestOptions = {}) { return request('tasks/get', { taskId: String(taskId || '') }, { ...requestOptions, replayable: false }); }
  function getTaskResult(taskId, requestOptions = {}) { return request('tasks/result', { taskId: String(taskId || '') }, { ...requestOptions, replayable: false }); }
  function listTasks(cursor, requestOptions = {}) { return request('tasks/list', cursor ? { cursor: String(cursor) } : {}, { ...requestOptions, replayable: true }); }
  function cancelTask(taskId, requestOptions = {}) { return request('tasks/cancel', { taskId: String(taskId || '') }, { ...requestOptions, replayable: false }); }
  async function listResources() { try { const result = await request('resources/list', {}, { replayable: true }); return Array.isArray(result?.resources) ? result.resources : []; } catch { return []; } }
  async function readResource(uri, requestOptions = {}) { return request('resources/read', { uri: String(uri || '') }, { ...requestOptions, replayable: false }); }
  async function listPrompts() { const result = await request('prompts/list', {}, { replayable: true }); return Array.isArray(result?.prompts) ? result.prompts : []; }
  async function getPrompt(name, args, requestOptions = {}) { return request('prompts/get', { name: String(name || ''), arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} }, { ...requestOptions, replayable: false }); }
  async function notifyRootsChanged() { return notify('notifications/roots/list_changed', {}); }
  async function close() { closed = true; started = false; try { sseUnsubscribe?.(); } catch { /* ignore */ } try { sseErrorUnsubscribe?.(); } catch { /* ignore */ } try { sseCloseUnsubscribe?.(); } catch { /* ignore */ } try { sseHandle?.close?.(); } catch { /* ignore */ } sseHandle = null; try { rpc?.close(); } catch { /* ignore */ } }

  return { start, reconnect, request, notify, listTools, callTool, getTask, getTaskResult, listTasks, cancelTask, listResources, readResource, listPrompts, getPrompt, notifyRootsChanged, getServerCapabilities: () => ({ ...serverCapabilities }), getProtocolVersion: () => negotiatedProtocolVersion || null, close };
}

module.exports = { createMcpSseClient, parseEndpointEvent, resolveEndpointUrl, defaultOpenSseFn, PROTOCOL_VERSION, REQUEST_TIMEOUT_MS, BODY_MAX };
