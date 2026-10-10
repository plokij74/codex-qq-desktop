# Phase D20：从复审结果继续修复

日期：2026-10-09。状态：已完成。对应 [实施记录](../plans/2026-10-09-phase-d20-pr-audit-recheck-repair.md)。

## 已确认范围

从同一份已完成且与当前 PR 一致的 D19 复审中选择 1–5 项“仍存在”或“无法判断”，预览后生成下一轮隔离修复。默认不勾选，“已解决”不可选。PR 变化或当前性未核实时，必须手动重新复审。单项“无法判断”与整份报告当前性未核实是不同状态。

沿用 D18 的生成、diff、可选手动复验、单独批准更新原 PR。新交付后手动复审本轮选择的问题，可继续多轮，保留独立历史、上一份复审及原始发现入口。未知项展示缺证原因，允许无改动结果。补充说明最多 2000 字，验证档案可选。沿用 API/模型、gh 登录、origin 同仓库 OPEN PR（含 Draft）及 GitHub.com/Enterprise。

## 实现合同

新增 PrAuditRecheckRepairManager，作为 D13 的 pr_audit_recheck 来源适配器，复用六轮 implement、每项目一个活动修复、取消、结果收集与验证。完整上下文含所选原问题、父复审结论、固定提交证据及说明，最多 32 KiB UTF-8，超限整批拒绝。未知项没有目标证据也可尝试，不能把生成成功当作问题已解决。

主进程冻结父复审、父交付、根审查、所选 ID 与目标快照。repairRevision 覆盖不可变内容，当前性单独校验。预览提交、批准、上下文、fetch、交付前均重新核对；变更后保留结果但禁止继续交付。Renderer 不能提供 SHA、路径、正文或结论。

原始 LEFT/RIGHT 始终读取根审查的 merge-base/head。本轮 worktree 基线为父复审目标 head。D19 增加 repair_base 阶段，以“本轮基线 → 本轮修复 → 新复审目标”提供差异；单父提交校验使用本轮基线，原始发现位置保持根快照身份。只检查本轮选择的问题。

复用共享写入锁、tree 校验、精确 lease 推送及一次性批准。不确定推送只读核对，不自动重发；核对使用冻结交付身份，允许父复审因本次更新而过期。D20 临时引用使用独立 pr-audit-recheck-repair 命名空间与随机操作引用，finally 清理。

## 接口与存储

全部 IPC 要求 sender 所属 projectBindingId；仅 UI 发起，不增加 Agent 工具。

| engineering:pr-audit:recheck: 接口 | 合同 |
| --- | --- |
| get | 增加 repairRevision |
| repair-snapshot | recheckRef、repairRevision、findingIds → recheckRepairRef、来源摘要、持久化状态 |
| repair-source | recheckRepairRef → 父复审、根审查、问题定位 |
| update-pr | resultId、subject → 更新或只读核对结果 |

repair:start 新增 `{ kind: 'pr_audit_recheck', recheckRepairRef }`；引用为 pcr_<24 hex>。recheck:start(resultId) 支持 D20 交付。修复选择、说明、验证档案仅在 Renderer 内存按绑定/PR/报告隔离，刷新保留编辑、焦点和滚动，旧响应不得启动任务。

新增 engineering-pr-audit-recheck-repairs.json v1，以 safeStorage 保存不可变来源元数据，每项目 50、全局 200 条。D19 历史升级 v2；旧来源 repairBaseHead 默认为 originalHead。repair store/marker 升级 v5，兼容 v1–v4，旧格式不得冒充新来源。

先恢复来源、复审、修复历史及可信 marker，再建立父链引用保护与淘汰。保留子记录保护父链和根报告，扫描失败保守保留，全部受保护时拒绝新增。加密/写入失败退化内存并提示，损坏原文件保留。代码、完整上下文、说明不进入来源存储、marker、聊天、导出、记忆或 Hooks。

切换页面后任务继续；解绑、sender 销毁、退出取消。重启保留中断记录，不恢复模型或推送。无自动循环、评论、线程操作或合并。

## 验收

- fake model/GitHub：多选、未知项无证据、无改动、复验、连续两轮、非法选择、来源变化、预算及无自动操作。
- 真实临时 Git：原始 LEFT/RIGHT、删除/重命名、空 diff、后续提交、强推、基线与 tree、独立引用、脏工作区及不确定推送不重发。
- IPC/存储：跨绑定、注入、迟到响应、取消、重启、加密降级、父链保护、容量与版本迁移。
- Electron 离线冒烟：1100×720 与 900×580，多轮流程、历史、导航、重载及 D13–D19 回归。
- 针对性测试、完整 npm test、脚本语法及 git diff --check；真实 GitHub.com/Enterprise 使用指定测试仓库另行验收。

设计前检查 25 项既有测试：24 项首轮通过，1 项 Git 子进程异常后单独复跑通过。这不是 D20 实现验收。
