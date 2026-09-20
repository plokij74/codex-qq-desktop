# Phase D.15 - GitHub Actions 后台跟踪设计

日期：2026-09-20  
状态：已按用户确认方案实施；真实桌面与 GitHub 验收单独记录。  
前置：D7 PR 页面、D14 Actions 失败与显式重跑 / 更新 PR。

## 1. 目标与边界

用户在同仓库、打开状态的 PR 上手动点击「跟踪 CI」，主进程跟踪开始查询时确认的 PR head 上全部已发现的 GitHub Actions workflow runs。切换页面、会话、项目或最小化不影响跟踪。PR head / head branch 改变时结束原跟踪，不自动追踪新提交。

D15 只读取元数据和提醒，不自动修复、重跑、验证、提交、push、merge，也不增加 Agent tools。D7 合并门禁、D12 本地 workflow gate、D13 repair 和 D14 一次性远端审批均保持独立。「已发现的 Actions 通过」不表示 PR 可以合并，不涵盖非 Actions checks、required checks、review、部署策略或稳定窗口后才出现的工作流。

## 2. 已锁定参数

| 项目 | 决策 |
| --- | --- |
| 启动 | 仅显式点击；PR 页面、D14 更新成功后的快捷入口 |
| 查询范围 | 当前绑定 canonical 项目的 origin；GitHub.com / Enterprise；同仓库 PR |
| 粒度 | PR 当前 head 的全部 workflow runs，不是单个 job |
| 查询节奏 | 完成一次查询后 15 秒再查；不重叠、不补发错过的轮询 |
| 单轮预算 | 总共 15 秒，包括本地 origin、PR、分页 runs、完成前复检 |
| 跟踪期限 | 默认 30 分钟，允许 15 / 30 / 60 分钟；从启动计算绝对期限 |
| 稳定窗口 | 全部已发现 runs 完成且 run ID / attempt / status / conclusion 连续稳定 30 秒 |
| 完成复检 | 再查 PR head 和 origin，确认未变且没有新增 rerun barrier |
| 数量 | 每 canonical 项目 1 条活动跟踪；应用总共最多 3 条 |
| 元数据上限 | 每轮最多 200 runs、2 页；超过上限或分页不一致不给出通过结论 |
| 历史 | 全应用最多 50 条终态记录，活动记录不被历史裁剪 |
| 生命周期 | 只在内存；renderer reload 可恢复主进程现存记录，应用重启不恢复 |
| 提醒 | 应用内未读记录始终可用；Windows 通知默认关闭 |

## 3. 主进程模型

`ci-watch-manager` 是独立于聊天 run、D11 verification 和 D14 repair 的应用级 manager。

记录私有字段包括 canonical project path / project key、origin 身份、PR number、固定 head、已发现 run attempts、稳定 fingerprint、重跑 barriers、绝对 deadline、轮询与 deadline timers、AbortController、poll generation 和 revision。公开字段只包含 opaque `ciw_<24 hex>`、project key、PR number、head SHA、状态 / 结论、计数、时间、固定 reason code、未读与等待 attempt 标记。详情额外提供最多 200 条脱敏 workflow 名称、字符串 ID、attempt、状态、结论。

正常路径：`starting → watching → completed`。其它终态是 `head_changed`、`pr_closed`、`expired`、`stopped`、`error`。所有终态停止本地 timer / 请求；`stop` 从不取消远端 Actions。

结论规则：

- 有 pending run 或未发现 run：继续等待；空列表不会通过，到期显示「仍未发现 Actions」。
- 全部完成且存在 failure / timed_out / startup_failure：`failed`。
- 至少一个 success，其余均为 success / neutral / skipped：`passed`。
- 全部跳过、中性、取消、action_required、stale、未知 completed conclusion：`attention`。
- 未知 run status、重复 ID、head 不匹配、缺字段、已见 run 消失或 attempt 倒退：元数据不完整，结束为 error。

查询暂时失败退避 30 / 60 秒，连续第三次失败结束。GitHub 401 / 403 / 404 等确定失败立即结束。429 / 限流 403 使用 Retry-After / rate-limit reset，最少 15 秒、缺省 60 秒，同 host 共享 cooldown；初次仓库解析也在任何远端 GET 前检查共享 cooldown。等待不延长 deadline。

系统 suspend 中止进行中的查询并清空稳定窗口；resume 先核对绝对 deadline，过期立即结束，未过期仅安排一轮查询。poll generation 区分休眠取消与真正查询失败，避免即时 suspend / resume 竞态。停止、失效和退出后的迟到响应不能更新记录。

## 4. D14 rerun attempt barrier

D14 在审批和新鲜度复检通过、真正发出 rerun POST 前，向 D15 的 main-only 回调发出 `sending`，随后发出 `requested`、`uncertain` 或 `failed`。事件包含可信 project / repo / PR / head / run ID / 原 attempt / remoteCiRef，renderer 不可填写这些事实。

- `sending` 阶段永不允许跟踪完成。
- `requested` 或 `uncertain` 必须观察到该 run 的更大 attempt，才能解除等待；旧失败不能代表新的重跑结果。
- 确定 `failed` 解除该次 barrier，但仍重新计算稳定窗口。
- barriers 在开始跟踪之前也能登记；pending barrier 不会被活动跟踪期间的清理移除。
- barrier 变化会清空稳定窗口；完成前异步复检使用 barrier version，防止审批刚完成时错误结束。
- 原跟踪已结束后不自动重新启动；用户再次点击跟踪时仍采用保留的 barrier。

## 5. IPC、归属与隐私

五个 IPC 入口是 `engineering:ci-watch:start/list/get/stop/ack`。每次必须证明 sender-owned `projectBindingId`；start 仅接受 PR number 和时长，其余操作仅接受 opaque watchRef。未知字段、renderer 路径 / host / repo / SHA / commands / run IDs 全部拒绝，并在异步分发前再次核对绑定。

事件走专用 `engineering:ci-watch:event`，不复用昂贵的 engineering aggregate 刷新。只投递给当前拥有该项目绑定的窗口。工作目录重绑或显式删除会释放旧项目归属，最后一个 owner 离开时停止活动跟踪；同目录的另一个有效 owner 不受影响。renderer reload 仅撤销旧 token / 事件归属，跟踪仍由主进程运行，重新绑定后通过 list 获取现状。

后台 GET 不读 job logs、annotations、评论、patch 或用户 token，不启动 LLM。HTTP headers / 原始 stdout / stderr 只在 adapter 内处理，不进入 IPC。记录不进入 localStorage、session export、memory、usage、Hooks 或普通 Agent event。

## 6. 提醒与 UI

- PR Checks 区域有独立 CI 面板：时长、手动开始 / 停止、计数、head、剩余时间、上次与下次查询、结果、工作流展开、查看 PR / 查看失败。
- 工程中心显示当前项目的活动与终态记录。工具栏「CI 结果」显示全窗口已绑定项目的未读数，可跨项目跳转。
- renderer 只每秒更新时间文本；不自行查询 GitHub。主进程事件仅重画 CI 区域，不重画 PR 标题、正文、评论输入框。
- 所有 list / action / detail 返回值使用捕获的 project path / token 和 revision 检查。展开详情从主进程内存读取，每 revision 最多一次自动读取，避免异常响应导致循环；折叠重开可重试。
- 结果跳转先通过有效绑定 get watch，再使用返回的 PR number 导航，导航成功后才 ack。通知 payload 不能指定新的仓库 / URL / PR。若 PR 已有新 head，D14 只展示当前提交的新鲜失败来源。
- `ciWatchSystemNotifications` 默认 false，只接受严格 boolean。开启后，当存在有效 owner 且 owner 窗口均不在前台时发送一次通用通知。正文仅含 PR number 与结果，不包含工作流、branch、日志或凭据。
- 通知点击时再次核对实时窗口 / 绑定 / watch；目标失效只聚焦应用。通知不支持、系统拒绝或发送失败不影响应用内未读结果。

## 7. 验收

自动化覆盖 GitHub 只读参数与分页、元数据分类、稳定窗口、延迟 run、rerun race、限流、超时、停止 / 休眠迟到响应、数量上限、owner / 重绑 / reload、专用 IPC、通知去重 / 失效点击以及 renderer 控件交互与 revision 竞态。

桌面验收脚本：`node scripts/smoke-ci-watch.cjs`。使用真实 Electron renderer / preload 与 watch / IPC manager，GitHub 为假数据，独立临时 userData，禁止 HTTP(S)，不发送 OS 通知。目标覆盖 1100×720、900×580、未保存 PR 编辑、后台完成、全局提醒跳转和 reload。

真实 GitHub Actions、GitHub Enterprise 和 Windows 通知送达仍须在用户环境显式验收；模拟通过不替代真实验收。具体执行结果见同日期实施记录。
