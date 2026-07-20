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

MCP、子 Agent、Skills / Hooks、多计划版本树、未验证时硬挡 `git_commit`。
