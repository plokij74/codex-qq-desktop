# Phase D.9 - MCP 高级能力与进程内会话恢复设计规格

**日期:** 2026-08-24
**项目:** `codex-qq-desktop`
**状态:** 设计已确认，待实施
**前置:** Phase D.8 MCP OAuth 与 SSRF 加固完成并通过自动化与桌面验收

## 1. 目标与范围

D9 在 D8 的 MCP OAuth、DNS/SSRF 和三传输基础上，补齐 MCP `prompts`、`roots`、受控 `sampling`，并为明确开启的 server 增加进程内跨 run session recovery。

本阶段交付：

- stdio、SSE、Streamable HTTP 统一处理服务端 request/notification。
- `prompts/list`、`prompts/get` 与固定 MCP prompt 工具。
- `roots/list`、roots 变更通知和设置页的按 server 目录授权。
- 服务端 `sampling/createMessage`，主进程复用当前模型并使用现有审批卡逐次确认。
- 可选的内存 session 复用、一次重连和 transport-specific session 恢复。
- 设置、preload、renderer、隐私边界、测试和 README D9 说明。

明确非目标：

- MCP elicitation、tasks、sampling tools、后台轮询和服务端任意 UI 请求。
- OAuth device flow、OIDC 身份展示、多账号和跨应用重启恢复。
- 子 Agent 使用 MCP、roots 或 sampling。
- 自动重放 `tools/call`、`resources/read`、`prompts/get` 或其它可能有副作用的请求。
- 新增 runtime npm 依赖。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| Prompts 入口 | 模型固定工具 + `/mcp-prompts`、`/mcp-prompt` 显式命令 |
| Prompt 命令 | 结果只填入输入框，不自动发送、不写入会话历史 |
| Roots | 当前项目根 + 按 MCP server 保存的额外 roots |
| Roots 授权 | 仅设置页系统目录选择器；server 运行期间不能新增或修改 |
| Sampling | 每 server 显式开启，默认关闭；每次请求需确认，可选择本会话允许 |
| Sampling 模型 | 当前配置模型；local 模式不可用；不传 tools、不递归调用 MCP |
| Sampling 上下文 | 默认 `none`；`thisServer` 仅在额外确认后提供有限脱敏摘要；`allServers` 拒绝 |
| Session recovery | 每 server 显式开启，默认关闭；仅进程内跨 run，不跨应用重启 |
| 恢复触发 | run 开始一次复用；传输错误最多一次重连；不重放副作用请求 |
| session 存储 | 主进程内存；不进入 settings public view、renderer、日志、usage 或 export |
| 兼容性 | recovery 关闭时保持 D8 每次 run 建连/断开行为 |
| 子 Agent | 沿用 D8/C5 行为，完全不继承 MCP session、roots 和 sampling |

## 3. 当前基线与兼容边界

当前 MCP client 只等待自己发出的 JSON-RPC response，服务端 request/notification 被忽略；hub 在每次 Agent run 结束时关闭所有 client。D9 把 request dispatch 抽到共享层，并由 session manager 可选地延长生命周期。

D9 保持：

- stdio、SSE、Streamable HTTP、resources 和 OAuth 动态认证合同。
- MCP 工具仍使用 `mcp` 风险；plan mode、subagent depth >= 1 不暴露 MCP 工具。
- D8 的 URL、DNS、重定向、Authorization、token 隐私规则。

D9 改变：

- 显式开启 recovery 的 server 在 run 结束后可能保留连接至多 5 分钟。
- 初始化 capabilities 会根据配置声明 `roots` 和 `sampling`。
- MCP server 可发送受支持的 inbound request；未知方法只返回 JSON-RPC method-not-found。

## 4. 配置与公开合同

### 4.1 保存配置

远程或 stdio server 增加：

~~~json
{
  "name": "remote",
  "transport": "http",
  "enabled": true,
  "sessionRecovery": false,
  "sampling": {
    "enabled": false
  },
  "roots": []
}
~~~

- `sessionRecovery` 缺失时为 `false`，旧配置和新配置均不自动改变 D8 生命周期。
- `sampling.enabled` 缺失时为 `false`；prompts 不需要单独开关，server 声明能力后自动可读。
- roots 的真实 canonical path 由 main 保存；renderer 只能提交 sender-owned opaque root id/token，不能直接提交路径。
- 每个 server 最多 8 个额外 roots；必须是存在的目录，保存时 realpath；无效项被丢弃并返回脱敏 warning。
- JSON 导入中的任意 root path 不获得授权；必须通过设置页目录选择器重新确认。

### 4.2 Renderer public view

`settings:get` 和保存结果只返回：

~~~js
{
  name,
  sessionRecovery: boolean,
  sampling: { enabled: boolean },
  roots: [{ rootId, label }],
  session: {
    state: 'disabled' | 'idle' | 'connected' | 'reconnecting' | 'error',
    reusable: boolean,
    lastErrorCode: string | null
  }
}
~~~

不返回 root absolute path、session id、transport secret、OAuth token 或完整远端错误。

## 5. 共享 RPC 与 Session Manager

新增共享 `McpRpcSession` 抽象，至少提供：

~~~js
start({ capabilities, requestHandler, notificationHandler }): Promise<void>
request(method, params, { signal, replayable }): Promise<any>
notify(method, params): Promise<void>
reconnect(reason): Promise<void>
close(): Promise<void>
~~~

- stdio 处理 stdout 中的 server request 并通过 stdin 返回 response。
- SSE 持续解析 message event；HTTP/SSE message endpoint 继续遵守 D8 同源和 SSRF guard。
- Streamable HTTP 记录服务端 `Mcp-Session-Id` 并在后续请求发送；session 过期时返回 `MCP_SESSION_EXPIRED`。
- 所有 request 有 bounded body、timeout、AbortSignal 和脱敏错误；未知 inbound method 返回 `-32601`。
- 只允许 `replayable=true` 的初始化、能力发现和列表请求在重连后重做；工具、资源、prompt 获取和 sampling response 永不自动重放。

`McpSessionManager` 以 transport、规范化 URL、server 配置 fingerprint 和 OAuth resource identity 建 key：

- `acquire` 返回带 lease 的 client；run 结束或 IPC prompt 完成后 `release`。
- recovery 开启时 idle 5 分钟回收，最多保留 8 个 session；关闭时 release 立即 close。
- 配置、OAuth logout、roots 变更、项目绑定变更或应用退出都会 invalidate。
- session 状态只发 `mcp-session-status` 摘要事件，不发 session id 或网络响应。

## 6. Prompts 设计

client/hub 增加 `listPrompts()`、`getPrompt(name, arguments)`。hub 暴露固定工具：

~~~text
mcp_prompts_list({ server? })
mcp_prompt_get({ server, name, arguments? })
~~~

- server name 必须来自已连接配置；prompt name、arguments 有数量、长度和控制字符限制。
- prompt 返回的 message/content 统一截断到现有 MCP result 上限；无法安全转换的 content 返回 `MCP_PROMPT_CONTENT_UNSUPPORTED`。
- 模型看到的 MCP prompt 是不可信数据，不进入 system prompt，不触发二次工具执行。
- `prompts/list_changed` 只清除该 server 的 prompt cache，并在下一次 list/get 时重新读取。

设置页和聊天输入支持：

- `/mcp-prompts [server]` 展示已保存 server 的 prompt 摘要。
- `/mcp-prompt <server> <name> [JSON arguments]` 通过 main IPC 读取结果，渲染为可编辑文本放入输入框。
- 未保存 draft、无效 server 或连接失败时不自动启动浏览器，只返回稳定错误。

## 7. Roots 设计

client 初始化声明 `roots: { listChanged: true }`，收到 `roots/list` 时返回：

1. 当前已绑定项目根（若存在），名称使用项目名，URI 使用 canonical `file://` URI。
2. 该 server 在设置页明确授权的额外目录，返回 opaque label 对应的 canonical URI。

额外目录只由 `mcp:roots:choose({ name })` 选择、由 `mcp:roots:remove({ name, rootId })` 删除。main 校验 sender、server name、root token、目录存在性和 canonical path；服务端不能改变 root 集合。

项目切换或 roots 变更时，对活跃 session 发送 `notifications/roots/list_changed`；不做后台轮询。

## 8. Sampling 设计

### 8.1 入站请求与审批

仅 `sampling.enabled=true` 且 settings 为 API 模式时，在 initialize capabilities 声明 sampling。收到 `sampling/createMessage` 后：

1. 校验 server identity、消息数量、文本 content、system prompt、temperature、stop sequences 和 maxTokens 上限。
2. `none` 只使用 server 提供的 messages。
3. `thisServer` 需要额外确认，最多附加 4 KiB 同 server 的脱敏 sampling 摘要。
4. `allServers` 返回 `MCP_SAMPLING_CONTEXT_DENIED`，不发送当前聊天或其它 server 内容。
5. 调用现有配置模型，固定 `tools` 为空、禁止 MCP recursion，使用非流式 bounded request。

审批事件复用 `approval-needed`，增加 `source: 'mcp-sampling'`、server、scope、请求摘要和上下文范围；preview 截断并脱敏。`chat:approve` 必须校验 sender/run ownership。`allow_session` 只记住当前 server 的 sampling scope，`full-auto` 不能绕过确认。

### 8.2 限制、结果与错误

- 单次最多 2048 output tokens、60 秒；单 server 每 run 最多 3 次，累计最多 8192 tokens。
- stop reason 只映射为 `endTurn`、`maxTokens`、`stopSequence` 或 `error`。
- 只接受文本 assistant result；模型 tool call、空响应、超时、abort 或 API 不可用均返回稳定错误。
- 采样 usage 事件使用 `kind: 'mcp-sampling'`，只包含 model、token/cost 摘要；不包含 prompt、response、server payload。

稳定错误至少包括：

~~~text
MCP_SAMPLING_DISABLED
MCP_SAMPLING_UNAVAILABLE
MCP_SAMPLING_APPROVAL_REQUIRED
MCP_SAMPLING_CONTEXT_DENIED
MCP_SAMPLING_LIMIT
MCP_SAMPLING_TIMEOUT
MCP_SAMPLING_CANCELLED
MCP_SAMPLING_CONTENT_INVALID
~~~

## 9. IPC、Preload 与 UI

新增 main IPC：

~~~text
mcp:prompts:list
mcp:prompts:get
mcp:roots:choose
mcp:roots:remove
mcp:session:status
mcp:session:reset
~~~

preload 只暴露 server name、prompt name、opaque root id 和脱敏结果；不能接受 renderer 提交任意 URL、路径、session id、token 或完整 request body。

设置页 MCP 行增加：

- “启用 session recovery”开关和连接状态。
- sampling 开关、风险说明和当前 server 的会话授权状态。
- roots 列表、添加目录、删除目录和路径披露警告。

聊天 UI 增加 prompt 命令帮助、sampling 审批卡和 session reconnect 状态。prompt 内容、roots absolute path、session id 和 sampling body 不写入 localStorage、session export、memory、usage、hooks 环境或普通 agent event。

## 10. 测试与验收

**实现状态:** 核心代码、自动化测试与本地真实 stdio MCP 子进程集成冒烟已完成；外部 MCP server 的 Electron 桌面 UI 冒烟仍需在具备可用 server 的环境中验证。

测试覆盖：

- RPC multiplexing、server request/notification、未知方法、abort、timeout 和错误脱敏。
- stdio/SSE/HTTP inbound roots/sampling、HTTP session header、SSE reconnect、stdio restart、session expiry。
- recovery 开关默认值、idle eviction、config/OAuth/roots invalidation、一次重连和 no-replay 证明。
- prompt list/get、参数边界、content truncation、cache invalidation、slash command input-only 行为。
- root picker sender ownership、canonical path、root token injection、项目根切换和 public/export redaction。
- sampling disabled、逐次 approval、allow_session scope、full-auto 不绕过、上下文策略、limits、abort、usage/privacy。
- D8 OAuth/SSRF、C5 resources/stdio、D7 PR 工作台和子 Agent 行为回归。

Definition of Done：

- D8 自动化和桌面验收通过后，D9 全部单测、`node --check`、`git diff --check` 通过。
- 真实 MCP server 完成 prompt 获取、roots/list、sampling 审批、run 间复用和断线恢复桌面冒烟。
- recovery 关闭时的旧 server 生命周期与 D8 完全一致；无秘密或 session identifier 泄漏。

本地验收记录：独立 Node stdio MCP 子进程已覆盖 prompt 获取、resource 读取、roots/list、sampling 审批、run 间复用、子进程崩溃后恢复和 session reset；该测试不替代外部 server 的 Electron 桌面 UI 手工冒烟。

## 11. 实施顺序

1. 抽取共享 RPC dispatcher，补齐三传输 inbound request/notification 测试。
2. 扩展配置规范化、main-owned roots picker/token 和 public settings 合同。
3. 实现 session manager、lease、idle eviction、transport recovery 和 no-replay 规则。
4. 接入 prompts client/hub、IPC、slash command 和设置 UI。
5. 接入 sampling callback、审批、模型调用、usage 和稳定错误。
6. 完成隐私回归、README D9、全量测试和真实 MCP 桌面验收。

## 12. 假设与后续阶段

- roots 可以位于项目外，但必须由用户通过系统目录选择器明确授权。
- recovery 默认关闭；不跨应用重启保存 session id，也不增加后台连接。
- sampling 的 server prompt 被视为不可信数据，不能改变 host policy、工具权限或 system prompt。
- 更完整的 MCP session migration、elicitation、tasks 和多账号 OAuth 保留给后续阶段。
