'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');
const { checkUrl, isBlockedIp } = require('./url-guard');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function makeNetworkError(code, message) {
  const error = new Error(redactSensitive(message || code));
  error.code = code;
  return error;
}

function redactSensitive(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(authorization|access_token|refresh_token|client_secret|code|state)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/("(?:access_token|refresh_token|client_secret|code|state)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .slice(0, 500);
}

function blockedCode(check) {
  if (!check || check.ok) return null;
  if (check.code === 'PRIVATE_IP') return 'MCP_SSRF_PRIVATE';
  if (check.code === 'PORT') return 'MCP_SSRF_PRIVATE';
  if (check.code === 'REDIRECT') return 'MCP_SSRF_REDIRECT';
  return 'MCP_SSRF_PRIVATE';
}

/**
 * Node's lookup callback is allowed to return one address, but every DNS
 * answer must be inspected first. A mixed public/private answer fails closed.
 */
function makeSafeLookup(dnsLookupImpl, options = {}) {
  const allowPrivate = options === true || options?.allowPrivate === true;
  const impl = dnsLookupImpl || ((hostname, _opts, cb) => {
    dns.lookup(hostname, { all: true }, cb);
  });

  return function safeLookup(hostname, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    const wantsAll = typeof opts === 'object' && opts?.all === true;
    impl(hostname, { all: true }, (err, addresses) => {
      if (err) {
        const error = makeNetworkError('MCP_SSRF_DNS', `DNS lookup failed for ${hostname}`);
        error.cause = err;
        return done(error);
      }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      if (!list.length || !list.some((entry) => entry?.address)) {
        return done(makeNetworkError('MCP_SSRF_DNS', `DNS returned no address for ${hostname}`));
      }
      if (!allowPrivate) {
        const bad = list.find((entry) => isBlockedIp(entry?.address));
        if (bad) {
          return done(makeNetworkError(
            'MCP_SSRF_PRIVATE',
            `域名 ${hostname} 解析到内网/保留地址，已拒绝`,
          ));
        }
      }
      if (wantsAll) return done(null, list);
      const first = list.find((entry) => entry?.address);
      return done(null, first.address, first.family);
    });
  };
}

function guardUrl(rawUrl, options = {}) {
  const checked = checkUrl(rawUrl, {
    allowPrivate: options.allowPrivate === true,
    allowDomains: options.allowDomains,
    denyDomains: options.denyDomains,
  });
  if (!checked.ok) {
    throw makeNetworkError(blockedCode(checked), checked.reason || checked.code);
  }
  return checked;
}

function assertPublicHttps(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw makeNetworkError('MCP_OAUTH_METADATA_INVALID', 'OAuth endpoint URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw makeNetworkError('MCP_OAUTH_METADATA_INVALID', 'OAuth endpoint must use HTTPS');
  }
  return guardUrl(parsed.href, { allowPrivate: false });
}

function verifyPublicHttps(rawUrl, options = {}) {
  const checked = assertPublicHttps(rawUrl);
  return new Promise((resolve, reject) => {
    const lookup = makeSafeLookup(options.dnsLookup, { allowPrivate: false });
    lookup(checked.host, { all: true }, (error) => {
      if (error) reject(error);
      else resolve(checked);
    });
  });
}

function sameOrigin(left, right) {
  try {
    return new URL(String(left)).origin === new URL(String(right)).origin;
  } catch {
    return false;
  }
}

function normalizeResponse(response) {
  const body = response?.bodyText != null
    ? String(response.bodyText)
    : Buffer.isBuffer(response?.body)
      ? response.body.toString('utf8')
      : String(response?.body || '');
  return {
    status: Number(response?.status || response?.statusCode) || 0,
    headers: response?.headers && typeof response.headers === 'object' ? response.headers : {},
    bodyText: body,
  };
}

function defaultRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    const body = options.body == null ? '' : String(options.body);
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    }

    let settled = false;
    let timeout;
    let aborted = false;
    let timedOut = false;
    let req;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      aborted = true;
      req?.destroy(makeNetworkError('ABORTED', 'request aborted'));
    };

    try {
      req = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        servername: isHttps ? parsed.hostname : undefined,
        lookup: options.lookup || makeSafeLookup(options.dnsLookup, {
          allowPrivate: options.allowPrivate === true,
        }),
      }, (res) => {
        const chunks = [];
        let received = 0;
        const maxBytes = Math.max(1, Math.floor(Number(options.maxBytes) || DEFAULT_MAX_BYTES));
        res.on('data', (chunk) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxBytes - received;
          if (remaining <= 0) return;
          chunks.push(buf.slice(0, remaining));
          received += Math.min(buf.length, remaining);
          if (buf.length > remaining) {
            finish(resolve, {
              status: res.statusCode || 0,
              headers: res.headers || {},
              body: Buffer.concat(chunks),
              bodyText: Buffer.concat(chunks).toString('utf8'),
              truncated: true,
            });
            req.destroy();
          }
        });
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          finish(resolve, {
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: data,
            bodyText: data.toString('utf8'),
            truncated: false,
          });
        });
        res.on('error', (error) => finish(reject, error));
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      req.destroy(makeNetworkError('TIMEOUT', 'request timed out'));
    }, Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => {
      if (timedOut) finish(reject, makeNetworkError('TIMEOUT', 'request timed out'));
      else if (aborted) finish(reject, makeNetworkError('ABORTED', 'request aborted'));
      else finish(reject, error);
    });
    req.end(body || undefined);
  });
}

/**
 * Guard every hop and return bounded response text. Redirect following is
 * opt-in because MCP JSON-RPC and token requests must not follow redirects.
 */
async function requestJson(rawUrl, options = {}) {
  const requestImpl = typeof options.requestFn === 'function' ? options.requestFn : defaultRequest;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const maxRedirects = Math.max(0, Math.min(3, Math.floor(Number(options.maxRedirects) || 0)));
  let current = String(rawUrl || '').trim();
  let previous = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.signal?.aborted) throw makeNetworkError('ABORTED', 'request aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw makeNetworkError('TIMEOUT', 'request timed out');
    let checked;
    try {
      checked = guardUrl(current, { allowPrivate: options.allowPrivate === true });
    } catch (error) {
      if (hop > 0 && ['MCP_SSRF_PRIVATE', 'MCP_SSRF_DNS'].includes(error?.code)) {
        throw makeNetworkError('MCP_SSRF_REDIRECT', 'redirect target is not allowed');
      }
      throw error;
    }
    if (options.requireHttps && checked.url.protocol !== 'https:') {
      throw makeNetworkError('MCP_SSRF_REDIRECT', 'HTTPS downgrade is not allowed');
    }
    if (previous && previous.protocol === 'https:' && checked.url.protocol !== 'https:') {
      throw makeNetworkError('MCP_SSRF_REDIRECT', 'HTTPS downgrade is not allowed');
    }

    let response;
    try {
      response = await requestImpl(checked.url.href, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        timeoutMs: remaining,
        maxBytes: options.maxBytes || DEFAULT_MAX_BYTES,
        signal: options.signal,
        allowPrivate: options.allowPrivate === true,
        lookup: options.lookup,
        dnsLookup: options.dnsLookup,
      });
    } catch (error) {
      if (error?.code) throw error;
      throw makeNetworkError('MCP_NETWORK', error?.message || 'network request failed');
    }
    const normalized = normalizeResponse(response);
    if (Buffer.byteLength(normalized.bodyText, 'utf8') > (options.maxBytes || DEFAULT_MAX_BYTES)) {
      throw makeNetworkError('MCP_OAUTH_METADATA_INVALID', 'response exceeded size limit');
    }
    const location = Object.entries(normalized.headers).find(([key]) => key.toLowerCase() === 'location')?.[1];
    if (REDIRECT_STATUSES.has(normalized.status) && location) {
      if (hop >= maxRedirects) throw makeNetworkError('MCP_SSRF_REDIRECT', 'redirect limit exceeded');
      let next;
      try {
        next = new URL(String(location), checked.url).href;
      } catch {
        throw makeNetworkError('MCP_SSRF_REDIRECT', 'redirect location is invalid');
      }
      previous = checked.url;
      current = next;
      continue;
    }
    return normalized;
  }
  throw makeNetworkError('MCP_SSRF_REDIRECT', 'redirect limit exceeded');
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  makeSafeLookup,
  guardUrl,
  assertPublicHttps,
  verifyPublicHttps,
  sameOrigin,
  defaultRequest,
  requestJson,
  redactSensitive,
};
