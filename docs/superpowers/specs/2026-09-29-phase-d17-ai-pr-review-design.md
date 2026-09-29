# Phase D17：主动 AI PR 代码审查

日期：2026-09-29。状态：已实现，已完成自动化与桌面冒烟验证。

## 目标与已锁定决策

在 PR 详情手动发起只读 AI 审查，分析 diff 和同一提交下的相关代码、测试；用户查看依据、编辑和勾选意见后，一次确认发布 COMMENT Review。发布后的线程继续使用 D16 的查看、回复、解决与隔离修复。

- 只支持当前绑定项目 origin 同仓库的 OPEN PR，包括 Draft；沿用 gh 登录，支持具备所需 API 的 GitHub.com / Enterprise。
- 当前 API/模型配置用于审查。本地模拟模式不生成可发布报告。
- 只发布 COMMENT，不提供 APPROVE、REQUEST_CHANGES、自动触发或直接修复未发布发现。
- 报告和发布记录加密保存；未发布编辑草稿、完整代码上下文和模型提示不落盘。

## 提交快照与只读运行

主进程从 sender 的 projectBindingId 解析规范项目目录、Git 根和 origin。冻结仓库身份、PR 编号、base/head 分支与 SHA、merge-base、项目相对范围。GitHub 文件 patch 是行内位置依据；以固定提交的 Git 对象读取代码，不能混入本地未提交文件。

base/head 获取到 refs/codex/pr-audit/pra_<24 hex>/{base,head}，禁止更新远端跟踪分支、FETCH_HEAD、工作区 HEAD、index 或文件。校验 fetch 后 SHA 和 GitHub merge-base；Git 对象读取禁用 replacement、外部 diff 与 textconv，不跟随 symlink、gitlink 或目录范围外的路径。请求前后复核仓库、PR 和来源，不能证明 diff/历史完整时拒绝审查。finally 清理临时 ref；恢复绑定时清理本模块遗留 ref，不删除 Git 对象。

独立 runtime 复用单轮模型请求、流式降级和文本工具协议，不调用通用 Agent 的文件写入/写 fence 收尾。工具只提供快照列表、读取、字面量搜索与 submit_review。GitHub 和 Git 获取由 main 执行固定调用，不向模型开放终端、网络、MCP、Hooks、skills 或子 Agent。PR 正文和代码均为待分析资料，不能修改权限。

审查只报告此次改动引入、有具体触发条件和影响的问题；每项含 P0–P3、标题、说明、路径、side 与行范围。位置必须属于项目范围内本次 diff 的同一 hunk，且覆盖相应 side 的变更行。主进程为发现分配 ID。格式或位置错误允许一次纠正，计入总轮数；自然语言、截断或无效报告不能变成“无问题”。

| 预算 | 首版默认 |
| --- | --- |
| 活动任务 | 每规范项目 1 个，全应用 2 个，超限不排队 |
| 运行 | 8 轮、5 分钟 |
| 变更文件 | 项目范围内最多 100 个；远端列表有界且必须证明完整 |
| diff | 256 KiB UTF-8，超限拒绝 |
| 代码读取 | 单 Blob 128 KiB，累计上下文 512 KiB，并服从配置的上下文预算 |
| 报告 | 最多 30 个发现；正文最多 5000 个 JS 字符 |
| 发布 | 单条正文最多 5000 个 JS 字符，整批 JSON 最多 256 KiB |
| 关注点 | 最多 2000 个 JS 字符 |
| 单次远端请求 | 15 秒；Git fetch 最多 60 秒，均受任务总期限约束 |

已跳过的二进制、symlink、gitlink 和范围外文件明确计入覆盖说明。需要分析的文本 patch 缺失、截断、格式不完整或超限时停止。取消、超时、耗尽轮数、上下文超限均为未完成状态，不允许发布。

## 生命周期与界面

状态为 preparing、running、completed、failed、cancelled、interrupted；stale 与发布状态单独保存。页面/会话切换和最小化不停止后台任务；解绑、删除项目或退出时取消。renderer reload 可重新读取 main 状态。主进程仅向当前项目所有者发送有界元数据事件，不广播代码或报告正文。

PR 详情增加独立“AI 代码审查”面板，工程中心提供任务与历史入口。报告显示来源提交、覆盖、问题、依据和状态；零发现显示“本次审查未发现可确认的问题”。点击位置读取固定提交片段；对象已不可用时明确告知，不回退到当前工作区。

用户可编辑汇总、发现标题与正文，位置不能编辑。发布项默认不勾选，允许仅发布汇总。面板局部刷新；按项目、绑定、PR 和报告隔离草稿，保留 PR 原有编辑和 D16 草稿。异步响应按绑定与请求代次丢弃。

## 接口与数据

所有接口带 projectBindingId；只接受表中参数，拒绝注入仓库、磁盘路径、SHA、位置、远端 ID 或批准结果。

| IPC 前缀 engineering:pr-audit: | 额外参数 | 返回 |
| --- | --- | --- |
| start | prNumber, note? | auditRef |
| list | prNumber? | 有界任务摘要 |
| get | auditRef | 报告与当前状态 |
| cancel | auditRef | 取消状态 |
| context | auditRef, findingId | 固定提交下有界代码片段 |
| prepare | auditRef, revision, summary, selections | 冻结预览、draftRef |
| publish | draftRef | 发布结果/不确定状态 |
| reconcile | auditRef | 只读核对结果 |

selections 为 { findingId, title, body } 数组；位置从报告派生。auditRef 为 pra_<24 hex>，draftRef 为 pad_<24 hex>，发现 ID 为 paf_<24 hex>。revision 覆盖报告、来源和发布状态。prepare 创建进程内一次性草稿；draftRef 不跨重启恢复。

审查记录保存来源快照、状态、覆盖、摘要、发现、数值用量与发布回执。独立 engineering-pr-audits.json v1 使用 Electron safeStorage，加密不可用或写入失败时只在内存运行并显示状态。加密文件通过临时写入、读回验证与 rename 保存；损坏文件保留不覆盖。每项目 50 条、全局 200 条；活动及 publishing/uncertain 记录受保护，全受保护时拒绝插入。

重启将 preparing/running 转为 interrupted，publishing 转为 uncertain。不自动恢复模型调用或远端写操作。完整 patch、Blob、提示、关注点、编辑草稿不持久化；普通聊天、导出、memory、Hooks 和 usage 不接收正文，usage 仅含数值。

## 发布与结果不确定

GitHub 官方 REST 文档已核对：POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews 接受 event=COMMENT、commit_id、body 和 comments 的 path/line/side/start_line/start_side。通过 gh api --hostname HOST --method POST ... --input - 的 JSON stdin 发送，不拼接 shell。

prepare 校验 revision 并冻结规范化的实际发布内容。publish 申请一次性 remote-mutation 批准，复用共享写入锁，在批准前、批准后发送前核对 origin、PR OPEN 状态和 base/head。full-auto 仍需确认；同一 draftRef 不能发送两次。明确未发送或被拒绝的请求可重新预览批准；已发布的报告不再发布。

发送前持久化发布意图、唯一标记、作者、提交、内容及位置 hash，不保存未发布编辑正文。正文带不含秘密的唯一 HTML comment 标记。发送后读取 review 与其完整 comments，核对身份、提交、内容和位置。无条件写入 API 无法防止最后一刻 head 变化：已证明成功时标记 published 并显示 stale；不能宣称原子写入。

超时、断连、部分响应、回读失败等进入 uncertain，不自动重试。reconcile 只读：按远端 review ID 或唯一标记定位，并匹配作者、commit 与完整内容/位置指纹；零匹配、多个匹配、分页不完整或已被编辑均保留 uncertain，不以“暂时查不到”为重发依据。相同报告最多一次成功发布。成功后用户可返回 D16 查看新线程。

## 验收

- fake GitHub + fake model 检验接口、来源、输出、审批、回读和不确定请求不重发。
- 临时真实 Git 仓库覆盖脏工作区、merge-base、rename/delete、LEFT/RIGHT、多行、子目录、symlink/gitlink、文本预算和取消清理。
- IPC 覆盖跨 sender/项目、注入参数、解绑取消与迟到响应；存储覆盖加密、损坏、容量和重启。
- 真实 Electron 冒烟覆盖 1100×720 / 900×580、开始/报告/编辑/确认/发布/核对/历史/草稿保留；禁用真实网络，回归 D15/D16。
- npm test、修改脚本语法和 git diff --check 通过。真实 GitHub.com / Enterprise COMMENT 写入在指定测试 PR 人工验收，不由离线脚本执行。

参考：https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
