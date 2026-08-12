# Phase D.5 - Worktree 隔离实施计划

**设计规格:** `docs/superpowers/specs/2026-08-10-phase-d5-worktree-isolation-design.md`
**实施日期:** 2026-08-11
**状态:** 已实施，待桌面手工冒烟

## 交付清单

- [x] `worktree-state`：v1 marker、状态转换、能力与脱敏摘要
- [x] `worktree`：Git preflight、local exclude、detached/locked 创建、收集、完整 binary patch、apply/discard/cleanup/recovery
- [x] `spawn_implement`：隔离项目路径、独立 allowlisted Gate、强制关闭 web、opaque result、父 `fileChanges` 隔离
- [x] `worktree-ipc`：sender-scoped binding、窄 list/get/apply/discard/retry/cleanup/open payload、全局 busy gate
- [x] preload 与 renderer：轻量 session ref、磁盘 list 对账、聊天待审卡、lazy diff、应用/丢弃/打开/重试
- [x] C.4 历史边界和 README D.5 使用、安全、隐私说明
- [x] Git 临时仓、runtime、IPC、renderer state 与全量回归测试

## 实施顺序

1. 先落 marker/schema 纯函数，固定 id、状态和公开摘要边界。
2. 用临时 Git 仓实现 create/collect/apply/discard/recovery；主树应用前后以 HEAD、status、index tree 和 alternate-index full tree 对账。
3. 将 manager 注入 `spawn_implement`；隔离结果不进入父 run `fileChanges`。
4. 在 main 建 sender-scoped project binding 和 mutation gate，再暴露窄 preload API。
5. renderer 只持久化 bounded result ref；patch preview 保持内存态并按需读取。
6. 更新 README，运行语法、diff 和全量测试。

## 验收证据

- `npm test`：616 pass、0 fail（包含 alternate-index patch replay、IPC busy recovery、renderer authoritative replacement 与 session export 回归）
- `node --check`：D.5 新增/修改 JS 通过
- `git diff --check`：通过
- Git 集成覆盖：dirty/ignored、子目录绑定、locked worktree、text/new/delete/rename/binary、独立 alternate-index patch replay、unstaged apply、base conflict、tamper、running/applying recovery

## 保持的非目标

主 Agent 写入、explore、终端、Hooks、Skills 和 MCP 不做 worktree 化；不做 dirty base 快照、自动测试、stage/commit/merge、逐文件应用、PR、implement 并行或新的 runtime 依赖。

## 手工冒烟

在桌面应用中分别用 `confirm-writes` 与 `full-auto` 触发一次 `spawn_implement`，确认主树在卡片应用前保持 clean；检查 diff 后整批应用，再用 `git status` 确认结果未 staged、HEAD 未改变。另保留一个 pending 结果重启应用，确认卡片恢复。
