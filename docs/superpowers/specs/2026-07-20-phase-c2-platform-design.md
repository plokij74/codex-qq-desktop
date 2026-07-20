# Phase C.2 — 平台化设计规格（ToolProvider + Skills + explore + MCP stdio）

**日期:** 2026-07-20  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase C.1 Plan 模式 + 软验证（`409367f`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §8 Phase C 项 12–14
- `docs/superpowers/specs/2026-07-20-phase-c-orchestration-design.md`（C.1 已交付；本文件为 C.2）
- 本轮 brainstorming 锁定决策（见 §2）

---

## 1. 目标与范围

### 1.1 一句话目标

在单 `runAgentLoop` 上引入 **ToolProvider 注册表**，使 **Skills 工作流**、**只读 explore 子 Agent**、**stdio MCP** 以同一扩展面挂载，且不改核心循环即可在后续 Phase 继续挂 Hooks / 更强子 Agent。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **ToolProvider 注册表** | 统一 `getTools` / `execute` / 可选 `getSystemFragment` / `onRunStart`·`onRunEnd`；builtin 包一层后挂新能力 |
| 2 | **Skills** | 三源扫描 `SKILL.md`；工具 `list_skills` / `use_skill`；斜杠 `/skills` `/skill name`；system 注入目录摘要 |
| 3 | **子 Agent（explore）** | 工具 `spawn_explore`：嵌套只读 `runAgentLoop`，有限轮次，返回摘要；禁止递归 spawn |
| 4 | **MCP（stdio 最小客户端）** | 设置 `mcpServers`；每 run 懒连接、结束断开；`tools/list` 合并为 `mcp_<server>_<tool>`；`tools/call` 经 PermissionGate |

### 1.3 非目标（C.3+ 硬边界）

- 完整 Hooks 生态（工具前后脚本）— **C.3**（本轮仅预留 registry execute 路径）
- 多子 Agent 并行 / implement 子 Agent / worktree 隔离 / depth>1 — **C.4**
- MCP SSE / HTTP、resources、prompts、采样 — **C.5**
- Skills 市场 / 在线安装 / 可执行 JS skill / 自动语义路由 — **C.5**
- 自动保存 PLAN.md、多计划版本树
- 未验证硬挡 `git_commit`
- 新 npm 依赖（纯 Node CommonJS）

### 1.4 成功标准

1. 项目 `.codex/skills/*/SKILL.md`、userData `skills`、内置 `src/skills/*/SKILL.md` 可被列出与加载；斜杠可用。  
2. `use_skill` 返回技能正文（有长度上限）；`list_skills` 返回目录；system 有摘要且不自动注入全文。  
3. `spawn_explore` 仅只读工具，嵌套深度 1，返回 summary；父 run 不因子 run 写盘。  
4. 配置合法 MCP server 且 `mcpEnabled` 后，模型可见 `mcp_*` 并可调用；失败以 JSON error 返回，不崩 loop；run 结束无残留 MCP 子进程。  
5. plan 模式工具列表**不包含** `spawn_explore` 与 `mcp_*`；Gate 对 risk=`mcp` 仍拒绝（双保险）。  
6. `npm test` 全绿；无新 npm 依赖；Hooks/并行/非 stdio 未混入实现。

### 1.5 平台化路线图（记账，非本规格实现）

| 阶段 | 内容 |
|------|------|
| **C.2（本规格）** | Registry + Skills + explore + MCP stdio |
| **C.3** | Hooks（挂 registry execute 前后） |
| **C.4** | 子 Agent 增强：implement、并行、depth 策略、transcript UI |
| **C.5** | MCP SSE/HTTP 与资源；Skills 可执行/自动路由；MCP 设置列表 UI |

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 范围切分 | 本轮仅 C.2；Hooks/更强子 Agent/MCP·Skills 增强 → C.3–C.5 |
| 实现形态 | **方案 2：ToolProvider 注册表** + 单 `runAgentLoop`（builtin 先包一层再挂扩展） |
| Skills 格式 | Markdown + 简易 frontmatter（`name` / `description`），无 YAML 库 |
| Skills 来源优先级 | 项目 `.codex/skills` > userData `skills` > 内置 `src/skills`；同名后者不覆盖前者 |
| Skills 触发 | 工具 + 斜杠 + system 目录摘要（不自动注入全文） |
| 子 Agent | 仅 **explore** 一种；**专用只读工具集**（非完整 plan 表）；默认 maxTurns=4，上限 8 |
| 递归 | `spawn_explore` 内禁止再 spawn；`subagentDepth` 入参 |
| MCP 传输 | 仅 **stdio** + Content-Length JSON-RPC |
| MCP 生命周期 | **每次主 run 懒连接，run 结束断开** |
| MCP 默认 | `mcpServers: []`，`mcpEnabled: false` |
| MCP 权限 | risk=`mcp`；行为与 **write 同级**（confirm-writes 确认 + allow_session；full-auto 放行；read-only/plan 拒） |
| 默认开关 | `skillsEnabled: true`，`subagentEnabled: true`，`mcpEnabled: false` |
| 依赖 | 无新 npm 依赖 |

---

## 3. 总体架构

### 3.1 分层

```
Renderer
  ├ /skills  /skill <name>
  ├ 子 Agent 事件简条（subagent-start / end）
  └ 设置：skillsEnabled / subagentEnabled / mcpEnabled + mcpServers JSON

Preload / Main
  ├ chat:send → 创建 RunContext → runAgentLoop
  ├ skills:list（斜杠用）
  └ settings 读写

Agent 核心（变薄）
  ├ runAgentLoop(ctx)
  ├ PermissionGate + filterToolsForMode
  └ ExtensionRegistry.collectTools / execute / systemFragments / onRunStart|End

ToolProvider 扩展
  ├ builtinProvider     # 现有 list/read/grep/write/git/terminal/submit_plan
  ├ skillsProvider      # list_skills, use_skill + system 目录片段
  ├ exploreProvider     # spawn_explore → 嵌套 loop
  └ mcpProvider         # 每 run 懒连 stdio，贡献 mcp_* 工具
```

### 3.2 RunContext（概念）

```js
/**
 * @typedef {object} RunContext
 * @property {object} project
 * @property {object} settings
 * @property {'plan'|'agent'} agentMode
 * @property {number} subagentDepth   // 0 = 主 agent
 * @property {object} gate
 * @property {(type: string, payload: object) => void} onEvent
 * @property {AbortSignal} [signal]
 * @property {string} [sessionKey]
 * @property {object} [extensions]    // run 级缓存：skillCatalog, mcpHub, …
 */
```

### 3.3 ToolProvider 接口（最小）

```js
/**
 * @typedef {object} ToolProvider
 * @property {string} id
 * @property {(ctx: RunContext) => boolean} isEnabled
 * @property {(ctx: RunContext) => Array|Promise<Array>} getTools
 * @property {(name: string, args: object, ctx: RunContext) => Promise<any>} execute
 * @property {(ctx: RunContext) => string|null|undefined} [getSystemFragment]
 * @property {(ctx: RunContext) => void|Promise<void>} [onRunStart]
 * @property {(ctx: RunContext) => void|Promise<void>} [onRunEnd]
 */
```

**注册：** 模块加载时 `registry.register(provider)`；测试可 `createRegistry()` 注入子集。

**执行路由：** `registry.execute(name, args, ctx)` 路由到在 `getTools` 中声明该 `name` 的 provider；未知名 → `{ ok:false, error }` 类结果，不抛崩 loop。

**主 loop 骨架：**

```
runAgentLoop:
  ctx = { …, subagentDepth, extensions: {} }
  await registry.onRunStart(ctx)
  tools = filterToolsForMode(await registry.collectTools(ctx), mode)
  system += registry.systemFragments(ctx)
  … 既有模型轮询 + gate.authorize + registry.execute …
  finally: await registry.onRunEnd(ctx)  // 必跑：MCP 断开
```

### 3.4 模式与深度裁剪

| 场景 | 行为 |
|------|------|
| `agentMode === 'plan'` | collect 后经 `filterToolsForMode`；**不包含** `spawn_explore` 与 `mcp_*`；Gate 仍拒 risk=`mcp`（双保险） |
| `subagentDepth >= 1` | 仅 **builtin 只读子集**；skills / mcp / explore 的 `isEnabled` 为 false |
| 主 agent | skills / explore 默认开；mcp 仅 `mcpEnabled && servers.length` |

### 3.5 源码布局

```
src/ai/extensions/
  registry.js           # register / collectTools / execute / systemFragments / run hooks
src/ai/providers/
  builtin.js            # 从 agent.js 迁出 TOOL_DEFS + execute（可分步：先整包包装）
  skills.js
  explore.js
  mcp.js                # 内部用 mcp-client + mcp-hub
src/ai/mcp-client.js
src/ai/mcp-hub.js
src/ai/skills-loader.js # discover/parse 纯函数（provider + IPC 共用）
src/ai/agent.js         # runAgentLoop 改用 registry
src/ai/agent-mode.js    # PLAN_HIDDEN + 新工具名；PLAN_BLOCKED 含 mcp
src/ai/permission.js    # risk mcp；READ_TOOLS 含 skills / spawn_explore
src/ai/settings.js      # skillsEnabled, subagentEnabled, mcpEnabled, mcpServers
src/ai/agent-events.js  # SUBAGENT_* , MCP_STATUS
src/skills/<id>/SKILL.md
```

**迁移策略：** 实现计划内 **先 registry + builtin 包一层**（行为零 diff、全绿），再挂 skills → explore → mcp，避免大爆炸。

### 3.6 循环依赖

`exploreProvider` 需调用 `runAgentLoop`：由工厂 **注入 `runLoop`**，或 `explore.js` 内懒 `require('./agent')`，避免 `agent → explore → agent` 顶层环。

---

## 4. Skills

### 4.1 文件布局

```
{project}/.codex/skills/<id>/SKILL.md
{userData}/skills/<id>/SKILL.md
{app}/src/skills/<id>/SKILL.md
```

`<id>` 为目录名；`name` 默认取 frontmatter 或目录名（小写 kebab）。

### 4.2 SKILL.md

```markdown
---
name: code-review
description: 代码审查清单与输出格式
---

# 代码审查

1. …
```

| 规则 | 说明 |
|------|------|
| Frontmatter | 仅简易 `key: value`（可选引号）；无 YAML 库 |
| 缺 name | 用目录名，经 sanitize |
| 缺 description | 正文首条非空行，截断 120 字符 |
| name 合法 | `^[a-z0-9][a-z0-9_-]{0,63}$`；非法则 skip |
| body 上限 | **24 KiB** 截断，返回 `truncated: true` |
| 目录上限 | 合并去重后最多 **50** 个 skill |
| 编码 | UTF-8 |

### 4.3 加载器（`skills-loader.js`）

- `discoverSkills({ projectPath, userDataPath, bundledDir }) → SkillMeta[]`
- `loadSkillBody(skill) → { name, description, body, source, truncated }`
- `SkillMeta`: `{ name, description, source: 'project'|'user'|'bundled', dir, skillPath }`
- 同名优先级：project > user > bundled（前者覆盖）
- 单次 run 内 catalog 可缓存在 `ctx.extensions`；设置变更下次 run 生效

### 4.4 工具（skillsProvider）

| 工具 | risk | 参数 | 返回 |
|------|------|------|------|
| `list_skills` | read | 无 | `{ ok, skills: [{ name, description, source }] }` |
| `use_skill` | read | `name` 必填 | `{ ok, name, description, body, source, truncated? }` 或 `{ ok:false, error }` |

- `settings.skillsEnabled === false`：不注册工具、不注入 system 片段  
- plan 模式：**保留**（只读，利于写计划时引用工作流）  
- `subagentDepth >= 1`：**不暴露**

### 4.5 System 片段

skills 非空且已启用时追加：

```
【可用 Skills】需要时用 list_skills / use_skill 加载全文，勿编造技能内容。
- code-review: 代码审查清单… (project)
- tdd: … (bundled)
```

- 仅目录摘要；description 在片段中再截断（如 80 字）  
- **不**自动注入全文

### 4.6 斜杠（renderer）

| 命令 | 行为 |
|------|------|
| `/skills` | IPC `skills:list`，聊天区展示 name / description / source |
| `/skill <name>` | 加载 body，**作为用户消息发出**（前缀：`请按技能 <name> 执行：\n` + body） |

name 不存在：本地提示，不发消息。本轮不做市场、自动路由、可执行 skill。

### 4.7 内置示例

至少 `src/skills/code-review/SKILL.md`；可选极简 `tdd`。

---

## 5. 子 Agent（explore）

### 5.1 工具 `spawn_explore`

| 参数 | 必填 | 规则 |
|------|------|------|
| `goal` | 是 | trim 后长度 ≥ 4，否则 `{ ok:false, error }` |
| `maxTurns` | 否 | 默认 **4**，clamp **1..8** |

**启用（同时满足）：**

- `settings.subagentEnabled !== false`（默认 true）  
- `agentMode === 'agent'`  
- `ctx.subagentDepth < 1`

### 5.2 行为

1. 事件 `subagent-start`：`{ goal, maxTurns }`  
2. 调用 `runAgentLoop`（或注入的 `runLoop`）：

| 入参 | 值 |
|------|-----|
| `messages` | `[{ role:'user', content: goal }]` |
| 该次 max turns | `maxTurns`（不写回用户 settings 文件） |
| `subagentDepth` | `1` |
| `gate` | 与父共享或只读等价；写/终端/mcp 必拒 |
| `onEvent` | 可带 `subagent: true` 转发或静默；至少保证 start/end |
| providers | 仅 builtin **只读子集** |

3. **只读工具集（固定）：**

```
list_dir, read_file, grep, glob, git_status, git_diff
```

**不包含：** `submit_plan`、`spawn_explore`、`list_skills`、`use_skill`、一切 `mcp_*`、写/删/终端/commit。

4. 返回：

```js
{
  ok: true,
  summary: String(result.content).slice(0, 8 * 1024),
  turns: number,
  agentLog: /* 精简：工具名 + 短结果，总长例如 ≤ 4KiB */
}
```

失败：`{ ok:false, error }`；abort 与主 loop 一致（`已停止` / `ABORTED`）向上传。

5. 事件 `subagent-end`：`{ ok, summary?, error? }`  
6. 不启动 MCP；不持久化子会话；不污染父 `fileChanges` / verify 写盘语义。

### 5.3 子 run System

简短专用 system：只读 explore；结论写入最终回复；不改文件、不调用不存在工具。不注入 Skills 目录、MCP、不要求 `submit_plan`。

### 5.4 权限与 abort

- 子 loop：工具未注册 + Gate 双保险禁写  
- 父 `signal` abort → 子 loop abort  
- 禁止二次 `spawn_explore`

### 5.5 UI

- `subagent-start` / `subagent-end` 状态简条  
- 本轮不做完整 transcript 面板、并行 explore、worktree

### 5.6 risk

`spawn_explore` 标 **read**（本身不写盘，避免无意义审批弹窗）。

---

## 6. MCP（stdio）

### 6.1 设置

```js
skillsEnabled: true,
subagentEnabled: true,
mcpEnabled: false,
mcpServers: [], // { name, command, args?, env?, cwd? }[]
```

| 字段 | 规则 |
|------|------|
| `name` | 唯一，`^[a-zA-Z0-9_-]+$` |
| `command` | 非空字符串 |
| `args` | 可选 `string[]` |
| `env` | 可选 object，与 `process.env` 浅合并（仅子进程） |
| `cwd` | 可选；run 时可默认 `project.path` |

保存时：非数组或非法项丢弃；重名 **保留先出现**。`mcpEnabled === false` 或 servers 空 → 不 spawn。

### 6.2 生命周期（每主 run）

1. `onRunStart`：若启用则对各 server **串行**连接（实现简单、日志顺序清晰；单 server 失败不阻断后续）  
2. 单 server 失败 → `mcp-status` warning，跳过该 server  
3. `tools/list` 成功 → 合并本 run 工具表  
4. `onRunEnd` / `finally`：全部 disconnect（杀进程、清 pending）  
5. explore 子 run（`subagentDepth >= 1`）：**不**执行 MCP onRunStart

### 6.3 协议（最小，`mcp-client.js`）

1. `spawn(command, args, { env, cwd, stdio: 'pipe' })`  
2. 帧：`Content-Length: N\r\n\r\n` + UTF-8 JSON-RPC 2.0 body  
3. `initialize`（`protocolVersion` 固定为 `2024-11-05`）→ 等 result  
4. `notifications/initialized`  
5. `tools/list` → 缓存  
6. `tools/call` `{ name, arguments }`  
7. 单请求超时默认 **60s**；abort → 杀进程  
8. 进程异常退出 → 后续 call 返回 error，不崩主 loop

本轮不做：SSE/HTTP、resources、prompts、sampling、roots 动态更新。

### 6.4 命名与 schema

- 对外名：`mcp_<serverName>_<toolName>`  
- `toolName` 非 `[a-zA-Z0-9_]` → `_`；碰撞后缀 `_2`…  
- OpenAI function：`description` 来自 MCP；`parameters` 尽量用 `inputSchema`，缺省 `{ type:'object', properties:{} }`  
- 结果：序列化为字符串；过长截断（如 32 KiB）并标记 truncated

### 6.5 权限

| 模式 | 行为 |
|------|------|
| risk | `mcp_*` → `'mcp'` |
| plan | 不注册 mcp_*；`isPlanBlockedRisk` 含 `mcp` |
| confirm-writes | 与 write 同：需确认；`allow_session` 可记 `mcp` |
| full-auto | 放行 |
| read-only | 拒绝 |
| explore 子 run | 无 mcp 工具 |

### 6.6 UI

- 开关「启用 MCP」  
- 多行「MCP 服务器 JSON」+ placeholder  
- 非法 JSON：提示且不写坏配置  

本轮不做：逐 server 列表启停、OAuth、市场。

### 6.7 错误语义

| 情况 | 表现 |
|------|------|
| 连接失败 | 该 server 无工具；可选 status 事件 |
| call 超时/进程死 | `{ ok:false, error }` 给模型 |
| 用户拒绝审批 | 与既有 tool 拒绝一致 |
| abort | `ABORTED` / 已停止 |

---

## 7. 事件

| 常量建议 | 事件名 | 载荷 |
|----------|--------|------|
| `SUBAGENT_START` | `subagent-start` | `{ goal, maxTurns }` |
| `SUBAGENT_END` | `subagent-end` | `{ ok, summary?, error? }` |
| `MCP_STATUS` | `mcp-status` | `{ server, ok, error? }` |

既有 `tool-start` / `tool-result` 等对 skills / spawn_explore / `mcp_*` 复用。

---

## 8. 权限与模式总表

| 工具 | risk | plan | agent confirm-writes | agent full-auto | agent read-only | depth≥1 |
|------|------|------|----------------------|-----------------|-----------------|---------|
| list_skills / use_skill | read | ✅ | ✅ | ✅ | ✅ | ❌ |
| spawn_explore | read | ❌ | ✅（默认开） | ✅ | ✅ | ❌ |
| mcp_* | mcp | ❌ | 确认 / session | 放行 | ❌ | ❌ |
| 只读 builtin | read | ✅ | ✅ | ✅ | ✅ | ✅ 子集 |
| 写/删/终端/commit | 既有 | ❌ | 既有 | 既有 | 既有 | ❌ |

**代码改动要点：**

- `READ_TOOLS`：`list_skills`、`use_skill`、`spawn_explore`  
- `riskForTool`：`name.startsWith('mcp_')` → `mcp`  
- `PLAN_BLOCKED_RISKS`：增加 `mcp`  
- `PLAN_HIDDEN_TOOLS` / filter：隐藏 `spawn_explore`；mcp 前缀在 filter 或 provider 层去掉

---

## 9. 测试策略

| 模块 | 要点 |
|------|------|
| `extensions/registry` | 注册、路由、未知工具、onRunStart/End 顺序（含 finally） |
| `skills-loader` + provider | frontmatter、优先级、截断、开关、未知名 |
| explore | depth 拒绝、goal 过短、只读工具（mock chat）、abort、开关与 plan 隐藏 |
| mcp-client / hub | 帧编解码、超时、多 server 部分失败、命名碰撞 |
| permission / agent-mode | mcp risk、plan 拒 mcp、READ_TOOLS |
| agent 集成 | tools 列表随 settings / mode / depth 变化；list_skills execute |
| 回归 | 全量 `npm test` |

---

## 10. 实现顺序

1. settings 默认值 + 事件常量 + 测试  
2. **registry + builtin 包一层**（行为不变，全绿）  
3. skills-loader + skillsProvider + system 片段 + 斜杠 IPC + 内置示例 skill  
4. exploreProvider + 嵌套 loop 注入 + UI 简条  
5. mcp-client + hub + mcpProvider + 设置 UI  
6. README + 全量测试 + 文档中 C.3–C.5 路线图引用  

---

## 11. 与初版草稿差异

| 项 | 初版草稿 | 本批准规格 |
|----|----------|------------|
| 架构 | 外提模块直接改 agent | **ToolProvider 注册表**（方案 2） |
| 默认开关 | 未完全钉死 | Skills/子 Agent 开，MCP 关 |
| explore 工具 | plan 或专用过滤含糊 | **固定只读六件套**，无 submit_plan/skills/mcp |
| MCP 生命周期 | 方案 A 倾向 | **明确每主 run 连/断** |
| MCP 权限 | risk mcp ≈ write | **与 write 同级**（含 allow_session） |
| 后续范围 | 混在非目标 | **C.3 Hooks / C.4 子 Agent / C.5 MCP·Skills 增强** 路线图 |

---

## 12. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-20 | 初版草稿：Skills + explore + stdio MCP（外提模块） |
| 2026-07-20 | brainstorming 批准：升级为 ToolProvider 注册表；锁定开关/权限/生命周期；拆分 C.3–C.5 |
