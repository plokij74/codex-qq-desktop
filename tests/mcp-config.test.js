'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeMcpServers, inferTransport } = require('../src/ai/mcp-config');

describe('mcp-config', () => {
  it('legacy command-only becomes stdio', () => {
    const out = sanitizeMcpServers([
      { name: 'fs', command: 'npx', args: ['-y', 'x'] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].transport, 'stdio');
    assert.equal(out[0].enabled, true);
    assert.equal(out[0].command, 'npx');
  });

  it('accepts http url transport', () => {
    const out = sanitizeMcpServers([
      { name: 'r', transport: 'http', url: 'https://example.com/mcp' },
    ]);
    assert.equal(out[0].transport, 'http');
    assert.equal(out[0].url, 'https://example.com/mcp');
  });

  it('rejects non-http url and missing command for stdio', () => {
    assert.deepEqual(sanitizeMcpServers([
      { name: 'bad', transport: 'http', url: 'file:///etc/passwd' },
      { name: 'ncmd', transport: 'stdio' },
    ]), []);
  });

  it('enabled false preserved; duplicate names keep first', () => {
    const out = sanitizeMcpServers([
      { name: 'a', command: 'c1', enabled: false },
      { name: 'a', command: 'c2' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].enabled, false);
    assert.equal(out[0].command, 'c1');
  });

  it('inferTransport', () => {
    assert.equal(inferTransport({ command: 'x' }), 'stdio');
    assert.equal(inferTransport({ url: 'https://a' }), 'http');
    assert.equal(inferTransport({ transport: 'sse', url: 'https://a' }), 'sse');
  });

  it('normalizes OAuth config, keeps allowPrivate explicit, and drops clientSecret', () => {
    const out = sanitizeMcpServers([{
      name: 'oauth',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer access-secret', 'X-Trace': 'yes' },
      allowPrivate: true,
      auth: 'oauth',
      oauth: {
        clientId: 'public',
        clientSecret: 'must-not-survive',
        authorizationEndpoint: 'https://example.com/authorize',
        tokenEndpoint: 'http://example.com/token',
        scopes: ['read', 'read', 'write now'],
      },
    }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].allowPrivate, true);
    assert.equal(out[0].auth, 'oauth');
    assert.equal(out[0].oauth.clientId, 'public');
    assert.equal(out[0].oauth.authorizationEndpoint, 'https://example.com/authorize');
    assert.equal(out[0].oauth.tokenEndpoint, undefined);
    assert.equal(out[0].oauth.clientSecret, undefined);
    assert.deepEqual(out[0].oauth.scopes, ['read']);
    assert.equal(out[0].headers.Authorization, undefined);
    assert.equal(out[0].headers['X-Trace'], 'yes');
  });

  it('ignores OAuth fields for stdio and defaults remote auth to none', () => {
    const out = sanitizeMcpServers([
      { name: 'local', transport: 'stdio', command: 'node', allowPrivate: true, auth: 'oauth', oauth: { clientId: 'x' } },
      { name: 'remote', transport: 'http', url: 'https://example.com/mcp' },
    ]);
    assert.equal(out[0].allowPrivate, undefined);
    assert.equal(out[0].auth, undefined);
    assert.equal(out[1].allowPrivate, false);
    assert.equal(out[1].auth, 'none');
  });

  it('defaults D9 recovery/sampling and drops unauthorized root paths', () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-root-'));
    const out = sanitizeMcpServers([{
      name: 'd9', command: 'node', sessionRecovery: true,
      sampling: { enabled: true }, roots: [{ rootId: 'r1', label: 'docs', path: rootPath }],
    }]);
    assert.equal(out[0].sessionRecovery, true);
    assert.equal(out[0].sampling.enabled, true);
    assert.equal(out[0].roots[0].path, undefined);
    const loaded = sanitizeMcpServers(out.map((item) => ({ ...item, roots: [{ rootId: 'r1', label: 'docs', path: rootPath }] })), { allowRootPaths: true });
    assert.equal(loaded[0].roots[0].path, fs.realpathSync(rootPath));
  });
});
