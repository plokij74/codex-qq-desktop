# Phase E2：统一消息、Plan 状态与工具轨迹持久化设计规格

日期：2026-10-15。对应 [实施规划](../plans/2026-10-15-phase-e-product-readiness.md) 与 [E2 实施记录](../plans/2026-10-15-phase-e2-message-plan-trajectory.md)。

## 一、设计目标与定位

Phase E2 解决 Phase E 全功能补齐规划中的核心基础断点与体验缺口：
1. **闭环 G04（Plan 审批生命周期断点）**：消除生成完成（finalize）、会话切换或页面重绘导致 Plan 批准按钮失效或卡片丢失的架构缺陷。确立主进程执行权威，实现绑定环境、原子防重与历史只读隔离。
2. **闭环 G05（工具/审批/验证/子任务时间线重载丢失）**：将模型执行过程中产生的富交互时间线（工具调用、人工权限审批、自动化验证、子 Agent 运行）有界、脱敏地固化进消息记录，重载与切换会话后完整复现只读审计轨迹。
3. **奠定 E3–E27 通用底层契约**：
   - **版本化消息模型与三向投影**：定义 `schemaVersion: 2` 结构，消除 `String(parts)` 兼容隐患，确立 UI 渲染投影、模型请求投影（LLM Payload）、存储持久化投影（Storage JSON）各自独立职责。
   - **共用任务契约（供 E9/E10）**：统一任务标识（`taskId`）、归属（`sessionId`/`projectId`/`owner`）、取消协议（`cancelTask(taskId, reason)`）与标准事件信封。
   - **附件引用与预算规范（供 E5/E6/E11）**：规范 `AttachmentRef` 状态、哈希去重、受控引用路径与预算字段（`estimatedTokens`、`maxBytes`）。

---

## 二、详细设计与规范

### 1. 版本化消息架构与三向投影契约

#### 消息模型定义（`src/ai/message-schema.js`）
每条消息采用版本化实体规范（`schemaVersion: 2`）：
- `id`: 字符串，格式 `msg_${Date.now()}_${random}`。
- `sessionId`: 所属会话 ID。
- `role`: `'user' | 'assistant' | 'system' | 'tool'`。
- `createdAt`: 毫秒时间戳。
- `schemaVersion`: 固定为整数 `2`。
- `parts`: 结构化内容块数组：
  - **TextPart**: `{ type: 'text', text: string }`。
  - **AttachmentRefPart**: `{ type: 'attachment_ref', attachmentId, name, mimeType, size, hash, source, status, budget }`。
  - **PlanPart**: `{ type: 'plan', planId, title, markdown, steps, status, createdAt, resolvedAt, resolutionReason }`。
  - **ToolCallPart**: `{ type: 'tool_call', callId, tool, args }`。
  - **ToolResultPart**: `{ type: 'tool_result', callId, tool, result, error }`。
- `trajectory`: 工具与动作执行时间线条目数组（主要存在于 assistant 消息）：
  - **ToolEvent**: `{ kind: 'tool', callId, tool, argsSummary, status: 'running'|'success'|'error', durationMs, timestamp }`。
  - **ApprovalEvent**: `{ kind: 'approval', tool, description, decision: 'approved'|'rejected', timestamp }`。
  - **VerifyEvent**: `{ kind: 'verify', passed, checks, failureCount, runId, timestamp }`。
  - **SubagentEvent**: `{ kind: 'subagent', subagentId, kindName, goal, status, durationMs, timestamp }`。
- `fileChanges`: 文件改动汇总数组 `[{ path, op, stats }]`。
- `applied`: 布尔值，是否已应用改动。
- `error` / `errorMessage` / `aborted`: 执行终止状态标志。
- `compact` / `compactedCount`: 会话压缩状态。

#### 三向投影行为规范
1. **UI 渲染投影 (`projectToUiModel`)**：
   - 提取 `text` 块使用 Markdown 渲染；
   - 提取 `attachment_ref` 渲染为专用附件胶囊；
   - 提取 `plan` 渲染为带有明确状态的 Plan 卡片（若为待处理状态，渲染可交互按钮；若已处理，渲染只读结论）；
   - 提取 `trajectory` 渲染为折叠/展开的只读时间线组件，保持与实时流式呈现完全一致的视觉层次。
2. **模型调用投影 (`projectToModelMessages`)**：
   - 严格遵循 OpenAI 兼容请求格式 `{ role, content }`；
   - 展开 `@refs` 引用（仅在内存副本展开，不污染存储文本）；
   - 剔除纯 UI 审计轨迹（`trajectory`），严禁将内部状态与未经验证的日志注入模型上下文；
   - 禁止盲目使用 `String(parts)` 将结构化对象简单拼接为乱码字符串；按部件类型分别转为纯文本描述或未来多模态 payload。
3. **存储持久化投影 (`projectToStorageJson` & `fromStorageJson`)**：
   - 使用 `stripSecrets` 递归脱敏所有字段中的敏感密钥（API Key、Authorization Header、Password、Token 等）；
   - 有界截断：单个工具参数摘要限长 200 字符，单个工具输出限长 1000 字符，防止 LocalStorage 容量溢出；
   - 自动双向兼容：反序列化时，遇到无 `schemaVersion` 或旧版 `{ role, content }` 格式，自动转为包含 `parts: [{ type: 'text', text: content }]` 的 v2 消息。

---

### 2. Plan 状态脱离临时 chatRun & 完整生命周期

#### 核心问题根因
原实现将 Plan 卡片创建与批准逻辑直接挂载在渲染进程内存对象 `chatRun` 及其 `timelineEl` 上。当流式生成完成调用 `finalizeChatRun()` 时，`disableApprovalCards(chatRun.el)` 强制禁用了按钮并将 `chatRun` 置为 `null`；而 `approvePlanFromCard()` 首行判断 `if (!chatRun || chatRun.finalized) return;` 导致正常结束后的计划卡片立即沦为无法点击的死组件；切换会话后 DOM 销毁更导致卡片永久丢失。

#### 设计规范
1. **消息模型承载**：
   - Assistant 消息在收到 `plan-ready` 事件时，将其固化为消息体中的 `parts`（`type: 'plan'`），随消息一同保存进 `session.messages`。
   - `renderMessages()` 根据消息中的 `parts` 重新渲染 Plan 卡片，即使 `chatRun` 已结束，卡片依旧存在。
2. **解耦审批执行通道**：
   - 重构 `approvePlanFromCard(card, planId, sessionId)`，不再依赖活跃的 `chatRun` 对象。
   - 只要当前无活跃生成（或停止当前流式），即可调用 `window.codex.approvePlan({ planId, sessionId, project, ... })` 启动新的执行流程。
3. **主进程状态机与防重（`PlanStateManager`）**：
   - 主进程维护活跃 Plan 注册表，绑定 `{ planId, sessionId, projectId, projectPath, projectBindingId, status, createdAt }`。
   - 状态流转控制：
     - `PROPOSED` 状态下接收批准请求，原子转换至 `APPROVED`，防止双击或并发重放；
     - 收到新计划时，旧计划原子流转至 `SUPERSEDED`；
     - 收到驳回请求时，原子流转至 `REJECTED`；
     - 若启动执行因环境繁忙（如 worktree 锁）失败，状态安全回滚为可重试的 `PROPOSED`，并在返回中携带 `isRetryable: true`，不让用户卡死。
4. **历史可见性 ≠ 自动授权**：
   - 重新加载应用或切换项目后，历史计划仍完整展示供复盘；
   - 但若当前绑定的项目路径与 Plan 所绑定的路径不一致，主进程坚决拒绝批准执行，提示“项目绑定已变更，请重新生成计划”，杜绝越权与越界副作用。

---

### 3. 工具执行与审核轨迹持久化

#### 行为与存储规范
1. **轨迹收集**：
   - `chatRun` 初始化时建立 `trajectory: []` 收集器；
   - 监听到 `tool-start`、`tool-end`、`approval-resolved`、`verify-result`、`subagent-start/end` 时，实时构造结构化轨迹条目追加到数组；
   - `tool-end` 自动关联对应的 `tool-start`（通过 `callId` 或工具名称匹配），记录执行耗时与成功/失败结果。
2. **固化保存**：
   - 在 `finalizeChatRun()` 中，将完整的 `trajectory` 数组深拷贝至存入 `session.messages` 的助手消息中。
3. **安全脱敏与有界性**：
   - 所有存入的参数及返回值通过 `stripSecrets` 过滤；
   - 截断保护：超长字符串自动裁剪并添加 `...（已截断）` 标识。
4. **历史回放渲染**：
   - `renderMessages()` 检测到 `msg.trajectory` 时，在气泡内渲染 `.agent-timeline.is-history` 只读区块；
   - 只读卡片展现执行过的工具、审批结论与测试结果，但所有按钮均为禁用/静态展示状态，不可重复触发或凭历史记录自动授权新操作。

---

### 4. 通用任务契约规范（供 E9/E10 共用）

#### 接口与常量规范（`src/ai/task-contract.js`）
1. **任务类型 (`TASK_KINDS`)**：
   - `CHAT_RUN`: 交互式对话/生成。
   - `PTY_SESSION`: 交互式终端（供 E9）。
   - `BACKGROUND_JOB`: 通用后台任务（供 E10）。
   - `VERIFICATION`: 代码验证作业。
   - `SUBAGENT`: 子 Agent 运行。
2. **任务状态 (`TASK_STATES`)**：
   - `IDLE` -> `STARTING` -> `RUNNING` -> `COMPLETED` | `FAILED` | `CANCELLED`。
3. **取消原因 (`CANCEL_REASONS`)**：
   - `USER_REQUEST`（用户点击停止）
   - `TIMEOUT`（运行超时）
   - `SESSION_CLOSED`（会话关闭）
   - `PROJECT_CHANGED`（项目解绑或切换）
   - `SYSTEM_SHUTDOWN`（应用退出）
4. **事件信封 (`createTaskEventEnvelope`)**：
   - `{ taskId, kind, sessionId, projectId, type, timestamp, data }`。
5. **任务控制器句柄 (`TaskHandle`)**：
   - 封装 `taskId`、`ownerId`、`signal` 与 `cancel(reason)` 方法，供主进程统一调度。

---

### 5. 附件引用与预算规范（供 E5/E6/E11 奠基）

#### 字段定义与规则
1. **结构定义**：
   - `attachmentId`: `att_${Date.now()}_${random}`。
   - `name`: 经过安全净化的文件名。
   - `mimeType`: MIME 类型字符串。
   - `size`: 字节大小。
   - `hash`: SHA-256 哈希串（用于 E5/E6 跨会话去重）。
   - `source`: `'user_upload' | 'at_project_ref' | 'tool_output'`。
   - `status`: `'ready' | 'missing' | 'deleted' | 'expired'`。
   - `budget`: `{ estimatedTokens: number, maxBytes: number, truncated: boolean }`。
2. **生命周期原则**：
   - 引用归会话与消息所有；
   - 物理缓存清理不删除用户本地源文件；
   - 导出消息时仅导出相对元数据，不暴露宿主机私有绝对路径。

---

## 三、验收标准与测试套件

| 验证项 | 对应模块 | 验证方法与验收基线 |
| --- | --- | --- |
| 消息模型与三向投影 | `message-schema.js` | V2 构造正确；UI、Model、Storage 投影互相隔离；敏感词脱敏；V1 无损升级 |
| Plan 生成后审批正常 | `app.js` / `main.js` | `finalizeChatRun` 结束后 Plan 按钮可点击且成功调用 `approvePlan`；卡片切换会话保留 |
| Plan 原子防重与绑定校验 | `plan-state.js` | 并发/双击仅触发一次；项目路径不符坚决拒绝；繁忙失败可重试且不丢失 Plan |
| 工具轨迹持久化与只读呈现 | `app.js` / `main.js` | 工具/审批/验证/子任务记录入库，刷新后生成 `.agent-timeline.is-history`，参数已脱敏 |
| 通用任务契约兼容性 | `task-contract.js` | 状态转换正确；取消原因与事件信封格式完备，满足 E9/E10 预设约束 |
| 全量回归测试 | `tests/` | E1 16 项全绿；E2 新增测试全绿；无内存泄露与未捕获异常 |
