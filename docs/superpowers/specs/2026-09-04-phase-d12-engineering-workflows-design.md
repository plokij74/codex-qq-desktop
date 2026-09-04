# Phase D.12 - 工程工作流编排与本地门禁设计规格

**日期:** 2026-09-04  
**项目:** `codex-qq-desktop`  
**状态:** 设计草案，待评审  
**前置:** Phase D.11 工程索引与后台验证已完成自动化实现；D5-D11 的安全与所有权回归仍需作为实施前置

## 1. 目标与范围

D12 把 D11 的单个验证 profile 提升为可重复的本地工程工作流。用户可以把已有的 `typecheck`、`test`、`build` 等 profile 组合成有向无环图（DAG），在工程中心或 Agent 中显式启动，并获得可恢复、可取消、可审计的整体结果。

本阶段同时提供一个只读的本地门禁合同，让 D5 worktree 应用、D6 Draft PR 创建和 D7 PR 合并可以在用户明确选择后要求某个工作流通过。门禁只验证同一项目、同一配置和同一工作区快照，不替用户提交、推送或合并。

D12 必须保持以下边界：

- 工作流节点只能引用当前项目已保存且启用的 D11 verification profile；不接受命令、cwd、环境变量、解释器或项目路径。
- 只允许用户或 Agent 显式启动；不在保存文件、写入完成、push、页面打开或定时器触发时自动运行。
- 不增加 runtime dependency，不引入 Tree-sitter、LSP、云端 CI 或远程执行服务。
- 不实现自动修复、自动提交、自动 push、自动合并、自动删除分支或无人值守审批。
- 工作流直接运行当前工作树；不创建新的快照或 worktree。工作区在运行期间发生变化时，结果不能被当作通过。
- 保留 D11 的单 profile 权限、命令拦截、terminal 开关、超时、诊断解析和 safeStorage 降级行为。
- 不改变旧的 `verifyCommand` 软验证语义；没有工作流配置时，现有聊天和手动验证行为不变。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 编排归属 | main-owned `engineering workflow manager`，按 canonical 项目目录复用实例 |
| 工作流形状 | 最多 32 个节点、64 条依赖边、最大深度 16；必须是 DAG |
| 节点类型 | 仅 `verification profile`；profile 指纹在启动时冻结 |
| 调度 | 依赖满足后运行；默认每个工作流最多 4 个并行节点，仍受 D11 验证 manager 的项目/全局并发上限约束 |
| 失败策略 | 默认 fail-fast；`continueOnFailure` 只允许指定节点在失败依赖后继续，最终仍为失败 |
| 启动方式 | 工程中心按钮、聊天明确命令或受控 Agent 工具；不提供后台定时触发 |
| 工作区快照 | 启动和每个节点结束记录 fingerprint；开始后任何文件变化令本次 run 进入 `stale` |
| 重跑 | 只允许重新创建完整 run；不在旧 run 中混合新 profile 或续跑已通过节点 |
| 持久化 | workflow 定义、run 元数据和节点引用使用版本化 safeStorage envelope；不可用时仅当前进程内存 |
| 历史 | 每项目最多保留 50 个 workflow run，全局最多 200 个；删除只清理元数据，不删除项目文件 |
| 门禁 | D5/D6/D7 通过显式 `workflowRunRef` 选择已通过 run；同项目、配置指纹和工作区 fingerprint 必须匹配 |
| Agent 面 | 只暴露列出、查询、启动、取消和结果摘要；启动只接受 opaque `workflowId`，不接受节点或 profile 内容 |

## 3. 工作流定义

### 3.1 数据形状

工作流定义按项目保存，renderer 只看到脱敏摘要。main 内部规范化后的形状如下：

```js
{
  workflowId: string,          // 随机 opaque id，不使用名称作为引用
  name: string,                // 1-80 字符，纯文本
  enabled: boolean,
  failFast: boolean,           // 默认 true
  maxParallel: number,         // 1-4
  timeoutMs: number,            // 1 分钟-24 小时
  nodes: [{
    nodeId: string,            // 同一 workflow 内唯一
    profileId: string,         // D11 profile opaque id
    dependsOn: string[],
    continueOnFailure: boolean
  }],
  createdAt: number,
  updatedAt: number,
  revision: number
}
```

renderer 提交时只允许 `name`、`enabled`、`failFast`、`maxParallel`、`timeoutMs` 和节点的 `nodeId`、`profileId`、`dependsOn`、`continueOnFailure`。未知字段、重复 id、自依赖、环、孤立 profile、超限值和不存在/禁用 profile 都返回稳定错误。

工作流保存时记录 `workflowFingerprint`。它由规范化定义计算，不包含命令正文、环境变量或绝对路径。profile 的命令、cwd、timeout 或 enabled 状态变化会使引用该 profile 的新 run 拒绝启动，旧 run 保留原有快照并以 `configuration_changed` 结束。

### 3.2 图校验与排序

保存和启动都重新校验 DAG。拓扑排序使用稳定的 `nodeId` 次序，保证相同定义得到相同调度顺序。依赖边只能指向同一 workflow 的节点；不允许通过 profile 名称或路径隐式建立依赖。

启动前先解析全部 profile，并冻结每个节点的 `profileFingerprint`。任一 profile 不存在、被禁用或指纹与当前定义不一致时，整个 run 不排队，不执行任何命令。

### 3.3 示例工作流

一个常见的本地门禁可以定义为：`typecheck` 为根节点；`test` 和 `build` 都依赖 `typecheck`，彼此可以并行；`package` 同时依赖 `test` 和 `build`。工作流只保存这些 profile 的 opaque id 和依赖关系，不复制任何命令：

```text
typecheck
  |-- test ----|
  |-- build ---|--> package
```

`failFast=true` 时任一节点失败会取消尚未完成的其它节点；`failFast=false` 时无关分支继续运行。节点的 `continueOnFailure=true` 只表示该节点在 `failFast=false` 且依赖存在失败/取消时仍可运行，它不会改变全局失败结果，也不会把 `skipped` 当作通过。

## 4. 运行时状态机

### 4.1 Workflow run

```text
queued -> running -> passed
                  -> failed
                  -> cancelled
                  -> timed_out
                  -> stale
                  -> interrupted
                  -> configuration_changed
```

`queued` 只表示已通过配置和权限预检。`running` 至少有一个节点正在运行。所有节点通过才是 `passed`；任一不可继续的节点、超时、取消、进程退出或配置变化都会使整体 run 进入对应终态。终态不可被原地重写，重跑创建新的 `workflowRunRef`。

### 4.2 Node run

```text
pending -> ready -> running -> passed
                         -> failed
                         -> cancelled
                         -> timed_out
                         -> stale
                         -> interrupted
                         -> skipped
```

依赖节点全部 `passed` 后才变为 `ready`。依赖失败时，节点默认为 `skipped`；无关分支是否继续由工作流的 `failFast` 决定，而不是由某个节点的 `continueOnFailure` 决定。`skipped` 不等于通过。

更具体地说，`continueOnFailure` 只作用于该节点自己的依赖：当 `failFast=false` 且它的一个或多个依赖为失败/取消时，该节点可以进入 `ready`；依赖为 `stale`、`timed_out`、`interrupted` 或 `configuration_changed` 时仍然不得继续。工作流的最终状态仍为失败或对应的非通过终态。

工作流 manager 通过 D11 verification manager 启动节点，不复制终端实现。每个节点只持有 D11 的 opaque `jobRef`、状态、退出码、diagnosticCount 和有限摘要。stdout/stderr、诊断正文仍由 D11 的结果接口按需读取，不写入 workflow history。

### 4.3 快照与 stale

启动时记录 `startWorkspaceFingerprint`。节点排队前和结束后都检查当前项目 fingerprint：

- 未启动节点发现变化时不执行，标记 `stale`，并取消可取消的兄弟节点。
- 已运行节点完成后发现变化时，其结果可展示但标记 `stale`，工作流不能为 `passed`。
- 变化发生在用户主动取消之后，最终状态仍为 `cancelled`，但结果摘要带 `workspaceChanged: true`。
- profile 指纹变化不重绑当前 run；运行中的节点完成后，剩余节点进入 `configuration_changed`。

fingerprint 只保存 size/mtime/hash 等脱敏元数据，不保存源码正文。门禁复用相同 fingerprint 合同，不能只比较时间或 workflow 状态。

## 5. 调度、取消与恢复

### 5.1 调度限制

每个项目最多一个 active workflow run；全局最多两个 active workflow run。单个 run 的 `maxParallel` 不超过 4，实际并行数取工作流设置、项目上限和 D11 verification manager 可用槽位的最小值。

调度器禁止递归启动工作流，也不允许 workflow 节点调用 Agent、MCP、Hooks 或另一个 workflow。D11 profile 的 terminal permission gate 对每个实际节点继续生效；`full-auto` 也不能绕过首次或指纹变化授权。

### 5.2 取消和超时

取消 workflow 会先阻止新的节点进入 `running`，再向所有 active D11 job 发送 abort。远端/子进程未能及时停止时，节点保持 `running` 直到 D11 的终止结果返回，不能提前伪装为 `cancelled`。总超时到达后走相同流程，最终为 `timed_out`。

### 5.3 应用退出和重启

退出时 active workflow 和 active node 标记为 `interrupted`，不自动重新执行命令。启动后只恢复定义、终态 run 和中断摘要；用户必须点击“重跑”创建新 run。恢复失败或 envelope 损坏不影响 D11 profile、index 或旧聊天数据。

## 6. 本地门禁合同

### 6.1 门禁检查

门禁是 main 内部的纯检查接口：

```js
checkWorkflowGate({
  projectPath,              // 只接受 main 已绑定的 canonical 路径
  workflowRunRef,
  action: 'apply' | 'create_pr' | 'merge',
  expectedFingerprint       // D5/D6/D7 调用方提供的目标快照
}) => {
  ok: boolean,
  reason?: 'WORKFLOW_NOT_PASSED' |
           'WORKFLOW_STALE' |
           'WORKFLOW_PROJECT_MISMATCH' |
           'WORKFLOW_CONFIG_CHANGED' |
           'WORKFLOW_FINGERPRINT_MISMATCH' |
           'WORKFLOW_RUN_NOT_FOUND',
  summary: { workflowRunRef, completedAt, nodeCount, passedCount }
}
```

检查必须同时满足：run 是 `passed`、项目 binding 一致、workflow/profile 指纹未变化、run 结束 fingerprint 与调用方 expected fingerprint 一致。D5/D6/D7 的实际 mutation 仍由各自 manager 执行，门禁失败时不得产生 apply、commit、push 或 merge 副作用。

门禁默认关闭以保持旧行为兼容。用户在工程中心为动作选择 workflow 后，D5/D6/D7 卡片显示绑定的 run；run 过期或工作区变化后必须重新运行。`full-auto` 不得自动选择 workflow 或自动通过门禁。

### 6.2 竞态处理

门禁检查和目标动作之间必须在 main 使用同一项目锁再次确认 fingerprint。若检查后工作区、PR head 或 worktree marker 改变，动作返回冲突且不重放。门禁不保存命令、patch、PR 正文、评论或 token。

## 7. Main / Preload / Agent 接口

### 7.1 IPC channels

新增建议 channel：

```text
engineering:workflow:list
engineering:workflow:get
engineering:workflow:save
engineering:workflow:delete
engineering:workflow:run
engineering:workflow:runs
engineering:workflow:result
engineering:workflow:cancel
engineering:workflow:rerun
engineering:workflow:gate-check
engineering:workflow:event
```

所有请求使用现有 sender-owned `projectBindingId`。renderer 不得提交 `projectPath`、命令、cwd、环境变量、绝对文件路径、D11 `jobRef` 所有者或别的项目的 workflow id。`gate-check` 只返回布尔结果和固定原因，不执行动作。

### 7.2 Agent tools

新增只读/受控工具：

- `engineering_workflows`：列出当前项目启用 workflow 的脱敏摘要。
- `workflow_start({ workflowId })`：启动已保存 workflow；风险为 `terminal`，只接受 workflow id。
- `workflow_get({ workflowRunRef })`：查询状态、节点摘要和有界计数。
- `workflow_result({ workflowRunRef })`：读取 bounded 节点结果引用和诊断计数，不返回绝对路径或完整命令。
- `workflow_cancel({ workflowRunRef })`：取消当前项目中由该 Agent run 启动的 workflow。

plan、explore 和 implement 子 Agent 不注册 `workflow_start` / `workflow_cancel`。Agent 不能创建、修改、删除 workflow，也不能调用 gate-check 触发 D5/D6/D7 动作。启动授权复用 D11 terminal risk；事件不进入聊天历史、usage、memory 或 session export。

## 8. 工程中心 UI

工程中心在现有 D11 页面上增加两个区块：

- 工作流列表：名称、节点数、启用状态、并行/超时配置、编辑、复制、删除和显式运行。
- 运行详情：整体状态、开始/结束时间、workspace stale/configuration changed 警告、DAG 节点状态、每个节点对应的 D11 job、取消、重跑和结果定位。

工作流编辑器采用窄窗口可用的表单和依赖下拉框，不引入画布编辑器。保存前在 renderer 做轻量提示，main 做最终 DAG 校验。节点结果点击后打开已有验证诊断定位；不会在 workflow 卡片复制日志或源码。

门禁选择放在 D5/D6/D7 现有动作确认卡中：用户先选择一个已通过 run，再确认具体动作。没有通过 run 时显示原因和“运行工作流”，不自动启动。切页、停止 Agent 或关闭聊天不会停止后台 workflow；关闭应用才按 interrupted 处理。

## 9. 持久化与隐私

建议使用 Electron `userData`：

```text
engineering-workflows.json
engineering-workflow-runs.json
```

两者使用版本化 `safeStorage` envelope、临时文件和原子替换。safeStorage 不可用时仅内存，不创建明文 fallback。损坏文件保留现场并返回 `WORKFLOW_STORE_CORRUPT`，不得用空数据静默覆盖。

持久化 run 只允许保存：opaque refs、项目内部 hash、workflow/profile fingerprint、节点状态、时间、退出码、计数、固定错误码和 bounded summary。禁止保存源码正文、命令/cwd、环境变量、stdout/stderr、诊断正文、绝对路径、PR 正文、token、MCP payload 或 Elicitation 输入。

renderer 的 localStorage 只保存当前页面的排序、筛选和选中的 opaque ref。工作流定义、run、日志和授权不得进入 session message、Markdown/JSON export、memory、usage、hooks 环境或普通 Agent event。

### 9.1 兼容与迁移

- 旧设置没有 `engineeringWorkflows` 时按空列表加载，不修改 D11 `verificationProfiles` 和 `codeIndexEnabled` 的既有默认值。
- profile 被删除、禁用或修改后，不静默删除引用它的 workflow；该 workflow 保留但标记为不可启动，用户编辑后才能恢复。
- D11 已存在的 verification job 不转换为 workflow node，仍可在 D11 列表中查看；D12 run 只引用其 opaque `jobRef`。
- safeStorage 不可用时不迁移到明文；本次进程内创建的定义和 run 在退出后丢失，UI 必须显示“仅当前进程”。
- D5/D6/D7 没有显式绑定 workflow 时继续旧的确认流程。门禁启用后只对用户选定的 action 和 `workflowRunRef` 生效，不对历史动作追溯加门槛。
- 迁移和读入均以 canonical project key 隔离；绝对路径只在 main 的现有 binding 表中解析，不能写入新的 workflow 文件或 renderer 状态。

实施前必须冻结以下容易引发兼容差异的选择：`continueOnFailure` 的依赖语义、fail-fast 取消粒度、workflow 全局并发上限、门禁是否要求每个 D5/D6/D7 action 单独绑定 run，以及历史清理的具体时间/数量优先级。

## 10. 固定错误码

```text
WORKFLOW_PROJECT_BINDING_INVALID
WORKFLOW_INVALID
WORKFLOW_LIMIT
WORKFLOW_PROFILE_NOT_FOUND
WORKFLOW_PROFILE_DISABLED
WORKFLOW_PROFILE_CHANGED
WORKFLOW_CYCLE
WORKFLOW_NODE_LIMIT
WORKFLOW_EDGE_LIMIT
WORKFLOW_ALREADY_RUNNING
WORKFLOW_RUN_NOT_FOUND
WORKFLOW_RUN_LIMIT
WORKFLOW_TERMINAL_DISABLED
WORKFLOW_APPROVAL_REQUIRED
WORKFLOW_APPROVAL_CANCELLED
WORKFLOW_CANCEL_FAILED
WORKFLOW_TIMED_OUT
WORKFLOW_STALE
WORKFLOW_INTERRUPTED
WORKFLOW_CONFIGURATION_CHANGED
WORKFLOW_GATE_REQUIRED
WORKFLOW_GATE_NOT_PASSED
WORKFLOW_GATE_FINGERPRINT_MISMATCH
WORKFLOW_STORE_CORRUPT
WORKFLOW_STORE_UNAVAILABLE
```

错误消息限长并脱敏，不包含绝对路径、命令 payload、环境变量、job 内部路径、token 或远端响应。

## 11. 测试与验收

自动化测试必须覆盖：

1. workflow 规范化、未知字段、profile 引用、节点/边/深度上限、稳定拓扑排序和环检测。
2. 分支并行、依赖阻塞、fail-fast、continue-on-failure、项目/全局并发上限和重复启动合并/拒绝。
3. 节点状态迁移、取消、超时、子 job 失败、应用退出 interrupted、完整 rerun 和历史清理。
4. 启动时冻结 workflow/profile fingerprint；运行期间工作区变化、profile 修改和 `.gitignore` 变化导致 stale/configuration_changed。
5. gate-check 的项目、run 状态、配置 fingerprint、workspace fingerprint 校验，以及 D5/D6/D7 动作前竞态复检。
6. safeStorage 成功、不可用、损坏和原子替换；明文泄漏扫描。
7. Agent 工具过滤、仅接受 workflow id/runRef、opaque 引用、权限 gate 和事件脱敏。
8. IPC sender ownership、跨项目拒绝、renderer 切页后台更新、取消/重跑和诊断定位。
9. D5 worktree、D6 Draft PR、D7 PR 生命周期、D8-D11 全量回归，旧 `verifyCommand` 行为不变。

真实 Electron 桌面验收至少完成：

- 创建 `typecheck -> test -> build` 工作流，确认依赖顺序、并行上限和工程中心状态更新；
- 首次授权后运行，切换聊天页、停止 Agent、重启应用，确认无自动重跑且中断可重跑；
- 人为修改文件触发 stale，修改 profile 触发 configuration_changed，失败节点可查看 D11 诊断；
- 通过 run 绑定 D5 应用、D6 Draft PR、D7 合并门禁，验证 fingerprint 变化时动作严格拒绝；
- 扫描 localStorage、session export、memory、usage、hooks、日志和普通聊天消息，确认没有命令、源码、诊断或绝对路径泄漏。

## 12. 非目标与后续阶段

- D12 不提供 cron、文件保存触发、git hook、远程 CI、跨设备同步或云端执行。
- D12 不把工作流结果转换成自动修复 patch，也不自动调用 Agent 修改文件；后续阶段可在 D5 隔离结果之上设计“建议修复 + 用户审批”。
- D12 不实现跨项目 workflow、矩阵参数、动态命令模板、workflow 内 MCP/Tasks/sampling 或用户自定义脚本节点。
- D12 不改变已有 PR 检查、merge 条件或 worktree 生命周期，只增加可选的本地 workflow gate。

后续阶段可在真实桌面验收后评估：基于隔离 worktree 的修复建议、远程 CI 状态回填和受控定时运行；任何一项都必须单独设计权限、隐私和恢复合同。
