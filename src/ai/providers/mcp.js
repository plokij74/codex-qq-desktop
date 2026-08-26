'use strict';

const { createMcpHub } = require('../mcp-hub');
const { AGENT_EVENTS } = require('../agent-events');

/**
 * MCP ToolProvider: starts hub on run, exposes mcp_* tools, always stops on end.
 */
function createMcpProvider(options = {}) {
  return {
    id: 'mcp',
    isEnabled(ctx) {
      if (!ctx.settings?.mcpEnabled) return false;
      if (!Array.isArray(ctx.settings.mcpServers) || !ctx.settings.mcpServers.length) return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      if (ctx.agentMode === 'plan') return false;
      return true;
    },
    async onRunStart(ctx) {
      if (!ctx.extensions) ctx.extensions = {};
      const hub = createMcpHub({
        sessionManager: options.sessionManager || ctx.extensions.mcpSessionManager,
        enableSessionRecoveryManager: true,
        onSessionStatus: (status) => ctx.onEvent?.({ type: AGENT_EVENTS.MCP_STATUS, ...status }),
      });
      ctx.extensions.mcpHub = hub;
      await hub.startAll(ctx.settings.mcpServers, {
        cwd: ctx.project?.path,
        signal: ctx.signal,
        oauthManager: options.oauthManager || ctx.extensions.mcpOAuthManager,
        project: ctx.project,
        onStatus: (st) => {
          ctx.onEvent?.({ type: AGENT_EVENTS.MCP_STATUS, ...st });
        },
        samplingEnabled: ctx.settings?.mode === 'api',
        samplingHandler: (server, params, signal) => ctx.extensions?.mcpSampling?.(server, params, ctx, signal),
        onRootsChanged: (server) => ctx.onEvent?.({ type: AGENT_EVENTS.MCP_STATUS, server, ok: true, rootsChanged: true }),
      });
    },
    getTools(ctx) {
      const hub = ctx.extensions?.mcpHub;
      if (!hub) return [];
      return hub.getToolDefs();
    },
    async execute(name, args, ctx) {
      const hub = ctx.extensions?.mcpHub;
      if (!hub) return JSON.stringify({ ok: false, error: 'MCP 未连接' });
      const r = await hub.call(name, args);
      return JSON.stringify(r);
    },
    async onRunEnd(ctx) {
      // Subagents must not tear down a parent-owned hub (defense in depth;
      // explore also omits mcpHub from child extensions).
      if (Number(ctx.subagentDepth) >= 1) return;
      const hub = ctx.extensions?.mcpHub;
      if (hub) {
        await hub.stopAll();
        delete ctx.extensions.mcpHub;
      }
    },
  };
}

module.exports = { createMcpProvider };
