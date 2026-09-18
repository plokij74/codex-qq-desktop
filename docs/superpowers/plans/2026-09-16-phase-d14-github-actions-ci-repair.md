# Phase D.14 - GitHub Actions 远程 CI 修复闭环实施计划

**设计规格:** `docs/superpowers/specs/2026-09-16-phase-d14-github-actions-ci-repair-design.md`
**实施状态:** 已实施（自动化测试全部通过，待真实桌面验收）
**目标:** 将当前项目同仓库 PR 的 GitHub Actions 单 job 失败转换为可信 D13 repair 来源，并允许用户审阅、可选本地复验、显式 exact-lease 更新原 PR；不直接修改主工作区，不引入自动修复循环。

## 0. 前置基线

- [x] 运行完整 `npm test`，记录 D5-D13 基线；区分产品回归、网络/`gh` 环境缺失和真实桌面未验收项。
- [x] 对 D5 marker/result、D6/D7 PR detail/checks/mutation、D11 profile/result、D13 source/record/store/validation 做接口快照测试。
- [x] 冻结 D14 ref、ID 字符串、snapshot/public allowlist、来源 fingerprint、日志/diagnostic/context 上限和错误码。
- [x] 确认不增加 runtime dependency，不读取 token，不修改 D7 merge gate、D12 gate 或 D13 local source 语义。

验收点：只有基线明确后才开始 schema 变更；仓库已有 `.idea/` 与临时测试日志保持未跟踪，不纳入 D14。

## 1. Remote CI state 与 encrypted store

- [x] 新增 `remote-ci-state.js`：`rci_` ref、十进制 ID、snapshot normalization、dedupe key、repo/source fingerprint、public summary 和固定上限。
- [x] snapshot 只接受 immutable GitHub Actions failure/timed_out 元数据；拒绝未知字段、URL、日志、token、命令与路径。
- [x] 新增 safeStorage `remote-ci-store.js`，实现 v1 envelope、原子替换、损坏保留、memory-only 和每项目/全局 pruning。
- [x] pruning 跳过仍被 repair 或 unresolved D5 result 引用的 snapshot。
- [x] store/privacy 测试证明日志、annotations、steps、signed URL、profile command 和 patch 不落盘。

验收点：safeStorage 不可用时不创建明文文件；store 损坏只关闭 D14 新写入，不影响 D7/D11-D13/D5。

## 2. GitHub Actions 窄 adapter

- [x] 扩展 PR normalization，读取 `isCrossRepository`、head repository identity、head ref/head SHA，并保持 D7 旧字段兼容。
- [x] 增加当前 commit latest check runs 查询，只保留 bounded public metadata，GitHub numeric IDs 全程使用字符串。
- [x] 对 GitHub Actions details URL 做同 host/repo 严格解析，再用 run/job API 对账 head、attempt、name、status 与 conclusion。
- [x] 增加 check annotations、run/job/steps 和 bounded raw job log 读取；分页、timeout、maxBuffer 和 abort 均固定。
- [x] 为 job log 增加独立 bounded raw runner，保留换行、2 MiB 硬上限；不得复用会压平输出的通用 error runner，也不得直接公开 raw stderr/stdout。
- [x] 增加 job rerun POST；超时/未知响应不得自动重试。
- [x] 增加 branch tip 读取与 exact-lease push adapter；所有命令 `shell:false`、参数分离、无用户 refspec。
- [x] 扩展 redaction，覆盖 GitHub token、Authorization、signed log URL、常见云凭据、ANSI 和控制字符。

验收点：伪造 URL/ID、GitHub Enterprise host、non-zero checks JSON、分页/截断、认证/网络失败均有固定脱敏结果。

## 3. Remote CI manager 与 source context

- [x] 新增 `remote-ci-manager.js`，通过 project binding 解析 origin/repo，并实现 failures、snapshot/list/get 和动态 capability。
- [x] 只接受 `OPEN`、same-repo、当前 head、latest attempt 的 Actions `failure/timed_out`；fork 与其它 checks 保持只读展示。
- [x] snapshot 对相同 project/PR/head/check/attempt 幂等返回同一 ref；远端事实变化创建新 ref。
- [x] 实现审批前后统一 freshness resolver，返回 stable source fingerprint、baseHead 与 delivery metadata。
- [x] resolver 分成 metadata/materialize 两阶段；审批前不读取 annotations 正文或 job log，审批后复检再构造内容。
- [x] 构造 annotations-first context，补充 failed steps 与 16 KiB log 头尾，最终限制为 D13 32 KiB。
- [x] 复用 D11 diagnostic parser/path normalization；零可信内容时关闭失败，不接受 renderer 替代日志。
- [x] 暴露 main-internal repair source resolver，不把远程正文放入 IPC、事件或持久 store。

验收点：repo/PR/head/check/job/attempt 任一不一致均在创建 worktree 前失败，且没有隐藏 fetch 或 D5 副作用。

## 4. D13 repair schema v2 与 remote source

- [x] `repair-state/store` v2 将 `sourceFingerprint` 与可选 `validationProfile` 分离。
- [x] 迁移 v1 `profileId/profileFingerprint/sourceWorkspaceFingerprint`，保持旧 public alias 和 retry/history/resultId。
- [x] `normalizeSource` 增加 `{ kind:'remote_ci', remoteCiRef }`，拒绝 PR/SHA/job/log 等附加字段。
- [x] `repair_start` 仅对 remote source 接受可选 `validationProfileId`；main 解析已保存、启用 profile 并冻结 fingerprint。
- [x] 将 D11/D12/remote resolver 适配统一内部 source shape，不改变旧来源 freshness 规则。
- [x] remote retry 重新验证 snapshot/head，创建新 repair/worktree；stale 来源不可改绑。
- [x] validation profile 缺失时只禁用 repair validation；生成、审阅和 PR update 仍可进行。
- [x] Agent 只可读取已有 snapshot 并用 ref 请求 repair；不能 snapshot、指定 profile、rerun 或更新 PR。

验收点：旧 D13 所有测试无语义变化；v1 store 可读、v2 重写后字段完整，迁移失败保留原文件。

## 5. D5 create-at-commit 与 marker v2

- [x] 提取 D5 create 共享核心，增加只供 main 使用的 `createAtCommit`；普通 create 继续取 local HEAD。
- [x] remote create 仍执行 clean repo、pending cap、exclude、canonical path、detached/locked 与 registration 全套校验。
- [x] 实现内部 ref fetch：固定 namespace、branch ref 校验、OID=head SHA、worktree 注册后删除临时 ref。
- [x] 扩展 `runIsolatedImplement` 的 main-internal `createWorktree` callback；remote manager 构造闭包，runtime 继续统一负责 child run、collect 与 incomplete cleanup。
- [x] callback 不进入 tool schema/IPC/settings/store，失败不得回退普通 create 或主树写入。
- [x] marker v2 增加 base/origin/delivery kind 与 remoteCiRef；v1 默认映射保持旧行为。
- [x] remote result 继续使用同一 collect/patch/hash/expectedTree/manifest 与恢复逻辑。
- [x] capability：preview/open/discard 保留；apply 要求 local HEAD==baseHead；create Draft PR 禁用；update PR 由新动作提供。
- [x] safeStorage/source 丢失时 result 仍可恢复审阅与丢弃，不从 marker 猜测远端 authority。

验收点：local HEAD 与 PR head 不同也能在精确 remote commit 生成 patch；主工作区、用户 refs、tags 和 FETCH_HEAD 不变。

## 6. 显式更新原 PR

- [x] 在全局 worktree mutation lock 内增加 remote result delivery preflight，联合验证 D5 result 与 remote snapshot。
- [x] 从 baseHead + expectedTree 创建单个 commit；验证 direct parent、tree、manifest 和 bounded subject。
- [x] 缺 Git identity 时返回固定错误，不修改任何 Git config。
- [x] push 前原子持久化 oldHead/newCommit/subject/expectedTree；重试始终复用同一个 commit，不受重启、时间或 identity 变化影响。
- [x] push 前重新读取 PR/head 与 `ls-remote`，要求 old head 精确一致。
- [x] 只允许 direct-child fast-forward commit，并使用 exact `--force-with-lease=<ref>:<oldSha>`；禁止任意 force/refspec。
- [x] push 后重新读取 PR 证明 new head；成功后进入 cleanup，不自动 rerun/refresh/merge/ready。
- [x] 增加 preparing/pushing/failed/uncertain/cleanup/updated 状态、marker migration 与幂等 retry。
- [x] retry 按 current==new/current==old/other 三态处理，不重复生成不同 commit，不覆盖并发更新。
- [x] branch protection、权限不足、网络超时、刷新失败和 cleanup failure 都保留可审阅结果与明确恢复动作。

验收点：远端只可能从 exact old head 前进到一个已证明 tree 的子 commit；任何 head 竞争都 fail closed。

## 7. 显式 rerun 与 IPC/Preload

- [x] 实现 snapshot rerun freshness、独立确认与 job rerun POST；不修改旧 snapshot、不轮询。
- [x] 新增 remote CI failures/snapshot/list/get/rerun/update-pr IPC，并接入 sender-owned engineering binding。
- [x] preload 对每个 payload 逐字段重建；update-pr 只接受 resultId + subject，由 marker 解析 remoteCiRef。
- [x] main 拒绝 projectPath/repo/url/branch/sha/run/job/log/refspec/lease/token/approval 注入。
- [x] 事件只复用 D13 repair/D5 result 的 bounded 状态；remote CI 请求不广播正文。
- [x] 添加 remote source 的 Agent 只读工具与模式过滤，主 Agent 无远端 mutation 能力。

验收点：跨 sender/project/ref/result 请求全部拒绝；`full-auto` 和 allow_session 均不能触发 rerun 或 update PR。

## 8. PR、Repair 与结果卡 UI

- [x] 在 D7 PR checks 区显示 Actions workflow/job/attempt/结论与可导入原因。
- [x] “生成修复”先 snapshot，再显示来源、head、job、内容可用性、可选 D11 profile 和 note。
- [x] fork/非 Actions/pending/旧 attempt/unsupported conclusion 只显示原因，不显示可执行入口。
- [x] remote repair 详情显示 PR/job/head/snapshot freshness 与本地 validation 的 advisory 标签。
- [x] D5 remote result 隐藏 create Draft PR，按 capability 显示 apply 与“更新此 PR”。
- [x] update 确认展示目标 PR/branch/old head、文件统计和可编辑 commit subject。
- [x] uncertain/head changed/protection/identity/store unavailable 提供对应重试、刷新、打开或丢弃动作。
- [x] rerun 独立确认；成功只提示手动刷新，不启用后台计时器。
- [x] 覆盖窄窗口、键盘焦点、loading/abort/rebind 和 QQ 2007 现有视觉层级。

验收点：远程日志不进入 localStorage/DOM 长期状态；切页或停止聊天 Agent 不取消已启动 repair，但关闭窗口不会继续未确认 mutation。

## 9. 恢复、隐私与回归

- [x] 启动恢复将 active PR update 标为 uncertain，不自动访问 GitHub或执行 push。
- [x] 打开结果时按 old/new/current head 对账并恢复 capability；snapshot/store 不可用时安全降级。
- [x] 检查 remote store、repair store、D5 marker、renderer DOM/localStorage、session/export、usage、memory、hooks、普通 event 与日志的 allowlist。
- [x] 确认任何持久位置都没有 CI log、annotations、signed URL、token、API 原文、profile command 或 patch 副本。
- [x] 重跑 D5-D13 全量测试，特别覆盖 D6 Draft PR、D7 lifecycle/merge、D11 verification、D12 gate 和 D13 local repair。
- [x] 确认 `package.json` 无新增 runtime dependency，README/阶段状态在真实桌面验收前不宣称 D14 已交付。

验收点：任何 D14 manager/store/GitHub 故障都不能破坏旧 PR 浏览、本地 verification/workflow/repair 或 unresolved D5 patch。

## 10. 真实桌面验收

- [ ] 同仓库 Actions failure -> snapshot -> repair -> diff，确认隔离 base 是 PR head 且主工作区完全不变。
- [ ] local HEAD 与 PR head 不同：apply 不可用，update PR 正常；local HEAD exact match 时 D5 apply 仍通过。
- [ ] 无本地 profile与选择 profile 两条路径；profile 修改/删除、validation failed/stale 均不改变远端交付能力。
- [ ] exact-lease push 成功，PR 只新增一个 commit，新 checks 手动刷新可见。
- [ ] 并发移动 head、branch protection、无权限、无 Git identity、push timeout/post-read failure 和重启恢复。
- [ ] job rerun 创建新 attempt，旧 snapshot 保持 immutable，新失败需新 snapshot。
- [ ] fork、closed/merged、非 Actions、pending/success/cancelled、旧 attempt 全部不可生成 remote repair。
- [ ] GitHub Enterprise、认证过期、网络断开、safeStorage unavailable/corrupt 和 remote store 丢失降级。
- [ ] 扫描私有仓库场景的持久文件、导出、日志与 UI state，确认远程 CI 正文和凭据不泄露。

## 11. 完成标准与回滚

- [x] 自动化测试、JS 语法检查与 `git diff --check` 全部通过。
- [x] D5-D13 回归为 0 failed；外部 GitHub/Enterprise 环境缺失只能记录为 skip，不能宣称完整交付。
- [ ] 真实 Electron 验收覆盖 source、repair、validation、update、rerun、race、取消和恢复后，才更新规格/计划状态与 README。

回滚按层进行：

- UI/IPC 回滚只移除 D14 入口，不删除 snapshot、repair 或 D5 result。
- remote CI manager/store 回滚使 remote source 不可新建；D7 PR 和旧工程中心继续工作。
- D13 v2 必须保留 v1/v2 只读兼容，不能通过回滚丢弃已有 repair history。
- D5 marker v2 必须继续允许 preview/open/discard；禁止因 D14 不可用而删除 remote result。
- 已更新的远端 PR commit 不自动回退；用户继续使用 GitHub/D7 正常 PR 生命周期处理。

## 12. 最终核对

- [x] 只有 current origin、same-repo open PR、current head、latest attempt 的单个 Actions failure/timed_out 能成为来源。
- [x] renderer/Agent 无法注入 repo、SHA、branch、job、日志、refspec、lease 或 approval。
- [x] 远程正文只进 bounded memory + 单次 repair prompt，任何持久/导出/日志面都不包含正文。
- [x] repair 仍一次一候选，validation 可选且 advisory，无自动循环。
- [x] remote base 不改变主工作区；apply 仍受 exact base，update PR 受 exact lease。
- [x] rerun/update 每次用户显式确认，`full-auto` 与 Agent 都不能自动触发。
- [x] fork、后台轮询、多 CI provider、artifacts、多候选和自动修复循环明确留在后续阶段。
