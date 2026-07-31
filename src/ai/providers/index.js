'use strict';

const { createRegistry } = require('../extensions/registry');
const { createBuiltinProvider } = require('./builtin');
const { createSkillsProvider } = require('./skills');
const { createExploreProvider } = require('./explore');
const { createImplementProvider } = require('./implement');
const { createMemoryProvider } = require('./memory');
const { createMcpProvider } = require('./mcp');

/**
 * Default registry: builtin + skills + explore + implement + memory + mcp.
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
  reg.register(createImplementProvider({ runLoop }));
  reg.register(createMemoryProvider());
  reg.register(createMcpProvider());
  return reg;
}

function createMemoryOnlyRegistry() {
  const reg = createRegistry();
  reg.register(createMemoryProvider());
  return reg;
}

module.exports = {
  createDefaultRegistry,
  createMemoryOnlyRegistry,
  createBuiltinProvider,
  createSkillsProvider,
  createExploreProvider,
  createImplementProvider,
  createMemoryProvider,
  createMcpProvider,
};
