'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { checkUrl } = require('./url-guard');
const { makeSafeLookup } = require('./network-security');
const { extractFromHtml } = require('./html-extract');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 524288;
const DEFAULT_MAX_CHARS = 15000;
const USER_AGENT = 'codex-qq-desktop/D.3';

function fail(code, error) {
  return { ok: false, code, error: String(error || code) };
}

function makeAbortError() {
  const error = new Error('已停止');
  error.code = 'ABORTED';
  return error;
}

function makeTimeoutError() {
  const error = new Error('TIMEOUT');
  error.code = 'TIMEOUT';
  return error;
}

/** Stream a response and stop reading once the compressed payload limit is hit. */
function defaultRequestFn(urlString, {
  headers,
  timeoutMs,
  maxBytes,
  signal,
  lookup,
} = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let timeout = null;
    let timedOut = false;
    let aborted = false;
    let req;
    const onAbort = () => {
      aborted = true;
      req?.destroy(makeAbortError());
    };
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const settleResolve = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    try {
      req = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        lookup: lookup || makeSafeLookup(),
      }, (res) => {
      const chunks = [];
      let received = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += body.length;
        if (received > maxBytes) {
          const keep = body.length - (received - maxBytes);
          if (keep > 0) chunks.push(body.slice(0, keep));
          settleResolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks),
            truncated: true,
          });
          req.destroy();
          return;
        }
        chunks.push(body);
      });
      res.on('end', () => settleResolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks),
        truncated: false,
      }));
        res.on('error', settleReject);
      });
    } catch (error) {
      settleReject(error);
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      req.destroy(makeTimeoutError());
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    req.on('error', (error) => {
      if (timedOut) settleReject(makeTimeoutError());
      else if (aborted) settleReject(makeAbortError());
      else settleReject(error);
    });
    req.end();
  });
}

function capBuffer(body, maxBytes) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (buf.length <= maxBytes) return { buf, truncated: false };
  return { buf: buf.slice(0, maxBytes), truncated: true };
}

/** Decompress and cap output so compressed responses cannot bypass maxBytes. */
function decompressCapped(body, encoding, maxBytes) {
  const enc = String(encoding || '').toLowerCase().trim();
  let stream;
  if (enc === 'gzip') stream = zlib.createGunzip();
  else if (enc === 'deflate') stream = zlib.createInflate();
  else if (enc === 'br') stream = zlib.createBrotliDecompress();
  else return Promise.resolve(capBuffer(body, maxBytes));

  return new Promise((resolve) => {
    const chunks = [];
    let output = 0;
    let settled = false;
    const finish = (truncated, error = null) => {
      if (settled) return;
      settled = true;
      resolve({ buf: Buffer.concat(chunks), truncated, error });
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      const bodyChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output += bodyChunk.length;
      if (output > maxBytes) {
        const keep = bodyChunk.length - (output - maxBytes);
        if (keep > 0) chunks.push(bodyChunk.slice(0, keep));
        finish(true);
        stream.destroy();
        return;
      }
      chunks.push(bodyChunk);
    });
    stream.on('end', () => finish(false));
    stream.on('error', (error) => finish(false, error));
    stream.end(Buffer.isBuffer(body) ? body : Buffer.from(body || ''));
  });
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(String(contentType || ''));
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decodeBody(buf, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function classifyContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/xml' || type.endsWith('+xml')) return 'xml';
  return 'binary';
}

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return '';
}

async function requestWithDeadline(requestFn, url, params, timeoutMs, callerSignal) {
  const controller = new AbortController();
  let timer;
  let callerAborted = false;
  let timedOut = false;
  let rejectCallerAbort;
  const callerAbortPromise = new Promise((_, reject) => {
    rejectCallerAbort = reject;
  });

  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
    rejectCallerAbort(makeAbortError());
  };
  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  const requestPromise = Promise.resolve().then(() => requestFn(url, {
    ...params,
    timeoutMs,
    signal: controller.signal,
  }));
  const deadlinePromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(makeTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestPromise, deadlinePromise, callerAbortPromise]);
  } catch (error) {
    if (callerAborted || callerSignal?.aborted || error?.code === 'ABORTED') throw makeAbortError();
    if (timedOut || error?.code === 'TIMEOUT' || error?.message === 'TIMEOUT') throw makeTimeoutError();
    if (error?.name === 'AbortError' || error?.message === 'aborted') {
      if (callerAborted || callerSignal?.aborted) throw makeAbortError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Controlled outbound fetch. Every redirect is guarded again, and all
 * transport/decompression/text limits are applied before returning content.
 */
async function fetchUrl(rawUrl, opts = {}) {
  const allowDomains = Array.isArray(opts.allowDomains) ? opts.allowDomains : [];
  const denyDomains = Array.isArray(opts.denyDomains) ? opts.denyDomains : [];
  const maxBytes = Math.max(1, Math.floor(Number(opts.maxBytes) || DEFAULT_MAX_BYTES));
  const timeoutMs = Math.max(1, Math.floor(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxChars = Math.max(1, Math.floor(Number(opts.maxChars) || DEFAULT_MAX_CHARS));
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequestFn;
  const lookup = opts.dnsLookup ? makeSafeLookup(opts.dnsLookup) : undefined;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8,*/*;q=0.5',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  const redirects = [];
  const deadlineAt = Date.now() + timeoutMs;
  let current = String(rawUrl || '').trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (opts.signal?.aborted) throw makeAbortError();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return fail('TIMEOUT', `请求超时（${timeoutMs}ms）：${current}`);
    const guard = checkUrl(current, { allowDomains, denyDomains });
    if (!guard.ok) return fail(guard.code, guard.reason);

    let response;
    try {
      response = await requestWithDeadline(
        requestFn,
        guard.url.href,
        { headers, maxBytes, lookup },
        remainingMs,
        opts.signal,
      );
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      if (error?.code === 'TIMEOUT' || error?.message === 'TIMEOUT') {
        return fail('TIMEOUT', `请求超时（${timeoutMs}ms）：${guard.url.href}`);
      }
      return fail('NETWORK', `网络请求失败：${error?.message || error}`);
    }

    const status = Number(response?.status) || 0;
    const responseHeaders = response?.headers || {};
    const location = headerValue(responseHeaders, 'location');
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      let next;
      try {
        next = new URL(String(location), guard.url).href;
      } catch {
        return fail('INVALID', `重定向目标无法解析：${location}`);
      }
      redirects.push({ from: guard.url.href, to: next, status });
      current = next;
      continue;
    }

    if (Date.now() >= deadlineAt) {
      return fail('TIMEOUT', `请求超时（${timeoutMs}ms）：${guard.url.href}`);
    }

    if (status < 200 || status >= 300) {
      return fail(`HTTP_${status}`, `HTTP ${status}：${guard.url.href}`);
    }

    const contentType = String(headerValue(responseHeaders, 'content-type') || '');
    const kind = classifyContentType(contentType);
    if (kind === 'binary') {
      return fail('CONTENT_TYPE', `不支持的内容类型：${contentType || '(未知)'}，只接受 html/text/json/xml`);
    }

    const decompressed = await decompressCapped(
      response?.body,
      headerValue(responseHeaders, 'content-encoding'),
      maxBytes,
    );
    if (decompressed.error) {
      return fail('DECOMPRESSION', `响应解压失败：${decompressed.error.message || decompressed.error}`);
    }
    const raw = decodeBody(decompressed.buf, contentType);
    let title = '';
    let text = raw;
    let extractTruncated = false;

    if (kind === 'html') {
      const extracted = extractFromHtml(raw, { baseUrl: guard.url.href, maxChars });
      title = extracted.title;
      text = extracted.text;
      extractTruncated = extracted.truncated;
    } else if (kind === 'json') {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    }
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      extractTruncated = true;
    }

    const transportTruncated = !!response?.truncated || decompressed.truncated;
    return {
      ok: true,
      url: guard.url.href,
      status,
      contentType: contentType.split(';')[0].trim() || 'text/plain',
      title,
      text,
      truncated: transportTruncated || extractTruncated,
      bytes: decompressed.buf.length,
      redirects,
    };
  }

  return fail('REDIRECT_LIMIT', `重定向超过 ${MAX_REDIRECTS} 次，已停止`);
}

module.exports = {
  fetchUrl,
  makeSafeLookup,
  defaultRequestFn,
  decompressCapped,
  classifyContentType,
};
