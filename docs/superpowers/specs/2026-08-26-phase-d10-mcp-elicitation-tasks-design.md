# Phase D.10 - MCP Elicitation 与 Tasks 设计规格

**日期:** 2026-08-26  
**项目:** `codex-qq-desktop`  
**状态:** 设计已确认，实施中  
**前置:** Phase D.8 MCP OAuth/SSRF、Phase D.9 MCP prompts/roots/sampling/session recovery

## 1. 目标与范围

D10 为现有 MCP 客户端增加 MCP 2025-11-25 的 Elicitation 与 Tasks 能力，并把长时间运行任务从 Agent run 生命周期中解耦。

本阶段交付：

- Elicitation `form` 与 `url` 两种模式。
- server 发起的 `sampling/createMessage` task-augmented 请求。
- server 发起的 `elicitation/create` task-augmented 请求。
- server 对 `tools/call` 的 task augmentation。
- 任务状态轮询、结果读取、取消、列表、通知、TTL 和重启恢复。
- 任务中心复用现有“已安排”视图，并在聊天时间线显示任务卡。
- main-owned 加密任务存储、后台轮询和安全的结果确认写回。
- MCP 协议版本协商和传输层兼容修复。

明确非目标：

- 不实现跨设备任务同步或多账号任务归属。
- 不自动重放有副作用的工具调用、sampling 正文或 elicitation 输入。
- 不因 MCP server 请求自动打开浏览器或自动提交用户表单。
- 不让 renderer 持有 token、远端 task ID、任务正文或表单敏感内容。
- 不改变 D8 OAuth、SSRF、permission gate 和 D9 子 Agent 隔离边界。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 协议版本 | 初始化优先 `2025-11-25`；明确不兼容时回退 `2024-11-05`；校验 server 回选版本 |
| 功能协商 | 只按 initialize 双方声明能力启用；配置不能强制覆盖 server 能力 |
| Tasks 默认值 | 关闭；启用后 `required`/`optional` 工具优先走任务，`forbidden` 保持同步 |
| Elicitation | 同时支持 `form` 与 `url`，各自按协商能力启用 |
| stdio framing | 新连接使用标准 newline JSON；reader 兼容旧 `Content-Length`，首包探测后固定模式 |
| 任务所有者 | main-owned task manager 独立于 Agent run、renderer 页面和 D9 session manager |
| Agent stop | 只停止当前 Agent；不自动取消远端任务 |
| 任务结果 | 重启恢复后必须用户确认，作为新消息发送；不自动写回原聊天记录 |
| 孤立任务 | 原会话/项目不可用时标记 `orphaned`，只能由用户明确认领 |
| URL 安全 | 生产仅公共 HTTPS；开发环境需额外显式开关，不能继承 MCP `allowPrivate` |
| Elicitation 并发 | 同一 server/task FIFO；全局最多一个前台交互 |
| 配置变更 | 有未完成任务时阻止修改/删除 server，除非先取消或明确遗弃引用 |
| 存储降级 | `safeStorage` 不可用时只允许进程内运行，禁止明文跨重启恢复 |

## 3. 协议版本与能力协商

### 3.1 初始化

所有 transport 共享版本选择逻辑：

1. client 发送 `initialize.protocolVersion = "2025-11-25"`。
2. client 声明：

   ```json
   {
     "elicitation": { "form": {}, "url": {} },
     "tasks": {
       "list": {},
       "cancel": {},
       "requests": {
         "sampling": { "createMessage": {} },
         "elicitation": { "create": {} }
       }
     }
   }
   ```

   实际声明必须受本地配置和功能可用性约束。Tasks 关闭时不声明 Tasks；Elicitation 关闭或对应模式不可用时不声明该模式。
3. client 要求 response 的 `protocolVersion` 必须是 `2025-11-25` 或 `2024-11-05`。
4. server 回选 `2025-11-25` 时启用 D10；回选 `2024-11-05` 时保持旧协议行为，不发送 task augmentation，不使用 D10 Elicitation。
5. 其它版本、缺失版本或不符合请求的回选均断开并返回稳定版本错误，不猜测兼容。

HTTP/SSE 后续请求统一发送 `MCP-Protocol-Version`，值为已协商版本；Streamable HTTP 同时保留 D9 的 `Mcp-Session-Id`。

### 3.2 工具任务能力

工具是否使用任务由三层共同决定：

- 本地 `tasks.enabled` 必须为 `true`。
- server 必须声明 `capabilities.tasks.requests.tools.call`。
- `tools/list` 中的 `execution.taskSupport` 决定工具级行为。

行为合同：

| taskSupport | Tasks 已启用且 server 支持 | Tasks 未启用或 server 不支持 |
|-------------|-----------------------------|-------------------------------|
| `required` | 发送带 `params.task` 的调用 | 不注册该工具，避免提供无法满足的能力 |
| `optional` | 优先发送带 `params.task` 的调用 | 同步调用 |
| `forbidden`/缺失 | 同步调用 | 同步调用 |

server capability 是硬门槛；不能由 renderer 配置伪造或覆盖。

## 4. Tasks 数据模型与状态机

### 4.1 MCP 任务

远端任务元数据按 MCP 合同保存：

```js
{
  taskId: string,
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled',
  statusMessage?: string,
  createdAt: string,
  lastUpdatedAt: string,
  ttl: number | null,
  pollInterval?: number
}
```

合法迁移：

```text
working -> input_required | completed | failed | cancelled
input_required -> working | completed | failed | cancelled
completed | failed | cancelled -> terminal
```

本地处置状态 `orphaned`、`abandoned`、`claimed` 不发送给 server，也不伪装成 MCP Task status。

### 4.2 工具任务

创建工具任务时发送：

```json
{
  "name": "tool-name",
  "arguments": {},
  "task": { "ttl": 3600000 }
}
```

初始 response 只接受 `CreateTaskResult.task`。实际结果只能通过 `tasks/result` 获取；不把原始工具请求再次发出。

main task manager 为每个任务生成本地 opaque `taskRef`，Agent 只收到：

```json
{
  "ok": true,
  "task": {
    "taskRef": "mcp_task_<random>",
    "status": "working",
    "server": "<sanitized-name>",
    "tool": "<sanitized-name>",
    "pollIntervalMs": 5000
  }
}
```

远端 task ID、参数、结果正文和 session identifier 不进入 Agent event 或模型上下文。Agent 可使用受控的 `mcp_tasks_list`、`mcp_task_get`、`mcp_task_result` 查询任务；结果经过大小限制和不可信 MCP 输出处理。

### 4.3 Sampling/Elicitation receiver task

当 server 对 `sampling/createMessage` 或 `elicitation/create` 附加 `params.task` 时，client 作为 receiver：

- 立即建立本地 receiver task 并返回 `CreateTaskResult`。
- 任务执行与前台交互在后台继续。
- server 通过 `tasks/get`、`tasks/result`、`tasks/cancel`、`tasks/list` 查询或取消。
- `input_required` 只用于等待用户输入；表单提交后转换回 `working`。
- receiver task 的内部正文只在内存存在，应用重启后不恢复正文，不重放请求。

本地 task manager 需要实现一套针对 server 请求的 task registry，并由 MCP RPC dispatcher 路由 server 后续 Tasks 请求。未知 task、非所属 server 或非法终态转换返回受限错误。

### 4.4 轮询与生命周期

- 优先使用 server 返回的 `pollInterval`，限制在 1 秒至 5 分钟。
- 没有 `pollInterval` 时使用 5 秒指数退避，最大 5 分钟。
- 到达终态或 `ttl` 过期停止轮询。
- `input_required` 触发 `tasks/result` 预取，使前台交互及时可见。
- `notifications/tasks/status` 只作为加速刷新信号，不能替代 `tasks/get`。
- 应用打开期间 main 持续轮询，不依赖当前聊天页或任务中心是否打开。
- D9 session recovery 负责连接复用；D10 task manager 负责任务监控，两者不可互相替代。

### 4.5 资源限制

| 限制 | 默认值 |
|------|--------|
| 默认 TTL | 1 小时 |
| 请求 TTL | 1 分钟至 24 小时 |
| 单 server 活跃任务 | 16 |
| 全局活跃任务 | 64 |
| 轮询间隔 | 1 秒至 5 分钟 |
| 重启后恢复监控 | 最多 24 小时 |
| 历史任务保留 | 500 条 |
| 单任务持久化结果 | 256 KB，超出截断并标记 |

超限时不创建新任务；已存在任务继续遵守 TTL 和取消规则。历史清理优先删除终态记录，不能删除仍处于 `working`/`input_required` 的记录。

## 5. Elicitation 设计

### 5.1 Form mode

client 处理 `elicitation/create` 时接受省略 mode 的旧请求，并按 `form` 处理。支持的 `requestedSchema` 仅为扁平 object 和 primitive 字段：

- string、number、integer、boolean；
- `enum`/`oneOf` 单选；
- `minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`format`；
- format 仅允许 `email`、`uri`、`date`、`date-time`。

拒绝嵌套对象、数组、未知 JSON Schema 关键字、超长描述、过多字段和疑似密码/API key/token/支付凭据字段。服务端提供的 schema、标题和描述均视为不可信文本。

UI 必须显示：server 名称、请求消息、字段标签、约束和当前值。用户可以编辑后选择：

- `accept`：提交经过本地 schema 校验的 content；
- `decline`：明确拒绝，不发送 content；
- `cancel`：关闭或取消，不发送 content。

表单内容只在 main 与 renderer 的短生命周期 IPC 中传递，不进入日志、Agent event、localStorage、session export、memory、usage 或 hooks。

### 5.2 URL mode

URL 请求必须包含 `mode: "url"`、`message` 和 URL。client：

- 不预取 URL 或 metadata；
- 先在前台显示完整 URL、主机和安全提示；
- 只有用户明确同意后才由 main 调用 `shell.openExternal`；
- 不把 URL 页面内容、用户输入或第三方凭据读回应用；
- 支持 `notifications/elicitation/complete`，但不自动重放原工具请求。

生产地址必须为公共 HTTPS，拒绝 credentials、fragment、私网、loopback、危险端口、明显敏感 query 和不合法 host。开发环境只有在显式 `CODEX_DEV_MCP_PRIVATE_URLS=1` 且配置 `elicitation.allowPrivateUrl=true` 时才允许本地地址；该开关不继承 MCP transport 的 `allowPrivate`。

### 5.3 队列与取消

同一 server/task 的 Elicitation 请求按 FIFO 排队；全局最多一个前台表单或 URL 确认。其它请求在内存中等待，不阻塞 transport 的消息接收。

用户关闭窗口、停止 Agent 或切换页面不会自动把已显示请求回复为 accept；需要明确 `cancel`。server 发起取消或 task 取消时，前台请求回传 `cancel`，并清理本地内容。

## 6. 存储、隐私与恢复

### 6.1 加密 envelope

任务记录位于 Electron `userData`，格式沿用 D8：

```json
{
  "version": 1,
  "cipher": "electron-safeStorage",
  "payload": "<base64 encrypted JSON>"
}
```

保存使用临时文件和原子替换。记录字段包含：

```js
{
  localTaskRef,
  serverName,
  serverConfigFingerprint,
  transport,
  remoteTaskId,
  kind: 'tool',
  toolName,
  status,
  statusMessage,
  createdAt,
  lastUpdatedAt,
  ttl,
  pollInterval,
  sessionBinding,
  sourceSessionIdHash,
  sourceProjectPathHash,
  persistedResult,
  resultTruncated,
  localDisposition
}
```

不持久化：工具 arguments、sampling messages、sampling response、elicitation schema/content/input、OAuth token、完整 MCP payload、绝对项目路径和未脱敏错误。

`safeStorage.isEncryptionAvailable()` 为 false 时返回 `persistence: "memory"`，当前进程任务仍可运行，但重启后不恢复；绝不创建明文任务文件。解密失败返回 `MCP_TASK_STORE_CORRUPT`，保留原文件，不覆盖或删除。

### 6.2 配置变更

`settings:save` 在保存前检查待修改或删除 server 是否仍有未完成任务。存在时返回 `MCP_TASKS_CONFIG_LOCKED`，并列出脱敏任务数量与可执行操作：

- 任务中心逐个取消远端任务；或
- 用户确认“遗弃任务引用”，停止本地监控但不向远端发送取消。

取消/遗弃完成后重新保存配置。配置 fingerprint 改变不会自动把旧任务绑定到新配置。

### 6.3 重启与结果认领

应用启动加载加密任务记录，过滤 TTL 和恢复期限。只恢复工具任务的 `tasks/get`/`tasks/result` 监控，不恢复旧 Agent run，不重放 `tools/call`。

若原 session、项目或项目路径快照不可用，任务标记为 `orphaned`。任务中心仍允许查看脱敏状态和结果；用户必须选择一个当前会话并确认，才能创建新的 assistant 消息。认领采用 prepare/commit：

1. `prepare` 再次校验任务处于终态、结果未被认领且目标会话存在。
2. renderer 展示待发送预览和目标会话。
3. `commit` 由 main 原子标记 claimed，并返回 bounded result；renderer 将其作为新消息写入目标会话。

无法确认远端状态时显示“不确定”，不自动重试可能有副作用的请求。

## 7. Main、Preload 与 Renderer 合同

### 7.1 Main-owned 接口

新增建议模块：`src/ai/mcp-task-manager.js`，负责存储、状态机、轮询、恢复、远端 task method 和本地 receiver task。

三种 transport 的 client 暴露统一接口：

```js
callTool(name, args, { task?: { ttl }, signal })
getTask(taskId)
getTaskResult(taskId)
listTasks(cursor)
cancelTask(taskId)
```

MCP hub 负责 capability/tool metadata 与任务路由，不持有任务历史。provider 把 task manager、elicitation handler 和事件回调注入当前 run，但不把 task manager 生命周期绑定到 run。

### 7.2 IPC

建议新增 channel：

```text
mcp:tasks:list
mcp:tasks:get
mcp:tasks:result:prepare
mcp:tasks:result:commit
mcp:tasks:cancel
mcp:tasks:abandon
mcp:elicitation:respond
mcp:elicitation:cancel
mcp:elicitation:open-url
```

所有 IPC 参数只接受已保存 server name、opaque taskRef、sender-owned elicitation ID、目标 session ID 和受限枚举。renderer 不能提交 remote task ID、任意 URL、server endpoint、项目绝对路径或完整 MCP body。`open-url` 由 main 根据内存中的待确认请求查找 URL，不信任 renderer 回传 URL。

事件发送到所有存活窗口，但 payload 只含脱敏字段：

```js
{
  type: 'mcp-task-updated',
  taskRef,
  server,
  tool,
  status,
  localDisposition,
  progressMessage,
  canCancel,
  canClaim
}
```

Elicitation 事件只含本地请求 ID、server、mode、消息和已净化 schema；form values 只通过 sender-owned 响应调用发送。

### 7.3 UI

现有 `data-view="scheduled"` / `showWorkView()` 扩展为任务中心：

- 任务状态、server、工具、创建/更新时间、错误摘要；
- 工作中任务的刷新状态和轮询提示；
- 终态任务的查看结果、认领、删除历史；
- 取消远端任务必须二次确认；
- 遗弃只停止本地监控并明确显示风险；
- 配置锁定时给出跳转任务中心入口。

聊天时间线增加任务卡，只展示 taskRef 和脱敏摘要。任务中心和时间线共用 main task event，不把任务状态写入现有 session message history。

## 8. 错误合同

至少固定以下错误码：

```text
MCP_PROTOCOL_VERSION_UNSUPPORTED
MCP_TASKS_DISABLED
MCP_TASKS_UNAVAILABLE
MCP_TASK_REQUIRED_UNSUPPORTED
MCP_TASK_INVALID
MCP_TASK_NOT_FOUND
MCP_TASK_STATUS_INVALID
MCP_TASK_LIMIT
MCP_TASK_TTL_EXPIRED
MCP_TASK_POLL_FAILED
MCP_TASK_RESULT_UNAVAILABLE
MCP_TASK_CANCEL_FAILED
MCP_TASK_STORE_UNAVAILABLE
MCP_TASK_STORE_CORRUPT
MCP_TASKS_CONFIG_LOCKED
MCP_TASK_ORPHANED
MCP_TASK_CLAIM_INVALID
MCP_ELICITATION_DISABLED
MCP_ELICITATION_UNSUPPORTED
MCP_ELICITATION_SCHEMA_INVALID
MCP_ELICITATION_SENSITIVE_FIELD
MCP_ELICITATION_BUSY
MCP_ELICITATION_CANCELLED
MCP_ELICITATION_URL_INVALID
MCP_ELICITATION_OPEN_FAILED
```

错误消息必须脱敏、限长，不包含 Bearer、token、authorization code、remote task ID、表单值、sampling 内容或完整远端响应。

## 9. 安全边界

- MCP server 返回的工具描述、task status、statusMessage、Elicitation message/schema 和结果全部视为不可信数据。
- server capability 和工具 `taskSupport` 是协议事实，不接受 renderer 或模型覆盖。
- 任务引用按 server/config fingerprint 隔离；renderer 不能跨 server 猜测或枚举 remote task ID。
- 任务 result 不能自动成为聊天指令；认领前必须 bounded、脱敏和用户确认。
- 有副作用的任务只允许监控和显式取消，不自动重放。
- URL elicitation 不预取、不内嵌 WebView、不读回页面内容、不接受 renderer 自带 URL。
- D8 OAuth token 只在 main/AI 内存和既有加密 store 中存在；D10 不扩展其可见范围。
- D9 roots、sampling、session recovery 的 project/session ownership 继续有效。

## 10. 测试与验收

自动化测试覆盖：

- `2025-11-25` 成功协商、回退 `2024-11-05`、非法回选和 HTTP 版本 header；
- newline 与 Content-Length framing、分片读取和探测失败；
- tasks capability、tool `required`/`optional`/`forbidden` 路由；
- tools/call task 创建、poll、result、status notification、input_required、TTL、列表和取消；
- sampling/elicitation receiver task 的 `tasks/get/result/cancel/list`；
- Agent stop 不取消、后台轮询、并发上限、恢复期限、orphan 和 claim prepare/commit；
- form schema 校验、敏感字段、accept/decline/cancel、FIFO 和 sender ownership；
- URL 不预取、完整地址展示、公共 HTTPS、开发私网显式开关和 opener 失败；
- safeStorage 加密、不可用、损坏、原子写入、历史清理和明文泄漏检测；
- 配置锁定、取消/遗弃解锁、D8 OAuth/SSRF 和 D9 session/recovery 回归；
- main/preload/renderer 任务中心、时间线、切页后台事件和新消息确认写回。

桌面验收必须使用真实外部 MCP server，至少完成：

1. server task tool 创建、离开聊天页后状态更新和结果确认写回；
2. `form` elicitation 的 accept/decline/cancel 和校验错误；
3. `url` elicitation 的完整地址确认、系统浏览器打开和不预取证明；
4. sampling task 的后台完成与 server 获取结果；
5. Agent stop、应用重启、任务恢复、orphan 认领、取消和遗弃；
6. D8 OAuth 真实 HTTPS 授权、refresh/revoke、allowPrivate 和 SSRF；
7. D9 prompts、roots、sampling approval、session recovery 与外部 MCP UI 冒烟。

Definition of Done：D8/D9 桌面硬前置、D10 自动化测试、JavaScript 语法检查、`git diff --check`、真实 MCP 桌面流程和隐私回归全部完成后，才将 D10 计划标记为已交付。
