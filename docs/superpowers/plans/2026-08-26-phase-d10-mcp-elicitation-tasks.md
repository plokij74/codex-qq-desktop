# Phase D.10 - MCP Elicitation 与 Tasks 实施计划

**设计规格:** `docs/superpowers/specs/2026-08-26-phase-d10-mcp-elicitation-tasks-design.md`  
**实施状态:** 实现中；自动化实现与回归已通过，D8/D9/D10 外部 MCP Electron 桌面验收仍为硬前置

目标：在 D8 OAuth/SSRF 和 D9 prompts/roots/sampling/session recovery 基础上，交付 MCP Elicitation 与 Tasks 的协议、任务中心、后台恢复和安全用户交互。

## 1. 实施前置与基线

- [ ] 完成 D8 真实 HTTPS OAuth MCP 的授权、重启 refresh/revoke、allowPrivate 和 SSRF Electron 桌面验收。
- [ ] 完成 D9 外部 MCP server 的 prompts、roots、sampling approval、session recovery 和 UI Electron 桌面冒烟。
- [x] 保留用户已有 `.idea/` 未跟踪内容，不覆盖无关工作区改动。
- [x] 运行 `npm test` 基线并记录结果；2026-08-28 为 707 passed、0 failed、0 skipped。
- [x] 冻结 D10 协议合同、资源上限和错误码后再开始实现。

## 2. Task 1 - MCP 协议版本与传输兼容

涉及：`src/ai/mcp-client.js`、`src/ai/mcp-http.js`、`src/ai/mcp-sse.js`、`src/ai/mcp-rpc.js`。

- [x] 抽出共享 protocol negotiation：优先 `2025-11-25`，明确不兼容时回退 `2024-11-05`，校验 server 回选版本。
- [x] 让 HTTP/SSE 后续请求统一发送 `MCP-Protocol-Version`，并保持 D9 `Mcp-Session-Id`。
- [x] 将 stdio writer 迁移到 newline JSON framing。
- [x] 让 stdio reader 增量支持 newline 与旧 `Content-Length`；初始化首包探测失败时一次性重启连接探测兼容 framing。
- [x] 协议回退时关闭 D10 capability 和 task 参数，避免把新字段发送给旧 server。
- [ ] 补充三 transport 的分片、超时、版本不匹配和未知 method 测试。

## 3. Task 2 - RPC task dispatcher 与统一 client 接口

涉及：`src/ai/mcp-rpc.js`、三种 transport client。

- [x] 扩展 request params 支持 `task.ttl`，并确保原始 `tools/call` 请求不可重放。
- [x] 增加统一 `getTask`、`getTaskResult`、`listTasks`、`cancelTask` client 方法。
- [x] 处理 `notifications/tasks/status`、`notifications/elicitation/complete`，事件内容只进入内部 callback。
- [x] 为 server request dispatcher 增加 Elicitation handler 和 receiver task handler。
- [x] 让 transport 在等待 HTTP body/SSE 消息期间继续增量 dispatch，避免嵌套 server request 互相等待。
- [ ] 固定任务方法超时、body 上限、错误脱敏和 cancellation 语义。

## 4. Task 3 - Task Manager、存储与后台轮询

新增：`src/ai/mcp-task-manager.js`；接入 `src/main.js` 和 D8 `safeStorage` 存储模式。

- [x] 实现 main-owned task manager，管理远端工具任务和本机 receiver task 两类记录。
- [x] 实现 MCP 状态机、local disposition、TTL、pollInterval、指数退避、并发上限和历史清理。
- [x] 使用版本化 Electron `safeStorage` envelope、临时文件和原子替换；不可用时 memory-only；损坏时不覆盖原文件。
- [x] 任务 record 不持久化工具参数、sampling/elicitation 正文、表单输入、绝对路径和完整远端 payload。
- [x] 应用启动恢复工具任务监控；不恢复 Agent run，不重放有副作用请求。
- [x] 实现 orphaned、abandoned、claimed、配置 fingerprint 和 session/project hash。
- [x] 配置修改/删除存在未完成任务的 server 时返回 `MCP_TASKS_CONFIG_LOCKED`。
- [x] 实现显式取消和遗弃操作，区分远端取消与本地停止监控。

## 5. Task 4 - MCP hub/provider/Agent 任务调用

涉及：`src/ai/mcp-hub.js`、`src/ai/providers/mcp.js`、`src/ai/agent.js`。

- [x] 在 hub 保存 server task capability 和每个 tool 的 `execution.taskSupport`。
- [x] 按本地开关、server capability 和 tool metadata 实现 required/optional/forbidden 路由。
- [x] Tasks 关闭时不注册无法同步执行的 required tool。
- [x] 工具 task 创建后立即向 Agent 返回 opaque taskRef 和脱敏摘要，不阻塞 Agent loop。
- [x] 增加受控 `mcp_tasks_list`、`mcp_task_get`、`mcp_task_result`，限制 server/taskRef 输入和结果大小。
- [x] Agent stop、run end 和页面切换不能取消或释放任务；D9 session manager 只负责连接生命周期。
- [ ] 任务结果通过 task manager 进入事件和任务中心，不自动追加原 session history。
- [ ] 保持 permission risk=`mcp`；取消和查看任务不绕过既有权限边界。

## 6. Task 5 - Elicitation form/url 与 sampling task

涉及：`src/ai/mcp-elicitation.js`（新增建议）、`src/ai/mcp-sampling.js`、三种 client、main IPC。

- [x] 实现 form mode 的扁平 primitive schema parser、字段限制、enum、format、默认值和提交校验。
- [x] 拒绝嵌套/数组/未知 schema 和敏感字段；净化 server message、title、description。
- [x] 实现 url mode 的公共 HTTPS/SSRF/危险 query 校验；开发私网必须同时满足显式环境开关与配置开关。
- [x] 保证 URL 不预取、不嵌入、不读回内容，只有 main 在用户确认后 `shell.openExternal`。
- [x] 实现 Elicitation FIFO、全局单前台交互、accept/decline/cancel 和窗口销毁清理。
- [x] 支持 `notifications/elicitation/complete`，但不自动重放工具或任务请求。
- [x] 为 task-augmented sampling/createMessage 建立本机 receiver task，支持 server 的 tasks/get/result/cancel/list。
- [x] 令 `input_required` 与前台 form/url 交互一致，提交后恢复 working。
- [x] sampling task 不持久化正文，不跨重启恢复。

## 7. Task 6 - Main/preload IPC 与任务中心 UI

涉及：`src/main.js`、`src/preload.js`、`src/renderer/index.html`、`src/renderer/app.js`、`src/renderer/styles.css`。

- [x] 增加 task list/get/result prepare/result commit/cancel/abandon IPC。
- [x] 增加 Elicitation respond/cancel/open-url IPC；所有 ID 做 sender ownership 校验，URL 从 main 内存查找。
- [x] 广播脱敏 task update、elicitation request 和完成事件到所有窗口。
- [x] 将“已安排”视图扩展为任务中心，显示状态、server、tool、时间、错误和可执行操作。
- [x] 聊天时间线增加任务卡和状态变化；切换到其它 view 后任务仍由 main 后台刷新。
- [x] 实现结果 claim prepare/commit：用户选择目标会话并确认后，以新 assistant 消息发送。
- [x] 对 orphaned、结果截断、不确定状态和配置锁定提供清晰 UI。
- [ ] 不将 task data、Elicitation 内容、URL、远端 task ID 写入 renderer localStorage、session export 或聊天历史。

## 8. Task 7 - 测试与隐私回归

- [x] 新增 `tests/mcp-task-manager.test.js`：状态机、TTL、poll、limits、cancel、abandon、orphan、claim 和加密 store。
- [x] 新增 `tests/mcp-elicitation.test.js`：schema、安全字段、URL guard、队列、响应动作和 opener。
- [x] 扩展 `tests/mcp-rpc.test.js`：nested server request、task status notification、receiver task routing。
- [x] 扩展 `tests/mcp-client.test.js`、`tests/mcp-http.test.js`、`tests/mcp-sse.test.js`：版本、header、两种 framing、task method 和增量 dispatch。
- [x] 扩展 `tests/mcp-hub.test.js`、Agent/provider 测试：tool taskSupport 路由和 Agent immediate task reference。
- [x] 增加 main/preload sender ownership、配置锁定和 public redaction 测试。
- [ ] 增加 D8 token、D9 roots/session/sampling、D7 PR 工作台和子 Agent 回归。
- [ ] 检查 task ID、task result、schema value、sampling 内容和 URL query 不进入日志、event、usage、memory、export 或 localStorage。

## 9. Task 8 - 文档、桌面验收与交付

- [x] 更新 README 的 D10 使用、Tasks 默认关闭、Elicitation 风险、任务中心和重启语义章节。
- [x] 提供本地可复现的 external MCP test fixture，覆盖工具任务、form/url elicitation、sampling task、取消和重启恢复。
- [ ] 使用真实外部 MCP server 完成 D8/D9 硬前置和 D10 Electron UI 冒烟。
- [x] 运行 `npm test`，要求 0 failed；记录宿主环境 skip。
- [x] 所有 JavaScript 文件通过 `node --check`。
- [x] `git diff --check` 通过，无新 runtime dependency。
- [ ] 只有自动化、隐私、真实桌面和 D8/D9 前置全部通过后，将本文档状态改为“已交付”并同步 README。

## 10. Definition of Done

D10 只有在以下条件全部满足后才算完成：

- D8 真实 HTTPS OAuth MCP 桌面验收通过。
- D9 外部 MCP Electron UI 冒烟通过。
- D10 的 form/url Elicitation、工具 Tasks、sampling Tasks、后台轮询、取消、遗弃、orphan 认领和重启语义通过真实桌面验收。
- `npm test` 全绿，`node --check` 和 `git diff --check` 通过。
- 任务敏感数据未泄漏到 renderer 持久化、聊天历史、导出、usage、memory、hooks 或日志。
- 无新增 runtime dependency，旧 stdio、公网 MCP、D8 OAuth/SSRF、D9 能力、D7 工作台和子 Agent 行为不回归。
