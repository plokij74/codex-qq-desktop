# Codex QQ Desktop

QQ 2007 风格的 **Codex 聊天客户端**（Windows / Electron）。

## 功能

- 经典 QQ 2007 三栏皮肤
- **多会话**：任务 / 项目 / 好友，localStorage 持久化
- **工具栏 / 侧栏**：新建任务、已安排、插件、站点、拉取请求、聊天
- **搜索**过滤会话与项目
- **表情 / 图片 / 附件**（含粘贴图片）
- **斜杠命令**：`/help` `/clear` `/mode` `/new 标题`
- AI：**本地模拟** 或 **OpenAI 兼容 API**
- **Phase A Agent 核心**：权限三档、内联审批、grep/glob/search_replace、流式正文 + 工具轨迹
- **Phase B 工程闭环**：写盘 unified diff 审批、`git_status` / `git_diff` / `git_commit`、底部终端面板、输入框 `@文件` 引用

## 开发

```bash
cd codex-qq-desktop
npm install
npm run start:win
# 或
npm start
```

## 测试

```bash
npm test
```

## 打包

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist
```

## 设置

标题栏 ⚙：

| 字段 | 说明 |
|------|------|
| 模式 | 本地模拟 / OpenAI 兼容 API |
| Base URL | 填到 `/v1`，不要带 `/chat/completions` |
| API Key | 主进程保存 |
| Model | 如 `gpt-4o-mini` |

## 界面操作速查

| 操作 | 效果 |
|------|------|
| 新建任务 | 弹窗创建任务会话 |
| 点击项目文件夹 | 打开项目上下文会话 |
| 点击好友 / Codex 卡片 | 打开对应聊天 |
| 已安排 / 插件 / 站点 / PR | 功能页，可一键丢给 Codex |
| 清空 | 清空当前会话消息 |

## Agent 与终端

| 设置 | 默认 | 说明 |
|------|------|------|
| 启用多轮 Agent | 开 | API 模式 + 已绑定项目时，模型可反复调用工具 |
| 最大轮数 | 8 | `0` = **不限制**（仍受单次停止/中止约束） |
| 权限模式 | **confirm-writes** | 见下表「权限模式」 |
| 允许终端 | **关** | 开启后 Agent 可调用 `run_terminal` |
| 执行前确认 | 开 | 终端命令走内联审批（与写盘同一套卡片） |

在项目会话中可说：「读取 package.json，加一个 scripts.hello，然后运行 npm run hello」。

### 权限模式（三档）

| 模式 | 读工具 | 写 / 删 / 终端 |
|------|--------|----------------|
| `read-only` | 自动允许 | **拒绝**（不弹审批） |
| `confirm-writes`（**默认**） | 自动允许 | 聊天区内联审批卡片 |
| `full-auto` | 自动允许 | 自动允许（终端若开「执行前确认」仍会审批） |

**行为变化：** 旧版写文件默认直接落盘；Phase A 默认改为 `confirm-writes`，`write_file` / `search_replace` 等写入需点「允许」或「本会话始终允许此类」后才会改磁盘。需要旧体验可在设置里改成 `full-auto`。

审批决策：

- **允许**：仅本次
- **拒绝**：本次不执行，磁盘不变
- **本会话始终允许此类**：同 risk（如 write）本 run/会话内后续不再弹卡

停止：发送中或审批挂起时点停止 → 抛 `ABORTED`（消息含「已停止」），未允许的写入不会落盘。

### Agent 工具

| 工具 | 风险 | 说明 |
|------|------|------|
| `list_dir` | read | 列目录 |
| `read_file` | read | 读文件；支持 `offset` / `limit` 行切片 |
| `grep` | read | 项目内内容搜索（默认正则）；可选 path/glob；尊重 `.gitignore` |
| `glob` | read | 按 glob 找文件；尊重 `.gitignore` |
| `search_replace` | write | **局部编辑**（默认要求 `old_string` 唯一匹配；可 `replace_all`） |
| `write_file` | write | 新建或整文件重写 |
| `run_terminal` | terminal | 可选；默认关闭；危险模式会拦截 |

工作流建议：先 `list_dir` / `glob` / `grep` / `read_file` 定位，再优先 `search_replace` 局部改；整文件新建/重写才用 `write_file`。

### 内联审批与停止

- 需确认的操作在**聊天区气泡内**显示审批卡片（非系统 MessageBox）
- 工具开始/结束事件与助手正文同时间线展示
- 正文优先 **SSE 流式**（网关不支持 stream 时整段回退，仍会推送工具事件）
- 网关不支持 `tools` 时仍可走文本协议解析，不崩溃

### 项目指令：AGENTS.md / CLAUDE.md

绑定项目根目录下若存在：

- `AGENTS.md`（或 `agents.md`）
- `CLAUDE.md`

会注入到 Agent system 片段（各文件有长度上限），用于项目约定（语言、测试命令、风格等）。可在仓库根放一份短 `AGENTS.md` 约束 Agent 行为。

`.gitignore` 基础规则会影响 `list_dir` / `grep` / `glob` 的遍历（注释、简单通配、目录忽略）；非常规 gitignore 语法不保证完整兼容。

### 模式提示

- **API 模式 + 已绑定项目 + agentEnabled**：完整多轮工具循环
- **本地模拟 (local)**：不依赖外网；list 等快路径仍可用
- **无 stream / 无 tools 网关**：自动降级，保持可用

## Phase B：工程闭环

在 Phase A 权限与工具循环之上，补齐「看 diff → 改文件 → 跑命令 → 本地提交 → 带上下文提问」路径。

### Diff 审批与改动列表

- **`confirm-writes`（默认）**：`write_file` / `search_replace` 在落盘前计算 unified diff，审批卡片展示 diff（过长会截断，行统计仍准确）；点「允许」后才写入。
- **`full-auto`**：直接写入，本轮结束在聊天区展示 `fileChanges` 改动列表（只读，不再二次审批）。
- 粒度：**一次工具调用一张卡**（串行 loop，与 Phase A 一致）。
- `git_commit` 风险等同 **write**（可走「本会话始终允许此类」）。

### Git 工具（无 push）

| 工具 | 风险 | 说明 |
|------|------|------|
| `git_status` | read | 工作区状态摘要 |
| `git_diff` | read | 工作区 / staged / 指定 path 的 diff |
| `git_commit` | write | 仅暂存给定 `paths`（或不带 paths 时只提交已暂存）；**不会** `git add -A`，**不会** push |

无项目绑定或路径越界会失败；`read-only` 权限下 commit 被拒绝。

### 终端面板

- 聊天区底部 **终端** 面板：折叠状态记在 localStorage。
- **Agent** 的 `run_terminal` 与 **手动一条** 共用输出区；事件 `terminal-start` / `terminal-output` / `terminal-end`。
- **无 PTY**：一次性 `spawn`，stdout/stderr 分块推送。
- **聊天「停止」≠ 终端「停止命令」**：手动命令用面板上的停止；互不误杀。
- 设置里仍需开启「允许终端」；若「执行前确认」开启，命令会走审批（面板内卡片）。

### `@` 文件引用

在项目会话输入框中：

| 写法 | 效果 |
|------|------|
| `@src/ai/agent.js` | 注入该文件（有大小/行数上限） |
| `@src/ai/agent.js:10-40` | 仅注入行号范围 |
| `@src/ai/` 或 `@src` | 目录树摘要 + 少量文件头预览 |
| 多个 `@` | 按出现顺序展开，总预算约 200 KiB |

- 输入 `@` / `@src/` 会弹出路径补全（↑↓ + Enter/Tab；尊重 `.gitignore`）。
- **发送时** main 侧展开并附加 `context:refs` 代码块给模型；**会话历史只存用户原文**（含 `@`），重载不会再读盘撑爆上下文。
- 代码围栏与行内 `` `code` `` 内的 `@` 不解析。
- 无项目绑定：补全禁用；展开跳过并 warning。

## Phase C.1：编排（计划模式 + 验证模板）

在 Phase A/B 之上增加会话级 **计划 / 执行** 档位，以及收工前软验证。

### 计划 / 执行

| 能力 | 说明 |
|------|------|
| 会话模式 | 输入区旁 **计划 / 执行** 切换；默认 **执行**；新建会话可用设置里的 `defaultAgentMode` |
| 计划模式 | 只读工具 + 强制暴露 `submit_plan`；禁止写/删/终端/`git_commit`（工具不注册 + Gate 拒绝） |
| 执行模式 | 与 Phase A/B 一致；`permissionMode` 照常生效；不注册 `submit_plan` |
| 计划卡 | 模型调用 `submit_plan` 后出现卡片；**批准执行** → 切到执行并自动发含计划正文的用户消息开跑 |
| 驳回 | 不改模式、不自动发消息 |

生成进行中会禁用模式切换（需先停止）。

### 验证命令

| 设置 | 默认 | 说明 |
|------|------|------|
| `verifyCommand` | 空 | 空=自动探测项目 `package.json` 的 `scripts.test` → `npm test`；填 `none` 或 `-` 禁用 |
| `verifyBeforeDone` | 开 | 关闭则不插验证轮 |

触发条件（**软门闩**，不硬挡 commit / 收工）：

- 当前为 **执行** 模式
- 本 run 曾有成功写/删
- 已解析出验证命令，且终端已启用
- 模型收工前会提示立刻 `run_terminal` 跑该命令；失败最多再提示 1 轮修复后允许收工
- UI 显示：✅ 通过 / ❌ 失败 / ⚠ 未验证

### 本阶段明确不做

多计划版本树、未验证时硬挡 `git_commit`、Hooks。Skills / explore 子 Agent / MCP 见 **Phase C.2**。

## Phase C.2：平台化（Skills + explore + MCP）

### Skills

- 目录：项目 `.codex/skills/<id>/SKILL.md`、userData `skills/`、内置 `src/skills/`
- 工具：`list_skills` / `use_skill`；斜杠 `/skills`、`/skill <name>`
- 设置：`skillsEnabled`（默认开）

### explore 子 Agent（C.2 基线）

- 工具：`spawn_explore`（仅执行模式）；只读六件套；默认 4 轮，最多 8
- 设置：`subagentEnabled`（默认开）
- C.4 在此基础上增加并行 explore、`spawn_explores`、`spawn_implement` 与可展开轨迹（见下）

### MCP（C.2 基线：stdio）

- 设置：`mcpEnabled`（默认关）+ `mcpServers`
- 每次 Agent run 连接，结束断开；工具名 `mcp_<server>_<tool>`；权限 risk=`mcp`
- C.2 仅 stdio；**三传输 / resources / 列表 UI** 见 **Phase C.5**

### 后续

- C.5 三传输 MCP、resources、`run_skill` / triggers、列表 UI（已交付，见下）

## Phase C.3：Hooks（配置驱动生命周期）

在 Agent 主 run 上挂载外部命令钩子（不改工具源码）。

### 开关与配置

| 项 | 说明 |
|----|------|
| 设置 `hooksEnabled` | 默认开；关闭则完全不加载/不执行 |
| 用户配置 | `{userData}/hooks.json` |
| 项目配置 | `{project}/.codex/hooks.json` |
| 合并 | 同一事件下 **用户规则在前、项目在后**，串行执行 |

### 事件

| 事件 | 时机 |
|------|------|
| `SessionStart` | 主 run 开始（registry onRunStart 之后） |
| `UserPromptSubmit` | 首次模型请求前 |
| `PreToolUse` | Gate 通过后、工具执行前（可 allow/deny/改参/skip） |
| `PostToolUse` | 工具有结果后（含拒绝/短路） |
| `Stop` | run 结束（done/aborted/error），onRunEnd 之前 |

### Pre 与权限

顺序：**Gate₁ → Pre →（改参则 Gate₂）→ 执行或短路 → Post**。  
`skip` **不能**绕过 Gate₁。Pre 失败/超时/非 JSON/非 0 退出 ⇒ **拒绝工具**。  
`subagentDepth >= 1`（explore）不跑 Hooks。

### 示例 `.codex/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_terminal",
        "command": "node",
        "args": [".codex/scripts/check-terminal.js"],
        "timeoutMs": 5000
      }
    ],
    "PostToolUse": [],
    "Stop": [],
    "SessionStart": [],
    "UserPromptSubmit": []
  }
}
```

命令通过 stdin 接收 JSON，Pre 向 stdout 写 `{"decision":"allow"}` / `deny` / `skip`。

## Phase C.4：子 Agent 增强（implement + 并行 explore + transcript）

在 C.2 的 `spawn_explore` 之上，增加可写 implement、有限并行 explore（含批量工具），以及主轨迹内可展开 transcript。**不实现 git worktree 隔离**；无新 npm 依赖。

### 开关与设置

| 设置 | 默认 | 说明 |
|------|------|------|
| `subagentEnabled` | 开 | 总开关；关闭后 `spawn_explore` / `spawn_explores` / `spawn_implement` 均不可用 |
| `exploreMaxParallel` | **2** | 同主 run 内 explore 并发上限，clamp **1..3** |

仅 **执行模式** 暴露 spawn 工具；**计划模式** 隐藏三者。

### 主 Agent 工具

| 工具 | 风险 | 说明 |
|------|------|------|
| `spawn_explore` | read | 单个只读调研子 Agent；`goal`（≥4 字）；`maxTurns` 默认 4、上限 8 |
| `spawn_explores` | read | 批量并行 explore：`goals[]`（有效 1..6）共享 `maxTurns`；按序返回 `results` |
| `spawn_implement` | **write** | 委派改文件子 Agent；`goal`（≥4 字）；`maxTurns` 默认 6、上限 12 |

### 并行与互斥

- **并行仅 explore**：多 explore / `spawn_explores` 受 `exploreMaxParallel` 信号量限制
- **implement 串行**：同主 run 内互斥，不可并行多个 implement
- 父 run 中止（停止）→ 运行中与排队中的子任务均取消

### 子 Agent 能力边界

| kind | 可用工具 | 不可用 |
|------|----------|--------|
| explore | `list_dir` / `read_file` / `grep` / `glob` / `git_status` / `git_diff` | 写/删/终端/commit/spawn/skills/mcp |
| implement | 上表只读 + **`write_file` / `search_replace`** | `run_terminal` / `delete_path` / `git_commit` / spawn / skills / mcp |

- **depth ≤ 1**：子 Agent **不可再 spawn**
- implement 与父 **共用** PermissionGate 与 session「始终允许」；写入仍走 `confirm-writes` 审批
- 子 run **不跑** Hooks（C.3：`subagentDepth >= 1`）
- **无 worktree** 隔离（本阶段不实现）
- implement 的 `fileChanges` **合并**进父轨迹；verify 软门闩 **不** 因子 implement 记成功（验证仍由主 Agent 负责）

### 轨迹 UI

- 主聊天轨迹中按 `subagentId` 归桶为 **可展开块**
- 展示：kind / goal / 状态 / 耗时 / 子工具摘要 / 最终 summary（implement 另含写入路径数）
- 并行多 explore 可同时出现多块

### 本阶段明确不做

git worktree 隔离、implement 并行、子内再 spawn、独立侧栏多 Agent 面板、子会话持久化/恢复。

## Phase C.5：MCP 增强 + Skills 可执行 / 路由 + 列表 UI

在 C.2 的 stdio MCP 与 Markdown Skills 之上：支持 **stdio / SSE / Streamable HTTP**、**只读 resources**、Skills **`run_skill` + triggers 提示路由**，以及设置页 **MCP 服务器列表（含测试连接）**。无新 npm 依赖；不实现 OAuth / MCP prompts / sampling。

### 开关与配置

| 设置 | 默认 | 说明 |
|------|------|------|
| `mcpEnabled` | **关** | 总开关；关则不连接、不注册 MCP 工具 |
| `mcpServers` | `[]` | 服务器列表；经 `sanitizeMcpServers` 规范化（非法项丢弃） |
| `skillsEnabled` | 开 | 关闭则无 list/use/run_skill 与匹配片段 |

主 Agent run 开始时串行连接已启用 server，run 结束断开（与 C.2 一致）。**计划模式**与 **子 Agent（depth≥1）** 不暴露 MCP 工具与 `run_skill`。

### 三传输与 `mcpServers` 字段

| 字段 | 说明 |
|------|------|
| `name` | 必填，`^[a-zA-Z0-9_-]+$`；重名保留先出现 |
| `transport` | `stdio` \| `sse` \| `http`；缺省：有 `command`→stdio，否则有 `url`→http |
| `enabled` | 默认 `true`；`false` 时跳过连接 |
| `command` / `args` / `env` / `cwd` | **stdio** 用；`command` 必填 |
| `url` | **sse / http** 必填；仅 `http:` / `https:` |
| `headers` | 可选；静态请求头（键/值有长度上限）；**不会**自动注入 API Key |
| `timeoutMs` | 默认 60000；钳制 1000..300000 |

示例：

```json
[
  {
    "name": "local_fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  {
    "name": "remote_http",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer YOUR_TOKEN" }
  },
  {
    "name": "remote_sse",
    "transport": "sse",
    "url": "https://example.com/sse",
    "enabled": false
  }
]
```

旧配置仅含 `command`、无 `transport` 时仍按 **stdio** 兼容。

| 传输 | 要点 |
|------|------|
| **stdio** | Content-Length JSON-RPC；`spawn` + `shell: false` |
| **http** | Streamable HTTP **最小子集**：POST JSON-RPC；JSON 或 SSE 式响应；无会话恢复 |
| **sse** | 最小 MCP-over-SSE；与 tools/resources 语义对齐 |

单 server 失败不影响其他 server；聊天侧有 `mcp-status`（可带 `transport`）。

### MCP 工具

| 工具 | 风险 | 说明 |
|------|------|------|
| `mcp_<server>_<tool>` | mcp | 各 server 动态工具（固定名 `mcp_resources_*` 保留，避免冲突） |
| `mcp_resources_list` | mcp | 列出已连接 server 的 resources；可选参数 `server` |
| `mcp_resource_read` | mcp | 按 `server` + `uri` 读取；无能力时安全失败 |

- `confirm-writes`：与其它 mcp 一样走内联审批；`allow_session` 可记 risk=`mcp`
- `full-auto`：自动允许
- 输出默认截断（约 32 KiB，标记 `truncated`）
- **不支持** MCP prompts / sampling / OAuth 浏览器鉴权

### Skills：`run_skill` 与 triggers

目录与 `list_skills` / `use_skill` 同 C.2。frontmatter 扩展：

| 字段 | 说明 |
|------|------|
| `triggers` | 可选；逗号分隔关键词；最多 20 条、每条 ≤64 字；子串、不区分大小写 |
| `command` | 可选；有则 `runnable: true`，可用 `run_skill` |
| `args` | 可选；JSON 数组字符串 |
| `timeoutMs` | 默认 30000；钳制 1000..120000 |
| `cwd` | `project`（默认）\| `skill` \| 项目内相对路径；必须落在 **项目根** 或 **该 skill 目录** 内 |

| 工具 | 风险 | 说明 |
|------|------|------|
| `list_skills` | read | 含 `runnable`、`triggers` 摘要 |
| `use_skill` | read | 加载 Markdown 全文（同 C.2） |
| `run_skill` | **write** | 外部 `spawn(command, args, { shell: false })`；**不**依赖「允许终端」；**禁止**主进程 `require` 用户 skill JS |

自动路由：

1. 用当前用户消息（过长只取前约 8 KiB）匹配 `triggers`
2. 最多 **5** 个 skill 写入 system 的【Skills 自动匹配】（name + description 截断 + triggers）
3. 提示优先 `use_skill`；可执行再用 `run_skill`
4. **不**自动注入 body、**不**自动执行脚本

计划模式：保留 list/use 与匹配片段，**隐藏** `run_skill`。`run_skill` **不**计入 verify 软门闩成功。

示例 `SKILL.md` frontmatter：

```markdown
---
name: fmt-check
description: 运行项目格式检查
triggers: format, prettier, 格式化
command: npm
args: ["run", "format:check"]
timeoutMs: 60000
cwd: project
---
```

### 设置列表 UI + 测试连接

- 设置 → **MCP 服务器** 列表：增删改、启停、`transport` 与 stdio/url 字段
- **测试连接**：临时 start → listTools（+ 可选 listResources）→ close；返回 ok / toolsCount / resourcesCount / error / transport（超时约 ≤15s）
- **从 JSON 导入替换**：导入整表替换列表；日常保存以列表为源 of truth
- Skills：设置内短说明（可执行 + triggers），无完整 skill 编辑器

### 安全与风险声明

- 远程 **http(s) URL** 由用户自行配置；本阶段**不做**私网 / SSRF 企业级拦截，请勿指向不可信地址
- 静态 `headers` / `env` 可放 token；**不会**把应用 API Key 自动写入 MCP
- stdio / `run_skill` 均为 `shell: false`；`run_skill` 的 cwd 限制在项目根或 skill 目录
- 可执行 skill 与 MCP 工具可能改文件或访问外网：请配合权限模式与审批使用
- **明确不做**：OAuth、MCP prompts/sampling、skill 市场、require 用户模块进主进程
