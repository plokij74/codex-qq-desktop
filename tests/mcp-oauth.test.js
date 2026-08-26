'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const {
  CALLBACK_PATH,
  createMcpOAuthManager,
  createPkce,
} = require('../src/ai/mcp-oauth');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-qq-oauth-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(String(value).split('').reverse().join(''), 'utf8');
    },
    decryptString(value) {
      return Buffer.from(value).toString('utf8').split('').reverse().join('');
    },
  };
}

function createHarness({ safeStorage, now, tokenResponses, dcr = false, wrongState = false } = {}) {
  const root = tempDir();
  let tokenIndex = 0;
  let openedUrl = null;
  const calls = [];
  const requestFn = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('oauth-protected-resource')) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          authorization_servers: ['https://auth.example.com'],
        }),
      };
    }
    if (url.includes('oauth-authorization-server')) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          ...(dcr ? { registration_endpoint: 'https://auth.example.com/register' } : {}),
          revocation_endpoint: 'https://auth.example.com/revoke',
        }),
      };
    }
    if (url.endsWith('/register')) {
      return {
        status: 201,
        headers: {},
        bodyText: JSON.stringify({ client_id: 'registered-public-client' }),
      };
    }
    if (url.endsWith('/token')) {
      const response = tokenResponses?.[tokenIndex++] || {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      return {
        status: response.status || 200,
        headers: {},
        bodyText: JSON.stringify(response.body || response),
      };
    }
    if (url.endsWith('/revoke')) return { status: 503, headers: {}, bodyText: 'rejected' };
    throw new Error(`unexpected OAuth URL ${url}`);
  };

  const manager = createMcpOAuthManager({
    userDataPath: root,
    safeStorage,
    requestFn,
    now,
    callbackTimeoutMs: 1000,
    openExternal: async (url) => {
      openedUrl = new URL(url);
      const redirect = new URL(openedUrl.searchParams.get('redirect_uri'));
      const state = wrongState ? 'wrong-state' : openedUrl.searchParams.get('state');
      setTimeout(() => {
        const callback = new URL(`http://127.0.0.1:${redirect.port}${CALLBACK_PATH}`);
        callback.searchParams.set('code', 'authorization-code-secret');
        callback.searchParams.set('state', state);
        http.get(callback.href).on('error', () => {});
      }, 5);
      return true;
    },
  });
  const cfg = {
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    auth: 'oauth',
    oauth: {
      ...(dcr ? {} : { clientId: 'configured-public-client' }),
    },
  };
  return {
    root,
    manager,
    cfg,
    calls,
    get openedUrl() { return openedUrl; },
  };
}

describe('mcp OAuth', () => {
  it('creates the PKCE S256 challenge', () => {
    const pkce = createPkce(() => Buffer.alloc(32, 1));
    assert.equal(pkce.verifier.length > 40, true);
    assert.equal(pkce.challenge, 'VtX6czP210fbQsI5QH5dpMMvTHnzXQkrE0_TWkAtnFw');
  });

  it('authorizes with loopback PKCE and reloads encrypted credentials', async () => {
    const harness = createHarness({ safeStorage: fakeSafeStorage(true) });
    const first = await harness.manager.authorize('remote', harness.cfg);
    assert.equal(first.authorized, true);
    assert.equal(first.persistence, 'encrypted');
    assert.equal(harness.openedUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(harness.openedUrl.searchParams.get('client_id'), 'configured-public-client');

    const file = path.join(harness.root, 'mcp-oauth.json');
    const envelope = fs.readFileSync(file, 'utf8');
    assert.match(envelope, /electron-safeStorage/);
    assert.equal(envelope.includes('access-secret'), false);
    assert.equal(envelope.includes('refresh-secret'), false);

    const reloaded = createMcpOAuthManager({
      userDataPath: harness.root,
      safeStorage: fakeSafeStorage(true),
    });
    const status = reloaded.getStatus('remote', harness.cfg);
    assert.equal(status.authorized, true);
    assert.equal(status.canRefresh, true);
  });

  it('uses memory-only persistence when safeStorage is unavailable', async () => {
    const harness = createHarness({ safeStorage: fakeSafeStorage(false) });
    const result = await harness.manager.authorize('remote', harness.cfg);
    assert.equal(result.persistence, 'memory');
    assert.equal(fs.existsSync(path.join(harness.root, 'mcp-oauth.json')), false);
  });

  it('registers a public client when clientId is absent', async () => {
    const harness = createHarness({ safeStorage: fakeSafeStorage(false), dcr: true });
    await harness.manager.authorize('remote', harness.cfg);
    assert.equal(harness.openedUrl.searchParams.get('client_id'), 'registered-public-client');
    assert.equal(harness.calls.some((call) => call.url.endsWith('/register')), true);
  });

  it('coalesces concurrent refreshes and keeps the rotated refresh token', async () => {
    let clock = 100000;
    const harness = createHarness({
      safeStorage: fakeSafeStorage(false),
      now: () => clock,
      tokenResponses: [
        { access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 1, token_type: 'Bearer' },
        { access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 3600, token_type: 'Bearer' },
      ],
    });
    await harness.manager.authorize('remote', harness.cfg);
    clock += 2000;
    const provider = harness.manager.getAuthProvider('remote', harness.cfg);
    const headers = await Promise.all([provider.getHeaders(), provider.getHeaders(), provider.getHeaders()]);
    assert.deepEqual(headers, [
      { Authorization: 'Bearer access-two' },
      { Authorization: 'Bearer access-two' },
      { Authorization: 'Bearer access-two' },
    ]);
    assert.equal(harness.calls.filter((call) => call.url.endsWith('/token')).length, 2);
  });

  it('maps invalid_grant to auth required and removes the credential', async () => {
    let clock = 100000;
    const harness = createHarness({
      safeStorage: fakeSafeStorage(false),
      now: () => clock,
      tokenResponses: [
        { access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 1, token_type: 'Bearer' },
        { status: 400, body: { error: 'invalid_grant' } },
      ],
    });
    await harness.manager.authorize('remote', harness.cfg);
    clock += 2000;
    await assert.rejects(() => harness.manager.getAuthProvider('remote', harness.cfg).getHeaders(), (error) => {
      assert.equal(error.code, 'MCP_AUTH_REQUIRED');
      return true;
    });
    assert.equal(harness.manager.getStatus('remote', harness.cfg).authorized, false);
  });

  it('rejects a mismatched callback state without exposing the code', async () => {
    const harness = createHarness({ safeStorage: fakeSafeStorage(false), wrongState: true });
    await assert.rejects(() => harness.manager.authorize('remote', harness.cfg), (error) => {
      assert.equal(error.code, 'MCP_OAUTH_STATE_MISMATCH');
      assert.equal(error.message.includes('authorization-code-secret'), false);
      return true;
    });
  });

  it('deletes local credentials even when revocation fails', async () => {
    const harness = createHarness({ safeStorage: fakeSafeStorage(false) });
    await harness.manager.authorize('remote', harness.cfg);
    const result = await harness.manager.logout('remote', harness.cfg);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'MCP_OAUTH_REVOKE_FAILED');
    assert.equal(result.status.authorized, false);
  });
});
