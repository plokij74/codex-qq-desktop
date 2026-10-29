# Phase E2 实施记录：统一消息、Plan 状态与工具轨迹持久化

日期：2026-10-15。对应 [设计规格](../specs/2026-10-15-phase-e2-message-plan-trajectory-design.md) 与 [总规划](2026-10-15-phase-e-product-readiness.md)。

## 2026-10-27 补齐与重新验收

已接通统一消息的存储、模型、UI、压缩与导出投影；Plan 使用主进程状态机，绑定窗口、会话、物理项目及绑定令牌，原子防重并支持失败回滚。历史恢复会过期 Plan，不恢复执行授权。Chat 通过 TaskHandle 产生任务生命周期事件；轨迹收集与存储经共用有界脱敏投影。

新增主进程 IPC 集成测试，覆盖跨窗口/跨项目拒绝、双击防重、失败重试与任务事件。最终测试数字及未关闭事项以本目录的 `2026-10-27-e2-e3-reacceptance.md` 为准。

## 2026-10-28 前置防重放闭环

已按[最新前置闭环记录](<2026-10-28-e2-e3-frontgate-closure.md>)区分准备失败与已开始执行后的失败：只有开始前可安全回滚重试；一旦任务接受并开始执行，原 Plan 授权耗用，失败后过期并返回 `isRetryable: false`，须检查现场、生成新 Plan 并重新授权。实际主进程 IPC + 临时副作用文件反测证明旧 Plan 不能重复执行。

完整检查点与导出/恢复已有 E10/E12/E13/E23 承接，留到相应阶段；这里不提前实现通用恢复。旧全量数字是历史结果，当前相关回归与未通过的全量稳定性以最新记录为准。

## 实施清单与状态跟踪

- [x] 1. 创建统一消息结构与三向投影模块（`src/ai/message-schema.js`）。
  - [x] 定义 V2 消息格式、部件（Text/Attachment/Plan/ToolCall/ToolResult）与轨迹结构。
  - [x] 实现 `projectToUiModel`、`projectToModelMessages`、`projectToStorageJson` 三向独立投影。
  - [x] 实现敏感凭据脱敏（`stripSecrets`）与参数/返回值有界截断。
  - [x] 实现旧版 V1 纯文本消息平滑升级迁移函数 `migrateSessionMessages`。
- [x] 2. 创建通用任务契约模块（`src/ai/task-contract.js`），供 E9/E10 共用。
  - [x] 定义 `TASK_KINDS`、`TASK_STATES`、`CANCEL_REASONS` 标准枚举。
  - [x] 实现标准任务事件信封构造器 `createTaskEventEnvelope`。
  - [x] 实现统一任务生命周期管理句柄 `TaskHandle`。
- [x] 3. 创建 Plan 状态管理器与生命周期模块（`src/ai/plan-state.js`）。
  - [x] 维护跨会话、跨项目绑定的 Plan 实体与状态流转矩阵（`PROPOSED`、`APPROVED`、`REJECTED`、`SUPERSEDED`、`EXPIRED`）。
  - [x] 实现原子防重校验与并发锁，防止双击或多次触发。
  - [x] 实现项目绑定与当前工作区环境校验，防止跨项目执行。
  - [x] 仅开始执行前的准备失败可安全回滚重试；开始执行后失败耗用原授权、过期旧 Plan，检查现场后生成新计划。
- [x] 4. 改造主进程（`src/main.js`）。
  - [x] 集成 `PlanStateManager`，重构 `chat:approvePlan` 与 `chat:rejectPlan`。
  - [x] 接入 `projectToModelMessages` 取代易失的直接字符串映射。
  - [x] 接入 `task-contract` 统一任务生命周期与事件广播。
- [x] 5. 改造渲染进程（`src/renderer/app.js`）。
  - [x] `loadState()` / `saveState()` 接入消息升级迁移。
  - [x] `chatRun` 收集器接入 `trajectory` 事件流。
  - [x] `finalizeChatRun()` 固化结构化 `parts` 与 `trajectory`。
  - [x] `renderPlanCard` 与 `approvePlanFromCard` 脱离对易失 `chatRun` 的依赖，卡片生命周期延续至消息中。
  - [x] `renderMessages()` 支持历史只读时间线与持久 Plan 卡片渲染。
- [x] 6. 适配与更新相关辅助模块。
  - [x] `src/ai/session-compact.js`：适配 V2 消息提取与计算。
  - [x] `src/ai/session-export.js`：适配 V2 消息导出（Markdown 与 JSON）。
- [x] 7. 编写专项测试套件与执行全量回归。
  - [x] `tests/e2-message-schema.test.js`
  - [x] `tests/e2-plan-lifecycle.test.js`
  - [x] `tests/e2-trajectory-persistence.test.js`
  - [x] [E2 边界与任务行为](<../../../tests/e2-behavior.test.js>)、[窗口生命周期](<../../../tests/e2-window-lifecycle.test.js>)。
  - [x] 更新 `tests/e1-plan-approval-gap.test.js` 验证缺口正式闭环。
  - [x] 全量串行回归 1134/1134 通过（600 秒文件预算），旧超时已关闭；后续渲染事件竞争修复另行专项复验。真实 Electron + 零延迟本地模拟模型验证 Plan 生成、批准、执行、刷新过期；未使用外部模型服务。最终相关回归数字见验收记录。

---

## 阶段演进与架构约束验证

1. **结构化内容保真原则**：禁止任何以 `String(parts)` 或隐式拼接的方式处理多类型内容，必须通过清晰定义的部件类型与投影适配器完成转换。
2. **授权隔离原则**：会话恢复与历史加载仅提供审计与复盘能力，不得继承既有执行授权；任何环境变更（项目变更、跨项目跳转、重载）均需用户重新确认。
3. **资源有界与存储安全**：所有持久化内容均经由 `stripSecrets` 消除 Token/密码风险，对长文本与工具日志强制施行硬性截断，杜绝 LocalStorage 崩溃隐患。
