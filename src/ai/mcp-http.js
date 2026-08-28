'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { checkUrl } = require('./url-guard');
const { makeSafeLookup, redactSensitive } = require('./network-security');
const { createMcpRpcDispatcher, rpcError } = require('./mcp-rpc');
const { LATEST_PROTOCOL_VERSION, buildClientCapabilities, validateNegotiatedVersion } = require('./mcp-protocol');

const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
const REQUEST_TIMEOUT_MS = 60_000;
const BODY_MAX = 1024 * 1024;

function assertMcpUrl(rawUrl, { allowPrivate = false } = {}) {
  const checked = checkUrl(rawUrl, { allowPrivate });
  if (!checked.ok) {
    const code = checked.code === 'PRIVATE_IP' || checked.code === 'PORT' ? 'MCP_SSRF_PRIVATE' : checked.code;
    const error = new Error(`MCP URL 不合法（${code}）：${checked.reason}`);
    error.code = code;
    throw error;
  }
  return checked;
}

function mergeHeaders(staticHeaders, dynamicHeaders, hasAuthProvider) {
  const out = { ...(staticHeaders || {}) };
  if (hasAuthProvider) {
    for (const key of Object.keys(out)) if (String(key).toLowerCase() === 'authorization') delete out[key];
  }
  for (const [key, value] of Object.entries(dynamicHeaders || {})) {
    if (String(key).toLowerCase() === 'authorization') {
      for (const existing of Object.keys(out)) if (String(existing).toLowerCase() === 'authorization') delete out[existing];
    }
    out[key] = String(value);
  }
  return out;
}

function httpStatusError(status, bodyText) {
  const error = new Error(`MCP HTTP ${status}`);
  error.code = Number(status) === 401 ? 'MCP_AUTH_REQUIRED' : `MCP_HTTP_${status}`;
  if (Number(status) === 404 || Number(status) === 410) error.code = 'MCP_SESSION_EXPIRED';
  error.detail = redactSensitive(String(bodyText || '').slice(0, 200));
  return error;
}

function parseSseOrJson(bodyText, headers) {
  const text = String(bodyText || '').trim();
  if (!text) return null;
  const ct = String((headers && (headers['content-type'] || headers['Content-Type'])) || '').toLowerCase();
  if (ct.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { return JSON.parse(data); } catch { /* next event */ }
    }
  }
  try { return JSON.parse(text); } catch { return null; }
}

function parseMessages(bodyText, headers) {
  const text = String(bodyText || '').trim();
  if (!text) return [];
  const ct = String((headers && (headers['content-type'] || headers['Content-Type'])) || '').toLowerCase();
  if (ct.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const messages = [];
    let dataLines = [];
    const flush = () => {
      const data = dataLines.join('\n').trim();
      dataLines = [];
      if (!data || data === '[DONE]') return;
      try { messages.push(JSON.parse(data)); } catch { /* ignore malformed event */ }
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      else if (!line.trim()) flush();
    }
    flush();
    return messages;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function defaultRequestFn(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { reject(error); return; }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = { ...(opts.headers || {}) };
    const body = opts.body != null ? String(opts.body) : '';
    if (body && !headers['Content-Length'] && !headers['content-length']) headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'POST',
      headers,
      servername: isHttps ? parsed.hostname : undefined,
      lookup: opts.lookup || makeSafeLookup(opts.dnsLookup, { allowPrivate: opts.allowPrivate === true }),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const streamMessages = contentType.includes('text/event-stream') && typeof opts.onMessage === 'function';
      let pendingEvents = '';
      const dispatchEvents = (flush = false) => {
        if (!streamMessages) return;
        pendingEvents = pendingEvents.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const events = pendingEvents.split('\n\n');
        pendingEvents = flush ? '' : (events.pop() || '');
        for (const event of events) {
          for (const message of parseMessages(`${event}\n\n`, { 'content-type': 'text/event-stream' })) {
            try { opts.onMessage(message); } catch { /* dispatcher owns handler errors */ }
          }
        }
        if (flush && pendingEvents.trim()) {
          for (const message of parseMessages(pendingEvents, { 'content-type': 'text/event-stream' })) {
            try { opts.onMessage(message); } catch { /* dispatcher owns handler errors */ }
          }
        }
      };
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= BODY_MAX) {
          chunks.push(chunk);
          if (streamMessages) {
            pendingEvents += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
            dispatchEvents(false);
          }
        }
        else req.destroy(new Error('MCP response too large'));
      });
      res.on('end', () => {
        dispatchEvents(true);
        opts.signal?.removeEventListener?.('abort', onAbort);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          bodyText: Buffer.concat(chunks).toString('utf8'),
          streamedMessages: streamMessages,
        });
      });
    });
    const onAbort = () => req.destroy(new Error('aborted'));
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); reject(new Error('aborted')); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => {
      opts.signal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    req.end(body || undefined);
  });
}

function createMcpHttpClient(opts = {}) {
  const url = String(opts.url || '').trim();
  const extraHeaders = opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers) ? { ...opts.headers } : {};
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS;
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequestFn;
  const allowPrivate = opts.allowPrivate === true;
  const authProvider = opts.authProvider && typeof opts.authProvider === 'object' ? opts.authProvider : null;
  let closed = false;
  let started = false;
  let rpc = null;
  let serverCapabilities = {};
  let negotiatedProtocolVersion = '';
  let sessionId = '';
  let reconnecting = null;
  let transportErrorReported = false;

  function reportTransportError(error) {
    if (closed || transportErrorReported) return;
    transportErrorReported = true;
    opts.onTransportError?.(error);
  }

  function baseHeaders(dynamicHeaders) {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...mergeHeaders(extraHeaders, dynamicHeaders, Boolean(authProvider)),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (negotiatedProtocolVersion) headers['MCP-Protocol-Version'] = negotiatedProtocolVersion;
    return headers;
  }

  async function rawPost(message, { expectResponse = true } = {}) {
    if (closed) throw new Error('MCP client closed');
    if (!url) throw new Error('MCP url required');
    assertMcpUrl(url, { allowPrivate });
    let retried = false;
    while (true) {
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized, 'utf8') > BODY_MAX) throw rpcError('MCP request too large', -32003);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort?.(), timeoutMs);
      try {
        const dynamicHeaders = authProvider?.getHeaders ? await authProvider.getHeaders() : {};
        const res = await requestFn(url, {
          method: 'POST',
          headers: baseHeaders(dynamicHeaders),
          body: serialized,
          signal: controller?.signal,
          allowPrivate,
          lookup: opts.lookup,
          dnsLookup: opts.dnsLookup,
          onMessage: expectResponse ? (inbound) => rpc?.dispatch(inbound) : undefined,
        });
        const headers = res?.headers || {};
        const returnedSession = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'mcp-session-id')?.[1];
        const sessionText = Array.isArray(returnedSession) ? returnedSession[0] : returnedSession;
        if (sessionText && String(sessionText).length <= 256 && !/[\r\n\t]/.test(String(sessionText))) {
          sessionId = String(sessionText);
        }
        if (Number(res?.status) === 401 && !retried) {
          if (!authProvider?.refresh) throw httpStatusError(401, res?.bodyText);
          retried = true;
          if (await authProvider.refresh() === false) throw httpStatusError(401, res?.bodyText);
          continue;
        }
        if (Number(res?.status) === 401) throw httpStatusError(401, res?.bodyText);
        if (Number(res?.status) === 404 || Number(res?.status) === 410) throw httpStatusError(res.status, res.bodyText);
        if (Number(res?.status) >= 400) throw httpStatusError(res.status, res.bodyText);
        if (expectResponse && res?.streamedMessages !== true) {
          for (const inbound of parseMessages(res?.bodyText, headers)) rpc?.dispatch(inbound);
        }
        return res;
      } catch (error) {
        if (closed) throw new Error('MCP client closed');
        if (error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))) {
          const timeoutError = new Error(`MCP request timeout: ${message.method || 'request'}`);
          timeoutError.code = 'MCP_TIMEOUT';
          reportTransportError(timeoutError);
          throw timeoutError;
        }
        reportTransportError(error);
        throw error;
      } finally { clearTimeout(timer); }
    }
  }

  function makeDispatcher() {
    rpc = createMcpRpcDispatcher({
      timeoutMs,
      // Notifications commonly return an empty 202, while requests return
      // the JSON-RPC response that must be fed back into the dispatcher.
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
        const error = new Error(`MCP method not found: ${method}`);
        error.code = 'MCP_METHOD_NOT_FOUND';
        throw error;
      },
      notificationHandler: (method, params, message) => {
        if (method === 'notifications/elicitation/complete') opts.elicitationComplete?.(params, message);
        opts.notificationHandler?.(method, params, message);
      },
      onError: opts.onError,
    });
  }

  async function start() {
    if (started) return;
    if (closed) throw new Error('MCP client closed');
    if (!url) throw new Error('MCP url required');
    assertMcpUrl(url, { allowPrivate });
    transportErrorReported = false;
    makeDispatcher();
    try {
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
      throw error;
    }
  }

  async function reconnect(reason) {
    if (closed) throw new Error('MCP client closed');
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      started = false;
      try { rpc?.close(new Error(`MCP reconnect: ${reason || 'transport error'}`)); } catch { /* ignore */ }
      if (String(reason || '').toUpperCase().includes('EXPIRED')) sessionId = '';
      serverCapabilities = {};
      await start();
    })();
    try { await reconnecting; } finally { reconnecting = null; }
  }
  function request(method, params, requestOptions) {
    if (closed) return Promise.reject(new Error('MCP client closed'));
    if (!rpc || !started) return Promise.reject(new Error('MCP client not started'));
    return rpc.request(method, params, requestOptions);
  }
  function notify(method, params) {
    if (closed) return Promise.reject(new Error('MCP client closed'));
    if (!rpc || !started) return Promise.reject(new Error('MCP client not started'));
    return rpc.notify(method, params);
  }
  async function listTools() {
    const result = await request('tools/list', {}, { replayable: true });
    return Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []);
  }
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
  async function listResources() {
    try { const result = await request('resources/list', {}, { replayable: true }); return Array.isArray(result?.resources) ? result.resources : []; } catch { return []; }
  }
  async function readResource(uri, requestOptions = {}) { return request('resources/read', { uri: String(uri || '') }, { ...requestOptions, replayable: false }); }
  async function listPrompts() { const result = await request('prompts/list', {}, { replayable: true }); return Array.isArray(result?.prompts) ? result.prompts : []; }
  async function getPrompt(name, args, requestOptions = {}) { return request('prompts/get', { name: String(name || ''), arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} }, { ...requestOptions, replayable: false }); }
  async function notifyRootsChanged() { return notify('notifications/roots/list_changed', {}); }
  async function close() {
    closed = true;
    started = false;
    sessionId = '';
    try { rpc?.close(); } catch { /* ignore */ }
  }

  return {
    start,
    reconnect,
    request,
    notify,
    listTools,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt,
    notifyRootsChanged,
    getServerCapabilities: () => ({ ...serverCapabilities }),
    getProtocolVersion: () => negotiatedProtocolVersion || null,
    getTask,
    getTaskResult,
    listTasks,
    cancelTask,
    getSessionId: () => sessionId ? 'active' : null,
    close,
  };
}

module.exports = {
  createMcpHttpClient,
  assertMcpUrl,
  parseSseOrJson,
  parseMessages,
  defaultRequestFn,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  BODY_MAX,
};
