# Phase C.5 — MCP 增强 + Skills 可执行/路由 + 设置列表 UI

**日期:** 2026-07-23  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase C.4 子 Agent 增强（`c6066d5`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §8 Phase C（MCP / Skills）
- `docs/superpowers/specs/2026-07-20-phase-c2-platform-design.md` §1.5（C.5 记账）
- `docs/superpowers/specs/2026-07-23-phase-c4-subagents-design.md` §1.5
- 本轮 brainstorming 锁定决策（见 §2）

---

## 1. 目标与范围

### 1.1 一句话目标

在 C.2 stdio MCP 与 Markdown Skills 之上，交付 **三传输 MCP（stdio / SSE / Streamable HTTP）+ 只读 resources**、**Skills 外部可执行 + triggers 自动路由提示**，以及 **MCP 服务器列表 UI（含测试连接）**；无新 npm 依赖，不把用户 JS `require` 进主进程。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **McpTransport / 多传输客户端** | 统一 `start` / `listTools` / `callTool` / `listResources` / `readResource` / `close`；stdio 迁入；新增 SSE、Streamable HTTP |
| 2 | **mcp-hub 升级** | 按 `transport` + `enabled` 连接；tools 命名保持 `mcp_<server>_<tool>`；resources 缓存与调用 |
| 3 | **resources 只读工具** | `mcp_resources_list` / `mcp_resource_read`；risk=`mcp` |
| 4 | **Skills 可执行** | frontmatter `command`/`args`/`timeoutMs`/`cwd`；工具 `run_skill`；`spawn` + `shell: false` |
| 5 | **自动路由** | frontmatter `triggers[]`；命中后 system 注入 description +「优先 use_skill」提示 |
| 6 | **设置列表 UI** | CRUD、启停、transport 字段、测试连接；JSON 导入替换 |
| 7 | **测试与文档** | config/transport/hub/skills/permission 单测；README Phase C.5 |

### 1.3 非目标（硬边界）

- MCP **prompts** / **sampling** / **roots** 完整支持
- OAuth / 交互式浏览器鉴权（允许用户静态 `headers` / `env`）
- `require()` 用户 skill 目录内 JS 进入 Electron 主进程
- Skills 市场、在线安装、语义向量路由
- DNS 重绑定 / 完整 SSRF 企业级 hardening（文档声明远程 URL 用户自负）
- worktree、子 Agent 再增强、新 npm 依赖

### 1.4 成功标准

1. `mcpEnabled: false` 或无启用 server 时，行为与 C.4 一致（无 MCP 工具、无连接）。  
2. 旧版仅含 `command` 的 `mcpServers` 项默认 `transport: 'stdio'`，stdio 回归通过。  
3. `stdio` / `sse` / `http` 均可在 mock 下完成 initialize + tools/list + tools/call。  
4. 已连接 server 支持 `resources/list` + `resources/read` 时，模型可经只读工具访问；无能力时安全降级。  
5. `run_skill` 仅外部 spawn；非法 cwd / 缺 command → 明确错误；超时/ abort 可杀进程。  
6. triggers 命中出现在 system 片段（最多 5 个 skill）；**不**自动注入 body、**不**自动 run。  
7. 设置页可增删改启停 server 并测试连接；sanitize 丢弃非法项。  
8. plan / depth≥1 不暴露 mcp 工具与 `run_skill`（plan 可保留 list/use_skill）。  
9. `npm test` 全绿；`package.json` 无新 runtime 依赖。

### 1.5 平台化路线图（记账）

| 阶段 | 内容 |
|------|------|
| C.2–C.4 | Registry / Skills MD / explore / stdio MCP / Hooks / 子 Agent |
| **C.5（本规格）** | 三传输 MCP + resources + Skills 可执行/路由 + 列表 UI |
| 以后 | prompts/sampling、OAuth、skill 市场、SSRF 加固 |

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 范围 | **全收（F）**：MCP 传输 + resources + Skills 可执行/路由 + 列表 UI |
| 实现形态 | **方案 1：传输适配层 + 配置模型升级**（统一 hub/provider） |
| 传输 | **stdio + SSE + Streamable HTTP** |
| MCP 能力 | tools + **resources 只读**（无 prompts/sampling） |
| 生命周期 | **每主 agent run** 连接，run 结束断开（与 C.2 一致） |
| Skills 可执行 | 外部 `spawn`，`shell: false`；禁止 require 用户模块 |
| `run_skill` risk | **`write`**（不依赖 terminalEnabled） |
| 自动路由 | triggers 子串命中 → system **description + 优先 use_skill**；不灌全文、不自动脚本 |
| 设置 UI | 列表 CRUD + 启停 + **测试连接**；JSON **导入替换**（列表为源 of truth） |
| 依赖 | 无新 npm 依赖 |

---

## 3. 架构

### 3.1 总览

```
settings.mcpServers[]  (transport, enabled, command|url, …)
        │  sanitizeMcpServers
        ▼
mcpProvider.onRunStart → createMcpHub().startAll
        │
   createMcpClient(cfg) ──┬── stdio (Content-Length JSON-RPC)
                          ├── sse
                          └── http (streamable, 最小子集)
        │
   tools: mcp_<server>_<tool>
   resource tools: mcp_resources_list / mcp_resource_read
        │
   PermissionGate risk=mcp

skills-loader (triggers, command, …)
skillsProvider: list_skills / use_skill / run_skill
getSystemFragment: catalog + 【Skills 自动匹配】
```

- ToolProvider 接口不变。  
- 子 Agent（depth≥1）：MCP / Skills provider 仍关闭（C.2/C.4）。  
- Hooks：主 run 的 `run_skill` / `mcp_*` 走既有 Pre/Post；子 run 无 hooks。

### 3.2 模块（拟）

| 路径 | 职责 |
|------|------|
| `src/ai/mcp-config.js` | `sanitizeMcpServers`、默认 transport 推断、校验 |
| `src/ai/mcp-client.js` | 工厂 `createMcpClient(cfg)`；或 re-export 各 transport |
| `src/ai/mcp-stdio.js` | 现有帧协议（可自 client 拆出） |
| `src/ai/mcp-http.js` | Streamable HTTP 最小客户端 |
| `src/ai/mcp-sse.js` | SSE 最小客户端 |
| `src/ai/mcp-hub.js` | 多 server、路由表、resources |
| `src/ai/skills-loader.js` | frontmatter 扩展字段 |
| `src/ai/providers/skills.js` | `run_skill`、匹配片段 |
| `src/ai/providers/mcp.js` | 资源工具注册（或经 hub.getToolDefs 合并） |
| `src/ai/permission.js` / `agent-mode.js` | `run_skill` risk；plan 隐藏 |
| `src/main.js` / `preload.js` | sanitize、`mcp:testServer` |
| `src/renderer/*` | 列表 UI |
| `tests/*` | 见 §9 |
| `README.md` | Phase C.5 |

### 3.3 与现有子系统

| 子系统 | 关系 |
|--------|------|
| PermissionGate | mcp / run_skill 授权权威 |
| registry | mcp / skills 仍为 provider |
| Hooks | depth 0 工具可挂；不放宽权限 |
| 子 Agent | 不启用 MCP/Skills |
| verify | run_skill **不**计 verify 成功（非 run_terminal） |

---

## 4. MCP 配置与协议

### 4.1 `mcpServers[]` 规范化字段

| 字段 | 说明 |
|------|------|
| `name` | 必填，`^[a-zA-Z0-9_-]+$`；重名保留先出现 |
| `transport` | `'stdio' \| 'sse' \| 'http'`；缺省：有 `command`→stdio，否则有 `url`→http |
| `enabled` | 默认 `true` |
| `command` / `args` / `env` / `cwd` | stdio；`command` 在 stdio 下必填 |
| `url` | sse/http 必填；仅 `http:` / `https:` |
| `headers` | 可选 `Record<string,string>`；键值长度限制（实现定数，如 key≤128、value≤4KiB） |
| `timeoutMs` | 默认 60000；钳制 1000..300000 |

非法项丢弃；可收集 `errors[]` 供 UI。旧配置无 `transport` 仅 `command` → stdio，**兼容 C.2**。

### 4.2 客户端接口

```js
/**
 * @typedef {object} McpClient
 * @property {() => Promise<void>} start
 * @property {() => Promise<object[]>} listTools
 * @property {(name: string, args?: object) => Promise<any>} callTool
 * @property {() => Promise<object[]>} listResources  // 无能力 → []
 * @property {(uri: string) => Promise<any>} readResource
 * @property {() => void|Promise<void>} close
 */
```

| 传输 | 要点 |
|------|------|
| **stdio** | Content-Length JSON-RPC；`initialize`（protocolVersion `2024-11-05`）→ `notifications/initialized` → tools/* |
| **http** | Streamable HTTP **最小子集**：向 `url` POST JSON-RPC；支持 JSON 响应；若 `Content-Type` 为 SSE 则解析 event 中的 JSON-RPC result；不实现会话恢复/复杂重连 |
| **sse** | 最小 MCP-over-SSE：以可 mock 的请求/事件形状固定在实现与测试中（规格要求：initialize + tools/list + tools/call + resources 路径与 stdio 语义对齐） |

共性：超时、`AbortSignal`、失败 `close`、不抛崩 hub。

### 4.3 Hub

1. `startAll`：跳过 `enabled === false`；**串行**连接。  
2. 成功：注册 tools；可选 `listResources` 缓存。  
3. 单 server 失败 → `mcp-status` `{ server, ok:false, error, transport? }`，继续。  
4. `stopAll`：run end。  
5. `call` / resources 读：经 server 映射；结果字符串化截断（默认 32 KiB，标记 `truncated`）。

### 4.4 资源工具（固定名）

| 工具 | risk | 参数 | 返回 |
|------|------|------|------|
| `mcp_resources_list` | mcp | `server?` | `{ ok, resources: [{ server, uri, name?, description?, mimeType? }] }` |
| `mcp_resource_read` | mcp | `server`, `uri` | `{ ok, contents, truncated? }` 或 error |

plan：不注册。confirm-writes：与其他 mcp 相同审批。  

动态工具名仍为 `mcp_<server>_<tool>`，**不得**与上述固定名冲突（固定名保留）。

### 4.5 权限

| 模式 | mcp_* / 资源工具 |
|------|------------------|
| risk | `mcp` |
| confirm-writes | 确认；`allow_session` 可记 `mcp` |
| full-auto | 放行 |
| read-only / plan | 拒绝或不注册 |
| depth≥1 | 无 |

### 4.6 安全

- URL 仅 http(s)  
- 不自动注入 `settings.apiKey` 到 headers/env  
- stdio `shell: false`  
- 输出截断  
- 远程地址 SSRF：本轮不做私网拦截，README 说明风险  

### 4.7 测试连接

IPC `mcp:testServer(config)` → 临时 client start → listTools（+ 可选 listResources）→ close → `{ ok, toolsCount, resourcesCount?, error?, transport }`；默认超时 ≤ 15s。

---

## 5. Skills 可执行与自动路由

### 5.1 Frontmatter 扩展

| 字段 | 说明 |
|------|------|
| `triggers` | 可选；解析为 `string[]`（小写 trim）；最多 20；每条 ≤ 64 字符；支持逗号分隔单行 |
| `command` | 可选；有则 `runnable: true` |
| `args` | 可选；**JSON 数组字符串** 或省略 → `string[]` |
| `timeoutMs` | 默认 30000；钳制 1000..120000 |
| `cwd` | `project`（默认）\| `skill` \| 项目下相对路径；解析后须在 **项目根之内** 或 **该 skill 目录之内** |

### 5.2 工具

| 工具 | risk | 说明 |
|------|------|------|
| `list_skills` | read | 增加 `runnable`、`triggers`（可截断展示） |
| `use_skill` | read | 同 C.2 |
| `run_skill` | **write** | 参数 `name`；可选 `args` 覆盖默认 |

`run_skill` 进程：

- `spawn(command, args, { cwd, env: filteredEnv + CODEX_QQ_SKILL, shell: false, windowsHide: true })`  
- stdin：可选 JSON `{ skill, projectPath, args }`（截断）  
- stdout/stderr 各截断（如 16 KiB）  
- exit≠0 / 超时 / spawn 失败 → `{ ok:false, … }`  
- abort → 杀进程；`ABORTED` 向上  

**禁止：** `shell: true`、主进程 `require(skill)`。

### 5.3 自动路由

1. 取当前 run 用户侧文本（至少最后一条 user；可对超长内容只取前 8 KiB 做匹配）。  
2. 子串、大小写不敏感匹配 `triggers`。  
3. 最多 **5** 个 skill（catalog 顺序）。  
4. system 追加【Skills 自动匹配】列表（name + description 截断 + triggers 提示）+「请优先 use_skill；可执行用 run_skill」。  
5. 不自动 body、不自动 run_skill。

### 5.4 模式矩阵

| 场景 | list/use | run_skill | 匹配片段 |
|------|----------|-----------|----------|
| skillsEnabled false | 无 | 无 | 无 |
| plan | 有 | **无** | 可有 |
| agent | 有 | 有 | 有 |
| depth≥1 | 无 | 无 | 无 |

### 5.5 安全

- cwd 沙箱（项目根 / skill 目录）  
- args 仅数组  
- Gate write  
- 输出截断  

---

## 6. 设置 UI 与 IPC

### 6.1 UI

- 保留 `mcpEnabled`  
- 列表行：enabled、name、transport、stdio 字段或 url、测试、删除  
- 添加服务器  
- 「从 JSON 导入替换列表」；日常保存只序列化列表模型  
- Skills：短说明文案（可执行 + triggers），不做完整编辑器  

文案 **zh-CN**。

### 6.2 IPC

| 通道 | 说明 |
|------|------|
| `settings:get` / `save` | `mcpServers` 经扩展后的 sanitize |
| `mcp:testServer` | §4.7；preload 封装 |

### 6.3 事件

- `mcp-status` 可带 `transport`  
- skill 运行复用 `tool-start` / `tool-end`（不强制新事件类型）

---

## 7. 测试计划

| 文件 | 覆盖 |
|------|------|
| `tests/mcp-config.test.js` | 兼容 stdio、url、enabled、非法丢弃 |
| `tests/mcp-client` / stdio 回归 | 帧与 initialize |
| `tests/mcp-http.test.js` | mock POST JSON-RPC |
| `tests/mcp-sse.test.js` | mock SSE 事件 |
| `tests/mcp-hub.test.js` | 多 transport、resources、失败隔离 |
| `tests/skills-loader.test.js` | triggers/command/args/cwd 解析 |
| skills provider 测 | run_skill mock、匹配片段、plan 隐藏 run_skill |
| permission / agent-mode | run_skill=write；资源工具 plan 隐藏 |

无外网；HTTP/SSE 用本地 mock 或注入 `requestFn`。

---

## 8. 文档

- 本规格：`docs/superpowers/specs/2026-07-23-phase-c5-mcp-skills-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-23-phase-c5-mcp-skills.md`（writing-plans）
- README：传输类型、resources 工具、run_skill、triggers、列表 UI、远程 URL 风险声明

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 三传输协议歧义 | mock 契约；stdio 金样；http/sse 最小子集写死 |
| 远程 SSRF | 仅 http(s)；文档风险；后续可拦私网 |
| run_skill 危险命令 | Gate + cwd + shell false |
| triggers 误触发 | 上限 5；仅 description |
| UI 状态不同步 | 列表为源 of truth；JSON 仅导入 |
| 包体膨胀 | 截断 tools/resources/skill 输出 |

---

## 10. 实现顺序建议

1. `mcp-config` + settings/main sanitize 兼容  
2. 客户端工厂 + stdio 拆分/回归  
3. HTTP transport + 测  
4. SSE transport + 测  
5. hub resources + 固定资源工具 + provider  
6. skills-loader + `run_skill` + 路由片段  
7. permission/mode + 测试  
8. `mcp:testServer` + renderer 列表 UI  
9. README + 全量 `npm test`

---

## 11. 附录：配置示例

```json
{
  "mcpEnabled": true,
  "mcpServers": [
    {
      "name": "local_fs",
      "transport": "stdio",
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    {
      "name": "remote_http",
      "transport": "http",
      "enabled": true,
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    },
    {
      "name": "legacy_sse",
      "transport": "sse",
      "enabled": false,
      "url": "https://example.com/sse"
    }
  ]
}
```

**可执行 skill 示例 `SKILL.md`：**

```markdown
---
name: dump-tree
description: 打印项目顶层目录
triggers: 目录树, tree
command: node
args: ["scripts/dump-tree.js"]
cwd: skill
timeoutMs: 15000
---

# dump-tree

运行本技能脚本，将 stdout 作为结果。
```
