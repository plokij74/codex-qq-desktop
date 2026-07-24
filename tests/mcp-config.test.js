'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
});
