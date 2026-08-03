'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const {
  assertMcpUrl,
  parseSseOrJson,
  defaultRequestFn,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} = require('./mcp-http');

/**
 * Parse SSE text for the first `event: endpoint` data payload.
 * @param {string} bodyText
 * @returns {string|null}
 */
function parseEndpointEvent(bodyText) {
  const text = String(bodyText || '');
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let eventName = '';
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:') && eventName === 'endpoint') {
      const data = line.slice(5).trim();
      if (data) return data;
    }
    if (line === '') eventName = '';
  }
  return null;
}

/**
 * Resolve absolute or relative endpoint against base URL.
 * @param {string} baseUrl
 * @param {string} endpoint
 * @returns {string}
 */
function resolveEndpointUrl(baseUrl, endpoint) {
  const data = String(endpoint || '').trim();
  if (!data) return baseUrl;
  try {
    return new URL(data, baseUrl).href;
  } catch {
    return data;
  }
}

/**
 * Default SSE open: GET url with Accept text/event-stream, collect early body for endpoint.
 * Connection stays open until close().
 * @param {string} url
 * @param {{ headers?: object, signal?: AbortSignal, endpointWaitMs?: number }} opts
 * @returns {Promise<{ bodyText: string, close: () => void }>}
 */
function defaultOpenSseFn(url, opts = {}) {
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
    const headers = { ...(opts.headers || {}) };
    if (!headers.Accept && !headers.accept) {
      headers.Accept = 'text/event-stream';
    }

    const waitMs =
      typeof opts.endpointWaitMs === 'number' && opts.endpointWaitMs > 0
        ? opts.endpointWaitMs
        : 5_000;

    let settled = false;
    let closed = false;
    const chunks = [];
    let req;

    const finish = (bodyText) => {
      if (settled) return;
      settled = true;
      resolve({
        bodyText: bodyText || Buffer.concat(chunks).toString('utf8'),
        close: () => {
          if (closed) return;
          closed = true;
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        },
      });
    };

    req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          const errChunks = [];
          res.on('data', (c) => errChunks.push(c));
          res.on('end', () => {
            if (!settled) {
              settled = true;
              reject(
                new Error(
                  `MCP SSE HTTP ${status}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 200)}`
                )
              );
            }
          });
          return;
        }

        const timer = setTimeout(() => {
          finish(Buffer.concat(chunks).toString('utf8'));
        }, waitMs);

        res.on('data', (c) => {
          chunks.push(c);
          const soFar = Buffer.concat(chunks).toString('utf8');
          if (parseEndpointEvent(soFar)) {
            clearTimeout(timer);
            finish(soFar);
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          finish(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      }
    );

    const onAbort = () => {
      try {
        req.destroy(new Error('aborted'));
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

/**
 * Minimal MCP-over-SSE client: GET SSE for endpoint, POST JSON-RPC messages.
 *
 * @param {{
 *   url: string,
 *   sseUrl?: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   requestFn?: Function,
 *   openSseFn?: Function,
 * }} opts
 */
function createMcpSseClient(opts = {}) {
  const url = String(opts.url || '').trim();
  const sseUrl = String(opts.sseUrl || opts.url || '').trim();
  const extraHeaders =
    opts.headers && typeof opts.headers === 'object' && !Array.isArray(opts.headers)
      ? { ...opts.headers }
      : {};
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : REQUEST_TIMEOUT_MS;
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequestFn;
  const openSseFn = typeof opts.openSseFn === 'function' ? opts.openSseFn : defaultOpenSseFn;

  let nextId = 1;
  let closed = false;
  let started = false;
  /** @type {string} */
  let messageUrl = url;
  /** @type {{ close?: () => void }|null} */
  let sseHandle = null;

  function baseHeaders() {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  async function postMessage(msg, { expectResponse = true } = {}) {
    if (closed) throw new Error('MCP client closed');
    if (!messageUrl) throw new Error('MCP url required');
    assertMcpUrl(messageUrl);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    try {
      const res = await requestFn(messageUrl, {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify(msg),
        signal: controller ? controller.signal : undefined,
      });

      if (!expectResponse) return null;

      if (res.status >= 400) {
        throw new Error(`MCP HTTP ${res.status}: ${(res.bodyText || '').slice(0, 200)}`);
      }

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
    assertMcpUrl(sseUrl || url);

    try {
      const sseHeaders = {
        Accept: 'text/event-stream',
        ...extraHeaders,
      };
      const handle = await openSseFn(sseUrl || url, { headers: sseHeaders });
      sseHandle = handle && typeof handle === 'object' ? handle : null;
      const bodyText =
        handle && typeof handle === 'object' ? String(handle.bodyText || '') : String(handle || '');
      const endpoint = parseEndpointEvent(bodyText);
      if (endpoint) {
        messageUrl = resolveEndpointUrl(sseUrl || url, endpoint);
      } else {
        messageUrl = url;
      }

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
    if (sseHandle && typeof sseHandle.close === 'function') {
      try {
        sseHandle.close();
      } catch {
        /* ignore */
      }
    }
    sseHandle = null;
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
  createMcpSseClient,
  parseEndpointEvent,
  resolveEndpointUrl,
  defaultOpenSseFn,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
};
