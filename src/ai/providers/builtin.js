'use strict';

/** Read-only tools allowed when subagentDepth >= 1 (explore) or exploreReadonly. */
const EXPLORE_READONLY = new Set([
  'list_dir',
  'read_file',
  'grep',
  'glob',
  'git_status',
  'git_diff',
]);

/** Tools allowed for implement subagents: explore set + write_file / search_replace. */
const IMPLEMENT_TOOLS = new Set([
  ...EXPLORE_READONLY,
  'write_file',
  'search_replace',
]);

/**
 * Builtin ToolProvider wrapping existing TOOL_DEFS + executeToolFixed.
 * Deps injected to avoid require cycles with agent.js.
 *
 * @param {{ getToolDefs: () => Array, executeTool: (name: string, args: object, ctx: object) => Promise<any> }} deps
 */
function createBuiltinProvider(deps) {
  if (!deps || typeof deps.getToolDefs !== 'function' || typeof deps.executeTool !== 'function') {
    throw new Error('createBuiltinProvider requires getToolDefs and executeTool');
  }
  const { getToolDefs, executeTool } = deps;

  return {
    id: 'builtin',
    isEnabled() {
      return true;
    },
    getTools(ctx) {
      let defs = getToolDefs().slice();
      if (!ctx?.settings?.terminalEnabled) {
        defs = defs.filter((t) => t.function.name !== 'run_terminal');
      }
      if (Number(ctx?.subagentDepth) >= 1 || ctx?.exploreReadonly) {
        const kind = ctx?.subagentKind === 'implement' ? 'implement' : 'explore';
        const allow = kind === 'implement' ? IMPLEMENT_TOOLS : EXPLORE_READONLY;
        defs = defs.filter((t) => allow.has(t.function.name));
      }
      return defs;
    },
    async execute(name, args, ctx) {
      // Defense in depth: same allowlist as getTools when subagent / explore-readonly.
      if (Number(ctx?.subagentDepth) >= 1 || ctx?.exploreReadonly) {
        const kind = ctx?.subagentKind === 'implement' ? 'implement' : 'explore';
        const allow = kind === 'implement' ? IMPLEMENT_TOOLS : EXPLORE_READONLY;
        if (!allow.has(name)) {
          return JSON.stringify({ ok: false, error: '未知工具: ' + name });
        }
      }
      return executeTool(name, args || {}, ctx);
    },
  };
}

module.exports = {
  createBuiltinProvider,
  EXPLORE_READONLY,
  IMPLEMENT_TOOLS,
};
