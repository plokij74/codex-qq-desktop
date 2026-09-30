# Phase D18：AI PR 审查发现直接修复

日期：2026-09-30。状态：已完成。

## 目标与已确认决策

在 D17 报告中选择发现，直接生成隔离修复，审阅 diff、可选本地复验后单独确认更新原 PR。修复不要求先把发现发布到 GitHub。

- 同一报告每次选择 1–5 个不同发现，一个 worktree、一份结果、一个交付提交。
- 使用保存的原始发现，可另填最多 2000 字补充说明；D17 发布文案与发布勾选独立保留。
- 支持有效的 LEFT/RIGHT 位置，以及删除和重命名相关发现。
- 已完成且未过期的报告才可修复；Review 发布状态不影响修复资格。
- 沿用当前 API/模型、origin 同仓库的 OPEN PR（含 Draft）、GitHub.com/Enterprise 和 D5 清洁工作区前置检查。
- 本地复验可选且仅供参考；生成、验证、PR 更新沿用各自权限，不自动串联远端动作。

## 用户流程

1. PR 详情的 AI 审查面板中勾选“修复此项”，默认不选。修复选择与“发布此项”互不影响。
2. 打开修复预览，查看原始发现、来源提交，填写说明并选择可选验证档案；点击生成后使用 D13 写入授权。
3. 工程中心显示准备、生成、收集、结果与取消/重试。可打开 D5 diff，手动运行已选档案的复验。
4. 单独确认“更新此 PR”。结果不能另建 PR；只有本地 HEAD 等于基线且通过 D5 检查时才能应用到主工作区。
5. 历史和结果卡可返回原报告定位所选发现。更新后提供重新 AI 审查与显式 CI 跟踪入口；不自动发布 Review、回复或解决线程，也不把生成成功等同于问题已消除。

选择、修复说明、验证档案和发布草稿按项目、绑定、PR、报告隔离，仅在 renderer 内存保存。局部刷新保留编辑、焦点与滚动；异步响应使用绑定和请求代次检查，不能由旧页面响应启动修复。

## 来源与固定提交

新增 PrAuditRepairManager 作为 D13 的 pr_audit 来源适配器，复用 D17 快照校验和共享 pr-delivery。

主进程从绑定解析规范项目目录与 origin，从已保存报告读取发现。repairRevision 覆盖规范化来源、报告和完成/过期状态，不包含 Review 发布状态。选择按原报告顺序规范化，拒绝重复、跨报告、缺失或超过 5 个的 ID。

不可变来源保存 auditRepairRef、auditRef、projectKey、repoKey、PR 编号、所选 findingIds、repairRevision，以及 base/head 分支与 SHA、merge-base、项目相对范围和 PR 描述 hash。来源指纹覆盖完整元数据。Renderer 不能提供仓库、SHA、磁盘路径、代码位置、问题正文或批准结果。

创建来源和构建上下文时重新获取完整 diff 并验证所选位置。RIGHT 读取 head 下的路径；LEFT 读取 merge-base 下的原路径，明确当前路径、旧路径及删除/重命名状态。代码片段沿用 D17 有界读取，不能回退到本地工作区。

批准前后、上下文构建、fetch 后及交付前检查来源。仓库、范围、PR 描述、base/head 分支或 SHA、merge-base 变化使来源失效，需重新审查。发布状态变化不会使旧选择失效。来源导航只验证项目与仓库绑定，允许从历史回看已过期报告。

D18 的快照与远程 worktree 获取使用独立 refs/codex/pr-audit-repair 命名空间，每次操作使用随机引用；finally 清理，仅在绑定恢复时清理本模块无活动所有者的遗留引用。不改变主工作区 HEAD、index、文件、远端跟踪分支或 FETCH_HEAD。

## 生成、交付与生命周期

复用 D13 每项目一个活动修复、六轮 implement、工具限制、取消和部分结果收集、可选 advisory 验证。来源正文、代码和补充说明均为不可信任务资料。完整问题、片段、说明和模板最多 32 KiB UTF-8，超限整批拒绝，不能截断问题后继续。marker goal 固定为“处理 AI PR 审查发现”。

当前模型必须可用；不新增模型配置、不开放终端、网络、MCP、Hooks、Git 提交或 push 给修复 Agent。只由主进程创建以报告 head 为基线的隔离 worktree。

更新 PR 使用共享写入锁、结果身份检查、单父提交和 tree 验证、精确 lease 推送。每次远端写入都需要一次性批准，full-auto 不能绕过。明确拒绝的推送可手动重试并复用提交；不确定推送与重启恢复只能读取核对，不因暂时看到旧 head 而重发。核对已发出推送使用冻结的来源和提交身份，不要求旧报告仍匹配已经被本次更新推进的 head。

页面切换、会话切换或最小化不取消任务。解绑、项目删除、sender 销毁或应用退出会取消；取消信号保留至生成结束。重启把活动修复标记 interrupted，保留可验证的 D5 结果，不自动恢复模型调用或推送。事件仅发送有界元数据给当前项目所有者。

## 接口与数据兼容

所有 IPC 都包含 sender 拥有的 projectBindingId。

| IPC | 额外输入 | 输出/变化 |
| --- | --- | --- |
| engineering:pr-audit:get | auditRef | 增加 repairRevision |
| engineering:pr-audit:repair-snapshot | auditRef, repairRevision, findingIds | auditRepairRef 与来源摘要 |
| engineering:pr-audit:repair-source | auditRepairRef | 原报告与所选发现定位 |
| engineering:pr-audit:update-pr | resultId, subject | PR 更新/只读核对结果 |

repair:start 增加来源 `{ kind: 'pr_audit', auditRepairRef }`；note、validationProfileId、取消、重试、验证和历史沿用 D13。auditRepairRef 为 par_<24 hex>。该来源仅由 UI 发起，Agent bridge 拒绝启动。

worktree 结果带 originKind=pr_audit、auditRepairRef、baseKind=remote_commit、deliveryKind=github_pr_update。repair store 与 marker 升到 v4，继续读取 v1–v3；旧版本不能冒充新的 pr_audit 来源，来源 ref 与基线、交付类型必须一致。

engineering-pr-audit-repairs.json v1 使用 safeStorage 加密，仅保存不可变来源元数据，不重复保存发现正文。每项目 50 条、全局 200 条。保留的 repair 历史、活动任务及未处置 worktree 引用的来源和 D17 报告免淘汰；扫描失败时保守保留，全受保护时拒绝新增。新来源至启动请求之间也保护报告；未使用来源可淘汰。不可加密/写入时退化为内存并显示状态；临时写入、解密读回校验和 rename，损坏文件保留不覆盖。恢复时缺少报告的来源不能启动新的修复。

补充说明、完整上下文、代码片段和发布草稿不写入 source/repair store、worktree marker、聊天、localStorage、导出、记忆、Hooks 或事件正文。用量只记录数值。

## 验收

- fake GitHub/model：多选、重复/跨报告 ID、全部发布状态、原始发现与发布草稿分离、六轮限制、字节预算、可选复验、批准期间变更和无自动远端操作。
- 真实临时 Git：LEFT/RIGHT、删除/重命名、子目录、符号链接/子模块、脏工作区拒绝、精确基线、ref 清理、单父/tree 校验、推送不确定与重启不重发。
- IPC/存储：跨 sender/绑定、注入参数、解绑取消和迟到响应、部分结果、报告保护、容量、损坏/加密失败和 v1–v4 恢复兼容。
- 真实 Electron 离线冒烟：1100×720、900×580，多选、预览、生成、diff、可选复验、批准更新、报告回溯、草稿保留、重新加载及 CI 入口；回归 D15–D17。
- 新增与 D13–D17 定向测试、完整 npm test、脚本语法、git diff --check 通过。

设计前基线：2026-09-30 的 D17 state/snapshot 与 D16 repair/delivery 共 17 项通过。真实 GitHub/Enterprise 权限与受保护分支写入仍需要指定测试仓库的独立现场验收；离线脚本不执行真实远端操作。
