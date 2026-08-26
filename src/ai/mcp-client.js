'use strict';

const { spawn } = require('child_process');
const { createMcpRpcDispatcher, rpcError } = require('./mcp-rpc');

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;
const BODY_MAX = 1024 * 1024;

/** Encode a JSON-RPC object as an MCP Content-Length frame. */
function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > BODY_MAX) throw rpcError('MCP message too large', -32003);
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, json]);
}

/** Incremental Content-Length frame reader. */
function createFrameReader() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buf.length > BODY_MAX * 2) {
        buf = Buffer.alloc(0);
        return [];
      }
      const out = [];
      while (true) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const header = buf.slice(0, sep).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          buf = buf.slice(sep + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = sep + 4;
        if (!Number.isSafeInteger(length) || length < 0 || length > BODY_MAX) {
          buf = buf.slice(start);
          continue;
        }
        if (buf.length < start + length) break;
        const body = buf.slice(start, start + length).toString('utf8');
        buf = buf.slice(start + length);
        try { out.push(JSON.parse(body)); } catch { /* malformed frame */ }
      }
      return out;
    },
  };
}

function capabilityOptions(opts) {
  const configured = opts.capabilities && typeof opts.capabilities === 'object'
    ? opts.capabilities
    : {};
  const capabilities = { ...configured };
  if (opts.rootsProvider || opts.getRoots) capabilities.roots = { listChanged: true };
  if (opts.samplingHandler) capabilities.sampling = {};
  return capabilities;
}

function createMcpStdioClient(opts = {}) {
  const command = String(opts.command || '').trim();
  const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const cwd = opts.cwd;
  const extraEnv = opts.env && typeof opts.env === 'object' ? opts.env : null;
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
    ? Number(opts.timeoutMs)
    : REQUEST_TIMEOUT_MS;

  let child = null;
  let reader = createFrameReader();
  let rpc = null;
  let started = false;
  let permanentlyClosed = false;
  let serverCapabilities = {};
  let reconnecting = null;
  let transportErrorReported = false;

  function write(message) {
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('MCP process not running');
    }
    child.stdin.write(encodeFrame(message));
  }

  function makeDispatcher() {
    rpc = createMcpRpcDispatcher({
      timeoutMs,
      send: (message) => write(message),
      requestHandler: async (method, params, _message, signal) => {
        if (method === 'roots/list') {
          const provider = opts.rootsProvider || opts.getRoots;
          if (!provider) {
            const error = new Error('roots unavailable');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          return provider(params, signal);
        }
        if (method === 'sampling/createMessage' && typeof opts.samplingHandler === 'function') {
          if (!serverCapabilities || typeof serverCapabilities.sampling !== 'object') {
            const error = new Error('MCP server did not declare sampling capability');
            error.code = 'MCP_METHOD_NOT_FOUND';
            throw error;
          }
          return opts.samplingHandler(params, signal);
        }
        const error = new Error(`MCP method not found: ${method}`);
        error.code = 'MCP_METHOD_NOT_FOUND';
        throw error;
      },
      notificationHandler: opts.notificationHandler,
      onError: opts.onError,
    });
  }

  function rejectProcess(error) {
    started = false;
    try { rpc?.close(error instanceof Error ? error : new Error(String(error))); } catch { /* ignore */ }
    if (!transportErrorReported) {
      transportErrorReported = true;
      opts.onTransportError?.(error);
    }
  }

  function attachChild(nextChild) {
    child = nextChild;
    if (!child) throw new Error('MCP spawn failed');
    transportErrorReported = false;
    reader = createFrameReader();
    makeDispatcher();
    const attachedChild = child;
    child.stdout?.on?.('data', (chunk) => {
      for (const message of reader.push(chunk)) rpc?.dispatch(message);
    });
    child.stderr?.on?.('data', () => {});
    child.on?.('error', (error) => {
      if (child !== attachedChild) return;
      rejectProcess(error || new Error('MCP process error'));
    });
    child.on?.('exit', () => {
      if (permanentlyClosed || child !== attachedChild) return;
      rejectProcess(new Error('MCP process exited'));
    });
  }

  async function initialize() {
    const result = await rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: capabilityOptions(opts),
      clientInfo: { name: 'codex-qq', version: '1.0.0' },
    }, { replayable: true });
    serverCapabilities = result?.capabilities && typeof result.capabilities === 'object'
      ? result.capabilities
      : {};
    await rpc.notify('notifications/initialized', {});
  }

  async function start() {
    if (started) return;
    if (permanentlyClosed) throw new Error('MCP client closed');
    if (!command) throw new Error('MCP command required');
    const env = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
    const spawnOpts = { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false };
    if (cwd) spawnOpts.cwd = cwd;
    attachChild(spawnFn(command, args, spawnOpts));
    try {
      await initialize();
      started = true;
    } catch (error) {
      await closeProcess(error);
      throw error;
    }
  }

  async function closeProcess(error) {
    started = false;
    try { rpc?.close(error instanceof Error ? error : new Error('MCP client closed')); } catch { /* ignore */ }
    const current = child;
    child = null;
    if (current) {
      try { current.kill?.(); } catch { /* ignore */ }
    }
  }

  async function reconnect(reason) {
    if (permanentlyClosed) throw new Error('MCP client closed');
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      await closeProcess(new Error(`MCP reconnect: ${reason || 'transport error'}`));
      serverCapabilities = {};
      await start();
    })();
    try { await reconnecting; } finally { reconnecting = null; }
  }

  function request(method, params, requestOptions) {
    if (!rpc || !started) return Promise.reject(new Error('MCP client not started'));
    return rpc.request(method, params, requestOptions);
  }
  function notify(method, params) {
    if (!rpc || !started) return Promise.reject(new Error('MCP client not started'));
    return rpc.notify(method, params);
  }
  async function listTools() {
    const result = await request('tools/list', {}, { replayable: true });
    return Array.isArray(result?.tools) ? result.tools : (Array.isArray(result) ? result : []);
  }
  async function callTool(name, toolArgs, requestOptions = {}) {
    return request('tools/call', {
      name: String(name || ''),
      arguments: toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs) ? toolArgs : {},
    }, { ...requestOptions, replayable: false });
  }
  async function listResources() {
    try {
      const result = await request('resources/list', {}, { replayable: true });
      return Array.isArray(result?.resources) ? result.resources : [];
    } catch { return []; }
  }
  async function readResource(uri, requestOptions = {}) {
    return request('resources/read', { uri: String(uri || '') }, { ...requestOptions, replayable: false });
  }
  async function listPrompts() {
    const result = await request('prompts/list', {}, { replayable: true });
    return Array.isArray(result?.prompts) ? result.prompts : [];
  }
  async function getPrompt(name, args, requestOptions = {}) {
    return request('prompts/get', {
      name: String(name || ''),
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    }, { ...requestOptions, replayable: false });
  }
  async function notifyRootsChanged() {
    return notify('notifications/roots/list_changed', {});
  }
  async function close() {
    permanentlyClosed = true;
    await closeProcess();
  }

  return {
    start,
    reconnect,
    request,
    notify,
    listTools,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt,
    notifyRootsChanged,
    getServerCapabilities: () => ({ ...serverCapabilities }),
    close,
  };
}

function createMcpClient(opts = {}) {
  const transport = String(opts.transport || 'stdio').toLowerCase();
  if (transport === 'http') return require('./mcp-http').createMcpHttpClient(opts);
  if (transport === 'sse') return require('./mcp-sse').createMcpSseClient(opts);
  return createMcpStdioClient(opts);
}

module.exports = {
  encodeFrame,
  createFrameReader,
  createMcpClient,
  createMcpStdioClient,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  BODY_MAX,
};
