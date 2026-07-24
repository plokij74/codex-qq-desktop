# Phase D.1 — 会话 Compact + 导出

**日期:** 2026-07-24  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase C.5 MCP/Skills（`d053c6b`）

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §6.3 项 19（会话 compact + 导出）、记忆相关差距
- 本轮 brainstorming 锁定决策（见 §2）

---

## 1. 目标与范围

### 1.1 一句话目标

为 QQ 多会话 Agent 增加 **结构化会话压缩（compact）** 与 **Markdown / JSON 导出**，默认手动、可选自动，降低长对话上下文膨胀，便于留存与分享；不引入向量记忆库或新 npm 依赖。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **compact 纯函数** | 划分「保留窗口 / 待摘要区」；启发式 token；序列化 transcript |
| 2 | **compact 摘要调用** | main IPC 用当前 API 设置生成中文摘要（local mock 可离线） |
| 3 | **会话替换** | renderer 将 older 段替换为 1 条摘要消息，保留最近窗口并持久化 |
| 4 | **手动入口** | `/compact`、工具栏或会话菜单「压缩会话」 |
| 5 | **可选自动** | `autoCompact` 默认 **false**；阈值可配；`chat:send` 前检查 |
| 6 | **导出** | `/export md` / `/export json` + 按钮；保存对话框写文件 |
| 7 | **设置 UI** | 自动开关、保留消息数、条数/约 token 阈值 |
| 8 | **测试与文档** | 纯函数单测；README Phase D.1 |

### 1.3 非目标（硬边界）

- 向量/嵌入记忆、跨会话自动召回、可编辑 MEMORY 库（可后续 D.x）
- 从导出 JSON **再导入** 恢复会话
- 压缩 **进行中** 的 agent run（须先停止）
- 新 npm 依赖（无 tiktoken）
- WebFetch、GitHub PR、worktree、MCP OAuth/prompts（其它阶段）

### 1.4 成功标准

1. 手动 `/compact` 后：更早消息变为一条「会话摘要」气泡，最近 `compactKeepMessages` 条原文保留；`localStorage` 已更新。  
2. `autoCompact: false` 时发送行为与 C.5 一致；为 true 且超阈值时，发送前可自动 compact，失败不阻断发送。  
3. 进行中 run 时 compact 被拒绝并 toast；export 仍允许。  
4. `/export md` 与 `/export json` 经保存对话框写入用户所选路径；内容无 apiKey。  
5. `/help` 含 compact/export；设置项可读写并 clamp。  
6. `npm test` 全绿；无新 npm 依赖。

### 1.5 路线图（记账）

| 阶段 | 内容 |
|------|------|
| C.1–C.5（已交付） | Plan、平台、Hooks、子 Agent、MCP/Skills |
| **D.1（本规格）** | 会话 compact + 导出 |
| 以后 D.x | 项目记忆、WebFetch、PR、worktree、MCP OAuth/SSRF… |

---

## 2. 产品决策摘要

| 主题 | 决定 |
|------|------|
| 阶段主题 | 会话与上下文（compact + 导出） |
| Compact 形态 | **结构化**：最近窗口原文 + 更早模型摘要 |
| 阈值 | **条数 + 启发 token（char/4）** 双条件 |
| 自动 | **默认关**；设置可开 |
| 导出 | **Markdown + JSON** 两种 |
| 入口 | `/compact`、`/export md|json` + 按钮 |
| 实现形态 | **方案 1：Renderer 会话层 + 主进程摘要/写盘 IPC** |
| 依赖 | 无新 npm 依赖 |

---

## 3. 架构

### 3.1 总览

```
Renderer sessions[] (localStorage)
  │
  ├─ /compact | 按钮 | (可选) send 前 auto
  │     → planCompact(messages, settings)
  │     → IPC session:compact({ transcript })
  │     → applyCompact → saveSessions
  │
  └─ /export md|json | 按钮
        → serializeSession(session, format)
        → IPC dialog:saveTextFile / session:export
        → 用户选路径写盘
```

- 会话权威数据仍在 **renderer**（与现网一致）。  
- 摘要与任意路径写文件放在 **main**（可用 settings / dialog）。  
- 不修改 `runAgentLoop` 工具表；compact 不是模型 tool。

### 3.2 模块（拟）

| 路径 | 职责 |
|------|------|
| `src/ai/session-compact.js` | `approxTokensFromMessages`、`planCompact`、`serializeOlderTranscript`、`applyCompact`、`buildCompactSystemPrompt` |
| `src/ai/session-export.js` | `exportSessionMarkdown`、`exportSessionJson` |
| `src/ai/settings.js` | compact 相关默认值与 clamp |
| `src/main.js` | `session:compact`、`dialog:saveTextFile`（或 `session:export`）；`toPublicSettings` 字段 |
| `src/preload.js` | 暴露 API |
| `src/renderer/app.js` 等 | 斜杠、按钮、设置、气泡样式、send 前自动 |
| `tests/session-compact.test.js` | 纯函数 |
| `tests/session-export.test.js` | 纯函数 |
| `tests/settings.test.js` | 默认与 clamp |
| `README.md` | Phase D.1 |

### 3.3 与现有子系统

| 子系统 | 关系 |
|--------|------|
| `messagesForModel` / chat:send | 使用压缩后的 messages；可剥 `compact` 元数据字段 |
| Agent 流式 / 工具 | 不直接改；compact 仅改历史 |
| local mock | compact 返回确定性占位摘要 |
| 项目沙箱写 | 导出 **不** 走 project write；用户任选路径 |

---

## 4. Compact 详细设计

### 4.1 设置

| 键 | 默认 | Clamp |
|----|------|-------|
| `autoCompact` | `false` | boolean |
| `compactKeepMessages` | `24` | 6..80 |
| `compactMaxMessages` | `40` | 20..200 |
| `compactMaxApproxTokens` | `24000` | 4000..200000 |

load/save 时 clamp；`toPublicSettings` 显式透传。

### 4.2 启发 token

```js
function approxTokensFromText(s) {
  return Math.ceil(String(s || '').length / 4);
}
function approxTokensFromMessages(messages) {
  // sum content strings; optional short tool summaries if present on message
}
```

无 tiktoken。

### 4.3 `planCompact(messages, opts)`

`opts`: `{ keepMessages, maxMessages, maxApproxTokens, force?: boolean }`

1. 规范化 `messages` 为数组。  
2. `force !== true` 时：若 `length <= keepMessages` → not needed；若 `length < maxMessages` **且** `approxTokens < maxApproxTokens` → not needed。  
3. `keep = slice(-keepMessages)`，`older = slice(0, -keepMessages)`。  
4. 若 `older.length === 0` → not needed。  
5. 若 `older` 每条均已 `compact === true` 且无可再压内容 → not needed（可选优化）。  
6. 返回 `{ needed, older, keep, approxTokens, olderApproxTokens }`。

### 4.4 Transcript 序列化

- 将 `older` 格式化为文本，总长上限约 **100_000** 字符（超出从头部截断并注明 truncated）。  
- 角色标签：`[user]` / `[assistant]` / `[tool:name]`。  
- 工具结果只保留短摘要（≤200 字符）。

### 4.5 IPC `session:compact`

**请求：** `{ transcript: string }`  
**响应：** `{ ok: true, summary: string } | { ok: false, error: string }`

Main 行为：

1. `loadSettings`；`mode === 'local'` → 返回基于 transcript 行数/长度的中文占位摘要（不调用外网）。  
2. API 模式：非流式 chat completion；system 要求中文简洁摘要，保留路径、决策、未决问题、用户约束。  
3. `max_tokens` 建议 1500；错误/超时 → `{ ok:false, error }`。  
4. **禁止** 把 apiKey 写入日志或响应。

可注入 `chatFn` 便于测试（实现细节）。

### 4.6 `applyCompact(messages, plan, summary)`

```js
{
  role: 'assistant',
  content: `【会话摘要 · 更早 ${plan.older.length} 条已压缩】\n${summary}`,
  compact: true,
  compactAt: Date.now(),
  compactedCount: plan.older.length,
}
// result = [summaryMsg, ...plan.keep]
```

### 4.7 触发

| 触发 | 条件 |
|------|------|
| 手动 `/compact` / 按钮 | 无活跃 `chatRun`；`force: true` 划分 |
| 自动 | `autoCompact` 且无活跃 run；`force: false`；在 user 消息入列后、IPC send 前 |

失败：toast，自动路径不阻断 send。

### 4.8 UI 摘要气泡

- class `msg-compact`（或等价）  
- 文案 zh-CN  

---

## 5. 导出详细设计

### 5.1 命令

| 输入 | 行为 |
|------|------|
| `/export md` / `/export markdown` | MD |
| `/export json` | JSON |
| `/export` | 提示用法 |
| 导出按钮 | 选择格式后同上 |

### 5.2 格式

**Markdown：** 标题元数据 + 按消息分节；tool 折叠为列表行。  
**JSON：** `{ version: 1, exportedAt, session: { …fields, messages } }`。

均不得包含 apiKey。超长字段可截断（MD 优先截 tool）。

### 5.3 IPC 写盘

`dialog:saveTextFile` 或 `session:export`：

- `showSaveDialog`（默认文件名如 `{title-safe}-{date}.md`）  
- 用户取消 → `{ ok: false, canceled: true }`  
- 成功 `fs.writeFile` UTF-8 → `{ ok: true, path }`

---

## 6. UI / 设置 / Help

- `/help` 增加：`/compact`、`/export md|json` 说明  
- 设置区：「自动压缩会话」+ 三个数字项（保留条数、条数阈值、约 token 阈值）  
- 聊天区按钮：「压缩会话」「导出」（具体布局跟随现有 QQ 工具条风格，不强制新侧栏）  

---

## 7. 测试计划

| 文件 | 覆盖 |
|------|------|
| `tests/session-compact.test.js` | token 启发、needed/not、force、apply 形状、transcript 截断 |
| `tests/session-export.test.js` | md/json 字段、无密钥 |
| `tests/settings.test.js` | 默认与 clamp |
| 可选 main 测 | mock chatFn 的 compact IPC |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 摘要丢关键细节 | 保留最近窗口；prompt 强调路径/决策/未决 |
| 费用与延迟 | 默认手动；截断 transcript；限 max_tokens |
| 自动惊吓 | 默认关 + toast |
| 与 run 竞态 | 活跃 run 拒绝 compact |
| 导出任意路径 | 仅用户对话框选择 |

---

## 9. 实现顺序建议

1. settings + 测试  
2. session-compact 纯函数 + 测试  
3. session-export 纯函数 + 测试  
4. main IPC + preload  
5. renderer 命令/按钮/设置/样式  
6. 自动 compact 挂点  
7. README + `npm test`

---

## 10. 附录：命令示例

```
/compact
/export md
/export json
```
