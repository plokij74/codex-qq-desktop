'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL, URLSearchParams } = require('url');
const {
  assertPublicHttps,
  verifyPublicHttps,
  requestJson,
  redactSensitive,
} = require('./network-security');

const STORE_VERSION = 1;
const STORE_FILENAME = 'mcp-oauth.json';
const CALLBACK_PATH = '/oauth/callback';
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 128 * 1024;

function makeError(code, message) {
  const error = new Error(redactSensitive(message || code));
  error.code = code;
  return error;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomString(randomBytes, size) {
  return base64Url(randomBytes(size));
}

function createPkce(randomBytes = crypto.randomBytes) {
  const verifier = randomString(randomBytes, 32);
  return {
    verifier,
    challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()),
  };
}

function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function wellKnownUrl(issuer, name) {
  const url = new URL(assertPublicHttps(issuer).url.href);
  const suffix = url.pathname.replace(/\/+$/, '');
  url.pathname = `/.well-known/${name}${suffix}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function parseJsonBody(response, errorCode) {
  const text = String(response?.bodyText || '').trim();
  if (!text) throw makeError(errorCode, 'OAuth response was empty');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw makeError(errorCode, 'OAuth response was not valid JSON');
  }
}

function isSuccess(status) {
  return Number(status) >= 200 && Number(status) < 300;
}

function normalizeEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return assertPublicHttps(value).url.href;
  } catch {
    return '';
  }
}

function sanitizeContext(context) {
  const out = {};
  for (const key of [
    'resource',
    'authorizationServer',
    'authorizationEndpoint',
    'tokenEndpoint',
    'registrationEndpoint',
    'revocationEndpoint',
    'clientId',
  ]) {
    if (context?.[key]) out[key] = String(context[key]);
  }
  if (Array.isArray(context?.scopes)) out.scopes = context.scopes.map(String).slice(0, 32);
  return out;
}

function storageKey(resource, authorizationServer) {
  return crypto.createHash('sha256')
    .update(`${normalizeUrl(resource)}\n${normalizeUrl(authorizationServer)}`)
    .digest('hex');
}

function getDefaultSafeStorage() {
  try {
    return require('electron').safeStorage || null;
  } catch {
    return null;
  }
}

function getMemoryPersistence(safeStorage) {
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
      return safeStorage.isEncryptionAvailable() ? 'encrypted' : 'memory';
    }
  } catch {
    return 'memory';
  }
  return 'memory';
}

function parseResourceMetadataUrl(value, resource) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, resource);
    return normalizeUrl(url.href);
  } catch {
    return '';
  }
}

function parseResourceMetadataHeader(headers, resource) {
  const value = String(headerValue(headers, 'www-authenticate') || '');
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i.exec(value);
  return parseResourceMetadataUrl(match?.[1] || match?.[2], resource);
}

function isInvalidGrant(data) {
  const value = String(data?.error || '').toLowerCase();
  return value === 'invalid_grant' || value === 'invalid_token' || value === 'unauthorized_client';
}

function tokenFromResponse(data, context, previous = null, now = Date.now, errorCode = 'MCP_OAUTH_TOKEN_FAILED') {
  const accessToken = String(data?.access_token || '').trim();
  if (!accessToken) throw makeError(errorCode, 'OAuth response did not contain an access token');
  const tokenType = String(data?.token_type || 'Bearer').trim();
  if (tokenType.toLowerCase() !== 'bearer') {
    throw makeError(errorCode, 'Only Bearer OAuth tokens are supported');
  }
  const expiresIn = Number(data?.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? now() + Math.floor(expiresIn * 1000)
    : null;
  const refreshToken = String(data?.refresh_token || previous?.refreshToken || '').trim();
  const scope = typeof data?.scope === 'string'
    ? data.scope.slice(0, 4096)
    : (previous?.scope || '');
  return {
    ...context,
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresAt,
    scope,
  };
}

function responseError(data, fallbackCode) {
  if (isInvalidGrant(data)) {
    const error = makeError('MCP_AUTH_REQUIRED', 'OAuth authorization is required again');
    error.oauthError = String(data?.error || 'invalid_grant');
    return error;
  }
  return makeError(fallbackCode, 'OAuth server rejected the request');
}

/**
 * Main-process OAuth manager. All token-bearing values stay inside this
 * object; its public status and event methods intentionally expose summaries.
 */
function createMcpOAuthManager(options = {}) {
  const safeStorage = options.safeStorage === undefined
    ? getDefaultSafeStorage()
    : options.safeStorage;
  const fsImpl = options.fs || fs;
  const userDataPath = String(options.userDataPath || process.cwd());
  const storePath = String(options.storePath || path.join(userDataPath, STORE_FILENAME));
  const requestFn = typeof options.requestFn === 'function' ? options.requestFn : null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const createServer = typeof options.createServer === 'function'
    ? options.createServer
    : http.createServer;
  const openExternal = typeof options.openExternal === 'function'
    ? options.openExternal
    : async () => true;
  const callbackTimeoutMs = Math.max(
    1,
    Number(options.callbackTimeoutMs) || DEFAULT_CALLBACK_TIMEOUT_MS,
  );

  let loaded = false;
  let records = new Map();
  let loadError = null;
  const contexts = new Map();
  const flows = new Map();
  const refreshLocks = new Map();
  const listeners = new Set();

  function persistence() {
    if (loadError?.code === 'MCP_OAUTH_STORE_UNAVAILABLE') return 'unavailable';
    return getMemoryPersistence(safeStorage);
  }

  function ensureDir() {
    fsImpl.mkdirSync(path.dirname(storePath), { recursive: true });
  }

  function ensureLoaded() {
    if (loaded) {
      if (loadError) throw loadError;
      return;
    }
    loaded = true;
    if (getMemoryPersistence(safeStorage) !== 'encrypted') return;
    let envelope;
    try {
      if (!fsImpl.existsSync(storePath)) return;
      envelope = JSON.parse(fsImpl.readFileSync(storePath, 'utf8'));
      if (envelope?.version !== STORE_VERSION || envelope?.cipher !== 'electron-safeStorage') {
        throw new Error('invalid envelope');
      }
      const encrypted = Buffer.from(String(envelope.payload || ''), 'base64');
      const plaintext = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(String(plaintext || ''));
      if (!parsed || parsed.version !== STORE_VERSION || !parsed.records || typeof parsed.records !== 'object') {
        throw new Error('invalid payload');
      }
      records = new Map(Object.entries(parsed.records));
    } catch (error) {
      loadError = makeError('MCP_OAUTH_STORE_CORRUPT', 'OAuth credential store could not be decrypted');
      loadError.cause = error;
      throw loadError;
    }
  }

  function saveRecords() {
    ensureLoaded();
    if (getMemoryPersistence(safeStorage) !== 'encrypted') return;
    const payload = JSON.stringify({
      version: STORE_VERSION,
      records: Object.fromEntries(records),
    });
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(payload);
      if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted);
      ensureDir();
      const tempPath = `${storePath}.${process.pid}.${randomString(randomBytes, 8)}.tmp`;
      try {
        fsImpl.writeFileSync(tempPath, JSON.stringify({
          version: STORE_VERSION,
          cipher: 'electron-safeStorage',
          payload: encrypted.toString('base64'),
        }), 'utf8');
        fsImpl.renameSync(tempPath, storePath);
      } catch (error) {
        try { fsImpl.unlinkSync(tempPath); } catch { /* keep original store */ }
        throw error;
      }
    } catch (error) {
      loadError = makeError('MCP_OAUTH_STORE_UNAVAILABLE', 'OAuth credential store is unavailable');
      loadError.cause = error;
      throw loadError;
    }
  }

  function emit(event) {
    const safe = {
      flowId: String(event?.flowId || ''),
      name: String(event?.name || ''),
      state: String(event?.state || ''),
    };
    if (event?.error) safe.error = String(event.error.code || event.error);
    for (const listener of listeners) {
      try { listener({ ...safe }); } catch { /* observers are best effort */ }
    }
  }

  function effectiveResource(cfg) {
    const configured = normalizeUrl(cfg?.oauth?.resource);
    if (configured) return configured;
    return normalizeUrl(cfg?.url);
  }

  function findRecord(cfg) {
    ensureLoaded();
    const resource = effectiveResource(cfg);
    const expectedServer = normalizeUrl(cfg?.oauth?.authorizationServer);
    let fallback = null;
    for (const [key, value] of records) {
      if (!value || normalizeUrl(value.resource) !== resource) continue;
      if (expectedServer && normalizeUrl(value.authorizationServer) === expectedServer) {
        return { key, value };
      }
      if (!fallback) fallback = { key, value };
    }
    return fallback;
  }

  async function metadataRequest(url, code) {
    try {
      assertPublicHttps(url);
      const response = await requestJson(url, {
        requestFn: requestFn || undefined,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: options.timeoutMs || 15000,
        maxBytes: MAX_METADATA_BYTES,
        maxRedirects: 3,
        requireHttps: true,
        signal: options.signal,
      });
      return { response, data: isSuccess(response.status) ? parseJsonBody(response, code) : null };
    } catch (error) {
      if (error?.code === 'MCP_SSRF_PRIVATE' || error?.code === 'MCP_SSRF_DNS' || error?.code === 'MCP_SSRF_REDIRECT') {
        throw error;
      }
      throw makeError(code, 'OAuth metadata request failed');
    }
  }

  async function discoverContext(cfg) {
    const resource = effectiveResource(cfg);
    if (!resource) throw makeError('MCP_OAUTH_METADATA_INVALID', 'MCP resource URL is invalid');
    try { assertPublicHttps(resource); } catch (error) {
      throw error.code?.startsWith('MCP_SSRF') ? error : makeError('MCP_OAUTH_METADATA_INVALID', 'MCP OAuth resource must be public HTTPS');
    }
    const oauth = cfg?.oauth && typeof cfg.oauth === 'object' ? cfg.oauth : {};
    const cacheKey = JSON.stringify({
      resource,
      authorizationServer: normalizeUrl(oauth.authorizationServer),
      authorizationEndpoint: String(oauth.authorizationEndpoint || ''),
      tokenEndpoint: String(oauth.tokenEndpoint || ''),
      registrationEndpoint: String(oauth.registrationEndpoint || ''),
      revocationEndpoint: String(oauth.revocationEndpoint || ''),
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes.map(String) : [],
    });
    if (contexts.has(cacheKey)) return { ...contexts.get(cacheKey) };

    let protectedData = null;
    let protectedResponse = null;
    let protectedUrl = wellKnownUrl(resource, 'oauth-protected-resource');
    try {
      ({ response: protectedResponse, data: protectedData } = await metadataRequest(
        protectedUrl,
        'MCP_OAUTH_DISCOVERY_FAILED',
      ));
    } catch (error) {
      if (!oauth.authorizationEndpoint && !oauth.tokenEndpoint && !oauth.authorizationServer) throw error;
    }

    let hintedUrl = '';
    if (protectedResponse?.status === 401) {
      hintedUrl = parseResourceMetadataHeader(protectedResponse.headers, resource);
    }
    if (!protectedData && hintedUrl && hintedUrl !== protectedUrl) {
      ({ response: protectedResponse, data: protectedData } = await metadataRequest(
        hintedUrl,
        'MCP_OAUTH_DISCOVERY_FAILED',
      ));
    }

    // Some servers advertise resource_metadata only on the protected resource.
    if (!protectedData && !hintedUrl && protectedResponse?.status >= 400) {
      try {
        const resourceResponse = await metadataRequest(resource, 'MCP_OAUTH_DISCOVERY_FAILED');
        if (resourceResponse.response.status === 401) {
          hintedUrl = parseResourceMetadataHeader(resourceResponse.response.headers, resource);
          if (hintedUrl) {
            ({ data: protectedData } = await metadataRequest(
              hintedUrl,
              'MCP_OAUTH_DISCOVERY_FAILED',
            ));
          }
        }
      } catch {
        // Explicit endpoint overrides can still make an otherwise incomplete server usable.
      }
    }

    let authorizationServer = normalizeEndpoint(oauth.authorizationServer);
    const advertisedServers = Array.isArray(protectedData?.authorization_servers)
      ? protectedData.authorization_servers : [];
    if (!authorizationServer) {
      authorizationServer = advertisedServers.map(normalizeEndpoint).find(Boolean) || '';
    }
    let serverData = null;
    if (authorizationServer) {
      const asUrl = wellKnownUrl(authorizationServer, 'oauth-authorization-server');
      try {
        ({ data: serverData } = await metadataRequest(asUrl, 'MCP_OAUTH_DISCOVERY_FAILED'));
      } catch (error) {
        // RFC 8414 has an OpenID configuration fallback.
        try {
          ({ data: serverData } = await metadataRequest(
            wellKnownUrl(authorizationServer, 'openid-configuration'),
            'MCP_OAUTH_DISCOVERY_FAILED',
          ));
        } catch {
          if (!oauth.authorizationEndpoint && !oauth.tokenEndpoint) throw error;
        }
      }
    }

    const context = {
      resource,
      authorizationServer: authorizationServer || normalizeEndpoint(serverData?.issuer) || resource,
      authorizationEndpoint: normalizeEndpoint(oauth.authorizationEndpoint || serverData?.authorization_endpoint),
      tokenEndpoint: normalizeEndpoint(oauth.tokenEndpoint || serverData?.token_endpoint),
      registrationEndpoint: normalizeEndpoint(oauth.registrationEndpoint || serverData?.registration_endpoint),
      revocationEndpoint: normalizeEndpoint(oauth.revocationEndpoint || serverData?.revocation_endpoint),
      clientId: String(oauth.clientId || '').trim(),
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes.map(String).filter(Boolean).slice(0, 32) : [],
    };
    if (context.authorizationEndpoint && context.tokenEndpoint) {
      contexts.set(cacheKey, { ...context });
      return { ...context };
    }
    if (!context.authorizationEndpoint || !context.tokenEndpoint) {
      throw makeError('MCP_OAUTH_METADATA_INVALID', 'OAuth metadata did not contain required endpoints');
    }
    contexts.set(cacheKey, { ...context });
    return { ...context };
  }

  async function registerClient(context, redirectUri) {
    if (context.clientId) return context;
    if (!context.registrationEndpoint) throw makeError('MCP_OAUTH_CLIENT_REQUIRED', 'OAuth public clientId is required');
    let response;
    try {
      response = await requestJson(context.registrationEndpoint, {
        requestFn: requestFn || undefined,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Codex QQ Desktop',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        timeoutMs: options.timeoutMs || 15000,
        maxBytes: MAX_TOKEN_BYTES,
        maxRedirects: 0,
        requireHttps: true,
      });
    } catch (error) {
      if (error.code?.startsWith('MCP_SSRF')) throw error;
      throw makeError('MCP_OAUTH_REGISTRATION_FAILED', 'OAuth client registration failed');
    }
    if (!isSuccess(response.status)) {
      throw makeError('MCP_OAUTH_REGISTRATION_FAILED', 'OAuth client registration was rejected');
    }
    const data = parseJsonBody(response, 'MCP_OAUTH_REGISTRATION_FAILED');
    if (data.client_secret) throw makeError('MCP_OAUTH_CLIENT_REQUIRED', 'OAuth server requires a client secret');
    const clientId = String(data.client_id || '').trim();
    if (!clientId || clientId.length > 512) throw makeError('MCP_OAUTH_REGISTRATION_FAILED', 'OAuth registration returned no usable clientId');
    return { ...context, clientId };
  }

  function makeRedirectUri(port) {
    return `http://127.0.0.1:${Number(port)}/oauth/callback`;
  }

  function closeServer(flow) {
    if (!flow?.server || flow.serverClosed) return;
    flow.serverClosed = true;
    try { flow.server.close(); } catch { /* best effort */ }
  }

  function finishCallback(flow, error, params) {
    if (!flow || flow.callbackFinished) return;
    flow.callbackFinished = true;
    clearTimeout(flow.timer);
    closeServer(flow);
    if (error) flow.rejectCallback(error);
    else flow.resolveCallback(params);
  }

  async function listenLoopback(flow) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      flow.server = createServer((req, res) => {
        let requestUrl;
        try { requestUrl = new URL(String(req.url || ''), 'http://127.0.0.1'); } catch {
          res.statusCode = 400;
          res.end('OAuth callback failed');
          finishCallback(flow, makeError('MCP_OAUTH_STATE_MISMATCH', 'OAuth callback was invalid'));
          return;
        }
        const generic = (ok) => {
          res.statusCode = ok ? 200 : 400;
          res.setHeader?.('Content-Type', 'text/html; charset=utf-8');
          res.end(ok ? '<!doctype html><title>授权完成</title><p>授权已完成，可以返回应用。</p>' : '<!doctype html><title>授权失败</title><p>授权未完成，请返回应用重试。</p>');
        };
        if (req.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
          generic(false);
          finishCallback(flow, makeError('MCP_OAUTH_STATE_MISMATCH', 'OAuth callback path was invalid'));
          return;
        }
        const state = requestUrl.searchParams.get('state') || '';
        if (state !== flow.state) {
          generic(false);
          finishCallback(flow, makeError('MCP_OAUTH_STATE_MISMATCH', 'OAuth state did not match'));
          return;
        }
        if (requestUrl.searchParams.get('error')) {
          generic(false);
          finishCallback(flow, makeError('MCP_AUTH_REQUIRED', 'OAuth authorization was cancelled'));
          return;
        }
        const code = requestUrl.searchParams.get('code') || '';
        if (!code) {
          generic(false);
          finishCallback(flow, makeError('MCP_OAUTH_TOKEN_FAILED', 'OAuth callback did not contain a code'));
          return;
        }
        generic(true);
        finishCallback(flow, null, { code });
      });
      flow.server.once?.('error', (error) => done(reject, error));
      flow.server.listen(0, '127.0.0.1', () => {
        const address = flow.server.address?.();
        const port = typeof address === 'object' && address ? Number(address.port) : 0;
        if (!port) return done(reject, new Error('loopback listener returned no port'));
        flow.port = port;
        done(resolve);
      });
    });
    flow.redirectUri = makeRedirectUri(flow.port);
  }

  function buildAuthorizationUrl(context, redirectUri, state, pkce) {
    let url;
    try { url = new URL(assertPublicHttps(context.authorizationEndpoint).url.href); } catch {
      throw makeError('MCP_OAUTH_METADATA_INVALID', 'OAuth authorization endpoint is invalid');
    }
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', context.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (context.resource) url.searchParams.set('resource', context.resource);
    if (context.scopes?.length) url.searchParams.set('scope', context.scopes.join(' '));
    return url.href;
  }

  async function exchangeCode(context, code, redirectUri, verifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
      client_id: context.clientId,
      code_verifier: verifier,
    });
    if (context.resource) body.set('resource', context.resource);
    let response;
    try {
      response = await requestJson(context.tokenEndpoint, {
        requestFn: requestFn || undefined,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeoutMs: options.timeoutMs || 15000,
        maxBytes: MAX_TOKEN_BYTES,
        maxRedirects: 0,
        requireHttps: true,
      });
    } catch (error) {
      if (error.code?.startsWith('MCP_SSRF')) throw error;
      throw makeError('MCP_OAUTH_TOKEN_FAILED', 'OAuth token exchange failed');
    }
    let data = null;
    try { data = parseJsonBody(response, 'MCP_OAUTH_TOKEN_FAILED'); } catch (error) { throw error; }
    if (!isSuccess(response.status)) throw responseError(data, 'MCP_OAUTH_TOKEN_FAILED');
    return tokenFromResponse(data, context, null, now);
  }

  async function saveToken(context, token) {
    ensureLoaded();
    const key = storageKey(context.resource, context.authorizationServer);
    records.set(key, {
      ...token,
      savedAt: now(),
    });
    saveRecords();
    return key;
  }

  async function refreshRecord(record) {
    const previous = record.value;
    if (!previous?.refreshToken) throw makeError('MCP_AUTH_REQUIRED', 'OAuth refresh token is unavailable');
    const context = sanitizeContext(previous);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken,
      client_id: previous.clientId,
    });
    if (context.resource) body.set('resource', context.resource);
    let response;
    try {
      response = await requestJson(context.tokenEndpoint, {
        requestFn: requestFn || undefined,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeoutMs: options.timeoutMs || 15000,
        maxBytes: MAX_TOKEN_BYTES,
        maxRedirects: 0,
        requireHttps: true,
      });
    } catch (error) {
      if (error.code?.startsWith('MCP_SSRF')) throw error;
      throw makeError('MCP_OAUTH_REFRESH_FAILED', 'OAuth refresh failed');
    }
    let data;
    try { data = parseJsonBody(response, 'MCP_OAUTH_REFRESH_FAILED'); } catch (error) { throw error; }
    if (!isSuccess(response.status)) {
      if (isInvalidGrant(data)) {
        records.delete(record.key);
        try { saveRecords(); } catch { /* auth is still required even if cleanup cannot persist */ }
        throw makeError('MCP_AUTH_REQUIRED', 'OAuth authorization is required again');
      }
      throw makeError('MCP_OAUTH_REFRESH_FAILED', 'OAuth refresh was rejected');
    }
    const token = tokenFromResponse(data, context, previous, now, 'MCP_OAUTH_REFRESH_FAILED');
    records.set(record.key, { ...token, savedAt: now() });
    saveRecords();
    return records.get(record.key);
  }

  async function getFreshRecord(cfg) {
    const found = findRecord(cfg);
    if (!found) return null;
    const expiresAt = Number(found.value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > now() + REFRESH_SKEW_MS) return found;
    if (!found.value.refreshToken) return found;
    if (!refreshLocks.has(found.key)) {
      refreshLocks.set(found.key, refreshRecord(found).finally(() => refreshLocks.delete(found.key)));
    }
    await refreshLocks.get(found.key);
    return findRecord(cfg);
  }

  async function getHeaders(name, cfg) {
    if (cfg?.auth !== 'oauth') return {};
    const found = await getFreshRecord(cfg);
    if (!found?.value?.accessToken) throw makeError('MCP_AUTH_REQUIRED', `MCP server ${name} requires OAuth authorization`);
    if (Number.isFinite(Number(found.value.expiresAt)) && Number(found.value.expiresAt) <= now()) {
      throw makeError('MCP_AUTH_REQUIRED', `MCP server ${name} requires OAuth authorization`);
    }
    const tokenType = found.value.tokenType || 'Bearer';
    return { Authorization: `${tokenType} ${found.value.accessToken}` };
  }

  async function refresh(name, cfg) {
    if (cfg?.auth !== 'oauth') return false;
    const found = findRecord(cfg);
    if (!found?.value?.refreshToken) throw makeError('MCP_AUTH_REQUIRED', `MCP server ${name} requires OAuth authorization`);
    if (!refreshLocks.has(found.key)) {
      refreshLocks.set(found.key, refreshRecord(found).finally(() => refreshLocks.delete(found.key)));
    }
    await refreshLocks.get(found.key);
    return true;
  }

  async function authorize(name, cfg) {
    const serverName = String(name || '').trim();
    if (!serverName || cfg?.auth !== 'oauth') throw makeError('MCP_OAUTH_METADATA_INVALID', 'OAuth server configuration is invalid');
    if (flows.has(serverName)) throw makeError('MCP_OAUTH_CALLBACK_TIMEOUT', 'An OAuth flow is already running for this server');
    const flowId = `oauth_${now().toString(36)}_${randomString(randomBytes, 6)}`;
    const flow = {
      flowId,
      name: serverName,
      callbackFinished: false,
      serverClosed: false,
      state: randomString(randomBytes, 24),
      pkce: createPkce(randomBytes),
    };
    flow.callback = new Promise((resolve, reject) => {
      flow.resolveCallback = resolve;
      flow.rejectCallback = reject;
    });
    flows.set(flowId, flow);
    emit({ flowId, name: serverName, state: 'starting' });

    try {
      await listenLoopback(flow);
      let context = await discoverContext(cfg);
      context = await registerClient(context, flow.redirectUri);
      flow.context = context;
      const authorizationUrl = buildAuthorizationUrl(context, flow.redirectUri, flow.state, flow.pkce);
      flow.timer = setTimeout(() => finishCallback(
        flow,
        makeError('MCP_OAUTH_CALLBACK_TIMEOUT', 'OAuth callback timed out'),
      ), callbackTimeoutMs);
      emit({ flowId, name: serverName, state: 'waiting' });
      let opened;
      try {
        if (!requestFn || options.dnsLookup) {
          await verifyPublicHttps(context.authorizationEndpoint, {
            dnsLookup: options.dnsLookup,
          });
        }
        opened = await openExternal(authorizationUrl);
      } catch {
        throw makeError('MCP_OAUTH_CALLBACK_TIMEOUT', 'Could not open the system browser');
      }
      if (opened === false) throw makeError('MCP_OAUTH_CALLBACK_TIMEOUT', 'Could not open the system browser');
      const callback = await flow.callback;
      emit({ flowId, name: serverName, state: 'exchanging' });
      const token = await exchangeCode(context, callback.code, flow.redirectUri, flow.pkce.verifier);
      await saveToken(context, token);
      emit({ flowId, name: serverName, state: 'success' });
      return getStatus(serverName, cfg);
    } catch (error) {
      closeServer(flow);
      if (error?.code === 'MCP_AUTH_REQUIRED' && flow.cancelled) {
        emit({ flowId, name: serverName, state: 'cancelled' });
      } else if (flow.cancelled) {
        emit({ flowId, name: serverName, state: 'cancelled' });
      } else {
        emit({ flowId, name: serverName, state: 'error', error });
      }
      throw error?.code ? error : makeError('MCP_OAUTH_TOKEN_FAILED', 'OAuth authorization failed');
    } finally {
      clearTimeout(flow.timer);
      closeServer(flow);
      flows.delete(flowId);
    }
  }

  function cancel(flowId) {
    const flow = flows.get(String(flowId || ''));
    if (!flow) return false;
    flow.cancelled = true;
    finishCallback(flow, makeError('MCP_AUTH_REQUIRED', 'OAuth authorization was cancelled'));
    return true;
  }

  async function logout(name, cfg) {
    const found = findRecord(cfg);
    if (!found) return { ok: true, status: getStatus(name, cfg) };
    let warning = null;
    const endpoint = normalizeEndpoint(cfg?.oauth?.revocationEndpoint || found.value.revocationEndpoint);
    if (endpoint) {
      try {
        const body = new URLSearchParams({
          token: found.value.accessToken,
          client_id: found.value.clientId,
          token_type_hint: 'access_token',
        });
        const response = await requestJson(endpoint, {
          requestFn: requestFn || undefined,
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          timeoutMs: options.timeoutMs || 15000,
          maxBytes: MAX_TOKEN_BYTES,
          maxRedirects: 0,
          requireHttps: true,
        });
        if (!isSuccess(response.status)) warning = makeError('MCP_OAUTH_REVOKE_FAILED', 'OAuth revocation was rejected');
      } catch {
        warning = makeError('MCP_OAUTH_REVOKE_FAILED', 'OAuth revocation failed');
      }
    }
    records.delete(found.key);
    try { saveRecords(); } catch (error) {
      if (!warning) warning = error;
    }
    return {
      ok: true,
      ...(warning ? { code: warning.code, error: warning.message } : {}),
      status: getStatus(name, cfg),
    };
  }

  function getStatus(name, cfg) {
    try {
      const found = cfg?.auth === 'oauth' ? findRecord(cfg) : null;
      return {
        name: String(name || ''),
        auth: cfg?.auth === 'oauth' ? 'oauth' : 'none',
        authorized: Boolean(found?.value?.accessToken),
        expiresAt: found?.value?.expiresAt == null ? null : Number(found.value.expiresAt) || null,
        canRefresh: Boolean(found?.value?.refreshToken),
        persistence: persistence(),
        ...(loadError ? { lastErrorCode: loadError.code } : {}),
      };
    } catch (error) {
      return {
        name: String(name || ''),
        auth: cfg?.auth === 'oauth' ? 'oauth' : 'none',
        authorized: false,
        expiresAt: null,
        canRefresh: false,
        persistence: error.code === 'MCP_OAUTH_STORE_CORRUPT' ? 'unavailable' : persistence(),
        lastErrorCode: error.code || 'MCP_OAUTH_STORE_UNAVAILABLE',
      };
    }
  }

  function statuses(serverConfigs) {
    return (Array.isArray(serverConfigs) ? serverConfigs : [])
      .map((cfg) => getStatus(cfg.name, cfg));
  }

  function getAuthProvider(name, cfg) {
    if (cfg?.auth !== 'oauth') return undefined;
    return {
      getHeaders: () => getHeaders(name, cfg),
      refresh: () => refresh(name, cfg),
    };
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function closeAll() {
    for (const flow of flows.values()) {
      flow.cancelled = true;
      finishCallback(flow, makeError('MCP_AUTH_REQUIRED', 'OAuth authorization was cancelled'));
    }
    flows.clear();
  }

  return {
    authorize,
    cancel,
    logout,
    getStatus,
    statuses,
    getHeaders,
    refresh,
    getAuthProvider,
    onEvent,
    closeAll,
    discoverContext,
    storageKey,
    get storePath() { return storePath; },
  };
}

module.exports = {
  CALLBACK_PATH,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  REFRESH_SKEW_MS,
  createPkce,
  storageKey,
  wellKnownUrl,
  parseResourceMetadataHeader,
  tokenFromResponse,
  createMcpOAuthManager,
};
