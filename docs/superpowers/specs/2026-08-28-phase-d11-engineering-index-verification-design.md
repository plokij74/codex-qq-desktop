# Phase D.11 - 工程验证与代码索引设计规格

**日期:** 2026-08-28
**项目:** `codex-qq-desktop`
**状态:** 设计已确认，待实施
**前置:** Phase D.8 MCP OAuth/SSRF、Phase D.9 MCP 高级会话、Phase D.10 MCP Elicitation/Tasks 的自动化与真实桌面验收

## 1. 目标与范围

D11 面向“搜索、修改、验证、定位问题”的日常工程闭环，交付两个互相独立但共享 main 生命周期的能力：

1. 按 canonical 项目目录共享的增量代码索引，支持符号、引用、文本和路径导航。
2. 脱离聊天 run 的一次性后台验证作业，支持保存验证档案、受控启动、诊断解析、取消、重跑和结果恢复。

本阶段必须保持以下边界：

- 不引入新的 runtime dependency，不依赖 Tree-sitter、LSP 或项目外部服务。
- 不把轻量词法索引描述成完整语义分析；结果必须标记为 `lexical` 近似定位。
- 不允许 Agent 注入任意 shell 命令；Agent 只能启动用户保存的验证档案。
- 不在每次写盘后自动执行命令；D11 的验证作业由用户或 Agent 显式触发。
- 不创建临时 worktree 或快照；验证直接运行当前工作树并检测期间改动。
- 不改变现有 Agent 收工前 `verifyCommand` 软验证语义。
- 不改变 D8 OAuth、SSRF、D9 session/roots/sampling、D10 Tasks/Elicitation、D7 PR 和 D5 worktree 的所有权边界。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 索引后端 | 内置轻量混合索引；不增加运行时依赖 |
| 索引语言 | JS/JSX/MJS/CJS、TS/TSX、Python、Go、Rust、Java 的词法声明；其它常见文本文件只做词项/路径索引 |
| 索引作用域 | 按 canonical 项目目录共享；同项目多个会话复用一份 main-owned 索引，不跨项目聚合 |
| 索引刷新 | 启动/首次绑定增量构建；文件变更 500ms 防抖更新；`.gitignore` 变化完整重建；提供手动重建和清除 |
| 索引缓存 | safeStorage 加密保存相对路径、文件指纹、符号和位置；不保存源码正文；safeStorage 不可用时仅内存 |
| 验证运行 | 一次性后台作业，显式启动，手动重跑；暂不做常驻 watch/CI |
| 验证目标 | 当前实时工作树；记录开始/结束 fingerprint，期间变化则结果为 `stale` |
| 验证配置 | 保存的 profile + 自动探测候选；profile 外的命令不可执行 |
| Agent 入口 | 受控工具只能接受 `profileId`；命令、cwd、超时全部由 main 的 profile 提供 |
| 验证权限 | 复用 `terminalEnabled`、项目内 cwd、命令拦截、超时和 PermissionGate；首次/指纹变化审批，按项目+profile 指纹持久化授权 |
| UI 入口 | 扩展现有“已安排”为“工程中心”，包含 MCP Tasks、验证作业、索引状态/查询 |
| 诊断 | 保存有界 stdout/stderr，并解析常见编译器、测试框架和 linter 的路径/行/列诊断 |
| 重启 | 不自动重跑命令；未结束验证转 `interrupted`；索引缓存可恢复并校验指纹 |

## 3. 索引设计

### 3.1 输入范围与忽略规则

索引器接收 main 已验证的 canonical 项目路径，不接受 renderer 或模型直接传入路径。遍历复用现有 `walkFiles`/`.gitignore` 语义，并额外遵守：

- 跳过 `.git`、`node_modules`、构建输出、缓存、虚拟环境、符号链接和被 `.gitignore` 忽略的路径。
- 单文件正文上限 1.5 MiB；项目总扫描正文上限 256 MiB；单项目最多 25,000 个文件。
- 发现 NUL 或无法按 UTF-8 读取时只记录 skipped 计数，不保存内容。
- 路径一律保存为项目相对 POSIX 路径；绝对路径只在 main 内部使用。

### 3.2 语言与记录

JS/TS 家族提取以下声明和导入关系：函数、类、接口、类型别名、枚举、变量、导入、导出。Python、Go、Rust、Java 提取可稳定识别的函数、类、接口/trait、结构体、枚举、模块/包声明和导入。解析采用有限状态和正则/词法扫描，遇到不确定语法时跳过该声明，不猜测 AST。

通用文本索引覆盖 JSON、CSS、Markdown、YAML、HTML、SQL、Shell 及其它小型文本文件。词项按大小写折叠保存原始展示形式和位置；停用词不做全局删除，保证精确文本查询仍可用。

内部记录形状：

```js
{
  projectKey: string,          // canonical path hash，仅 main 内部
  path: string,                // project-relative POSIX path
  language: string,
  fingerprint: { size: number, mtimeMs: number, sha256?: string },
  symbols: [{
    name: string,
    kind: string,
    role: 'definition' | 'reference' | 'import' | 'export',
    line: number,
    column: number,
    endLine?: number,
    endColumn?: number,
    confidence: 'lexical'
  }],
  terms: [{ term: string, line: number, column: number }]
}
```

引用只表示词法命中或导入名匹配，不承诺绑定到唯一声明。查询结果包含 `confidence: "lexical"`，并在 UI 显示“近似定位”。

### 3.3 生命周期与资源上限

每个 canonical 项目最多一个构建任务和一个 watcher。状态为 `idle`、`building`、`ready`、`stale`、`error`。同项目并发 `ensure` 合并到同一个 Promise；项目解绑、应用退出或清除索引时停止 watcher。

首次构建和手动重建扫描所有候选文件。后续刷新比较 size/mtime，只有变化文件重新解析；mtime 不可信或缓存校验失败时计算 sha256。watcher 事件按 500ms 防抖合并，删除文件从索引移除，重命名按删除+新增处理。

资源上限：

| 限制 | 默认值 |
|------|--------|
| 文件数 | 25,000 |
| 单文件正文 | 1.5 MiB |
| 单项目扫描正文 | 256 MiB |
| 符号数 | 250,000 |
| 词项位置 | 500,000 |
| 加密索引缓存 | 16 MiB |
| 单次查询结果 | 100 |
| 查询字符串 | 256 字符 |
| 运行时 snippet | 每条 240 字符 |

达到上限时保留已完成记录，状态为 `stale`，并返回 `truncated: true` 与计数；不得无限扩容或阻塞 Agent run。

### 3.4 查询合同

```js
search({
  projectPath,                         // main 内部绑定值
  mode: 'definitions' | 'references' | 'text',
  query: string,
  pathGlob?: string,
  language?: string,
  maxResults?: number
}) => {
  ok: boolean,
  indexState: string,
  results: [{
    path: string,
    line: number,
    column: number,
    endLine?: number,
    endColumn?: number,
    name?: string,
    kind?: string,
    role?: string,
    confidence: 'lexical',
    snippet?: string
  }],
  truncated: boolean
}
```

`definitions` 优先返回声明角色，`references` 返回引用/导入角色，`text` 返回词项命中。结果排序固定为路径、行、列、名称，保证测试和 UI 稳定。索引未 ready 时查询可返回当前已建结果并带 `indexState`，不会同步阻塞等待全量构建。

## 4. 验证档案与作业

### 4.1 Profile

设置中新增 `verificationProfiles`，每个项目 profile 独立保存：

```js
{
  id: string,                       // main 生成，vfy_<hex>
  name: string,                     // 1..120 chars
  kind: 'test' | 'build' | 'typecheck' | 'lint' | 'custom',
  command: string,                  // 1..1000 chars
  cwd: string,                      // project-relative, default "."
  timeoutMs: number,                // 5s..15m
  enabled: boolean
}
```

最多 12 个 profile。`command` 禁止 NUL/换行和现有终端危险命令；`cwd` 必须是项目内相对目录，不能包含绝对路径或 `..` 越界。profile ID、名称和命令均由 main 规范化；renderer 不能直接写入执行中的 job。

自动探测只产生未保存候选，不执行命令：

- `package.json` scripts 中的 `test`、`build`、`typecheck`、`lint`；
- `pyproject.toml`/`pytest.ini` -> `python -m pytest`；
- `go.mod` -> `go test ./...`；
- `Cargo.toml` -> `cargo test`；
- Maven/Gradle/Makefile 中可识别的测试目标。

旧 `verifyCommand` 继续用于 Agent 软验证；D11 profile 不覆盖旧字段。

### 4.2 作业状态与记录

合法状态迁移：

```text
queued -> running | cancelled | error
running -> passed | failed | timed_out | cancelled | stale | interrupted | error
passed | failed | timed_out | cancelled | stale | interrupted | error -> terminal
```

作业记录：

```js
{
  jobRef: 'vfy_job_<hex>',
  projectKey: string,
  projectBindingFingerprint: string,
  profileId: string,
  profileFingerprint: string,
  status: string,
  createdAt: string,
  startedAt?: string,
  finishedAt?: string,
  workspaceFingerprintStart: string,
  workspaceFingerprintEnd?: string,
  exitCode?: number,
  timedOut?: boolean,
  stdout: string,                   // bounded and redacted
  stderr: string,                   // bounded and redacted
  diagnostics: Diagnostic[],
  outputTruncated: boolean,
  statusMessage?: string
}
```

每项目最多一个 running job，全局最多四个；历史最多 200 条，清理优先终态记录，不能删除运行中的作业。stdout/stderr 各最多 64 KiB，diagnostics 最多 200 条，单条消息最多 1000 字符。所有错误和输出经过现有敏感信息脱敏，不保存 API key、Bearer、环境变量、绝对项目路径或完整命令行以外的 shell payload。

`workspaceFingerprint` 是项目相对文件 manifest 的 hash，只包含路径、size、mtime/内容 hash 等元数据。作业开始后如果工作树发生变化，结束时状态强制为 `stale`，并保留退出码和诊断供用户参考。

### 4.3 运行、取消与恢复

作业使用现有 `runTerminal` 的 PowerShell、项目内 cwd、超时和 abort 机制。开始前执行：profile 校验、项目 binding 校验、terminal 开关校验、权限 gate 校验和并发限制。首次运行或 profile/project/command/cwd/timeout 指纹变化时发送 terminal 风险审批；用户选择 `allow_session` 后按 `projectKey + profileFingerprint` 持久化授权。授权撤销后立即失效。

作业不会因 Agent stop、切换页面或聊天结束而自动取消。用户在工程中心明确取消时终止子进程，状态为 `cancelled`；超时为 `timed_out`。应用退出前不等待作业完成，重启加载记录并把 `queued`/`running` 改为 `interrupted`，绝不自动重跑。

手动重跑创建新的 `jobRef`，复制 profile 和 project binding 指纹，但不复制旧日志或诊断。旧作业保持历史只读。

### 4.4 诊断解析

统一诊断结构：

```js
{
  path: string,                    // project-relative
  line: number,
  column: number,
  severity: 'error' | 'warning' | 'info',
  code: string | null,
  message: string,
  source: string
}
```

首版解析 TypeScript/JavaScript 编译器、ESLint、Jest/Vitest、pytest、Go、Rust、javac/Maven/Gradle 常见的 `path:line:column`、`path(line,column)` 和测试失败行格式。解析失败的输出只保留在有界日志中，不生成猜测诊断。诊断路径必须通过 `resolveSafe` 校验，越界路径丢弃并计数。

## 5. Agent、权限与 IPC

### 5.1 Agent 工具

新增只读工具：

- `code_index_status`：返回索引状态、文件/符号/词项计数、截断和错误摘要。
- `code_index_search`：接受 `mode/query/pathGlob/language/maxResults`，返回有界定位结果。
- `verification_profiles`：列出已保存且启用的 profile 的脱敏摘要。
- `verification_get`：按 opaque `jobRef` 查询状态摘要。
- `verification_result`：按 opaque `jobRef` 读取有界日志和诊断。

新增 `verification_start({ profileId })`，风险为 `terminal`，只能使用当前绑定项目中已保存 profile。计划模式、explore 子 Agent、implement 子 Agent 不注册该工具；`full-auto` 仍不能绕过首次/变更授权。

Agent 事件只发送 `jobRef`、状态、profile 名称、计数、退出码和脱敏摘要，不发送绝对路径、完整命令、环境变量或未经截断日志。验证结果不会自动追加聊天 history，Agent 必须显式读取结果。

### 5.2 Main/Preload IPC

新增建议 channel：

```text
engineering:index:ensure
engineering:index:status
engineering:index:rebuild
engineering:index:clear
engineering:index:search
engineering:index:location
engineering:verification:profiles
engineering:verification:run
engineering:verification:list
engineering:verification:get
engineering:verification:result
engineering:verification:cancel
engineering:verification:rerun
engineering:verification:revoke-grant
engineering:event
```

所有调用使用现有 sender-owned `projectBindingId`，main 从绑定表解析 canonical 路径。renderer 不得提交 `projectPath`、任意命令、任意 cwd、绝对文件路径或可伪造的 job/profile 所有者。`engineering:index:location` 只返回项目内 bounded 行窗口，不提供写入能力。

### 5.3 工程中心 UI

现有 `data-view="scheduled"` 扩展为工程中心，保留 MCP Tasks 入口并增加：

- 索引状态、计数、最近更新时间、重建/清除按钮和近似定位提示；
- 搜索模式 tabs：定义、引用、文本；结果显示相对路径、行列、语言和 snippet；
- profile 列表、自动探测候选、启用/禁用和编辑；
- 作业列表、状态、时间、退出码、stale/interrupted/截断警告、取消和重跑；
- 诊断列表的点击定位和复制脱敏摘要；
- 验证授权撤销入口和 terminal 未启用提示。

工程中心和聊天时间线共用 `engineering:event`。切换页面、停止 Agent、关闭当前会话不会停止后台 watcher/job。renderer 只保存脱敏的临时状态，不把索引、日志、命令、诊断正文或授权写入 localStorage、session export、memory、usage、hooks 或普通聊天消息。

## 6. 持久化与错误合同

建议文件位于 Electron `userData`：

```text
engineering-index.json
engineering-jobs.json
engineering-verification-grants.json
```

三者均使用版本化 Electron `safeStorage` envelope，临时文件写入后原子替换。解密失败保留原文件并返回 corruption 错误；safeStorage 不可用时只使用内存，不创建明文文件。索引缓存损坏只删除内存索引并标记重建，不影响项目文件。

固定错误码：

```text
ENGINEERING_PROJECT_BINDING_INVALID
INDEX_DISABLED
INDEX_BUILDING
INDEX_QUERY_INVALID
INDEX_LIMIT
INDEX_LOCATION_INVALID
INDEX_STORE_CORRUPT
INDEX_STORE_UNAVAILABLE
VERIFICATION_PROFILE_INVALID
VERIFICATION_PROFILE_NOT_FOUND
VERIFICATION_PROFILE_CHANGED
VERIFICATION_PROFILE_LIMIT
VERIFICATION_TERMINAL_DISABLED
VERIFICATION_APPROVAL_REQUIRED
VERIFICATION_APPROVAL_CANCELLED
VERIFICATION_JOB_NOT_FOUND
VERIFICATION_JOB_LIMIT
VERIFICATION_JOB_RUNNING
VERIFICATION_JOB_CANCEL_FAILED
VERIFICATION_STALE
VERIFICATION_TIMED_OUT
VERIFICATION_STORE_CORRUPT
VERIFICATION_STORE_UNAVAILABLE
```

错误消息必须限长并脱敏，不包含 token、环境变量、绝对路径、未截断远端响应或完整 shell payload。

## 7. 安全与隐私

- 项目路径只能来自 main 的 canonical sender binding；索引、作业和授权按项目 key 隔离。
- 轻量索引只持久化相对路径和元数据，不持久化源码正文；snippet 每次查询时读取并再次做边界检查。
- 验证命令只能来自已保存 profile；权限 gate、terminal 开关、项目 cwd 和现有危险命令拦截全部保留。
- Agent、renderer、日志、usage、memory、hooks 和 session export 不得接触 API key、环境变量、完整命令上下文或绝对路径。
- `stale` 结果只能显示为参考，不能自动宣称验证通过，也不能自动触发修复或提交。
- 索引的词法命中不被解释为可信指令；从源码读取的文本仍按不可信项目数据处理。

## 8. 测试与验收

自动化测试必须覆盖：

1. 五种主语言声明提取、通用文本索引、词法 definitions/references/text 查询和稳定排序。
2. `.gitignore`、符号链接、二进制、大文件、总量/结果上限和路径越界。
3. 增量 fingerprint、watcher 防抖、删除/重命名、`.gitignore` 变化、缓存加密/损坏/不可用。
4. profile 规范化、自动探测、profile 指纹、权限授权/撤销、终端开关和并发上限。
5. 作业状态机、取消、超时、前后 fingerprint stale、重启 interrupted、手动重跑和历史清理。
6. TypeScript、ESLint、Jest/Vitest、pytest、Go、Rust、javac/Maven/Gradle 诊断解析及未知格式日志保留。
7. Agent 工具过滤、只能使用 profileId、opaque jobRef、结果限制和事件脱敏。
8. IPC sender ownership、工程中心刷新、切页后台事件、点击定位和复制摘要。
9. D8 OAuth/SSRF、D9 session/roots/sampling、D10 Tasks/Elicitation、D7 PR、D5 worktree、权限和旧软验证回归。
10. 明文泄漏扫描：源码正文、命令、日志、诊断、授权和绝对路径不进入 renderer localStorage、export、memory、usage、hooks 或聊天 history。

真实 Electron 桌面验收至少完成：

- 绑定中型项目后索引完成、增量更新、定义/引用/文本搜索和点击定位；
- 保存 test/build/typecheck profile，首次审批后后台运行，切换聊天页仍更新；
- 通过、失败、诊断、取消、超时、stale、重跑和授权撤销流程；
- 应用重启后索引恢复，未结束作业显示 interrupted，不自动执行命令；
- D8/D9/D10 真实 MCP 流程和 D7 PR/worktree 工作台不回归。

Definition of Done：所有自动化测试、隐私回归、JavaScript 语法检查、`git diff --check`、D8-D10 硬前置和 D11 Electron 桌面流程全部通过后，才将 D11 标记为已交付。

## 9. 假设与后续阶段

- D11 不实现 Tree-sitter、LSP、语义类型解析、跨项目索引、远程 CI 或常驻文件分析服务。
- D11 不实现验证作业依赖图、定时触发、跨设备同步、云端执行或自动修复。
- profile 授权按项目+profile fingerprint 持久化；修改命令、cwd、超时或 profile 后必须重新审批。
- 真实桌面验收所需的外部 MCP server、Electron 环境和终端工具由实施/验收环境提供；缺少时只能记录 skip，不能宣称 D11 完成。
