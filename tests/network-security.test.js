'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  makeSafeLookup,
  requestJson,
  assertPublicHttps,
  sameOrigin,
} = require('../src/ai/network-security');

function fakeDns(addresses) {
  return (_host, options, callback) => {
    assert.equal(options.all, true);
    callback(null, addresses.map(([address, family]) => ({ address, family })));
  };
}

describe('network-security', () => {
  it('fails closed when DNS returns a mixed public and private answer', (t, done) => {
    const lookup = makeSafeLookup(fakeDns([
      ['93.184.216.34', 4],
      ['127.0.0.1', 4],
    ]));
    lookup('mixed.example', { all: false }, (error) => {
      assert.equal(error.code, 'MCP_SSRF_PRIVATE');
      done();
    });
  });

  it('permits private DNS only for an explicitly allowlisted transport', (t, done) => {
    const lookup = makeSafeLookup(fakeDns([['127.0.0.1', 4]]), { allowPrivate: true });
    lookup('local.example', { all: false }, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, '127.0.0.1');
      done();
    });
  });

  it('requires public HTTPS for OAuth endpoints', () => {
    assert.throws(() => assertPublicHttps('http://example.com/token'), (error) => {
      assert.equal(error.code, 'MCP_OAUTH_METADATA_INVALID');
      return true;
    });
    assert.throws(() => assertPublicHttps('https://127.0.0.1/token'), (error) => {
      assert.equal(error.code, 'MCP_SSRF_PRIVATE');
      return true;
    });
  });

  it('rechecks redirects and rejects HTTPS downgrade/private targets', async () => {
    const requestFn = async (url) => ({
      status: 302,
      headers: { location: url.includes('good') ? 'http://127.0.0.1/private' : 'https://good.example/next' },
      bodyText: '',
    });
    await assert.rejects(() => requestJson('https://good.example/start', {
      requestFn,
      maxRedirects: 3,
      requireHttps: true,
    }), (error) => {
      assert.equal(error.code, 'MCP_SSRF_REDIRECT');
      return true;
    });
  });

  it('compares SSE endpoints by origin', () => {
    assert.equal(sameOrigin('https://example.com/sse', 'https://example.com/message'), true);
    assert.equal(sameOrigin('https://example.com/sse', 'https://other.example/message'), false);
  });
});
