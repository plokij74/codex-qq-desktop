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

// D11 read-only engineering tools are kept separate so older consumers that
// compare the original explore allowlist remain source-compatible.
const ENGINEERING_READONLY = new Set([
  'code_index_status', 'code_index_search', 'verification_profiles',
  'verification_get', 'verification_result',
]);

/**
 * Tools allowed for implement subagents: explore set + write_file /
 * search_replace. Engineering reads are deliberately excluded: an implement
 * child runs inside a temporary worktree, so its project path is not the bound
 * project and an index or profile lookup there would answer about the wrong
 * tree. The isolated gate rejects these names as well.
 */
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
      if (ctx?.settings?.codeIndexEnabled === false) {
        defs = defs.filter((t) => !String(t.function.name || '').startsWith('code_index_'));
      }
      if (Number(ctx?.subagentDepth) >= 1 || ctx?.exploreReadonly) {
        const kind = ctx?.subagentKind === 'implement' ? 'implement' : 'explore';
        const allow = kind === 'implement' ? IMPLEMENT_TOOLS : new Set([...EXPLORE_READONLY, ...ENGINEERING_READONLY]);
        defs = defs.filter((t) => allow.has(t.function.name));
      }
      return defs;
    },
    async execute(name, args, ctx) {
      // Defense in depth: same allowlist as getTools when subagent / explore-readonly.
      if (Number(ctx?.subagentDepth) >= 1 || ctx?.exploreReadonly) {
        const kind = ctx?.subagentKind === 'implement' ? 'implement' : 'explore';
        const allow = kind === 'implement' ? IMPLEMENT_TOOLS : new Set([...EXPLORE_READONLY, ...ENGINEERING_READONLY]);
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
  ENGINEERING_READONLY,
};
