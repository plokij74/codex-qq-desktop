'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMcpClient } = require('./mcp-client');
const { createMcpSessionManager, configFingerprint } = require('./mcp-session-manager');
const { isHttpUrl } = require('./mcp-config');
const { redactSensitive } = require('./network-security');
const { supportsTaskRequest } = require('./mcp-protocol');

const RESERVED_TOOL_NAMES = new Set([
  'mcp_resources_list', 'mcp_resource_read', 'mcp_prompts_list', 'mcp_prompt_get',
  'mcp_tasks_list', 'mcp_task_get', 'mcp_task_result', 'mcp_task_cancel',
]);
const RESULT_MAX = 32 * 1024;
const PROMPT_NAME_MAX = 160;
const PROMPT_ARGS_MAX = 32;
const PROMPT_ARG_VALUE_MAX = 4096;
const PROMPT_LIST_MAX = 128;
const PROMPT_DESCRIPTION_MAX = 1000;
const PROMPT_MESSAGES_MAX = 64;
const PROMPT_MESSAGE_MAX = 16 * 1024;

function sanitizeToolPart(s) { return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_') || 'tool'; }

function truncateText(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = ''; }
  text = String(text || '');
  const truncated = text.length > RESULT_MAX;
  return { text: truncated ? text.slice(0, RESULT_MAX) : text, truncated };
}

function sanitizeMcpError(error) {
  const code = String(error?.code || '').trim();
  if (code.startsWith('MCP_')) return code;
  return redactSensitive(error?.message || String(error || 'MCP server failed')).slice(0, 300);
}

function isValidServerName(name) { return /^[a-zA-Z0-9_-]+$/.test(String(name || '').trim()); }

function normalizePromptArgs(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('MCP prompt arguments invalid'), { code: 'MCP_PROMPT_ARGUMENTS_INVALID' });
  const keys = Object.keys(raw);
  if (keys.length > PROMPT_ARGS_MAX) throw Object.assign(new Error('MCP prompt arguments too many'), { code: 'MCP_PROMPT_ARGUMENTS_INVALID' });
  const out = {};
  for (const key of keys) {
    const name = String(key || '').trim();
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw Object.assign(new Error('MCP prompt argument name invalid'), { code: 'MCP_PROMPT_ARGUMENTS_INVALID' });
    const value = raw[key];
    if (typeof value === 'string') {
      if (value.length > PROMPT_ARG_VALUE_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Object.assign(new Error('MCP prompt argument value invalid'), { code: 'MCP_PROMPT_ARGUMENTS_INVALID' });
      out[name] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[name] = value;
    else throw Object.assign(new Error('MCP prompt argument value invalid'), { code: 'MCP_PROMPT_ARGUMENTS_INVALID' });
  }
  return out;
}

function cleanPromptText(raw, max = PROMPT_DESCRIPTION_MAX) {
  return String(raw || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, max);
}

function normalizePromptDescriptor(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const name = String(item.name || '').trim();
  if (!name || name.length > PROMPT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  const out = {
    name,
    description: cleanPromptText(item.description, PROMPT_DESCRIPTION_MAX),
    arguments: [],
  };
  if (Array.isArray(item.arguments)) {
    for (const argument of item.arguments.slice(0, PROMPT_ARGS_MAX)) {
      if (!argument || typeof argument !== 'object' || Array.isArray(argument)) continue;
      const argumentName = String(argument.name || '').trim();
      if (!argumentName || argumentName.length > 128 || /[\u0000-\u001f\u007f]/.test(argumentName)) continue;
      out.arguments.push({
        name: argumentName,
        description: cleanPromptText(argument.description, 500),
        required: argument.required === true,
      });
    }
  }
  return out;
}

function normalizePromptList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, PROMPT_LIST_MAX)) {
    const prompt = normalizePromptDescriptor(item);
    if (!prompt || seen.has(prompt.name)) continue;
    seen.add(prompt.name);
    out.push(prompt);
  }
  return out;
}

function promptContentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(promptContentToText).filter(Boolean).join('\n');
  if (typeof content !== 'object') return String(content);
  if (content.type && content.type !== 'text') throw Object.assign(new Error('MCP prompt content unsupported'), { code: 'MCP_PROMPT_CONTENT_UNSUPPORTED' });
  if (typeof content.text === 'string') return cleanPromptText(content.text, PROMPT_MESSAGE_MAX);
  if (content.content !== undefined) return promptContentToText(content.content);
  return '';
}

function promptResultToText(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const chunks = [];
  for (const message of messages.slice(0, PROMPT_MESSAGES_MAX)) {
    const text = promptContentToText(message?.content);
    if (text) chunks.push(`${message?.role ? `${cleanPromptText(message.role, 32)}: ` : ''}${text}`);
  }
  return truncateText(chunks.join('\n'));
}

function rootsForConfig(cfg, context = {}) {
  const roots = [];
  const projectPath = context.projectPath || context.cwd || '';
  if (projectPath) {
    try {
      const resolved = path.resolve(projectPath);
      const canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      if (!fs.statSync(canonical).isDirectory()) throw new Error('project root is not a directory');
      roots.push({ name: context.projectName || path.basename(canonical) || 'project', uri: pathToFileURL(canonical).href });
    } catch { /* ignore invalid project */ }
  }
  for (const root of Array.isArray(cfg.roots) ? cfg.roots : []) {
    if (!root?.path) continue;
    try {
      const resolved = path.resolve(String(root.path));
      const canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
      if (!fs.statSync(canonical).isDirectory()) continue;
      roots.push({ name: String(root.label || root.rootId || 'directory').slice(0, 128), uri: pathToFileURL(canonical).href });
    } catch { /* ignore invalid root */ }
  }
  return { roots };
}

/** MCP hub. Discovery calls are replayable; tool/resource/prompt calls are not. */
function createMcpHub(opts = {}) {
  const createClient = opts.createClient || ((cfg) => createMcpClient({ ...cfg, transport: cfg.transport || 'stdio' }));
  const sessionManager = opts.sessionManager || null;
  const ownedManager = !sessionManager && opts.enableSessionRecoveryManager === true
    ? createMcpSessionManager({ createClient, onStatus: opts.onSessionStatus })
    : null;
  const manager = sessionManager || ownedManager;
  const taskManager = opts.taskManager || null;
  const servers = new Map();
  const route = new Map();
  const resourcesByServer = new Map();
  const promptsByServer = new Map();
  let runContext = {};

  function isValidConfig(cfg) {
    const name = String(cfg?.name || '').trim();
    if (!isValidServerName(name)) return false;
    const transport = String(cfg.transport || 'stdio').toLowerCase();
    return transport === 'http' || transport === 'sse' ? isHttpUrl(cfg.url) : Boolean(cfg.command);
  }

  async function acquireClient(cfg, context) {
    const serverName = String(cfg.name || '').trim();
    const leaseRef = { current: null, runStopped: context.taskRecovery === true };
    const releaseTaskConnection = async () => {
      if (!leaseRef.runStopped) return;
      if (taskManager?.hasConnectionHoldingTasks?.(serverName)) return;
      await leaseRef.current?.release?.();
    };
    const attachTaskLeaseLifecycle = (acquired) => {
      acquired.markRunStopped = () => { leaseRef.runStopped = true; };
      acquired.releaseTaskConnection = releaseTaskConnection;
      return acquired;
    };
    const clientConfig = {
      ...cfg,
      transport: cfg.transport || 'stdio',
      cwd: cfg.cwd || context.cwd,
      allowPrivate: cfg.allowPrivate === true,
      authProvider: cfg.authProvider || context.authProvider,
      tasksEnabled: cfg.tasks?.enabled === true,
      elicitation: {
        form: cfg.elicitation?.enabled !== false,
        url: cfg.elicitation?.enabled !== false,
      },
    };
    const notificationHandler = (method, params, message) => {
      if (method === 'notifications/prompts/list_changed') promptsByServer.delete(serverName);
      if (method === 'notifications/tasks/status') taskManager?.notifyTaskStatus?.(serverName, params);
      context.notificationHandler?.(method, params, message);
    };
    if (manager) {
      const acquired = await manager.acquire(clientConfig, {
        projectPath: context.projectPath,
        taskRecovery: context.taskRecovery === true,
        rootsProvider: () => rootsForConfig(clientConfig, context),
        samplingHandler: cfg.sampling?.enabled === true && context.samplingEnabled !== false && context.samplingHandler
          ? (params, signal) => context.samplingHandler(cfg.name, params, signal, releaseTaskConnection)
          : undefined,
        elicitationHandler: cfg.elicitation?.enabled !== false && context.elicitationHandler
          ? (params, signal) => context.elicitationHandler(cfg.name, params, signal, releaseTaskConnection)
          : undefined,
        elicitationComplete: context.elicitationComplete
          ? (params, message) => context.elicitationComplete(cfg.name, params, message)
          : undefined,
        taskHandler: context.taskHandler
          ? (method, params, signal) => context.taskHandler(cfg.name, method, params, signal)
          : undefined,
        notificationHandler,
        onRootsChanged: context.onRootsChanged,
        onTransportError: context.onTransportError,
      });
      leaseRef.current = acquired;
      return attachTaskLeaseLifecycle(acquired);
    }
    const client = createClient({
      ...clientConfig,
      rootsProvider: () => rootsForConfig(clientConfig, context),
      ...(cfg.sampling?.enabled === true && context.samplingEnabled !== false && context.samplingHandler
        ? { samplingHandler: (params, signal) => context.samplingHandler(cfg.name, params, signal, releaseTaskConnection) }
        : {}),
      ...(cfg.elicitation?.enabled !== false && context.elicitationHandler
        ? { elicitationHandler: (params, signal) => context.elicitationHandler(cfg.name, params, signal, releaseTaskConnection) }
        : {}),
      ...(context.elicitationComplete
        ? { elicitationComplete: (params, message) => context.elicitationComplete(cfg.name, params, message) }
        : {}),
      ...(context.taskHandler
        ? { taskHandler: (method, params, signal) => context.taskHandler(cfg.name, method, params, signal) }
        : {}),
      notificationHandler,
    });
    await client.start();
    const acquired = { client, release: async () => client.close(), status: () => ({ server: cfg.name, state: 'connected', reusable: false, lastErrorCode: null }) };
    leaseRef.current = acquired;
    return attachTaskLeaseLifecycle(acquired);
  }

  async function startAll(serverConfigs, context = {}) {
    await stopAll();
    runContext = context;
    const list = Array.isArray(serverConfigs) ? serverConfigs : [];
    const configsByName = new Map(list.map((cfg) => [String(cfg?.name || '').trim(), cfg]));
    for (const cfg of list) {
      if (context.signal?.aborted) break;
      const name = String(cfg?.name || '').trim();
      if (cfg?.enabled === false) continue;
      if (!isValidConfig(cfg)) { context.onStatus?.({ server: name || '?', ok: false, error: 'invalid config' }); continue; }
      let lease = null;
      try {
        const authProvider = cfg.auth === 'oauth' ? context.oauthManager?.getAuthProvider?.(name, cfg) : undefined;
        if (cfg.auth === 'oauth' && !authProvider) { const e = new Error('MCP OAuth manager unavailable'); e.code = 'MCP_AUTH_REQUIRED'; throw e; }
        lease = await acquireClient({ ...cfg, authProvider }, { ...context, authProvider, projectName: context.project?.name, projectPath: context.project?.path || context.cwd });
        const client = lease.client;
        const tools = await client.listTools();
        const capabilities = client.getServerCapabilities?.() || {};
        const protocolVersion = typeof client.getProtocolVersion === 'function' ? client.getProtocolVersion() : '2025-11-25';
        const taskCallSupported = cfg.tasks?.enabled === true
          && protocolVersion === '2025-11-25'
          && supportsTaskRequest(capabilities, 'requests.tools.call');
        let resources = [];
        try { resources = typeof client.listResources === 'function' ? (await client.listResources()) || [] : []; } catch { resources = []; }
        let prompts = null;
        try { prompts = typeof client.listPrompts === 'function' ? (await client.listPrompts()) || [] : []; } catch { prompts = null; }
        servers.set(name, {
          client,
          lease,
          tools: Array.isArray(tools) ? tools : [],
          cfg,
          capabilities,
          taskCallSupported,
          runStopped: context.taskRecovery === true,
          releaseTaskConnection: lease.releaseTaskConnection,
        });
        taskManager?.registerClient?.(name, client, {
          recover: context.taskRecovery !== true,
          serverConfigFingerprint: configFingerprint(cfg),
          sessionId: context.sessionId,
          projectPath: context.project?.path || context.cwd,
          releaseConnection: lease.releaseTaskConnection,
        });
        resourcesByServer.set(name, Array.isArray(resources) ? resources : []);
        if (prompts) promptsByServer.set(name, normalizePromptList(prompts));
        for (const tool of Array.isArray(tools) ? tools : []) {
          const taskSupport = String(tool?.execution?.taskSupport || '').toLowerCase();
          if (taskSupport === 'required' && !taskCallSupported) continue;
          let full = `mcp_${name}_${sanitizeToolPart(tool.name)}`;
          let n = 2;
          while (route.has(full) || RESERVED_TOOL_NAMES.has(full)) full = `mcp_${name}_${sanitizeToolPart(tool.name)}_${n++}`;
          route.set(full, {
            serverName: name,
            toolName: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            taskSupport,
            taskEnabled: taskCallSupported && (taskSupport === 'required' || taskSupport === 'optional'),
          });
        }
        context.onStatus?.({ server: name, ok: true, session: lease.status?.() || null });
      } catch (error) {
        try { await lease?.release?.(); } catch { /* ignore */ }
        context.onStatus?.({ server: name, ok: false, error: sanitizeMcpError(error) });
      }
    }
    if (context.taskRecovery === true && taskManager?.restore && list.length) {
      await taskManager.restore({
        sessionId: context.sessionId,
        projectPath: context.project?.path || context.cwd,
        getClient: (serverName) => servers.get(serverName)?.client || null,
        getConfigFingerprint: (serverName) => {
          const entry = servers.get(serverName);
          const cfg = entry?.cfg || configsByName.get(serverName);
          return cfg ? configFingerprint(cfg) : '';
        },
        releaseConnection: (serverName) => servers.get(serverName)?.releaseTaskConnection?.(),
      });
      await Promise.all([...servers.values()].map((entry) => entry.releaseTaskConnection?.()));
    }
  }

  function getToolDefs() {
    const defs = [];
    for (const [full, meta] of route) defs.push({ type: 'function', function: { name: full, description: meta.description || `MCP ${meta.serverName}/${meta.toolName}`, parameters: meta.inputSchema && typeof meta.inputSchema === 'object' ? meta.inputSchema : { type: 'object', properties: {} } } });
    if (!servers.size) return defs;
    defs.push({ type: 'function', function: { name: 'mcp_resources_list', description: 'List MCP resources from connected servers', parameters: { type: 'object', properties: { server: { type: 'string' } } } } });
    defs.push({ type: 'function', function: { name: 'mcp_resource_read', description: 'Read one MCP resource by server name and uri', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'] } } });
    defs.push({ type: 'function', function: { name: 'mcp_prompts_list', description: 'List MCP prompts from connected servers', parameters: { type: 'object', properties: { server: { type: 'string' } } } } });
    defs.push({ type: 'function', function: { name: 'mcp_prompt_get', description: 'Get one MCP prompt by server and name', parameters: { type: 'object', properties: { server: { type: 'string' }, name: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'name'] } } });
    if (taskManager) {
      defs.push({ type: 'function', function: { name: 'mcp_tasks_list', description: 'List background MCP tasks', parameters: { type: 'object', properties: { server: { type: 'string' }, limit: { type: 'integer' } } } } });
      defs.push({ type: 'function', function: { name: 'mcp_task_get', description: 'Get one background MCP task by local reference', parameters: { type: 'object', properties: { taskRef: { type: 'string' } }, required: ['taskRef'] } } });
      defs.push({ type: 'function', function: { name: 'mcp_task_result', description: 'Read a completed background MCP task result', parameters: { type: 'object', properties: { taskRef: { type: 'string' } }, required: ['taskRef'] } } });
      defs.push({ type: 'function', function: { name: 'mcp_task_cancel', description: 'Cancel a background MCP task', parameters: { type: 'object', properties: { taskRef: { type: 'string' } }, required: ['taskRef'] } } });
    }
    return defs;
  }

  async function callResourcesList(args) {
    const filter = args?.server != null && String(args.server).trim() ? String(args.server).trim() : null;
    const resources = [];
    for (const [serverName, list] of resourcesByServer) {
      if (filter && serverName !== filter) continue;
      for (const item of list || []) resources.push({ server: serverName, uri: item.uri, ...(item.name != null ? { name: item.name } : {}), ...(item.description != null ? { description: item.description } : {}), ...(item.mimeType != null ? { mimeType: item.mimeType } : {}) });
    }
    return { ok: true, resources };
  }
  async function callResourceRead(args) {
    const server = String(args?.server || '').trim();
    const uri = String(args?.uri || '');
    if (!server || !uri) return { ok: false, error: 'server 与 uri 必填' };
    const entry = servers.get(server);
    if (!entry) return { ok: false, error: 'server 未连接: ' + server };
    try { const result = await entry.client.readResource(uri); const out = truncateText(result); return { ok: true, contents: out.text, truncated: out.truncated }; } catch (error) { return { ok: false, error: sanitizeMcpError(error) }; }
  }
  async function listPrompts(serverName = '') {
    const filter = String(serverName || '').trim();
    if (filter) {
      const entry = servers.get(filter);
      if (!entry) return { ok: false, error: 'server 未连接: ' + filter, code: 'MCP_SERVER_NOT_FOUND' };
      if (!promptsByServer.has(filter)) {
        try { const list = await entry.client.listPrompts(); promptsByServer.set(filter, normalizePromptList(list)); } catch (error) { return { ok: false, error: sanitizeMcpError(error) }; }
      }
      return { ok: true, prompts: (promptsByServer.get(filter) || []).map((item) => ({ server: filter, ...item })) };
    }
    const prompts = [];
    for (const name of servers.keys()) { const result = await listPrompts(name); if (result.ok) prompts.push(...result.prompts); }
    return { ok: true, prompts };
  }
  async function getPrompt(serverName, promptName, args) {
    const server = String(serverName || '').trim();
    const name = String(promptName || '').trim();
    if (!isValidServerName(server) || !server || !name || name.length > PROMPT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, code: 'MCP_PROMPT_ARGUMENTS_INVALID', error: 'server/name 无效' };
    const entry = servers.get(server);
    if (!entry) return { ok: false, code: 'MCP_SERVER_NOT_FOUND', error: 'server 未连接: ' + server };
    let normalized;
    try { normalized = normalizePromptArgs(args); } catch (error) { return { ok: false, code: error.code, error: error.message }; }
    try {
      const result = await entry.client.getPrompt(name, normalized);
      const out = promptResultToText(result);
      // Only the bounded editable text crosses the main/renderer boundary.
      return { ok: true, server, name, text: out.text, truncated: out.truncated };
    } catch (error) {
      return { ok: false, code: String(error?.code || 'MCP_PROMPT_FAILED'), error: sanitizeMcpError(error) };
    }
  }

  async function call(fullName, args) {
    const taskContext = {
      sessionId: runContext.sessionId,
      projectPath: runContext.project?.path || runContext.cwd,
    };
    if (fullName === 'mcp_resources_list') return callResourcesList(args || {});
    if (fullName === 'mcp_resource_read') return callResourceRead(args || {});
    if (fullName === 'mcp_prompts_list') return listPrompts(args?.server || '');
    if (fullName === 'mcp_prompt_get') return getPrompt(args?.server, args?.name, args?.arguments);
    if (fullName === 'mcp_tasks_list') return {
      ok: true,
      tasks: taskManager?.list?.({
        server: args?.server,
        limit: args?.limit,
        sourceSessionId: taskContext.sessionId,
        sourceProjectPath: taskContext.projectPath,
      }) || [],
    };
    if (fullName === 'mcp_task_get') {
      try {
        const task = taskManager.getForContext
          ? taskManager.getForContext(String(args?.taskRef || ''), taskContext)
          : taskManager.get(String(args?.taskRef || ''));
        return { ok: true, task };
      } catch (error) { return { ok: false, code: error.code, error: error.message }; }
    }
    if (fullName === 'mcp_task_result') {
      try {
        const result = taskManager.resultForContext
          ? await taskManager.resultForContext(String(args?.taskRef || ''), taskContext)
          : await taskManager.result(String(args?.taskRef || ''));
        return { ok: true, taskRef: String(args?.taskRef || ''), result: truncateText(result).text };
      } catch (error) { return { ok: false, code: error.code, error: error.message }; }
    }
    if (fullName === 'mcp_task_cancel') {
      try {
        const task = taskManager.cancelForContext
          ? await taskManager.cancelForContext(String(args?.taskRef || ''), taskContext)
          : await taskManager.cancel(String(args?.taskRef || ''));
        return { ok: true, task };
      } catch (error) { return { ok: false, code: error.code, error: error.message }; }
    }
    const meta = route.get(fullName);
    if (!meta) return { ok: false, error: '未知 mcp 工具: ' + fullName };
    const entry = servers.get(meta.serverName);
    if (!entry) return { ok: false, error: 'server 未连接: ' + meta.serverName };
    try {
      const requestOptions = meta.taskEnabled
        ? { task: { ttl: entry.cfg.tasks?.defaultTtlMs || taskManager.constants?.DEFAULT_TTL_MS || 60 * 60 * 1000 } }
        : {};
      const result = await entry.client.callTool(meta.toolName, args || {}, requestOptions);
      if (meta.taskEnabled && result?.task) {
        // The run's lease must remain usable until onRunEnd. If the Agent
        // finishes first, stopAll marks the entry and the task completion
        // releases the retained lease. Releasing immediately here used to
        // close a non-recovery stdio client in the middle of the same run.
        const created = taskManager.registerToolTask({
          serverName: meta.serverName,
          serverConfigFingerprint: configFingerprint(entry.cfg),
          transport: entry.cfg.transport,
          remoteTaskId: result.task.taskId,
          createResult: result,
          toolName: meta.toolName,
          ttl: entry.cfg.tasks?.defaultTtlMs,
          client: entry.client,
          sourceSessionId: runContext.sessionId,
          sourceProjectPath: runContext.project?.path || runContext.cwd,
          releaseConnection: entry.releaseTaskConnection,
        });
        return { ok: true, task: created.task };
      }
      if (meta.taskSupport === 'required') return { ok: false, code: 'MCP_TASK_REQUIRED_UNSUPPORTED', error: 'MCP server did not create a task' };
      const out = truncateText(result);
      return { ok: true, result: out.text, truncated: out.truncated };
    } catch (error) { return { ok: false, code: error?.code, error: sanitizeMcpError(error) }; }
  }

  async function stopAll() {
    for (const entry of servers.values()) {
      entry.runStopped = true;
      entry.lease?.markRunStopped?.();
      if (taskManager?.hasConnectionHoldingTasks?.(entry.cfg.name)
        || taskManager?.hasActiveTasks?.(entry.cfg.name)) continue;
      try { await entry.lease?.release?.(); } catch { try { await entry.client?.close?.(); } catch { /* ignore */ } }
    }
    servers.clear(); route.clear(); resourcesByServer.clear(); promptsByServer.clear();
  }
  async function close() { await stopAll(); if (ownedManager) await ownedManager.closeAll(); }
  function sessionStatus(name) { return manager?.status?.(name) || [...servers.entries()].map(([server, entry]) => ({ server, state: 'connected', reusable: false, lastErrorCode: null })); }

  return {
    startAll,
    getToolDefs,
    call,
    listPrompts,
    getPrompt,
    stopAll,
    close,
    sessionStatus,
    rootsForConfig,
    taskManager,
  };
}

module.exports = { createMcpHub, sanitizeToolPart, truncateText, sanitizeMcpError, normalizePromptArgs, normalizePromptDescriptor, normalizePromptList, promptResultToText, rootsForConfig, RESULT_MAX };
