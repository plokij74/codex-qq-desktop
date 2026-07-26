'use strict';

/**
 * Phase D.2 — long-term memory provider.
 *
 * Exposes remember / recall / forget to the model and injects the
 * 【长期记忆】 block into system via getSystemFragment.
 */

const store = require('../memory-store');
const {
  selectForInjection, formatInjection, tokenizeQuery, matchScore, scoreEntry,
} = require('../memory-recall');
// clampInt 已由 settings.js 导出并被 main.js 复用，不要再抄一份。
const { clampInt } = require('../settings');

const RECALL_LIMIT_DEFAULT = 10;
const RECALL_LIMIT_MAX = 20;

function normalizeMode(m) {
  return m === 'plan' ? 'plan' : 'agent';
}

function pathsFor(ctx) {
  return {
    projectPath: ctx?.project?.path || null,
    userDataPath: ctx?.extensions?.userDataPath || null,
  };
}

/** Bound to the project when one is attached; otherwise the user layer. */
function resolveScope(ctx, requested) {
  if (requested === 'user') return 'user';
  if (requested === 'project') return 'project';
  return ctx?.project?.path ? 'project' : 'user';
}

const TOOL_REMEMBER = {
  type: 'function',
  function: {
    name: 'remember',
    description: '记住一条长期事实（跨会话保留）。仅记稳定的项目约定、用户偏好、关键决策；不要记临时状态或密钥。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的事实，一句话，中文优先' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，便于以后召回' },
        scope: { type: 'string', enum: ['project', 'user'], description: 'project=随项目共享；user=跨项目的个人偏好。默认 project' },
      },
      required: ['text'],
    },
  },
};

const TOOL_RECALL = {
  type: 'function',
  function: {
    name: 'recall',
    description: '按关键词检索长期记忆（项目级 + 用户级）。system 里已自动带上最相关的若干条，这里用于查更多。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        limit: { type: 'integer', description: '返回条数，1..20，默认 10' },
      },
      required: ['query'],
    },
  },
};

const TOOL_FORGET = {
  type: 'function',
  function: {
    name: 'forget',
    description: '按 id 删除一条长期记忆。id 来自 recall 或 system 中的记忆块。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'user'] },
      },
      required: ['id'],
    },
  },
};

function createMemoryProvider() {
  return {
    id: 'memory',

    isEnabled(ctx) {
      if (ctx?.settings?.memoryEnabled === false) return false;
      // Sub-agents get no extension providers (same rule as skills/mcp/implement).
      if (Number(ctx?.subagentDepth) >= 1) return false;
      return true;
    },

    getTools(ctx) {
      // plan mode is read-only research; the gate would refuse writes anyway,
      // but not offering them keeps the tool list honest.
      if (normalizeMode(ctx?.agentMode) === 'plan') return [TOOL_RECALL];
      return [TOOL_RECALL, TOOL_REMEMBER, TOOL_FORGET];
    },

    async execute(name, args, ctx) {
      const { projectPath, userDataPath } = pathsFor(ctx);
      try {
        if (name === 'remember') {
          const scope = resolveScope(ctx, args?.scope);
          if (scope === 'project' && !projectPath) {
            return JSON.stringify({ ok: false, error: '当前会话未绑定项目，请用 scope="user"' });
          }
          const res = store.appendEntry({
            scope,
            projectPath,
            userDataPath,
            text: args?.text,
            tags: args?.tags,
            source: 'tool',
            maxEntries: clampInt(ctx?.settings?.memoryMaxEntries, 20, 2000, 200),
          });
          return JSON.stringify(res);
        }

        if (name === 'recall') {
          const { entries, skipped } = store.readAll({ projectPath, userDataPath });
          const limit = clampInt(args?.limit, 1, RECALL_LIMIT_MAX, RECALL_LIMIT_DEFAULT);
          const queryText = String(args?.query || '');
          const tokens = tokenizeQuery(queryText);
          const queryLower = queryText.toLowerCase();
          const now = Date.now();
          const ranked = entries
            .map((e) => ({ e, m: matchScore(e, tokens, queryLower), s: scoreEntry(e, tokens, queryLower, now) }))
            .sort((a, b) => (b.m - a.m) || (b.s - a.s))
            .slice(0, limit)
            .map(({ e }) => ({
              id: e.id, text: e.text, tags: e.tags, scope: e.scope, createdAt: e.createdAt,
            }));
          return JSON.stringify({ ok: true, entries: ranked, skipped });
        }

        if (name === 'forget') {
          const res = store.deleteEntry({
            id: args?.id, scope: args?.scope, projectPath, userDataPath,
          });
          return JSON.stringify(res);
        }
      } catch (err) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) });
      }
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    },

    getSystemFragment(ctx) {
      try {
        const { projectPath, userDataPath } = pathsFor(ctx);
        const { entries } = store.readAll({ projectPath, userDataPath });
        if (!entries.length) return '';
        const picked = selectForInjection(entries, {
          queryText: ctx?.extensions?.userPromptText || '',
          topN: clampInt(ctx?.settings?.memoryInjectTopN, 0, 30, 8),
          maxApproxTokens: clampInt(ctx?.settings?.memoryInjectMaxTokens, 200, 8000, 1200),
          now: Date.now(),
        });
        return formatInjection(picked);
      } catch {
        // A broken store must never break the run.
        return '';
      }
    },
  };
}

module.exports = { createMemoryProvider };
