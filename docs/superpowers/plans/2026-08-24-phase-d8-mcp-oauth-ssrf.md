# Phase D.8 - MCP OAuth 与 SSRF 加固实施计划

设计规格：docs/superpowers/specs/2026-08-24-phase-d8-mcp-oauth-ssrf-design.md
实施状态：代码完成，待手工验收

执行记录（2026-08-24）：D8 代码实现、自动化回归和 JavaScript 静态检查已完成；`npm test` 为 656/656 通过，`node --check` 与 `git diff --check` 通过。真实第三方 HTTPS OAuth MCP 的浏览器授权、重启恢复、refresh/revoke 和桌面 UI 流程仍需手工验收，因此暂不标记为已交付。
目标：在不增加 runtime 依赖的前提下，为 HTTP/SSE remote MCP 增加主进程 OAuth 授权、加密 token 生命周期和公共地址默认的 SSRF 防护。

## 1. 实施约束

- 保留 stdio MCP、无 OAuth 公网 MCP、既有 permission risk=mcp 和每 run hub 生命周期。
- 不把 token、authorization code、client secret 或完整 OAuth 响应传入 renderer、Agent event、session export、memory、usage 或日志。
- 授权只能由设置页显式触发；Agent 运行只能静默 refresh，不能启动浏览器。
- safeStorage 不可用时允许当前进程内存凭据，但绝不明文落盘。
- 现有 localhost/内网 HTTP/SSE 配置升级后必须显式设置 allowPrivate=true。
- 所有新增网络和 OAuth 逻辑必须支持依赖注入，单测不依赖外网、系统浏览器或真实密钥环。

## 2. Task 0 - 基线与测试 seam

- [x] 阅读并冻结 D8 spec；确认 D7 未提交工作区改动不被覆盖。
- [x] 为 OAuth store、HTTP request、DNS lookup、时间、随机数、loopback server 和 external opener 定义可注入 seam。
- [x] 保留 Electron main 的安全边界：context isolation、sandbox、nodeIntegration=false。
- [x] 运行现有 npm test 作为基线，记录失败与宿主环境 skip。
- [x] 为 OAuth 相关测试创建统一 mock response、mock safeStorage 和 mock clock helper。

## 3. Task 1 - 共享网络安全层

涉及：src/ai/url-guard.js、src/ai/web-fetch.js、新增共享网络模块。

- [x] 将 web-fetch 的 makeSafeLookup 抽到共享模块，支持 allowPrivate 参数和注入的 DNS 实现。
- [x] DNS 使用 all=true 检查所有结果；任一 blocked 地址命中时整体拒绝，不能只选择首个公网地址。
- [x] 保留 hostname 作为 HTTPS SNI/Host，同时将 socket lookup 固定到已校验地址。
- [x] 增加公共 endpoint guard：HTTP(S)、无 credentials、无 fragment、端口范围、literal IP 和域名规则。
- [x] 增加 bounded JSON metadata request helper：整体 timeout、响应大小上限、AbortSignal 和错误脱敏。
- [x] discovery 请求最多跟随 3 次重定向；每一跳重新 guard，禁止 HTTPS 降级、私网目标和危险端口。
- [x] MCP JSON-RPC request 不自动跟随重定向。
- [x] allowPrivate 只由 MCP transport 配置显式传入；OAuth metadata/token/registration/revocation 不继承该放行。
- [x] 回归 web-fetch 现有 URL、DNS、redirect、timeout、abort 和内容限制行为。

## 4. Task 2 - MCP 配置与 settings 合同

涉及：src/ai/mcp-config.js、src/ai/settings.js、src/main.js、renderer MCP settings draft。

- [x] 增加 auth、allowPrivate 和 oauth 字段的规范化。
- [x] 只接受 auth=none|oauth；OAuth endpoint 必须为绝对 HTTP(S) URL，限制长度且禁止 credentials/fragment。
- [x] 限制 public clientId、scope 数量/长度和 endpoint 覆盖字段；丢弃 clientSecret。
- [x] OAuth 模式忽略静态 Authorization header，但保留其它自定义 headers。
- [x] stdio 配置忽略 D8 字段并保持旧版 command-only 配置兼容。
- [x] 公开 settings 只返回脱敏 OAuth 配置和 status 摘要，不返回 token store 内容。
- [x] 明确旧 localhost/内网配置不自动升级为可信配置，需在 UI 显式打开 allowPrivate。
- [x] 增加配置单测：旧配置、重复 name、非法 endpoint、OAuth 字段注入、Authorization header 覆盖和本地地址策略。

## 5. Task 3 - OAuth encrypted store

新增建议模块：src/ai/mcp-oauth.js，必要时拆出 src/ai/mcp-oauth-store.js。

- [x] 实现 createMcpOAuthManager，依赖注入 safeStorage、userDataPath、HTTP request、clock、random bytes 和 external opener。
- [x] 使用 userData 下的版本化 encrypted envelope 保存完整 token JSON。
- [x] store key 使用规范化 resource URL + authorization server 的 hash，不使用 server name。
- [x] 使用临时文件 + 原子替换写入；保存/删除失败不影响其它 MCP server。
- [x] safeStorage 不可用时使用 memory-only map，并返回 persistence=memory。
- [x] 解密失败返回 MCP_OAUTH_STORE_CORRUPT，不删除或覆盖原文件。
- [x] 实现脱敏 status：authorized、expiresAt、canRefresh、persistence、lastErrorCode。
- [x] 实现按 key 的 refresh lock，合并并发 refresh，避免重复使用 refresh token。
- [x] 单测覆盖加密成功、不可用、解密失败、原子写入、凭据删除和并发 refresh。

## 6. Task 4 - OAuth discovery、DCR 与 loopback

- [x] 实现 RFC 9728 Protected Resource Metadata 的 path-aware discovery。
- [x] 处理资源 401 的 WWW-Authenticate resource_metadata 地址。
- [x] 实现 Authorization Server Metadata 和标准 OpenID configuration fallback。
- [x] 配置的 authorization server 优先；否则使用 metadata 第一个有效 authorization server。
- [x] 实现受限 endpoint override，并对每个 override 重新执行公共 HTTPS/SSRF guard。
- [x] 未配置 clientId 时使用当前随机 loopback redirect URI 执行 DCR。
- [x] DCR 使用 public client、authorization_code/refresh_token、response_type=code 和 token_endpoint_auth_method=none。
- [x] 不保存 DCR 返回的 client secret；需要 secret 的服务返回 MCP_OAUTH_CLIENT_REQUIRED 或明确不支持错误。
- [x] loopback server 绑定 127.0.0.1、随机端口和固定 callback path，仅接受一次 GET。
- [x] 使用 state + PKCE S256；5 分钟 timeout；cancel、window destroyed、app quit 都关闭 listener。
- [x] callback 页面不回显 code、state 或错误 query。
- [x] 授权地址只能通过 main 的 shell.openExternal 打开。
- [x] 单测覆盖 metadata 顺序、DCR、PKCE、state mismatch、callback timeout、取消、重复 flow 和 opener 失败。

## 7. Task 5 - Token exchange、refresh、revoke

- [x] 实现 authorization code exchange，校验 access_token、token_type、expires_in 和 bounded response。
- [x] 默认 resource 为规范化 MCP URL；配置 resource 时使用已校验的 override。
- [x] access token 过期前 60 秒触发 refresh。
- [x] refresh response 缺少新 refresh token 时保留旧值。
- [x] invalid_grant 或不可恢复 refresh 错误删除本地凭据并返回 MCP_AUTH_REQUIRED。
- [x] logout 在 revocation endpoint 存在时发送 token、client_id 和 token_type_hint。
- [x] revocation 失败不阻止本地删除，但返回 MCP_OAUTH_REVOKE_FAILED 警告。
- [x] 所有 token endpoint 请求不跟随重定向、不打印响应原文、不向非授权 host 泄露 token。

## 8. Task 6 - HTTP/SSE client 与 MCP hub

涉及：src/ai/mcp-http.js、src/ai/mcp-sse.js、src/ai/mcp-client.js、src/ai/mcp-hub.js、src/ai/providers/mcp.js。

- [x] 为 HTTP/SSE client 增加异步 authProvider.getHeaders() 和 authProvider.refresh() seam。
- [x] 每次请求动态构造 header；OAuth Authorization 覆盖静态同名 header。
- [x] 401 只执行一次 refresh + retry；第二次 401 不重放。
- [x] OAuth 无凭据、refresh 失败和 token store unavailable 映射为稳定错误。
- [x] SSE 初始 GET 与 message POST 都使用认证；服务端返回的 endpoint 必须同源。
- [x] hub 创建 client 时按 remote server 注入 OAuth provider；stdio 不注入。
- [x] server 认证或网络失败时发送脱敏 MCP status，并继续启动其它 server。
- [x] provider 通过 main run extensions 获取 OAuth manager；子 Agent 不继承 manager/hub。
- [x] 更新 HTTP/SSE/hub 测试，确保旧 static headers、resources 和 transport routing 不回归。

## 9. Task 7 - IPC、preload 与设置 UI

涉及：src/main.js、src/preload.js、src/renderer/app.js、src/renderer/index.html、src/renderer/styles.css。

- [x] main 在 app ready 后创建单例 OAuth manager；测试可注入替代实现。
- [x] 增加 mcp:oauth:status、authorize、cancel、logout IPC。
- [x] authorize/logout payload 只接受保存配置的 server name；cancel 只接受 sender-owned flowId。
- [x] window destroyed 时清理该 sender 的 pending OAuth flow。
- [x] preload 只暴露 status、显式授权、取消、退出授权和脱敏事件监听。
- [x] 设置行增加 OAuth mode、allowPrivate、本地地址提示、授权/重新授权/退出授权按钮和状态。
- [x] endpoint override、clientId、resource、scopes 放入高级设置；不提供 client secret 输入。
- [x] 未保存 draft 禁止授权并提示先保存；测试未授权 server 只显示 auth required。
- [x] 授权事件不依赖 active chat，设置页关闭或无 chat run 时仍能完成状态刷新。
- [x] renderer 不把 token 或授权 URL 写入 localStorage/session/export。
- [x] 增加 renderer state/source contract 测试和 IPC sender/argument injection 测试。

## 10. Task 8 - 隐私、错误与文档

- [x] 统一 redact Bearer、Authorization、refresh token、authorization code 和敏感 query。
- [x] 固定 OAuth/SSRF 错误码和用户可见中文错误，不暴露完整远端响应。
- [x] 增加 D8 README 章节：OAuth 授权、safeStorage fallback、allowPrivate 风险、退出授权、不会自动弹浏览器。
- [x] 明确 OAuth status 不进入 session export、memory、usage 和聊天记录。
- [x] 更新 C.5/D7 后续路线图引用为 D8。
- [x] 不修改既有 D7 规格和工作区中的用户改动。

## 11. 自动化验收

- [x] npm test 全绿。
- [x] 全部 JavaScript 文件通过 node --check。
- [x] git diff --check 通过。
- [x] 无新增 runtime dependency。
- [x] 检查 token、authorization code、refresh token 不出现在测试输出、错误、事件和导出文本。
- [x] 检查旧 stdio、无 OAuth 公网 HTTP/SSE、MCP resources、permission gate 和 subagent 行为不回归。

## 12. 桌面手工冒烟

- [ ] 使用真实 HTTPS OAuth MCP server 从设置页完成授权。
- [ ] 授权后测试连接能加载 tools/resources，Agent run 能调用工具。
- [ ] 重启应用后 status 恢复，过期 token 能静默 refresh。
- [ ] 手动退出授权后本地状态清除，远端 revocation 结果显示为成功或警告。
- [ ] Agent 遇到未授权 server 时只显示 auth required，不自动打开浏览器。
- [ ] 公共 server 的 DNS/redirect 安全策略生效。
- [ ] 显式 allowPrivate=true 的 localhost MCP 可用，未显式开启时被拒绝。
- [ ] D7 PR 工作台和主工作区状态不受影响。

## 13. Definition of Done

D8 只有在 OAuth 授权、token refresh/revoke、safeStorage fallback、DNS/redirect SSRF 防护、IPC/UI、隐私回归、自动化测试和桌面冒烟全部完成后，才标记为已交付。单元测试通过但未完成真实桌面授权冒烟时，状态保持“代码完成，待手工验收”。
