# Phase B — 工程闭环设计规格

**日期:** 2026-07-19  
**项目:** `codex-qq-desktop`  
**状态:** 已批准（brainstorming）  
**前置:** Phase A Agent 核心（`cf52268`）— 权限三档、grep/glob/search_replace、流式、事件通道、gitignore、AGENTS.md/CLAUDE.md、read offset/limit  

**依据:**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md` §8 Phase B
- `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md`（明确延后项）
- 本轮 brainstorming 锁定决策（见 §1.2）

---

## 1. 目标与范围

### 1.1 一句话目标

用户在绑定的 git 项目会话中完成 **「修 bug → 看 diff → 跑命令 → 提交」**，尽量不切换外部终端/编辑器。

### 1.2 本 Phase 交付（全量剩余 B）

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **Diff Accept/Reject** | `confirm-writes` 先审后写；审批卡带 unified diff；按**单次工具调用**粒度；`full-auto` 直写 + 本轮改动只读列表 |
| 2 | **Git 本地闭环** | `git_status` / `git_diff` / `git_commit`（可 stage 指定文件）；无 push/PR/切分支 |
| 3 | **终端面板** | 只读输出聚合 + **手动跑一条**；无 PTY、无多标签持久 shell |
| 4 | **`@文件` 实用深引用** | 多文件、行号范围、目录摘要+截断、路径补全；发送时注入；有总预算 |

### 1.3 Phase A 已覆盖、本 Phase 不重做

- 项目指令 `AGENTS.md` / `CLAUDE.md`
- 基础 `.gitignore` 遍历
- `read_file` 的 `offset` / `limit`

### 1.4 非目标（硬边界）

- PTY / 多终端标签 / 持久交互 shell
- `git push` / PR / checkout / branch / merge / rebase / amend / worktree
- multi-hunk `apply_patch` 协议（编辑仍以 `search_replace` / `write_file` 为主）
- AST/符号 `@`、与 diff 双向打开完整编辑器
- 改前全局快照树、跨 run 撤销 / Reject 回滚已落盘内容
- MCP / Plan 模式 / 子 Agent / Skills（Phase C）
- 独立 `git` risk 档位、full-auto 强制 Accept、默认 `git add -A`

### 1.5 成功标准（出口）

1. `@` 或 Agent 搜索定位后，`confirm-writes` 下写操作展示 unified diff，**允许后才落盘**；拒绝则磁盘不变  
2. 终端面板可见 Agent 与手动命令的 stdout/stderr  
3. `git_status` / `git_diff` → `git_commit` 完成本地提交（confirm 下审批 message + files）  
4. `full-auto` 下写与 commit 不弹卡，但有本轮 `fileChanges` 可回看  
5. 停止 / 拒绝不会出现「声称成功却未授权」的写盘或 commit  
6. `npm test` 全绿；Linux 无 PowerShell 时终端真执行测试可 skip（与 Phase A 一致）

---

## 2. 产品决策摘要

| 主题 | 决策 |
|------|------|
| 实现形态 | **方案 3：微应用拆分** — Diff / Git / Terminal / `@` 边界清晰的子系统；**共享** PermissionGate + `chat:event` |
| Diff 落盘 | 模式感知：**confirm-writes = 先审后写**；**full-auto = 直写** + 事后只读改动列表；read-only 拒写 |
| Diff 粒度 | **按工具调用**一张审批卡（串行，与 Phase A 一致） |
| Git 深度 | status + diff + commit（可选 paths stage）；禁止 add -A 默认 |
| Commit 权限 | **与写文件同一套**：confirm-writes 批，full-auto 直 commit；risk = **`write`** |
| 终端 | 底栏可折叠面板 + 手动一条；聊天停止 ≠ 手动终端停止 |
| `@` | 发送时 expand；历史只存用户原文；context 仅当次请求注入 |

---

## 3. 总体架构

### 3.1 分层

```
Renderer (QQ UI)
  ├ Chat timeline（正文 / tool 轨迹 / 审批卡+diff）
  ├ At-Ref composer（@ 补全与引用提示）
  ├ Diff/Changes strip（本轮改动只读列表）
  └ Terminal panel（输出 + 手动一条）

Preload：按域窄 API（chat.* / terminal.* / atRef.* / 可选 git.*）

Main
  ├ Agent host（runAgentLoop + Gate + 事件转发）  ← Phase A，轻改
  ├ diff 子系统      纯函数：unified diff、截断、change 记录
  ├ git 子系统       git 执行与工具适配
  ├ terminal 面板    会话级缓冲 + 手动 run IPC
  └ at-ref 子系统    路径解析、读盘、目录摘要、限额

共享：PermissionGate、project-fs/resolveSafe、settings、agent-events
```

### 3.2 子系统职责

| 子系统 | 做什么 | 不做什么 |
|--------|--------|----------|
| **Diff** | 算 unified diff；审批卡预览；run 级 `fileChanges`；full-auto 事后列表 | 编辑器；多步未落盘 buffer |
| **Git** | status/diff/commit 工具 + 可选只读 UI | push/PR/branch/checkout/amend |
| **Terminal panel** | 聚合 `run_terminal` 与手动命令输出 | PTY、多标签持久 shell |
| **@-ref** | 补全、发送前展开为 context 块 | AST 符号、diff 双向编辑 |

### 3.3 与 Agent 的耦合

- Agent **只**调用工具与 Gate；不直接操作面板 DOM  
- 子系统通过：**工具**、**扩展 `chat:event`**、**独立 IPC**（手动终端、`@` 展开、可选 git 只读）  
- **唯一权限入口：** `PermissionGate.authorize`（拆模块不拆策略）

### 3.4 建议源码布局

```
src/ai/diff.js           # computeUnifiedDiff, truncateDiff, change helpers
src/ai/git.js            # execFile git + parse status/diff/commit
src/ai/at-ref.js         # parseAtRefs, completeAtPath, expandAtRefs
src/ai/terminal.js       # 扩展分块回调（兼容既有返回值）
src/ai/agent.js          # 注册 git_* 工具；写路径挂 diff/file-change；terminal 挂钩
src/ai/agent-events.js   # 新事件常量
src/main.js              # IPC：terminal:*、atRef:*、可选 git:*
src/preload.js           # 暴露窄 API
src/renderer/*           # 审批 diff UI、改动条、终端面板、@ 补全
tests/diff|git|at-ref|...test.js
```

不引入插件加载器（Phase C）。

---

## 4. Diff 与审批数据流

### 4.1 原则

1. **模式感知落盘**（见 §2）  
2. **粒度 = 单次工具调用** — `search_replace` / `write_file` / `delete_path` / write-fence 各自独立  
3. **Diff 纯函数** — `diff.js` 不碰权限；输入 before/after/path，输出 text + stats  

### 4.2 `confirm-writes` 写路径

```
executeTool(search_replace | write_file | delete_path)
  → 读磁盘 before（不存在则 ""）
  → 内存计算 after（search_replace 失败则 tool error，不进审批）
  → unified = computeUnifiedDiff(path, before, after)
  → gate.authorize({ tool, risk, summary, path,
        detail: truncatedDiff,
        diff: { path, stats, text, truncated } })
  → !allowed → 拒绝 JSON，磁盘不变
  → allowed → 真正写/删
  → emit file-change；累计 run.fileChanges
  → tool-end
```

| 操作 | before / after |
|------|----------------|
| 新建 `write_file` | before `""`，diff 为全文 add（可截断） |
| `search_replace` | 替换前后文本 |
| `delete_path` 文件 | after `""` |
| `delete_path` 目录 | 不强制整树 diff；detail 说明递归删除 + 路径 |

### 4.3 `full-auto` 与事后列表

- 不弹 Accept；写成功后同样 `file-change` + 累计  
- `done` 增加 `fileChanges: [{ path, op, stats, ... }]`  
- Renderer **本轮改动条只读**；本 Phase **不**提供 Reject 回滚  

### 4.4 审批卡 UI 扩展

在 Phase A 允许 / 拒绝 / 本会话始终允许 之上：

| 区域 | 内容 |
|------|------|
| 标题 | 工具 + 风险 + 路径 |
| Diff 区 | monospaced unified diff；max-height 滚动 |
| 截断提示 | `truncated` 时显示「已截断，+x/-y」 |
| 按钮 | 三按钮语义不变 |

**截断（写死）：**

- 单次 diff 文本约 **32 KiB** 或 **400 行**（先到为准）  
- 保留头尾，中间 `... diff truncated ...`  
- **`stats`（additions/deletions）基于完整 before/after**，不受展示截断影响  

### 4.5 事件扩展

| 事件 | 何时 | 载荷要点 |
|------|------|----------|
| `approval-needed` | 扩展 | 可选 `diff: { path, stats, text, truncated }` |
| `file-change` | 写/删成功 | `{ runId, path, op: 'write'\|'create'\|'delete', stats? }` |
| `done` | 结束 | `fileChanges: [...]` |

审批 IPC 仍为 `chat:approve`。

### 4.6 Gate 与 `allow_session`

- risk 仍为 `write` / `delete` / `terminal`  
- `allow_session` 后同 risk **不再弹卡**（含不再展示 diff）— 与 Phase A 一致  
- 本 Phase **不做**「始终允许但仍显示 diff」  

### 4.7 Diff 错误边界

| 情况 | 行为 |
|------|------|
| search_replace 无匹配 / 不唯一 | 工具失败，不弹审批 |
| 二进制 / 非 UTF-8 | 不提供全文 diff；卡上路径 + 操作说明 |
| 超大文件 | 沿用 project-fs 上限；超限工具失败或明确错误 |
| 停止 / ABORTED | 未 allow 不落盘 |

---

## 5. Git 工具与权限

### 5.1 工具表

| 工具 | 风险 | 作用 |
|------|------|------|
| `git_status` | read | 分支 + porcelain/结构化 entries |
| `git_diff` | read | 工作区或暂存 diff；可选 path |
| `git_commit` | **write** | stage 指定 paths（可选）并 commit |

### 5.2 `src/ai/git.js`

- 自 `project.path` 向上找 `.git`；**所有 path 参数仍须 `resolveSafe` 在项目沙箱内**  
- 非 git 仓：`{ ok:false, error: '不是 git 仓库' }`  
- **`execFile`/`spawn` 跑 `git`，禁止 shell 拼接**  
- 超时：status/diff ~30s，commit ~60s；支持 `signal`  
- 未安装 git：明确错误文案  

### 5.3 参数契约

**`git_status`**

```json
{ "short": true }
```

返回：`{ ok, branch, entries[], summary }`。

**`git_diff`**

```json
{ "path": "可选", "staged": false, "maxBytes": "可选" }
```

- `staged:false` → `git diff --`  
- `staged:true` → `git diff --cached --`  
- 输出截断与 Diff 同量级（~32KiB / 400 行）  

**`git_commit`**

```json
{
  "message": "必填非空",
  "paths": ["可选，相对项目根"],
  "stage": true
}
```

语义（写死）：

1. `message` trim 空 → 失败，不执行 git  
2. `paths` 非空：authorize 通过后 `git add -- <paths>`（`stage` 默认 true；`stage:false` 且 paths 非空 → 失败）  
3. `paths` 省略/空：**不** `git add -A`；仅 commit 已暂存；无暂存 → 失败  
4. **禁止**默认 `git add -A`  
5. 不传 `--no-verify`、`--amend`、强制旗标  
6. 成功：`{ ok, commit, branch, summary }`  

### 5.4 权限矩阵

| 模式 | status / diff | commit |
|------|---------------|--------|
| `read-only` | 允许 | **拒绝**（不弹卡） |
| `confirm-writes` | 允许 | **审批**（message + paths + 可选 cached diff 预览截断） |
| `full-auto` | 允许 | **直接执行** |

commit 的 risk = **`write`**（复用 session allow write；本 Phase 不拆独立 git risk）。

### 5.5 UI

- Agent：工具轨迹 + commit 走统一审批卡  
- 可选只读轻面板：`git:status` / `git:diff` IPC，**与 `git.js` 同源**  
- 不做完整 Git GUI  

### 5.6 Git 错误边界

| 情况 | 行为 |
|------|------|
| 无 git / 非仓库 | ok:false 明确错误 |
| path 越界 | 不执行 |
| hooks 失败 | stderr，ok:false |
| abort | 杀子进程，不重试 commit |

---

## 6. 终端面板

### 6.1 做 / 不做

**做：** 底栏可折叠面板；Agent `run_terminal` + 用户手动一条；每条 Run 含 command/cwd/code/stdout/stderr/source；权限与黑名单复用 Phase A。  

**不做：** PTY、多标签、持久 shell、自定义 shell UI。

### 6.2 事件（统一 `chat:event`）

| 事件 | 载荷要点 |
|------|----------|
| `terminal-start` | `{ runId, termId, command, cwd, source: 'agent'\|'user' }` |
| `terminal-output` | `{ termId, stream: 'stdout'\|'stderr', chunk }`（可节流合并） |
| `terminal-end` | `{ termId, code, ok, timedOut, aborted, summary }` |

Agent 路径仍发 `tool-start`/`tool-end`；面板额外订 `terminal-*`。

### 6.3 执行器

- 扩展 `runTerminal`：可选 `onStdout`/`onStderr` 分块；返回值兼容  
- 工具返回模型侧仍截断（~20k）；面板单 run 缓冲可更大（~200k，超出标 truncated）  
- **同一** `isBlockedCommand`、`assertInsideProject`、默认超时  

### 6.4 手动运行

```
terminal:run { sessionId, command, cwd? }
  → 校验项目绑定、terminalEnabled
  → gate.authorize(tool: run_terminal, risk: terminal, ...)
  → runTerminal + terminal-* 事件
```

| 设置 | 行为 |
|------|------|
| `terminalEnabled: false` | 隐藏输入并拒绝 IPC；Agent 不暴露工具 |
| `read-only` | 拒绝终端（含手动） |
| `terminalRequireConfirm` | 与 Phase A 相同（full-auto 下仍可要求终端确认） |

### 6.5 并发与停止（写死）

- 同时仅 **一个** 手动 run；Agent 工具本身串行  
- **聊天停止只停 Agent**；终端面板 **独立**「停止本命令」与 controller  
- 折叠状态 / 高度 → localStorage  

### 6.6 UI 要点

- 标题「终端」+ 折叠；运行中指示  
- 新 run 追加底部；自动滚底（用户上翻则暂停）  
- 等宽输出；stderr 区分样式  
- 输入一行 + 运行；Enter 提交  

### 6.7 安全

- 面板历史 **不**自动注入模型上下文  

---

## 7. `@文件` 引用

### 7.1 语法

| 形式 | 含义 |
|------|------|
| `@path/to/file.js` | 整文件（上限内） |
| `@path/to/file.js:10-40` | 1-based 行范围（含端点） |
| `@path/to/dir` 或 `@dir/` | 目录树摘要 + 可选少量文件头预览 |

多 `@` 按出现顺序展开。  
**不**解析 fenced code block 与行内 `` `code` `` 内的 `@`。

### 7.2 `src/ai/at-ref.js`

| 函数 | 作用 |
|------|------|
| `parseAtRefs(text)` | 提取 refs |
| `completeAtPath(projectRoot, prefix, limit)` | 补全（gitignore） |
| `expandAtRefs(projectRoot, text, caps)` | `{ displayText, contextBlock, refs, warnings }` |

### 7.3 限额（默认常量）

| 项 | 默认 |
|----|------|
| 单文件最大注入 | 64 KiB 或 2000 行（先到） |
| 行号范围最大行数 | 500 |
| 单条消息最多 ref | 20 |
| 单条消息总预算 | 200 KiB |
| 目录树 max 条目 | 200 |
| 目录文件头预览 | ≤5 个文本文件 × 2 KiB（计入总预算） |
| 补全条数 | 20 |

超限：截断 + `warnings`，**仍发送**（不整条失败）。

### 7.4 发送与持久化（写死）

1. 发送时 main 侧 `expandAtRefs`（`atRef:expand` 或并入 `chat:send`）  
2. **发给模型**的 user 内容 = 用户原文 + `\n\n` + context fence：

```text
```context:refs
### file: src/ai/agent.js:10-40
...
### dir: src/ai
(tree)
```
```

3. **会话存储只存用户可见原文**（含 `@`）；**不**把 expand 后全文当历史重存  
4. 重载历史 **不**自动再读盘注入（避免过期内容）  
5. 无项目绑定：禁用补全；expand 跳过或 warning  

### 7.5 补全 UX

- `@` / `@src/` 弹出候选；上下键 + Enter/Tab  
- IPC `atRef:complete`；防抖 ~100ms；大仓有限深度/条目  

### 7.6 与工具关系

- 不替代 `read_file` / `grep`  
- system 可注明：`context:refs` 为用户显式附加  

### 7.7 错误边界

| 情况 | 行为 |
|------|------|
| 不存在 / 越界 | 跳过该 ref + warning |
| 二进制 | 不注入正文 + 说明 |
| 行号越界 | clamp + warning |

---

## 8. 设置、IPC、错误总则

### 8.1 设置

- **不新增**权限相关开关（commit 跟 write；无 full-auto 强制 diff 开关）  
- 既有：`permissionMode`、`terminalEnabled`、`terminalRequireConfirm`  
- 终端面板 UI 状态 → localStorage  

### 8.2 IPC 增量

| API | 方向 | 用途 |
|-----|------|------|
| `chat:*` 既有 | | 扩展事件与 `done.fileChanges` |
| `terminal:run` | R→M | 手动一条 |
| `terminal:stop` | R→M | 停手动命令 |
| `terminal:clear` | R→M 或纯前端 | 清缓冲 |
| `atRef:complete` | R→M | 补全 |
| `atRef:expand` | R→M | 展开（或并入 send） |
| `git:status` / `git:diff` | R→M | 可选只读轻面板 |

### 8.3 错误总则

- 工具失败 → JSON error 给模型，不崩 loop  
- 拒绝审批 → 磁盘 / HEAD 不变  
- Abort → `ABORTED` + `/已停止/`；挂起审批 deny  
- 子系统不可用 → 中文错误降级  
- Renderer 用 `runId`/`termId` 归桶；未知事件忽略  
- **禁止**吞异常后假装成功  

---

## 9. 测试与验收

### 9.1 自动化

| 模块 | 要点 |
|------|------|
| `diff.js` | 增删改、空文件、截断后 stats 仍准 |
| Gate + write | confirm-writes 拒绝不落盘；allow 后内容正确；full-auto 无 approval、有 file-change |
| `git.js` | 临时仓 status/diff/commit；无 staged 失败；越界 path；read-only 不 commit |
| `at-ref.js` | parse 多 ref/行号/忽略 fence；expand 预算；complete gitignore；`../` 拒绝 |
| terminal 挂钩 | mock：deny 不 spawn；start/output/end 顺序 |
| 回归 | 全量 `npm test` |

### 9.2 手工验收清单

- [ ] confirm-writes：search_replace 卡上可见 diff → 允许落盘 / 拒绝不落盘  
- [ ] full-auto：写文件无卡，本轮改动列表可见  
- [ ] 终端面板：Agent 命令与手动一条均有输出；聊天停止不杀手动命令  
- [ ] git：status → diff → commit（confirm 审批后有新 commit）  
- [ ] `@file`、`@file:1-10`、`@dir` 注入后模型能引用内容；历史重载不重复撑爆  
- [ ] read-only：写/删/终端/commit 均不可擅自成功  

---

## 10. 实现顺序建议

供 `writing-plans` 拆 Task 时参考（非绑定工时）：

1. **Diff 核心** — `diff.js` + 写工具先算后批 + 审批卡 UI + `file-change` / `fileChanges`  
2. **Git** — `git.js` + 三工具 + 权限 + 测试  
3. **终端面板** — 事件挂钩 + renderer 面板 + `terminal:run/stop`  
4. **@-ref** — parse/expand/complete + 发送注入 + 补全 UI  
5. **文档与验收** — README 增量、手工清单勾选  

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 范围大（四子系统） | 严格非目标；微模块 + 串行 Task；共享 Gate |
| 大 diff 卡 UI | 硬截断 + 滚动容器 |
| git 环境差异 | execFile + 临时仓单测 |
| `@` 误解析 / 路径穿越 | 忽略 fence；resolveSafe |
| 权限双实现 | code review：所有写/终端/commit 必经 Gate |
| allow_session 后无 diff | 文档说明；用户可用单次允许 |

---

## 12. 文档与后续流程

| 产物 | 路径 |
|------|------|
| 本规格 | `docs/superpowers/specs/2026-07-19-phase-b-engineering-loop-design.md` |
| 实现计划 | brainstorming 用户审阅本 spec 通过后，由 **writing-plans** 生成 `docs/superpowers/plans/...` |

**相关文档：**

- `docs/2026-07-17-capability-gap-vs-codex-claude-code.md`
- `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md`
- `docs/superpowers/specs/2026-07-18-phase-a-execution-readiness-design.md`
- `README.md`（实现后更新 Phase B 用法）

---

## 13. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-19 | 初版：brainstorming 批准后落盘 |
