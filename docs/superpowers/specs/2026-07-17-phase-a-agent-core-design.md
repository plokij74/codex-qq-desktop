# Phase A Agent Core — Design Spec

**日期:** 2026-07-17  
**项目:** `codex-qq-desktop`  
**状态:** 待实现（设计已确认）  
**依据:** `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` Phase A + 薄增强  
**对标吸收:** Claude Code（权限、内联审批、可观测流式）+ OpenAI Codex（工程向工具面：grep/glob/局部编辑）

---

## 1. 目标与非目标

### 1.1 目标（Phase A 出口）

在 **API 模式 + 已绑定项目 + agentEnabled** 下，Agent 能：

1. 用 **grep / glob / 分段 read** 定位代码（大仓不靠盲 list+整文件读）
2. 用 **search_replace** 局部修改；新建或有意整文件重写仍用 `write_file`
3. **权限三档**；默认 `confirm-writes` 时，写 / 删 / 终端在聊天区 **内联审批卡片** 确认
4. **每轮 assistant content 流式** + **tool start/end** 实时轨迹（最接近 Claude Code 体感的 B 档流式）
5. **薄增强：** `.gitignore` 基础尊重、`AGENTS.md` / `CLAUDE.md` 注入、`read_file` 的 `offset`/`limit`

### 1.2 非目标（本阶段明确不做）

- Diff 面板 Accept/Reject、改前快照/撤销树
- `apply_patch` / multi-hunk unified diff
- MCP、子 Agent、Plan 模式、Skills、Hooks
- Git 工具集、真实 PR、WebFetch
- `tool_calls` 参数 token 级增量流式
- 强制依赖 ripgrep 二进制、OS 级沙箱
- 像素级 UI 重做、多窗口

### 1.3 已确认决策摘要

| 项 | 决策 |
|----|------|
| 范围 | Phase A 五项 + 薄增强 |
| 架构 | **方案 2：工具 + 权限 + 事件三层**（非最小堆补丁、非重写状态机） |
| 局部编辑 | **search_replace 为主**，保留 write_file |
| 权限 UX | **聊天区内联审批卡片**（非系统 MessageBox；终端确认也迁入同一套） |
| 流式 | **B：每轮 content 流式 + 工具事件点状推送**；tool 参数等完整再执行 |
| 默认权限 | `permissionMode: 'confirm-writes'`（比旧「写直接落盘」更严） |

---

## 2. 架构

### 2.1 分层

```
Renderer (气泡 / 内联审批 / 工具轨迹)
    ↕ IPC: chat:send · chat:event · chat:approve · chat:stop
Main: PermissionGate + AgentRunner
    → Tools (grep/glob/search_replace/read/write/delete/terminal)
    → Model (stream chat completions)
    → Project context (gitignore, AGENTS.md/CLAUDE.md, tree helpers)
```

### 2.2 模块与文件

| 路径 | 职责 |
|------|------|
| `src/ai/permission.js` | **新建** 权限模式、会话记忆、`authorize()` 挂起/恢复 |
| `src/ai/search.js` | **新建** `grep` / `glob`（纯 Node，无强制 rg） |
| `src/ai/project-instructions.js` | **新建** 加载 `AGENTS.md` / `CLAUDE.md` |
| `src/ai/agent-events.js` | **新建** 事件 type 常量（main/agent/renderer 共用字符串源） |
| `src/ai/project-fs.js` | **扩展** gitignore 跳过、read offset/limit、`searchReplace`、write fence 走审批前置由 agent 调 Gate |
| `src/ai/openai-compatible.js` | **扩展** `streamChatCompletionMessage`（或等价） |
| `src/ai/agent.js` | **改造** 事件化循环、新工具、PermissionGate、进度 emit |
| `src/ai/terminal.js` | 审批改为经 Gate（去掉主路径 MessageBox 依赖） |
| `src/ai/settings.js` | `permissionMode` 等默认值与合并 |
| `src/main.js` | runId、转发 events、`chat:approve`、host 快路径发事件 |
| `src/preload.js` | `onChatEvent`、`approveChat` |
| `src/renderer/app.js` + `styles.css` + `index.html` | 轨迹区、流式气泡、审批卡片、设置项 |

### 2.3 一次用户发送的数据流

```
用户发送
  → renderer: 用户气泡 + 助手轮次容器（轨迹 + 正文）
  → invoke chat:send { messages, project, sessionId }
  → main: runId + AbortController；开始循环
       stream model turn
         → chat:event text-delta
         → 若完整 tool_calls:
              每个 tool 串行:
                → tool-start
                → PermissionGate.authorize(...)
                     需确认 → approval-needed；await chat:approve
                → execute
                → tool-end
       无 tool → 继续 text-delta → done
  → stop → abort → 挂起审批 deny/aborted → aborted 事件
```

### 2.4 IPC 契约

| 通道 | 方向 | 说明 |
|------|------|------|
| `chat:send` | R→M invoke | 启动 run；仍 Promise resolve 最终结果（兼容）；过程以事件为主 |
| `chat:event` | M→R | 流式与进度 |
| `chat:approve` | R→M invoke | `{ approvalId, decision: 'allow' \| 'deny' \| 'allow_session' }` |
| `chat:stop` | R→M invoke | abort run + 取消挂起审批 |

**事件 `type` 枚举：**

`run-start` | `text-delta` | `tool-start` | `tool-end` | `approval-needed` | `approval-resolved` | `turn-end` | `done` | `error` | `aborted`

**`chat:send` payload：**

```js
{
  messages: Array<{ role, content }>,
  project: { name: string, path: string } | null,
  sessionId: string  // allow_session 记忆键
}
```

**最终 resolve 形状（保持可扩展）：**

```js
{
  content: string,
  applied: Array,
  agentLog: Array,
  turns: number,
  mode: 'agent' | 'api' | 'local' | ...,
  runId: string,
  aborted?: boolean
}
```

Abort：**统一 `throw`，`Error` 带 `code: 'ABORTED'`（message 可用 `已停止`）**。`chat:event` 同时发 `aborted`。renderer 的 invoke catch 识别后展示停止态。更新 `tests/abort*.test.js` 与此一致；不采用 `{ aborted: true }` 成功返回双路径。

### 2.5 兼容与降级

- **不支持 stream 的网关：** 捕获后回退非流式整段 message，仍发 tool 事件；可将整段 content 作为单次 `text-delta`。
- **不支持 tools 的网关：** 保持现有文本协议（` ```tool name` / `TOOL_CALL`），新工具名同样可解析。
- **local / 无项目 / agent 关：** 单次回复路径；至少发 `text-delta`（可一次全量）+ `done`，UI 只维护一条更新路径。
- **host list/structure 快路径：** 保留本机扫盘；发 `tool-start`/`tool-end`（如 `host:listTree`）+ content + `done`。

---

## 3. 工具设计

### 3.1 工具表

| 工具 | 灵感 | 要点 |
|------|------|------|
| `list_dir` | 现有 | 尊重 gitignore + SKIP_DIRS |
| `read_file` | Claude Code Read | `offset`（1-based 起始行）、`limit`（行数）；输出带行号；过大文件引导分段 |
| `search_replace` | Claude Code Edit | `path`, `old_string`, `new_string`, 可选 `replace_all` |
| `write_file` | 现有 | 新建/整文件；system 提示优先 search_replace |
| `delete_path` | 现有 | 项目内 only |
| `grep` | CC / Codex | 内容搜索；可选 path/glob；maxResults；ignore；大文件跳过 |
| `glob` | CC / Codex | 文件名模式；上限；ignore |
| `run_terminal` | 现有 | PowerShell；经 PermissionGate；黑名单保留 |

### 3.2 search_replace 硬规则

1. 路径 `resolveSafe`，禁止越界  
2. 文件必须已存在；否则错误提示改用 `write_file`  
3. `old_string` 为空 → 错误  
4. 默认：全文 **恰好一次** 匹配才替换；多次 → 错误并返回出现次数  
5. `replace_all: true` → 替换全部，summary 含次数  
6. UTF-8 写回；`applied` 记录 `{ path, ok, mode: 'search_replace', replacements }`  
7. Phase A **不做** 模糊匹配、自动缩进修复  

### 3.3 grep / glob

- 纯 Node 实现，不强制 rg  
- 跳过：既有 `SKIP_DIRS` + 项目根 `.gitignore` **基础**解析（`#` 注释、目录尾 `/`、简单 `*` / `**`；不宣称与 git 完全一致）  
- 单文件超过约 1.5MB：grep 跳过并计数  
- `maxResults` 默认 50，硬顶 200；`truncated: true`  
- 返回格式：`file:line:preview` 列表（grep）

### 3.4 项目指令

Agent 启动且存在 `project.path` 时：

1. 读取根目录 `AGENTS.md`（回退 `agents.md`）  
2. 读取根目录 `CLAUDE.md`  
3. 各自截断约 8KB，注入 system，标明来源  
4. **不再默认把完整深树塞进 system**（缩短与 grep 重复的上下文）；list/structure 用户意图仍走本机快路径  

### 3.5 write fence

保留 ` ```write:path` 解析；**落盘前必须经 PermissionGate**（risk: `write`），与 `write_file` 同等对待。

---

## 4. 权限模型

### 4.1 `permissionMode`

| 值 | 读 / list / grep / glob | write / search_replace / delete / write-fence | terminal |
|----|-------------------------|-----------------------------------------------|----------|
| `read-only` | 允许 | 拒绝（工具结果说明原因） | 拒绝 |
| `confirm-writes` | 允许 | 内联审批 | 内联审批 |
| `full-auto` | 允许 | 直接执行 | 直接执行（仍过命令黑名单） |

**默认：** `confirm-writes`。

### 4.2 与旧设置兼容

| 旧字段 | Phase A 行为 |
|--------|----------------|
| `terminalEnabled: false` | 不暴露或拒绝 `run_terminal`（不变） |
| `terminalRequireConfirm` | **`permissionMode` 优先**；仅当 `full-auto` 且 `terminalRequireConfirm === true` 时，终端仍要审批 |
| 无 `permissionMode` | 合并默认 `confirm-writes` |

### 4.3 内联审批

**`approval-needed` 载荷：**

```json
{
  "approvalId": "appr_xxx",
  "runId": "run_xxx",
  "tool": "search_replace",
  "risk": "write",
  "summary": "修改 src/ai/agent.js",
  "detail": "截断预览（约 1–2KB）或命令全文",
  "path": "src/ai/agent.js"
}
```

**按钮 → decision：**

- 允许 → `allow`  
- 拒绝 → `deny`（结果回模型，磁盘不改）  
- 本会话始终允许此类 → `allow_session`（按 risk：`write` | `delete` | `terminal`，键为 `sessionId`）  

**串行：** Agent 工具本就串行；同一时刻最多一个挂起审批。  
**停止 / 关窗：** 所有挂起 approval 以 deny/aborted 结束；**未 allow 前不得写盘**。  
**超时：** Phase A 不设自动超时。  
**非目标：** 审批卡片不做完整 diff 面板（Phase B）。

### 4.4 PermissionGate 接口

```js
// authorize({ tool, args, risk, summary, detail, sessionKey, signal })
//   → Promise<{ allowed: boolean, reason?: string }>
// rememberSession(sessionKey, risk)
// resetSession(sessionKey)  // 可选：会话切换时
// resolveApproval(approvalId, decision)  // main 在 chat:approve 时调用
```

Agent **只**通过 Gate 授权，不直接调 `dialog.showMessageBox`。

---

## 5. 流式与模型层

### 5.1 行为（档位 B）

- 每一 model turn：若有 `content`，以 delta 发 `text-delta`  
- `tool_calls`：**等完整组装**后再进入执行（不解析半截 arguments JSON）  
- 工具：`tool-start` →（审批）→ 执行 → `tool-end`  
- 最终无 tool 的 turn：流式正文后 `done`  

### 5.2 API

在 `openai-compatible.js` 增加基于 `stream: true` 的读取（fetch body 异步迭代或缓冲解析 SSE）。  
对外可提供：

- `streamChatCompletionMessage({ ..., onDelta, signal })` → `Promise<{ role, content, tool_calls? }>`  
- 或统一 `chatCompletionMessage` 增加 `stream` + `onDelta` 选项  

失败时回退非流式（见 2.5）。

---

## 6. UI / UX

### 6.1 设置

中文文案说明三档；其余 agent/terminal 字段保留。

### 6.2 助手轮次容器（同一 `runId`）

- **轨迹区：** tool-start/end、approval 卡片；默认展开，过高限高滚动  
- **正文区：** 流式中轻量转义 / textContent；`done` 后用完整 content 走 `renderMarkdownLite` 重渲染  
- **停止：** 现有按钮；abort 后卡片禁用  

### 6.3 Preload

```js
onChatEvent(cb) → unsubscribe
approveChat({ approvalId, decision })
// 现有 sendChat / stopChat / settings / project.* 保留
```

### 6.4 错误展示

`error` 事件更新气泡 + invoke reject 供 catch；renderer 避免 toast 与气泡双重刷屏。

---

## 7. 测试与验收

### 7.1 自动化（`npm test`）

| 区域 | 要点 |
|------|------|
| search_replace | 唯一命中、多次失败、replace_all、不存在、越界 |
| grep / glob | 命中格式、ignore、截断、特殊字符 |
| read offset/limit | 行切片、越界、兼容整读 |
| gitignore 解析 | 纯函数：注释、目录、简单通配 |
| permission | 三档矩阵、allow_session、deny、abort 取消等待 |
| stream client | mock body：delta 拼接、完整 tool_calls |
| agent loop | mock 多轮 tool + 事件顺序 |
| abort | 流式中 / 审批等待中停止；未 allow 无脏写 |

不强制 Electron UI E2E。

### 7.2 手工验收清单

1. 绑定本仓库，grep `runAgentLoop` 有轨迹与命中  
2. search_replace 改注释 → 内联审批 → 允许后仅局部变更  
3. 拒绝写入 → 磁盘不变  
4. allow_session 后再写 → 不再弹卡  
5. read-only 下修改被拒  
6. 正文流式出现  
7. 审批挂起时停止 → 无续写  
8. 根目录短 `AGENTS.md` 约束可观察  
9. 无 tools 网关文本协议不崩  
10. local 模式与 list 快路径可用  

### 7.3 风险

| 风险 | 缓解 |
|------|------|
| 网关无 stream | 回退非流式 + 仍发 tool 事件 |
| 网关无 tools | 文本协议 |
| 审批死锁 | stop/destroy 必 resolve Promise |
| gitignore 不完美 | 文档声明基础支持；SKIP_DIRS 兜底 |
| 默认 confirm 打断旧习惯 | README 写明；可改 full-auto |

---

## 8. 实现顺序

1. `settings` + `permissionMode` + `permission.js`  
2. `search_replace` / `grep` / `glob` / read offset + gitignore + project-instructions  
3. `agent` 注册新工具 + Gate  
4. stream API + `chat:event` 主进程转发  
5. renderer：轨迹 + 流式正文 + 审批卡片 + 设置  
6. 测试 + README + 手工验收  

---

## 9. 与差距文档的映射

| 差距文档 Phase A 项 | 本规格 |
|---------------------|--------|
| 1 局部编辑 | §3 search_replace |
| 2 grep + glob | §3 search.js |
| 3 权限分级 | §4 permissionMode + 内联审批 |
| 4 Agent 进度事件 | §2 chat:event |
| 5 流式输出 | §5 档位 B |
| 薄增强 offset/gitignore/指令 | §3.1 / §3.3 / §3.4 |

Phase B（Diff Accept/Reject、Git、@文件等）与 Phase C（Plan/MCP/子 Agent）不在本规格范围。

---

## 10. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-17 | 初版：brainstorming 确认后的完整设计 |
