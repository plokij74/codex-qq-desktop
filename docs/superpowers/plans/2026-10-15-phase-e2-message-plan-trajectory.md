# Phase E2 实施记录：统一消息、Plan 状态与工具轨迹持久化

日期：2026-10-15。对应 [设计规格](../specs/2026-10-15-phase-e2-message-plan-trajectory-design.md) 与 [总规划](2026-10-15-phase-e-product-readiness.md)。

## 实施清单与状态跟踪

- [ ] 1. 创建统一消息结构与三向投影模块（`src/ai/message-schema.js`）。
  - [ ] 定义 V2 消息格式、部件（Text/Attachment/Plan/ToolCall/ToolResult）与轨迹结构。
  - [ ] 实现 `projectToUiModel`、`projectToModelMessages`、`projectToStorageJson` 三向独立投影。
  - [ ] 实现敏感凭据脱敏（`stripSecrets`）与参数/返回值有界截断。
  - [ ] 实现旧版 V1 纯文本消息平滑升级迁移函数 `migrateSessionMessages`。
- [ ] 2. 创建通用任务契约模块（`src/ai/task-contract.js`），供 E9/E10 共用。
  - [ ] 定义 `TASK_KINDS`、`TASK_STATES`、`CANCEL_REASONS` 标准枚举。
  - [ ] 实现标准任务事件信封构造器 `createTaskEventEnvelope`。
  - [ ] 实现统一任务生命周期管理句柄 `TaskHandle`。
- [ ] 3. 创建 Plan 状态管理器与生命周期模块（`src/ai/plan-state.js`）。
  - [ ] 维护跨会话、跨项目绑定的 Plan 实体与状态流转矩阵（`PROPOSED`、`APPROVED`、`REJECTED`、`SUPERSEDED`、`EXPIRED`）。
  - [ ] 实现原子防重校验与并发锁，防止双击或多次触发。
  - [ ] 实现项目绑定与当前工作区环境校验，防止跨项目执行。
  - [ ] 支持执行启动异常时的安全回滚与可重试标记。
- [ ] 4. 改造主进程（`src/main.js`）。
  - [ ] 集成 `PlanStateManager`，重构 `chat:approvePlan` 与 `chat:rejectPlan`。
  - [ ] 接入 `projectToModelMessages` 取代易失的直接字符串映射。
  - [ ] 接入 `task-contract` 统一任务生命周期与事件广播。
- [ ] 5. 改造渲染进程（`src/renderer/app.js`）。
  - [ ] `loadState()` / `saveState()` 接入消息升级迁移。
  - [ ] `chatRun` 收集器接入 `trajectory` 事件流。
  - [ ] `finalizeChatRun()` 固化结构化 `parts` 与 `trajectory`。
  - [ ] `renderPlanCard` 与 `approvePlanFromCard` 脱离对易失 `chatRun` 的依赖，卡片生命周期延续至消息中。
  - [ ] `renderMessages()` 支持历史只读时间线与持久 Plan 卡片渲染。
- [ ] 6. 适配与更新相关辅助模块。
  - [ ] `src/ai/session-compact.js`：适配 V2 消息提取与计算。
  - [ ] `src/ai/session-export.js`：适配 V2 消息导出（Markdown 与 JSON）。
- [ ] 7. 编写专项测试套件与执行全量回归。
  - [ ] `tests/e2-message-schema.test.js`
  - [ ] `tests/e2-plan-lifecycle.test.js`
  - [ ] `tests/e2-trajectory-persistence.test.js`
  - [ ] `tests/e2-task-contract.test.js`
  - [ ] 更新 `tests/e1-plan-approval-gap.test.js` 验证缺口正式闭环。
  - [ ] 确保全量回归用例通过。

---

## 阶段演进与架构约束验证

1. **结构化内容保真原则**：禁止任何以 `String(parts)` 或隐式拼接的方式处理多类型内容，必须通过清晰定义的部件类型与投影适配器完成转换。
2. **授权隔离原则**：会话恢复与历史加载仅提供审计与复盘能力，不得继承既有执行授权；任何环境变更（项目变更、跨项目跳转、重载）均需用户重新确认。
3. **资源有界与存储安全**：所有持久化内容均经由 `stripSecrets` 消除 Token/密码风险，对长文本与工具日志强制施行硬性截断，杜绝 LocalStorage 崩溃隐患。
