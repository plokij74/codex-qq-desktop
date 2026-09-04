# Phase D.13 - 验证失败隔离修复建议设计规格

**日期:** 2026-09-04
**项目:** `codex-qq-desktop`
**状态:** 设计草案，待评审
**前置:** Phase D.12 工程工作流自动化实现已完成；D5-D12 自动化回归和真实 Electron 桌面前置状态必须在实施前重新确认

## 1. 目标与范围

D13 把 D11 单 profile 验证和 D12 workflow 节点产生的失败结果转换为一份可审阅的修复建议。用户或主 Agent 显式选择失败来源后，main 在 D5 独立 Git worktree 中运行受限 implement Agent，收集完整 patch，并把结果交回已有 D5 结果卡处理。

修复建议不会直接修改主工作区。用户可以继续使用 D5/D6/D7 已有的 diff 预览、整批应用、丢弃、打开隔离目录、创建 Draft PR 和后续 PR 生命周期。修复生成完成后，用户还可以显式选择在同一个隔离 worktree 中只重跑原失败 profile；该结果仅供参考，不成为应用或创建 PR 的硬门槛。

D13 必须保持以下边界：

- 只接受状态仍为 `failed` 的 D11 job，或 D12 workflow 中状态仍为 `failed` 且拥有有效 D11 `jobRef` 的单个节点。
- workflow 来源必须同时提交 `workflowRunRef + nodeId`；不能对整个 workflow、多个节点或任意日志直接请求修复。
- renderer 和 Agent 只能提交 opaque ref 与一段有界纯文本补充说明；不能提交命令、cwd、路径、环境变量、profile 内容、模型配置或 worktree 参数。
- 修复始终在 D5 detached/locked worktree 中生成；非 Git、脏主工作区、HEAD 变化、D5 创建失败或来源过期时关闭失败，绝不回退直写主项目。
- 不自动应用、不自动 stage/commit/push/merge，也不自动创建 PR；`full-auto` 不能越过 D5 的用户显式交付动作。
- 不在验证失败时自动生成修复，不循环执行“修复 -> 验证 -> 再修复”，不并行生成多个候选。
- 修复后验证只由用户显式点击启动；验证失败、超时、取消或 stale 都不会禁用 D5 应用、Draft PR 或后续 PR 操作。
- 不把修复 prompt、补充说明、诊断正文、日志、patch 或模型过程写入聊天 history、usage、memory、hooks、session export 或普通 Agent event。
- 不增加 runtime dependency，不引入远程 CI、云端修复服务、代码执行沙箱或新的 Git 合并策略。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 功能归属 | main-owned `engineering repair manager`，按 canonical 项目目录管理活动尝试和历史 |
| 来源 | 单个 D11 `jobRef`，或 D12 `workflowRunRef + nodeId`；两者最终都解析为一个失败 D11 job |
| 来源新鲜度 | job、项目、profile fingerprint 和 workspace fingerprint 必须与当前状态一致；过期来源拒绝启动 |
| 生成隔离 | 每次尝试创建一个新的 D5 detached/locked worktree；不复用旧尝试或主 Agent 工作目录 |
| 生成 Agent | 复用 D5 implement 隔离工具面，只允许受控读取、`write_file` 和 `search_replace`；无 terminal、MCP、Skills、Hooks、web 或子 Agent |
| 模型与预算 | UI 请求使用 main 从当前 session 解析的 provider/model；Agent 请求复用当前 run；renderer/工具不能指定模型，单次固定为 implement 默认 6 turns、硬上限 12 |
| 并发 | 每个项目最多一个 active repair；单次请求只生成一个候选，不做 best-of-N |
| 重试 | 失败后只能手动重试；重试创建新的 `repairRef` 和新 worktree，旧尝试保持只读 |
| 补充说明 | 可选纯文本，最多 2,000 字符；只作为不可信上下文，不解析成命令或配置 |
| 结果交付 | 生成 patch 后复用 D5 authoritative result 与结果卡；D13 不复制 patch 状态机和 Git mutation |
| 修复后验证 | 用户显式启动，在同一 repair worktree 中只运行来源 profile；不重跑整个 workflow |
| 验证语义 | advisory；不作为 D5 apply、D6 Draft PR 或 D7 PR 动作的门禁 |
| 权限 | `read-only` 拒绝生成；`confirm-writes` 走 write 审批；`full-auto` 复用现有 write 策略；主树交付始终要求 D5 显式动作 |
| 持久化 | repair 元数据使用版本化 safeStorage envelope；safeStorage 不可用时仅当前进程内存，不创建明文 fallback |
| 事件 | 独立 `engineering:repair:event`/受控 Agent 摘要；不复用聊天消息、普通 Agent event 或 terminal transcript |

## 3. 用户闭环

```text
D11 failed job 或 D12 failed node
  -> 用户/Agent 显式选择“生成修复”
  -> main 校验 sender binding、source、profile 与 workspace fingerprint
  -> write PermissionGate
  -> D5 preflight + detached/locked worktree
  -> 受限 implement Agent 在隔离项目中生成一次修复
  -> D5 collect 完整 patch
       |-- 有变更: repair ready + 复用 D5 结果卡
       |-- 无变更: repair no_changes + 清理 worktree
       `-- 失败/取消/退出: 终态；有部分变更时保留 incomplete D5 结果

repair ready
  |-- 查看 diff / 打开隔离目录
  |-- 用户显式重跑来源 profile（advisory）
  |-- D5 整批应用或丢弃
  `-- D6 创建 Draft PR，之后沿用 D7 生命周期
```

“生成修复”和“验证修复”是两个独立显式动作。生成成功不会自动运行 profile；验证通过也不会自动应用 patch。主工作区在 D5 应用前保持不变。

## 4. 失败来源合同

### 4.1 输入形状

renderer 和 Agent 只允许使用以下二选一来源：

```js
{ kind: 'verification', jobRef: 'vfy_job_<24 hex>' }

{ kind: 'workflow', workflowRunRef: 'wf_run_<24 hex>', nodeId: string }
```

未知字段、同时提交两类 ref、空 `nodeId`、伪造格式、路径字段、profile 内容和命令字段必须拒绝。`nodeId` 最多 120 字符，只用于定位已持久化 workflow 节点，不被解释为路径或命令。

### 4.2 D11 job 来源

main 从 sender-owned `projectBindingId` 解析 canonical project path，然后读取 D11 authoritative job。启动前必须同时满足：

1. `jobRef` 属于当前 canonical 项目，状态严格等于 `failed`；`stale`、`timed_out`、`cancelled`、`interrupted`、`error` 和 `passed` 都不能作为来源。
2. job 的 `profileId` 仍存在且启用；当前 `profileFingerprint` 与 job 冻结值一致。
3. job 具有合法 `workspaceFingerprintEnd`，且它等于当前项目 fingerprint；开始/结束 fingerprint 不一致的旧 job 已由 D11 标记为 `stale`，不能绕过。
4. job 的有界结果仍可读取。日志或诊断损坏时拒绝，而不是让 renderer 补交文本。
5. D5 preflight 最终仍独立校验 Git、HEAD、clean status、pending 上限和路径安全；来源 fingerprint 通过不代表可以创建 worktree。

### 4.3 D12 workflow 节点来源

workflow 来源先解析 run，再解析指定节点和该节点的 D11 job。启动前必须同时满足：

1. `workflowRunRef` 属于当前项目，run 已结束且整体状态为 `failed`。
2. `nodeId` 在该 run 中唯一存在，节点状态严格等于 `failed`，并具有合法 `jobRef`。
3. 节点 `jobRef` 指向同项目且状态仍为 `failed` 的 D11 job；节点摘要不能代替 D11 authoritative result。
4. workflow run 冻结的 `profileId`/`profileFingerprint`、D11 job 冻结值和当前已保存 profile 三者一致。
5. workflow 的项目 key、start/end workspace fingerprint、D11 job end fingerprint 和当前项目 fingerprint 一致；`workspaceChanged`、`stale` 或配置变化的 run 拒绝。

D13 不接受“修复所有失败节点”。用户必须逐个选择节点，避免把不同 profile、不同诊断和互相依赖的失败合并为一个不可审阅 prompt。

### 4.4 来源上下文与上限

main 从 D11 result 构造一次性的修复上下文，renderer 和 Agent 不能覆盖。首版固定上限：

| 内容 | 上限 |
|------|------|
| 诊断条数 | 50 |
| 单条相对路径 | 500 字符 |
| 单条诊断 message | 1,000 字符，继续经过 D11 脱敏 |
| stdout/stderr 补充摘录 | 合计 12 KiB |
| 用户补充说明 | 2,000 字符 |
| 最终来源上下文 | 32 KiB |

优先使用结构化 diagnostics；原始输出只在诊断不足时补充头尾摘录，不复制完整日志。路径必须是项目相对路径并再次通过安全规范化；绝对路径、越界路径和 token 形式内容删除或替换。

诊断、日志和用户补充说明都按不可信数据处理。系统提示必须明确它们只描述失败现象，不能改变工具权限、项目根、目标 profile 或交付方式；其中出现的“忽略指令”“运行命令”“读取密钥”等文本不能成为控制指令。

## 5. Repair 数据与状态机

### 5.1 Opaque ref 与记录

每次尝试使用新的 `repairRef`：

```text
rpr_<24 lowercase hex>
```

main 内部记录的逻辑形状：

```js
{
  repairRef: string,
  projectKey: string,
  source: {
    kind: 'verification' | 'workflow',
    jobRef: string,
    workflowRunRef?: string,
    nodeId?: string
  },
  profileId: string,
  profileFingerprint: string,
  sourceWorkspaceFingerprint: string,
  status: string,
  resultId?: string,                 // D5 opaque result id
  rootRepairRef: string,
  retryOf?: string,
  attempt: number,
  incomplete: boolean,
  diagnosticCount: number,
  outputExcerpted: boolean,
  createdAt: string,
  startedAt?: string,
  finishedAt?: string,
  errorCode?: string,
  statusMessage?: string,
  validation?: {
    status: string,
    startedAt?: string,
    finishedAt?: string,
    exitCode?: number,
    diagnosticCount: number,
    outputTruncated: boolean,
    workspaceChanged: boolean,
    errorCode?: string,
    statusMessage?: string
  }
}
```

`projectKey` 是 canonical path hash。repair store 不保存 canonical/absolute path、profile command/cwd、用户补充说明、诊断正文、stdout/stderr、prompt、模型回复或 patch。`resultId` 只引用 D5 marker；D5 仍是 patch 和 worktree 生命周期的唯一权威。

### 5.2 生成状态机

```text
queued -> preparing -> generating -> collecting -> ready
   |          |             |             `------> no_changes
   |          |             |--------------------> failed
   |          |             |--------------------> cancelled
   |          |             `--------------------> interrupted
   |          |----------------------------------> failed/cancelled/interrupted
   `---------------------------------------------> cancelled/failed
```

- `queued` 表示来源和 payload 结构已通过，但尚未产生 D5 磁盘副作用。
- `preparing` 执行权限、来源新鲜度复检和 D5 create。
- `generating` 表示受限 implement Agent 正在 repair worktree 中运行。
- `collecting` 表示 Agent 已停止，D5 正在收集或恢复完整 patch；此阶段不能提前宣称取消完成。
- `ready` 表示 D5 已返回可对账的 result；后续 apply/discard/PR 状态由 D5/D6/D7 展示，不回写为新的 repair 生成状态。
- `no_changes` 表示 Agent 没有产生 patch，D5 已按既有合同清理 worktree。
- `failed`、`cancelled`、`interrupted` 为不可原地重跑的终态。

取消或应用退出发生在 Agent 已写入之后时，manager 继续沿用 D5 的 incomplete 收集原则。若能安全收集到部分 patch，repair 保持 `cancelled`/`interrupted`，同时带 `incomplete: true` 和 `resultId`；UI 必须明确标记为未完成结果，但仍由用户决定查看、应用、丢弃或创建 Draft PR。若无法证明结果完整性，保留 D5 现场并返回固定错误，不自动删除。

### 5.3 重试

`retry` 不修改旧记录。main 重新执行全部来源、新鲜度、权限和 D5 preflight，创建新的 `repairRef`、`resultId` 和 worktree：

```text
rpr_A (failed/cancelled/no_changes/ready)
  -> retry
rpr_B { retryOf: rpr_A, rootRepairRef: rpr_A, attempt: 2 }
```

旧尝试的 prompt、worktree 和 patch不会复制到新尝试。可选补充说明重新提交并只作用于新尝试。若主工作区已因应用旧 patch 而变化，旧失败来源通常会因 workspace fingerprint 不匹配而拒绝重试；用户应先产生新的验证失败记录。

### 5.4 验证状态

验证是 repair 下独立的单次状态，不改变生成终态：

```text
not_run -> queued -> running -> passed
                           -> failed
                           -> timed_out
                           -> cancelled
                           -> stale
                           -> interrupted
                           -> error
```

同一尝试同一时间最多一个 validation。再次验证会创建新的内部 validation run 并替换 repair 对外展示的“最近一次验证摘要”，旧验证日志不累积进 repair store。若需要完整诊断，使用 repair result 的有界即时结果；应用重启后只恢复最近一次摘要。

## 6. Main-owned Repair Manager

### 6.1 模块与依赖

建议新增：

| 路径 | 职责 |
|------|------|
| `src/ai/repair-state.js` | ref、记录规范化、状态转换、公开摘要、固定上限和错误整形 |
| `src/ai/repair-store.js` | safeStorage envelope、原子替换、损坏保留、history pruning 和 memory-only 降级 |
| `src/ai/repair-manager.js` | 来源解析、并发、D5 生命周期、受限 Agent、取消、重试、显式验证、恢复和事件 |

`repair-manager` 通过依赖注入使用现有 verification manager、workflow manager、worktree manager、Agent run loop、PermissionGate 和 settings。它不复制 Git 命令、diagnostic parser、profile 规范化、workflow 解析或 D5 marker 状态机。

### 6.2 生成运行时

为避免出现第二套“看起来像 implement、实际权限不同”的实现，D13 从 `subagent-runtime.js` 提取一个 main-internal 的受限 implement 执行入口。该入口必须继续满足 D5 的 defense-in-depth：

- child project 固定为 `handle.childProjectPath`，不能由 IPC、模型或补充说明提供。
- 创建全新的 isolated Gate，不继承 parent/session `allow_session` 或 full-auto 的广泛能力。
- 工具面只包含 `list_dir`、`read_file`、`grep`、`glob`、`git_status`、`git_diff`、`write_file`、`search_replace`。
- 禁止 terminal、`verification_start`、`workflow_start`、repair 工具、Git mutation、MCP、Skills、Hooks、web、memory 和再次 spawn。
- 不加载聊天 history、memory 注入或普通 session transcript；修复目标只来自 main 构造的有界上下文。
- 模型的 `fileChanges`、token 过程事件和文本回复不进入父聊天；repair manager 只消费终止原因并调用 D5 collect。

D5 marker 中的 `goal` 使用固定脱敏标签，例如“修复验证失败”，不能写入诊断、日志或用户补充说明。`subagentId` 可以使用 `repairRef` 作为关联标识，但它不是安全 owner。

UI 启动时，main 根据当前 sender 的 session/project 关联解析已经选定的 provider、model 和受信 credential；Agent 工具启动时复用当前 run 已解析的相同上下文。IPC、preload 和工具参数都不允许提交 provider、model、base URL、token 或 `maxTurns`。缺少可用 session/model 时返回 `REPAIR_AGENT_UNAVAILABLE`，不创建 worktree。

单次 repair 使用现有 implement 默认 6 turns，并硬限制在 12 turns 内。D13 不提供用户可调的 turn 数、并行候选或自动续跑；到达上限后进入正常 collect，若已有改动则以 `incomplete: true` 交付。

### 6.3 并发和所有权

- 每个 canonical project 同时最多一个状态为 `queued/preparing/generating/collecting` 的 repair。
- 同一项目的 validation 与新的 repair 生成互斥，避免同时操作同一个 D5 worktree 或争用 terminal/profile 状态。
- D13 不提供批量、多候选或自动 fan-out；跨项目仍受现有主进程 Agent/terminal 资源上限约束。
- renderer 启动的尝试属于项目，不属于某条可伪造 session；`sessionId` 仅用于 UI 关联。
- Agent 只能取消由当前 Agent run 启动且仍 active 的尝试；用户 UI 可以取消当前绑定项目的 active 尝试。

### 6.4 取消、退出与恢复

取消先阻止新的 Agent turn，再 abort 当前 repair run。若已经创建 worktree，必须等待或安排 D5 collect/cleanup 对账，不能把“abort 已发送”当成最终取消。

应用退出时：

- `queued/preparing/generating/collecting` repair 标记 `interrupted`，绝不在重启后自动恢复模型生成。
- active validation 标记 `interrupted`，不自动重跑 profile。
- 已存在 D5 worktree 由 D5 `recover/list` 继续对账；repair startup reconcile 只关联合法 `resultId`，不能凭 repair store 中的 ref 删除目录。
- 若 D5 恢复出 incomplete patch，repair 保持 `interrupted` 并展示可审阅结果；若 marker 缺失或被篡改，展示固定错误和恢复警告。
- `ready/no_changes/failed/cancelled/interrupted` 历史可以恢复，但补充说明、prompt 和即时日志不会恢复。

## 7. D5 Worktree 复用合同

### 7.1 创建与收集

repair manager 调用现有 manager：

```js
worktreeManager.create({
  project,
  sessionId,
  subagentId: repairRef,
  goal: '修复验证失败'
})

worktreeManager.collect(handle, { incomplete })
```

D13 不自行选择目录、执行 `git worktree add`、生成 patch、计算 hash 或操作 marker。D5 返回的 `resultId`、base HEAD、expected tree、patch hash、文件摘要、锁和 conflict 状态保持原合同。

### 7.2 结果交付

repair `ready` 后，renderer 根据 `resultId` 使用已有 worktree list/get/preview/apply/discard/open/PR API。D13 只增加来源和最近验证摘要，不复制 D5 卡片按钮或实现新的 apply IPC。

以下行为保持不变：

- diff 按需读取，不进入 localStorage 或 repair store。
- apply 前重新检查主仓 HEAD、clean status、patch hash、expected tree 和路径安全。
- Draft PR 从 D5 stored patch 重建精确 commit，不直接提交验证后的 checkout 杂项。
- apply/discard/PR cleanup 完成后可删除 worktree；repair 历史只保留失效的 `resultId` 和“结果已处理”摘要。
- repair validation 不是 D5 capability 的输入；验证失败不会把 `canApply` 或 `canCreatePr` 改为 false。

### 7.3 验证期间的 checkout 完整性

验证命令可能生成文件，甚至意外修改 tracked 文件或 Git index。D13 必须通过 worktree manager 的 main-internal helper 执行以下闭环，而不是从 repair manager 拼接 Git 命令：

1. 校验 result 仍属于当前项目，状态允许验证，patch bytes/hash、base HEAD、expected tree、registration、detached/locked 和 common dir 均有效。
2. 从 stored patch 确认 repair checkout 的 index tree 等于 expected tree。
3. 在 `childProjectPath` 运行冻结 profile。
4. 捕获 D11 同等的有界输出、诊断、exit code、timeout 和前后 fingerprint。
5. 验证结束后，从 `baseHead + stored patch` 恢复 repair checkout 的 staged tree，清理验证产生的非 ignored 临时变更，并再次校验 patch/hash/expected tree。
6. 若 Git metadata、patch 或 worktree 无法安全恢复，返回 `REPAIR_PATCH_CHANGED`/D5 固定错误，保留现场并禁用再次验证；不能把未知状态报告为通过。

恢复只作用于 D5 隔离目录，不触碰主工作区。ignored 构建缓存不属于 patch；若无法安全清理，可保留到 D5 最终 cleanup，但不得进入 diff、apply 或 PR commit。

## 8. 修复后显式验证

### 8.1 Profile 解析

validation 请求只含 `repairRef`。main 从 repair 记录获取 `profileId/profileFingerprint`，再从原项目当前 settings 解析 profile。以下任一条件失败时不运行命令：

- repair 没有可验证的 D5 result，或 worktree 已 apply/discard/cleanup/PR cleanup。
- 当前 profile 不存在、被禁用或 fingerprint 与来源不一致。
- D5 patch、marker、worktree registration、HEAD 或 expected tree 校验失败。
- `terminalEnabled` 关闭、权限审批未通过、同项目已有 repair/validation 或应用正在退出。

renderer、Agent 和 repair store 都不能提供 command/cwd/timeout。建议在 verification manager 增加 main-internal `runFrozenProfile` 接口：输入原项目、隔离 execution root、`profileId + expectedFingerprint` 和权限上下文；manager 自己解析当前 profile，并把相对 cwd 重新锚定到 repair worktree。

### 8.2 权限与输出

validation 继续使用 D11 terminal 风险、危险命令拦截、profile grant、timeout、abort、diagnostic parser 和脱敏。用户点击“验证修复”是启动意图，但不会绕过首次或 profile fingerprint 变化后的 terminal 审批。

validation 不创建普通 D11 `jobRef`，不进入 D11 job history，也不回写 D12 workflow run。它返回 repair-owned ephemeral result：

```js
{
  ok: boolean,
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'stale' | 'interrupted' | 'error',
  exitCode?: number,
  stdout: string,              // D11 上限和脱敏
  stderr: string,
  diagnostics: Diagnostic[],
  diagnosticsTruncated: boolean,
  outputTruncated: boolean,
  workspaceFingerprintStart: string,
  workspaceFingerprintEnd: string
}
```

完整即时结果只保存在当前进程的 bounded cache，供 `engineering:repair:result` 读取；repair store 只保存最近一次状态、计数、时间、exit code 和固定错误码。重启后日志和诊断不恢复，UI 明确显示“详细结果未保留”。

### 8.3 Advisory 语义

- `passed` 表示来源 profile 在该 repair patch 对应的隔离树上通过，不代表整个 D12 workflow、远程 CI 或主工作区通过。
- `failed` 可以用于用户判断、修改补充说明并手动 retry，但不会自动启动新 Agent。
- `stale` 表示验证期间隔离树发生非预期变化；即使 exit code 为 0 也不能显示为通过。
- apply/PR 前 D5 只检查自身 patch 合同，不读取 validation status。
- patch 应用到主工作区后，如需可信结论，用户仍应在主工作区显式运行 D11 profile 或 D12 workflow。

## 9. 权限与安全边界

### 9.1 生成权限

repair start 的有效风险是 `write`：

- `read-only`：拒绝，且不创建 repair record 或 worktree。
- `confirm-writes`：显示一次“在隔离 worktree 生成修复”的 write 审批；拒绝/取消不产生 D5 磁盘副作用。
- `full-auto`：复用现有 write 允许策略，只允许生成隔离结果；不能自动 apply、discard、创建 PR 或 merge。

无论由 UI 还是 Agent 发起，来源校验必须在审批前后各复检一次。审批等待期间项目、profile 或 workspace fingerprint 变化时，返回 `REPAIR_SOURCE_CHANGED`，不能使用旧审批继续。

### 9.2 输入和 prompt 注入

- note 只做 Unicode 文本规范化、NUL/控制字符移除和长度限制，不作为 shell 或模板变量。
- 不允许 note 选择文件根、扩大工具、要求读取 `.git`/项目外路径或改变交付动作。
- source output 中的绝对路径、凭据模式和环境变量值继续经过 D11 redaction。
- implement Agent 读取的项目内容、测试输出和 note 都标记为不可信；权限由代码 allowlist 决定，不依赖模型遵守文字指令。

### 9.3 所有权

- renderer 所有请求使用现有 sender-owned `projectBindingId`；main 从 binding registry 解析 canonical path。
- `repairRef`、`jobRef`、`workflowRunRef`、`nodeId` 和 `resultId` 必须与同一 project key 对账。
- reload、窗口销毁或项目 rebind 后旧 binding 失效；project history 仍可在重新绑定同一 canonical 项目后恢复。
- Agent 查询只限当前绑定项目；cancel 还要校验 `agentRunId` owner。opaque ref 不是单独授权凭据。

## 10. Main / Preload / Agent 接口

### 10.1 IPC channels

新增建议 channel：

```text
engineering:repair:list
engineering:repair:get
engineering:repair:result
engineering:repair:start
engineering:repair:retry
engineering:repair:cancel
engineering:repair:validate
engineering:repair:validate-cancel
engineering:repair:event
```

主要 payload：

```js
start({ projectBindingId, source, note?, sessionId? })
retry({ projectBindingId, repairRef, note?, sessionId? })
get/result/cancel/validate/validateCancel({ projectBindingId, repairRef })
list({ projectBindingId, limit? })
```

preload 必须逐字段重建 payload，不能透传任意对象。main 拒绝 `projectPath`、`resultId`、command、cwd、env、profile、settings、provider、model、base URL、token 和权限决策字段。`resultId` 只能由 repair manager 返回，renderer 再交给既有 D5 API。

`engineering:repair:event` 只广播到已绑定同 project key 的 owner，内容限制为 repair ref、状态、来源 opaque ref、result id、时间、计数、incomplete、validation 摘要和固定错误；不包含 note、prompt、日志、diagnostic message、patch、路径或模型文本。

### 10.2 Agent tools

新增：

- `engineering_repairs`：列出当前项目 bounded repair 摘要。
- `repair_start`：接受 D11 `jobRef`，或 D12 `workflowRunRef + nodeId`，以及可选 `note`。
- `repair_get`：读取状态、来源摘要、D5 result id 和最近 validation 摘要。
- `repair_result`：读取 bounded 即时 validation 结果和 D5 结果摘要；不返回 patch 正文。
- `repair_cancel`：取消当前 Agent run 在当前项目启动的 active repair。

Agent 不提供 `repair_validate`。修复后执行 profile 必须由用户在工程中心或结果卡显式点击，防止模型自行形成未受控的修复循环。

plan、explore 和 implement 子 Agent 不注册 `repair_start`/`repair_cancel`；implement 子 Agent也不注册 repair 查询，避免把外部工程历史注入隔离生成。主 Agent 的只读查询仍按项目和结果上限裁剪。

## 11. 工程中心与结果卡

工程中心在 D11 verification job 和 D12 workflow node 的失败详情增加“生成修复”命令。点击后显示一个轻量确认面板：来源 profile、失败时间、diagnosticCount、workspace 新鲜度、可选补充说明和权限状态；不展示或允许编辑命令、cwd、env 或 worktree 路径。

新增 repair 列表/详情应提供：

- 来源类型、profile 名称、attempt、状态、时间、diagnosticCount、错误摘要和 retry 关系。
- active 尝试的取消；终态失败/取消/no_changes/ready 的手动 retry。
- `ready` 或带 incomplete result 的尝试关联现有 D5 结果卡，使用同一套 diff、apply、discard、open 和 Draft PR 控件。
- worktree 仍可用时显示“验证修复”；运行中显示取消，结束后显示 advisory 状态和 diagnostics 定位。
- D5 result 已处理或清理后，保留 repair 历史但禁用 open/validate，并显示“隔离结果已处理”。
- 来源 job 和 workflow node 的返回定位；diagnostic 点击继续复用 D11 项目相对路径定位。

repair 卡不能嵌套复制一张 D5 卡。实现应以关联区或共享 renderer helper 渲染同一个 authoritative worktree result，避免两个组件对同一 result 显示不一致 capability。

切换聊天、停止普通 Agent 或离开工程中心不会取消后台 repair；关闭应用按 `interrupted` 处理。窄窗口使用现有工程中心紧凑列表和详情布局，不增加画布、向导或营销式页面。

## 12. 持久化、历史与隐私

建议使用 Electron `userData`：

```text
engineering-repairs.json
```

文件使用版本化 safeStorage envelope、同目录临时文件、原子 replace 和损坏保留。safeStorage 不可用时 repair manager 只保留当前进程内存，UI 显示“仅当前进程”，不得创建明文 JSON fallback。

历史上限：每项目最多 50 个 repair attempt，全局最多 200 个。清理优先最旧终态记录，不删除 active repair，不调用 D5 cleanup，也不删除仍未处理的 D5 result。若某条 repair 因历史裁剪消失，其 D5 result 仍可由 D5 项目列表独立恢复。

允许持久化：

- opaque refs、project key、source kind、profile id/fingerprint、workspace fingerprint；
- repair/validation 状态、attempt 关系、时间、exit code、计数、布尔标志和固定错误码；
- D5 result id，以及 safeStorage 可用/损坏状态。

禁止持久化到 repair store：

- canonical/absolute path、profile command/cwd/env；
- 用户 note、prompt、模型输入/输出、聊天内容；
- stdout/stderr、diagnostic message、源码、diff、patch、文件 snippet；
- token、API key、provider credential、MCP payload、Hooks 环境或 PR 正文。

D5 已有项目内 `.codex/worktrees/<resultId>` artifact 继续保存 patch 和 marker，这是 D5 的既有显式隔离结果，不复制进 `engineering-repairs.json`。renderer localStorage/session 只允许保存选中的 opaque `repairRef`、排序和筛选；repair history 以 main store 为权威。

## 13. 固定错误码

```text
REPAIR_PROJECT_BINDING_INVALID
REPAIR_INVALID
REPAIR_NOT_FOUND
REPAIR_ALREADY_RUNNING
REPAIR_SOURCE_INVALID
REPAIR_SOURCE_NOT_FAILED
REPAIR_SOURCE_CHANGED
REPAIR_SOURCE_NOT_FOUND
REPAIR_PROFILE_NOT_FOUND
REPAIR_PROFILE_DISABLED
REPAIR_PROFILE_CHANGED
REPAIR_WORKSPACE_CHANGED
REPAIR_READ_ONLY
REPAIR_APPROVAL_REQUIRED
REPAIR_APPROVAL_CANCELLED
REPAIR_WORKTREE_CREATE_FAILED
REPAIR_AGENT_UNAVAILABLE
REPAIR_GENERATION_FAILED
REPAIR_COLLECT_FAILED
REPAIR_NO_CHANGES
REPAIR_CANCEL_FAILED
REPAIR_INTERRUPTED
REPAIR_RESULT_NOT_FOUND
REPAIR_RESULT_UNAVAILABLE
REPAIR_PATCH_CHANGED
REPAIR_VALIDATION_RUNNING
REPAIR_VALIDATION_UNAVAILABLE
REPAIR_VALIDATION_CANCEL_FAILED
REPAIR_TERMINAL_DISABLED
REPAIR_STORE_CORRUPT
REPAIR_STORE_UNAVAILABLE
```

当底层 D5/D11 返回更精确的固定错误时，public response 可以同时带 `causeCode`，但 `error` 必须 bounded、脱敏，不包含命令、绝对路径、patch、日志、环境变量、token 或模型文本。

## 14. 测试与验收

### 14.1 自动化测试

1. repair ref、payload、状态迁移、retry lineage、公开摘要、history 上限和未知字段拒绝。
2. D11 来源：跨项目、非 failed、stale、profile 删除/禁用/修改、workspace fingerprint 变化和损坏结果全部拒绝且无 worktree 副作用。
3. D12 来源：缺 nodeId、节点不存在、节点非 failed、jobRef 缺失/伪造、run/job/profile/project/fingerprint 不一致全部拒绝。
4. context builder：diagnostics/output/note 上限、路径相对化、secret redaction、控制字符、prompt injection 文本和不持久化正文。
5. 权限：read-only、confirm-writes allow/deny/cancel、full-auto 只生成、审批等待期间来源变化和主树绝不提前写入。
6. D5 create/collect：clean Git、dirty base、非 Git、pending cap、无变更、文本/新增/删除/rename/binary、oversize、patch tamper 和 collect failure。
7. implement runtime：只用 D5 allowlist、child root 正确、无 terminal/MCP/Skills/Hooks/web/subagent、无聊天/history/memory 注入、父 `fileChanges` 不合并。
8. 取消/退出：preparing、generating、collecting、validation 各阶段；partial patch 以 incomplete result 保留；重启不自动续跑。
9. retry 创建新 repair/worktree，旧记录只读；来源或主工作区变化时重新拒绝。
10. validation：只解析 frozen profile，在同一 worktree 运行；terminal gate、timeout、cancel、diagnostics、stale、profile changed 和 result 已清理。
11. validation 前后 patch/hash/expected tree 对账；profile 写 tracked/untracked/index/HEAD 或篡改 `.git` 时安全恢复或 fail-closed，主工作区不变。
12. advisory：validation failed/timed_out/stale 不改变 D5 `canApply/canCreatePr`，D5 apply/PR 仍只以自身合同判定。
13. IPC sender ownership、preload payload 重建、Agent owner cancel、项目事件路由、窗口销毁和 rebind。
14. privacy：repair store、localStorage、session export、usage、memory、hooks、普通 Agent event 和日志中无 note、prompt、diagnostic、command、路径、patch 或 token。
15. D5-D12 全量回归；旧 `spawn_implement`、D11 verification、D12 workflow/gate、D6 Draft PR 和 D7 PR 生命周期不变。

### 14.2 真实 Electron 桌面验收

- 从 D11 失败 job 生成修复，确认主工作区在 D5 应用前保持 clean，diff 卡可预览/打开/丢弃/应用。
- 从 D12 失败节点生成修复，确认必须选择 node，且 source job/profile/fingerprint 正确定位。
- 分别在 `read-only`、`confirm-writes`、`full-auto` 验证生成权限；确认 full-auto 仍不能自动应用或创建 PR。
- 提交补充说明，确认只影响本次尝试；重试得到新的 repair/result，旧尝试仍可查看。
- 显式验证 repair，覆盖 passed、failed、timeout、cancel 和 profile 修改；确认失败不阻止 apply/Draft PR。
- 在 repair/validation 运行期间切页、停止普通聊天 Agent、关闭并重启应用，确认不自动重跑且 incomplete/D5 结果可恢复。
- 人为修改主工作区、profile、D5 patch/marker 和 repair checkout Git 状态，确认严格拒绝且无主树额外副作用。
- 扫描 localStorage、session export、memory、usage、hooks、日志、普通聊天消息和 `engineering-repairs.json` 解密后结构，确认隐私边界。

## 15. 非目标与后续阶段

- D13 不自动观察所有失败、不在 workflow 中增加 repair node、不把 validation 变成 D12 gate。
- D13 不提供多候选排名、模型辩论、自动 retry、自动修复循环或跨项目 patch。
- D13 不允许用户编辑 patch、逐文件应用、自动解决冲突或绕过 D5 clean-base 合同。
- D13 不自动安装依赖、修改 verification profile、创建临时命令、读取远程 CI 日志或触发云端执行。
- D13 不承诺修复正确；它交付的是隔离、可审阅、可显式验证的建议。

后续阶段可以单独评估：把远程 CI 失败映射为可信来源、允许用户选择多个独立候选、或在显式预算与审批下执行多轮 repair loop。任何扩展都必须重新设计命令来源、成本上限、取消恢复、patch ownership 和隐私合同。

## 16. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-04 | 初版：锁定 D11/D12 单失败来源、D5 worktree 隔离生成、一次一候选、手动 retry、显式 advisory validation、safeStorage 历史与事件隔离 |
