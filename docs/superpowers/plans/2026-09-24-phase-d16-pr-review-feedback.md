# Phase D16 实施记录

日期：2026-09-24。对应 [设计规格](../specs/2026-09-24-phase-d16-pr-review-feedback-design.md)。

## 已完成实现

- [x] 核对公开 GraphQL schema，固定 review thread 列表/详情、Blob 定位、回复和解决 mutation。
- [x] 新增 `pr-review-state.js`、`pr-review-github.js`、`pr-review-store.js`、`pr-review-manager.js`，建立 opaque refs、完整性和权限检查、不可变快照及新鲜度验证。
- [x] GitHub CLI 通过 JSON stdin 传递 GraphQL 变量，处理 EPIPE、超时、取消和部分响应，继续复用现有登录。
- [x] 提取 `pr-delivery.js`，供 D14/D16 共享 exact-head worktree、单父提交校验和 exact-lease 交付。不确定推送只读核对，不重复推送。
- [x] 扩展 D13 来源为 `pr_review`，在完整任务提示超过 32 KiB 时拒绝，保留可选复验、取消和部分结果。
- [x] repair store 和 worktree marker 升级 v3，兼容 v1/v2，验证来源与交付字段组合。
- [x] 接入七个 sender-bound IPC/preload 方法，拒绝目标注入；解绑取消请求，修复信号保持到任务结束；Agent bridge 不开放审查来源。
- [x] 新增独立 PR 审查面板，筛选、完整讨论、回复、解决、说明及可选验证档案；局部重绘并保留临时草稿。
- [x] 保留 PR 标题/正文/普通评论/合并选择的未提交编辑；结果卡和工程中心可回到原线程，更新后可显式跟踪 CI。
- [x] 新增后端、存储迁移、IPC、渲染交互和真实临时 Git 交付测试。
- [x] 新增 `scripts/smoke-pr-review.cjs`，并兼容 D15 既有桌面冒烟。
- [x] 收尾复核：保守识别推送传输失败、Windows 大小写目录范围、工程中心异步导航，以及关闭的 CI 浮层隐藏样式。
- [x] 更新设计、实施记录及 README。

## 自动化验证记录

- 修改前基线：`npm test`，882 项通过，无失败（`.npm-cache/d16-baseline.log`）。
- D13/D14/D15 相关回归：52 项通过，无失败（`.npm-cache/d16-targeted-second.log`）。
- D16 初轮新增测试：48 项通过，无失败（`.npm-cache/d16-new-tests.log`）。覆盖当前锚点而非根评论 commit、新鲜度、重复分页、范围边界、完整性、只读核对、存储保护、解绑取消、草稿和迟到响应。
- 收尾定向回归：审查 manager / renderer 26 项通过，GitHub CLI 14 项通过（`.npm-cache/d16-final-targeted.log`、`.npm-cache/d16-push-recheck.log`）；补充了混合大小写子目录和非零退出码推送歧义的回归用例。
- 最终全量：`npm test`，932 项通过、0 失败、0 跳过，约 224 秒（`.npm-cache/d16-full-test-final.log`）。相对基线增加 50 项测试。
- 首轮全量曾在既有 `memoryAccept applies memoryMaxEntries to accepted candidates` 用例失败一次；该文件独立复跑 17 项通过，最终全量也通过。未修改记忆功能代码（`.npm-cache/d16-memory-recheck.log`）。
- D16 桌面冒烟：通过，1100×720 / 900×580，无横向溢出。真实执行一次隔离修复、D5 diff 审阅，以及一次模拟推送、一次模拟回复和一次模拟解决；三个远端动作分别获得单次批准。覆盖工程中心导航、逐线程草稿与 PR 编辑保留、更新后的 CI 跟踪、重新加载后返回原线程，以及讨论与草稿不进入聊天和业务存储的检查。renderer 错误 0、网络请求 0（`.npm-cache/d16-smoke-final.log`）。
- D15 桌面回归：通过，1100×720 / 900×580，renderer 错误 0、网络请求 0（`.npm-cache/d16-ci-watch-smoke-final.log`）。
- 最终静态检查：30 个新增或修改的 JS/CJS 文件通过 `node --check`；`git diff --check` 无空白错误。

已检查两种尺寸的审查面板、D5 diff、PR 更新确认弹窗和重新加载后的已解决线程截图。截图保存在两个桌面日志 `artifacts` 字段指向的独立临时目录。

## 可复现命令

```powershell
npm test
node scripts/smoke-pr-review.cjs
node scripts/smoke-ci-watch.cjs
git diff --check
```

桌面脚本为每次运行创建独立临时 profile 和仓库，输出 PNG 截图路径。D16 脚本使用 fake GitHub 和 fake model，真实执行 Electron、审批、D13 runtime、D5 diff/commit/tree 验证和 IPC；不会访问真实网络、发送系统通知或推送真实远端。

## 真实环境验收状态

公共 GraphQL schema 已读取并核对所需字段。尚未对真实 GitHub.com / Enterprise 账号执行回复、解决和受保护分支更新。现场验收应使用用户指定测试仓库，并按应用内单次批准逐项执行；这些远端动作不会由本地冒烟自动完成。
