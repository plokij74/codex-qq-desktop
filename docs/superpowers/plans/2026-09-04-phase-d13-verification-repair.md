# Phase D.13 - 验证失败隔离修复建议实施计划

**设计规格:** `docs/superpowers/specs/2026-09-04-phase-d13-verification-repair-design.md`
**实施状态:** 待实施
**目标:** 将仍然新鲜的 D11/D12 单个验证失败转换为 D5 隔离 repair patch，并提供用户显式触发的同 worktree profile 验证；不直接修改主工作区，不引入自动修复循环。

## 1. 实施前置与基线

- [ ] 运行完整 `npm test`，记录 D5-D12 基线和 D8-D12 真实桌面验收缺口；已有失败必须先区分环境问题与产品回归。
- [ ] 对 D5 `create/collect/get/apply/discard/createPr/recover`、D11 job/result/profile fingerprint、D12 run/node/jobRef 和 sender binding 做接口快照测试。
- [ ] 冻结 D13 ref、状态机、source payload、context 上限、错误码、history 上限和 privacy allowlist。
- [ ] 确认不增加 runtime dependency，不修改 D5 clean-base、D11 profile 命令来源、D12 gate 和 D6/D7 PR 语义。
- [ ] 在开始实现前运行 `git status --short`，保留用户现有改动和未跟踪文件，不把无关文件纳入提交。

## 2. Task 1 - Repair state 与公开合同

新增：`src/ai/repair-state.js`、`tests/repair-state.test.js`。

- [ ] 实现 `rpr_<24 hex>` 生成/校验、source union 规范化、note 规范化和未知字段拒绝。
- [ ] 固化 `queued/preparing/generating/collecting/ready/no_changes/failed/cancelled/interrupted` 合法迁移。
- [ ] 固化 `not_run/queued/running/passed/failed/timed_out/cancelled/stale/interrupted/error` validation 迁移。
- [ ] 实现 public summary/result shaping，只返回 opaque refs、状态、时间、计数、D5 result id、retry lineage 和固定错误。
- [ ] 将 diagnostics 50 条、output excerpt 12 KiB、note 2,000 字符、context 32 KiB 等上限定义为单一常量来源。
- [ ] 测试非法 ref、非法迁移、超长字段、控制字符、retry lineage、incomplete result 和公开结构无敏感字段。

验收点：纯函数测试不需要 Electron、Git 或网络，且任何 raw repair record 都不能通过 public shaper 泄露 note、prompt、command、cwd、路径或日志。

## 3. Task 2 - 加密 Repair Store

新增：`src/ai/repair-store.js`、`tests/repair-store.test.js`。

- [ ] 实现 `engineering-repairs.json` versioned safeStorage envelope、同目录临时写入、原子 replace 和写后读取校验。
- [ ] safeStorage 不可用时使用 memory-only store，返回明确 persistence status，不创建明文 fallback。
- [ ] 解密/JSON/schema 损坏时保留原文件并返回 `REPAIR_STORE_CORRUPT`，不得用空历史静默覆盖。
- [ ] 只持久化 spec allowlist 中的 refs、hash/fingerprint、状态、时间、计数、布尔和固定错误码。
- [ ] 实现每项目 50、全局 200 的终态 history pruning；active repair 和未处理 D5 result 不触发 D5 删除。
- [ ] 测试加密成功、不可用、损坏、原子替换失败、旧版本、历史边界、active 保留和明文泄漏扫描。

验收点：解密后的 repair store 仍不包含 note、diagnostics、stdout/stderr、profile command/cwd、absolute path、prompt、模型输出或 patch。

## 4. Task 3 - 失败来源解析与 Context Builder

涉及：`src/ai/repair-manager.js`、`src/ai/engineering-ipc.js`、`src/ai/verification-manager.js`、`src/ai/workflow-manager.js`、测试。

- [ ] 提供 main-internal D11 job/source lookup，返回 authoritative job、bounded result、profileId/fingerprint 和 workspace fingerprint，不暴露 renderer 新接口。
- [ ] D11 source 只接受同项目 `failed` job；拒绝 passed/stale/timeout/cancel/interrupted/error、profile 删除/禁用/变化和 workspace 变化。
- [ ] D12 source 强制 `workflowRunRef + nodeId`；对账 run/node/job/profile/project/workspace fingerprint，最终解析为同一个 D11 failed job。
- [ ] workflow 整体失败但选中节点非 failed、缺 jobRef 或 D11 job 状态不一致时严格拒绝。
- [ ] 构建 diagnostics-first context；不足时加入 bounded stdout/stderr 头尾摘录，并复用 D11 redaction 与项目相对路径校验。
- [ ] 将 note、diagnostics 和日志标记为不可信数据；prompt 模板固定权限与交付边界，不把数据拼进 system 指令位置。
- [ ] 审批前和审批后各执行来源新鲜度复检，fingerprint 改变时不创建 worktree。
- [ ] 测试跨项目 opaque ref、伪造 node、过期 workspace、profile mutation、损坏 result、secret/path redaction 和 prompt injection 文本。

验收点：renderer/Agent 无法通过 payload 提交 command、cwd、env、profile、path、model 或 worktree 参数；所有执行配置来自 main authoritative state。

## 5. Task 4 - 复用 D5 的 Repair Worktree 运行时

涉及：`src/ai/subagent-runtime.js`、`src/ai/worktree.js`、新增 `src/ai/repair-manager.js`、`tests/worktree.test.js`、新增 `tests/repair-manager.test.js`。

- [ ] 从现有 implement runtime 提取 main-internal helper，允许 D5 `handle.childProjectPath` 上运行受限 implement Agent，不改变 `spawn_implement` 行为。
- [ ] helper 每次创建新的 isolated Gate；严格保留 D5 read/write allowlist、no-reparse、`.git` 拒绝和项目根校验。
- [ ] 关闭 terminal、verification/workflow/repair 工具、Git mutation、MCP、Skills、Hooks、web、memory 和子 Agent。
- [ ] repair run 不加载聊天 history，不发送普通 Agent turn/tool/file-change event，不把 child `fileChanges` 合并到父 run。
- [ ] UI 请求由 main 从当前 sender session 解析 provider/model，Agent 请求复用当前 run；拒绝外部 model/base URL/token/maxTurns，缺少可用模型时无 worktree 副作用失败。
- [ ] 固定复用 implement 默认 6 turns、硬上限 12；到达上限后停止生成并按 incomplete 语义收集，不自动续跑。
- [ ] D5 create 使用固定脱敏 goal 和 `repairRef` 关联；不得把 note/diagnostics 写入 `.codex/worktrees/*/meta.json`。
- [ ] implement 正常结束后调用 D5 collect；无变更进入 `no_changes`，有变更进入 `ready`，oversize/collect error 保留 D5 原始错误和现场。
- [ ] 取消或异常后按 D5 incomplete 语义收集部分变更；repair 终态保持 cancelled/interrupted/failed 并带 incomplete result。
- [ ] 每项目一个 active repair；同项目 validation/repair/mutation 冲突返回稳定 BUSY/ALREADY_RUNNING 结果。
- [ ] 测试主树全程不变、dirty/non-Git/PENDING_LIMIT、文本/新增/删除/rename/binary、no changes、abort、max turns、provider error 和 patch tamper。

验收点：D13 只通过 D5 manager 创建/收集/恢复结果，不出现第二套 Git worktree、marker、patch hash 或 apply 实现。

## 6. Task 5 - Repair Manager、取消、重试与恢复

新增：`src/ai/repair-manager.js`、`tests/repair-manager.test.js`。

- [ ] 注入 repair store、verification/workflow/worktree manager、run loop、PermissionGate、settings 和 event sink。
- [ ] 实现 start/get/list/result/cancel/retry；所有 mutation 在 canonical project lock 下串行。
- [ ] start 按 payload -> source -> permission -> source recheck -> D5 create -> generate -> collect 顺序推进并持久化状态。
- [ ] `read-only` 无副作用拒绝，`confirm-writes` 审批一次，`full-auto` 只允许隔离生成。
- [ ] retry 创建新的 repairRef/worktree，记录 `retryOf/rootRepairRef/attempt`，不修改或复用旧 patch/prompt。
- [ ] cancel 阻止新 turn、abort active run，并等待 collect/cleanup 对账；不能在 child 尚未停止时提前完成。
- [ ] close/restore 将 active repair/validation 标记 interrupted，不自动恢复模型或 profile；启动后与 D5 recover/list 对账合法 resultId。
- [ ] store write 失败时 fail-closed 或明确 memory-only，不允许生成成功却丢失 owner/ref 对账。
- [ ] 测试每个阶段取消、重复 start、跨项目并发、retry source changed、store failure、退出/重启、D5 recovered incomplete result 和无 marker/tamper warning。

验收点：重启后所有模型执行都保持停止；有价值的 D5 patch 可以恢复，无法验证的目录不会被 repair manager 自动删除。

## 7. Task 6 - 同 Worktree 显式验证

涉及：`src/ai/verification-manager.js`、`src/ai/worktree.js`、`src/ai/repair-manager.js`、`tests/verification-manager.test.js`、`tests/worktree.test.js`、`tests/repair-manager.test.js`。

- [ ] 为 verification manager 增加 main-internal `runFrozenProfile`，只接受 original project、D5 execution root、profileId、expected fingerprint 和权限上下文。
- [ ] manager 内部解析 command/cwd/timeout，重新锚定 cwd 到 repair child root；外部 payload 永远不能传命令。
- [ ] 复用 terminalEnabled、危险命令拦截、profile grant、timeout/abort、redaction 和 diagnostic parser。
- [ ] validation 不创建普通 D11 jobRef、不进入 D11 history、不广播 D11 job event、不修改 D12 workflow run。
- [ ] worktree manager 增加 main-internal validation checkout helper：运行前验证 stored patch/index/metadata，运行后从 base+patch 恢复 staged tree并再次对账。
- [ ] 处理 profile 产生 tracked/untracked/index/HEAD 改动和 `.git`/registration 篡改；可证明时恢复，不能证明时 `REPAIR_PATCH_CHANGED` 并保留现场。
- [ ] 保存最近一次 validation summary；bounded 详细结果只放当前进程 cache，重启后明确不可恢复。
- [ ] validate 只由 renderer 显式动作启动；Agent 不注册 validate tool。validation failed/timed_out/stale 不修改 D5 capabilities。
- [ ] 实现 validation cancel、应用退出 interrupted、重复 validate 拒绝和 result 已处理/清理后的 unavailable。
- [ ] 测试 passed/failed/timeout/cancel/stale/error、profile changed、terminal disabled/approval、patch tamper、checkout cleanup 和 advisory 非门禁。

验收点：验证执行前后主工作区 HEAD/index/status 不变；D5 stored patch/hash/expected tree 保持一致，或系统明确进入 fail-closed 状态。

## 8. Task 7 - Main、IPC 与 Preload

涉及：`src/ai/engineering-ipc.js`、`src/main.js`、`src/preload.js`、`tests/engineering-ipc.test.js`、preload/source-contract 测试。

- [ ] 在 engineering owner 生命周期中创建/关闭 repair manager，并复用 worktree sender binding 解析 canonical project path。
- [ ] 注册 repair list/get/result/start/retry/cancel/validate/validate-cancel channels。
- [ ] preload 对每个方法逐字段重建 payload，只允许 projectBindingId、opaque refs、nodeId、note、sessionId 和 limit。
- [ ] 事件只发给绑定同 project key 的 webContents；窗口销毁、unbind/rebind 时移除 owner 与 approval gate。
- [ ] Agent bridge 只暴露 main-internal repair list/start/get/result/cancel，不把 validate 或路径/命令能力放进 preload。
- [ ] repair approval 使用独立 `source: 'repair'`，不混入聊天 terminal/file approval 卡或 D11 verification approval 状态。
- [ ] 对账 repairRef/source/resultId 同项目；跨 sender、stale token、伪造 resultId、未知字段和绝对路径严格拒绝。
- [ ] 测试 main IPC 注册、sender ownership、event routing、approval resolve、窗口关闭、payload injection 和 bounded error。

验收点：renderer 即使完全伪造 payload，也只能引用当前 sender 已绑定项目中的 authoritative source/repair；不能控制执行路径或命令。

## 9. Task 8 - Agent 工具与权限面

涉及：`src/ai/agent.js`、`src/ai/agent-mode.js`、`src/ai/permission.js`、`src/ai/providers/builtin.js`、Agent/provider/permission 测试。

- [ ] 增加 `engineering_repairs`、`repair_start`、`repair_get`、`repair_result`、`repair_cancel` schema 和执行分支。
- [ ] `repair_start` 只接受 `jobRef`，或 `workflowRunRef + nodeId`，以及 bounded note；mutually exclusive source 在 main 再校验。
- [ ] `repair_start` 风险映射为 write，`repair_cancel` 使用受控 mutation 风险；read-only/plan 模式不可启动。
- [ ] plan、explore、implement 子 Agent 移除 start/cancel；implement 进一步移除 repair history 查询，防止隔离 prompt 扩展。
- [ ] Agent cancel 校验 `agentRunId` owner；普通 Agent 不得取消 UI 或其它 run 启动的 repair。
- [ ] 工具返回只含 opaque refs、状态、计数、bounded errors 和 D5 summary；不返回 patch、note、prompt、完整日志或命令。
- [ ] repair 工具事件不进入聊天 history、usage、memory、hooks 或 export；必要状态通过 engineering repair event/UI 对账。
- [ ] 测试工具过滤、schema、风险、full-auto 边界、owner cancel、invalid refs、结果上限和事件脱敏。

验收点：模型可以请求“生成一份隔离修复”，但无法自行验证、应用、丢弃、创建 PR、push 或发起多候选循环。

## 10. Task 9 - 工程中心与 D5 结果复用

涉及：`src/renderer/index.html`、`src/renderer/app.js`、`src/renderer/styles.css`、`src/renderer/worktree-result-state.js`、`tests/renderer-engineering-ui.test.js`、renderer state/storage 测试。

- [ ] 在 D11 failed job 详情和 D12 failed node 详情增加生成修复入口；其它状态不显示或禁用。
- [ ] 增加 repair 确认面板：来源摘要、workspace/profile freshness、note、权限提示和取消；不展示可编辑命令/cwd/env/path。
- [ ] 增加 repair 列表与详情：attempt lineage、状态、时间、diagnosticCount、incomplete、错误、取消和 retry。
- [ ] 使用共享 renderer helper 关联同一个 D5 result，不嵌套或复制第二套 worktree 卡；capability 继续来自 authoritative worktree get/list。
- [ ] 增加显式 validate/validate-cancel 和 advisory 结果；failed/stale/timeout 文案不能表现为 apply gate。
- [ ] D5 result 处理/cleanup 后，repair 历史保留但 open/validate 禁用；来源 job/node 仍可定位。
- [ ] 监听 repair event 并用 list/get 对账丢失事件；切页、Agent stop、reload 不取消后台任务。
- [ ] localStorage 只保存 selected repairRef、排序和筛选；note、validation output、diagnostics、patch 和 result detail 保持内存态。
- [ ] 覆盖窄窗口、长 profile 名、长错误、按钮 loading/disabled、键盘焦点和现有 QQ 2007 工程中心视觉回归。

验收点：用户始终能看清“来源失败 -> repair attempt -> D5 patch -> 最近验证”的关联，但不存在两套冲突的 apply/PR 状态。

## 11. Task 10 - 隐私、恢复与全量回归

- [ ] 扫描 `engineering-repairs.json` 解密结构、renderer localStorage、session Markdown/JSON export、usage、memory、hooks、普通 Agent event 和应用日志。
- [ ] 断言 note、prompt、模型文本、diagnostics/logs、command/cwd/env、absolute path、patch/diff 和 token 不出现在禁止位置。
- [ ] 测试 safeStorage unavailable/corrupt 时 D11/D12/D5 仍可工作；repair 明确 memory-only 或 unavailable，不污染其它 store。
- [ ] 重跑 `tests/worktree*.test.js`、verification、workflow、engineering IPC、permission、provider、renderer 和 export 回归。
- [ ] 对所有新增/修改 JS 运行 `node --check`，运行 `npm test` 和 `git diff --check`。
- [ ] 确认 `package.json` 无新增 runtime dependency，README/阶段状态不提前宣称 D13 已交付。

## 12. 真实 Electron 验收

- [ ] D11 failed job -> repair -> diff -> validation -> D5 apply；确认主树在 apply 前 clean，apply 后 unstaged、HEAD 不变。
- [ ] D12 failed node -> repair；确认必须选择 node，且只重跑该节点 profile，不重跑 workflow。
- [ ] `read-only`、`confirm-writes`、`full-auto` 三种模式权限行为符合规格，full-auto 不自动交付。
- [ ] repair failed/cancelled/no_changes/ready 手动 retry；新旧 repair/result 关系和 source freshness 正确。
- [ ] validation passed/failed/timeout/cancel/stale/profile changed；所有结果 advisory，D5 apply/Draft PR 能力不被错误门禁。
- [ ] 运行中切页、停止普通 Agent、reload、关闭应用并重启；active 变 interrupted，D5 incomplete/ready 结果可恢复且不自动重跑。
- [ ] patch/marker/checkout Git metadata 篡改、主树变化、result cleanup 后验证都严格拒绝，无额外主树写入。
- [ ] 在 `1100x720`、`900x580` 和长中文/英文错误下检查列表、详情、note、诊断和 D5 控件无溢出或重叠。

## 13. 交付顺序与回滚

固定实施顺序：

```text
repair-state
  -> repair-store
  -> source resolver/context
  -> D5 implement helper + repair manager
  -> frozen-profile validation + checkout restore
  -> main/preload IPC
  -> Agent tools/permission
  -> renderer/D5 result association
  -> privacy/full regression
  -> Electron acceptance
```

每一步保持旧能力可用：

- repair manager 不可用时隐藏/禁用 repair 入口，D11 job、D12 workflow 和 D5 worktree 继续工作。
- source resolver 失败不能影响查看原 diagnostics 或 rerun D11/D12。
- validation helper 失败只禁用 repair validation，不得禁用 D5 patch 的原有动作，除非 D5 自身完整性校验也失败。
- renderer 回滚只移除 repair UI/API，不删除 D5 marker、D11 jobs、D12 runs 或项目文件。
- store schema 回滚保留损坏/新版本文件，不用旧代码空写覆盖；D5 unresolved result 仍可独立恢复。

## 14. Definition of Done

- [ ] D11/D12 只允许新鲜、同项目、同 profile/workspace fingerprint 的单个 failed 来源启动 repair。
- [ ] 每次 repair 在新的 D5 worktree 中运行受限 implement Agent，主工作区在用户交付前无变化。
- [ ] 每项目一个 active repair、一次一候选、手动 retry、新旧 attempt 只读关系和取消/中断恢复全部通过测试。
- [ ] repair result 完整复用 D5 diff/apply/discard/open/Draft PR/PR 生命周期，不复制 Git mutation 状态机。
- [ ] 显式 validation 只运行 frozen source profile，在同 repair worktree 中执行并恢复 patch 完整性；结果严格 advisory。
- [ ] sender ownership、Agent owner cancel、read-only/confirm-writes/full-auto 和 terminal approval 边界全部通过。
- [ ] safeStorage、memory-only、损坏保留、history pruning 和禁止位置明文泄漏测试全绿。
- [ ] `npm test`、相关 `node --check`、`git diff --check` 全部通过，无新增 runtime dependency。
- [ ] 真实 Electron 桌面覆盖 D11/D12 来源、权限、retry、validation、D5 apply/Draft PR、取消和重启恢复后，才能把 D13 标记为已交付。
