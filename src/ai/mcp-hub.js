'use strict';

const { createMcpClient } = require('./mcp-client');
const { isHttpUrl } = require('./mcp-config');

const RESERVED_TOOL_NAMES = new Set(['mcp_resources_list', 'mcp_resource_read']);
const RESULT_MAX = 32 * 1024;

function sanitizeToolPart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_') || 'tool';
}

function truncateText(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  let truncated = false;
  if (text.length > RESULT_MAX) {
    text = text.slice(0, RESULT_MAX);
    truncated = true;
  }
  return { text, truncated };
}

/**
 * Per-run MCP hub: serial connect, tool naming mcp_<server>_<tool>, disconnect all.
 * @param {{ createClient?: Function }} [opts]
 */
function createMcpHub(opts = {}) {
  const createClient =
    opts.createClient ||
    ((cfg) => createMcpClient({ ...cfg, transport: cfg.transport || 'stdio' }));
  /** @type {Map<string, { client: any, tools: any[] }>} */
  const servers = new Map();
  /** @type {Map<string, { serverName: string, toolName: string, description?: string, inputSchema?: any }>} */
  const route = new Map();
  /** @type {Map<string, any[]>} */
  const resourcesByServer = new Map();

  function isValidConfig(cfg) {
    const name = String(cfg?.name || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
    const transport = String(cfg.transport || 'stdio').toLowerCase();
    if (transport === 'http' || transport === 'sse') {
      return isHttpUrl(cfg.url);
    }
    return Boolean(cfg.command);
  }

  async function startAll(serverConfigs, { cwd, onStatus, signal } = {}) {
    await stopAll();
    const list = Array.isArray(serverConfigs) ? serverConfigs : [];
    for (const cfg of list) {
      if (signal?.aborted) break;
      const name = String(cfg.name || '').trim();
      if (cfg.enabled === false) {
        continue;
      }
      if (!isValidConfig(cfg)) {
        onStatus?.({ server: name || '?', ok: false, error: 'invalid config' });
        continue;
      }
      let client = null;
      let started = false;
      try {
        client = createClient({
          ...cfg,
          transport: cfg.transport || 'stdio',
          cwd: cfg.cwd || cwd,
        });
        await client.start();
        started = true;
        const tools = await client.listTools();
        let resources = [];
        if (typeof client.listResources === 'function') {
          try {
            resources = (await client.listResources()) || [];
          } catch {
            resources = [];
          }
        }
        servers.set(name, { client, tools: tools || [] });
        resourcesByServer.set(name, Array.isArray(resources) ? resources : []);
        started = false; // ownership transferred to servers map
        for (const t of tools || []) {
          let full = `mcp_${name}_${sanitizeToolPart(t.name)}`;
          let n = 2;
          while (route.has(full) || RESERVED_TOOL_NAMES.has(full)) {
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
    if (servers.size > 0) {
      defs.push(
        {
          type: 'function',
          function: {
            name: 'mcp_resources_list',
            description: 'List MCP resources from connected servers',
            parameters: {
              type: 'object',
              properties: { server: { type: 'string' } },
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mcp_resource_read',
            description: 'Read one MCP resource by server name and uri',
            parameters: {
              type: 'object',
              properties: {
                server: { type: 'string' },
                uri: { type: 'string' },
              },
              required: ['server', 'uri'],
            },
          },
        }
      );
    }
    return defs;
  }

  async function callResourcesList(args) {
    const filter = args && args.server != null && String(args.server).trim()
      ? String(args.server).trim()
      : null;
    const resources = [];
    for (const [serverName, list] of resourcesByServer) {
      if (filter && serverName !== filter) continue;
      for (const r of list || []) {
        resources.push({
          server: serverName,
          uri: r.uri,
          ...(r.name != null ? { name: r.name } : {}),
          ...(r.description != null ? { description: r.description } : {}),
          ...(r.mimeType != null ? { mimeType: r.mimeType } : {}),
        });
      }
    }
    return { ok: true, resources };
  }

  async function callResourceRead(args) {
    const server = String(args?.server || '').trim();
    const uri = String(args?.uri || '');
    if (!server || !uri) {
      return { ok: false, error: 'server 与 uri 必填' };
    }
    const entry = servers.get(server);
    if (!entry) return { ok: false, error: 'server 未连接: ' + server };
    if (typeof entry.client.readResource !== 'function') {
      return { ok: false, error: 'server 不支持 resources: ' + server };
    }
    try {
      const result = await entry.client.readResource(uri);
      const { text, truncated } = truncateText(result);
      return truncated
        ? { ok: true, contents: text, truncated: true }
        : { ok: true, contents: text };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async function call(fullName, args) {
    if (fullName === 'mcp_resources_list') {
      return callResourcesList(args || {});
    }
    if (fullName === 'mcp_resource_read') {
      return callResourceRead(args || {});
    }
    const meta = route.get(fullName);
    if (!meta) return { ok: false, error: '未知 mcp 工具: ' + fullName };
    const entry = servers.get(meta.serverName);
    if (!entry) return { ok: false, error: 'server 未连接: ' + meta.serverName };
    try {
      const result = await entry.client.callTool(meta.toolName, args || {});
      const { text, truncated } = truncateText(result);
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
    resourcesByServer.clear();
  }

  return { startAll, getToolDefs, call, stopAll };
}

module.exports = { createMcpHub, sanitizeToolPart };
