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
