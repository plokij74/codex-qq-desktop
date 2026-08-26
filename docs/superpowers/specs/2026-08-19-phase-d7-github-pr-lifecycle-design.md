# Phase D.7 - GitHub PR 生命周期管理设计规格

**日期:** 2026-08-19
**项目:** `codex-qq-desktop`
**状态:** 已实施，待桌面手工冒烟
**前置:** Phase D.6 GitHub Draft PR

## 1. 目标与范围

D7 把现有“拉取请求”演示页替换为当前绑定项目 `origin` 仓库的真实 PR 工作台，并在 D6 创建完成后继续管理 PR 生命周期。

本阶段交付：

- 打开/关闭/已合并/全部 PR 列表，固定最多 50 条。
- PR 详情、正文、分支、checks、文件摘要和评论。
- 编辑标题/正文、评论、关闭、重开、Draft 转 Ready。
- Squash/Merge/Rebase 合并；默认 Squash，严格 checks 门槛并固定 head SHA。
- D6 marker 状态同步、sender-scoped IPC、显式远端操作确认和脱敏错误。

非目标：OAuth/PAT、fork/remote 选择、跨仓库聚合、后台轮询、自动合并、评论编辑/删除、远端分支自动删除。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 授权 | 只复用 `gh` CLI 登录，不读取或保存 token |
| 仓库 | 只使用当前绑定项目的 `origin`；支持 GitHub.com / Enterprise |
| 刷新 | 进入页面或用户点击刷新；不轮询 |
| 写操作 | 每次显式确认；不受 `permissionMode` / `full-auto` 自动放行 |
| Ready | Draft 使用独立动作和确认 |
| 合并 | 默认 Squash，可选 merge/rebase；不删除远端分支 |
| checks | 至少一个，且无 pending/failure/cancelled/unknown |
| 并发 | 远端 mutation 复用全局 busy gate |
| 持久化 | 普通 PR 详情只在内存；D6 marker 只存脱敏摘要 |

## 3. 接口与数据流

主进程从 `projectBindingId` 取 canonical project path，再解析 `origin`、校验 `gh auth` 和仓库 identity。renderer 只能提供 `number`，或为 D6 卡片提供 `resultId`；不能提供 host、repo、URL 或磁盘路径。

新增 IPC：

- `worktree:pr:list` / `worktree:pr:get`
- `worktree:pr:edit` / `worktree:pr:comment`
- `worktree:pr:close` / `worktree:pr:reopen` / `worktree:pr:ready`
- `worktree:pr:merge`

列表和普通详情是只读。使用 D6 `resultId` 刷新会更新 marker，因此进入 mutation gate；“打开 PR”读取详情但不写 marker。编辑、评论、关闭、重开、Ready 和 merge 均在 gate 内串行执行。

D6 marker v1 兼容增加：`pr.state`、`headSha`、`mergeable`、`mergeStateStatus`、`updatedAt` 和 bounded `checksSummary`。不保存 body、comments、checks 明细或文件详情。

## 4. 合并与失败语义

合并前重新读取详情与 checks，并要求：

- state=`OPEN`、非 Draft、mergeable=`MERGEABLE`；
- checks total > 0；
- passed + skipped = total，且 pending/failed/unknown 全为 0；
- head SHA 是完整 40 位 Git SHA。

调用 `gh pr merge` 时传 method、`--match-head-commit <sha>` 和 `--delete-branch=false`。任何 mutation 后重新读取详情证明后置状态；无法读取或状态不符返回 `PR_ACTION_UNCERTAIN`，不自动重试。评论成功但刷新失败同样视为不确定，避免重复评论。

稳定错误包括 `PR_INVALID`、`PR_LOOKUP_FAILED`、`PR_CHECKS_FAILED`、`PR_NO_CHECKS`、`PR_MERGE_BLOCKED`、`PR_HEAD_CHANGED`、`PR_ACTION_UNCERTAIN` 和 `BUSY`。

## 5. 验收

- github.com / Enterprise 的 current-origin list/detail/action 均使用参数数组。
- renderer 不能注入 repo/host/URL/path；跨 sender/token/result 拒绝。
- title/body/comment shell 字符保持单参数，错误不披露 GitHub token。
- 无 checks、pending/failed checks、Draft、冲突或 head 变化均不能 merge。
- 成功 merge 不修改主工作区 HEAD/index/files，也不删除远端分支。
- D6 marker reload 恢复远端摘要，普通详情不进 localStorage/export。
- `npm test`、JS 语法检查和 `git diff --check` 通过。
