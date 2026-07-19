# Phase C.1 — 编排层设计规格（Plan 模式 + 验证模板）

**日期:** 2026-07-20  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase A Agent 核心；Phase B 工程闭环（`ddde5a5`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §8 Phase C
- `docs/superpowers/specs/2026-07-19-phase-b-engineering-loop-design.md`（明确延后 MCP/Plan/子 Agent/Skills）
- 本轮 brainstorming 锁定决策（见 §1.2）

---

## 1. 目标与范围

### 1.1 一句话目标

用户可在 **`plan` 档位**下安全只读探索并产出**结构化计划**，点 **「批准执行」** 后自动切到 **`agent`** 按计划改代码；在 **`agent`** 下收工前尽量跑 **`verifyCommand`**，并在 UI 展示验证结果。

### 1.2 本 Phase 交付（C.1 编排优先）

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **Plan 模式** | 会话级 `plan \| agent`；plan 下禁写/删/终端/commit；强制工具 `submit_plan`；计划卡 + **批准执行**（切 agent + 自动发执行消息） |
| 2 | **验证模板** | 可配置/可探测 `verifyCommand`；有成功写盘时收工前软门闩提示跑测；事件 + UI 状态条；**不**硬挡 commit |

### 1.3 非目标（C.2+ 硬边界）

- MCP 客户端  
- 子 Agent / 并行 explore  
- Skills 目录 / 插件加载器 / Hooks 生态  
- 多计划版本树、完整计划编辑器、自动保存 `PLAN.md`  
- 未跑 verify 时硬挡 `git_commit` 或禁止 `done`  
- PTY、push/PR 增强、双 `runAgentLoop` 重写  

### 1.4 成功标准（出口）

1. 会话为 `plan` 时模型无法落盘写文件 / commit / 跑终端（工具不注册 + Gate 拒绝）。  
2. 调用 `submit_plan` 后出现计划卡；**批准执行** → `agentMode=agent` 且自动发送含计划正文的执行消息并开跑。  
3. 存在可解析的 `verifyCommand` 且本 run 有成功写/删时，收工路径会尽量触发验证，UI 显示通过/失败/跳过。  
4. `npm test` 全绿；无 MCP/子 Agent/Skills 实现混入。  
5. 切到 `agent` 后既有 `permissionMode`（confirm-writes / full-auto / read-only）行为与 Phase A/B 一致。

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 范围切分 | 仅 Plan + 验证；MCP/子 Agent/Skills → C.2 |
| 实现形态 | **方案 1**：单 `runAgentLoop` + 模式入参；**强制 `submit_plan`** 强化计划结构 |
| Plan 形态 | 会话档位 `plan \| agent`（非全局锁死、非纯 prompt） |
| 计划产出 | 仅 plan 模式注册 `submit_plan`；事件 `plan-ready` |
| 批准执行 | 切 agent + **自动**合成 user 消息开跑 |
| 与 permissionMode | **plan 覆盖写风险**；切 agent 后 permissionMode 照常 |
| 模式存储 | **每会话独立** localStorage；默认 `agent`；新建会话用 `defaultAgentMode` |
| 验证 | 软门闩 B：应跑 + UI；失败后再多 1 轮提示后允许收工 |
| 验证触发 | 仅 agent + 本 run 曾成功写/删 + 命令可解析 + 终端可用策略见 §5 |

---

## 3. 总体架构

### 3.1 分层

```
Renderer
  ├ agentMode 切换（会话 plan | agent）
  ├ 计划卡（plan-ready）+ 批准执行 / 驳回
  └ 验证条（verify-result）

Preload
  ├ chat:send（+ agentMode）
  ├ chat:approvePlan / 可选 rejectPlan
  └ 既有 onChatEvent / approveChat / terminal / atRef / git

Main
  ├ chat:send → runAgentLoop({ agentMode, ... })
  ├ chat:approvePlan → mode=agent + 合成消息 + 新 run
  └ settings: defaultAgentMode, verifyCommand, verifyBeforeDone

Agent 层（扩展，非双 Loop）
  ├ toolsForSettings(settings, { agentMode })
  ├ submit_plan 工具
  ├ Gate / authorizeTool：plan 下拒 write/delete/terminal
  └ 收工前 verify 软门闩

共享：Phase A/B PermissionGate、chat:event、run_terminal、git、diff、@
```

### 3.2 建议源码布局

```
src/ai/agent-mode.js     # 可选：PLAN 阻断 risk、执行消息模板、mode 校验
src/ai/verify.js         # resolveVerifyCommand
src/ai/agent-events.js   # PLAN_READY, VERIFY_RESULT, （可选 PLAN_APPROVED）
src/ai/agent.js          # 工具过滤、submit_plan、verify 插轮、authorize 叠加
src/ai/permission.js     # 可选 authorize 接受 agentMode
src/ai/settings.js       # defaultAgentMode, verifyCommand, verifyBeforeDone
src/main.js              # approvePlan、send 透传 mode
src/preload.js
src/renderer/*           # 模式切换、计划卡、验证条
tests/agent-mode|verify|agent*.test.js
```

### 3.3 与 Phase A/B 关系

- 不重写双 Loop；同一 `runAgentLoop` 增加 `agentMode` 与 verify 状态。  
- `agent` 下 diff 审批、git、终端面板、`@` 与 B 一致。  
- `plan` 下：不注册写/删/终端/commit；fence 写盘仍经 Gate 且必拒。  

---

## 4. Plan 模式

### 4.1 会话状态

| 字段 | 位置 | 说明 |
|------|------|------|
| `agentMode` | 会话（localStorage） | `'plan' \| 'agent'`，默认 `'agent'` |
| `pendingPlan` | 会话内存（可持久） | 最近 `submit_plan`：`{ planId, title, markdown, steps }` |
| `defaultAgentMode` | settings | 仅**新建会话**初始值，默认 `'agent'` |

**写死：** `runAgentLoop` / activeRun 进行中 **禁止**切换 `agentMode`（控件 disabled 或提示先停止）。

### 4.2 工具可见性（第一道闸）

`toolsForSettings(settings, { agentMode })`：

| 工具 | agent | plan |
|------|-------|------|
| list_dir, read_file, grep, glob | ✅ | ✅ |
| git_status, git_diff | ✅ | ✅ |
| search_replace, write_file, delete_path | ✅* | ❌ 不注册 |
| git_commit | ✅* | ❌ |
| run_terminal | 视 terminalEnabled | ❌ |
| **submit_plan** | ❌ 不注册 | ✅ **必须暴露** |

\* 仍受 `permissionMode` 约束。

### 4.3 权限（第二道闸）

```
if (agentMode === 'plan' && risk ∈ { write, delete, terminal }) {
  return { allowed: false, reason: '当前为计划模式，仅允许只读与提交计划' };
}
// 否则走既有 permissionMode 矩阵
```

`submit_plan` 的 risk = **`read`**（默认允许，不弹审批）。

`git_commit` 在 agent 下 risk 仍为 **`write`**（Phase B）。

### 4.4 `submit_plan` 契约

**参数：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `markdown` | 是 | 计划正文；trim 后长度 **&lt; 10 → ok:false** |
| `title` | 否 | 短标题 |
| `steps` | 否 | `string[]`，UI 有序列表 |

**语义：**

1. 不写磁盘。  
2. 生成 `planId`；`onEvent({ type: 'plan-ready', planId, title, markdown, steps })`。  
3. 返回 `{ ok: true, planId, message: '计划已提交，等待用户批准执行' }`。  
4. **同一 run 多次 submit**：后者覆盖当前 pending（新 planId）；旧卡按钮失效。  
5. markdown 展示/注入上限约 **32 KiB**，超限截断并注明。

### 4.5 System 提示（plan 追加）

- 当前为计划模式：只读调研 + 必须用 `submit_plan` 交计划。  
- 禁止声称已改文件；批准前不假设会执行。  
- 计划须含：目标、步骤、涉及路径、风险、建议验证方式。  

**不**强制「无 submit_plan 不许 done」（避免死锁）；靠 system 引导。

### 4.6 计划卡 UI

| 区域 | 内容 |
|------|------|
| 标题 | `title` 或「实施计划」 |
| 正文 | Markdown lite |
| 步骤 | 可选 `steps` 有序列表 |
| 按钮 | **批准执行** / **驳回** |

**驳回：** 不改 mode；不自动发消息；关闭或标记 rejected。  
**批准：** §4.7。

### 4.7 批准执行数据流

```
批准执行
  → chat:approvePlan({ sessionId, planId })
  → main:
      1. planId 必须匹配当前 pending，否则 error
      2. 若 activeRun 存在 → 拒绝（先停止）
      3. 通知 renderer：agentMode = 'agent'
      4. 合成 user 消息（写入历史，用户可见）：
         「请严格按以下已批准计划执行。不要重新规划，除非发现计划不可行。

         # {title}
         {markdown}
         」
      5. 启动与 chat:send 相同的 agent 路径（新 runId，agentMode:'agent'）
  → 可选：本 run system 一句「用户已批准计划，见最近 user 消息」
```

计划正文主要放在 **user 消息**，不长期挂在全局 system，避免污染后续无关轮次。

### 4.8 chat:send

payload 增加 `agentMode: 'plan' | 'agent'`。  
**Renderer 为 mode 的 source of truth**；main 以 payload 为准。

### 4.9 事件

| 事件 | 载荷要点 |
|------|----------|
| `plan-ready` | `{ runId, planId, title?, markdown, steps? }` |
| `plan-approved` | `{ planId, sessionId }`（可选） |
| `plan-rejected` | `{ planId }`（可选） |

### 4.10 Plan 错误边界

| 情况 | 行为 |
|------|------|
| plan 下 write / fence | 不注册或 Gate 拒绝，磁盘不变 |
| 批准时 planId 过期 | error，toast |
| 批准时 run 进行中 | 拒绝 |
| 停止 | 与 Phase A 一致；计划卡可保留 |

---

## 5. 验证模板

### 5.1 命令解析

`resolveVerifyCommand(projectPath, settings) → string | null`：

1. `settings.verifyCommand` 非空 → 使用  
2. 值为 `none` 或 `-`（trim 后大小写不敏感 **none**）→ **禁用**，返回 `null`  
3. 否则若项目根 `package.json` 有 `scripts.test` → `npm test`  
4. 否则 `null`（不插轮）

**本轮不做：** 从 AGENTS.md NLP 抽命令；多命令流水线。

| 设置键 | 默认 | 说明 |
|--------|------|------|
| `verifyCommand` | `''` | 空=自动探测 |
| `verifyBeforeDone` | `true` | false 时不插轮 |

### 5.2 触发条件（软门闩）

在最终自然语言返回前（write-fence 处理完、`appendAgentFooter` 之前）：

**同时满足**才考虑插轮：

- `agentMode === 'agent'`  
- `verifyBeforeDone !== false`  
- `verifyCmd` 非 null  
- 本 run 曾有**成功**写/删（applied / fileChanges）  
- 终端策略允许尝试（见下）

| 情况 | 行为 |
|------|------|
| 无成功写/删（纯问答） | 不插轮 |
| 本 run 已对 **同一 verifyCmd** `run_terminal` 且 exit 0 | 视为已验证；发 `verify-result` ok；收工 |
| 未验证且 turns 有剩余 | 向 working 追加提示，令模型立刻 `run_terminal` 执行该命令；`verifyPrompted=true`；continue |
| 已 prompted 模型仍 final | **允许收工**；`verify-result` skipped/incomplete |
| prompted 后命令失败 | `verify-result` ok:false；**最多再 1 轮**修复提示，然后允许收工并带失败状态 |
| plan 模式 | 永不自动 verify |
| `terminalEnabled === false` | 不插轮；可发 skipped（终端未启用） |
| 用户拒绝终端审批 | 记失败/跳过，允许收工 |

### 5.3 权限

验证经现有 `run_terminal` + PermissionGate（confirm-writes 可能弹终端审批）。

### 5.4 事件与 UI

```js
{
  type: 'verify-result',
  runId,
  command: string,
  ok: boolean,
  skipped?: boolean,
  code?: number,
  summary?: string
}
```

UI 条（zh-CN）：验证中 / ✅ 通过 / ❌ 失败 / ⚠ 未验证。  
完整日志以终端面板 `TERMINAL_*` 为准，不强制塞进聊天正文。

### 5.5 System 提示（agent + 有 verifyCmd）

完成修改后应 `run_terminal` 执行约定命令；失败则根据输出修复或说明阻塞。

### 5.6 验证错误边界

| 情况 | 行为 |
|------|------|
| 超时 | verify-result ok:false |
| 无 package.json test 且无设置 | null，安静跳过 |

---

## 6. 设置、IPC、错误总则

### 6.1 IPC

| API | 用途 |
|-----|------|
| `chat:send` + `agentMode` | 启动 run |
| `chat:approvePlan` | 批准并自动执行 |
| `chat:rejectPlan` | 可选；或纯前端 |
| `chat:event` | `plan-ready`、`verify-result` 等 |

### 6.2 错误总则

- 工具失败 → JSON error，不崩 loop  
- plan 拒写文案统一中文  
- Abort：`code:'ABORTED'`，消息匹配 `/已停止/`  
- 禁止 plan 下伪造成功写入  
- approvePlan 失败可恢复，不改坏 session mode（失败则保持 plan）  

### 6.3 测试策略

| 模块 | 要点 |
|------|------|
| tools 过滤 | plan 无 write/terminal/commit，有 submit_plan |
| Gate | plan 下 deny write |
| submit_plan | 事件 + 短 markdown 拒绝 |
| verify resolve | settings / none / package.json |
| verify 插轮 | 有写盘则多一轮；已成功则不重复；plan 不插 |
| 回归 | 全量 `npm test` |

### 6.4 实现顺序建议

1. settings + `agentMode` 入参 + 工具过滤 + Gate  
2. `submit_plan` + 事件 + 计划卡 + 模式 UI  
3. `approvePlan` 自动执行  
4. `verify.js` + 软门闩 + 验证条  
5. README + 手工验收  

### 6.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| 模型不调 submit_plan | system 引导；不强制死锁 |
| 计划过长 | 32KiB 截断 |
| 终端确认与 verify 拉锯 | 软门闩 + skipped |
| agent.js 膨胀 | 外提 agent-mode / verify |
| 范围爬到 MCP | 硬非目标；评审拒收 |

---

## 7. 文档与后续

| 产物 | 路径 |
|------|------|
| 本规格 | `docs/superpowers/specs/2026-07-20-phase-c-orchestration-design.md` |
| 实现计划 | 用户审阅本 spec 后由 **writing-plans** 生成 |

**相关文档：**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md`
- `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md`
- `docs/superpowers/specs/2026-07-19-phase-b-engineering-loop-design.md`
- `README.md`（实现后更新 C.1 用法）

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-20 | 初版：C.1 Plan + 验证；brainstorming 批准后落盘 |
