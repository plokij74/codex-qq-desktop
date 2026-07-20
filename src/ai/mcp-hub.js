'use strict';

const { createMcpClient } = require('./mcp-client');

function sanitizeToolPart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_') || 'tool';
}

/**
 * Per-run MCP hub: serial connect, tool naming mcp_<server>_<tool>, disconnect all.
 * @param {{ createClient?: typeof createMcpClient }} [opts]
 */
function createMcpHub(opts = {}) {
  const createClient = opts.createClient || createMcpClient;
  /** @type {Map<string, { client: any, tools: any[] }>} */
  const servers = new Map();
  /** @type {Map<string, { serverName: string, toolName: string, description?: string, inputSchema?: any }>} */
  const route = new Map();

  async function startAll(serverConfigs, { cwd, onStatus, signal } = {}) {
    await stopAll();
    const list = Array.isArray(serverConfigs) ? serverConfigs : [];
    for (const cfg of list) {
      if (signal?.aborted) break;
      const name = String(cfg.name || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !cfg.command) {
        onStatus?.({ server: name || '?', ok: false, error: 'invalid config' });
        continue;
      }
      let client = null;
      let started = false;
      try {
        client = createClient({
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env,
          cwd: cfg.cwd || cwd,
        });
        await client.start();
        started = true;
        const tools = await client.listTools();
        servers.set(name, { client, tools: tools || [] });
        started = false; // ownership transferred to servers map
        for (const t of tools || []) {
          let full = `mcp_${name}_${sanitizeToolPart(t.name)}`;
          let n = 2;
          while (route.has(full)) {
            full = `mcp_${name}_${sanitizeToolPart(t.name)}_${n++}`;
          }
          route.set(full, {
            serverName: name,
            toolName: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
        onStatus?.({ server: name, ok: true });
      } catch (err) {
        if (started && client) {
          try {
            await client.close();
          } catch {
            /* ignore close errors on failed start */
          }
        }
        onStatus?.({ server: name, ok: false, error: err.message || String(err) });
      }
    }
  }

  function getToolDefs() {
    const defs = [];
    for (const [full, meta] of route) {
      defs.push({
        type: 'function',
        function: {
          name: full,
          description: meta.description || `MCP ${meta.serverName}/${meta.toolName}`,
          parameters: meta.inputSchema && typeof meta.inputSchema === 'object'
            ? meta.inputSchema
            : { type: 'object', properties: {} },
        },
      });
    }
    return defs;
  }

  async function call(fullName, args) {
    const meta = route.get(fullName);
    if (!meta) return { ok: false, error: '未知 mcp 工具: ' + fullName };
    const entry = servers.get(meta.serverName);
    if (!entry) return { ok: false, error: 'server 未连接: ' + meta.serverName };
    try {
      const result = await entry.client.callTool(meta.toolName, args || {});
      let text = typeof result === 'string' ? result : JSON.stringify(result);
      let truncated = false;
      if (text.length > 32 * 1024) {
        text = text.slice(0, 32 * 1024);
        truncated = true;
      }
      return { ok: true, result: text, truncated };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async function stopAll() {
    for (const [, entry] of servers) {
      try {
        await entry.client.close();
      } catch {
        /* ignore close errors */
      }
    }
    servers.clear();
    route.clear();
  }

  return { startAll, getToolDefs, call, stopAll };
}

module.exports = { createMcpHub, sanitizeToolPart };
