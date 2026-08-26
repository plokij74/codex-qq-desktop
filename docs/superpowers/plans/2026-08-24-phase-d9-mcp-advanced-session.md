# Phase D.9 - MCP 高级能力与进程内会话恢复实施计划

**设计规格:** `docs/superpowers/specs/2026-08-24-phase-d9-mcp-advanced-session-design.md`
**实施状态:** 核心实现、自动化验收与本地真实 stdio MCP 集成冒烟完成；外部 MCP server 的 Electron 桌面 UI 冒烟待验证

目标：在 D8 MCP OAuth/SSRF 基础上，交付 prompts、roots、受控 sampling 和显式开启的进程内 session recovery；保留 D8 的安全边界、无新 runtime 依赖和旧配置兼容。

## 1. 实施前置

- [ ] D8 真实 HTTPS OAuth MCP 授权、重启 refresh/revoke、allowPrivate 和 SSRF 桌面验收完成。
- [x] 冻结当前 D8/D7 未提交工作区改动，不覆盖用户已有修改。
- [x] 运行 `npm test` 基线并记录结果；为 request/notification、目录选择器、model callback 和时钟建立注入 seam。

## 2. Task 1 - 共享 MCP RPC 层

涉及 `src/ai/mcp-client.js`、`src/ai/mcp-http.js`、`src/ai/mcp-sse.js` 及共享模块。

- [x] 抽出 JSON-RPC request/response/notification dispatcher，支持 server request response 和 cancellation。
- [x] stdio 响应 inbound request；SSE 持续消费 message event；HTTP 处理 bounded response stream。
- [x] initialize 声明按配置启用的 `roots`/`sampling` capability。
- [x] 统一 timeout、AbortSignal、body 上限、`-32601` unknown method 和脱敏错误。
- [x] 补充 stdio/SSE/HTTP 的 inbound mock 测试。

## 3. Task 2 - 配置、Roots 与公开设置

涉及 `src/ai/mcp-config.js`、`src/ai/settings.js`、`src/main.js`、preload 和 MCP settings UI。

- [x] 增加 `sessionRecovery:false`、`sampling.enabled:false`、`roots:[]` 默认值和旧配置迁移。
- [x] 实现 main-owned directory picker、sender-scoped root token、canonical path、目录存在性和最多 8 项限制。
- [x] 按 server 持久化 roots；JSON import 不接受未经 picker 授权的 root path。
- [x] public settings 只返回 `rootId`/label 和 session 摘要，不返回 absolute path/session id。
- [x] 设置页增加 recovery/sampling 开关、roots 添加删除、状态和路径披露警告。
- [x] 补充配置注入、root token ownership、旧配置和 public redaction 测试。

## 4. Task 3 - Session Manager 与恢复

涉及新增 `McpSessionManager`，并接入 `mcp-hub`、MCP provider、main IPC prompt path。

- [x] 按 transport/URL/config fingerprint 建立 session key，支持 acquire/release/invalidate/status。
- [x] recovery 开启时跨 run 保留 lease-backed client；idle 5 分钟回收，最多 8 个 session。
- [x] HTTP 保存/发送 `Mcp-Session-Id`；SSE 重新连接事件流；stdio 重启子进程。
- [x] run 开始最多恢复一次，传输错误最多重连一次；仅 replayable discovery/list 请求可重做。
- [x] `tools/call`、`resources/read`、`prompts/get`、sampling response 永不自动重放。
- [x] 配置、OAuth logout、roots/project 变更和 app quit 清理 session；状态事件不泄漏 identifier。
- [x] 补充 session reuse、expiry、reconnect、eviction、invalidation 和 no-replay 测试。

## 5. Task 4 - Prompts

- [x] client/hub 增加 `listPrompts`、`getPrompt` 和固定工具 `mcp_prompts_list`/`mcp_prompt_get`。
- [x] 限制 server/name/arguments/content/result 大小，标记 MCP 返回为不可信数据。
- [x] 增加 `mcp:prompts:list/get` IPC，仅接受已保存 server name 和 prompt name。
- [x] 增加 `/mcp-prompts` 与 `/mcp-prompt`；读取结果只填入 composer，不自动发送或写入历史。
- [x] 处理 `prompts/list_changed` cache invalidation 和连接错误。
- [x] 补充 hub、IPC、slash command、截断和未保存 draft 测试。

## 6. Task 5 - Sampling 与审批

- [x] 只为 `sampling.enabled=true` 且 API 模式 server 声明 sampling capability。
- [x] 校验 text-only messages、system prompt、temperature、stop sequences、maxTokens 和请求大小。
- [x] 接入 `sampling/createMessage` 到当前配置模型；tools 为空、禁止 MCP recursion、非流式调用。
- [x] 实现 `mcp-sampling` approval，逐次确认、server-scoped `allow_session`，full-auto 仍需确认。
- [x] 实现 `none`、确认后的 bounded `thisServer` 和拒绝 `allServers` context policy。
- [x] 增加每次 2048 tokens/60 秒、每 server 每 run 3 次、累计 8192 tokens 的限制。
- [x] 生成 `kind:mcp-sampling` usage；统一处理 disabled/unavailable/limit/timeout/cancelled/content errors。
- [x] 补充审批、上下文、限额、abort、usage 和 prompt/response privacy 测试。

## 7. Task 6 - 集成、文档与验收

- [x] 增加 `mcp:roots:choose/remove`、`mcp:session:status/reset` preload API 和 renderer 状态处理。
- [x] 更新 README D9，说明 recovery 默认关闭、roots 路径披露、sampling 审批和 prompt 命令。
- [x] 全量运行 `npm test`、全部 JavaScript `node --check`、`git diff --check`（`npm test`: 678 passed, 0 failed）。
- [x] 使用独立 Node stdio MCP 子进程验证 prompts、resources、roots/list、sampling approval、跨 run recovery、断线恢复和 reset。
- [ ] 使用外部 MCP server 完成 Electron 桌面 UI 手工冒烟。
- [x] 回归 D8 OAuth/SSRF、既有 stdio/resources、C5 hub、D7 PR 工作台和子 Agent。

## 8. Definition of Done

D9 只有在所有自动化测试、隐私/ownership 回归、D8 兼容验证和真实桌面 MCP 冒烟全部通过后，才标记为已交付。recovery 未开启的 server 必须继续遵守 D8 的每 run 连接/断开生命周期。
