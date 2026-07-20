'use strict';

/** Read-only tools allowed when subagentDepth >= 1 or exploreReadonly. */
const EXPLORE_READONLY = new Set([
  'list_dir',
  'read_file',
  'grep',
  'glob',
  'git_status',
  'git_diff',
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
        defs = defs.filter((t) => EXPLORE_READONLY.has(t.function.name));
      }
      return defs;
    },
    async execute(name, args, ctx) {
      return executeTool(name, args || {}, ctx);
    },
  };
}

module.exports = {
  createBuiltinProvider,
  EXPLORE_READONLY,
};
