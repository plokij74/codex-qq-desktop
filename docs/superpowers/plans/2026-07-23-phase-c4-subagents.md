# Phase C.4 Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 implement 子 Agent、有限并行 explore（含 `spawn_explores`）、主轨迹可展开 transcript；无 worktree、无新 npm 依赖。

**Architecture:** 共享 `subagent-runtime`（explore 信号量 + implement 互斥 + 嵌套 `runLoop` + 事件规范化）；`exploreProvider` 增强并新增批量工具；新建 `implementProvider`；`builtin` 按 `subagentKind` 裁剪；renderer 按 `subagentId` 归桶可展开块。

**Tech Stack:** Electron 33、Node CommonJS、`node:test`、无新依赖。

## Global Constraints

- 无新 npm 依赖（纯 Node CommonJS）
- 用户可见文案 **zh-CN**
- `subagentDepth >= 1` 不跑 hooks（C.3 已保证）；子 settings 再关 `hooksEnabled` / `subagentEnabled` / skills / mcp
- implement 工具白名单：只读集 + `write_file` + `search_replace` only
- implement 与父 **共用** PermissionGate / session allow；`spawn_implement` risk=`write`
- explore 默认可并行上限 **2**（clamp **1..3**）；implement **串行**
- depth 固定 **≤ 1**；子内禁止一切 spawn
- 无 worktree 实现；`isolation` 若传入则忽略当 none
- `spawn_explore` 对外签名兼容 C.2
- plan 模式隐藏 `spawn_explore` / `spawn_explores` / `spawn_implement`
- `npm test` 全绿

**Spec:** `docs/superpowers/specs/2026-07-23-phase-c4-subagents-design.md`

---

## File map

| 路径 | 动作 | 职责 |
|------|------|------|
| `src/ai/settings.js` | Modify | `exploreMaxParallel` 默认 2；load 时 clamp |
| `src/ai/subagent-runtime.js` | Create | 池、互斥、id、runChild、裁剪结果 |
| `src/ai/providers/explore.js` | Modify | 走 runtime；`spawn_explores`；事件字段 |
| `src/ai/providers/implement.js` | Create | `spawn_implement` |
| `src/ai/providers/index.js` | Modify | 注册 implement |
| `src/ai/providers/builtin.js` | Modify | `IMPLEMENT_TOOLS` + kind 过滤 |
| `src/ai/agent.js` | Modify | system prompt 分 kind；主提示；fileChanges 合并（子 end 事件或返回值路径） |
| `src/ai/agent-mode.js` | Modify | PLAN_HIDDEN 新工具 |
| `src/ai/permission.js` | Modify | READ_TOOLS / risk |
| `src/main.js` | Modify | 透传 `exploreMaxParallel`（若已有白名单字段列表） |
| `src/renderer/index.html` | Modify | 设置文案 + parallel 输入 |
| `src/renderer/app.js` | Modify | 可展开块；设置读写 |
| `src/renderer/styles.css` | Modify | 展开块样式 |
| `README.md` | Modify | Phase C.4 节 |
| `tests/settings.test.js` | Modify | exploreMaxParallel |
| `tests/subagent-runtime.test.js` | Create | 池/互斥/abort |
| `tests/explore.test.js` | Modify | 字段 + batch |
| `tests/implement.test.js` | Create | implement 行为 |
| `tests/permission.test.js` | Modify | risk |
| `tests/agent-mode.test.js` | Modify | plan 隐藏 |
| `tests/builtin-subagent.test.js` | Create | 或并入 implement：kind 过滤 |

---

### Task 1: settings — exploreMaxParallel

**Files:**
- Modify: `src/ai/settings.js`
- Modify: `tests/settings.test.js`
- Modify: `src/main.js`（若 save/load 白名单需显式字段）

**Interfaces:**
- Produces: `DEFAULT_SETTINGS.exploreMaxParallel === 2`；`loadSettings` 将非法值 clamp 到 1..3

- [ ] **Step 1: 写失败测试**

在 `tests/settings.test.js` 追加：

```js
it('defaults Phase C.4 exploreMaxParallel', () => {
  const { DEFAULT_SETTINGS, loadSettings, saveSettings } = require('../src/ai/settings');
  assert.equal(DEFAULT_SETTINGS.exploreMaxParallel, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  assert.equal(loadSettings(dir).exploreMaxParallel, 2);
  saveSettings(dir, { exploreMaxParallel: 99 });
  assert.equal(loadSettings(dir).exploreMaxParallel, 3);
  saveSettings(dir, { exploreMaxParallel: 0 });
  assert.equal(loadSettings(dir).exploreMaxParallel, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/settings.test.js`  
Expected: FAIL — `exploreMaxParallel` undefined 或未 clamp

- [ ] **Step 3: 最小实现**

`src/ai/settings.js`：

```js
// DEFAULT_SETTINGS 增加
exploreMaxParallel: 2, // Phase C.4; clamp 1..3 on load

function clampExploreMaxParallel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    merged.exploreMaxParallel = clampExploreMaxParallel(merged.exploreMaxParallel);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
  next.exploreMaxParallel = clampExploreMaxParallel(next.exploreMaxParallel);
  // ... rest unchanged
}
```

若 `src/main.js` 有 settings 字段白名单数组，加入 `'exploreMaxParallel'`。

- [ ] **Step 4: 测试通过**

Run: `node --test tests/settings.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/settings.js tests/settings.test.js src/main.js
git commit -m "feat(codex-qq): Phase C.4 exploreMaxParallel setting"
```

---

### Task 2: subagent-runtime

**Files:**
- Create: `src/ai/subagent-runtime.js`
- Create: `tests/subagent-runtime.test.js`

**Interfaces:**
- Produces:
  - `createSubagentRuntime()` → `{ runExplore(ctx, opts), runExplores(ctx, opts), runImplement(ctx, opts) }`
  - `opts`: `{ goal|goals, maxTurns? }`
  - 返回 plain object（非 JSON 字符串）；provider 负责 `JSON.stringify`
  - 事件：`subagent-start` / `subagent-end` 含 `subagentId`, `kind`, `goal`, `maxTurns`, `durationMs`, `ok`, …
  - 子 `onEvent` 转发：附加 `subagent: true`, `subagentId`, `kind`

- [ ] **Step 1: 写失败测试**

`tests/subagent-runtime.test.js`：

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSubagentRuntime } = require('../src/ai/subagent-runtime');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeCtx(overrides = {}) {
  const events = [];
  return {
    events,
    ctx: {
      subagentDepth: 0,
      settings: { subagentEnabled: true, exploreMaxParallel: 2, maxAgentTurns: 8 },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: {},
      sessionKey: 's1',
      signal: overrides.signal,
      onEvent: (e) => events.push(e),
      extensions: { mcpHub: { x: 1 }, keep: true },
      registry: {},
      ...overrides.ctx,
    },
  };
}

describe('subagent-runtime', () => {
  it('runExplore sets depth 1, kind explore, strips mcpHub, emits start/end', async () => {
    let seen;
    const rt = createSubagentRuntime({
      runLoop: async (opts) => {
        seen = opts;
        return { content: 'sum', turns: 1, agentLog: [{ tool: 'grep', ok: true, summary: 'ok' }], fileChanges: [] };
      },
    });
    const { ctx, events } = makeCtx();
    const out = await rt.runExplore(ctx, { goal: 'find auth module', maxTurns: 3 });
    assert.equal(out.ok, true);
    assert.equal(out.kind, 'explore');
    assert.ok(String(out.subagentId).startsWith('sa_'));
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.subagentKind, 'explore');
    assert.equal(seen.settings.maxAgentTurns, 3);
    assert.equal(seen.extensions.mcpHub, undefined);
    assert.equal(seen.extensions.keep, true);
    assert.ok(events.some((e) => e.type === 'subagent-start' && e.kind === 'explore'));
    assert.ok(events.some((e) => e.type === 'subagent-end' && e.ok === true));
  });

  it('limits explore concurrency to exploreMaxParallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(40);
        concurrent -= 1;
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx();
    ctx.settings.exploreMaxParallel = 2;
    await Promise.all([
      rt.runExplore(ctx, { goal: 'goal one xx' }),
      rt.runExplore(ctx, { goal: 'goal two xx' }),
      rt.runExplore(ctx, { goal: 'goal three x' }),
    ]);
    assert.equal(maxConcurrent, 2);
  });

  it('serializes implement runs', async () => {
    const order = [];
    const rt = createSubagentRuntime({
      runLoop: async (opts) => {
        order.push('start:' + opts.messages[0].content.slice(0, 8));
        await sleep(30);
        order.push('end:' + opts.messages[0].content.slice(0, 8));
        return { content: 'done', turns: 1, agentLog: [], fileChanges: [{ path: 'a.js', op: 'write' }] };
      },
    });
    const { ctx } = makeCtx();
    await Promise.all([
      rt.runImplement(ctx, { goal: 'task AAA implement' }),
      rt.runImplement(ctx, { goal: 'task BBB implement' }),
    ]);
    // No interleaving of two implements
    assert.deepEqual(order, [
      'start:task AAA',
      'end:task AAA',
      'start:task BBB',
      'end:task BBB',
    ]);
  });

  it('runExplores preserves goal order and sets parallel', async () => {
    const rt = createSubagentRuntime({
      runLoop: async (opts) => ({
        content: 's:' + opts.messages[0].content,
        turns: 1,
        agentLog: [],
      }),
    });
    const { ctx } = makeCtx();
    const out = await rt.runExplores(ctx, {
      goals: ['goal alpha here', 'goal beta here'],
      maxTurns: 2,
    });
    assert.equal(out.parallel, true);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].ok, true);
    assert.match(out.results[0].summary, /alpha/);
    assert.match(out.results[1].summary, /beta/);
    assert.equal(out.ok, true);
  });

  it('rejects short goal', async () => {
    const rt = createSubagentRuntime({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [] }),
    });
    const { ctx } = makeCtx();
    const out = await rt.runExplore(ctx, { goal: 'ab' });
    assert.equal(out.ok, false);
  });

  it('aborts queued explore when signal aborted', async () => {
    const ac = new AbortController();
    let started = 0;
    const rt = createSubagentRuntime({
      runLoop: async () => {
        started += 1;
        await sleep(80);
        return { content: 'x', turns: 1, agentLog: [] };
      },
    });
    const { ctx } = makeCtx({ signal: ac.signal });
    ctx.settings.exploreMaxParallel = 1;
    const p1 = rt.runExplore(ctx, { goal: 'first goal xx' });
    const p2 = rt.runExplore(ctx, { goal: 'second goal x' });
    await sleep(10);
    ac.abort();
    const results = await Promise.allSettled([p1, p2]);
    // At least one should reject with ABORTED or return ok:false with abort semantics.
    // Runtime should throw ABORTED for consistency with agent loop when aborted mid-flight.
    const aborted = results.some(
      (r) => r.status === 'rejected' && (r.reason?.code === 'ABORTED' || /停止|abort/i.test(String(r.reason?.message || r.reason)))
    );
    assert.ok(aborted || results.some((r) => r.status === 'fulfilled' && r.value?.ok === false));
    assert.ok(started <= 2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/subagent-runtime.test.js`  
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/ai/subagent-runtime.js`**

```js
'use strict';

const { AGENT_EVENTS } = require('./agent-events');

const SUMMARY_MAX = 8 * 1024;
const GOALS_MAX = 6;
const LOG_MAX_ITEMS = 20;
const LOG_SUMMARY_MAX = 200;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function makeAbortedError() {
  const err = new Error('已停止');
  err.code = 'ABORTED';
  return err;
}

function createSubagentRuntime({ runLoop } = {}) {
  if (typeof runLoop !== 'function') {
    throw new Error('createSubagentRuntime requires runLoop');
  }

  let idSeq = 0;
  function nextId() {
    idSeq += 1;
    return `sa_${idSeq.toString(36)}_${Date.now().toString(36).slice(-4)}`;
  }

  /** @type {Map<object, { active: number, wait: Array<() => void> }>} */
  const explorePools = new Map();
  /** @type {Map<object, Promise<void>>} */
  const implementTails = new Map();

  function poolKey(ctx) {
    return ctx; // per parent ctx object identity for this run
  }

  function getExplorePool(ctx) {
    const key = poolKey(ctx);
    let p = explorePools.get(key);
    if (!p) {
      p = { active: 0, wait: [] };
      explorePools.set(key, p);
    }
    return p;
  }

  function exploreLimit(ctx) {
    return clampInt(ctx?.settings?.exploreMaxParallel, 1, 3, 2);
  }

  async function acquireExplore(ctx) {
    const pool = getExplorePool(ctx);
    const limit = exploreLimit(ctx);
    if (pool.active < limit) {
      pool.active += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = () => resolve();
      entry.reject = reject;
      pool.wait.push(entry);
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          pool.wait = pool.wait.filter((x) => x !== entry);
          reject(makeAbortedError());
          return;
        }
        const onAbort = () => {
          pool.wait = pool.wait.filter((x) => x !== entry);
          reject(makeAbortedError());
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    pool.active += 1;
  }

  function releaseExplore(ctx) {
    const pool = getExplorePool(ctx);
    pool.active = Math.max(0, pool.active - 1);
    const next = pool.wait.shift();
    if (next) next();
  }

  async function withImplementLock(ctx, fn) {
    const key = poolKey(ctx);
    const prev = implementTails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate, () => gate);
    implementTails.set(key, tail);
    await prev.catch(() => {});
    if (ctx.signal?.aborted) {
      release();
      throw makeAbortedError();
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function normalizeGoal(goal) {
    return String(goal || '').trim();
  }

  function clampMaxTurns(kind, raw) {
    if (kind === 'implement') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return 6;
      return clampInt(n, 1, 12, 6);
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return 4;
    return clampInt(n, 1, 8, 4);
  }

  function slimLog(agentLog) {
    if (!Array.isArray(agentLog)) return [];
    return agentLog.slice(0, LOG_MAX_ITEMS).map((x) => ({
      tool: x.tool,
      ok: x.ok,
      summary: String(x.summary || '').slice(0, LOG_SUMMARY_MAX),
    }));
  }

  function childSettings(parentSettings, maxTurns) {
    return {
      ...parentSettings,
      maxAgentTurns: maxTurns,
      skillsEnabled: false,
      mcpEnabled: false,
      subagentEnabled: false,
      verifyBeforeDone: false,
      hooksEnabled: false,
    };
  }

  function childExtensions(parentExt) {
    const childExt = { ...(parentExt || {}) };
    delete childExt.mcpHub;
    delete childExt.subagentRuntime;
    return childExt;
  }

  async function runChild(ctx, { kind, goal, maxTurns, batchId }) {
    if (Number(ctx.subagentDepth) >= 1) {
      return { ok: false, kind, error: '子 Agent 内禁止再次 spawn' };
    }
    const g = normalizeGoal(goal);
    if (g.length < 4) {
      return { ok: false, kind, error: 'goal 过短（至少 4 个字符）' };
    }
    const turns = clampMaxTurns(kind, maxTurns);
    const subagentId = nextId();
    const t0 = Date.now();

    if (ctx.signal?.aborted) throw makeAbortedError();

    ctx.onEvent?.({
      type: AGENT_EVENTS.SUBAGENT_START,
      subagentId,
      kind,
      goal: g,
      maxTurns: turns,
      ...(batchId ? { batchId } : {}),
    });

    try {
      const result = await runLoop({
        project: ctx.project,
        settings: childSettings(ctx.settings, turns),
        messages: [{ role: 'user', content: g }],
        gate: ctx.gate,
        onEvent: (ev) => {
          if (ev && typeof ev === 'object') {
            ctx.onEvent?.({ ...ev, subagent: true, subagentId, kind });
          }
        },
        signal: ctx.signal,
        sessionKey: ctx.sessionKey,
        agentMode: 'agent',
        subagentDepth: 1,
        subagentKind: kind,
        registry: ctx.registry,
        extensions: childExtensions(ctx.extensions),
      });

      const summary = String(result.content || '').slice(0, SUMMARY_MAX);
      const fileChanges = Array.isArray(result.fileChanges)
        ? result.fileChanges.map((fc) => ({
          path: fc.path,
          op: fc.op,
          stats: fc.stats,
        }))
        : [];
      const out = {
        ok: true,
        kind,
        subagentId,
        summary,
        turns: result.turns,
        agentLog: slimLog(result.agentLog),
      };
      if (kind === 'implement') out.fileChanges = fileChanges;

      ctx.onEvent?.({
        type: AGENT_EVENTS.SUBAGENT_END,
        subagentId,
        kind,
        ok: true,
        summary,
        durationMs: Date.now() - t0,
        fileChangeCount: fileChanges.length,
        ...(batchId ? { batchId } : {}),
        ...(kind === 'implement' && fileChanges.length ? { fileChanges } : {}),
      });
      return out;
    } catch (err) {
      const msg = err?.message || String(err);
      ctx.onEvent?.({
        type: AGENT_EVENTS.SUBAGENT_END,
        subagentId,
        kind,
        ok: false,
        error: msg,
        durationMs: Date.now() - t0,
        ...(batchId ? { batchId } : {}),
      });
      if (err?.code === 'ABORTED') throw err;
      return { ok: false, kind, subagentId, error: msg };
    }
  }

  async function runExplore(ctx, { goal, maxTurns, batchId } = {}) {
    await acquireExplore(ctx);
    try {
      return await runChild(ctx, { kind: 'explore', goal, maxTurns, batchId });
    } finally {
      releaseExplore(ctx);
    }
  }

  async function runImplement(ctx, { goal, maxTurns } = {}) {
    return withImplementLock(ctx, () => runChild(ctx, { kind: 'implement', goal, maxTurns }));
  }

  async function runExplores(ctx, { goals, maxTurns } = {}) {
    if (!Array.isArray(goals)) {
      return { ok: false, error: 'goals 必须为数组', results: [] };
    }
    const normalized = goals.map((g) => normalizeGoal(g)).filter((g) => g.length > 0);
    if (normalized.length === 0) {
      return { ok: false, error: 'goals 为空或全非法', results: [] };
    }
    let truncated = false;
    let list = normalized;
    if (list.length > GOALS_MAX) {
      list = list.slice(0, GOALS_MAX);
      truncated = true;
    }
    const batchId = `batch_${nextId()}`;
    const results = await Promise.all(
      list.map((goal) => runExplore(ctx, { goal, maxTurns, batchId }))
    );
    return {
      ok: results.every((r) => r && r.ok),
      parallel: true,
      results,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  return { runExplore, runExplores, runImplement };
}

module.exports = { createSubagentRuntime };
```

注意：若 implement 串行测试因 goal 截断 `slice(0,8)` 与中文/空格不一致，按实际 `messages[0].content` 调整断言；保持「不交错」语义。

- [ ] **Step 4: 测试通过**

Run: `node --test tests/subagent-runtime.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/subagent-runtime.js tests/subagent-runtime.test.js
git commit -m "feat(codex-qq): Phase C.4 subagent-runtime pool and mutex"
```

---

### Task 3: builtin kind 过滤 + permission + agent-mode + system prompt

**Files:**
- Modify: `src/ai/providers/builtin.js`
- Modify: `src/ai/permission.js`
- Modify: `src/ai/agent-mode.js`
- Modify: `src/ai/agent.js`（`agentSystemPrompt` + 收集 tools 时传 `subagentKind`）
- Modify: `tests/permission.test.js`
- Modify: `tests/agent-mode.test.js`
- Create: `tests/builtin-subagent.test.js`（或并入现有）

**Interfaces:**
- Consumes: `ctx.subagentDepth`, `ctx.subagentKind`
- Produces: depth≥1 + kind=implement → `IMPLEMENT_TOOLS`；否则 explore 只读集
- `riskForTool('spawn_implement') === 'write'`；`spawn_explores` → read
- plan 隐藏三个 spawn 工具
- `runAgentLoop` 把 `subagentKind` 放进 runCtx 并传给 `agentSystemPrompt`

- [ ] **Step 1: 写失败测试**

`tests/builtin-subagent.test.js`：

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBuiltinProvider, EXPLORE_READONLY, IMPLEMENT_TOOLS } = require('../src/ai/providers/builtin');

describe('builtin subagent tool filter', () => {
  const allDefs = [
    'list_dir', 'read_file', 'grep', 'glob', 'git_status', 'git_diff',
    'write_file', 'search_replace', 'delete_path', 'run_terminal', 'git_commit', 'submit_plan',
  ].map((name) => ({ type: 'function', function: { name } }));

  function names(defs) {
    return defs.map((t) => t.function.name).sort();
  }

  it('exports IMPLEMENT_TOOLS including writes', () => {
    assert.ok(IMPLEMENT_TOOLS.has('write_file'));
    assert.ok(IMPLEMENT_TOOLS.has('search_replace'));
    assert.ok(!IMPLEMENT_TOOLS.has('run_terminal'));
    assert.ok(!IMPLEMENT_TOOLS.has('delete_path'));
  });

  it('explore depth filters to readonly', () => {
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async () => '{}',
    });
    const tools = p.getTools({
      subagentDepth: 1,
      subagentKind: 'explore',
      settings: { terminalEnabled: true },
    });
    assert.deepEqual(names(tools), [...EXPLORE_READONLY].sort());
  });

  it('implement depth allows write_file and search_replace', () => {
    const p = createBuiltinProvider({
      getToolDefs: () => allDefs,
      executeTool: async () => '{}',
    });
    const tools = p.getTools({
      subagentDepth: 1,
      subagentKind: 'implement',
      settings: { terminalEnabled: true },
    });
    const set = new Set(names(tools));
    assert.ok(set.has('write_file'));
    assert.ok(set.has('search_replace'));
    assert.ok(set.has('read_file'));
    assert.ok(!set.has('run_terminal'));
    assert.ok(!set.has('delete_path'));
    assert.ok(!set.has('git_commit'));
  });
});
```

`tests/permission.test.js` 追加（按文件既有风格 require）：

```js
it('spawn_implement is write risk; spawn_explores is read', () => {
  const { riskForTool } = require('../src/ai/permission');
  assert.equal(riskForTool('spawn_implement'), 'write');
  assert.equal(riskForTool('spawn_explores'), 'read');
  assert.equal(riskForTool('spawn_explore'), 'read');
});
```

若 `riskForTool` 未导出，改为导出或测 `READ_TOOLS`/`WRITE` 行为（`createPermissionGate` authorize mock）。**优先导出 `riskForTool`**（已存在于 module 内部则加入 `module.exports`）。

`tests/agent-mode.test.js` 追加：

```js
it('plan mode hides spawn_implement and spawn_explores', () => {
  const { filterToolsForMode } = require('../src/ai/agent-mode');
  const defs = ['spawn_explore', 'spawn_explores', 'spawn_implement', 'read_file'].map((name) => ({
    type: 'function',
    function: { name },
  }));
  const plan = filterToolsForMode(defs, 'plan');
  const names = plan.map((t) => t.function.name);
  assert.deepEqual(names, ['read_file']);
});
```

可选 system prompt 测：若已有 agent 测，断言 depth=1 kind=implement 的 system **不含**「只读调研子 Agent（explore）」而含 implement 要点。可在 Task 5 一并测。

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/builtin-subagent.test.js tests/permission.test.js tests/agent-mode.test.js`  
Expected: FAIL on new asserts

- [ ] **Step 3: 实现**

**builtin.js：**

```js
const EXPLORE_READONLY = new Set([/* unchanged */]);

const IMPLEMENT_TOOLS = new Set([
  ...EXPLORE_READONLY,
  'write_file',
  'search_replace',
]);

// getTools:
if (Number(ctx?.subagentDepth) >= 1 || ctx?.exploreReadonly) {
  const kind = ctx?.subagentKind === 'implement' ? 'implement' : 'explore';
  const allow = kind === 'implement' ? IMPLEMENT_TOOLS : EXPLORE_READONLY;
  defs = defs.filter((t) => allow.has(t.function.name));
}

module.exports = { createBuiltinProvider, EXPLORE_READONLY, IMPLEMENT_TOOLS };
```

**permission.js：**

```js
const READ_TOOLS = new Set([
  'list_dir', 'read_file', 'grep', 'glob',
  'git_status', 'git_diff',
  'submit_plan',
  'list_skills', 'use_skill', 'spawn_explore', 'spawn_explores',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'search_replace', 'git_commit', 'spawn_implement',
]);
// ensure riskForTool exported if tests need it
```

**agent-mode.js：**

```js
const PLAN_HIDDEN_TOOLS = new Set([
  'search_replace',
  'write_file',
  'delete_path',
  'git_commit',
  'run_terminal',
  'spawn_explore',
  'spawn_explores',
  'spawn_implement',
]);
```

**agent.js `agentSystemPrompt`：**

```js
function agentSystemPrompt(project, settings, opts = {}) {
  const depth = Number(opts.subagentDepth) || 0;
  const kind = opts.subagentKind === 'implement' ? 'implement' : 'explore';
  // ...
  if (depth >= 1) {
    if (kind === 'implement') {
      return buildImplementSubagentPrompt(project); // 中文：可 write_file/search_replace；禁删/终端/commit/spawn；优先 search_replace；总结改动路径
    }
    return buildExploreSubagentPrompt(project); // 抽出原 explore 只读文案
  }
  // 主 agent 段：
  if (settings?.subagentEnabled !== false && mode === 'agent') {
    parts.push('');
    parts.push('【子 Agent】复杂调研：spawn_explore / spawn_explores（可并行只读）；委派改文件：spawn_implement（仅 write_file/search_replace，无终端/提交）；子 Agent 不能再 spawn；验证由你负责。');
  }
}
```

**agent.js runAgentLoop：** 解构 `subagentKind`，写入 `runCtx.subagentKind`，调用 `agentSystemPrompt(..., { subagentDepth: depth, subagentKind, ... })`。  
`collectTools` / 内部 ctx 构造同样带上 `subagentKind`。

- [ ] **Step 4: 测试通过**

Run: `node --test tests/builtin-subagent.test.js tests/permission.test.js tests/agent-mode.test.js tests/settings.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/builtin.js src/ai/permission.js src/ai/agent-mode.js src/ai/agent.js tests/
git commit -m "feat(codex-qq): Phase C.4 subagent kind tool filter and prompts"
```

---

### Task 4: explore provider — runtime + spawn_explores

**Files:**
- Modify: `src/ai/providers/explore.js`
- Modify: `src/ai/providers/index.js`（若需注入 runtime 工厂）
- Modify: `tests/explore.test.js`

**Interfaces:**
- Consumes: `createSubagentRuntime` 或 `ctx.extensions.subagentRuntime`
- Produces: tools `spawn_explore` + `spawn_explores`；execute 返回 JSON 字符串

**推荐：** provider 构造时注入 `runLoop`；**每次 execute** 使用 `ctx.extensions.subagentRuntime`，若无则 `createSubagentRuntime({ runLoop })` 并挂到 `ctx.extensions`（保证同 run 共享池）。  
主 loop 也可在 depth=0 启动时预创建 runtime（Task 5/6 可做）；本任务 provider 自愈即可。

- [ ] **Step 1: 扩展测试**

```js
it('spawn_explores returns ordered results', async () => {
  const p = createExploreProvider({
    runLoop: async (opts) => ({
      content: 'out:' + opts.messages[0].content,
      turns: 1,
      agentLog: [],
    }),
  });
  const raw = await p.execute('spawn_explores', {
    goals: ['goal one value', 'goal two value'],
  }, {
    subagentDepth: 0,
    settings: { subagentEnabled: true, exploreMaxParallel: 2 },
    agentMode: 'agent',
    project: { path: process.cwd(), name: 't' },
    gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
    onEvent: () => {},
    extensions: {},
  });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.parallel, true);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].kind, 'explore');
  assert.ok(parsed.results[0].subagentId);
});

it('spawn_explore result includes kind and subagentId', async () => {
  // update existing success test asserts
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/explore.test.js`  
Expected: FAIL on new cases / missing tool

- [ ] **Step 3: 重写 explore provider**

```js
'use strict';
const { createSubagentRuntime } = require('../subagent-runtime');

function getRuntime(ctx, runLoop) {
  if (ctx.extensions?.subagentRuntime) return ctx.extensions.subagentRuntime;
  if (!ctx.extensions) ctx.extensions = {};
  const rt = createSubagentRuntime({ runLoop });
  ctx.extensions.subagentRuntime = rt;
  return rt;
}

function createExploreProvider({ runLoop } = {}) {
  const resolvedRunLoop = typeof runLoop === 'function'
    ? runLoop
    : (...args) => require('../agent').runAgentLoop(...args);

  return {
    id: 'explore',
    isEnabled(ctx) {
      if (ctx.settings?.subagentEnabled === false) return false;
      if (normalizeMode(ctx.agentMode) !== 'agent') return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      return true;
    },
    getTools() {
      return [
        {
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
        },
        {
          type: 'function',
          function: {
            name: 'spawn_explores',
            description: 'Spawn multiple read-only explore sub-agents in parallel (limited concurrency); returns ordered results',
            parameters: {
              type: 'object',
              properties: {
                goals: { type: 'array', items: { type: 'string' } },
                maxTurns: { type: 'integer' },
              },
              required: ['goals'],
            },
          },
        },
      ];
    },
    async execute(name, args, ctx) {
      if (name !== 'spawn_explore' && name !== 'spawn_explores') {
        return JSON.stringify({ ok: false, error: '未知工具: ' + name });
      }
      if (Number(ctx.subagentDepth) >= 1) {
        return JSON.stringify({ ok: false, error: '子 Agent 内禁止再次 spawn' });
      }
      const rt = getRuntime(ctx, resolvedRunLoop);
      try {
        if (name === 'spawn_explore') {
          const out = await rt.runExplore(ctx, {
            goal: args?.goal,
            maxTurns: args?.maxTurns,
          });
          return JSON.stringify(out);
        }
        const out = await rt.runExplores(ctx, {
          goals: args?.goals,
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

module.exports = { createExploreProvider };
```

更新旧测试：断言 `parsed.kind === 'explore'` 等；嵌套拒绝仍可在 provider 或 runtime 层触发。

- [ ] **Step 4: 测试通过**

Run: `node --test tests/explore.test.js tests/subagent-runtime.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/explore.js tests/explore.test.js
git commit -m "feat(codex-qq): Phase C.4 spawn_explores and runtime-backed explore"
```

---

### Task 5: implement provider + registry

**Files:**
- Create: `src/ai/providers/implement.js`
- Modify: `src/ai/providers/index.js`
- Create: `tests/implement.test.js`

**Interfaces:**
- Produces: `createImplementProvider({ runLoop })`；tool `spawn_implement`
- 注册顺序：builtin, skills, explore, implement, mcp（implement 在 explore 后即可）

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createImplementProvider } = require('../src/ai/providers/implement');
const { createPermissionGate } = require('../src/ai/permission');
const { createBuiltinProvider, IMPLEMENT_TOOLS } = require('../src/ai/providers/builtin');

describe('implement provider', () => {
  it('rejects nested spawn', async () => {
    const p = createImplementProvider({
      runLoop: async () => ({ content: 'x', turns: 0, agentLog: [], fileChanges: [] }),
    });
    const raw = await p.execute('spawn_implement', { goal: 'add a feature now' }, {
      subagentDepth: 1,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      onEvent: () => {},
      extensions: {},
    });
    assert.equal(JSON.parse(raw).ok, false);
  });

  it('calls runLoop with subagentKind implement', async () => {
    let seen;
    const p = createImplementProvider({
      runLoop: async (opts) => {
        seen = opts;
        return {
          content: 'changed settings',
          turns: 2,
          agentLog: [{ tool: 'search_replace', ok: true, summary: 'ok' }],
          fileChanges: [{ path: 'src/a.js', op: 'search_replace' }],
        };
      },
    });
    const events = [];
    const raw = await p.execute('spawn_implement', { goal: 'fix the bug in a.js', maxTurns: 5 }, {
      subagentDepth: 0,
      settings: { subagentEnabled: true },
      agentMode: 'agent',
      project: { path: process.cwd(), name: 't' },
      gate: createPermissionGate({ permissionMode: 'full-auto', agentMode: 'agent' }),
      onEvent: (e) => events.push(e),
      extensions: {},
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, 'implement');
    assert.equal(seen.subagentKind, 'implement');
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.settings.maxAgentTurns, 5);
    assert.ok(Array.isArray(parsed.fileChanges));
    assert.ok(events.some((e) => e.type === 'subagent-start' && e.kind === 'implement'));
    assert.ok(events.some((e) => e.type === 'subagent-end' && e.ok));
  });

  it('isEnabled false when subagent disabled or plan', () => {
    const p = createImplementProvider({ runLoop: async () => ({}) });
    assert.equal(p.isEnabled({
      settings: { subagentEnabled: false },
      agentMode: 'agent',
      subagentDepth: 0,
    }), false);
    assert.equal(p.isEnabled({
      settings: { subagentEnabled: true },
      agentMode: 'plan',
      subagentDepth: 0,
    }), false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/implement.test.js`  
Expected: FAIL — module not found

- [ ] **Step 3: 实现 implement.js + index 注册**

```js
// implement.js — mirror explore, call rt.runImplement
'use strict';
const { createSubagentRuntime } = require('../subagent-runtime');

function getRuntime(ctx, runLoop) {
  if (ctx.extensions?.subagentRuntime) return ctx.extensions.subagentRuntime;
  if (!ctx.extensions) ctx.extensions = {};
  const rt = createSubagentRuntime({ runLoop });
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
      if ((ctx.agentMode === 'plan' ? 'plan' : 'agent') !== 'agent') return false;
      if (Number(ctx.subagentDepth) >= 1) return false;
      return true;
    },
    getTools() {
      return [{
        type: 'function',
        function: {
          name: 'spawn_implement',
          description: 'Spawn an implement sub-agent that may edit files via write_file/search_replace only; shares parent permissions; returns summary and fileChanges',
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

module.exports = { createImplementProvider };
```

**index.js：**

```js
const { createImplementProvider } = require('./implement');
// inside createDefaultRegistry:
reg.register(createExploreProvider({ runLoop }));
reg.register(createImplementProvider({ runLoop }));
reg.register(createMcpProvider());
// exports createImplementProvider
```

- [ ] **Step 4: 测试通过**

Run: `node --test tests/implement.test.js tests/explore.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/providers/implement.js src/ai/providers/index.js tests/implement.test.js
git commit -m "feat(codex-qq): Phase C.4 spawn_implement provider"
```

---

### Task 6: 父 run fileChanges 合并

**Files:**
- Modify: `src/ai/agent.js`（工具路径在 spawn_* 的 result 解析后，或监听 subagent-end）
- Modify: `tests/implement.test.js` 或 `tests/hooks-agent.test.js` 风格集成测（优先轻量：单测「合并 helper」或 mock loop）

**Interfaces:**
- 当 depth=0 工具结果为 implement 成功 JSON 且含 `fileChanges` 时，合并进父 `fileChanges` 数组并发 `FILE_CHANGE`（若尚未由子转发重复）
- 子 run 内部已对真实写发 `FILE_CHANGE` 且带 `subagent: true`；**renderer** 已会 merge 到 `chatRun.fileChanges`（见 `app.js` file-change 处理）
- **本任务焦点：** 确保子写盘事件能到父 `onEvent`（runtime 已转发）；父 `result.fileChanges` 在 agent loop 返回值中也包含子变更，避免仅 UI 有、返回体无

**策略（选一，推荐 A）：**

**A.** runtime `subagent-end` 已带 `fileChanges`；主 `runAgentLoop` 在 `TOOL_END` 前解析 implement 工具 JSON，若 `fileChanges` 则 push 到父数组（去重 path）。  
**B.** 仅依赖转发的 `FILE_CHANGE` 事件；父 `result.fileChanges` 在 loop 内对 `file-change` 事件也 push（若当前只在 execute 成功路径 push，需对转发事件补记——**不要**对 subagent 转发双重计数）。

推荐 **A**（工具结果驱动，简单去重）：

```js
// after tool result string known, name === 'spawn_implement'
try {
  const parsed = JSON.parse(resultStr);
  if (parsed && parsed.ok && Array.isArray(parsed.fileChanges)) {
    for (const fc of parsed.fileChanges) {
      if (!fc?.path) continue;
      if (!fileChanges.some((x) => x.path === fc.path && x.op === fc.op)) {
        fileChanges.push({ path: fc.path, op: fc.op, stats: fc.stats });
      }
    }
  }
} catch { /* ignore */ }
```

放置位置：与现有 `search_replace`/`write_file` 更新 `fileChanges` 的分支相邻；**仅** `spawn_implement`（或 parsed.kind==='implement'）。

- [ ] **Step 1: 测试**

若集成成本高：单测纯函数 `mergeSubagentFileChanges(parentArr, toolName, resultStr)` 抽到 `subagent-runtime.js` 或 `agent.js` 导出仅测试。

```js
it('mergeSubagentFileChanges merges implement paths', () => {
  const { mergeSubagentFileChanges } = require('../src/ai/subagent-runtime');
  const arr = [];
  mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
    ok: true,
    kind: 'implement',
    fileChanges: [{ path: 'a.js', op: 'write' }],
  }));
  assert.equal(arr.length, 1);
  mergeSubagentFileChanges(arr, 'spawn_implement', JSON.stringify({
    ok: true,
    fileChanges: [{ path: 'a.js', op: 'write' }],
  }));
  assert.equal(arr.length, 1); // dedupe
});
```

- [ ] **Step 2–4: 实现 helper、agent 调用、测试绿、commit**

```bash
git commit -m "feat(codex-qq): Phase C.4 merge implement fileChanges into parent"
```

---

### Task 7: renderer 可展开 transcript + 设置

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/index.html`
- Modify: `src/main.js`（settings 白名单含 `exploreMaxParallel`）

**Interfaces:**
- `subagent-start` → 创建折叠块（id=`subagentId`），状态进行中  
- 带 `subagentId` 的 `tool-start`/`tool-end` → 追加摘要行到该块  
- `subagent-end` → 更新状态/summary/耗时  
- 点击标题切换展开  
- 设置：文案「启用子 Agent」；`exploreMaxParallel` 输入 1–3

- [ ] **Step 1: HTML**

```html
<label class="switch-row">
  <input type="checkbox" id="set-subagent-enabled" checked />
  <span>启用子 Agent（explore / implement / 批量调研）</span>
</label>
<label class="field">
  <span>Explore 最大并行</span>
  <input id="set-explore-max-parallel" type="number" min="1" max="3" value="2" />
</label>
```

- [ ] **Step 2: CSS**

```css
.subagent-block {
  margin: 6px 0 2px;
  border: 1px solid #8a9bcc;
  border-radius: 3px;
  background: #eef2fc;
  color: #243a6a;
  font-size: 12px;
}
.subagent-block-hd {
  cursor: pointer;
  padding: 4px 8px;
  user-select: none;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.subagent-block-hd .sa-status.is-run { color: #3a5a9a; }
.subagent-block-hd .sa-status.is-ok { color: #2a6a2a; }
.subagent-block-hd .sa-status.is-fail { color: #8a2020; }
.subagent-block-body {
  display: none;
  padding: 4px 8px 8px;
  border-top: 1px solid #c5d0e8;
}
.subagent-block.open .subagent-block-body { display: block; }
.subagent-block-body .sa-tool {
  opacity: 0.9;
  margin: 2px 0;
}
.subagent-block-body .sa-summary {
  margin-top: 6px;
  white-space: pre-wrap;
}
```

- [ ] **Step 3: app.js 逻辑**

用 `Map<subagentId, { el, toolsEl, summaryEl, statusEl }>` 绑定当前 run（`chatRun` 上挂 `subagentBlocks`）。

```js
function ensureSubagentBlock(ev) {
  if (!chatRun) return null;
  if (!chatRun.subagentBlocks) chatRun.subagentBlocks = new Map();
  const id = ev.subagentId || 'unknown';
  if (chatRun.subagentBlocks.has(id)) return chatRun.subagentBlocks.get(id);
  const root = document.createElement('div');
  root.className = 'subagent-block';
  root.dataset.subagentId = id;
  root.innerHTML = `
    <div class="subagent-block-hd">
      <span class="sa-title"></span>
      <span class="sa-status is-run">进行中…</span>
    </div>
    <div class="subagent-block-body">
      <div class="sa-tools"></div>
      <div class="sa-summary"></div>
    </div>`;
  const hd = root.querySelector('.subagent-block-hd');
  hd.addEventListener('click', () => root.classList.toggle('open'));
  const kind = ev.kind || 'explore';
  const goal = String(ev.goal || '').slice(0, 80);
  root.querySelector('.sa-title').textContent = `子 Agent · ${kind} · ${goal}`;
  // append into current assistant trajectory host — same place as appendTimelineRow
  appendTimelineCustom(root); // 若不存在，则复用 appendTimelineRow 的父容器 query
  const rec = {
    el: root,
    toolsEl: root.querySelector('.sa-tools'),
    summaryEl: root.querySelector('.sa-summary'),
    statusEl: root.querySelector('.sa-status'),
  };
  chatRun.subagentBlocks.set(id, rec);
  return rec;
}
```

事件处理：

```js
if (type === 'subagent-start') {
  ensureSubagentBlock(ev);
  setRunStatus(`子 Agent (${ev.kind || 'explore'}): ${String(ev.goal || '').slice(0, 60)}`);
  return;
}
if (type === 'subagent-end') {
  const rec = ensureSubagentBlock(ev);
  if (rec) {
    rec.statusEl.className = 'sa-status ' + (ev.ok ? 'is-ok' : 'is-fail');
    const ms = ev.durationMs != null ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : '';
    const writes = ev.fileChangeCount ? ` · 写入 ${ev.fileChangeCount} 个文件` : '';
    rec.statusEl.textContent = (ev.ok ? '成功' : ('失败: ' + (ev.error || ''))) + ms + writes;
    if (ev.summary) rec.summaryEl.textContent = String(ev.summary).slice(0, 4000);
  }
  setRunStatus(ev.ok ? '子 Agent 完成' : ('子 Agent 失败: ' + (ev.error || '')));
  return;
}
// In tool-start / tool-end handlers, if ev.subagent && ev.subagentId:
if (ev.subagent && ev.subagentId && chatRun?.subagentBlocks?.get(ev.subagentId)) {
  const rec = chatRun.subagentBlocks.get(ev.subagentId);
  if (type === 'tool-end') {
    const line = document.createElement('div');
    line.className = 'sa-tool';
    line.textContent = `· ${ev.name || ev.tool || '?'} ${ev.ok === false ? '失败' : 'ok'}`;
    rec.toolsEl.appendChild(line);
  }
  return; // 可选：不再写入主轨迹，避免刷屏；若需双写可去掉 return
}
```

设置 load/save：

```js
const emp = document.getElementById('set-explore-max-parallel');
if (emp) emp.value = String(settings.exploreMaxParallel ?? 2);
// save:
exploreMaxParallel: Number(document.getElementById('set-explore-max-parallel')?.value || 2),
```

- [ ] **Step 4: 手工检查清单（无 UI 单测框架时）**

- 开设置可见并行输入  
- mock/local 若难触发 spawn，至少保证事件处理不抛错（可在控制台 `handleAgentEvent({type:'subagent-start',...})` 若导出）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app.js src/renderer/styles.css src/renderer/index.html src/main.js
git commit -m "feat(codex-qq): Phase C.4 subagent expandable transcript UI"
```

---

### Task 8: README + 全量测试

**Files:**
- Modify: `README.md`
- 全量回归

- [ ] **Step 1: README 增加 Phase C.4 节**

要点（zh-CN）：

- `spawn_explore` / `spawn_explores` / `spawn_implement`
- 并行仅 explore；`exploreMaxParallel` 1–3
- implement 仅改文件工具；共用权限；无终端/提交
- 子 Agent 不可再 spawn；无 worktree
- 轨迹可展开块
- `subagentEnabled` 总开关

- [ ] **Step 2: 全量测试**

Run: `npm test`  
Expected: 全绿（在 C.3 的 221 基础上增加本 Phase 用例）

- [ ] **Step 3: 修复任何回归**（常见：plan 隐藏、risk、explore 旧测试事件字段、agent system 快照）

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(codex-qq): Phase C.4 subagents usage in README"
```

---

## Self-review (plan vs spec)

| Spec 项 | Task |
|---------|------|
| subagent-runtime 池/互斥 | T2 |
| spawn_implement | T5 |
| spawn_explore 增强 | T4 |
| spawn_explores | T4 |
| transcript UI | T7 |
| exploreMaxParallel | T1 + T7 |
| builtin kind 过滤 | T3 |
| Gate 共享 write risk | T3 + T5 |
| fileChanges 合并 | T6 |
| plan 隐藏 | T3 |
| 无 worktree | 全任务不实现 |
| 测试 + README | T2–T5, T8 |
| depth≤1 / 子无 hooks | runtime childSettings + 既有 hooks depth 门闩 |

无 TBD；接口名在任务间一致（`createSubagentRuntime` / `subagentKind` / `spawn_*`）。

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-phase-c4-subagents.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每任务新 subagent + 任务间 review，迭代快  
2. **Inline Execution** — 本会话按 executing-plans 批量执行并设检查点  

**Which approach?**
