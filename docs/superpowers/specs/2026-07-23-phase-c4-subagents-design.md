# Phase C.4 — 子 Agent 增强设计规格（implement + 并行 explore + transcript）

**日期:** 2026-07-23  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase C.3 Hooks（`099b09c`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §8 项 13（简单子 Agent explore vs implement）
- `docs/superpowers/specs/2026-07-20-phase-c2-platform-design.md` §1.3 / §1.5（C.4 = implement、并行、depth、transcript UI）
- `docs/superpowers/specs/2026-07-21-phase-c3-hooks-design.md`（`subagentDepth >= 1` 不跑 hooks）
- 本轮 brainstorming 锁定决策（见 §2）

---

## 1. 目标与范围

### 1.1 一句话目标

在 C.2 的 `spawn_explore` 之上，增加 **可写 implement 子 Agent**、**有限并行 explore（含批量工具）**，以及主轨迹内 **可展开 transcript**，使主 Agent 能安全委派调研与改文件，且 **不引入 worktree 实现 / 新 npm 依赖**。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **subagent-runtime** | 共享：嵌套 `runLoop`、事件包装（`subagentId` / `kind`）、explore 并发池、implement 互斥、depth 门闩 |
| 2 | **spawn_implement** | 写子集工具（`write_file` + `search_replace`）；与父共用 PermissionGate / session allow；同 run 内串行 |
| 3 | **spawn_explore 增强** | 事件带 `subagentId` / `kind`；可与其它 explore 在并发上限内并行 |
| 4 | **spawn_explores** | `goals[]` 批量并行只读；按序聚合 `results` |
| 5 | **transcript UI** | 主轨迹可展开块：子工具摘要 + 最终 summary（+ implement 写入路径数） |
| 6 | **测试与文档** | runtime / provider / mode / settings 单测；README Phase C.4；规格预留 worktree |

### 1.3 非目标（硬边界）

- **git worktree 隔离**（本轮不实现；§3.5 / 附录仅文档预留）
- implement **并行**（同 run 内串行互斥）
- 子 Agent 内再 spawn；`subagentDepth > 1`
- implement 使用 `run_terminal` / `delete_path` / `git_commit` / mcp / skills
- 独立侧栏多 Agent 面板、子会话持久化 / 可恢复
- C.5：MCP SSE/HTTP、Skills 可执行/自动路由、更强 MCP/Hooks 设置 UI
- 新 npm 依赖（纯 Node CommonJS）

### 1.4 成功标准

1. `subagentEnabled: false` 时 `spawn_explore` / `spawn_explores` / `spawn_implement` 均不可用；无子 Agent 事件。  
2. `spawn_explore` 保持 C.2 核心语义（只读、depth=1、返回 summary）；多 explore 并发 ≤ `exploreMaxParallel`。  
3. `spawn_explores` 按 `goals` 顺序返回 `results`；空/全非法 goals → `{ ok:false }` 且不启子 run。  
4. `spawn_implement` 可真实 `write_file` / `search_replace`；工具表 **无** terminal / delete / commit / spawn / skills / mcp。  
5. implement 与父 **共用** Gate 与 session allow；`spawn_implement` 本身 risk=`write`。  
6. `subagentDepth >= 1` 无法再 spawn；子 run **不跑**用户 hooks（C.3）。  
7. 同主 run 内 implement **串行**；父 `signal` abort → 运行中与排队中的子任务均取消。  
8. 主轨迹可展开块展示 kind / goal / 状态 / 耗时 / 工具摘要 / summary；并行多块可用。  
9. implement 的 `fileChanges` **合并**进父 UI；verify 软门闩 **不** 因子 implement 记成功。  
10. `npm test` 全绿；无新 npm 依赖；无 worktree 实现代码。

### 1.5 平台化路线图（记账）

| 阶段 | 内容 |
|------|------|
| C.2（已交付） | Registry + Skills + explore + MCP stdio |
| C.3（已交付） | Hooks |
| **C.4（本规格）** | implement + 并行 explore + transcript UI |
| C.5 | MCP SSE/HTTP；Skills 可执行/自动路由；设置 UI 增强；可选 worktree |

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 目标 | implement + 有限并行 explore + 主轨迹可展开 transcript（最小可用） |
| 实现形态 | **方案 1：薄 Provider 扩展** + 共享 `subagent-runtime`（不改 ToolProvider 接口哲学） |
| API 面 | 保留 `spawn_explore`；新增 `spawn_implement` + `spawn_explores`（批量） |
| implement 权限 | 与主 Agent **共用** PermissionGate / session allow |
| implement 工具 | **仅** `write_file` + `search_replace`（+ 只读 builtin 子集） |
| 并行 | **仅 explore** 可并；implement **串行** |
| depth | **≤ 1**；子内禁 spawn；主可同时挂多个 depth-1 explore |
| UI | 主轨迹 **可展开块**（非独立侧栏） |
| worktree | **不实现**；协议/文档 **预留** `isolation` |
| 开关 | `subagentEnabled` 总开关；`exploreMaxParallel` 默认 2（1..3） |
| 依赖 | 无新 npm 依赖 |

---

## 3. 架构

### 3.1 总览

```
主 runAgentLoop (depth=0)
  registry
    exploreProvider     → spawn_explore, spawn_explores
    implementProvider   → spawn_implement
    builtin / skills / mcp / …

  ctx.extensions.subagentRuntime  (每主 run 一份)
    ├ runExplore / runExplores
    ├ runImplement
    ├ explore 信号量 (exploreMaxParallel)
    └ implement Mutex (串行)

子 runAgentLoop (depth=1, subagentKind)
  ├ explore: EXPLORE_READONLY
  ├ implement: readonly + write_file + search_replace
  ├ gate / signal / sessionKey 与父共享
  ├ skills / mcp / explore / implement providers 关闭
  └ hooks 跳过 (C.3)
```

- ToolProvider 接口不变；新增 provider + runtime 辅助模块。  
- `runLoop` 仍由工厂注入 / 懒 require，避免 `agent ↔ provider` 顶层环。

### 3.2 新模块（拟）

| 路径 | 职责 |
|------|------|
| `src/ai/subagent-runtime.js` | 并发池、互斥、id、嵌套 runLoop、事件规范化、结果裁剪 |
| `src/ai/providers/explore.js` | 增强事件字段；`spawn_explores` |
| `src/ai/providers/implement.js` | `spawn_implement` |
| `src/ai/providers/index.js` | 注册 implement；注入 runtime 或 runLoop |
| `src/ai/providers/builtin.js` | 按 `subagentDepth` + `subagentKind` 裁剪工具 |
| `src/ai/agent.js` | system prompt 分 kind；主提示子 Agent 能力；fileChanges 合并钩子（若需） |
| `src/ai/agent-mode.js` | `PLAN_HIDDEN_TOOLS` 含 `spawn_implement` / `spawn_explores` |
| `src/ai/permission.js` | `spawn_implement` → write；`spawn_explores` → read；READ_TOOLS 更新 |
| `src/ai/settings.js` | `exploreMaxParallel` 默认 2 |
| `src/ai/agent-events.js` | 字段约定（可不新增 type 常量） |
| `src/renderer/*` | 可展开 transcript 块 |
| `tests/subagent-runtime.test.js` 等 | 见 §9 |
| `README.md` | Phase C.4 用法 |

### 3.3 RunContext 扩展

```js
/**
 * @typedef {object} RunContext  // 增量
 * @property {number} subagentDepth
 * @property {'explore'|'implement'|undefined} [subagentKind]
 * @property {object} [extensions]
 * @property {object} [extensions.subagentRuntime]
 */
```

主 run 在 `depth === 0` 且 `subagentEnabled !== false` 时创建 runtime 挂到 `extensions`；子 run **不**创建新池（不需要）。

### 3.4 与现有子系统

| 子系统 | 关系 |
|--------|------|
| PermissionGate | 唯一授权权威；父子共享实例与 session allow |
| registry | implement / explore 为普通 provider |
| Hooks (C.3) | `subagentDepth >= 1` 整表跳过 |
| MCP / Skills | 子 run `isEnabled` false（与 C.2 一致） |
| verify 软门闩 | 仅父真实 `run_terminal` 成功计数 |
| plan 模式 | 隐藏全部 spawn_* |

---

## 4. 工具协议

### 4.1 主 Agent 工具表

| 工具 | risk | 启用条件 | 参数 |
|------|------|----------|------|
| `spawn_explore` | read | agent + `subagentEnabled` + depth=0 | `goal`（trim 后 ≥ 4）、`maxTurns?` 默认 **4** clamp **1..8** |
| `spawn_explores` | read | 同上 | `goals: string[]`（有效项 1..**6**）、`maxTurns?` 同上共享 |
| `spawn_implement` | **write** | 同上 | `goal`（≥ 4）、`maxTurns?` 默认 **6** clamp **1..12** |

**plan：** 三者均在 `PLAN_HIDDEN_TOOLS`。  
**depth ≥ 1：** provider `isEnabled` false；`execute` 双保险返回错误 JSON（不抛崩 loop，abort 除外）。

`spawn_explore` 对外签名与 C.2 **兼容**。

### 4.2 子 run 工具策略（builtin）

```js
const EXPLORE_READONLY = new Set([
  'list_dir', 'read_file', 'grep', 'glob', 'git_status', 'git_diff',
]);

const IMPLEMENT_TOOLS = new Set([
  ...EXPLORE_READONLY,
  'write_file', 'search_replace',
]);
```

| `subagentKind` | 过滤结果 |
|----------------|----------|
| `explore` 或未设且 depth≥1 | `EXPLORE_READONLY` |
| `implement` | `IMPLEMENT_TOOLS` |

一律排除：`delete_path`、`run_terminal`、`git_commit`、`submit_plan`、一切 `spawn_*`、skills、`mcp_*`。

### 4.3 System 提示

| 场景 | 要点 |
|------|------|
| 主 agent（subagent 开） | 可用 `spawn_explore` / `spawn_explores` 调研；可用 `spawn_implement` 委派改文件；子不能再 spawn；implement **无**终端/提交/删除；验证由主 Agent 负责 |
| 子 explore | 与 C.2：只读调研，中文结论，不编造 |
| 子 implement | 可读写；优先 `search_replace`；禁止删/终端/commit/spawn；完成后中文总结改动路径 |

`agentSystemPrompt` 在 `depth >= 1` 时按 `subagentKind` 分支，**不得**再把 implement 误标为「只读 explore」。

### 4.4 返回值

**单次 spawn（explore / implement）：**

```js
{
  ok: true,
  kind: 'explore' | 'implement',
  subagentId: 'sa_…',
  summary: string,           // ≤ 8 KiB
  turns: number,
  agentLog: Array<{ tool, ok, summary }>,  // 精简，条数与单条长度有上限
  fileChanges?: Array        // 仅 implement：相对路径变更摘要
}
```

失败：`{ ok: false, kind, subagentId?, error }`。  
`err.code === 'ABORTED'` → 向上抛，与主 loop 一致。

**`spawn_explores`：**

```js
{
  ok: boolean,              // 全部子项 ok 才为 true
  parallel: true,
  results: [ /* 与单次结构相同，顺序与规范化后的 goals 一致 */ ]
}
```

| 输入 | 行为 |
|------|------|
| 缺省 / 非数组 / 有效 goal 数为 0 | `{ ok:false, error }`，不启子 run |
| 有效 goals > 6 | 截断为前 6，或返回 error（实现选 **截断并在结果中标注** `truncated: true` 于顶层，文档写明） |
| 单项 goal 过短 | 该槽 `{ ok:false, error: 'goal 过短…' }`，不占用成功语义 |

### 4.5 生命周期（单子任务）

1. 主模型发起 spawn → 主 loop 对 **spawn 工具** 做 Gate₁（及 C.3 Pre/Post，depth=0）。  
2. runtime 获取槽位（explore 池 / implement 锁）；排队期间尊重 `signal`。  
3. 发 `subagent-start`。  
4. `runLoop({ subagentDepth: 1, subagentKind, gate: 父, signal: 父, sessionKey: 父, settings: 子覆盖, extensions: 无 mcpHub 共享问题处理与 C.2 相同, registry })`。  
5. 子内工具仍走 Gate；写工具对 implement 可见且需授权。  
6. 结束 → 规范化返回值 → 合并 fileChanges（implement）→ `subagent-end` → 释放槽位。  
7. 父模型收到 JSON 字符串结果。

**子 settings 覆盖（建议）：**

```js
{
  ...parentSettings,
  maxAgentTurns: maxTurns,
  skillsEnabled: false,
  mcpEnabled: false,
  subagentEnabled: false,
  verifyBeforeDone: false,
  hooksEnabled: false,  // 双保险；runner 仍看 depth
}
```

### 4.6 fileChanges / verify

| 项 | 策略 |
|----|------|
| 磁盘 | implement **直接写项目目录**（无 worktree） |
| 父 UI `fileChanges` | 子成功结束后 **合并** 子变更（去重 path） |
| verify | implement **不能** `run_terminal` → **不得** 增加 verify 成功计数 |
| skip / 假写 | 不适用 hooks skip；真实 execute 才产生变更 |

---

## 5. 并发与 runtime

### 5.1 API 形状

```js
function createSubagentRuntime(opts: {
  runLoop: Function,
  // 以下也可在每次 run* 时从 ctx 传入
}): {
  runExplore(ctx, { goal, maxTurns }): Promise<object>,
  runExplores(ctx, { goals, maxTurns }): Promise<object>,
  runImplement(ctx, { goal, maxTurns }): Promise<object>,
}
```

实现可把 `onEvent` / `signal` / `settings` 从 `ctx` 读取，便于 provider 一行调用。

### 5.2 规则

| 规则 | 值 |
|------|-----|
| `exploreMaxParallel` | 默认 **2**，clamp **1..3**（settings） |
| implement | 同 runtime **互斥**；后来者等待 |
| `subagentId` | `sa_` + 同 run 唯一（递增或 random） |
| 池作用域 | **每主 run** 一份 runtime，不跨 chat run 复用 |
| abort | 父 signal → 取消等待 + 中止子 runLoop |
| 同事件串行 hooks | 不改变；子无 hooks |

### 5.3 批量 explore

- 规范化 goals → 对每个 goal 调度 `runExplore`（受池限制，可同时跑多个）。  
- `batchId`（可选）写入各 start/end，UI 可分组。  
- 顶层 `ok` = 所有 results 的 `ok === true`。

---

## 6. 事件与 UI

### 6.1 事件字段

| 事件 | 字段 |
|------|------|
| `subagent-start` | `subagentId`, `kind`, `goal`, `maxTurns`, `batchId?` |
| `subagent-end` | `subagentId`, `kind`, `ok`, `summary?`, `error?`, `durationMs`, `fileChangeCount?` |
| 转发 `tool-start` / `tool-end` | `subagent: true`, `subagentId`, `kind` |

不强制新增 `AGENT_EVENTS` 类型；沿用 `SUBAGENT_START` / `SUBAGENT_END`。

### 6.2 可展开轨迹块

- 默认 **折叠**：`子 Agent · {kind} · {goal 截断}` + 状态（进行中/成功/失败）+ 耗时。  
- **展开**：子工具摘要列表（来自转发事件或 end 时 agentLog 回填）+ 最终 summary。  
- implement 折叠条可显示「写入 n 个文件」。  
- 并行：多块同时进行中。  
- 批量：可选外框「批量 explore (k)」。  
- 文案 **zh-CN**。  
- **不做**独立侧栏。

### 6.3 设置 UI

- 保留「启用 Explore 子 Agent」文案扩展为覆盖 implement / 批量（或改为「启用子 Agent」）。  
- `exploreMaxParallel`：数字输入或 select（1–3），默认 2。  
- 无规则编辑器级 GUI。

---

## 7. 安全硬约束

| 规则 | 说明 |
|------|------|
| Gate 权威 | Hooks/子 Agent 均不能放宽 permissionMode 或伪造 session allow |
| spawn_implement risk | `write`，confirm-writes 下可弹确认 |
| 子工具集 | 白名单裁剪 + Gate 双保险 |
| 无 worktree | 串行 implement 降低写冲突；不保证多进程外部并发安全 |
| depth | 子永不 spawn |
| hooks | depth≥1 不跑 |
| 机密 | 不把 apiKey 等注入子特有 env（无新 env 面） |
| shell | 不新增 shell 执行路径 |

---

## 8. worktree 预留（不实现）

未来可选：

```json
{ "goal": "…", "isolation": "none" | "worktree" }
```

- C.4：**固定等价 `none`**；若传入 `worktree` → 忽略或返回明确 error（推荐 **忽略并当 none**，避免半成品路径）。  
- 真正 worktree：创建 → 子 cwd → 合并/丢弃 → 清理；属后续 Phase。

---

## 9. 测试计划

| 文件 | 覆盖 |
|------|------|
| `tests/subagent-runtime.test.js` | 池上限、implement 互斥与排队、abort、id 唯一、结果裁剪 |
| `tests/explore.test.js` | 兼容 C.2；`spawn_explores` 顺序/部分失败/空 goals；事件字段 |
| `tests/implement.test.js` | 工具集、写盘、禁终端、Gate 共享 mock、depth 拒绝、fileChanges 形状 |
| `tests/agent-mode.test.js` | plan 隐藏新工具 |
| `tests/permission.test.js` | risk：explores=read，implement=write |
| `tests/settings.test.js` | `exploreMaxParallel` 默认与加载 |
| `tests/builtin` 或 provider 测 | depth+kind 过滤 |

手段：mock `runLoop`、临时目录；无外网、无新依赖。

---

## 10. 文档

- 本规格：`docs/superpowers/specs/2026-07-23-phase-c4-subagents-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-23-phase-c4-subagents.md`（writing-plans 阶段）
- README：Phase C.4 小节（工具、并行、权限、UI、与 C.2 差异、worktree 未做说明）

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 并行 explore 费用/限流 | 默认并发 2、maxTurns 低、可关 subagent |
| implement 无法自测 | system 写明由主 Agent verify；工具集有意收窄 |
| 共享目录写冲突 | implement 串行；文档提示 |
| system/agent.js 膨胀 | kind 专用 prompt 片段函数 |
| UI 事件乱序 | 严格 `subagentId` 归桶 |
| 与 hooks 交错 | 子无 hooks；父 spawn 走正常 Pre/Post |

---

## 12. 实现顺序建议（供 plan 拆任务）

1. settings：`exploreMaxParallel` + 测试  
2. `subagent-runtime` + 测试  
3. builtin `subagentKind` 裁剪 + `agentSystemPrompt` 分支 + permission/mode  
4. explore 增强 + `spawn_explores`  
5. `implement` provider + 注册  
6. 父 fileChanges 合并  
7. renderer 可展开块 + 设置文案  
8. README + 全量 `npm test`

---

## 13. 附录：最小调用示意

**主模型并行调研：**

```json
{
  "name": "spawn_explores",
  "arguments": {
    "goals": [
      "定位鉴权中间件入口",
      "列出 settings 相关默认值"
    ],
    "maxTurns": 4
  }
}
```

**主模型委派修改：**

```json
{
  "name": "spawn_implement",
  "arguments": {
    "goal": "在 src/ai/settings.js 为 exploreMaxParallel 增加默认值 2，并补 settings 单测",
    "maxTurns": 8
  }
}
```
