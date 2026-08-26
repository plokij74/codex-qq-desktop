# Phase D.8 - MCP OAuth 与 SSRF 加固设计规格

**日期:** 2026-08-24
**项目:** `codex-qq-desktop`
**状态:** 设计已确认，待实施
**前置:** Phase C.5 MCP 多传输与资源、Phase D.7 GitHub PR 生命周期

## 1. 目标与范围

D8 为现有 HTTP/SSE remote MCP 增加 OAuth 授权闭环，并强化远程 MCP 请求的 DNS、私网地址和重定向防护。

本阶段交付：

- OAuth 2.1 authorization code + PKCE（S256）。
- 系统浏览器授权与一次性 loopback 回调。
- Protected Resource Metadata、Authorization Server Metadata 和 Dynamic Client Registration。
- 主进程 token 管理、自动 refresh、401 单次重试和显式退出授权。
- Electron `safeStorage` 加密凭据文件；加密不可用时仅允许当前进程内存保存。
- HTTP/SSE MCP 请求的 DNS rebinding、私网地址、危险端口、跨源 endpoint 与重定向防护。
- 设置页 OAuth 状态、授权、重新授权、退出授权和受限端点覆盖。

明确非目标：

- stdio MCP OAuth。
- MCP prompts、sampling、roots 扩展。
- OAuth device authorization、OIDC 身份展示和多账号切换。
- GitHub fork、跨 remote PR 和后台 MCP 轮询。
- 明文 token 文件、token 进入 renderer/localStorage/session export/usage/memory/log。
- 新增 npm runtime 依赖。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 授权入口 | 仅设置页显式操作可启动浏览器授权；Agent 运行、401 或模型输出不得自动打开浏览器 |
| 回调方式 | 系统浏览器 + 主进程监听 `127.0.0.1` 随机端口的一次性 callback |
| OAuth 流程 | authorization code + PKCE S256；不使用 client secret |
| 客户端注册 | 发现优先；无 `clientId` 时尝试 DCR；不支持 DCR 时允许配置公开 `clientId` |
| 元数据兼容 | 自动发现优先，允许用户覆盖 authorization/token/registration/revocation endpoint 和 scopes |
| 凭据保存 | Electron `safeStorage` 加密 userData 文件；不可用时只保留内存凭据，绝不明文回退 |
| token 生命周期 | access token 过期前刷新；401 最多 refresh + retry 一次；不自动重放工具调用 |
| 退出授权 | 若存在 revocation endpoint 则显式调用，之后无论远端结果如何都删除本地凭据 |
| SSRF 默认 | 公共地址默认允许，私网/回环/链路本地/保留地址默认拒绝 |
| 本地 MCP | 每个 HTTP/SSE server 显式设置 `allowPrivate: true` 后才允许本地地址 |
| OAuth endpoint | 即使 MCP transport 开启 `allowPrivate`，OAuth discovery/token/registration/revocation endpoint 仍要求公共 HTTPS |
| 认证隔离 | 一个规范化 resource URL + authorization server 对应一套凭据，不按 server name 绑定 |
| 子 Agent | 沿用现有行为，子 Agent 不启动或使用 MCP hub |

## 3. 当前基线与兼容边界

当前 C.5 MCP 实现：

- HTTP/SSE 只支持静态 `headers`。
- `mcp-hub` 在每次主 Agent run 开始时连接，在结束时关闭。
- MCP server 失败只报告状态，不阻止其它 server 继续连接。
- `url-guard` 目前允许 MCP 使用私网地址，`web-fetch` 已有安全 DNS lookup 可复用。
- Electron 使用 context isolation、sandbox 和 `nodeIntegration: false`。

D8 保持：

- stdio 配置和现有无 OAuth 的公网 MCP 调用方式。
- 每次 Agent run 独立连接/关闭 MCP hub。
- MCP 工具风险仍为 `mcp`，不改变既有 permission gate。

D8 改变：

- HTTP/SSE remote MCP 默认不再允许私网地址；已有 localhost 配置需要显式开启 `allowPrivate`。
- OAuth 模式下静态 `Authorization` header 不再生效，由主进程动态 Bearer token 覆盖。

## 4. MCP 配置模型

远程 server 的规范化形状：

~~~json
{
  "name": "remote",
  "transport": "http",
  "enabled": true,
  "url": "https://example.com/mcp",
  "timeoutMs": 60000,
  "allowPrivate": false,
  "auth": "oauth",
  "oauth": {
    "clientId": "",
    "resource": "",
    "authorizationServer": "",
    "authorizationEndpoint": "",
    "tokenEndpoint": "",
    "registrationEndpoint": "",
    "revocationEndpoint": "",
    "scopes": []
  }
}
~~~

规范化规则：

- `auth` 缺失时为 `none`；只有 `auth: "oauth"` 才启用 OAuth。
- `allowPrivate` 只对 HTTP/SSE transport 有效，默认 `false`。
- OAuth endpoint 必须是无 credentials、无 fragment 的绝对 HTTP(S) URL；实际网络访问还要经过 D8 endpoint guard。
- `clientId`、endpoint 和 scope 均限长；不接受 `clientSecret` 字段。
- OAuth 模式保留非 Authorization 的自定义 headers；任何大小写形式的静态 Authorization header 都由动态 token 覆盖。
- stdio 项忽略 `auth`、`oauth` 和 `allowPrivate`，保持旧配置兼容。
- 配置校验仍在 settings load/save 和 main IPC 两侧执行，renderer 传来的配置不能绕过规范化。

OAuth `resource` 未配置时使用当前 MCP URL 的规范化地址。配置的 resource 只能是通过同一 URL/SSRF 策略校验的公共 HTTPS 地址。

## 5. OAuth 授权流程

### 5.1 元数据发现

主进程按以下顺序获取元数据：

1. 使用 RFC 9728 的 path-aware well-known 规则查找 Protected Resource Metadata。
2. 若 MCP resource 返回 `401`，解析 `WWW-Authenticate: Bearer resource_metadata=...` 并使用其地址。
3. 从 `authorization_servers` 选择配置的 `authorizationServer`，否则选择第一个有效项。
4. 获取 RFC 8414 Authorization Server Metadata；必要时按标准回退到 OpenID configuration。
5. 将用户显式覆盖的 endpoint 作为最终值，但每个覆盖值都必须重新通过 endpoint guard。

元数据请求只接受 bounded JSON 响应，不携带用户 token 或静态 Authorization header。每个 discovery 重定向最多 3 跳，每跳重新做 URL、DNS 和私网校验。

### 5.2 DCR 与授权地址

没有配置 `clientId` 且元数据存在 registration endpoint 时，发送 public client 注册：

~~~json
{
  "client_name": "Codex QQ Desktop",
  "redirect_uris": ["http://127.0.0.1:<port>/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
~~~

由于 loopback 端口每次随机，DCR 使用当前授权流程的实际 redirect URI；不保存 client secret。服务端返回 secret 时不写入持久化凭据，若后续要求 secret 则返回明确错误并要求用户配置可公开使用的 clientId。

授权地址包含：

- `response_type=code`
- `client_id`
- 当前 loopback `redirect_uri`
- 随机 `state`
- `code_challenge`
- `code_challenge_method=S256`
- 已知时的 `resource`
- 用户配置的 `scopes`（未配置时不臆造 scope）

授权地址只通过 `shell.openExternal` 打开，不进入 renderer HTML。

### 5.3 Loopback callback

- 主进程使用 `http.createServer` 绑定 `127.0.0.1` 和随机端口。
- 只接受 GET `/oauth/callback`，只处理第一个请求，然后立即关闭 listener。
- 必须严格校验 `state`；state、code、verifier 只保存在内存。
- 5 分钟未完成则返回 `MCP_OAUTH_CALLBACK_TIMEOUT` 并关闭 listener。
- callback 页面只返回通用成功/失败文字，不回显 code 或错误 query。
- 每个 server 同时只允许一个授权流程；窗口销毁、用户取消或应用退出都会关闭 listener。

### 5.4 Token exchange 与 refresh

authorization code exchange 使用 `grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`code_verifier`，已知时附带 `resource`。

响应必须包含非空 `access_token`；`token_type` 缺失时按 Bearer 处理，存在且不是 Bearer 时拒绝。保存：

- access token；
- refresh token；
- token type；
- expiresAt；
- scope；
- resource；
- authorization server；
- clientId。

refresh 使用 `grant_type=refresh_token`。新响应没有 refresh token 时保留旧 refresh token。出现 `invalid_grant` 或同等不可恢复错误时删除本地凭据并返回 `MCP_AUTH_REQUIRED`。

## 6. 凭据存储

新增主进程 OAuth store，文件位于 Electron `userData`：

~~~json
{
  "version": 1,
  "cipher": "electron-safeStorage",
  "payload": "<base64 encrypted JSON>"
}
~~~

- 文件内容整体由 `safeStorage.encryptString` 加密，使用临时文件 + 原子替换写入。
- store key 使用规范化 resource URL 与 authorization server 的 hash，不直接使用 server name。
- token 不进入 settings.json、renderer 状态、session export、memory、usage、hooks 环境、Agent event 或错误文本。
- `safeStorage.isEncryptionAvailable() === false` 时使用内存 map，并在状态中标记 `persistence: "memory"`。
- 解密失败返回 `MCP_OAUTH_STORE_CORRUPT`，不删除或覆盖原文件。
- store 加载、保存、删除均不阻断无关 Agent 或非 OAuth MCP server。

## 7. MCP client 与 hub 接口

HTTP/SSE client 增加动态认证依赖：

~~~js
authProvider: {
  getHeaders: async () => ({ Authorization: 'Bearer <internal>' }),
  refresh: async () => true
}
~~~

实际 token 只在 main/ai 内部存在，上述示例不作为 renderer 或日志接口。

请求行为：

1. 请求前异步取得动态 headers。
2. 收到 401 且尚未重试时调用 refresh。
3. refresh 成功后重建 Authorization header 并重试原请求一次。
4. 第二次 401、无 refresh token 或 refresh 失败时返回 `MCP_AUTH_REQUIRED`。
5. 不自动重新执行 JSON-RPC tool call，不自动打开浏览器。

SSE 的 GET 地址和服务端返回的 message endpoint 必须与配置 resource 同源；跨源 endpoint 返回 `MCP_ENDPOINT_ORIGIN`，禁止发送 Bearer 或静态敏感 header。

`mcp-hub` 接收 OAuth manager/provider factory。单 server 的 discovery、认证、网络或工具列表失败只发送脱敏 `mcp-status`，其它 server 继续启动。OAuth manager通过 main 的 run extensions 注入，子 Agent extensions 继续剥离。

## 8. SSRF 与网络安全

将 `web-fetch.js` 现有 `makeSafeLookup` 抽取为共享网络安全模块，保留 web-fetch 现有测试和行为。

公共地址模式：

- URL 必须是 HTTP(S)，不得携带 username/password。
- 拒绝常见危险服务端口、特权非 HTTP(S) 端口和非法主机。
- literal IP 和 DNS 所有解析结果都检查 loopback、私网、link-local、metadata、保留和 IPv4-mapped IPv6 范围。
- DNS 返回任一 blocked 地址时整体 fail-closed，不选择“安全的另一个地址”。
- socket 使用预校验地址，保留原 hostname 作为 HTTPS SNI/Host。

重定向与 endpoint：

- MCP JSON-RPC 请求不自动跟随重定向。
- metadata helper 最多跟随 3 跳；每跳重新校验，禁止 HTTPS 降级或进入私网。
- OAuth endpoint 不因 MCP 的 `allowPrivate` 而放宽。
- SSE 动态 endpoint 必须同源，避免服务端通过 endpoint 事件诱导 token 外发。
- OAuth authorization URL 经过公共 HTTPS 校验后才交给系统浏览器。

稳定网络错误：

~~~text
MCP_SSRF_PRIVATE
MCP_SSRF_DNS
MCP_SSRF_REDIRECT
MCP_ENDPOINT_ORIGIN
~~~

## 9. IPC 与 renderer UI

新增 main IPC：

~~~text
mcp:oauth:status
mcp:oauth:authorize
mcp:oauth:cancel
mcp:oauth:logout
~~~

preload API：

~~~js
getMcpOAuthStatus()
startMcpOAuth({ name })
cancelMcpOAuth({ flowId })
logoutMcpOAuth({ name })
onMcpOAuthEvent(callback)
~~~

renderer 只能提交已保存的 server `name` 或当前 flowId；main 根据 name 重新加载配置，不能接受 renderer 提交的任意 token、URL、endpoint、文件路径或 client secret。

状态返回：

~~~js
{
  name,
  auth: 'none' | 'oauth',
  authorized: boolean,
  expiresAt: number | null,
  canRefresh: boolean,
  persistence: 'encrypted' | 'memory' | 'unavailable'
}
~~~

设置页远程 server 行增加 OAuth 状态和显式操作按钮。未保存 OAuth 草稿必须先保存设置才能授权。测试连接在没有 token 时返回 `MCP_AUTH_REQUIRED`，不自动启动浏览器。

授权事件只包含：

~~~js
{
  flowId,
  name,
  state: 'starting' | 'waiting' | 'exchanging' |
         'success' | 'error' | 'cancelled',
  code?,
  error?
}
~~~

事件不得包含 authorization code、access token、refresh token、完整响应体或敏感 query。

## 10. 稳定错误与隐私

新增 OAuth 错误：

~~~text
MCP_AUTH_REQUIRED
MCP_OAUTH_DISCOVERY_FAILED
MCP_OAUTH_METADATA_INVALID
MCP_OAUTH_CLIENT_REQUIRED
MCP_OAUTH_REGISTRATION_FAILED
MCP_OAUTH_CALLBACK_TIMEOUT
MCP_OAUTH_STATE_MISMATCH
MCP_OAUTH_TOKEN_FAILED
MCP_OAUTH_REFRESH_FAILED
MCP_OAUTH_STORE_UNAVAILABLE
MCP_OAUTH_STORE_CORRUPT
MCP_OAUTH_REVOKE_FAILED
~~~

所有网络错误必须截断并移除 Bearer、Authorization、refresh token、authorization code 和敏感 query 参数。认证失败、超时和应用关闭不得自动重放授权或 MCP 工具调用。

## 11. 测试与验收

新增或修改测试覆盖：

- Protected Resource Metadata、`WWW-Authenticate`、Authorization Server Metadata、端点覆盖和 DCR。
- PKCE challenge、state 校验、一次性 callback、超时、取消和浏览器打开失败。
- token exchange、过期 refresh、并发 refresh、401 单次重试、invalid_grant 和 revocation。
- `safeStorage` 正常、不可用、解密失败、原子写入和明文泄漏检测。
- HTTP/SSE 动态 Authorization、静态 header 兼容、跨源 SSE endpoint。
- DNS 混合公网/私网、IPv4/IPv6、DNS rebinding、重定向到私网、HTTPS 降级和危险端口。
- 配置注入、sender/flow ownership、token 不进入 public settings/export/localStorage/usage/log。
- localhost MCP 在显式 `allowPrivate=true` 下可用，未显式开启时拒绝。

最终验收：

- `npm test` 全绿。
- 全部 JavaScript 文件通过 `node --check`。
- `git diff --check` 通过。
- 桌面手工验证真实 HTTPS MCP 授权、应用重启后的 refresh、退出授权和安全错误。
- D7 PR 工作台、主工作区和既有 stdio MCP 行为不回归。

## 12. 实施顺序

1. 抽取共享 DNS/URL 安全层，补齐 URL guard 和 web-fetch 回归。
2. 扩展 MCP 配置规范化和 settings 公开/保存合同。
3. 实现 OAuth store、metadata discovery、DCR、PKCE loopback 和 token lifecycle。
4. 接入 HTTP/SSE 动态认证、refresh lock、401 retry 和同源校验。
5. 接入 MCP hub/provider、main IPC、preload 和设置 UI。
6. 完成隐私回归、README D8 说明、自动化验收和桌面冒烟。

## 13. 假设与后续阶段

- 一个 resource/authorization server 只保存一套凭据，不做账号列表和切换。
- 动态注册使用当前随机 loopback redirect URI；配置 public clientId 时跳过 DCR。
- DCR 返回 client secret 时不持久化；需要 secret 的服务不属于 D8 支持范围。
- 现有本地 HTTP/SSE 配置升级后必须显式设置 `allowPrivate`，不会自动将旧配置提升为可信私网配置。
- D8 不改变 MCP permission risk、Agent full-auto 语义或 session export 合同。
- MCP prompts/sampling、GitHub fork、OAuth device flow 和更复杂的 MCP session recovery 保留给后续阶段。
