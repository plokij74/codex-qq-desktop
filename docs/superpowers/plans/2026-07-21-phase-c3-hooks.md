# Phase C.3 Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase C.3 config-driven external-command Hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) outside the ToolProvider registry, with Gate double-check, layered user+project merge, settings summary, and chat trajectory UI.

**Architecture:** `hooks-loader` reads and merges `{userData}/hooks.json` + `{project}/.codex/hooks.json`. `hooks-runner` serially spawns commands (`shell: false`), parses stdout JSON for Pre decisions (`allow` / `deny` / `skip` + args rewrite), and emits `hook-start` / `hook-end`. `runAgentLoop` (only when `subagentDepth === 0` and `hooksEnabled`) calls runner at lifecycle points; tool path is `Gate₁ → Pre → (Gate₂ if args changed) → execute|skip → Post`. Registry/providers stay unaware of hooks.

**Tech Stack:** Electron 33, plain Node.js CommonJS (no new deps), `child_process.spawn`, `node:test` via `npm test`, existing QQ renderer HTML/CSS/JS.

**Design spec:** `docs/superpowers/specs/2026-07-21-phase-c3-hooks-design.md`

## Global Constraints

- Repo-relative paths only; `contextIsolation: true`, `nodeIntegration: false`, API key only in main
- Abort: throw `Error` with `code: 'ABORTED'` and message matching `/已停止/`
- No new npm dependencies
- Default: `hooksEnabled: true`
- Pre failure / non-JSON / exit≠0 / timeout → **deny** (tool does not run)
- Non-Pre event failure → log + `hook-end` ok:false, **do not block** main flow
- `subagentDepth >= 1` → skip all hooks
- Gate is sole authorization authority; skip cannot bypass Gate₁
- `shell: false` only; cwd limited to project / userData / path under project root
- Never put `apiKey` or MCP secrets into hook env or stdin
- UI labels: zh-CN
- Tests: `node --test` via `npm test`; CommonJS `module.exports`
- Frequent commits; Tasks **1 → 8 serially**
- Do not implement C.4 parallel agents, C.5 SSE MCP, JS-module hooks, or hooks GUI editor
- Do not mix unrelated dirty files (ignore `.idea/`)

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/ai/settings.js` | Modify | `hooksEnabled: true` |
| `src/ai/agent-events.js` | Modify | `HOOK_START`, `HOOK_END` |
| `src/ai/hooks-loader.js` | Create | matchTool, loadHooks, normalize rules, merge, summarize |
| `src/ai/hooks-runner.js` | Create | createHooksRunner, spawn, protocol, Pre/Post/lifecycle |
| `src/ai/agent.js` | Modify | load/run hooks at lifecycle + tool path; pass userDataPath via extensions |
| `src/main.js` | Modify | `hooksEnabled` public settings; `hooks:summary` IPC |
| `src/preload.js` | Modify | `hooksSummary` |
| `src/renderer/index.html` | Modify | hooks toggle + summary block |
| `src/renderer/styles.css` | Modify | minimal hook trajectory styles |
| `src/renderer/app.js` | Modify | settings bind; render hook-start/end |
| `README.md` | Modify | Phase C.3 usage |
| `tests/settings.test.js` | Modify | hooksEnabled + events |
| `tests/hooks-loader.test.js` | Create | merge, matcher, version, bad JSON |
| `tests/hooks-runner.test.js` | Create | allow/deny/skip/rewrite/timeout/abort |
| `tests/hooks-agent.test.js` | Create | Gate₁/Pre/Gate₂/skip/depth integration |

---

### Task 1: Settings default + event constants

**Files:**
- Modify: `src/ai/settings.js`
- Modify: `src/ai/agent-events.js`
- Modify: `tests/settings.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SETTINGS.hooksEnabled === true`
  - `AGENT_EVENTS.HOOK_START === 'hook-start'`
  - `AGENT_EVENTS.HOOK_END === 'hook-end'`

- [ ] **Step 1: Write failing tests** in `tests/settings.test.js`

```js
it('defaults Phase C.3 hooksEnabled', () => {
  const { DEFAULT_SETTINGS, loadSettings } = require('../src/ai/settings');
  assert.equal(DEFAULT_SETTINGS.hooksEnabled, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  assert.equal(loadSettings(dir).hooksEnabled, true);
});

it('AGENT_EVENTS includes hook names', () => {
  const { AGENT_EVENTS } = require('../src/ai/agent-events');
  assert.equal(AGENT_EVENTS.HOOK_START, 'hook-start');
  assert.equal(AGENT_EVENTS.HOOK_END, 'hook-end');
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/settings.test.js`  
Expected: FAIL missing `hooksEnabled` / hook events

- [ ] **Step 3: Implement**

`src/ai/settings.js` — add to `DEFAULT_SETTINGS`:

```js
// Phase C.3 hooks
hooksEnabled: true,
```

`src/ai/agent-events.js` — add:

```js
HOOK_START: 'hook-start',
HOOK_END: 'hook-end',
```

- [ ] **Step 4: Run to pass**

Run: `node --test tests/settings.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/settings.js src/ai/agent-events.js tests/settings.test.js
git commit -m "feat(codex-qq): Phase C.3 hooksEnabled setting and hook events"
```

---

### Task 2: hooks-loader (match + load + merge)

**Files:**
- Create: `src/ai/hooks-loader.js`
- Create: `tests/hooks-loader.test.js`

**Interfaces:**
- Produces:
  - `matchTool(matcher: string, toolName: string): boolean`
  - `loadHooks({ userDataPath: string, projectPath?: string|null }): ResolvedHooks`
  - `HOOK_EVENTS: string[]` constant list of five event names
- `ResolvedHooks` shape:

```js
{
  userPath: string,
  projectPath: string | null,
  errors: string[],
  countsByEvent: { PreToolUse: number, PostToolUse: number, Stop: number, SessionStart: number, UserPromptSubmit: number },
  rulesByEvent: {
    PreToolUse: HookRule[],
    PostToolUse: HookRule[],
    Stop: HookRule[],
    SessionStart: HookRule[],
    UserPromptSubmit: HookRule[],
  },
}
// HookRule: { matcher, command, args: string[], timeoutMs, cwd, env?: object, source: 'user'|'project' }
```

- [ ] **Step 1: Write failing tests** `tests/hooks-loader.test.js`

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { matchTool, loadHooks, HOOK_EVENTS } = require('../src/ai/hooks-loader');

describe('matchTool', () => {
  it('matches * exact prefix and OR', () => {
    assert.equal(matchTool('*', 'write_file'), true);
    assert.equal(matchTool('write_file', 'write_file'), true);
    assert.equal(matchTool('write_file', 'read_file'), false);
    assert.equal(matchTool('mcp_*', 'mcp_srv_tool'), true);
    assert.equal(matchTool('mcp_*', 'write_file'), false);
    assert.equal(matchTool('write_file|search_replace', 'search_replace'), true);
    assert.equal(matchTool('write_file|search_replace', 'delete_path'), false);
  });
});

describe('loadHooks', () => {
  it('missing files → empty rules no throw', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-proj-'));
    const r = loadHooks({ userDataPath: user, projectPath: project });
    assert.equal(r.countsByEvent.PreToolUse, 0);
    assert.ok(Array.isArray(r.rulesByEvent.PreToolUse));
    assert.ok(HOOK_EVENTS.includes('PreToolUse'));
  });

  it('merges user then project', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-proj-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: '*', command: 'node', args: ['u.js'] }],
      },
    }));
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: 'write_file', command: 'node', args: ['p.js'] }],
      },
    }));
    const r = loadHooks({ userDataPath: user, projectPath: project });
    assert.equal(r.rulesByEvent.PreToolUse.length, 2);
    assert.equal(r.rulesByEvent.PreToolUse[0].source, 'user');
    assert.equal(r.rulesByEvent.PreToolUse[1].source, 'project');
    assert.equal(r.countsByEvent.PreToolUse, 2);
  });

  it('ignores bad version layer and records error', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 99,
      hooks: { PreToolUse: [{ matcher: '*', command: 'x' }] },
    }));
    const r = loadHooks({ userDataPath: user, projectPath: null });
    assert.equal(r.rulesByEvent.PreToolUse.length, 0);
    assert.ok(r.errors.length >= 1);
  });

  it('skips invalid rules missing command', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PostToolUse: [{ matcher: '*', command: '' }, { matcher: '*', command: 'node' }],
      },
    }));
    const r = loadHooks({ userDataPath: user });
    assert.equal(r.rulesByEvent.PostToolUse.length, 1);
    assert.equal(r.rulesByEvent.PostToolUse[0].command, 'node');
  });

  it('clamps timeoutMs', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        Stop: [{ matcher: '*', command: 'node', timeoutMs: 5 }],
      },
    }));
    const r = loadHooks({ userDataPath: user });
    assert.equal(r.rulesByEvent.Stop[0].timeoutMs, 1000);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/hooks-loader.test.js`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement** `src/ai/hooks-loader.js`

```js
'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionStart',
  'UserPromptSubmit',
];

const DEFAULT_TIMEOUT = 15000;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 120000;

function matchOne(pattern, toolName) {
  const p = String(pattern || '').trim();
  const name = String(toolName || '');
  if (!p || p === '*') return true;
  if (p.endsWith('*') && p.indexOf('*') === p.length - 1) {
    const prefix = p.slice(0, -1);
    return name.startsWith(prefix);
  }
  if (p.includes('*')) return false; // only trailing * supported
  return p === name;
}

function matchTool(matcher, toolName) {
  const raw = String(matcher == null ? '*' : matcher).trim() || '*';
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.some((part) => matchOne(part, toolName));
}

function emptyRulesByEvent() {
  const o = {};
  for (const e of HOOK_EVENTS) o[e] = [];
  return o;
}

function emptyCounts() {
  const o = {};
  for (const e of HOOK_EVENTS) o[e] = 0;
  return o;
}

function clampTimeout(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.floor(x)));
}

function normalizeRule(raw, source, errors) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`${source}: invalid rule`);
    return null;
  }
  const command = String(raw.command || '').trim();
  if (!command) {
    errors.push(`${source}: rule missing command`);
    return null;
  }
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const matcher = raw.matcher == null ? '*' : String(raw.matcher);
  let cwd = raw.cwd == null ? 'project' : String(raw.cwd);
  if (cwd !== 'project' && cwd !== 'userData') {
    // allow relative path under project only (resolved later)
    if (path.isAbsolute(cwd)) {
      errors.push(`${source}: absolute cwd not allowed: ${cwd}`);
      return null;
    }
  }
  const rule = {
    matcher,
    command,
    args,
    timeoutMs: clampTimeout(raw.timeoutMs),
    cwd,
    source,
  };
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    rule.env = { ...raw.env };
  }
  return rule;
}

function loadLayer(filePath, source, errors) {
  const byEvent = emptyRulesByEvent();
  if (!filePath || !fs.existsSync(filePath)) return byEvent;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    errors.push(`${source}: bad JSON (${err.message || err})`);
    return byEvent;
  }
  if (!parsed || typeof parsed !== 'object') {
    errors.push(`${source}: root must be object`);
    return byEvent;
  }
  if (parsed.version !== 1) {
    errors.push(`${source}: unsupported version ${parsed.version}`);
    return byEvent;
  }
  const hooks = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {};
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rule = normalizeRule(item, `${source}:${event}`, errors);
      if (rule) byEvent[event].push(rule);
    }
  }
  return byEvent;
}

function loadHooks({ userDataPath, projectPath } = {}) {
  const errors = [];
  const userPath = userDataPath ? path.join(userDataPath, 'hooks.json') : null;
  const projectHooksPath = projectPath
    ? path.join(projectPath, '.codex', 'hooks.json')
    : null;

  const userRules = userPath
    ? loadLayer(userPath, 'user', errors)
    : emptyRulesByEvent();
  const projectRules = projectHooksPath
    ? loadLayer(projectHooksPath, 'project', errors)
    : emptyRulesByEvent();

  const rulesByEvent = emptyRulesByEvent();
  const countsByEvent = emptyCounts();
  for (const event of HOOK_EVENTS) {
    rulesByEvent[event] = [
      ...userRules[event],
      ...projectRules[event],
    ];
    countsByEvent[event] = rulesByEvent[event].length;
  }

  return {
    userPath: userPath || '',
    projectPath: projectHooksPath,
    errors,
    countsByEvent,
    rulesByEvent,
  };
}

module.exports = {
  HOOK_EVENTS,
  matchTool,
  loadHooks,
  clampTimeout,
  DEFAULT_TIMEOUT,
};
```

- [ ] **Step 4: Run to pass**

Run: `node --test tests/hooks-loader.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/hooks-loader.js tests/hooks-loader.test.js
git commit -m "feat(codex-qq): Phase C.3 hooks-loader merge and matcher"
```

---

### Task 3: hooks-runner (spawn + Pre protocol)

**Files:**
- Create: `src/ai/hooks-runner.js`
- Create: `tests/hooks-runner.test.js`

**Interfaces:**
- Produces:

```js
function createHooksRunner(opts): {
  runLifecycle(event, extra?): Promise<void>,
  runPreToolUse({ name, args, risk }): Promise<PreResult>,
  runPostToolUse({ name, args, risk, result, flags }): Promise<void>,
  enabled: boolean,
}

// PreResult:
// { decision: 'allow'|'deny'|'skip', args: object, reason?: string, resultStr?: string, argsChanged: boolean }
```

- Consumes: `loadHooks` result as `opts.hooks`, `AGENT_EVENTS`, `matchTool`
- `opts`: `{ hooks, projectPath, userDataPath, settings, sessionKey, agentMode, subagentDepth, onEvent, signal, spawnFn? }`
- When `subagentDepth >= 1` or `settings.hooksEnabled === false` or no rules: methods no-op / Pre returns `{ decision:'allow', args, argsChanged:false }` without events

- [ ] **Step 1: Write failing tests** `tests/hooks-runner.test.js`

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadHooks } = require('../src/ai/hooks-loader');
const { createHooksRunner } = require('../src/ai/hooks-runner');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

function writeHooks(project, hooksObj) {
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.codex', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: hooksObj })
  );
}

function scriptCmd(jsBody) {
  // inline node -e for Windows-friendly single rule
  return {
    matcher: '*',
    command: process.execPath,
    args: ['-e', jsBody],
    timeoutMs: 10000,
  };
}

describe('hooks-runner PreToolUse', () => {
  it('allow with empty stdout exit 0', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, {
      PreToolUse: [scriptCmd('process.exit(0)')],
    });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const events = [];
    const runner = createHooksRunner({
      hooks,
      projectPath: project,
      userDataPath: user,
      settings: { hooksEnabled: true, permissionMode: 'full-auto' },
      sessionKey: 's1',
      agentMode: 'agent',
      subagentDepth: 0,
      onEvent: (e) => events.push(e),
    });
    const r = await runner.runPreToolUse({
      name: 'read_file',
      args: { path: 'a.js' },
      risk: 'read',
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.args.path, 'a.js');
    assert.ok(events.some((e) => e.type === AGENT_EVENTS.HOOK_START));
    assert.ok(events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.ok));
  });

  it('deny on exit non-zero', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, {
      PreToolUse: [scriptCmd('process.exit(2)')],
    });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks,
      projectPath: project,
      userDataPath: user,
      settings: { hooksEnabled: true },
      subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({ name: 'write_file', args: {}, risk: 'write' });
    assert.equal(r.decision, 'deny');
  });

  it('skip returns resultStr', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const body = `
      let s=''; process.stdin.on('data',d=>s+=d);
      process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({decision:'skip',result:{ok:true,skipped:true,by:'test'}}));
      });
    `;
    writeHooks(project, { PreToolUse: [scriptCmd(body)] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({ name: 'list_dir', args: {}, risk: 'read' });
    assert.equal(r.decision, 'skip');
    const parsed = JSON.parse(r.resultStr);
    assert.equal(parsed.skipped, true);
  });

  it('allow rewrites args', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const body = `
      let s=''; process.stdin.on('data',d=>s+=d);
      process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({decision:'allow',args:{path:'b.js'}}));
      });
    `;
    writeHooks(project, { PreToolUse: [scriptCmd(body)] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({
      name: 'read_file',
      args: { path: 'a.js', offset: 1 },
      risk: 'read',
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.args.path, 'b.js');
    assert.equal(r.args.offset, 1);
    assert.equal(r.argsChanged, true);
  });

  it('depth>=1 skips hooks', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, { PreToolUse: [scriptCmd('process.exit(2)')] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const events = [];
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 1,
      onEvent: (e) => events.push(e),
    });
    const r = await runner.runPreToolUse({ name: 'read_file', args: {}, risk: 'read' });
    assert.equal(r.decision, 'allow');
    assert.equal(events.length, 0);
  });

  it('lifecycle failure does not throw', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, { Stop: [scriptCmd('process.exit(1)')] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    await runner.runLifecycle('Stop', { reason: 'done' });
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/hooks-runner.test.js`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement** `src/ai/hooks-runner.js`

Core requirements (implement fully, not stubs):

1. **`createHooksRunner(opts)`**  
   - `active = settings.hooksEnabled !== false && (Number(subagentDepth)||0) === 0`  
   - If inactive: Pre always allow; lifecycle/post no-op.

2. **`resolveCwd(rule)`**  
   - `project` → `projectPath` (required; if missing, fail rule)  
   - `userData` → `userDataPath`  
   - else relative join under `projectPath`, then `fs.realpathSync` / resolve; if result is outside project root → fail rule.

3. **`buildEnv(rule)`**  
   - Copy safe subset of `process.env` (on Windows keep `PATH`, `SystemRoot`, `TEMP`, `LANG`, etc.; do not invent secrets).  
   - Merge `rule.env` but **drop** keys matching `/apikey|secret|token|password/i` and never copy `settings.apiKey`.  
   - Set `CODEX_QQ_EVENT`, `CODEX_QQ_PROJECT` (if any).

4. **`truncateForHook(value, …)`**  
   - Strings > 8192 → slice + `\n…[truncated]`  
   - Whole JSON payload max ~256 KiB: if `JSON.stringify` too big, replace large tool.args fields aggressively.

5. **`runOne(rule, event, payload)`**  
   - Emit `HOOK_START`  
   - `spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] })` — inject `spawnFn` in tests optional; default `require('child_process').spawn`  
   - Write stdin JSON; collect stdout/stderr  
   - Timeout via `setTimeout` → `child.kill()` → fail  
   - `signal` abort → kill → if Pre path, rethrow ABORTED with message `已停止`  
   - Emit `HOOK_END` with `ok`, `decision?`, `reason?`, `durationMs`

6. **`parsePreStdout(stdout, exitCode)`**  
   - exit≠0 → deny  
   - empty + 0 → allow  
   - JSON: decision allow|deny|skip; merge args on allow; resultStr on skip

7. **`runPreToolUse`**  
   - Filter rules with `matchTool(rule.matcher, name)`  
   - Serial; stop on deny/skip  
   - Track `argsChanged` if final args JSON !== initial

8. **`runPostToolUse` / `runLifecycle`**  
   - For lifecycle events, only run rules whose matcher is `*` or empty OR `matchTool` with toolName `''` treating non-tool as: **only `*` or omitted matcher matches** (implement helper `matchLifecycle(rule)` → matcher empty/`*`).  
   - Failures swallowed after hook-end.

9. **Stop abort timeout**  
   - If `signal?.aborted` or `extra.reason === 'aborted'`, clamp each rule timeout to `Math.min(rule.timeoutMs, 5000)`.

Skeleton entry (expand to full implementation matching tests):

```js
'use strict';

const { spawn: defaultSpawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { matchTool } = require('./hooks-loader');
const { AGENT_EVENTS } = require('./agent-events');
const { riskForTool } = require('./permission');

// ... helpers: truncateDeep, resolveCwd, buildEnv, makeAbortedError, runProcess ...

function createHooksRunner(opts = {}) {
  const {
    hooks,
    projectPath,
    userDataPath,
    settings = {},
    sessionKey,
    agentMode = 'agent',
    subagentDepth = 0,
    onEvent,
    signal,
    spawnFn = defaultSpawn,
  } = opts;

  const depth = Number(subagentDepth) || 0;
  const enabled = settings.hooksEnabled !== false && depth === 0 && hooks;

  function basePayload(event, extra = {}) {
    return {
      event,
      timestamp: new Date().toISOString(),
      sessionKey: sessionKey || null,
      agentMode,
      subagentDepth: depth,
      projectPath: projectPath || null,
      permissionMode: settings.permissionMode || 'confirm-writes',
      tool: extra.tool || null,
      result: extra.result != null ? truncateDeep(extra.result) : null,
      run: {
        aborting: !!(signal && signal.aborted),
        reason: extra.reason || null,
      },
      promptPreview: extra.promptPreview != null
        ? String(extra.promptPreview).slice(0, 2000)
        : null,
      flags: extra.flags || null,
    };
  }

  async function runPreToolUse({ name, args, risk }) {
    if (!enabled) {
      return { decision: 'allow', args: args || {}, argsChanged: false };
    }
    // ... serial rules, return PreResult
  }

  async function runPostToolUse(ctx) { /* ... */ }
  async function runLifecycle(event, extra = {}) { /* ... */ }

  return { enabled: !!enabled, runPreToolUse, runPostToolUse, runLifecycle };
}

module.exports = { createHooksRunner };
```

Implement `runProcess` carefully for Windows: use `process.execPath` in tests; kill with `child.kill()`; collect streams to string with max cap (e.g. 1 MiB).

- [ ] **Step 4: Run to pass**

Run: `node --test tests/hooks-runner.test.js`  
Expected: PASS  
If flaky on Windows quoting of `node -e`, switch tests to write a temp `.js` file and `command: process.execPath, args: [file]`.

- [ ] **Step 5: Commit**

```bash
git add src/ai/hooks-runner.js tests/hooks-runner.test.js
git commit -m "feat(codex-qq): Phase C.3 hooks-runner spawn and Pre protocol"
```

---

### Task 4: Agent lifecycle hooks (SessionStart / UserPromptSubmit / Stop)

**Files:**
- Modify: `src/ai/agent.js`
- Create: `tests/hooks-agent.test.js` (lifecycle cases first)

**Interfaces:**
- Consumes: `loadHooks`, `createHooksRunner`
- `runAgentLoop` options already include `extensions.userDataPath` from main (see `src/main.js` ~724)
- Produces: hooks fire at start/stop; `Stop` reason `done` | `aborted` | `error`

- [ ] **Step 1: Write failing tests** in `tests/hooks-agent.test.js`

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentLoop } = require('../src/ai/agent');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { createPermissionGate } = require('../src/ai/permission');

function setupProjectWithStopHook() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const hookJs = path.join(project, '.codex', 'stop-hook.js');
  fs.writeFileSync(hookJs, 'process.exit(0);\n');
  fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: {
      SessionStart: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
      UserPromptSubmit: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
      Stop: [{ matcher: '*', command: process.execPath, args: [hookJs], timeoutMs: 5000 }],
    },
  }));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"t"}');
  return { project, user };
}

describe('hooks agent lifecycle', () => {
  it('emits SessionStart UserPromptSubmit Stop on short local-like loop', async () => {
    const { project, user } = setupProjectWithStopHook();
    const events = [];
    // Force tools path with chatFn that returns plain text immediately (no tools)
    const gate = createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' });
    await runAgentLoop({
      project: { path: project, name: 't' },
      settings: {
        mode: 'api',
        agentEnabled: true,
        maxAgentTurns: 1,
        hooksEnabled: true,
        permissionMode: 'full-auto',
        model: 'test',
        apiKey: 'x',
        baseUrl: 'http://127.0.0.1:9/v1',
      },
      messages: [{ role: 'user', content: 'hello' }],
      gate,
      onEvent: (e) => events.push(e),
      sessionKey: 's',
      agentMode: 'agent',
      subagentDepth: 0,
      extensions: { userDataPath: user },
      chatFn: async () => ({ role: 'assistant', content: 'done', tool_calls: null }),
    });
    const types = events.map((e) => e.type);
    assert.ok(types.includes(AGENT_EVENTS.HOOK_START), 'expected hook-start');
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'SessionStart'),
      'SessionStart'
    );
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'UserPromptSubmit'),
      'UserPromptSubmit'
    );
    assert.ok(
      events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.event === 'Stop'),
      'Stop'
    );
  });
});
```

Note: `runAgentLoop` currently requires project path and uses chatFn if provided — verify existing `agent.test.js` patterns for `chatFn` and reuse them. If `chatFn` signature differs, match `agent.test.js` exactly.

- [ ] **Step 2: Run to fail**

Run: `node --test tests/hooks-agent.test.js`  
Expected: FAIL no hook events

- [ ] **Step 3: Wire lifecycle in `runAgentLoop`**

Near top of try after `registry.onRunStart(runCtx)`:

```js
const { loadHooks } = require('./hooks-loader');
const { createHooksRunner } = require('./hooks-runner');

const userDataPath = extensions.userDataPath || extensionsOpt?.userDataPath;
let hooksRunner = null;
let stopReason = 'done';

if (depth === 0 && settings.hooksEnabled !== false && userDataPath) {
  const resolved = loadHooks({ userDataPath, projectPath: project.path });
  hooksRunner = createHooksRunner({
    hooks: resolved,
    projectPath: project.path,
    userDataPath,
    settings,
    sessionKey,
    agentMode: mode,
    subagentDepth: depth,
    onEvent,
    signal,
  });
  await hooksRunner.runLifecycle('SessionStart');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  await hooksRunner.runLifecycle('UserPromptSubmit', {
    promptPreview: lastUser ? String(lastUser.content || '') : '',
  });
}
// stash on runCtx for tool path (Task 5)
runCtx.hooksRunner = hooksRunner;
```

In `finally` **before** `registry.onRunEnd`:

```js
} catch (err) {
  // if you structure with outer try/catch, set stopReason:
  // stopReason = (err.code==='ABORTED') ? 'aborted' : 'error'; throw err;
} finally {
  try {
    if (hooksRunner) {
      const reason = signal?.aborted ? 'aborted' : stopReason;
      await hooksRunner.runLifecycle('Stop', { reason });
    }
  } catch { /* never throw from Stop */ }
  await registry.onRunEnd(runCtx);
}
```

Prefer wrapping the main body so errors set `stopReason = 'error'` and rethrow; abort paths set `'aborted'`. Success leaves `'done'`.

Also re-export nothing new unless tests need it.

- [ ] **Step 4: Run to pass**

Run: `node --test tests/hooks-agent.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent.js tests/hooks-agent.test.js
git commit -m "feat(codex-qq): Phase C.3 agent SessionStart UserPromptSubmit Stop hooks"
```

---

### Task 5: Agent tool path (Gate₁ → Pre → Gate₂ → execute/skip → Post)

**Files:**
- Modify: `src/ai/agent.js` (tool execution block ~1280–1420)
- Modify: `tests/hooks-agent.test.js` (add tool-path cases)

**Interfaces:**
- After Gate₁ allow, call `hooksRunner.runPreToolUse`
- On deny: `resultStr = JSON.stringify({ ok:false, error: reason || '钩子拒绝' })`
- On skip: `resultStr = pre.resultStr`; do **not** update applied/fileChanges
- On allow + `argsChanged`: re-run authorize (Gate₂) with refreshed diff preview when mutating
- Always `runPostToolUse` when hooksRunner present (including gate deny), with flags

- [ ] **Step 1: Write failing tests**

```js
it('Pre deny blocks tool without execute', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-agent-'));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const denyJs = path.join(project, '.codex', 'deny.js');
  fs.writeFileSync(
    denyJs,
    `process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked-by-test'}));\n`
  );
  fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: {
      PreToolUse: [{
        matcher: 'write_file',
        command: process.execPath,
        args: [denyJs],
        timeoutMs: 5000,
      }],
    },
  }));
  fs.writeFileSync(path.join(project, 'package.json'), '{}');

  let executed = false;
  // Use chatFn that requests one write_file tool call then stops
  // Follow existing agent.test.js tool_calls fixture shape exactly.
  // Assert tool result error contains blocked-by-test and file not created.
});

it('skip cannot bypass Gate₁ read-only', async () => {
  // permissionMode read-only, Pre returns skip for write_file
  // Expect unauthorized result, not skipped success; no file written
});

it('Post runs after gate deny', async () => {
  // read-only gate + PostToolUse hook file touch marker
  // Assert marker file exists after run
});
```

Fill tool_calls fixtures by copying from `tests/agent.test.js` (search `tool_calls`). Keep tests deterministic with `chatFn` queue.

- [ ] **Step 2: Run to fail**

Run: `node --test tests/hooks-agent.test.js`  
Expected: FAIL on new cases

- [ ] **Step 3: Implement tool-path wrapping**

Refactor the per-tool block carefully:

```js
// After building name, args, risk, tool-start, and existing mutate preview + Gate₁:

let effectiveArgs = { ...args };
let hookFlags = {
  deniedByGate: false,
  deniedByHook: false,
  skipped: false,
};

// existing Gate₁ → if !authAllowed:
//   resultStr = ...
//   hookFlags.deniedByGate = true
// else if hooksRunner:
//   const pre = await hooksRunner.runPreToolUse({ name, args: effectiveArgs, risk })
//   if (pre.decision === 'deny') {
//     resultStr = JSON.stringify({ ok: false, error: pre.reason || '钩子拒绝' })
//     hookFlags.deniedByHook = true
//   } else if (pre.decision === 'skip') {
//     resultStr = pre.resultStr || JSON.stringify({ ok: true, skipped: true, by: 'hook' })
//     hookFlags.skipped = true
//     effectiveArgs = pre.args || effectiveArgs
//   } else {
//     effectiveArgs = pre.args || effectiveArgs
//     if (pre.argsChanged) {
//       // re-preview mutating tools if needed; Gate₂ authorizeTool with new args/diff
//       // if deny → resultStr unauthorized, deniedByGate=true
//     }
//     if (resultStr == null) {
//       // existing search_replace preview apply OR registry.execute(name, effectiveArgs, ...)
//       // IMPORTANT: if argsChanged and search_replace, do NOT use stale mutatePreview.after;
//       // recompute preview from effectiveArgs or execute via registry/searchReplace
//     }
//   }
// else {
//   // existing execute path unchanged
// }

// after resultStr finalized:
if (hooksRunner) {
  let parsedResult;
  try { parsedResult = JSON.parse(resultStr); } catch { parsedResult = { raw: resultStr }; }
  await hooksRunner.runPostToolUse({
    name,
    args: effectiveArgs,
    risk,
    result: parsedResult,
    flags: hookFlags,
  });
}
```

**Gate₂ detail:** If `argsChanged` and tool is in `MUTATING_TOOLS`, re-run `previewMutatingTool` + `buildDiffForAuthorize` + `authorizeTool` before write. If only non-mutating args change, Gate₂ with new detail/path is enough.

**search_replace + argsChanged:** discard old `mutatePreview`; either new preview+apply or `registry.execute`.

**skip:** skip `applied` / `fileChanges` pushes (guard existing `if (name === 'write_file' && parsed.ok)` with `&& !hookFlags.skipped`).

- [ ] **Step 4: Run to pass**

Run: `node --test tests/hooks-agent.test.js tests/agent.test.js`  
Expected: PASS (no regression)

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent.js tests/hooks-agent.test.js
git commit -m "feat(codex-qq): Phase C.3 Pre/Post tool hooks with Gate double-check"
```

---

### Task 6: main / preload / settings sanitize

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`

**Interfaces:**
- `toPublicSettings`: `hooksEnabled: s.hooksEnabled !== false`
- `settings:save` allowlist includes `hooksEnabled`
- `ipcMain.handle('hooks:summary', …)` → loadHooks + return summary fields
- preload: `hooksSummary: (payload) => ipcRenderer.invoke('hooks:summary', payload || {})`

- [ ] **Step 1: Implement main**

In `toPublicSettings`:

```js
hooksEnabled: s.hooksEnabled !== false,
```

In save allowlist array (near skillsEnabled): add `'hooksEnabled'`.

Add handler:

```js
const { loadHooks } = require('./ai/hooks-loader');

ipcMain.handle('hooks:summary', async (_e, payload = {}) => {
  const settings = loadSettings(userDataPath());
  const projectPath = payload.projectPath ? String(payload.projectPath) : null;
  const resolved = loadHooks({
    userDataPath: userDataPath(),
    projectPath,
  });
  return {
    enabled: settings.hooksEnabled !== false,
    userPath: resolved.userPath,
    projectPath: resolved.projectPath,
    countsByEvent: resolved.countsByEvent,
    errors: resolved.errors,
  };
});
```

- [ ] **Step 2: Implement preload**

```js
hooksSummary: (payload) => ipcRenderer.invoke('hooks:summary', payload || {}),
```

- [ ] **Step 3: Manual sanity (optional script)**

No unit test required for IPC; covered by settings default tests. If desired, tiny test of `loadHooks` summary shape already in loader tests.

- [ ] **Step 4: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(codex-qq): Phase C.3 hooks settings IPC and summary"
```

---

### Task 7: Renderer UI (toggle, summary, trajectory)

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`

**Interfaces:**
- Settings checkbox `set-hooks-enabled`
- Summary element `hooks-summary` filled on open settings / refresh button
- Chat event handler for `hook-start` / `hook-end`

- [ ] **Step 1: HTML** — in settings panel near MCP/skills blocks:

```html
<label class="row">
  <input type="checkbox" id="set-hooks-enabled" />
  启用 Hooks（项目 .codex/hooks.json + 用户 hooks.json）
</label>
<div class="hooks-summary" id="hooks-summary">Hooks 摘要：未加载</div>
<button type="button" id="btn-hooks-refresh" class="btn-small">刷新 Hooks</button>
```

- [ ] **Step 2: app.js settings bind**

Load:

```js
const he = document.getElementById('set-hooks-enabled');
if (he) he.checked = settings.hooksEnabled !== false;
```

Save partial:

```js
hooksEnabled: document.getElementById('set-hooks-enabled')?.checked !== false,
```

Refresh helper:

```js
async function refreshHooksSummary() {
  const el = document.getElementById('hooks-summary');
  if (!el || !window.codex?.hooksSummary) return;
  const projectPath = /* current project path if any */ getActiveProjectPath?.() || null;
  try {
    const s = await window.codex.hooksSummary({ projectPath });
    const c = s.countsByEvent || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    el.textContent = s.enabled
      ? `Hooks 已启用 · 共 ${total} 条（用户 ${s.userPath || '-'} / 项目 ${s.projectPath || '无'}）`
      : 'Hooks 已关闭';
    if (s.errors?.length) el.textContent += ` · 警告: ${s.errors[0]}`;
  } catch {
    el.textContent = 'Hooks 摘要加载失败';
  }
}
```

Call on settings open + button click.

- [ ] **Step 3: Trajectory** — near `tool-start` / `subagent-start` handlers:

```js
if (type === 'hook-start') {
  appendAgentTraceLine(`🪝 钩子 ${data.event || ''}${data.toolName ? ' · ' + data.toolName : ''} 开始`);
  return;
}
if (type === 'hook-end') {
  const bit = data.ok === false ? '失败' : (data.decision === 'deny' ? '拒绝' : data.decision === 'skip' || data.skipped ? '短路' : '完成');
  appendAgentTraceLine(`🪝 钩子 ${data.event || ''} ${bit}${data.reason ? '：' + data.reason : ''}`);
  return;
}
```

Use the same helper that renders tool trajectory lines in existing code (name may differ — grep `tool-start` in `app.js` and mirror style).

- [ ] **Step 4: CSS** — minimal:

```css
.hooks-summary {
  font-size: 12px;
  color: #333;
  margin: 4px 0 8px;
  line-height: 1.4;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(codex-qq): Phase C.3 hooks settings UI and trajectory"
```

---

### Task 8: README + full test suite

**Files:**
- Modify: `README.md`
- Verify: all tests

- [ ] **Step 1: README section** after Phase C.2:

```markdown
## Phase C.3：Hooks（配置驱动生命周期）

在 Agent 主 run 上挂载外部命令钩子（不改工具源码）。

### 开关与配置

| 项 | 说明 |
|----|------|
| 设置 `hooksEnabled` | 默认开；关闭则完全不加载/不执行 |
| 用户配置 | `{userData}/hooks.json` |
| 项目配置 | `{project}/.codex/hooks.json` |
| 合并 | 同一事件下 **用户规则在前、项目在后**，串行执行 |

### 事件

| 事件 | 时机 |
|------|------|
| `SessionStart` | 主 run 开始（registry onRunStart 之后） |
| `UserPromptSubmit` | 首次模型请求前 |
| `PreToolUse` | Gate 通过后、工具执行前（可 allow/deny/改参/skip） |
| `PostToolUse` | 工具有结果后（含拒绝/短路） |
| `Stop` | run 结束（done/aborted/error），onRunEnd 之前 |

### Pre 与权限

顺序：**Gate₁ → Pre →（改参则 Gate₂）→ 执行或短路 → Post**。  
`skip` **不能**绕过 Gate₁。Pre 失败/超时/非 JSON/非 0 退出 ⇒ **拒绝工具**。  
`subagentDepth >= 1`（explore）不跑 Hooks。

### 示例 `.codex/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_terminal",
        "command": "node",
        "args": [".codex/scripts/check-terminal.js"],
        "timeoutMs": 5000
      }
    ],
    "PostToolUse": [],
    "Stop": [],
    "SessionStart": [],
    "UserPromptSubmit": []
  }
}
```

命令通过 stdin 接收 JSON，Pre 向 stdout 写 `{"decision":"allow"}` / `deny` / `skip`。
```

- [ ] **Step 2: Full test**

Run: `npm test`  
Expected: all pass (190 + new tests), fail 0

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(codex-qq): Phase C.3 Hooks usage in README"
```

- [ ] **Step 4: Final status**

```bash
git status -sb
git log --oneline -12
```

---

## Self-Review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| hooks-loader user+project merge | Task 2 |
| matcher `*` / exact / `mcp_*` / OR | Task 2 |
| hooks-runner spawn shell:false | Task 3 |
| Pre allow/deny/skip/args rewrite | Task 3 |
| Pre fail = deny; other fail soft | Task 3 |
| SessionStart / UserPromptSubmit / Stop | Task 4 |
| Gate₁ → Pre → Gate₂ → exec/skip → Post | Task 5 |
| skip no applied/fileChanges; no verify cheat | Task 5 |
| depth≥1 no hooks | Task 3 + 5 |
| hooksEnabled + summary IPC | Task 1 + 6 |
| UI toggle + trajectory | Task 7 |
| README | Task 8 |
| no new deps / no JS module hooks / no GUI editor | Global constraints |

**Placeholder scan:** none intentional; Task 5 tests require copying `tool_calls` fixture from `tests/agent.test.js` at implementation time (file lines may shift — open that file, do not invent OpenAI shapes).

**Type consistency:** `createHooksRunner` / `runPreToolUse` / `runPostToolUse` / `runLifecycle` / `loadHooks` / `matchTool` names stable across tasks.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-phase-c3-hooks.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — same session with executing-plans and checkpoints  

Which approach?
