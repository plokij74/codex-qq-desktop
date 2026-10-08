# Phase D19 实施计划与记录

日期：2026-10-08。状态：实现及本地验收完成；真实远端验收另列。对应 [设计规格](../specs/2026-10-08-phase-d19-pr-audit-recheck-design.md)。

## 已确认范围

从 D18 成功交付手动发起复审，检查本次修复的全部 1–5 项原问题；允许包含修复提交的最新 PR head。结论为只读 AI 判断，保留独立历史及固定提交依据。未解决项通过完整 D17 审查进入后续修复，不增加直接重修复或人工状态。

## 实施顺序

- [x] 0. 确认入口、范围、后续提交、后续操作及结论归属，检查 D17/D18 源码与基线测试，保存 spec 和 plan。
- [x] 1. 来源与状态：成功交付身份、历史原报告校验、结构化逐项结论、证据标识、独立加密存储及引用保护。
- [x] 2. 固定提交与运行：隔离 refs、祖先与 tree 验证、原/修复/目标快照、重命名/删除、只读 runtime、共享 D17/D19 配额、取消与恢复。
- [x] 3. IPC 与生命周期：五个 recheck 接口、preload/main 注册、sender/绑定校验、元数据事件、源保护恢复。
- [x] 4. 界面：结果卡与修复历史入口、PR/工程中心复审展示、进度/历史/证据、完整审查与原发现导航、草稿/焦点/滚动及迟到响应隔离。
- [x] 5. 验证：新增模型/状态/存储/IPC 测试、真实临时 Git、真实 Electron D19 冒烟、D17/D18 回归、全量分批测试及静态检查。
- [x] 6. 文档与交付：更新 README、spec 状态、本实施记录，记录真实验证结果和剩余外部验收边界。

## 当前进度

按用户要求，先保存设计与计划文件，再继续实现。现已完成：

- 新增复审 state/store/snapshot/runtime/manager，提供历史来源与交付校验、固定提交证据、目标新鲜度、只读模型执行及加密历史。
- 抽取审查任务配额，D17/D19 共用；D17 runtime 增加内部协议注入以复用模型调用和八轮限制。
- 接入 engineering IPC、main、preload、绑定恢复及来源引用保护；旧 D17/D18 存储和 marker 格式不变。
- 新增独立复审 UI，接入结果卡、修复详情、PR 与工程中心；复审正文与证据不进入聊天存储。
- 补齐 D19 专项测试与真实 Git/Electron 验证。额外修复 D17 同报告刷新短暂清空内容的问题，并加入草稿保持回归测试。
- 独立 D18 重载验收暴露启动时并发绑定导致旧令牌失效：合并同项目/路径的在途绑定请求，路径变化后丢弃旧响应；新增可执行并发回归。
- 新增真实容量淘汰测试；复审历史无法解密或持久化降级时，保守保护可能被旧文件引用的来源。
- 桌面测试对隐藏窗口截图等待增加有界退路，避免 requestAnimationFrame 不触发时无限挂起；重载后等待项目绑定完成再点击来源入口，没有放宽业务断言。

## 验证策略

先验证逐项结论与证据合同、历史 stale 原报告及来源保护，再验证运行、权限边界和真实 Git。桌面脚本使用独立临时 profile/repo、fake GitHub/model，实际经过 renderer/preload/IPC/main，不访问真实 GitHub。

覆盖：目标为修复提交或其后代、后续撤销修复、强推移除修复、LEFT/RIGHT、删除/重命名、零文本 diff、子目录、符号链接/子模块、脏主工作区、运行时来源变化、取消、重启和旧结果兼容。

运行 D19 针对性测试并回归 D17/D18，再执行完整 npm test。桌面验证尺寸 1100×720 和 900×580，覆盖入口、进度、结果、证据、历史、刷新、过期及导航。最后对修改的 JavaScript 执行 node --check，并执行 git diff --check。

## 验证记录

- 设计前：`node --test --test-reporter=spec tests/pr-audit-state.test.js tests/pr-audit-runtime.test.js tests/pr-audit-repair-store.test.js tests/pr-audit-repair-manager.test.js`，27 项通过，0 失败。
- 初步后台集成后：`node --test --test-reporter=spec tests/pr-audit-state.test.js tests/pr-audit-runtime.test.js tests/pr-audit-manager.test.js tests/pr-audit-repair-manager.test.js tests/pr-audit-repair-boundary.test.js`，29 项通过，0 失败。
- D19 manager/state/store/runtime/snapshot/UI 专项及 IPC/preload 边界已通过；真实 Git 验证包含固定提交、修复后代、撤销修复后的空 diff、强推移除祖先、tree 不匹配、LEFT/RIGHT、重命名/删除、子目录、符号链接/子模块、脏 index/工作区与遗留 refs 清理。
- 首轮 `npm test`：1012 项，1010 通过、2 失败。两项 `git.test.js` 的非仓库断言因临时目录位于工作仓库内而发现父 `.git`，未修改产品 Git 逻辑规避。尝试提权重跑时自动审批服务返回 503，命令未执行，也未绕过审批。
- 在原有沙箱权限内分批验证整个测试集合：其余测试使用仓库内临时目录，1006 项全部通过；`node --test tests/git.test.js` 使用默认系统临时目录，11 项全部通过。随后新增 UI 历史默认选择与并发绑定两项测试：分别包含在 22 项针对性回归与 34 项 renderer 回归中，均全部通过。当前 1019 项测试均已覆盖，不能把这描述为单次 `npm test` 全绿。
- `node scripts/smoke-pr-audit-recheck.cjs`：三轮成功（含绑定修正后的最终独立运行），真实走完 D18 生成/复验/交付后 D19 复审、代码依据、过期提示、重新加载、历史与完整审查导航。最终计数：审查 2、复审 1、修复生成 1、验证 1、推送 1；Review/回复/解决线程均 0，渲染错误与真实网络请求均 0。
- D15 `smoke-ci-watch.cjs`、D16 `smoke-pr-review.cjs`、D17 `smoke-pr-audit.cjs`、D18 `smoke-pr-audit-repair.cjs` 独立桌面回归全部通过。D18 最终日志为 `smoke-d18-binding.log`，含重载回溯和重新审查。
- 收尾时并行运行的一轮 D19 在 D18 验证等待阶段超时，尚未进入复审；另行单独重跑完整 D19 后通过，未放宽验证断言或扩大超时时间。最终日志：`smoke-d19-final.log`。
- 1100×720 和 900×580 截图已检查，复审面板及代码依据无横向溢出。最终 D19 截图目录：`.worktrees/d19-tests/codex-d18-smoke-qWnpD3`；前轮截图目录：`codex-d18-smoke-RbJRRK`。
- 最后针对性回归：`node --test tests/renderer-pr-audit.test.js tests/renderer-pr-audit-recheck.test.js tests/pr-audit-recheck-manager.test.js`，22 项通过。
- 绑定修正回归：`node --test tests/renderer-worktree-binding.test.js tests/renderer-engineering-ui.test.js tests/renderer-pr-audit.test.js tests/renderer-pr-audit-recheck.test.js`，34 项通过。
- 绑定修正后再次检查：29 个新增/修改 JavaScript 与 CJS 文件 `node --check` 通过；`git diff --check` 通过。

本地日志位于 `.worktrees/d19-tests/`：`full-suite-sandbox.log`、`final-targeted.log`、`smoke-d15.log` 至 `smoke-d19.log`。首次全量日志为 `npm-test.log`。根目录 7 个来源不明的 `Q*.tmp` 文件未删除或修改；未创建 Git 提交。

## 外部验收边界

真实 GitHub.com/Enterprise 的组织权限、网络及实际 PR 生命周期需要指定测试仓库独立验收。离线测试不得调用真实远端写入；D19 本身仅读取远端并调用配置的模型，不增加 PR 写入操作。
