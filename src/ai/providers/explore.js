'use strict';

const { AGENT_EVENTS } = require('../agent-events');

function createExploreProvider({ runLoop } = {}) {
  return {
    id: 'explore',
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
          name: 'spawn_explore',
          description: 'Spawn a read-only explore sub-agent for research; returns summary',
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
      if (name !== 'spawn_explore') {
        return JSON.stringify({ ok: false, error: '未知工具: ' + name });
      }
      if (Number(ctx.subagentDepth) >= 1) {
        return JSON.stringify({ ok: false, error: '子 Agent 内禁止再次 spawn' });
      }
      const goal = String(args.goal || '').trim();
      if (goal.length < 4) {
        return JSON.stringify({ ok: false, error: 'goal 过短（至少 4 个字符）' });
      }
      let maxTurns = Number(args.maxTurns);
      if (!Number.isFinite(maxTurns)) maxTurns = 4;
      maxTurns = Math.max(1, Math.min(8, maxTurns));

      if (typeof runLoop !== 'function') {
        return JSON.stringify({ ok: false, error: 'runLoop 未注入' });
      }

      ctx.onEvent?.({ type: AGENT_EVENTS.SUBAGENT_START, goal, maxTurns });
      try {
        const childSettings = {
          ...ctx.settings,
          maxAgentTurns: maxTurns,
          skillsEnabled: false,
          mcpEnabled: false,
          subagentEnabled: false,
          verifyBeforeDone: false,
        };
        // Do not share parent's mcpHub — child onRunEnd would stopAll() the parent hub
        const childExt = { ...ctx.extensions };
        delete childExt.mcpHub;

        const result = await runLoop({
          project: ctx.project,
          settings: childSettings,
          messages: [{ role: 'user', content: goal }],
          gate: ctx.gate,
          onEvent: (ev) => {
            // optional forward; avoid infinite UI noise — still allow tool events with flag
            if (ev && typeof ev === 'object') {
              ctx.onEvent?.({ ...ev, subagent: true });
            }
          },
          signal: ctx.signal,
          sessionKey: ctx.sessionKey,
          agentMode: 'agent', // tools filtered by exploreReadonly/depth
          subagentDepth: 1,
          registry: ctx.registry, // same registry; providers self-disable
          extensions: childExt,
        });
        const summary = String(result.content || '').slice(0, 8 * 1024);
        const agentLog = Array.isArray(result.agentLog)
          ? result.agentLog.slice(0, 20).map((x) => ({
            tool: x.tool,
            ok: x.ok,
            summary: String(x.summary || '').slice(0, 200),
          }))
          : [];
        ctx.onEvent?.({ type: AGENT_EVENTS.SUBAGENT_END, ok: true, summary });
        return JSON.stringify({
          ok: true,
          summary,
          turns: result.turns,
          agentLog,
        });
      } catch (err) {
        const msg = err?.message || String(err);
        ctx.onEvent?.({ type: AGENT_EVENTS.SUBAGENT_END, ok: false, error: msg });
        if (err?.code === 'ABORTED') throw err;
        return JSON.stringify({ ok: false, error: msg });
      }
    },
  };
}

function normalizeMode(m) {
  return m === 'plan' ? 'plan' : 'agent';
}

module.exports = { createExploreProvider };
