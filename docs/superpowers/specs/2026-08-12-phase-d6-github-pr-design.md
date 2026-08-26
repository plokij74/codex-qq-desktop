# Phase D.6 - GitHub Draft PR 集成设计规格

**日期:** 2026-08-12
**项目:** `codex-qq-desktop`
**状态:** 已实施，待桌面手工冒烟
**前置:** Phase D.5 Worktree 隔离已交付（`f0b49b0`）

## 1. 目标与范围

D6 把 D5 的 `ready` 隔离结果扩展为第二条显式交付路径：用户可以选择“应用全部”到主工作区，或在隔离 worktree 中创建一次性提交并通过 GitHub CLI 推送、创建 Draft PR。两条路径互斥，主工作区在 PR 流程中始终保持不变。

本阶段交付：

- `gh` CLI、`origin`、GitHub host、登录和远端默认分支预检。
- `codex/<resultId>` 一次性分支和单提交，commit tree 必须等于 D5 `expectedTree`。
- push 后幂等查询并创建 Draft PR；失败、重启和本地清理均可恢复。
- sender-scoped 窄 IPC、聊天卡片 title/body 编辑、PR 链接和错误状态。
- GitHub CLI、worktree PR、IPC、renderer、导出非披露测试与 README。

非目标：

- GitHub OAuth、PAT 输入或应用自行保存 GitHub token。
- 自动 fork、新增 remote、选择 remote、force push 或删除远端分支。
- PR 更新、评论、合并、关闭/重开、状态轮询或自动转 Ready。
- 自动测试、自动应用主树、自动 stage/commit 主分支。
- 将非默认分支既有提交隐式带入 PR。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 授权 | 复用用户已登录的 `gh` CLI；应用不读取或保存 token |
| 远端 | 仅现有 `origin`；支持 `github.com` 与 GitHub Enterprise host |
| base | GitHub 默认分支；远端 HEAD 必须与 D5 `baseHead` 完全一致 |
| head | 唯一 `codex/<resultId>`；本地成功后删除，远端保留 |
| 提交 | 单提交；用户编辑的 PR title 同时作为 commit subject |
| PR | 默认 Draft；title/body 创建前可编辑 |
| 交互 | “应用全部”和“创建 Draft PR”独立且互斥，均要求用户点击 |
| 失败 | 保留 marker、patch、checkout/commit；按已推送事实幂等重试 |
| 成功 | 删除 checkout、patch 和本地分支，仅保留脱敏 PR marker |

## 3. 流程与状态

```text
D5 ready/conflict
  -> preflight: clean + origin + gh auth + default branch HEAD == baseHead
  -> pr_preparing
  -> pr_committing: 重建隔离 patch，创建 codex/<id>，单次 commit
  -> pr_pushing: push <commit>:refs/heads/codex/<id>
  -> pr_creating: 先按 head 查询已有 PR，再 gh pr create --draft
  -> pr_cleanup_pending: PR 已确认，只允许本地清理
  -> pr_created: 保留脱敏 marker，可打开 PR
```

任一创建阶段失败进入 `pr_failed`。marker 的 `pr.pushed` 是恢复事实：为 `true` 时，重试必须先按 head 查询已有 PR；已有唯一 PR 直接认领，无 PR 才重新创建，多个 PR 则关闭失败。应用在中间状态退出后，启动恢复把它标为 `PR_INTERRUPTED` 的 `pr_failed`，不自动重放网络副作用。

成功 marker 仅保留 host、owner/repo、base/head、commit SHA、PR URL/number、Draft 状态、title 和时间；不保存 token、PR body、完整 patch或 checkout authority。PR body 草稿只存在 renderer session 状态，并继续被会话导出整体剥离。

## 4. 安全与接口

`src/ai/github-cli.js` 只使用 `execFile(command, args)`；用户 title/body 始终是单独参数，不经 shell。命令有超时、输出上限和 GitHub token/Authorization 脱敏。

manager 新增：

```js
preflightPr({ projectPath, resultId })
createPr({ projectPath, resultId, title, body, draft })
retryPr({ projectPath, resultId, title, body, draft })
cleanupPr({ projectPath, resultId })
```

IPC 使用既有 `projectBindingId + resultId`，不接受 renderer 提供的 repo、checkout、patch、remote 或 URL：

- `worktree:pr:preflight`
- `worktree:pr:create`
- `worktree:pr:retry`
- `worktree:pr:cleanup`
- `worktree:pr:open`

mutation 复用 D5 全局 busy gate。打开 PR 前重新从磁盘摘要读取 URL，并要求 HTTPS host 与 owner/repo path 同 marker 一致。

## 5. 验收

- HTTPS/SSH、github.com/Enterprise remote 解析；缺 `gh`、未登录和远端前进关闭失败。
- title/body shell 字符保持单参数；错误中的 GitHub token 被脱敏。
- text/new/delete/rename/binary patch 的 commit tree 精确等于 D5 `expectedTree`。
- push 成功、PR 创建失败后重试不重复 push；超时后先查已有 PR。
- PR 成功后主树 HEAD/index/files 不变，本地 worktree/patch/分支已删除，远端分支保留。
- renderer 支持编辑、失败重试、清理和打开 PR；reload 对账不丢草稿。
- Markdown/JSON 导出不包含 PR 草稿、patch 或 authority path。
- `npm test`、JS 语法检查、`git diff --check` 和桌面尺寸冒烟通过。

## 6. 后续路线图

D6 不扩展 MCP OAuth。MCP OAuth、PR 管理/合并和 fork 工作流继续作为独立后续阶段。
