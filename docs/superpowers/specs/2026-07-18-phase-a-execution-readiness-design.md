# Phase A Execution Readiness — Design Spec

**日期:** 2026-07-18  
**项目:** `codex-qq-desktop`  
**状态:** 已确认（brainstorming 2026-07-18）  
**依据:**
- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md`（Phase A 路线）
- `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md`（能力与架构真相）
- `docs/superpowers/plans/2026-07-17-phase-a-agent-core.md`（主执行脚本，待轻修订）

**目的:** 在 **不重写 Phase A 能力设计** 的前提下，把「已有 design + plan、代码实现度为 0」收敛为可立刻开工的执行就绪规格。

---

## 1. 目标与范围冻结

### 1.1 本规格做什么

产出一份 **执行就绪** 设计：冻结范围、标明代码基线、定义对现有 plan 的轻量修订、里程碑顺序、出口与回滚。  
**不**替代 Phase A agent-core design；**不**扩 Phase B/C。

### 1.2 能力范围（完全沿用 Phase A design）

| # | 能力 | 说明 |
|---|------|------|
| 1 | 局部编辑 | `search_replace` 为主；保留 `write_file` |
| 2 | 代码搜索 | `grep` + `glob`（纯 Node，不强制 ripgrep） |
| 3 | 权限分级 | `read-only` / `confirm-writes` / `full-auto`；默认 `confirm-writes`；写/删/终端走聊天区内联审批 |
| 4 | 过程可见 | `chat:event` 推送 tool 轨迹 |
| 5 | 流式输出 | 档位 B：每轮 assistant content 流式 + 工具事件点状推送 |
| 薄增强 | 上下文 | 基础 `.gitignore`、`AGENTS.md`/`CLAUDE.md` 注入、`read_file` 的 `offset`/`limit` |

### 1.3 明确不做（本阶段）

- Diff 面板 Accept/Reject、改前快照/撤销树  
- `apply_patch` / multi-hunk unified diff  
- MCP、子 Agent、Plan 模式、Skills、Hooks  
- Git 工具集、真实 PR、WebFetch  
- `tool_calls` 参数 token 级增量流式  
- 强制依赖 ripgrep、OS 级沙箱  
- 像素级 UI 重做、多窗口  

### 1.4 成功标准（Phase A 完成定义）

1. 绑定中型仓库上可完成：**grep 定位 → search_replace 改约 3 处（可确认）→ 可选终端 → 可中途停止**  
2. `npm test` 全绿  
3. 现有 plan Task 1–10 全部勾选完成  
4. README 说明新设置与行为；design §7.2 手工清单在 API 可用时完成（或记录未测项）

### 1.5 交付物

| 交付物 | 路径 | 职责 |
|--------|------|------|
| 本规格 | `docs/superpowers/specs/2026-07-18-phase-a-execution-readiness-design.md` | 为何现在做、基线、修订清单、里程碑、出口 |
| 能力设计（已有） | `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md` | 架构/工具/权限/流式/IPC 真相源 |
| 实现计划（轻修订） | `docs/superpowers/plans/2026-07-17-phase-a-agent-core.md` | Task 1–10 TDD 主执行脚本 |

---

## 2. 代码基线与差距

### 2.1 基线

| 项 | 值 |
|----|-----|
| 分支 | `dev` |
| 基线提交 | `9815e38`（feat: QQ 2007 style Codex desktop agent client） |
| 工作区（撰写时） | clean |
| Phase A 代码实现度 | **0**（design/plan 已有，业务代码未落地） |

### 2.2 可复用现状

- Electron 主进程 / preload / renderer 三进程，`contextIsolation`  
- `runAgentLoop` 多轮 function calling + 文本 tool 协议回退  
- 工具：`list_dir` / `read_file` / `write_file` / `delete_path` / `run_terminal`  
- 路径 `resolveSafe`、write fence、项目绑定扫盘  
- Abort：`已停止` + `code: 'ABORTED'` 约定（测试已覆盖）  
- 设置：local | api、agent 开关、终端开关  
- 测试：`node --test` via `npm test`

### 2.3 Phase A 缺口清单（全部待建）

**新文件：**

- `src/ai/permission.js`  
- `src/ai/search.js`  
- `src/ai/gitignore.js`  
- `src/ai/project-instructions.js`  
- `src/ai/agent-events.js`  

**既有文件必须改造：**

| 文件 | 改造要点 |
|------|----------|
| `src/ai/settings.js` | `permissionMode` 默认 `confirm-writes` |
| `src/ai/project-fs.js` | gitignore 进 list；`searchReplace`；read `offset`/`limit` |
| `src/ai/openai-compatible.js` | SSE stream + `onDelta`；失败回退非流式 |
| `src/ai/agent.js` | 新工具、Gate、`onEvent`、stream turn |
| `src/ai/terminal.js` | 审批改经 Gate，去掉主路径 MessageBox 依赖 |
| `src/main.js` | runId、`chat:event`、`chat:approve`、Gate 接线 |
| `src/preload.js` | `onChatEvent`、`approveChat` |
| `src/renderer/app.js` + `styles.css` + `index.html` | 轨迹、流式正文、审批卡片、权限设置 |
| `README.md` | Phase A 行为说明 |
| `tests/*` | 新建 permission/search/gitignore/project-instructions；扩展现有测试 |

### 2.4 实现风险与缓解

| 风险 | 缓解 |
|------|------|
| 默认 `confirm-writes` 改变「写即落盘」习惯 | README 写明；用户可切 `full-auto`；**不**把默认改回无确认 |
| 网关不支持 stream | 回退非流式整段 + 仍发 tool 事件（design §2.5） |
| 审批 Promise 死锁 | stop/destroy 必 resolve/deny 所有挂起审批 |
| plan 内历史路径 `D:\workspace\...` | 轻修订改为仓库相对路径 |
| 无 tools 的网关 | 保持文本协议；新工具名同样可解析 |

---

## 3. 对现有 plan 的轻量修订

### 3.1 原则

- **不改** Task 1–10 能力边界、接口形状、推荐顺序、TDD 步骤正文主干  
- **只做** 执行就绪修补，使 plan 可直接当开工脚本  

### 3.2 修订清单（writing-plans 阶段落实）

1. **文首 Status 块**  
   - Status: Not started  
   - Baseline: `9815e38`  
   - Specs: phase-a-agent-core-design + 本 execution-readiness  
2. **Global Constraints**  
   - 路径改为仓库相对（去掉 `D:\workspace\ai\codex-qq-desktop\` 硬编码）  
3. **每 Task 顶部**  
   - `Depends-on:` / 预计影响文件一行（便于依赖意识；执行仍串行）  
4. **勾选**  
   - 保持全 `- [ ]`；实现后由执行者勾选  
5. **Task 8 / 9**  
   - 补与当前符号挂钩：`chat:send`、`chat:stop`、`stopChat`、`sendChat` 等现有 preload/main 入口  
6. **Task 10**  
   - 验收显式映射 design §7.2 手工清单 + `npm test`  
7. **可选 Kickoff**  
   - 文末：先 `npm test` 基线绿 → 从 Task 1 开始  

### 3.3 明确不改

- 默认 `permissionMode: 'confirm-writes'`  
- Abort 约定（throw + `code: 'ABORTED'`）  
- 工具语义（search_replace 唯一匹配等）  
- 事件 type 枚举  
- 审批三按钮：`allow` / `deny` / `allow_session`  

### 3.4 文档职责边界

| 文档 | 读它回答什么 |
|------|----------------|
| capability-gap | 为什么要做 Phase A |
| phase-a-agent-core-design | 做成什么样（架构/契约） |
| phase-a-execution-readiness（本文） | 从当前仓库怎么开工、修订什么、何时算完 |
| phase-a-agent-core plan | 每一步测什么、写什么、怎么 commit |

---

## 4. 执行顺序与里程碑

Task 编号与现有 plan **一一对应，不重排**。里程碑仅作进度分组。

| 里程碑 | Tasks | 出口 |
|--------|-------|------|
| **M0 Kickoff** | 本文 commit + plan 轻修订 + 基线 `npm test` 绿 | 文档就绪、无回归起点 |
| **M1 策略与上下文** | Task 1–3 | permissionMode、事件常量、PermissionGate、gitignore、项目指令 |
| **M2 代码手术刀** | Task 4–5 | search_replace、read 分段、grep/glob |
| **M3 模型与循环** | Task 6–7 | stream API、agent 新工具 + Gate + 事件 |
| **M4 产品面** | Task 8–9 | IPC 事件/审批、renderer 轨迹/流式/卡片/设置 |
| **M5 收口** | Task 10 | 全量测试、README、手工验收记录 |

### 4.1 依赖要点

- **PermissionGate 必须先于** agent 改写（Task 2 → Task 7）  
- **stream 与纯工具函数** 可在不同 Task 内串行完成；合入 agent 前各自测试须绿  
- 推荐顺序仍为 Task 1 → 10，不跳步  

### 4.2 执行纪律

1. 实现阶段推荐 `subagent-driven-development` 或 `executing-plans`，严格按 plan TDD 勾选  
2. **每 Task 独立 commit**（message 沿用 plan 草稿）  
3. **不穿插 Phase B/C**；不混入无关工作区改动  
4. 中途失败：停在当前 Task，修复后再前进  
5. UI 文案：zh-CN  

---

## 5. 验收、回滚与后续动作

### 5.1 出口检查表

| # | 标准 | 验证 |
|---|------|------|
| 1 | 自动化全绿 | `npm test` |
| 2 | 局部编辑 | 单测 + 手工改注释非整文件覆盖 |
| 3 | 搜索 | 单测 + 手工 grep 本仓符号 |
| 4 | 权限 | 三档矩阵；拒绝不落盘；`allow_session` 跳过后续同 risk |
| 5 | 过程可见 | tool 轨迹实时；正文流式或降级整段 |
| 6 | 可停止 | 流式中 / 审批挂起 stop → 无脏写 |
| 7 | 上下文 | gitignore 生效；指令文件注入可观察 |
| 8 | 兼容 | local、list 快路径、无 tools 文本协议 |
| 9 | 文档 | README 更新 |
| 10 | Plan | Task 1–10 全部 `[x]` |

手工项映射：`2026-07-17-phase-a-agent-core-design.md` §7.2。

### 5.2 回滚策略

| 场景 | 策略 |
|------|------|
| 单 Task 测试失败 | 不提交半截；修到绿再 commit |
| 默认权限过严 | 用户改 `full-auto`；不改产品默认回无确认 |
| 流式不兼容 | 代码内降级，不整体回滚 Phase A |
| 需撤销整 Phase | 按 Task commit 反向 revert |

**硬约束：** 未 `allow` 前不得写盘；stop/destroy 必须结束挂起审批。

### 5.3 文档三角（落地后）

```
capability-gap (为何)
    → phase-a-agent-core-design (做什么)
        → phase-a-execution-readiness (如何从现状开工)  ← 本文
            → phase-a-agent-core plan (逐步执行)
```

### 5.4 Brainstorming 收口后的下一步

1. ~~分段确认本设计~~（已完成 2026-07-18）  
2. **写本文并 commit**  
3. **用户审阅本 spec**  
4. **Invoke writing-plans**：轻修订 `2026-07-17-phase-a-agent-core.md`  
5. 用户确认 plan 修订后 → **实现**（subagent-driven-development / executing-plans）  
6. 本规格阶段 **不写业务代码**

---

## 6. 已确认决策摘要

| 项 | 决策 |
|----|------|
| 范围 | 落地 Phase A only |
| 形态 | 按现有 plan 开工 + 轻量修订（方案 2） |
| 能力真相源 | 2026-07-17 phase-a-agent-core-design |
| 执行脚本 | 2026-07-17 phase-a-agent-core plan（轻修订） |
| Task 顺序 | 1–10 不重排 |
| 默认权限 | `confirm-writes` |
| 流式 | 档位 B + 网关回退 |
| 架构 | 工具 + 权限 + 事件三层（design 方案 2） |

---

## 7. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-18 | 初版：brainstorming 确认的 Phase A 执行就绪设计 |
