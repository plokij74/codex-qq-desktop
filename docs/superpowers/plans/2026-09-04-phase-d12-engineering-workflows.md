# Phase D.12 - 工程工作流编排与本地门禁实施计划

**设计规格:** `docs/superpowers/specs/2026-09-04-phase-d12-engineering-workflows-design.md`  
**实施状态:** 自动化实现与回归已完成；真实 Electron 桌面验收待执行  
**目标:** 在不增加 runtime dependency、不开启自动执行的前提下，将 D11 verification profile 编排为受控 DAG，并为 D5/D6/D7 提供可选的本地通过门禁。

## 1. 实施前置与基线

- [ ] D5-D11 自动化回归保持 0 failed，并记录 D8-D10 外部桌面验收状态。
- [x] 确认 D11 `verification-manager` 的项目/全局并发、fingerprint、取消和 safeStorage 合同不变。
- [x] 冻结 workflow 定义、状态机、错误码、上限、runRef 和 gate-check 合同。
- [x] 运行 `npm test`、`node --check` 和 `git diff --check` 基线。

## 2. Task 1 - 设置与 workflow 规范化

涉及：`src/ai/settings.js`、`src/main.js`、`src/preload.js`、新增 `src/ai/workflow-config.js`、测试。

- [x] 增加按项目保存的 `engineeringWorkflows`，限制 workflow 数量、名称、节点、边、深度、并行数和超时。
- [x] 只接受 profileId 引用；保存和启动都验证 profile 存在、启用和 fingerprint。
- [x] 实现未知字段拒绝、稳定规范化、拓扑排序和环检测。
- [x] 固化 `continueOnFailure` 只影响自身失败依赖、`failFast` 控制全局取消的语义，并为示例 DAG 添加契约测试。
- [x] 保持旧设置兼容；`settings:get` 只返回 workflow 脱敏摘要，不返回命令、cwd 或授权。
- [x] 覆盖手工 JSON、重复节点、孤立节点、循环依赖、profile 删除/禁用、旧设置迁移和上限测试。

## 3. Task 2 - 加密 workflow store

新增：`src/ai/workflow-store.js`、`tests/workflow-store.test.js`。

- [x] 实现版本化 safeStorage envelope、临时文件原子替换、损坏保留和 memory-only 降级。
- [x] 保存 workflow 定义、run 元数据和 bounded 节点摘要，不保存命令、日志、源码或绝对路径。
- [x] 实现每项目 50、全局 200 的历史清理，终态优先且不影响 active run。
- [x] 测试不可用/损坏/截断/旧版本 envelope、仅当前进程提示和明文泄漏。

## 4. Task 3 - Workflow manager 调度器

新增：`src/ai/workflow-manager.js`、`tests/workflow-manager.test.js`。

- [x] 实现 queued/running/终态和 pending/ready/running/终态节点状态机。
- [x] 通过 D11 verification manager 启动 profile，传递授权、取消、超时、日志/诊断摘要和事件。
- [x] 实现稳定 DAG 调度、分支并行、fail-fast、continue-on-failure、每项目/全局并发上限。
- [x] 实现 workflow 级取消、总超时、子 job 终止等待、重复启动拒绝和完整 rerun。
- [x] 启动、节点边界和结束检查 workspace fingerprint；实现 stale 和 configuration_changed。
- [x] 实现应用退出 interrupted、重启恢复不自动执行和后台定时器释放。
- [x] 测试所有迁移、竞态、取消失败、重启和历史清理。
- [x] 明确 fail-fast 下 ready/running 节点的取消顺序，确保不提前伪装成终态。

## 5. Task 4 - Main/preload IPC 与本地门禁

涉及：`src/ai/engineering-ipc.js`、`src/main.js`、`src/preload.js`、`src/ai/worktree-ipc.js`、PR 相关 IPC。

- [x] 增加 workflow list/get/save/delete/run/runs/result/cancel/rerun handlers。
- [x] 所有请求使用 sender-owned `projectBindingId`；跨项目 workflow/runRef、绝对路径和伪造 profile 返回固定错误。
- [x] 广播 `engineering:workflow:event`，窗口销毁时移除 listener，不停止其它项目 run。
- [x] 实现内部 `checkWorkflowGate`，校验 run 状态、项目、workflow/profile fingerprint 和 expected workspace fingerprint。
- [x] 在 D5 应用、D6 Draft PR、D7 合并确认前接入可选 gate；检查和动作之间在 main 复检 fingerprint。
- [x] 保持门禁默认关闭，旧动作没有 workflow 时行为不变。
- [x] 测试 sender ownership、gate 失败无副作用和动作竞态。

## 6. Task 5 - Agent/provider 接入

涉及：`src/ai/agent.js`、`src/ai/agent-mode.js`、`src/ai/permission.js`、`src/ai/providers/builtin.js`、测试。

- [x] 增加 `engineering_workflows`、`workflow_start`、`workflow_get`、`workflow_result`、`workflow_cancel` 工具定义。
- [x] `workflow_start` 只接受 workflowId，复用 terminal risk 和 D11 approval/grant；不接受 profile 内容或命令。
- [x] plan/explore/implement 子 Agent 不注册启动/取消工具；保留只读查询范围。
- [x] 事件、结果和错误 bounded、脱敏，不写入聊天 history、usage、memory、hooks 或 export。
- [x] 增加 provider、permission、Agent 模式和 opaque 引用测试。

## 7. Task 6 - 工程中心 Renderer UI

涉及：`src/renderer/index.html`、`src/renderer/app.js`、`src/renderer/styles.css`、UI 测试。

- [x] 增加 workflow 列表、创建/编辑表单、节点依赖选择和 DAG 校验提示。
- [x] 增加 run 列表和详情：节点状态、整体状态、并行/超时、stale/configuration_changed、取消和完整重跑。
- [x] 复用 D11 验证诊断定位和结果摘要，不复制日志、命令或源码。
- [x] 在 D5/D6/D7 确认卡加入通过 run 选择和 gate 原因；没有通过 run 时提供跳转工程中心，不自动启动。
- [x] 监听后台 workflow 事件；切页、停止 Agent 和刷新不丢失状态。
- [ ] 确认窄窗口、键盘操作、QQ 2007 视觉和 D10 Tasks/D11 index UI 不回归。
- [ ] 增加 renderer source-contract、DOM 冒烟和 storage 隐私测试。

## 8. Task 7 - 全量回归与桌面验收

- [x] 为新增 JS 文件运行 `node --check`，运行 `npm test`，要求 0 failed。
- [x] 运行 `git diff --check`，确认无新增 runtime dependency 和明文 workflow 文件。
- [x] 自动化验收 DAG、并行、失败策略、取消、超时、stale、配置变化、中断恢复和 rerun。
- [x] 自动化验收 D5/D6/D7 gate 在通过、失败、fingerprint 变化和竞态下无意外副作用。
- [x] 执行 localStorage、session export、memory、usage、hooks、日志和聊天 history 明文扫描。
- [ ] 完成真实 Electron 中型项目工作流、切页后台运行、重启中断、诊断定位和 gate 操作。
- [x] 重跑 D8-D11 以及旧 `verifyCommand` 回归；外部依赖缺失只能记录 skip，不得宣称完整交付。

## 9. 交付顺序与回滚

实施顺序固定为：workflow 设置/规范化 -> 加密 store -> manager 调度器 -> main/preload 与 gate -> Agent/provider -> renderer -> 全量回归和桌面验收。

每一步保持旧行为可用。workflow manager 或 store 不可用时，D11 单 profile 验证继续工作；gate 接线失败时 D5/D6/D7 回退到原有显式确认流程，但不得静默自动放行。回滚只移除 workflow IPC/provider/UI 和两份 workflow envelope，不删除 D11 jobs/grants、D5 marker、D6 PR 摘要或 D7 列表状态。

## 10. Definition of Done

- [x] workflow 定义、DAG 校验、加密持久化和历史清理测试全绿。
- [x] 调度、并发、取消、超时、stale、配置变化、中断恢复和完整 rerun 测试全绿。
- [x] Agent 只能启动已保存 workflow，事件/结果 bounded、脱敏且不写入聊天历史。
- [x] 工程中心支持编辑、运行、取消、重跑、诊断定位和后台状态更新。
- [x] D5/D6/D7 可选 gate 在 fingerprint 不匹配时严格拒绝，旧流程不回归。
- [x] `npm test`、`node --check`、`git diff --check` 全部通过，无新增 runtime dependency。
- [ ] 完成真实 Electron 桌面工作流和重启验收，并记录 D8-D11 前置状态。
