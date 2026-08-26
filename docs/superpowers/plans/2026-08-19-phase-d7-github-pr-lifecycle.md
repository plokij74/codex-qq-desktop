# Phase D.7 - GitHub PR 生命周期实施记录

**设计规格:** `docs/superpowers/specs/2026-08-19-phase-d7-github-pr-lifecycle-design.md`
**实施状态:** 已完成代码与自动化测试，待桌面手工冒烟

## 交付清单

- [x] GitHub CLI：仓库身份、PR list/detail/checks、edit/comment/close/reopen/ready/merge
- [x] manager：状态前置、严格 checks、head SHA 固定、后置状态确认和 marker 同步
- [x] IPC/preload：sender-scoped PR 编号/resultId 引用与全局 mutation gate
- [x] renderer：真实 PR 工作台、手动刷新、生命周期动作和 D6 卡片入口
- [x] 隐私：详情仅内存，marker/session/export 不保存正文或评论
- [x] CLI、manager、IPC、renderer state 与静态界面测试

最终自动化验收：`638` 项测试通过，`116` 个 JavaScript 文件通过语法检查，`git diff --check` 通过。

## 实施边界

- 不新增 npm runtime 依赖。
- 不实现 OAuth/PAT、fork、跨仓库、轮询或自动远端动作。
- 不删除远端分支；merge 使用刷新时确认的 head SHA。
- 所有远端写操作仍要求 renderer 显式确认。

## 验收命令

```powershell
npm test
node --check src/ai/github-cli.js
node --check src/ai/worktree.js
node --check src/renderer/app.js
git diff --check
```

桌面冒烟：使用已登录 `gh` 的测试仓库加载 PR 列表和详情；编辑正文、评论、关闭/重开 Draft、转 Ready，并在 checks 全通过后 Squash 合并。确认主工作区不变且远端分支保留。
