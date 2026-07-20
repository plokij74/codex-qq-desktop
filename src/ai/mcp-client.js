'use strict';

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Encode a JSON-RPC object as an MCP Content-Length frame.
 * @param {object} obj
 * @returns {Buffer}
 */
function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, json]);
}

/**
 * Incremental Content-Length frame reader.
 * @returns {{ push(chunk: Buffer|string): object[] }}
 */
function createFrameReader() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const out = [];
      while (true) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const header = buf.slice(0, sep).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // drop invalid header block
          buf = buf.slice(sep + 4);
          continue;
        }
        const len = Number(m[1]);
        const start = sep + 4;
        if (buf.length < start + len) break;
        const body = buf.slice(start, start + len).toString('utf8');
        buf = buf.slice(start + len);
        try {
          out.push(JSON.parse(body));
        } catch {
          /* skip malformed JSON body */
        }
      }
      return out;
    },
  };
}

/**
 * Minimal MCP stdio JSON-RPC client (tools/list + tools/call).
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   spawnFn?: typeof spawn,
 *   timeoutMs?: number,
 * }} opts
 * @returns {{
 *   start(): Promise<void>,
 *   listTools(): Promise<object[]>,
 *   callTool(name: string, args?: object): Promise<any>,
 *   close(): void,
 * }}
 */
function createMcpClient(opts = {}) {
  const command = opts.command;
  const args = Array.isArray(opts.args) ? opts.args : [];
  const cwd = opts.cwd;
  const extraEnv = opts.env && typeof opts.env === 'object' ? opts.env : null;
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs
      : REQUEST_TIMEOUT_MS;

  let child = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  const reader = createFrameReader();
  let closed = false;
  let started = false;

  function rejectAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      try {
        p.reject(err);
      } catch {
        /* ignore */
      }
    }
    pending.clear();
  }

  function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id === undefined || msg.id === null) return; // notifications / server requests ignored
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.error) {
      const e = new Error(
        (msg.error && msg.error.message) || JSON.stringify(msg.error)
      );
      e.code = msg.error.code;
      e.data = msg.error.data;
      p.reject(e);
    } else {
      p.resolve(msg.result);
    }
  }

  function onStdout(chunk) {
    const msgs = reader.push(chunk);
    for (const m of msgs) dispatch(m);
  }

  function write(obj) {
    if (!child || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('MCP process not running');
    }
    child.stdin.write(encodeFrame(obj));
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error('MCP client closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        const msg = { jsonrpc: '2.0', id, method };
        if (params !== undefined) msg.params = params;
        write(msg);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    write(msg);
  }

  async function start() {
    if (started) return;
    if (closed) throw new Error('MCP client closed');
    if (!command) throw new Error('MCP command required');

    const env = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
    const spawnOpts = {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    if (cwd) spawnOpts.cwd = cwd;

    child = spawnFn(command, args, spawnOpts);
    if (!child) throw new Error('MCP spawn failed');

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', onStdout);
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      // Drain stderr so the pipe does not fill and block the child.
      child.stderr.on('data', () => {});
    }
    if (typeof child.on === 'function') {
      child.on('error', (err) => {
        closed = true;
        rejectAll(err || new Error('MCP process error'));
      });
      child.on('exit', () => {
        closed = true;
        rejectAll(new Error('MCP process exited'));
      });
    }

    try {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codex-qq', version: '1.0.0' },
      });
      notify('notifications/initialized', {});
      started = true;
    } catch (err) {
      close();
      throw err;
    }
  }

  async function listTools() {
    const result = await request('tools/list', {});
    if (Array.isArray(result?.tools)) return result.tools;
    if (Array.isArray(result)) return result;
    return [];
  }

  async function callTool(name, toolArgs) {
    return request('tools/call', {
      name,
      arguments: toolArgs && typeof toolArgs === 'object' ? toolArgs : {},
    });
  }

  function close() {
    closed = true;
    rejectAll(new Error('MCP client closed'));
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      child = null;
    }
  }

  return {
    start,
    listTools,
    callTool,
    close,
  };
}

module.exports = {
  encodeFrame,
  createFrameReader,
  createMcpClient,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
};
