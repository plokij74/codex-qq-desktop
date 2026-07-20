'use strict';

const { createRegistry } = require('../extensions/registry');
const { createBuiltinProvider } = require('./builtin');
const { createSkillsProvider } = require('./skills');
const { createExploreProvider } = require('./explore');
const { createMcpProvider } = require('./mcp');

/**
 * Default registry: builtin + skills + explore + mcp.
 *
 * @param {{
 *   getToolDefs: () => Array,
 *   executeTool: Function,
 *   userDataPath?: string,
 *   bundledDir?: string,
 *   runLoop?: Function,
 * }} deps
 */
function createDefaultRegistry(deps) {
  const reg = createRegistry();
  reg.register(createBuiltinProvider(deps));
  reg.register(createSkillsProvider({
    userDataPath: deps?.userDataPath,
    bundledDir: deps?.bundledDir,
  }));
  // Lazy require avoids cycle if runLoop not injected (agent.js injects runAgentLoop).
  const runLoop = typeof deps?.runLoop === 'function'
    ? deps.runLoop
    : (...args) => require('../agent').runAgentLoop(...args);
  reg.register(createExploreProvider({ runLoop }));
  reg.register(createMcpProvider());
  return reg;
}

module.exports = {
  createDefaultRegistry,
  createBuiltinProvider,
  createSkillsProvider,
  createExploreProvider,
  createMcpProvider,
};
