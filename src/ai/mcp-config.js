'use strict';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HEADER_KEY_MAX = 128;
const HEADER_VAL_MAX = 4 * 1024;

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
    out[key] = String(v ?? '').slice(0, HEADER_VAL_MAX);
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

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function sanitizeMcpServers(raw) {
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
      const entry = { name, transport: 'stdio', enabled, command, timeoutMs };
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
    if (!isHttpUrl(url)) continue;
    const entry = { name, transport, enabled, url, timeoutMs };
    const headers = sanitizeHeaders(item.headers);
    if (headers) entry.headers = headers;
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
};
