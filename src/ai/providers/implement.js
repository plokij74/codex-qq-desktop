'use strict';

const { createSubagentRuntime } = require('../subagent-runtime');

function getRuntime(ctx, runLoop) {
  if (ctx.extensions?.subagentRuntime) return ctx.extensions.subagentRuntime;
  if (!ctx.extensions) ctx.extensions = {};
  const rt = createSubagentRuntime({ runLoop, worktreeManager: ctx.extensions?.worktreeManager });
  ctx.extensions.subagentRuntime = rt;
  return rt;
}

function createImplementProvider({ runLoop } = {}) {
  const resolvedRunLoop = typeof runLoop === 'function'
    ? runLoop
    : (...args) => require('../agent').runAgentLoop(...args);

  return {
    id: 'implement',
    isEnabled(ctx) {
      if (ctx.settings?.subagentEnabled === false) return false;
      if (normalizeMode(ctx.agentMode) !== 'agent') return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      return true;
    },
    getTools() {
      return [{
        type: 'function',
        function: {
          name: 'spawn_implement',
          description: 'Spawn an implement sub-agent in a dedicated Git worktree; it may edit files via write_file/search_replace only and returns an opaque result summary for user review',
          parameters: {
            type: 'object',
            properties: {
              goal: { type: 'string' },
              maxTurns: { type: 'integer' },
            },
            required: ['goal'],
          },
        },
      }];
    },
    async execute(name, args, ctx) {
      if (name !== 'spawn_implement') {
        return JSON.stringify({ ok: false, error: '未知工具: ' + name });
      }
      if (Number(ctx.subagentDepth) >= 1) {
        return JSON.stringify({ ok: false, error: '子 Agent 内禁止再次 spawn' });
      }
      const rt = getRuntime(ctx, resolvedRunLoop);
      try {
        const out = await rt.runImplement(ctx, {
          goal: args?.goal,
          maxTurns: args?.maxTurns,
        });
        return JSON.stringify(out);
      } catch (err) {
        if (err?.code === 'ABORTED') throw err;
        return JSON.stringify({ ok: false, error: err?.message || String(err) });
      }
    },
  };
}

function normalizeMode(m) {
  return m === 'plan' ? 'plan' : 'agent';
}

module.exports = { createImplementProvider };
