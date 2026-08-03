'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { checkUrl } = require('./url-guard');

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;

function assertMcpUrl(rawUrl) {
  const checked = checkUrl(rawUrl, { allowPrivate: true });
  if (!checked.ok) {
    throw new Error(`MCP URL 不合法（${checked.code}）：${checked.reason}`);
  }
}

/**
 * Parse JSON body or text/event-stream data lines into a JSON-RPC message.
 * @param {string} bodyText
 * @param {Record<string, string>|object} headers
 * @returns {object|null}
 */
function parseSseOrJson(bodyText, headers) {
  const text = String(bodyText || '').trim();
  if (!text) return null;
  const ct = String(
    (headers && (headers['content-type'] || headers['Content-Type'])) || ''
  ).toLowerCase();

  if (ct.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        return JSON.parse(data);
      } catch {
        /* try next data line */
      }
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Default HTTP(S) request using Node built-ins.
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ status: number, headers: object, bodyText: string }>}
 */
function defaultRequestFn(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const method = opts.method || 'POST';
    const headers = { ...(opts.headers || {}) };
    const body = opts.body != null ? String(opts.body) : '';
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    }

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    const onAbort = () => {
      req.destroy(new Error('aborted'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        reject(new Error('aborted'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.end(body || undefined);
  });
}

/**
 * Minimal Streamable HTTP MCP client (JSON-RPC over POST).
 *
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   requestFn?: Function,
 * }} opts
 */
function createMcpHttpClient(opts = {}) {
  const url = String(opts.url || '').trim();
  const extraHeaders =
    opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers)
      ? { ...opts.headers }
      : {};
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : REQUEST_TIMEOUT_MS;
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequestFn;

  let nextId = 1;
  let closed = false;
  let started = false;

  function baseHeaders() {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  async function postMessage(msg, { expectResponse = true } = {}) {
    if (closed) throw new Error('MCP client closed');
    if (!url) throw new Error('MCP url required');
    assertMcpUrl(url);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    try {
      const res = await requestFn(url, {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify(msg),
        signal: controller ? controller.signal : undefined,
      });

      if (!expectResponse) return null;

      if (res.status >= 400) {
        throw new Error(`MCP HTTP ${res.status}: ${(res.bodyText || '').slice(0, 200)}`);
      }

      // Notifications may return empty / 202
      if (!res.bodyText || !String(res.bodyText).trim()) {
        if (msg.id === undefined) return null;
        throw new Error(`MCP empty response for ${msg.method || 'request'}`);
      }

      const parsed = parseSseOrJson(res.bodyText, res.headers || {});
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`MCP invalid response for ${msg.method || 'request'}`);
      }
      if (parsed.error) {
        const e = new Error(
          (parsed.error && parsed.error.message) || JSON.stringify(parsed.error)
        );
        e.code = parsed.error.code;
        e.data = parsed.error.data;
        throw e;
      }
      return parsed.result;
    } catch (err) {
      if (closed) throw new Error('MCP client closed');
      if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || err)))) {
        throw new Error(`MCP request timeout: ${msg.method || 'request'}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error('MCP client closed'));
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return postMessage(msg, { expectResponse: true });
  }

  async function notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    try {
      await postMessage(msg, { expectResponse: false });
    } catch {
      /* notification best-effort */
    }
  }

  async function start() {
    if (started) return;
    if (closed) throw new Error('MCP client closed');
    if (!url) throw new Error('MCP url required');
    assertMcpUrl(url);

    try {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codex-qq', version: '1.0.0' },
      });
      await notify('notifications/initialized', {});
      started = true;
    } catch (err) {
      close();
      throw err;
    }
  }

  async function listTools() {
    const result = await request('tools/list', {});
    if (Array.isArray(result?.tools)) return result.tools;
    if (Array.isArray(result)) return result;
    return [];
  }

  async function callTool(name, toolArgs) {
    return request('tools/call', {
      name,
      arguments: toolArgs && typeof toolArgs === 'object' ? toolArgs : {},
    });
  }

  async function listResources() {
    try {
      const result = await request('resources/list', {});
      if (Array.isArray(result?.resources)) return result.resources;
      return [];
    } catch {
      return [];
    }
  }

  async function readResource(uri) {
    return request('resources/read', { uri: String(uri || '') });
  }

  function close() {
    closed = true;
    started = false;
  }

  return {
    start,
    listTools,
    callTool,
    listResources,
    readResource,
    close,
  };
}

module.exports = {
  createMcpHttpClient,
  assertMcpUrl,
  parseSseOrJson,
  defaultRequestFn,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
};
