# Phase C.3 — Hooks 设计规格（配置驱动生命周期钩子）

**日期:** 2026-07-21  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase C.2 平台化 — registry / Skills / explore / MCP stdio（`6bb7122`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §6.3 项 17、§5.2 Hooks
- `docs/superpowers/specs/2026-07-20-phase-c2-platform-design.md` §1.3 / §1.5（C.3 = Hooks 挂 registry execute 前后；本规格落地）
- 本轮 brainstorming 锁定决策（见 §2）

---

## 1. 目标与范围

### 1.1 一句话目标

在主 `runAgentLoop` 外侧引入 **配置驱动、外部命令** 的 Hooks 运行时，覆盖工具前后与会话级生命周期，使安全策略与自动化流水线 **不改 ToolProvider / 不改源码** 即可扩展。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **hooks-loader** | 读取 userData + 项目 `.codex/hooks.json`，校验 `version`，按 event 合并规则列表 |
| 2 | **hooks-runner** | matcher 匹配、串行 `spawn`（`shell: false`）、超时/Abort、解析 stdout JSON |
| 3 | **生命周期** | `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` |
| 4 | **Pre 强语义** | `allow` / `deny` / 改 `args` / `skip`（短路结果）；与 PermissionGate 双次校验 |
| 5 | **设置与 UI** | `hooksEnabled`；设置页规则摘要；聊天轨迹 `hook-start` / `hook-end` |
| 6 | **测试与文档** | loader/runner/gate 时序单测；README Phase C.3 小节 + 示例配置说明 |

### 1.3 非目标（硬边界）

- 项目内任意 JS 模块作为 hook 运行时（不 `require` 用户脚本）
- 可视化 hooks 规则编辑器 / 完整管理 GUI
- HTTP / 远程 webhook 触发
- 同 event 内并行多 hook
- 完整正则 matcher（仅 `*`、前缀 `mcp_*`、`a|b` OR）
- Hooks 放宽 `permissionMode` 或写入 session allow 列表
- explore 子 Agent（`subagentDepth >= 1`）内执行用户 Hooks
- C.4 子 Agent 增强、C.5 MCP SSE/HTTP / Skills 可执行
- 新 npm 依赖（纯 Node CommonJS）

### 1.4 成功标准

1. `hooksEnabled: false` 或两层配置皆空时，行为与 C.2 完全一致（零可见 hook 事件）。  
2. 用户级 + 项目级规则按「用户先、项目后」串行；matcher 正确过滤工具名。  
3. Pre：`allow` / `deny` / 改参后 **Gate₂** / `skip` 均符合 §4–§5；**skip 不能绕过 Gate₁**。  
4. Post / SessionStart / UserPromptSubmit / Stop 单条失败或超时 **不阻断** 主流程。  
5. Pre 失败、非 JSON、exit≠0、超时 → **deny**（工具不执行）。  
6. `subagentDepth >= 1` 不跑 hooks。  
7. 设置页可见路径与按 event 计数；轨迹展示 hook 起止/拒绝/短路（zh-CN）。  
8. `npm test` 全绿；无新 npm 依赖；无任意 JS hook 运行时、无 hooks GUI 编辑器。

### 1.5 平台化路线图（记账）

| 阶段 | 内容 |
|------|------|
| C.2（已交付） | Registry + Skills + explore + MCP stdio |
| **C.3（本规格）** | Hooks（配置 + 外部命令 + 生命周期） |
| C.4 | 子 Agent 增强：implement、并行、depth、transcript UI |
| C.5 | MCP SSE/HTTP；Skills 可执行/自动路由；MCP/Hooks 更强设置 UI |

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 目标 | 安全策略 + 自动化流水线（最小可用且生命周期更全） |
| 形态 | **配置 + 外部命令**（`spawn`，`shell: false`） |
| 生命周期 | `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` / `UserPromptSubmit` |
| Pre 能力 | 允许 / 拒绝 / **改 args** / **短路 skip** |
| 配置位置 | 用户 `{userData}/hooks.json` + 项目 `.codex/hooks.json` **分层合并** |
| 与 Gate | **Gate₁ → Pre →（args 变则 Gate₂）→ 执行或 skip → Post** |
| Pre 失败/超时 | **deny**（保守） |
| 其它事件失败 | 记日志 / 事件，**不阻断** |
| UI | 轨迹事件 + 设置总开关 + 已加载规则摘要（不编辑） |
| 实现形态 | **方案 1：hooks-runner 薄层挂在 registry 外**（不改 ToolProvider） |
| 默认开关 | `hooksEnabled: true`（无规则时 runner 空跑） |
| 子 Agent | `subagentDepth >= 1` **跳过**全部 hooks |
| 依赖 | 无新 npm 依赖 |

---

## 3. 架构

### 3.1 总览

```
┌─ 配置 ──────────────────────────────────────┐
│ userData/hooks.json  +  project/.codex/hooks.json │
│            ↓ merge（用户先，项目后）           │
│         hooks-loader → ResolvedHooks          │
└──────────────────────┬───────────────────────┘
                       │
┌─ runAgentLoop（depth===0） ──────────────────┐
│  registry.onRunStart                         │
│  SessionStart                                │
│  UserPromptSubmit                            │
│  … 模型轮次 …                                │
│    Gate₁ → PreToolUse → [改参则 Gate₂]       │
│         → execute | skip 结果                │
│         → PostToolUse                        │
│  finally: Stop → registry.onRunEnd           │
└──────────────────────────────────────────────┘
```

- ToolProvider / `createRegistry` **不感知** hooks。  
- MCP 的 `onRunStart`/`onRunEnd` 与 Hooks 独立；顺序：`onRunStart` → SessionStart；Stop → `onRunEnd`。

### 3.2 新模块（拟）

| 路径 | 职责 |
|------|------|
| `src/ai/hooks-loader.js` | 读文件、校验、合并、`matchTool(matcher, name)` |
| `src/ai/hooks-runner.js` | 按 event 跑规则：spawn、超时、Abort、解析响应、发事件 |
| `src/ai/settings.js` | `hooksEnabled` 默认 `true` |
| `src/ai/agent-events.js` | `HOOK_START` / `HOOK_END`（及可选归入 end 的 deny 信息） |
| `src/ai/agent.js` | 挂生命周期与工具路径包装 |
| `src/main.js` / `preload.js` | 传 `userDataPath`；`hooks:summary` IPC |
| `src/renderer/*` | 设置开关与摘要；轨迹渲染 |
| `tests/hooks-*.test.js` | loader / runner / 与 gate 集成 |
| `README.md` | Phase C.3 用法 |

可选：协议常量与截断工具放在 `hooks-runner.js` 内，不强制第三文件。

### 3.3 运行时注入

`runAgentLoop` 在 `depth === 0` 且 `settings.hooksEnabled !== false` 时：

```js
const hooks = await loadHooks({ userDataPath, projectPath: project.path });
// runCtx.hooks = hooks; runner 持有 hooks + onEvent + signal
```

`userDataPath` 由 main 传入（与 settings 同源）；测试可直接注入 `ResolvedHooks` 或 mock runner。

---

## 4. 配置格式与合并

### 4.1 路径

| 层 | 路径 |
|----|------|
| 用户 | `{userData}/hooks.json` |
| 项目 | `{projectRoot}/.codex/hooks.json` |

文件缺失 → 该层空数组，不抛错。

### 4.2 JSON 形状

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|search_replace",
        "command": "node",
        "args": [".codex/scripts/pre-write.js"],
        "timeoutMs": 15000,
        "cwd": "project"
      }
    ],
    "PostToolUse": [],
    "Stop": [],
    "SessionStart": [],
    "UserPromptSubmit": []
  }
}
```

### 4.3 规则字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `matcher` | 是* | 见 §4.4；非工具事件可省略，视为 `*` |
| `command` | 是 | 可执行文件路径或 PATH 上命令名 |
| `args` | 否 | `string[]`，原样传给 spawn |
| `timeoutMs` | 否 | 默认 `15000`；钳制 `1000..120000` |
| `cwd` | 否 | `"project"`（默认）\| `"userData"` \| 项目根下相对路径；**禁止**任意绝对路径跳出约定根（见 §6） |
| `env` | 否 | 额外环境变量浅合并；不得用于注入 API Key |

非法规则（缺 command、args 非数组等）：跳过该条，计入 `errors[]` / 加载 warning，不拖垮整层。

`version !== 1`（或非数字）：**整层忽略**，summary / 日志记一条错误。

### 4.4 matcher

| 模式 | 含义 |
|------|------|
| `*` | 全部工具名 |
| `write_file` | 精确匹配 |
| `mcp_*` | 仅支持 **末尾一个** `*` 的前缀匹配 |
| `a\|b\|c` | OR（拆 `|` 后对每段同上） |

**不做** 完整正则。  
`SessionStart` / `UserPromptSubmit` / `Stop`：matcher 为 `*` 或省略 → 匹配；若写成具体工具名 → **不匹配**（该条跳过）。

### 4.5 合并

1. 校验并规范化每层。  
2. 每个 event：`rules = [...userRules, ...projectRules]`。  
3. 同 event **严格串行** 按 `rules` 顺序。  
4. Pre：deny / 失败 / 超时 / skip → **停止后续 Pre**。  
5. 其它 event：单条失败继续下一条。

### 4.6 设置摘要 API

`hooks:summary` 返回：

```json
{
  "enabled": true,
  "userPath": "…/hooks.json",
  "projectPath": "…/.codex/hooks.json",
  "countsByEvent": {
    "PreToolUse": 2,
    "PostToolUse": 1,
    "Stop": 0,
    "SessionStart": 0,
    "UserPromptSubmit": 0
  },
  "errors": []
}
```

无绑定项目时 `projectPath` 可为 `null`，项目层计数 0。

---

## 5. 命令协议与 Pre 语义

### 5.1 进程

- `spawn(command, args, { cwd, env, windowsHide: true, shell: false })`
- stdin：UTF-8 JSON，写完 `end()`
- stdout：整段 trim 后 `JSON.parse`
- stderr：截断（建议 8 KiB）仅诊断
- 超时：杀子进程 → 该条失败
- `signal` abort：杀子进程；工具路径上未完成则按现有 `ABORTED` 上抛

### 5.2 stdin payload（通用）

```json
{
  "event": "PreToolUse",
  "timestamp": "2026-07-21T12:00:00.000Z",
  "sessionKey": "…",
  "agentMode": "agent",
  "subagentDepth": 0,
  "projectPath": "D:/work/my-app",
  "permissionMode": "confirm-writes",
  "tool": {
    "name": "write_file",
    "risk": "write",
    "args": { "path": "a.js", "content": "…" }
  },
  "result": null,
  "run": {
    "aborting": false,
    "reason": null
  },
  "promptPreview": null
}
```

| 事件 | tool | result | 其它 |
|------|------|--------|------|
| PreToolUse | 当前 name/args/risk | `null` | — |
| PostToolUse | 最终 name/**生效 args**/risk | 结果对象摘要 | `flags`: `deniedByGate` / `deniedByHook` / `skipped` |
| SessionStart | `null` | `null` | — |
| UserPromptSubmit | `null` | `null` | `promptPreview` 截断用户文本 |
| Stop | `null` | `null` | `run.reason`: `done` \| `aborted` \| `error` |

**截断：** 单字符串字段默认 ≤ 8 KiB；整包 JSON ≤ 256 KiB；超长替换为明确截断标记。  
**禁止** 将 `settings.apiKey`、MCP 机密 env 写入 payload 或 hook `env`。  
hook `env` = 过滤后的 `process.env` + 规则 `env` + 只读元数据（如 `CODEX_QQ_EVENT`、`CODEX_QQ_PROJECT`）。

### 5.3 PreToolUse stdout

| 字段 | 说明 |
|------|------|
| `decision` | `"allow"` \| `"deny"` \| `"skip"` |
| `reason` | 可选，UI / 工具错误文案 |
| `args` | 仅 `allow`：对当前 `tool.args` **按键覆盖**（给出的键替换，未给出的保留） |
| `result` | 仅 `skip`：作为工具返回；对象则 `JSON.stringify`；缺省 `{ ok: true, skipped: true, by: "hook" }` |

兼容：

| 情况 | 行为 |
|------|------|
| exit 0 + 空 stdout | `allow` |
| exit ≠ 0 | **deny** |
| stdout 非 JSON | **deny** |
| 超时 / spawn 失败 | **deny** |

### 5.4 Pre 串行算法

1. `args ← args₀`（Gate₁ 已通过后的参数）。  
2. 对每条匹配的 Pre 规则：  
   - `deny` / 失败 / 超时 → `result = { ok: false, error: reason }`，停止 Pre，进入 Post。  
   - `skip` → 规范化 `result`，停止 Pre，**不**真实执行，进入 Post（`skipped: true`）。  
   - `allow` + 可选新 args → 若 args 相对本条入口有变化 → **Gate₂**；拒绝则同 deny 路径；允许则 `args` 更新，下一条 Pre。  
3. 全部 allow → `registry.execute` / 现有 search_replace preview 写盘路径，使用最终 `args`。

### 5.5 非 Pre 事件响应

- 不解析业务 decision；exit≠0 / 超时 / 异常 → `hook-end` `ok: false`，继续。  
- 可选 stdout `{ "message": "…" }` 写入 `hook-end`（截断）。

### 5.6 skip 与副作用

- skip **不** 更新 `applied` / `fileChanges`（避免假写污染 UI 与统计）。  
- skip 的 `run_terminal` **不** 计 verify 成功。  
- 模型仍收到 skip 的 JSON 结果（可含 `skipped: true`）。

---

## 6. 安全硬约束

| 规则 | 说明 |
|------|------|
| `shell: false` | 禁止 shell 字符串拼接执行 |
| cwd | 仅 `project` / `userData` / 解析后仍在 **项目根之内** 的相对路径；非法 cwd → 该规则失败（Pre=deny，其它=跳过） |
| 路径与写盘 | 改写后的 path 等仍走 `resolveSafe` + Gate |
| Gate 权威 | Hooks 不能放宽 permissionMode；不能改 session allow |
| skip 与 Gate₁ | **必须先过 Gate₁** 才进入 Pre；未授权则钩子无法 skip 伪造成功 |
| 子 Agent | `subagentDepth >= 1` 整表跳过 hooks |
| 机密 | API Key 与 MCP 机密永不进 hook 环境与 stdin |
| 并发 | 同 run 内 hook 子进程串行，同时最多一个 |

---

## 7. 生命周期挂点与 Gate 时序

### 7.1 主 run 事件表

| 事件 | 时机 | 失败策略 |
|------|------|----------|
| SessionStart | `registry.onRunStart` 之后、拼 system / 进模型循环之前 | 不阻断 |
| UserPromptSubmit | 用户消息确定后、**第一次**模型请求前 | 不阻断 |
| PreToolUse | 每个工具：Gate₁ 通过后 | deny 等 → 不执行工具 |
| PostToolUse | 工具有最终结果后（含 Gate 拒绝、Pre deny、skip、真实执行） | 不阻断 |
| Stop | `finally` 内、`registry.onRunEnd` **之前**；`reason`: `done` \| `aborted` \| `error` | 不阻断；abort 时 `timeoutMs` 上限压到 ≤ 5s |

### 7.2 单工具时序

```
1. 解析 name, args₀
2. tool-start
3. Gate₁(name, args₀)
   ├─ 拒绝 → result = 未授权 JSON → 跳到 Post（flags.deniedByGate）
   └─ 允许 ↓
4. PreToolUse 串行
   ├─ deny/失败/超时 → result 错误 JSON → Post（deniedByHook）
   ├─ skip → result = hook 结果 → Post（skipped）
   └─ allow [+ 改参 → Gate₂ 重算 diff/审批如需]
5. 真实执行（search_replace 已批准 preview 或 registry.execute）
6. agentLog / fileChanges / verify 跟踪（skip 不写 applied/fileChanges）
7. PostToolUse
8. tool-end
```

**Gate₂：** 仅当某条 Pre 修改了 args 后触发；`search_replace` / `write_file` 等若 args 变化需 **重新计算 diff** 并可能再次弹审批卡。

**plan 模式：** 挂点相同；Gate 仍拦写；skip 同样不能绕过 Gate₁。

### 7.3 与现有子系统

| 子系统 | 关系 |
|--------|------|
| PermissionGate | 唯一授权权威 |
| registry | 无 hooks 感知 |
| verify 软门闩 | 仅真实终端成功计数 |
| MCP / Skills | 可被 matcher 匹配 |

---

## 8. UI、IPC 与事件

### 8.1 设置

- `hooksEnabled` 开关（默认 true）  
- 只读：用户/项目路径、`countsByEvent`、加载 `errors`  
- 打开设置或「刷新 hooks」调用 `hooks:summary`

### 8.2 轨迹事件

| 常量 | type 字符串 | 主要字段 |
|------|-------------|----------|
| `HOOK_START` | `hook-start` | `event`, `matcher`, `command`, `toolName?` |
| `HOOK_END` | `hook-end` | `event`, `ok`, `decision?`, `reason?`, `durationMs`, `skipped?` |

无匹配规则时 **不** 发事件（避免刷屏）。  
文案 zh-CN，例如：「钩子 PreToolUse · write_file」「钩子拒绝：…」「钩子短路」。

### 8.3 preload

暴露 `hooksSummary(projectPath?)`（或等价 IPC），与现有 skills 列表风格一致。

---

## 9. 测试计划

| 文件 | 覆盖 |
|------|------|
| `tests/hooks-loader.test.js` | 缺文件、坏 JSON、version、合并顺序、matcher（`*` / 精确 / 前缀 / OR） |
| `tests/hooks-runner.test.js` | allow / deny / skip / 改参、超时、非 JSON、exit≠0、Abort、截断 |
| `tests/agent.test.js` 或 `hooks-integration.test.js` | Gate₁→Pre→Gate₂；skip 不绕过 Gate₁；depth≥1 不跑；Post 在 Gate 拒绝后仍可调用 runner |
| `tests/settings.test.js` | `hooksEnabled` 默认 true |
| 事件常量 | `HOOK_START` / `HOOK_END` 存在 |

用临时目录与 `node -e` / 小脚本作为 hook 命令，无外网、无新依赖。

---

## 10. 文档

- 本规格：`docs/superpowers/specs/2026-07-21-phase-c3-hooks-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-21-phase-c3-hooks.md`（writing-plans 阶段）
- README：Phase C.3 小节（开关、两层路径、matcher、Pre 决策、与 Gate 关系、示例 `hooks.json`）

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 钩子拖慢对话 | 默认 15s 超时、串行、可关 `hooksEnabled` |
| 改参导致二次审批烦扰 | 文档说明；脚本应少改敏感字段 |
| 坏 Pre 脚本挡写入 | 有意保守；用户关 hooks 或修配置 |
| agent.js 膨胀 | runner 薄 API；逻辑单测在 hooks-* |
| Windows 杀进程 | 与现有 terminal 模式对齐；测试覆盖超时路径 |

---

## 12. 实现顺序建议（供 plan 拆任务）

1. settings + agent-events  
2. hooks-loader（纯函数 + 测试）  
3. hooks-runner（spawn + 协议 + 测试）  
4. agent.js 挂 SessionStart / UserPromptSubmit / Stop  
5. agent.js 工具路径 Gate₁/Pre/Gate₂/Post  
6. main / preload / renderer 摘要与轨迹  
7. README + 全量 `npm test`

---

## 13. 附录：最小示例

**项目 `.codex/hooks.json`：**

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_terminal",
        "command": "node",
        "args": [".codex/scripts/deny-rm.js"],
        "timeoutMs": 5000
      }
    ],
    "PostToolUse": [
      {
        "matcher": "write_file|search_replace",
        "command": "node",
        "args": [".codex/scripts/log-write.js"]
      }
    ],
    "Stop": [],
    "SessionStart": [],
    "UserPromptSubmit": []
  }
}
```

**deny-rm.js（示意）：** 读 stdin，若 `tool.args.command` 匹配危险模式则打印 `{"decision":"deny","reason":"禁止危险命令"}` 并以 exit 0 退出；否则 `{"decision":"allow"}`。
