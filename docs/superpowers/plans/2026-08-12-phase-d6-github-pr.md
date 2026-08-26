# Phase D.6 - GitHub Draft PR 实施记录

**设计规格:** `docs/superpowers/specs/2026-08-12-phase-d6-github-pr-design.md`
**实施状态:** 已完成代码与自动化测试，待桌面手工冒烟

## 交付清单

- [x] GitHub CLI 适配：origin/host、`gh` auth、默认分支、严格 base、push、幂等 PR 创建
- [x] D5 marker 扩展：PR 状态、脱敏摘要、push 恢复事实和 pending 配额语义
- [x] worktree manager：重建 patch、单提交、tree 对账、失败重试和本地清理
- [x] IPC/preload：sender-scoped PR preflight/create/retry/cleanup/open
- [x] renderer：Draft PR title/body、状态、错误、重试、清理和链接
- [x] README、设计规格、CLI/worktree/IPC/renderer/export 测试

## 实施边界

- 不新增 npm runtime 依赖。
- 不保存 GitHub token，不实现 OAuth/PAT。
- 不 force push、不删除远端分支、不自动合并或修改主工作区。
- PR base 严格为远端默认分支，且其 HEAD 必须等于 D5 基线。

## 验收命令

最终自动化验收：`626` 项测试通过，`113` 个 JavaScript 文件通过语法检查，`git diff --check` 通过。

```powershell
npm test
node --check src/ai/github-cli.js
node --check src/ai/worktree.js
node --check src/renderer/app.js
git diff --check
```

桌面冒烟：使用已登录 `gh` 的测试仓库创建一个 D5 ready 结果，编辑 title/body 后创建 Draft PR；确认主工作区 clean、PR URL 可打开、本地 `codex/<resultId>` 分支和 checkout 已清理。另模拟一次 PR 创建失败后重试，确认不重复 push。
