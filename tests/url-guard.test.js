const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkUrl, isBlockedIp, matchDomain } = require('../src/ai/url-guard');

describe('isBlockedIp', () => {
  it('blocks IPv4 private, loopback, metadata and reserved ranges', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.1.2.3',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1',
      '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    ]) assert.equal(isBlockedIp(ip), true, ip);
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.255.255', '11.0.0.1']) {
      assert.equal(isBlockedIp(ip), false, ip);
    }
  });

  it('blocks IPv6 loopback, ULA, link-local, multicast, NAT64 and mapped v4', () => {
    for (const ip of [
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
      '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]',
    ]) assert.equal(isBlockedIp(ip), true, ip);
  });

  it('allows public IPv6', () => {
    assert.equal(isBlockedIp('2001:4860:4860::8888'), false);
    assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
    assert.equal(isBlockedIp('64:ff9b:1::1'), false);
  });

  it('returns false for non-IP hostnames', () => {
    assert.equal(isBlockedIp('example.com'), false);
  });
});

describe('matchDomain', () => {
  it('matches the domain itself and any subdomain', () => {
    assert.equal(matchDomain('example.com', 'example.com'), true);
    assert.equal(matchDomain('a.b.example.com', 'example.com'), true);
  });
  it('does not match suffix lookalikes', () => {
    assert.equal(matchDomain('notexample.com', 'example.com'), false);
    assert.equal(matchDomain('example.com.evil.cn', 'example.com'), false);
  });
});

describe('checkUrl', () => {
  it('accepts a plain https URL when no lists are set', () => {
    const r = checkUrl('https://example.com/docs?q=1');
    assert.equal(r.ok, true);
    assert.equal(r.host, 'example.com');
  });

  it('rejects non-http protocols', () => {
    assert.equal(checkUrl('file:///etc/passwd').code, 'PROTOCOL');
    assert.equal(checkUrl('ftp://example.com/x').code, 'PROTOCOL');
  });

  it('rejects unparsable input', () => {
    assert.equal(checkUrl('not a url').code, 'INVALID');
    assert.equal(checkUrl('').code, 'INVALID');
  });

  it('rejects embedded credentials', () => {
    assert.equal(checkUrl('https://user:pass@example.com/').code, 'CREDENTIALS');
  });

  it('rejects service ports and privileged non-http ports', () => {
    assert.equal(checkUrl('http://example.com:22/').code, 'PORT');
    assert.equal(checkUrl('http://example.com:6379/').code, 'PORT');
    assert.equal(checkUrl('http://example.com:1023/').code, 'PORT');
    assert.equal(checkUrl('http://example.com:8080/').ok, true);
    assert.equal(checkUrl('https://example.com:443/').ok, true);
  });

  it('rejects loopback and metadata literals including obfuscated forms', () => {
    // new URL() normalizes octal/integer hosts to dotted decimal.
    assert.equal(checkUrl('http://127.0.0.1/').code, 'PRIVATE_IP');
    assert.equal(checkUrl('http://0177.0.0.1/').code, 'PRIVATE_IP');
    assert.equal(checkUrl('http://2130706433/').code, 'PRIVATE_IP');
    assert.equal(checkUrl('http://169.254.169.254/latest/meta-data/').code, 'PRIVATE_IP');
    assert.equal(checkUrl('http://[::1]/').code, 'PRIVATE_IP');
    assert.equal(checkUrl('http://[::ffff:127.0.0.1]/').code, 'PRIVATE_IP');
  });

  it('rejects local-ish hostnames', () => {
    for (const h of ['localhost', 'foo.localhost', 'db.local', 'svc.internal']) {
      assert.equal(checkUrl(`http://${h}/`).code, 'PRIVATE_IP', h);
    }
  });

  it('honours denyDomains including subdomains', () => {
    const r = checkUrl('https://x.evil.com/', { denyDomains: ['evil.com'] });
    assert.equal(r.code, 'DENIED');
  });

  it('enforces allowDomains only when non-empty', () => {
    assert.equal(checkUrl('https://other.com/', { allowDomains: ['example.com'] }).code, 'NOT_ALLOWED');
    assert.equal(checkUrl('https://docs.example.com/', { allowDomains: ['example.com'] }).ok, true);
    assert.equal(checkUrl('https://other.com/', { allowDomains: [] }).ok, true);
  });

  it('applies deny before allow', () => {
    const r = checkUrl('https://bad.example.com/', {
      allowDomains: ['example.com'], denyDomains: ['bad.example.com'],
    });
    assert.equal(r.code, 'DENIED');
  });

  it('every rejection carries a Chinese reason', () => {
    for (const u of ['file:///x', 'http://127.0.0.1/', 'http://example.com:22/']) {
      const r = checkUrl(u);
      assert.equal(r.ok, false);
      assert.match(r.reason, /[一-龥]/);
    }
  });
});
