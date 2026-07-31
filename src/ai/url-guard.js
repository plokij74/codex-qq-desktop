'use strict';

const { URL } = require('url');

/** Common service ports remain blocked even for allowlisted domains. */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 465, 587, 993, 995,
  1433, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

function ipv4ToInt(addr) {
  const parts = String(addr).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function cidr(base, bits) {
  const mask = bits === 0 ? 0 : (((~0) << (32 - bits)) >>> 0);
  return { base: (ipv4ToInt(base) & mask) >>> 0, mask };
}

/** Compare all IPv4 ranges as 32-bit integers, never string prefixes. */
const V4_BLOCKS = [
  cidr('0.0.0.0', 8),
  cidr('10.0.0.0', 8),
  cidr('100.64.0.0', 10),
  cidr('127.0.0.0', 8),
  cidr('169.254.0.0', 16),
  cidr('172.16.0.0', 12),
  cidr('192.0.0.0', 24),
  cidr('192.168.0.0', 16),
  cidr('198.18.0.0', 15),
  cidr('224.0.0.0', 4),
  cidr('240.0.0.0', 4),
];

function isBlockedIpv4(addr) {
  const n = ipv4ToInt(addr);
  if (n == null) return false;
  return V4_BLOCKS.some((b) => (((n & b.mask) >>> 0) === b.base));
}

/** Expands IPv6 input to eight 16-bit groups, or returns null when invalid. */
function expandIpv6(input) {
  let s = String(input).toLowerCase();
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    if (n == null) return null;
    s = `${dotted[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let parts;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  }
  const groups = parts.map((h) => {
    if (!/^[0-9a-f]{1,4}$/.test(h || '0')) return NaN;
    return parseInt(h || '0', 16);
  });
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

function isBlockedIpv6(addr) {
  let s = String(addr).toLowerCase().trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const g = expandIpv6(s);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    if (isBlockedIpv4(v4)) return true;
  }
  return false;
}

/** Returns true only when a literal IP belongs to a hard-blocked range. */
function isBlockedIp(addr) {
  const s = String(addr || '').trim().replace(/^\[|\]$/g, '');
  if (!s) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return isBlockedIpv4(s);
  if (s.includes(':')) return isBlockedIpv6(s);
  return false;
}

/** Matches a domain itself or a dot-delimited subdomain, but not suffix lookalikes. */
function matchDomain(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  const p = String(pattern || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h || !p) return false;
  return h === p || h.endsWith(`.${p}`);
}

function reject(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Validates an outbound URL in this order: parsing, protocol, credentials,
 * port, hostname, literal IP, deny list, then allow list.
 */
function checkUrl(rawUrl, opts = {}) {
  const allow = Array.isArray(opts.allowDomains) ? opts.allowDomains : [];
  const deny = Array.isArray(opts.denyDomains) ? opts.denyDomains : [];

  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return reject('INVALID', 'URL 无法解析，请检查是否包含协议头');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return reject('PROTOCOL', `只允许 http/https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    return reject('CREDENTIALS', 'URL 不允许携带用户名或密码');
  }

  if (url.port) {
    const p = Number(url.port);
    if (BLOCKED_PORTS.has(p)) return reject('PORT', `端口 ${p} 属常见服务端口，已拒绝`);
    if (p < 1024 && p !== 80 && p !== 443) {
      return reject('PORT', `端口 ${p} 属特权端口，已拒绝`);
    }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return reject('INVALID', 'URL 缺少主机名');

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))) {
    return reject('PRIVATE_IP', `主机名 ${host} 指向本机或内网，已拒绝`);
  }
  if (isBlockedIp(host)) {
    return reject('PRIVATE_IP', `目标地址是内网/保留地址：${host}`);
  }

  if (deny.some((d) => matchDomain(host, d))) {
    return reject('DENIED', `域名 ${host} 在拒绝清单里`);
  }
  if (allow.length && !allow.some((d) => matchDomain(host, d))) {
    return reject('NOT_ALLOWED', `域名 ${host} 不在允许清单里`);
  }

  return { ok: true, url, host };
}

module.exports = {
  checkUrl,
  isBlockedIp,
  matchDomain,
  BLOCKED_PORTS,
};
