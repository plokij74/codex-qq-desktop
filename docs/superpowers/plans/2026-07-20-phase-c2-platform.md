# Phase C.2 Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase C.2 platform surface: ToolProvider registry, Skills (discover/list/use + slash), read-only explore sub-agent (`spawn_explore`), and stdio MCP (per-run connect/disconnect)—without Hooks, parallel agents, or non-stdio MCP.

**Architecture:** Single `runAgentLoop` gains a RunContext and an ExtensionRegistry. Builtin tools wrap existing `TOOL_DEFS` / `executeToolFixed`. Skills, explore, and MCP each implement ToolProvider (`isEnabled` / `getTools` / `execute` / optional system fragment and run hooks). Plan mode and `subagentDepth>=1` hide write/spawn/mcp. MCP risk aligns with write.

**Tech Stack:** Electron 33, plain Node.js CommonJS (no new deps), `node:test` via `npm test`, existing QQ renderer HTML/CSS/JS.

**Design spec:** `docs/superpowers/specs/2026-07-20-phase-c2-platform-design.md`

## Global Constraints

- Repo-relative paths only; `contextIsolation: true`, `nodeIntegration: false`, API key only in main
- Abort: throw `Error` with `code: 'ABORTED'` and message matching `/已停止/`
- No new npm dependencies (pure Node `child_process` + JSON-RPC frames)
- Default: `skillsEnabled: true`, `subagentEnabled: true`, `mcpEnabled: false`, `mcpServers: []`
- plan mode: tool list **excludes** `spawn_explore` and `mcp_*`; Gate still blocks risk `mcp`
- explore: only `list_dir` `read_file` `grep` `glob` `git_status` `git_diff`; depth 1; maxTurns default 4 clamp 1..8
- MCP: stdio only; `protocolVersion: '2024-11-05'`; **serial** connect per main run; always disconnect in `finally`
- risk: `list_skills`/`use_skill`/`spawn_explore` → `read`; `mcp_*` → `mcp` (same approval path as write)
- UI labels: zh-CN
- Tests: `node --test` via `npm test`; CommonJS `module.exports`
- Frequent commits; Tasks **1 → 11 serially**; do not implement Hooks / parallel explore / SSE
- Do not mix unrelated dirty files (ignore `.idea/`)

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/ai/settings.js` | Modify | `skillsEnabled`, `subagentEnabled`, `mcpEnabled`, `mcpServers` |
| `src/ai/agent-events.js` | Modify | `SUBAGENT_START`, `SUBAGENT_END`, `MCP_STATUS` |
| `src/ai/agent-mode.js` | Modify | plan hide `spawn_explore`; plan block risk `mcp`; filter `mcp_*` in plan |
| `src/ai/permission.js` | Modify | READ_TOOLS + skills/spawn; `riskForTool` mcp prefix |
| `src/ai/extensions/registry.js` | Create | register / collectTools / execute / systemFragments / onRunStart|End |
| `src/ai/providers/builtin.js` | Create | wrap TOOL_DEFS + executeToolFixed; explore-readonly filter |
| `src/ai/skills-loader.js` | Create | discover + parse frontmatter + load body |
| `src/ai/providers/skills.js` | Create | list_skills / use_skill + system fragment |
| `src/ai/providers/explore.js` | Create | spawn_explore nested runLoop |
| `src/ai/mcp-client.js` | Create | Content-Length framing + initialize/list/call |
| `src/ai/mcp-hub.js` | Create | multi-server start/stop + tool merge |
| `src/ai/providers/mcp.js` | Create | mcp_* tools + onRunStart/End |
| `src/ai/agent.js` | Modify | RunContext, registry wire-up, tools/execute/system/finally |
| `src/main.js` | Modify | settings sanitize; `skills:list` / `skills:get`; pass paths for skills |
| `src/preload.js` | Modify | expose skills list/get |
| `src/renderer/index.html` | Modify | skills/subagent/mcp settings fields |
| `src/renderer/styles.css` | Modify | subagent status strip (minimal) |
| `src/renderer/app.js` | Modify | settings form; slash; subagent events |
| `src/skills/code-review/SKILL.md` | Create | bundled example skill |
| `README.md` | Modify | Phase C.2 usage |
| `tests/settings.test.js` | Modify | C.2 defaults + events |
| `tests/permission.test.js` | Modify | skills/spawn read; mcp risk; plan denies mcp |
| `tests/agent-mode.test.js` | Modify | plan hides spawn_explore and mcp_* |
| `tests/registry.test.js` | Create | registry routing and hooks |
| `tests/skills-loader.test.js` | Create | discover priority, frontmatter, truncate |
| `tests/mcp-client.test.js` | Create | frame encode/decode |
| `tests/explore.test.js` | Create | goal/depth/readonly (mock) |
| `tests/agent.test.js` | Modify | tools list with flags; list_skills if needed |

---

### Task 1: Settings defaults + event constants

**Files:**
- Modify: `src/ai/settings.js`
- Modify: `src/ai/agent-events.js`
- Modify: `tests/settings.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SETTINGS.skillsEnabled === true`
  - `DEFAULT_SETTINGS.subagentEnabled === true`
  - `DEFAULT_SETTINGS.mcpEnabled === false`
  - `DEFAULT_SETTINGS.mcpServers` deep-equal `[]`
  - `AGENT_EVENTS.SUBAGENT_START === 'subagent-start'`
  - `AGENT_EVENTS.SUBAGENT_END === 'subagent-end'`
  - `AGENT_EVENTS.MCP_STATUS === 'mcp-status'`

- [ ] **Step 1: Write failing tests** in `tests/settings.test.js`

```js
it('defaults Phase C.2 platform settings', () => {
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');
  assert.equal(DEFAULT_SETTINGS.skillsEnabled, true);
  assert.equal(DEFAULT_SETTINGS.subagentEnabled, true);
  assert.equal(DEFAULT_SETTINGS.mcpEnabled, false);
  assert.deepEqual(DEFAULT_SETTINGS.mcpServers, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  const s = require('../src/ai/settings').loadSettings(dir);
  assert.equal(s.skillsEnabled, true);
  assert.equal(s.mcpEnabled, false);
});

it('AGENT_EVENTS includes subagent and mcp names', () => {
  const { AGENT_EVENTS } = require('../src/ai/agent-events');
  assert.equal(AGENT_EVENTS.SUBAGENT_START, 'subagent-start');
  assert.equal(AGENT_EVENTS.SUBAGENT_END, 'subagent-end');
  assert.equal(AGENT_EVENTS.MCP_STATUS, 'mcp-status');
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/settings.test.js`  
Expected: FAIL missing keys/events

- [ ] **Step 3: Implement**

`src/ai/settings.js` — add to `DEFAULT_SETTINGS`:

```js
// Phase C.2 platform
skillsEnabled: true,
subagentEnabled: true,
mcpEnabled: false,
mcpServers: [], // { name, command, args?, env?, cwd? }[]
```

`src/ai/agent-events.js` — add:

```js
SUBAGENT_START: 'subagent-start',
SUBAGENT_END: 'subagent-end',
MCP_STATUS: 'mcp-status',
```

- [ ] **Step 4: Pass tests**

Run: `node --test tests/settings.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/settings.js src/ai/agent-events.js tests/settings.test.js
git commit -m "feat(codex-qq): Phase C.2 settings and agent events"
```

---

### Task 2: Permission + agent-mode for C.2 tools

**Files:**
- Modify: `src/ai/permission.js`
- Modify: `src/ai/agent-mode.js`
- Modify: `tests/permission.test.js`
- Modify: `tests/agent-mode.test.js`

**Interfaces:**
- Produces:
  - `riskForTool('list_skills'|'use_skill'|'spawn_explore') === 'read'`
  - `riskForTool('mcp_foo_bar') === 'mcp'`
  - `isPlanBlockedRisk('mcp') === true`
  - `filterToolsForMode` plan drops `spawn_explore` and any `mcp_*`; agent keeps them (if present in input)

- [ ] **Step 1: Write failing tests**

`tests/permission.test.js`:

```js
it('riskForTool maps skills and spawn_explore to read', () => {
  assert.equal(riskForTool('list_skills'), 'read');
  assert.equal(riskForTool('use_skill'), 'read');
  assert.equal(riskForTool('spawn_explore'), 'read');
});

it('riskForTool maps mcp_ prefix to mcp', () => {
  assert.equal(riskForTool('mcp_git_status'), 'mcp');
  assert.equal(riskForTool('mcp_server_tool_name'), 'mcp');
});

it('plan mode denies mcp risk even in full-auto', async () => {
  const gate = createPermissionGate({
    permissionMode: 'full-auto',
    agentMode: 'plan',
    onApprovalNeeded: async () => {},
  });
  const r = await gate.authorize({ tool: 'mcp_x_y', risk: 'mcp', sessionKey: 's' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /计划模式/);
});

it('confirm-writes treats mcp like write (needs approval)', async () => {
  let called = false;
  const gate = createPermissionGate({
    permissionMode: 'confirm-writes',
    agentMode: 'agent',
    onApprovalNeeded: async (p) => {
      called = true;
      gate.resolveApproval(p.approvalId, 'allow');
    },
  });
  const r = await gate.authorize({ tool: 'mcp_a_b', risk: 'mcp', sessionKey: 's-mcp' });
  assert.equal(r.allowed, true);
  assert.equal(called, true);
});
```

`tests/agent-mode.test.js`:

```js
it('isPlanBlockedRisk includes mcp', () => {
  assert.equal(isPlanBlockedRisk('mcp'), true);
});

it('filterToolsForMode plan hides spawn_explore and mcp_*', () => {
  const defs = [
    { function: { name: 'read_file' } },
    { function: { name: 'spawn_explore' } },
    { function: { name: 'mcp_demo_ping' } },
    { function: { name: 'submit_plan' } },
    { function: { name: 'list_skills' } },
  ];
  const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
  assert.ok(plan.includes('read_file'));
  assert.ok(plan.includes('submit_plan'));
  assert.ok(plan.includes('list_skills'));
  assert.ok(!plan.includes('spawn_explore'));
  assert.ok(!plan.includes('mcp_demo_ping'));
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/permission.test.js tests/agent-mode.test.js`  
Expected: FAIL

- [ ] **Step 3: Implement**

`src/ai/permission.js`:

```js
const READ_TOOLS = new Set([
  'list_dir', 'read_file', 'grep', 'glob',
  'git_status', 'git_diff',
  'submit_plan',
  'list_skills', 'use_skill', 'spawn_explore',
]);

function riskForTool(toolName) {
  const name = String(toolName || '');
  if (name.startsWith('mcp_')) return 'mcp';
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'delete_path') return 'delete';
  if (name === 'run_terminal') return 'terminal';
  return 'write';
}
```

`src/ai/agent-mode.js`:

```js
const PLAN_BLOCKED_RISKS = new Set(['write', 'delete', 'terminal', 'mcp']);

const PLAN_HIDDEN_TOOLS = new Set([
  'search_replace',
  'write_file',
  'delete_path',
  'git_commit',
  'run_terminal',
  'spawn_explore',
]);

function filterToolsForMode(toolDefs, agentMode) {
  const mode = normalizeAgentMode(agentMode);
  const list = Array.isArray(toolDefs) ? toolDefs : [];
  if (mode === 'plan') {
    return list.filter((t) => {
      const name = t?.function?.name;
      if (!name) return false;
      if (PLAN_HIDDEN_TOOLS.has(name)) return false;
      if (String(name).startsWith('mcp_')) return false;
      return true;
    });
  }
  return list.filter((t) => t?.function?.name !== 'submit_plan');
}
```

Note: `createPermissionGate` already blocks `isPlanBlockedRisk` in plan and treats non-`read` risks under confirm-writes like write — no authorize branch change required once `mcp` is blocked in plan and not classified as `read`.

- [ ] **Step 4: Pass tests**

Run: `node --test tests/permission.test.js tests/agent-mode.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/permission.js src/ai/agent-mode.js tests/permission.test.js tests/agent-mode.test.js
git commit -m "feat(codex-qq): Phase C.2 permission and plan filters for skills/mcp"
```

---

### Task 3: Extension registry

**Files:**
- Create: `src/ai/extensions/registry.js`
- Create: `tests/registry.test.js`

**Interfaces:**
- Produces:
  - `createRegistry()` → `{ register, collectTools, execute, systemFragments, onRunStart, onRunEnd, listProviders }`
  - `register(provider)` — provider must have `id`, `isEnabled`, `getTools`, `execute`
  - `collectTools(ctx)` → merged OpenAI tool defs from enabled providers (async-safe)
  - `execute(name, args, ctx)` → routes to owning provider; unknown → `{ ok:false, error }` stringified or object (match agent: return JSON string if agent expects string — **return value convention: same as executeToolFixed: JSON string**)
  - `systemFragments(ctx)` → join non-empty fragments with `\n\n`
  - `onRunStart(ctx)` / `onRunEnd(ctx)` call each enabled provider hook in register order; errors in onRunEnd must not throw out (log/swallow per provider) so finally always completes

- [ ] **Step 1: Write failing tests** in `tests/registry.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../src/ai/extensions/registry');

describe('extension registry', () => {
  it('collects tools from enabled providers only', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'a',
      isEnabled: () => true,
      getTools: () => [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object', properties: {} } } }],
      execute: async () => JSON.stringify({ ok: true }),
    });
    reg.register({
      id: 'b',
      isEnabled: () => false,
      getTools: () => [{ type: 'function', function: { name: 'tool_b', parameters: { type: 'object', properties: {} } } }],
      execute: async () => JSON.stringify({ ok: true }),
    });
    const tools = await reg.collectTools({});
    assert.deepEqual(tools.map((t) => t.function.name), ['tool_a']);
  });

  it('routes execute by tool name', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'a',
      isEnabled: () => true,
      getTools: () => [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }],
      execute: async (name, args) => JSON.stringify({ ok: true, name, args }),
    });
    const raw = await reg.execute('echo', { x: 1 }, {});
    assert.deepEqual(JSON.parse(raw), { ok: true, name: 'echo', args: { x: 1 } });
  });

  it('unknown tool returns ok false', async () => {
    const reg = createRegistry();
    const raw = await reg.execute('nope', {}, {});
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /未知|unknown/i);
  });

  it('onRunStart and onRunEnd order', async () => {
    const reg = createRegistry();
    const log = [];
    reg.register({
      id: 'p',
      isEnabled: () => true,
      getTools: () => [],
      execute: async () => '{}',
      onRunStart: async () => { log.push('start'); },
      onRunEnd: async () => { log.push('end'); },
    });
    await reg.onRunStart({});
    await reg.onRunEnd({});
    assert.deepEqual(log, ['start', 'end']);
  });

  it('systemFragments joins non-empty', async () => {
    const reg = createRegistry();
    reg.register({
      id: 'p',
      isEnabled: () => true,
      getTools: () => [],
      execute: async () => '{}',
      getSystemFragment: () => 'FRAG',
    });
    assert.match(await reg.systemFragments({}), /FRAG/);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/registry.test.js`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement** `src/ai/extensions/registry.js`

```js
'use strict';

function createRegistry() {
  /** @type {any[]} */
  const providers = [];
  /** @type {Map<string, any>} name → provider, rebuilt on collectTools */
  let route = new Map();

  function register(provider) {
    if (!provider || !provider.id) throw new Error('provider.id required');
    providers.push(provider);
  }

  async function collectTools(ctx) {
    route = new Map();
    const out = [];
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      const tools = await Promise.resolve(p.getTools(ctx));
      for (const t of tools || []) {
        const name = t?.function?.name;
        if (!name) continue;
        route.set(name, p);
        out.push(t);
      }
    }
    return out;
  }

  async function execute(name, args, ctx) {
    const p = route.get(name);
    if (!p) {
      // rebuild route if collectTools not called (tests)
      await collectTools(ctx);
    }
    const provider = route.get(name);
    if (!provider) {
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    }
    return provider.execute(name, args || {}, ctx);
  }

  async function systemFragments(ctx) {
    const parts = [];
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      if (typeof p.getSystemFragment !== 'function') continue;
      const frag = await Promise.resolve(p.getSystemFragment(ctx));
      if (frag && String(frag).trim()) parts.push(String(frag).trim());
    }
    return parts.join('\n\n');
  }

  async function onRunStart(ctx) {
    for (const p of providers) {
      if (typeof p.isEnabled === 'function' && !p.isEnabled(ctx)) continue;
      if (typeof p.onRunStart === 'function') await p.onRunStart(ctx);
    }
  }

  async function onRunEnd(ctx) {
    for (const p of providers) {
      // always try onRunEnd for providers that started resources; call if function exists
      // Spec: MCP disconnect must run — call when hook exists even if isEnabled flipped
      if (typeof p.onRunEnd === 'function') {
        try {
          await p.onRunEnd(ctx);
        } catch {
          // never throw from finally path
        }
      }
    }
  }

  function listProviders() {
    return providers.slice();
  }

  return {
    register,
    collectTools,
    execute,
    systemFragments,
    onRunStart,
    onRunEnd,
    listProviders,
  };
}

module.exports = { createRegistry };
```

- [ ] **Step 4: Pass tests**

Run: `node --test tests/registry.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/extensions/registry.js tests/registry.test.js
git commit -m "feat(codex-qq): ToolProvider extension registry"
```

---

### Task 4: Builtin provider + wire runAgentLoop to registry

**Files:**
- Create: `src/ai/providers/builtin.js`
- Create: `src/ai/providers/index.js` (optional factory `createDefaultRegistry`)
- Modify: `src/ai/agent.js`
- Modify: `tests/agent.test.js` (only if toolsForSettings signature tests break — keep exports stable)

**Interfaces:**
- Produces:
  - `createBuiltinProvider({ getToolDefs, executeTool })` or module that imports from agent carefully
  - Prefer **lazy require** to avoid cycles: `builtin.js` receives `TOOL_DEFS` + `executeToolFixed` as deps from agent when building registry inside agent
  - `toolsForSettings(settings, opts)` still exported; now uses registry + filterToolsForMode
  - `runAgentLoop` accepts optional `subagentDepth` (default 0), `registry` (default createDefault), `extensions` bag
  - Loop: `await registry.onRunStart(ctx)` → collect tools → system += fragments → … → `finally registry.onRunEnd`
  - Tool execution path: after authorize, `registry.execute(name, args, toolCtx)` **or** keep executeToolFixed for builtin-only until other providers land — **must** use registry.execute once registry owns tools

**Recommended wiring inside agent.js (avoid cycle):**

```js
const { createRegistry } = require('./extensions/registry');

function createDefaultRegistry() {
  const reg = createRegistry();
  reg.register(createBuiltinProvider());
  // skills/explore/mcp registered in later tasks
  return reg;
}

function createBuiltinProvider() {
  const EXPLORE_READONLY = new Set([
    'list_dir', 'read_file', 'grep', 'glob', 'git_status', 'git_diff',
  ]);
  return {
    id: 'builtin',
    isEnabled: () => true,
    getTools(ctx) {
      let defs = TOOL_DEFS.slice();
      if (!ctx.settings?.terminalEnabled) {
        defs = defs.filter((t) => t.function.name !== 'run_terminal');
      }
      if (Number(ctx.subagentDepth) >= 1 || ctx.exploreReadonly) {
        defs = defs.filter((t) => EXPLORE_READONLY.has(t.function.name));
      }
      return defs;
    },
    async execute(name, args, ctx) {
      return executeToolFixed(name, args, ctx);
    },
  };
}
```

- [ ] **Step 1: Write / extend test**

In `tests/agent.test.js` (or new case): `toolsForSettings` still returns read tools; plan still hides writes. Add:

```js
it('toolsForSettings agent includes builtin reads', () => {
  const { toolsForSettings } = require('../src/ai/agent');
  const names = toolsForSettings({ terminalEnabled: false }, { agentMode: 'agent' })
    .map((t) => t.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('run_terminal'));
});
```

- [ ] **Step 2: Run existing agent tests to establish baseline**

Run: `node --test tests/agent.test.js`  
Expected: PASS before edits (sanity)

- [ ] **Step 3: Implement registry wire-up**

1. Add `createBuiltinProvider` + `createDefaultRegistry` in `agent.js` or `providers/builtin.js` + `providers/index.js`.
2. Change `toolsForSettings` to async-**or**-sync: registry `getTools` for builtin is sync — keep **sync** API by using only sync providers for collect in toolsForSettings:

```js
function toolsForSettings(settings, opts = {}) {
  const agentMode = normalizeAgentMode(opts.agentMode);
  const registry = opts.registry || createDefaultRegistry();
  const ctx = {
    settings,
    agentMode,
    subagentDepth: opts.subagentDepth || 0,
    exploreReadonly: !!opts.exploreReadonly,
    project: opts.project || null,
    extensions: opts.extensions || {},
  };
  // collectTools is async in registry — for sync toolsForSettings, either:
  // (A) make toolsForSettings async (breaking), or
  // (B) add collectToolsSync that only awaits if needed
  // Spec choice: implement collectTools as async; change toolsForSettings to async
  // and update all call sites (runAgentLoop only). Export async function.
}
```

**Lock decision:** Make `toolsForSettings` **async**; `runAgentLoop` awaits it. Update tests to await. Grep call sites: only `runAgentLoop` and tests.

```js
async function toolsForSettings(settings, opts = {}) {
  const agentMode = normalizeAgentMode(opts.agentMode);
  const registry = opts.registry || createDefaultRegistry();
  const ctx = {
    settings,
    agentMode,
    subagentDepth: Number(opts.subagentDepth) || 0,
    exploreReadonly: !!opts.exploreReadonly,
    project: opts.project || null,
    extensions: opts.extensions || {},
  };
  const tools = await registry.collectTools(ctx);
  return filterToolsForMode(tools, agentMode);
}
```

3. In `runAgentLoop`, build ctx, `await registry.onRunStart(ctx)`, collect tools, append `await registry.systemFragments(ctx)` to system content, and in the tool loop after authorize call `await registry.execute(...)`.

4. Wrap entire loop body in `try { ... } finally { await registry.onRunEnd(ctx); }`.

5. Pass `subagentDepth: 0` by default from `runAgentLoop` params.

```js
async function runAgentLoop({
  project,
  settings,
  messages,
  gate,
  onEvent,
  fetchFn,
  signal,
  sessionKey,
  chatFn,
  confirmTerminal,
  agentMode,
  subagentDepth = 0,
  registry: registryOpt,
  extensions: extensionsOpt,
}) {
  const registry = registryOpt || createDefaultRegistry();
  const extensions = extensionsOpt || {};
  const mode = normalizeAgentMode(agentMode);
  const depth = Number(subagentDepth) || 0;
  const ctxBase = {
    project,
    settings,
    agentMode: mode,
    subagentDepth: depth,
    exploreReadonly: depth >= 1,
    gate: effectiveGate after resolve,
    onEvent,
    signal,
    sessionKey,
    extensions,
    registry,
  };
  // ...
}
```

6. Keep exporting `TOOL_DEFS`, `executeToolFixed`, `toolsForSettings` (now async).

- [ ] **Step 4: Fix tests that call toolsForSettings**

```js
const tools = await toolsForSettings({ terminalEnabled: true }, { agentMode: 'plan' });
```

Run: `node --test tests/agent.test.js tests/agent-mode.test.js tests/permission.test.js`  
Expected: PASS (behavior zero-diff)

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/builtin.js src/ai/providers/index.js src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): wire ToolProvider registry into agent loop"
```

---

### Task 5: Skills loader

**Files:**
- Create: `src/ai/skills-loader.js`
- Create: `tests/skills-loader.test.js`

**Interfaces:**
- Produces:
  - `parseFrontmatter(text) → { attrs: object, body: string }`
  - `sanitizeSkillName(name) → string | null`
  - `discoverSkills({ projectPath, userDataPath, bundledDir }) → SkillMeta[]`
  - `loadSkillBody(meta) → { ok, name, description, body, source, truncated }`
  - Priority project > user > bundled; max 50; body max 24 KiB

- [ ] **Step 1: Failing tests** `tests/skills-loader.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseFrontmatter,
  sanitizeSkillName,
  discoverSkills,
  loadSkillBody,
  SKILL_BODY_MAX,
} = require('../src/ai/skills-loader');

describe('skills-loader', () => {
  it('parseFrontmatter reads name and description', () => {
    const raw = '---\nname: code-review\ndescription: "审查"\n---\n\n# Hi\n';
    const { attrs, body } = parseFrontmatter(raw);
    assert.equal(attrs.name, 'code-review');
    assert.equal(attrs.description, '审查');
    assert.match(body, /# Hi/);
  });

  it('sanitizeSkillName', () => {
    assert.equal(sanitizeSkillName('Code_Review'), 'code_review');
    assert.equal(sanitizeSkillName('OK-1'), 'ok-1');
    assert.equal(sanitizeSkillName('!!!'), null);
  });

  it('discoverSkills priority project over bundled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const project = path.join(root, 'proj');
    const bundled = path.join(root, 'bundled');
    const userData = path.join(root, 'ud');
    fs.mkdirSync(path.join(project, '.codex', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(project, '.codex', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: from-project\n---\nP\n');
    fs.mkdirSync(path.join(bundled, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: from-bundled\n---\nB\n');
    const list = discoverSkills({ projectPath: project, userDataPath: userData, bundledDir: bundled });
    const demo = list.find((s) => s.name === 'demo');
    assert.equal(demo.source, 'project');
    assert.equal(demo.description, 'from-project');
  });

  it('loadSkillBody truncates large body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-body-'));
    const dir = path.join(root, 'big');
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: big\ndescription: d\n---\n' + 'x'.repeat(SKILL_BODY_MAX + 100));
    const r = loadSkillBody({
      name: 'big', description: 'd', source: 'project', dir, skillPath,
    });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.body.length <= SKILL_BODY_MAX);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/skills-loader.test.js`  
Expected: FAIL

- [ ] **Step 3: Implement** `src/ai/skills-loader.js`

Key rules from spec:

- Frontmatter only between leading `---` lines; `key: value` with optional quotes
- name regex `^[a-z0-9][a-z0-9_-]{0,63}$` after lowercasing sanitize
- Scan each root: subdirs with `SKILL.md`
- Merge maps: insert bundled, then user, then project (later overwrites)
- Cap 50 entries (stable order: prefer keep higher priority already in map; if over 50 after merge, keep insertion order of final map values sliced to 50)

```js
const SKILL_BODY_MAX = 24 * 1024;
const SKILL_MAX_COUNT = 50;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sanitizeSkillName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s || !NAME_RE.test(s)) return null;
  return s;
}

// parseFrontmatter, discoverSkills, loadSkillBody as specified
module.exports = {
  SKILL_BODY_MAX,
  SKILL_MAX_COUNT,
  parseFrontmatter,
  sanitizeSkillName,
  discoverSkills,
  loadSkillBody,
};
```

- [ ] **Step 4: Pass**

Run: `node --test tests/skills-loader.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/skills-loader.js tests/skills-loader.test.js
git commit -m "feat(codex-qq): skills-loader discover and parse"
```

---

### Task 6: Skills provider + agent registration

**Files:**
- Create: `src/ai/providers/skills.js`
- Modify: `src/ai/providers/index.js` or `agent.js` `createDefaultRegistry`
- Create: `src/skills/code-review/SKILL.md`
- Modify: `tests/agent.test.js` (tools include list_skills when enabled)

**Interfaces:**
- Produces:
  - `createSkillsProvider({ bundledDir })` 
  - Tools: `list_skills`, `use_skill`
  - `isEnabled(ctx)`: `settings.skillsEnabled !== false` && `subagentDepth < 1`
  - `getSystemFragment`: catalog lines when non-empty
  - Bundled skill at `src/skills/code-review/SKILL.md`

- [ ] **Step 1: Failing tests**

```js
it('toolsForSettings includes list_skills when skills enabled', async () => {
  const { toolsForSettings } = require('../src/ai/agent');
  const names = (await toolsForSettings(
    { terminalEnabled: false, skillsEnabled: true },
    { agentMode: 'agent' },
  )).map((t) => t.function.name);
  assert.ok(names.includes('list_skills'));
  assert.ok(names.includes('use_skill'));
});

it('toolsForSettings omits skills when disabled', async () => {
  const { toolsForSettings } = require('../src/ai/agent');
  const names = (await toolsForSettings(
    { terminalEnabled: false, skillsEnabled: false },
    { agentMode: 'agent' },
  )).map((t) => t.function.name);
  assert.ok(!names.includes('list_skills'));
});
```

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement provider**

`src/ai/providers/skills.js`:

```js
const path = require('path');
const { discoverSkills, loadSkillBody } = require('../skills-loader');

function createSkillsProvider(opts = {}) {
  const bundledDir = opts.bundledDir || path.join(__dirname, '..', '..', 'skills');

  function ensureCatalog(ctx) {
    if (ctx.extensions.skillCatalog) return ctx.extensions.skillCatalog;
    const catalog = discoverSkills({
      projectPath: ctx.project?.path,
      userDataPath: ctx.extensions.userDataPath || opts.userDataPath,
      bundledDir,
    });
    ctx.extensions.skillCatalog = catalog;
    return catalog;
  }

  return {
    id: 'skills',
    isEnabled(ctx) {
      if (ctx.settings?.skillsEnabled === false) return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      return true;
    },
    getTools() {
      return [
        {
          type: 'function',
          function: {
            name: 'list_skills',
            description: 'List available Skills (name, description, source)',
            parameters: { type: 'object', properties: {} },
          },
        },
        {
          type: 'function',
          function: {
            name: 'use_skill',
            description: 'Load full Skill body by name',
            parameters: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        },
      ];
    },
    async execute(name, args, ctx) {
      const catalog = ensureCatalog(ctx);
      if (name === 'list_skills') {
        return JSON.stringify({
          ok: true,
          skills: catalog.map((s) => ({
            name: s.name,
            description: s.description,
            source: s.source,
          })),
        });
      }
      if (name === 'use_skill') {
        const key = String(args.name || '').trim().toLowerCase();
        const meta = catalog.find((s) => s.name === key);
        if (!meta) {
          return JSON.stringify({ ok: false, error: '未找到 skill: ' + key });
        }
        const body = loadSkillBody(meta);
        return JSON.stringify(body);
      }
      return JSON.stringify({ ok: false, error: '未知工具: ' + name });
    },
    getSystemFragment(ctx) {
      const catalog = ensureCatalog(ctx);
      if (!catalog.length) return null;
      const lines = catalog.map((s) => {
        const desc = String(s.description || '').slice(0, 80);
        return `- ${s.name}: ${desc} (${s.source})`;
      });
      return ['【可用 Skills】需要时用 list_skills / use_skill 加载全文，勿编造技能内容。', ...lines].join('\n');
    },
  };
}

module.exports = { createSkillsProvider };
```

Register in `createDefaultRegistry()`. Pass `userDataPath` into `ctx.extensions` from `main.js` when calling `runAgentLoop` (Task 7 can add if not yet — for tests pass `extensions: { userDataPath: tmp }`).

Bundled `src/skills/code-review/SKILL.md`:

```markdown
---
name: code-review
description: 代码审查清单与输出格式
---

# 代码审查

1. 理解改动目的与范围
2. 正确性与边界条件
3. 安全与权限
4. 可读性与测试
5. 用中文给出结论与建议
```

Also update `agentSystemPrompt` **or** rely solely on registry fragments appended after base system — prefer append after `agentSystemPrompt(...)` in loop:

```js
const baseSystem = agentSystemPrompt(...);
const extra = await registry.systemFragments(ctx);
content: [baseSystem, extra].filter(Boolean).join('\n\n')
```

- [ ] **Step 4: Pass**

Run: `node --test tests/agent.test.js tests/skills-loader.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/skills.js src/skills/code-review/SKILL.md src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): skills provider and bundled code-review skill"
```

---

### Task 7: Skills IPC + slash commands + main userDataPath

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/index.html` (skillsEnabled checkbox)
- Ensure `package.json` build `files` includes `src/skills/**` (already `src/**/*`)

**Interfaces:**
- Produces:
  - IPC `skills:list` → `{ ok, skills }` using discoverSkills for active project path if any — list uses **last project from payload** or optional; simpler: `skills:list` with `{ projectPath? }`
  - IPC `skills:get` → `{ projectPath?, name }` → loadSkillBody
  - preload: `listSkills`, `getSkill`
  - slash `/skills`, `/skill <name>`
  - settings save/load `skillsEnabled`; main passes `extensions.userDataPath` into runAgentLoop
  - sanitize mcpServers not yet — next tasks

- [ ] **Step 1: Implement main handlers**

```js
const { discoverSkills, loadSkillBody } = require('./ai/skills-loader');
const path = require('path');

function bundledSkillsDir() {
  return path.join(__dirname, 'skills');
}

ipcMain.handle('skills:list', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  return {
    ok: true,
    skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
  };
});

ipcMain.handle('skills:get', async (_e, payload = {}) => {
  const skills = discoverSkills({
    projectPath: payload.projectPath || null,
    userDataPath: userDataPath(),
    bundledDir: bundledSkillsDir(),
  });
  const name = String(payload.name || '').trim().toLowerCase();
  const meta = skills.find((s) => s.name === name);
  if (!meta) return { ok: false, error: '未找到 skill: ' + name };
  return loadSkillBody(meta);
});
```

In `startChatRun` → `runAgentLoop`:

```js
extensions: {
  userDataPath: userDataPath(),
},
```

`settings:save` — boolean coerce for `skillsEnabled`, `subagentEnabled`, `mcpEnabled`.

- [ ] **Step 2: preload**

```js
listSkills: (payload) => ipcRenderer.invoke('skills:list', payload || {}),
getSkill: (payload) => ipcRenderer.invoke('skills:get', payload || {}),
```

- [ ] **Step 3: renderer slash + settings**

In `handleSlashCommand`:

```js
if (lower === '/skills') {
  const proj = sessionProject(activeSession());
  window.codex.listSkills({ projectPath: proj?.path || null }).then((r) => {
    const lines = (r.skills || []).map((s) => `- **${s.name}** (${s.source}): ${s.description || ''}`);
    activeSession().messages.push({
      role: 'assistant',
      content: lines.length ? ('可用 Skills：\n' + lines.join('\n')) : '暂无 Skills。',
    });
    saveState(); renderMessages();
  });
  return true;
}
if (lower.startsWith('/skill ')) {
  const name = cmd.slice(7).trim();
  const proj = sessionProject(activeSession());
  window.codex.getSkill({ name, projectPath: proj?.path || null }).then((r) => {
    if (!r.ok) {
      toast(r.error || '未找到 skill');
      return;
    }
    document.getElementById('chat-input').value =
      `请按技能 ${r.name} 执行：\n\n${r.body}`;
    sendMessage();
  });
  return true;
}
```

Settings HTML checkbox `set-skills-enabled` (default checked); wire open/save like other switches.

Update `/help` text to mention `/skills` `/skill`.

- [ ] **Step 4: Manual sanity** — unit tests for IPC optional; run `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/main.js src/preload.js src/renderer/app.js src/renderer/index.html
git commit -m "feat(codex-qq): skills IPC and slash commands"
```

---

### Task 8: Explore sub-agent provider

**Files:**
- Create: `src/ai/providers/explore.js`
- Create: `tests/explore.test.js`
- Modify: `src/ai/agent.js` (register provider; accept injected runLoop)
- Modify: `src/renderer/app.js` (subagent-start/end UI)
- Modify: `src/renderer/styles.css` (optional `.subagent-strip`)

**Interfaces:**
- Produces:
  - `createExploreProvider({ runLoop })` where `runLoop` is `runAgentLoop`
  - Tool `spawn_explore` { goal, maxTurns? }
  - Nested: `subagentDepth: 1`, `exploreReadonly: true`, settings copy with `maxAgentTurns: maxTurns`, `skillsEnabled: false`, `mcpEnabled: false`, `subagentEnabled: false` optional
  - Events SUBAGENT_START / END via `ctx.onEvent`

- [ ] **Step 1: Failing tests** `tests/explore.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createExploreProvider } = require('../src/ai/providers/explore');
const { createPermissionGate } = require('../src/ai/permission');

describe('explore provider', () => {
  it('rejects short goal', async () => {
    const p = createExploreProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const raw = await p.execute('spawn_explore', { goal: 'ab' }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
    });
    assert.equal(JSON.parse(raw).ok, false);
  });

  it('rejects nested spawn', async () => {
    const p = createExploreProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const raw = await p.execute('spawn_explore', { goal: 'find auth module' }, {
      subagentDepth: 1,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
    });
    assert.match(JSON.parse(raw).error, /禁止|子 Agent/);
  });

  it('calls runLoop with depth 1 and readonly tools only', async () => {
    let seen;
    const p = createExploreProvider({
      runLoop: async (opts) => {
        seen = opts;
        return { content: 'summary here', turns: 2, agentLog: [{ tool: 'grep', ok: true, summary: '1' }] };
      },
    });
    const events = [];
    const gate = createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' });
    const raw = await p.execute('spawn_explore', { goal: 'find auth module', maxTurns: 3 }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true, maxAgentTurns: 8 },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate,
      onEvent: (e) => events.push(e),
      extensions: {},
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.settings.maxAgentTurns, 3);
    assert.ok(events.some((e) => e.type === 'subagent-start'));
    assert.ok(events.some((e) => e.type === 'subagent-end'));
  });
});
```

- [ ] **Step 2: Implement** `src/ai/providers/explore.js`

```js
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
          extensions: { ...ctx.extensions },
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
```

**Critical:** `createDefaultRegistry` must register explore with **lazy** runLoop:

```js
function createDefaultRegistry() {
  const reg = createRegistry();
  reg.register(createBuiltinProvider());
  reg.register(createSkillsProvider());
  reg.register(createExploreProvider({
    runLoop: (...args) => require('./agent').runAgentLoop(...args), // or bind after export
  }));
  return reg;
}
```

Because `createDefaultRegistry` lives in agent.js, inject:

```js
reg.register(createExploreProvider({ runLoop: runAgentLoop }));
```

after `function runAgentLoop` is defined (function declaration is hoisted in JS — `async function` is hoisted). Safe to reference `runAgentLoop` in `createDefaultRegistry` if both are function declarations in same file.

Builtin already filters EXPLORE_READONLY when `subagentDepth >= 1`.

**Nested system prompt:** when `depth >= 1`, shorten system via `agentSystemPrompt` branch:

```js
if (depth >= 1) {
  // only readonly explore instructions; no verify, no plan submit
}
```

Add at start of `agentSystemPrompt` when `opts.subagentDepth >= 1` or `opts.exploreReadonly`.

- [ ] **Step 3: Renderer events**

```js
if (type === 'subagent-start') {
  setRunStatus('子 Agent 调研中: ' + String(ev.goal || '').slice(0, 60));
  return;
}
if (type === 'subagent-end') {
  setRunStatus(ev.ok ? '子 Agent 完成' : ('子 Agent 失败: ' + (ev.error || '')));
  return;
}
```

Settings checkbox `set-subagent-enabled`.

- [ ] **Step 4: Pass**

Run: `node --test tests/explore.test.js tests/agent.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/explore.js src/ai/agent.js tests/explore.test.js src/renderer/app.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat(codex-qq): explore sub-agent spawn_explore"
```

---

### Task 9: MCP client framing + JSON-RPC

**Files:**
- Create: `src/ai/mcp-client.js`
- Create: `tests/mcp-client.test.js`

**Interfaces:**
- Produces:
  - `encodeFrame(obj) → Buffer|string` Content-Length framed
  - `createFrameReader()` → `{ push(chunk) → messages[], }` 
  - `createMcpClient({ command, args, env, cwd, spawnFn? })` → `{ start(), listTools(), callTool(name, args), close() }`
  - `protocolVersion: '2024-11-05'`
  - request timeout 60s
  - `start`: spawn, initialize, initialized notification, ready for listTools

- [ ] **Step 1: Frame unit tests**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, createFrameReader } = require('../src/ai/mcp-client');

describe('mcp frames', () => {
  it('encodeFrame roundtrips via reader', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    const frame = encodeFrame(body);
    const reader = createFrameReader();
    const msgs = reader.push(frame);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], body);
  });

  it('reader handles split chunks', () => {
    const body = { jsonrpc: '2.0', id: 2, result: { ok: true } };
    const frame = encodeFrame(body);
    const mid = Math.floor(frame.length / 2);
    const reader = createFrameReader();
    assert.deepEqual(reader.push(frame.slice(0, mid)), []);
    const msgs = reader.push(frame.slice(mid));
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], body);
  });
});
```

- [ ] **Step 2: Implement encode/reader + client**

```js
function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, json]);
}

function createFrameReader() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const out = [];
      while (true) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const header = buf.slice(0, sep).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // drop invalid header line
          buf = buf.slice(sep + 4);
          continue;
        }
        const len = Number(m[1]);
        const start = sep + 4;
        if (buf.length < start + len) break;
        const body = buf.slice(start, start + len).toString('utf8');
        buf = buf.slice(start + len);
        try { out.push(JSON.parse(body)); } catch { /* skip */ }
      }
      return out;
    },
  };
}
```

Client outline:

- `let nextId = 1; pending = Map id → {resolve,reject,timer}`
- on stdout data → reader.push → dispatch responses by id; ignore notifications for now
- `request(method, params)` sends framed message
- `start()`: spawn; `await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-qq', version: '1.0.0' } })`; write notification `notifications/initialized`; 
- `listTools()` → `tools/list`
- `callTool(name, args)` → `tools/call` `{ name, arguments: args }`
- `close()`: kill process, reject pendings

Use `child_process.spawn` with `stdio: ['pipe','pipe','pipe']`.

- [ ] **Step 3: Pass frame tests**

Run: `node --test tests/mcp-client.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/ai/mcp-client.js tests/mcp-client.test.js
git commit -m "feat(codex-qq): MCP stdio client framing and RPC"
```

---

### Task 10: MCP hub + provider + settings sanitize

**Files:**
- Create: `src/ai/mcp-hub.js`
- Create: `src/ai/providers/mcp.js`
- Modify: `src/ai/agent.js` register mcp provider
- Modify: `src/main.js` sanitize `mcpServers` on save
- Modify: `src/renderer/index.html` + `app.js` MCP settings UI
- Modify: `tests/permission.test.js` / agent tests as needed

**Interfaces:**
- Produces:
  - `createMcpHub()` → `{ startAll(servers, { cwd, onStatus, signal }), getToolDefs(), call(toolName, args), stopAll() }`
  - Tool names `mcp_<server>_<tool>` with sanitization
  - Provider `onRunStart` starts hub if `mcpEnabled && servers.length && subagentDepth===0 && agentMode==='agent'`
  - `onRunEnd` always `stopAll`
  - `saveSettings` validates mcpServers array

- [ ] **Step 1: Implement hub**

```js
// src/ai/mcp-hub.js
const { createMcpClient } = require('./mcp-client');

function sanitizeToolPart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_') || 'tool';
}

function createMcpHub(opts = {}) {
  const createClient = opts.createClient || createMcpClient;
  /** @type {Map<string, { client, tools: any[] }>} */
  const servers = new Map();
  /** @type {Map<string, { serverName, toolName }>} */
  const route = new Map();

  async function startAll(serverConfigs, { cwd, onStatus, signal } = {}) {
    await stopAll();
    const list = Array.isArray(serverConfigs) ? serverConfigs : [];
    for (const cfg of list) {
      if (signal?.aborted) break;
      const name = String(cfg.name || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !cfg.command) {
        onStatus?.({ server: name || '?', ok: false, error: 'invalid config' });
        continue;
      }
      try {
        const client = createClient({
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env,
          cwd: cfg.cwd || cwd,
        });
        await client.start();
        const tools = await client.listTools();
        servers.set(name, { client, tools: tools || [] });
        for (const t of tools || []) {
          let full = `mcp_${name}_${sanitizeToolPart(t.name)}`;
          let n = 2;
          while (route.has(full)) {
            full = `mcp_${name}_${sanitizeToolPart(t.name)}_${n++}`;
          }
          route.set(full, { serverName: name, toolName: t.name, description: t.description, inputSchema: t.inputSchema });
        }
        onStatus?.({ server: name, ok: true });
      } catch (err) {
        onStatus?.({ server: name, ok: false, error: err.message || String(err) });
      }
    }
  }

  function getToolDefs() {
    const defs = [];
    for (const [full, meta] of route) {
      defs.push({
        type: 'function',
        function: {
          name: full,
          description: meta.description || `MCP ${meta.serverName}/${meta.toolName}`,
          parameters: meta.inputSchema && typeof meta.inputSchema === 'object'
            ? meta.inputSchema
            : { type: 'object', properties: {} },
        },
      });
    }
    return defs;
  }

  async function call(fullName, args) {
    const meta = route.get(fullName);
    if (!meta) return { ok: false, error: '未知 mcp 工具: ' + fullName };
    const entry = servers.get(meta.serverName);
    if (!entry) return { ok: false, error: 'server 未连接: ' + meta.serverName };
    try {
      const result = await entry.client.callTool(meta.toolName, args || {});
      let text = typeof result === 'string' ? result : JSON.stringify(result);
      let truncated = false;
      if (text.length > 32 * 1024) {
        text = text.slice(0, 32 * 1024);
        truncated = true;
      }
      return { ok: true, result: text, truncated };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async function stopAll() {
    for (const [, entry] of servers) {
      try { await entry.client.close(); } catch { /* */ }
    }
    servers.clear();
    route.clear();
  }

  return { startAll, getToolDefs, call, stopAll };
}

module.exports = { createMcpHub, sanitizeToolPart };
```

- [ ] **Step 2: MCP provider**

```js
// src/ai/providers/mcp.js
const { createMcpHub } = require('../mcp-hub');
const { AGENT_EVENTS } = require('../agent-events');

function createMcpProvider() {
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
      const hub = createMcpHub();
      ctx.extensions.mcpHub = hub;
      await hub.startAll(ctx.settings.mcpServers, {
        cwd: ctx.project?.path,
        signal: ctx.signal,
        onStatus: (st) => {
          ctx.onEvent?.({ type: AGENT_EVENTS.MCP_STATUS, ...st });
        },
      });
    },
    getTools(ctx) {
      const hub = ctx.extensions.mcpHub;
      if (!hub) return [];
      return hub.getToolDefs();
    },
    async execute(name, args, ctx) {
      const hub = ctx.extensions.mcpHub;
      if (!hub) return JSON.stringify({ ok: false, error: 'MCP 未连接' });
      const r = await hub.call(name, args);
      return JSON.stringify(r);
    },
    async onRunEnd(ctx) {
      const hub = ctx.extensions.mcpHub;
      if (hub) {
        await hub.stopAll();
        delete ctx.extensions.mcpHub;
      }
    },
  };
}

module.exports = { createMcpProvider };
```

**Ordering note:** `onRunStart` must run **before** `collectTools` so mcp tools appear. Registry already does start then collect in agent loop.

Register `createMcpProvider()` in `createDefaultRegistry`.

- [ ] **Step 3: main settings sanitize**

```js
function sanitizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    const command = String(item.command || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !command) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = { name, command };
    if (Array.isArray(item.args)) entry.args = item.args.map(String);
    if (item.env && typeof item.env === 'object') entry.env = item.env;
    if (item.cwd) entry.cwd = String(item.cwd);
    out.push(entry);
  }
  return out;
}
```

On save: `mcpServers: sanitizeMcpServers(nextPartial.mcpServers)`.

- [ ] **Step 4: Settings UI**

After verify fields:

```html
<label class="switch-row"><input type="checkbox" id="set-skills-enabled" checked /> <span>启用 Skills</span></label>
<label class="switch-row"><input type="checkbox" id="set-subagent-enabled" checked /> <span>启用 explore 子 Agent</span></label>
<label class="switch-row"><input type="checkbox" id="set-mcp-enabled" /> <span>启用 MCP（stdio）</span></label>
<label class="field">
  <span>MCP 服务器 JSON</span>
  <textarea id="set-mcp-servers" rows="5" placeholder='[{"name":"demo","command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}]'></textarea>
</label>
```

In save: parse JSON; on invalid toast 错误并 **中止保存** or save other fields without mcpServers — **abort save with toast** if invalid when non-empty.

- [ ] **Step 5: Tests + commit**

Add unit test for `sanitizeToolPart` / hub naming if exported. Run full suite subset.

```bash
git add src/ai/mcp-hub.js src/ai/providers/mcp.js src/ai/agent.js src/main.js src/renderer/index.html src/renderer/app.js tests/
git commit -m "feat(codex-qq): MCP hub provider and settings UI"
```

---

### Task 11: README + full regression + polish

**Files:**
- Modify: `README.md`
- Touch any remaining gaps from self-review (help text, electron-builder files already cover skills)

- [ ] **Step 1: README section** after Phase C.1:

```markdown
## Phase C.2：平台化（Skills + explore + MCP）

### Skills
- 目录：项目 `.codex/skills/<id>/SKILL.md`、userData `skills/`、内置 `src/skills/`
- 工具：`list_skills` / `use_skill`；斜杠 `/skills`、`/skill <name>`
- 设置：`skillsEnabled`（默认开）

### explore 子 Agent
- 工具：`spawn_explore`（仅执行模式）；只读六件套；默认 4 轮，最多 8
- 设置：`subagentEnabled`（默认开）

### MCP（stdio）
- 设置：`mcpEnabled`（默认关）+ `mcpServers` JSON
- 每次 Agent run 连接，结束断开；工具名 `mcp_<server>_<tool>`；权限同写操作
- 仅 stdio；无 SSE/HTTP

### 后续
- C.3 Hooks · C.4 更强子 Agent · C.5 MCP/Skills 增强
```

Remove/adjust “本阶段明确不做” under C.1 that says MCP/Skills entirely — add note “见 Phase C.2”.

- [ ] **Step 2: Full test**

Run: `npm test`  
Expected: all PASS

- [ ] **Step 3: Final commit**

```bash
git add README.md
git commit -m "docs(codex-qq): Phase C.2 platform usage in README"
```

---

## Spec coverage checklist (author self-review)

| Spec requirement | Task |
|------------------|------|
| ToolProvider registry | 3, 4 |
| Skills discover 3 sources + priority | 5, 6 |
| list_skills / use_skill + system fragment | 6 |
| slash /skills /skill | 7 |
| bundled skill | 6 |
| spawn_explore readonly depth 1 | 8 |
| plan hides spawn + mcp | 2, 8, 10 |
| MCP stdio per-run lifecycle | 9, 10 |
| risk mcp ≈ write | 2 |
| defaults skills/subagent on, mcp off | 1 |
| settings UI | 7, 10 |
| events subagent + mcp-status | 1, 8, 10 |
| no new deps / no Hooks | global |
| README | 11 |

## Placeholder scan

No TBD steps; concrete code and commands included. Implementers must still adapt line-level merges to live `agent.js` (large file) without deleting Phase C.1 verify/plan logic.

## Type consistency

- `createRegistry` / `createBuiltinProvider` / `createSkillsProvider` / `createExploreProvider({ runLoop })` / `createMcpProvider` / `createMcpHub` / `createMcpClient`
- Events: `subagent-start` | `subagent-end` | `mcp-status`
- Settings keys: `skillsEnabled`, `subagentEnabled`, `mcpEnabled`, `mcpServers`
- `toolsForSettings` becomes **async** (Task 4) — all call sites must `await`

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-07-20-phase-c2-platform.md`.

After user approval of this plan file, offer:

1. **Subagent-Driven (recommended)** — superpowers:subagent-driven-development  
2. **Inline Execution** — superpowers:executing-plans  
