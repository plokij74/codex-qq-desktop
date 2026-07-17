# Codex QQ Desktop — 能力差距对照（vs OpenAI Codex & Claude Code）

**日期:** 2026-07-17  
**项目:** `codex-qq-desktop`  
**对照基准:**

| 产品 | 定位 | 形态 |
|------|------|------|
| **本项目 (Codex QQ)** | QQ 2007 皮肤的本地编程 Agent 客户端 | Electron 桌面 + OpenAI 兼容 API |
| **OpenAI Codex** | OpenAI 编程 Agent（CLI / IDE / 云端任务） | CLI + IDE 扩展 + 托管运行时 |
| **Claude Code** | Anthropic 官方 CLI 编程 Agent | CLI + Desktop/Web/IDE 扩展 + Agent 编排 |

> 说明：Codex / Claude Code 功能会随版本迭代；本文按 **2026 年中常见公开能力与工程实践** 对照本仓库 **当前已实现代码**（`src/ai/*`、`src/main.js`、`src/renderer/*`），不是营销文案逐条对齐。

---

## 1. 一句话结论

| 对比 | 结论 |
|------|------|
| **vs OpenAI Codex** | 已有「真实项目 + 工具循环 + 可选终端」骨架；缺 **精编辑 (patch)、代码搜索、流式过程、权限/沙箱、Git/PR 闭环**。 |
| **vs Claude Code** | 上述缺口同样存在，且额外差一截 **产品编排层**：子 Agent、Skills、Hooks、MCP、Plan 模式、权限分级、会话/记忆、验证闭环。 |
| **总体定位** | 本项目 ≈ **带 QQ 壳的轻量本地 Agent 客户端**；Codex / Claude Code ≈ **可托管仓库的工程级编程 Agent 平台**。 |

成熟度粗评（⭐ 仅作相对刻度，满分 5）：

| 维度 | 本项目 | OpenAI Codex | Claude Code |
|------|--------|--------------|-------------|
| 对话与多轮 Agent | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 代码读写 / 搜索 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 精编辑 / 可回滚 | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 终端 / 沙箱 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 权限与审批 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 过程可见 / 流式 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Git / PR 闭环 | ⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 扩展生态 (MCP/Skills) | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 上下文与项目规范 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 多 Agent 编排 | ❌ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| GUI / 会话管理 | ⭐⭐⭐⭐ (QQ 壳) | ⭐⭐⭐ | ⭐⭐⭐ |
| 模型中立 (任意兼容 API) | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ (偏 Claude) |

**本项目独有优势：** QQ 2007 高还原 GUI、多会话/项目绑定可视化、OpenAI 兼容任意后端、Windows 便携打包、本地模拟模式可离线演示。

---

## 2. 本项目当前能力基线（已实现）

依据提交历史与源码（截至 `9ba894f` 一带）：

### 2.1 产品 / UI

- Electron 单窗口，QQ 2007 三栏皮肤
- 多会话：任务 / 项目 / 好友；`localStorage` 持久化
- 项目列表：绑定真实目录、置顶、右键菜单、资源管理器打开
- 工具栏视图占位：已安排 / 插件 / 站点 / PR（多为演示数据）
- 表情、图片/附件（含粘贴）、斜杠命令（`/help` `/clear` `/mode` `/new` 等轻量级）
- 设置：local | api、Base URL、API Key、Model
- Agent 设置：`agentEnabled`、`maxAgentTurns`（0=无限）、终端开关与确认
- 停止生成：`AbortController` + UI 停止按钮

### 2.2 AI / Agent 核心

| 能力 | 实现位置 | 说明 |
|------|----------|------|
| 本地模拟回复 | `src/ai/local-mock.js` | 关键词模板 + 绑定项目时简单 list/read/write 意图 |
| OpenAI Chat Completions | `src/ai/openai-compatible.js` | 非流式；支持 `tools` / `tool_calls` |
| 多轮 Agent 循环 | `src/ai/agent.js` | function calling；不支持 tools 时文本协议回退 |
| 本机目录树快路径 | `src/ai/project-fs.js` + `main.js` | list/structure 意图直接扫盘，非模型臆造 |
| 写文件 fence | ` ```write:path ` | 最终答复中解析并落盘 |
| 路径沙箱 | `resolveSafe` | 禁止 `..` 越界到项目外 |

### 2.3 工具集（Agent tools）

| 工具 | 状态 | 备注 |
|------|------|------|
| `list_dir` | ✅ | maxDepth / 截断 |
| `read_file` | ✅ | 整文件；有大小上限 |
| `write_file` | ✅ | **整文件覆盖** |
| `delete_path` | ✅ | 文件/目录递归删 |
| `run_terminal` | ✅ 可选 | PowerShell；确认弹窗；粗黑名单 |

### 2.4 明确未做（设计非目标或尚未实现）

- 流式输出、token 级过程 UI  
- `apply_patch` / search-replace / diff 预览与 Accept-Reject  
- `grep` / `glob` / 符号导航  
- MCP、Web 搜索、子 Agent、Skills、Hooks  
- Git 原生集成、真实 PR  
- OS 级沙箱、网络策略、分级权限（suggest / auto-edit / full-auto）  
- `AGENTS.md`、长期记忆、会话 compact  
- Vision / Notebook / Plan 模式  

---

## 3. 三维对照总表

图例：✅ 有且成熟 · 🟡 有但弱/半成品 · ❌ 无 · 🎨 本项目特色

| 能力域 | 具体项 | 本项目 | OpenAI Codex | Claude Code |
|--------|--------|--------|--------------|-------------|
| **运行形态** | CLI | ❌ | ✅ | ✅ |
| | GUI 客户端 | 🎨 QQ 桌面 | IDE 扩展为主 | Desktop / Web / IDE |
| | 任意 OpenAI 兼容后端 | ✅ | 🟡 偏自家 | 🟡 偏 Claude |
| **会话** | 多会话管理 | ✅ GUI | ✅ | ✅ |
| | 会话导出/同步 | ❌ localStorage | 🟡 | 🟡 |
| | 斜杠命令 / 快捷指令 | 🟡 少量 | ✅ | ✅ 丰富 |
| **项目上下文** | 绑定工作区 | ✅ | ✅ | ✅ |
| | 忽略规则 (gitignore 等) | 🟡 写死 SKIP_DIRS | ✅ | ✅ |
| | 项目指令文件 | ❌ | ✅ (如 AGENTS 类) | ✅ `CLAUDE.md` / 规则 |
| | 用户长期记忆 | ❌ | 🟡 | ✅ memory |
| | `@文件` / 引用进上下文 | ❌ | ✅ | ✅ |
| | 长会话压缩 compact | ❌ | 🟡 | ✅ |
| **代码理解** | 列目录树 | ✅ 本机扫盘 | ✅ | ✅ |
| | 读文件 | ✅ 整文件 | ✅ 可分段 | ✅ 可分段 |
| | 内容搜索 grep | ❌ | ✅ | ✅ |
| | 文件名 glob | ❌ | ✅ | ✅ |
| | 语义/文档检索 | ❌ 插件占位 | 🟡 | 🟡 + MCP |
| **代码修改** | 整文件写 | ✅ | ✅ | ✅ |
| | 局部 patch / 精确替换 | ❌ | ✅ | ✅ |
| | 改动 diff 预览 | ❌ | ✅ | ✅ |
| | Accept / Reject 单文件 | ❌ | ✅ | ✅ |
| | 改前快照 / 撤销 | ❌ | ✅ | 🟡/✅ |
| **执行** | Shell | 🟡 PS + 确认 | ✅ + 沙箱策略 | ✅ + 权限模式 |
| | 交互式 PTY | ❌ | 🟡 | 🟡 |
| | 后台长任务 | ❌ | 🟡 | ✅ 类任务/通知 |
| | 危险命令策略 | 🟡 短黑名单 | ✅ | ✅ |
| **Agent 编排** | 多轮 tool loop | ✅ | ✅ | ✅ |
| | 最大轮数 / 停止 | ✅ | ✅ | ✅ |
| | 子 Agent / 并行 | ❌ | 🟡 | ✅ |
| | Plan 模式（先计划后执行） | ❌ | 🟡 | ✅ |
| | Skills / 可插拔工作流 | ❌ | 🟡 | ✅ |
| | Hooks（停/启/工具前后） | ❌ | 🟡 | ✅ |
| **扩展** | MCP | ❌ | 🟡 | ✅ |
| | WebFetch / 搜索 | ❌ | 🟡 | ✅ |
| | 自定义工具 | 🟡 改源码 | 🟡 | ✅ MCP/工具定义 |
| **Git / 协作** | status/diff/commit | ❌ | ✅ | ✅ |
| | PR 创建与审查 | ❌ UI 假数据 | ✅ | ✅ |
| | worktree 隔离 | ❌ | 🟡 | ✅ |
| **安全** | 路径限制在项目内 | ✅ | ✅ | ✅ |
| | 写操作需批准 | ❌ 默认直写 | ✅ 策略化 | ✅ 权限模式 |
| | 网络/文件系统沙箱 | ❌ | ✅ | 🟡/✅ 视环境 |
| | API Key 仅主进程 | ✅ | N/A/CLI | N/A/CLI |
| **可观测** | 流式 token | ❌ | ✅ | ✅ |
| | 工具调用实时轨迹 | 🟡 结束后 footer | ✅ | ✅ |
| | 费用 / token 统计 | ❌ | ✅ | ✅ |
| **验证闭环** | 测完再结 / verify skill | ❌ | 🟡 | ✅ 强调验证 |
| | 系统性 debug 流程 | ❌ | 🟡 | ✅ 技能化 |
| **打包分发** | Windows 便携包 | ✅ | ✅ 安装器/平台 | ✅ 多端 |

---

## 4. 与 OpenAI Codex 的差距（专题）

### 4.1 已对齐的「Codex 内核 30%」

1. 真实项目目录绑定  
2. 本机扫盘，避免瞎编目录  
3. 多轮 Agent：`list → read → write → (optional) shell`  
4. 可选终端 + 执行前确认  
5. 可停止生成  

### 4.2 主要缺口（按影响）

#### P0 — 敢用 / 能改大仓

| 缺口 | Codex 典型做法 | 本项目现状 | 影响 |
|------|----------------|------------|------|
| 局部编辑 | `apply_patch` / unified diff | 仅整文件 `write_file` + write fence | 大文件易毁、难 review |
| 代码搜索 | grep + glob | 无，靠 list+read | 大仓慢、费 token、易漏 |
| 写删审批 | 策略档位 | 写/删直接落盘 | 误操作风险高 |
| 过程流式 UI | 边想边播 + 工具实时 | 整段返回 + 结束 footer | 体感像「卡住」 |

#### P1 — 工程体验

| 缺口 | 说明 |
|------|------|
| 流式 API | `chat/completions` 未开 `stream` |
| Diff 面板 | 无 Accept/Reject per file |
| 分段读文件 | 无 offset/limit |
| 终端成熟度 | 固定 PowerShell、无 PTY、无输出面板 |
| Git 工具 | 无 status/diff/commit/PR 真集成 |
| 项目规范 | 无 AGENTS.md / 用户级 instruction |

#### P2 — 生态

| 缺口 | 说明 |
|------|------|
| Web / 文档检索 | 无 |
| MCP / 插件真逻辑 | 仅 UI 占位 |
| 云端任务 / 异步 job | 无（本地单进程） |
| 自动更新与账号 | 设计非目标 |

### 4.3 相对 Codex 的优势

- **GUI 优先**：非开发者也能点选项目、多会话聊天  
- **后端中立**：任意 OpenAI 兼容网关（含国产/自建）  
- **可离线演示**：local mock  
- **Windows 场景友好**：便携包 + 中文 UI  

---

## 5. 与 Claude Code 的差距（专题）

Claude Code 不只是「会调工具的 CLI」，而是 **Agent 平台 + 工程方法论**（Skills、权限、验证、多 Agent）。与之相比，本项目缺口比 Codex 对照时 **多一层编排与产品化**。

### 5.1 工具与编辑层（与 Codex 重叠的差距）

与 §4 相同，Claude Code 同样具备且通常更强调：

- Read（分段）/ Write / Edit（精确替换）  
- Bash（可配置权限）  
- Glob / Grep  
- 可选 Notebook、WebFetch、WebSearch  
- 工具结果截断与续读策略更细  

**本项目：** 5 个工具 + 整文件写 + 无搜索 ≈ Claude Code **基础工具面的子集**。

### 5.2 Claude Code 独有/明显更强的层（本项目基本没有）

| 层级 | Claude Code | 本项目 |
|------|-------------|--------|
| **权限模式** | 细粒度 allow/deny、会话级与项目级设置、减少重复确认 | 仅终端确认开关；写文件无批准 |
| **Hooks** | 工具前后、停止时等自动化（配置驱动） | ❌ |
| **Skills / 斜杠技能** | 可安装、可路由的领域工作流（TDD、review、debug…） | 仅极少 slash |
| **子 Agent** | Explore / Plan / 通用 / 只读检索等并行委派 | 单线程单 loop |
| **Plan 模式** | 先方案后改代码，降低误改 | ❌ |
| **MCP** | 一等公民扩展 | ❌ |
| **项目记忆** | `CLAUDE.md`、memory 文件、自动召回 | 仅当次 system 里塞目录树 |
| **验证文化** | 改完要跑、要观察，而非只交补丁 | 无强制 verify 闭环 |
| **Worktree / 隔离** | 并行改动隔离 | ❌ |
| **任务系统** | 任务列表、后台 task、通知 | ❌（「已安排」为假数据） |
| **IDE / 多端** | CLI + Desktop + Web + VS Code/JetBrains | 仅 Electron QQ 壳 |
| **模型能力绑定** | 深度吃 Claude 工具调用与长上下文 | 依赖任意兼容 API，质量随模型波动 |

### 5.3 交互范式差异

| | Claude Code | 本项目 |
|--|-------------|--------|
| 主入口 | 终端对话 / IDE 侧栏，开发者密度高 | IM 式气泡，降低操作门槛 |
| 过程 | 工具调用默认可见、可打断 | 结束后摘要 |
| 配置 | `settings.json`、权限、hooks、env | 简单设置弹窗 + userData JSON |
| 扩展方式 | Skill / MCP / hook，用户不改源码 | 改 `src/ai/agent.js` |

### 5.4 相对 Claude Code 的优势

- **非 CLI 用户更友好**的会话与项目可视化  
- **后端可切换**（不绑 Anthropic）  
- **皮肤化/娱乐化**产品形态（QQ 2007）差异化明确  
- 实现体量小，**定制成本低**（全仓库万行级可读）

---

## 6. 合并差距：一张「缺口清单」（去重后）

将 Codex + Claude Code 对照 **合并去重**，得到本项目要追的工程能力清单。

### 6.1 P0 — 核心 Agent 可信度（建议最先做）

| # | 能力 | 主要对标 | 验收标准（建议） |
|---|------|----------|------------------|
| 1 | **局部编辑** `apply_patch` 或 `search_replace` | 两者 | 改 500+ 行文件不整文件重写；失败可重试 |
| 2 | **`grep` + `glob` 工具** | 两者 | 大仓按内容/文件名定位 < 数秒 |
| 3 | **权限分级**（只读 / 写要确认 / 全自动） | 两者，尤 CC | 设置可切换；写/删/终端走策略 |
| 4 | **Agent 进度事件**（IPC 推送到 UI） | 两者 | 每步 tool 实时显示，不必等结束 |
| 5 | **流式输出** | 两者 | 首 token 延迟可感知变短 |

### 6.2 P1 — 工程闭环

| # | 能力 | 主要对标 |
|---|------|----------|
| 6 | Diff 预览 + Accept/Reject | 两者 |
| 7 | 读文件 `offset`/`limit` | 两者 |
| 8 | `AGENTS.md` / 项目指令注入 | 两者（CC: CLAUDE.md） |
| 9 | git status / diff / commit 工具 | 两者 |
| 10 | 终端输出面板 + shell 可选 | 两者 |
| 11 | ignore 规则（尊重 .gitignore） | 两者 |
| 12 | `@文件` 引用 / 附件进模型上下文 | 两者 |

### 6.3 P2 — 平台化（更靠近 Claude Code）

| # | 能力 | 主要对标 |
|---|------|----------|
| 13 | Plan 模式 | Claude Code |
| 14 | MCP 客户端 | Claude Code（Codex 部分场景也有） |
| 15 | Skills / 工作流插件 | Claude Code |
| 16 | 子 Agent（至少：只读探索 / 实施） | Claude Code |
| 17 | Hooks（工具前后脚本） | Claude Code |
| 18 | WebFetch / 搜索 | 两者 |
| 19 | 会话 compact + 导出 | 两者 |
| 20 | 验证任务（test → 修 → 再测）模板 | Claude Code |
| 21 | GitHub PR 真集成 | 两者 |
| 22 | Worktree / 并行任务隔离 | Claude Code |

### 6.4 可选 / 非目标（保持产品边界）

- 像素级换肤引擎、多独立聊天窗、账号云同步、语音视频  
- 完整复刻 Claude Code 企业权限与托管沙箱（成本高，可分阶段）  
- 绑死单一模型供应商（与当前「兼容 API」定位冲突）  

---

## 7. 架构层面的结构性差距

```
Claude Code / Codex 典型分层          本项目当前分层
─────────────────────────────        ─────────────────────────
┌ 交互：CLI / IDE / Desktop ┐        ┌ QQ Renderer (DOM)      ┐
├ 编排：Plan / 子Agent/Skill┤        ├ 单 chat:send IPC       ┤
├ 权限：模式 + hooks        ┤   vs   ├ runAgentLoop 单循环    ┤
├ 工具：grep/edit/bash/MCP  ┤        ├ 5 tools + write tree    ┤
├ 运行时：沙箱 / worktree   ┤        ├ PS 终端 + 路径 resolve ┤
└ 模型：流式长上下文        ┘        └ 非流式 chat.completions┘
```

**关键结构性差异：**

1. **编排层缺失** — 只有 `runAgentLoop`，没有任务分解、子代理、计划门闩。  
2. **工具语义偏 CRUD** — 像「远程文件浏览器 + shell」，不像「代码手术刀」（patch/grep）。  
3. **策略层缺失** — 安全靠路径限制 + 终端确认，没有统一 Permission Engine。  
4. **可观测性缺失** — 主进程跑完才回 UI，难做 UX 与调试。  
5. **扩展点缺失** — 加能力必须改主进程源码，不能 MCP/Skill 热插拔。  

---

## 8. 建议路线图（整合双对标）

### Phase A — 「能放心改代码」（对齐 Codex 可用线）

1. `search_replace` / `apply_patch`  
2. `grep` + `glob`  
3. 权限：`read-only | confirm-writes | full-auto`  
4. `agent:progress` 事件 + 简易工具轨迹 UI  
5. 流式 assistant 文本  

**出口标准：** 在绑定的中型仓库上，完成「搜索符号 → 局部改 3 处 → 跑测试命令 → 汇总」且可中途停止、写操作可确认。

### Phase B — 「能当日常 IDE Agent」（工程闭环）

6. Diff Accept/Reject  
7. 项目指令文件 + gitignore  
8. Git 基础工具  
9. 终端面板化  
10. `@文件` 与分段 read  

**出口标准：** 用户可完成「修 bug → 看 diff → 提交」不切换到外部终端/编辑器（或极少切换）。

### Phase C — 「平台化」（追 Claude Code 编排）

11. Plan 模式  
12. MCP  
13. 简单子 Agent（explore vs implement）  
14. Skills 目录（Markdown/JS 工作流）  
15. 验证模板（test-driven 修复循环）  

**出口标准：** 不改核心源码也能加「审查 PR / 跑迁移」类技能；复杂任务可先 plan 再执行。

---

## 9. 优先级决策建议（给本项目）

| 若目标是… | 优先追… | 不必先追… |
|-----------|---------|-----------|
| 对标 **Codex「改我的仓库」** | Phase A 全部 | MCP、子 Agent |
| 对标 **Claude Code「团队工程流」** | A + B + Plan/MCP | QQ 皮肤继续打磨可并行 |
| **差异化 QQ 客户端** | 过程 UI、权限、diff 可视化 | 完整复刻 CLI 生态 |
| **快速演示 / 教学** | 保持 mock + 现有 agent | 沙箱与企业权限 |

**不建议：** 同时铺开 MCP + 多 Agent + 像素皮肤重构。应先补 **编辑模型 + 搜索 + 权限 + 可见性**，否则 Agent 轮数再多也只是「更勤快地整文件覆盖」。

---

## 10. 附录

### 10.1 本项目关键代码索引

| 路径 | 职责 |
|------|------|
| `src/ai/agent.js` | 多轮工具循环、文本 tool 协议回退 |
| `src/ai/project-fs.js` | 扫盘、读写删、write fence |
| `src/ai/terminal.js` | PowerShell 执行与黑名单 |
| `src/ai/openai-compatible.js` | Chat Completions（非流式） |
| `src/ai/settings.js` | 设置默认值（agent/terminal） |
| `src/main.js` | IPC、Agent 路由、目录意图快路径 |
| `src/preload.js` | contextBridge API |
| `src/renderer/app.js` | QQ UI、会话、项目绑定 |

### 10.2 文档修订

| 日期 | 说明 |
|------|------|
| 2026-07-17 | 初版：整合 vs Codex 与 vs Claude Code 的差距与路线图 |

### 10.3 相关文档

- `docs/2026-07-17-codex-qq-desktop-design.md` — 产品设计规格  
- `docs/2026-07-17-codex-qq-desktop-plan.md` — 初版实现计划（部分已被 Agent 能力超越）  
- `README.md` — 使用与设置说明  
