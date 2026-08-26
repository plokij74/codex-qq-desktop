'use strict';

const fs = require('fs');
const { checkUrl } = require('./url-guard');

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HEADER_KEY_MAX = 128;
const HEADER_VAL_MAX = 4 * 1024;
const OAUTH_ENDPOINT_MAX = 2048;
const OAUTH_CLIENT_ID_MAX = 512;
const OAUTH_SCOPE_MAX = 128;
const OAUTH_SCOPES_MAX = 32;
const ROOTS_MAX = 8;
const ROOT_ID_MAX = 160;
const ROOT_LABEL_MAX = 128;

function clampTimeoutMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60000;
  return Math.max(1000, Math.min(300000, Math.floor(n)));
}

function inferTransport(item) {
  const t = String(item?.transport || '').toLowerCase();
  if (t === 'stdio' || t === 'sse' || t === 'http') return t;
  if (item?.command) return 'stdio';
  if (item?.url) return 'http';
  return 'stdio';
}

function sanitizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim().slice(0, HEADER_KEY_MAX);
    if (!key) continue;
    const value = String(v ?? '').slice(0, HEADER_VAL_MAX);
    if (/\r|\n/.test(key) || /\r|\n/.test(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function withoutAuthorizationHeader(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'authorization') continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function isHttpUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHttpsEndpoint(raw, { resource = false } = {}) {
  const text = String(raw || '').trim();
  if (!text || text.length > OAUTH_ENDPOINT_MAX) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
    const checked = checkUrl(url.href, { allowPrivate: false });
    if (!checked.ok) return '';
    if (resource && !url.pathname) url.pathname = '/';
    return url.href;
  } catch {
    return '';
  }
}

function sanitizeOAuth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  const clientId = String(raw.clientId || '').trim();
  if (clientId && clientId.length <= OAUTH_CLIENT_ID_MAX) out.clientId = clientId;

  for (const key of [
    'resource',
    'authorizationServer',
    'authorizationEndpoint',
    'tokenEndpoint',
    'registrationEndpoint',
    'revocationEndpoint',
  ]) {
    const value = normalizeHttpsEndpoint(raw[key], { resource: key === 'resource' });
    if (value) out[key] = value;
  }

  if (Array.isArray(raw.scopes)) {
    const scopes = [];
    for (const item of raw.scopes) {
      const scope = String(item || '').trim();
      if (!scope || scope.length > OAUTH_SCOPE_MAX || /\s/.test(scope)) continue;
      if (!scopes.includes(scope)) scopes.push(scope);
      if (scopes.length >= OAUTH_SCOPES_MAX) break;
    }
    if (scopes.length) out.scopes = scopes;
  }
  return Object.keys(out).length ? out : {};
}

function isSafeRemoteUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function sanitizeRootLabel(raw) {
  const label = String(raw || '').replace(/[\r\n\t]+/g, ' ').trim();
  return label.slice(0, ROOT_LABEL_MAX);
}

/**
 * Normalize roots without granting filesystem authority.  `allowPaths` is
 * used only when reading the already-saved main-process settings file; JSON
 * imports and renderer payloads must leave it false.
 */
function sanitizeMcpRoots(raw, { allowPaths = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rootId = String(item.rootId || '').trim().slice(0, ROOT_ID_MAX);
    if (!rootId || !/^[a-zA-Z0-9_-]+$/.test(rootId) || seen.has(rootId)) continue;
    const label = sanitizeRootLabel(item.label || item.name || '目录');
    if (!label) continue;
    const entry = { rootId, label };
    if (allowPaths) {
      if (typeof item.path !== 'string' || !item.path.trim()) continue;
      try {
        const candidate = fs.realpathSync.native ? fs.realpathSync.native(item.path.trim()) : fs.realpathSync(item.path.trim());
        if (!fs.statSync(candidate).isDirectory()) continue;
        entry.path = candidate.slice(0, 4096);
      } catch {
        continue;
      }
    }
    seen.add(rootId);
    out.push(entry);
    if (out.length >= ROOTS_MAX) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function sanitizeMcpServers(raw, { allowRootPaths = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const transport = inferTransport(item);
    const enabled = item.enabled === false ? false : true;
    const timeoutMs = clampTimeoutMs(item.timeoutMs);

    if (transport === 'stdio') {
      const command = String(item.command || '').trim();
      if (!command) continue;
      const entry = {
        name, transport: 'stdio', enabled, command, timeoutMs,
        sessionRecovery: item.sessionRecovery === true,
        sampling: { enabled: item.sampling?.enabled === true },
        roots: sanitizeMcpRoots(item.roots, { allowPaths: allowRootPaths }),
      };
      if (Array.isArray(item.args)) entry.args = item.args.map(String);
      if (item.env && typeof item.env === 'object' && !Array.isArray(item.env)) {
        entry.env = { ...item.env };
      }
      if (item.cwd) entry.cwd = String(item.cwd);
      seen.add(name);
      out.push(entry);
      continue;
    }

    // sse | http
    const url = String(item.url || '').trim();
    if (!isHttpUrl(url) || !isSafeRemoteUrl(url)) continue;
    const entry = {
      name,
      transport,
      enabled,
      url,
      timeoutMs,
      allowPrivate: item.allowPrivate === true,
      auth: item.auth === 'oauth' ? 'oauth' : 'none',
      sessionRecovery: item.sessionRecovery === true,
      sampling: { enabled: item.sampling?.enabled === true },
      roots: sanitizeMcpRoots(item.roots, { allowPaths: allowRootPaths }),
    };
    const headers = entry.auth === 'oauth'
      ? withoutAuthorizationHeader(sanitizeHeaders(item.headers))
      : sanitizeHeaders(item.headers);
    if (headers) entry.headers = headers;
    if (entry.auth === 'oauth') entry.oauth = sanitizeOAuth(item.oauth) || {};
    seen.add(name);
    out.push(entry);
  }
  return out;
}

module.exports = {
  sanitizeMcpServers,
  inferTransport,
  clampTimeoutMs,
  isHttpUrl,
  sanitizeHeaders,
  withoutAuthorizationHeader,
  sanitizeOAuth,
  normalizeHttpsEndpoint,
  sanitizeMcpRoots,
  sanitizeRootLabel,
  ROOTS_MAX,
};
