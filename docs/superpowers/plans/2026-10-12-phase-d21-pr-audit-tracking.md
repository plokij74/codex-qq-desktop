# Phase D21 实施记录

日期：2026-10-12。状态：实现、针对性回归及完整多轮桌面冒烟完成；全量回归首次失败的六项用例均已复验通过。对应 [设计规格](../specs/2026-10-12-phase-d21-pr-audit-tracking-design.md)。

- [x] 主进程只读历史聚合、项目/仓库范围过滤、轮次父链及缺失提示。
- [x] 当前性查询、旧结论保留、部分续修统计。
- [x] list/get IPC、preload、PR 面板、工程中心和既有操作导航。
- [x] 针对性测试及离线 Electron 冒烟入口。
- [x] 独立 Electron 追踪面板冒烟、脚本语法和 diff 检查。
- [x] 完整多轮桌面冒烟。
- [x] 完整回归执行及全部失败用例复验（首次全量未全部通过，详见下）。

## 验证记录

实施基线为 e0ac0e1。根目录已有 Q*.tmp 文件未修改。

- D21 聚合、IPC、Renderer 专项测试最终 15/15 通过，覆盖部分续修、分支/循环、缺失历史、离线/关闭 PR、身份过滤、同时间排序、只读历史、无网络本地列表、参数边界、转义、迟到响应及订阅释放。
- D17–D21 管理器、边界与 Renderer 针对性回归 70/70 通过，最终日志为 `.npm-cache/d21-targeted-final.log`。
- `node scripts/smoke-pr-audit-tracking-ui.cjs` 通过。真实 Electron + preload + 聚合模块，使用受控历史/交付替身；覆盖三轮历史、部分问题过期、只读导航回调、离线、刷新展开保留、页面重载、工程中心入口，以及 1100×720 / 900×580 布局。渲染错误 0，外部网络请求 0。此检查不替代真实 worktree 全流程。
- `node scripts/smoke-pr-audit-tracking.cjs` 在取消沙箱限制后完整通过：真实临时 Git + Electron，覆盖初始修复、两轮续修、三次手动复审、三轮追踪、只读导航、重载恢复以及 1100×720 / 900×580 布局。渲染错误 0、外部网络请求 0；追踪导航未增加模型、交付或其他操作次数。日志为 `.npm-cache/d21-smoke-unrestricted.log`。
- `npm test` 在正常系统临时目录、无沙箱环境中完成：1061 项，通过 1055 项、失败 6 项。失败包括 D20 Git 交付 3 项、D16 Git 初始化 1 项、D5 worktree 恢复 1 项，以及 usage-store 文件重命名 `EPERM` 1 项；D21 专项全部通过。日志为 `.npm-cache/d21-tests-unrestricted.log`。
- 对上述失败用例及其相关套件使用 `node --test --test-concurrency=1 --test-name-pattern=...` 复验，24/24 通过，覆盖全部六项原失败用例；未为此修改生产代码或放宽断言。日志为 `.npm-cache/d21-failed-rerun.log`。首次并行全量运行仍记录为失败，不宣称单次全量全部通过。
- 早期沙箱尝试受 PATH_UNSAFE、工作区临时目录的父仓库识别和界面加载超时影响；两次沙箱外执行申请遇到审批服务 503。后续已在用户取消沙箱限制后完成上述测试，不再等待审批。
- 修改脚本语法检查及 `git diff --check` 通过。已有 Q*.tmp 保留；本次测试新产生的六个 Q*.tmp 已清理。

真实 GitHub.com/Enterprise 与真实模型不在离线冒烟内；本阶段不增加远端写入操作。
