# Phase D.14 - GitHub Actions 远程 CI 修复闭环设计规格

**日期:** 2026-09-16
**项目:** `codex-qq-desktop`
**状态:** 设计草案，待评审
**前置:** Phase D.13 验证失败隔离修复已完成自动化实现；D5-D13 自动化回归与 D6/D7 GitHub 桌面流程必须在实施前重新确认

## 1. 目标与范围

D14 把当前绑定项目 GitHub PR 上的 GitHub Actions 失败接入已有工程闭环。用户在 PR 详情中选择一个仍属于当前 PR head 的失败 job，main 读取可信元数据、annotations 和有界日志，生成一个不可伪造的远程 CI 来源。该来源可以交给 D13，在 PR head 对应的 D5 隔离 worktree 中生成修复建议。

修复完成后，用户可以审阅 diff、选择本地 D11 profile 做 advisory 验证，并显式把修复提交回原 PR 分支。更新动作使用精确旧 head lease，远端分支已经移动时关闭失败。主工作区不会因远程修复或 PR 更新被直接修改。

D14 必须保持以下边界：

- 首版只支持当前项目 `origin` 对应仓库中的 GitHub Actions check run；其它 checks 继续展示，但不能成为 D14 来源。
- 只支持同仓库 PR。fork PR、跨 remote、用户提供仓库/URL/ref 和自动 fork 均不在本阶段范围。
- 来源必须是当前打开 PR 的最新 head 上、状态已结束、结论为 `failure` 或 `timed_out` 的单个 Actions job。
- renderer 只能提交 PR number、check run id、opaque ref 和可选 D11 profile id；不能提交仓库、SHA、branch、run/job id、日志、命令、路径、token 或 Git 参数。
- 远程日志和 annotations 只在当前进程的有界内存与一次性 repair prompt 中存在，不写入 store、聊天、session export、usage、memory、Hooks 或普通 Agent event。
- repair 仍由 D13 一次生成一个候选，不自动验证、不自动重试、不自动推送，也不形成“失败 -> 修复 -> 推送 -> 等待 -> 再修复”的循环。
- 更新 PR、重新运行 job 都是独立的用户显式远端动作；`full-auto` 不能自动执行，主 Agent 也没有对应 mutation tool。
- 不增加 npm runtime dependency，不读取或保存 GitHub token，只复用已有 `gh` CLI 登录。

## 2. 已锁定决策

| 主题 | 决策 |
|------|------|
| 功能归属 | 新增 main-owned `remote CI manager`；D13 继续拥有 repair，D5 继续拥有 patch/worktree 生命周期 |
| 支持提供方 | GitHub Actions；check run 的 `app.slug` 必须等于 `github-actions` |
| 仓库 | 当前 sender 绑定项目的 canonical Git repo 与 `origin`；GitHub.com / Enterprise 沿用 D7 |
| PR | `OPEN`、同仓库、非 fork，head branch 和 40 位 head SHA 均可由 GitHub 重新证明 |
| 失败粒度 | 单个 check run / Actions job；不接受整个 PR、整个 workflow run 或多个 job |
| 来源引用 | `rci_<24 lowercase hex>` opaque `remoteCiRef`；snapshot 创建后不可改写 |
| 来源新鲜度 | repo、PR、head SHA、check run、Actions job、run attempt 和失败结论必须在 repair 开始前后均一致 |
| 远程内容 | annotations-first；不足时加入失败 steps 与 job log 头尾摘录；最终仍受 D13 32 KiB context 上限 |
| repair 基线 | 精确 PR head SHA，不要求本地主工作区 HEAD 等于 PR head，但仍要求绑定 repo 是 clean Git worktree |
| 本地验证 | 可选选择一个已保存且启用的 D11 profile；只表示本地 advisory 复验，不声称等价于远程 job |
| 交付 | D5 结果可预览/打开/丢弃；本地 HEAD 等于来源 SHA 时仍可 apply；默认交付是显式更新原 PR |
| PR 更新 | 从来源 SHA 创建单个后继 commit，证明 tree 等于 D5 `expectedTree`，使用 exact lease 推送原 head branch |
| fork | 可继续查看 D7 checks；D14 snapshot、repair、rerun 和 PR update 全部拒绝 |
| rerun | 用户可显式重新运行原失败 job；不自动轮询、不自动在修复推送后 rerun |
| 权限 | repair 复用 D13 write Gate；本地验证复用 D11 terminal Gate；远端 mutation 每次独立确认 |
| 持久化 | remote CI 元数据使用 safeStorage envelope；日志、annotations、step message 和 prompt 永不持久化 |
| 兼容 | D13 repair store 升级为 v2，旧 D11/D12 repair 记录无损迁移；D5/D6/D7 既有结果语义保持不变 |

## 3. 用户闭环

```text
当前项目 PR 详情
  -> 读取当前 head 的 GitHub Actions jobs
  -> 用户选择一个 failure/timed_out job
  -> main 重新证明 repo / PR / head / check run / job
  -> 创建 immutable remoteCiRef（只保存元数据）
       |-- 可选：用户显式 rerun 原 job
       `-- 生成修复
             -> 可选选择 D11 本地复验 profile
             -> D13 write approval
             -> fetch 精确 PR head 到临时内部 ref
             -> D5 detached/locked worktree @ PR head
             -> D13 受限 implement Agent 生成单个 patch
             -> D5 结果卡
                  |-- 查看 diff / 打开 / 丢弃
                  |-- 本地 HEAD 恰好等于 PR head 时应用到主工作区
                  |-- 可选运行冻结的 D11 profile（advisory）
                  `-- 用户显式“更新此 PR”
                         -> 复检 PR head 仍等于来源 SHA
                         -> 生成 parent=来源 SHA、tree=expectedTree 的 commit
                         -> exact-lease push 到原 head branch
                         -> 重新读取 PR 证明新 head
                         -> 本地 cleanup；用户手动刷新后查看新 checks
```

snapshot、repair、validation、PR update 和 rerun 是五个独立动作。任何一步成功都不会隐式触发下一步。

## 4. 远程 CI 来源合同

### 4.1 支持的 PR

main 必须从当前 sender-owned `projectBindingId` 解析 canonical project path，并通过已有 GitHub CLI adapter 重新读取 `origin` 与 PR。D14 来源必须同时满足：

1. `origin` 可解析为 GitHub.com 或 GitHub Enterprise 的单一 `owner/repo`，且 `gh auth status --hostname` 成功。
2. PR number 是正整数；PR 属于该 `owner/repo`，状态严格等于 `OPEN`。
3. `isCrossRepository === false`，head repository 与 `origin` 的 `nameWithOwner` 完全一致。
4. `headRefName` 通过 `git check-ref-format refs/heads/<name>`；head SHA 是 40 位小写 hex。
5. renderer 不能覆盖 host、owner、repo、head ref、head SHA、PR URL 或 default branch。

Draft PR 可以作为来源。closed、merged、fork 或无法证明 head repository 的 PR 不能创建 D14 snapshot。

### 4.2 支持的 check run / job

main 使用 GitHub API 读取精确 head SHA 的 check runs。可导入项必须满足：

- check run `app.slug === 'github-actions'`；
- `status === 'completed'`；
- `conclusion` 只允许 `failure` 或 `timed_out`；
- check run id 是合法十进制字符串，并且仍出现在当前 head 的 latest check runs 中；
- `details_url` 必须是当前 GitHub host、当前 `owner/repo` 下的 Actions URL；
- 从 URL 得到的 run/job id 只作为候选，随后必须通过 Actions job API 重新读取并对账；
- Actions job 的 run id、job id、name、head SHA、status、conclusion 和 run attempt 与 check run/PR 一致；
- 当前 run attempt 必须仍是该 run 的最新 attempt，避免旧失败 attempt 在 rerun 已通过后继续成为新 repair 来源。

`cancelled`、`neutral`、`skipped`、`stale`、`action_required`、`startup_failure`、pending 和未知结论不可导入。非 Actions checks 保留 D7 原展示与 merge gate 语义。

### 4.3 Snapshot 输入与 immutable 记录

renderer 创建 snapshot 时只提交：

```js
{
  projectBindingId: string,
  prNumber: number,
  checkRunId: string
}
```

main 必须忽略或拒绝未知字段。snapshot 成功后生成：

```text
rci_<24 lowercase hex>
```

同一 project、PR、head SHA、check run id 和 run attempt 重复 snapshot 时返回已有 `remoteCiRef`，不复制记录。head、attempt 或 check run 不同则创建新 ref。snapshot 记录创建后不可编辑；用户若要选择另一 job 或新 attempt，创建新 snapshot。

### 4.4 新鲜度复检

创建 snapshot、repair 审批前、repair 审批后、rerun 前和 PR update 前都必须从 GitHub 重新读取权威状态。repair 来源有效要求：

- 当前 `origin` repo identity 与 snapshot 的 `repoKey` 一致；
- PR 仍为 `OPEN`、同仓库，head SHA/head branch 与 snapshot 完全一致；
- check run 和 Actions job 仍能读取，仍属于该 head 与同一 run attempt；
- check run/job 仍为允许的失败结论；
- 本地 fetch 到的 branch tip OID 精确等于 snapshot head SHA。

任何变化返回 stale/changed 固定错误，不使用旧日志、不创建 worktree、不自动改绑到新 head。用户刷新 PR 并选择新失败生成新的 snapshot。

## 5. 远程失败内容与诊断

### 5.1 获取顺序

repair 审批通过并完成第二次新鲜度复检后，main 按以下顺序构造一次性来源内容：

1. check run output 的 bounded title/summary；
2. check run annotations，按 API 顺序最多 50 条；
3. Actions job 中 conclusion 非成功的 steps，最多 20 条；
4. 当结构化内容不足时，读取该 job 的 log，加入头尾摘录。

日志获取失败不必阻断已有 annotations 的 repair；若 annotations、失败 steps、check output 和日志都为空，则返回 `REMOTE_CI_RESULT_UNAVAILABLE`，不能让 renderer 用自由文本冒充 CI 内容。

### 5.2 固定上限

| 内容 | 上限 |
|------|------|
| check runs | 当前 head 最多读取 200 条；超过标记 truncated |
| annotations | 50 条 |
| annotation path | 500 字符，必须为 repo 相对路径 |
| annotation title/message | 每条合计 1,500 字符 |
| failed steps | 20 条；单个名称 200 字符 |
| 原始 job log 读取 | 2 MiB process buffer；超过立即截断 |
| prompt 中 log 摘录 | 合计 16 KiB，保留头尾 |
| check output | 合计 4 KiB |
| 最终 D13 来源 context | 32 KiB，沿用 D13 总上限 |

### 5.3 规范化与脱敏

- annotations path 只能是相对路径；绝对路径、`..`、NUL、越界或 malformed 行直接丢弃。
- ANSI escape、不可见控制字符和超长行在解析前移除或裁剪。
- 日志、annotation message、step name 和 check output 都继续经过 D11 secret/path redaction，并增加 GitHub token、signed log URL、Authorization/header 和常见云凭据模式的脱敏。
- GitHub 已遮蔽的 `***` 保持原样，但不能把它当成充分脱敏证明。
- 所有远程正文都标记为不可信数据；其中的命令、提示注入、链接和“读取 secret”等文字不改变 Agent 工具、项目根、profile 或交付动作。

结构化 annotation 可以复用 D11 `Diagnostic` 形状；日志解析继续复用 `verification-diagnostics.js`，但 source 标记为 `github-actions`。只有路径能安全归一化到 repo/bound project 时才生成可点击定位。

## 6. Remote CI 数据、状态与持久化

### 6.1 记录形状

main 内部逻辑记录：

```js
{
  remoteCiRef: string,
  projectKey: string,
  repoKey: string,
  prNumber: number,
  headSha: string,
  headRefName: string,
  checkRunId: string,
  runId: string,
  jobId: string,
  runAttempt: number,
  workflowName: string,
  jobName: string,
  conclusion: 'failure' | 'timed_out',
  completedAt?: string,
  annotationCount: number,
  annotationsTruncated: boolean,
  logsAvailable: boolean,
  createdAt: string,
  lastVerifiedAt: string
}
```

GitHub numeric IDs 全部保存为十进制字符串，避免 JavaScript number 精度损失。`repoKey` 是规范化 host + `nameWithOwner` 的 SHA-256；project/repo identity 每次敏感操作都重新推导，store 字段不是单独授权。

### 6.2 Snapshot 状态

snapshot 是 immutable 终态事实，不维护 active job 状态机。对外动态计算 capability：

```text
available | stale | unavailable
```

- `available`：重新验证后仍属于当前 PR head 的失败 job。
- `stale`：PR head、attempt、结论或 repo identity 已变化。
- `unavailable`：认证、API、store 或远程内容不可读取，不能证明 stale/available。

动态状态不回写旧事实。刷新得到新的 job/check 时创建新 snapshot。

### 6.3 Store

建议新增：

```text
engineering-remote-ci.json
```

使用版本化 safeStorage envelope、同目录临时文件、原子 replace 和损坏保留。safeStorage 不可用时只保留当前进程内存，不创建明文 fallback。

历史上限为每项目 50 条、全局 200 条。仍被 repair 记录或未处理 D5 result 引用的 snapshot 不自动裁剪；其余按 `createdAt` 删除最旧记录。裁剪 snapshot 不触碰 repair、worktree、PR 或远端 job。

允许持久化上面的 bounded 元数据。禁止持久化：

- check output、annotations、steps、stdout/stderr/job log；
- signed log URL、PR body/comment、源码片段、patch/diff；
- `gh` token、header、环境变量、API 响应原文；
- D11 profile command/cwd 和用户 repair note。

## 7. D13 Repair v2 集成

### 7.1 新来源形状

D13 `normalizeSource` 增加：

```js
{ kind: 'remote_ci', remoteCiRef: 'rci_<24 hex>' }
```

renderer/Agent 不能直接提交 PR、check、run、job、SHA 或日志字段。`repair_start` 额外允许一个可选顶层字段：

```js
validationProfileId?: 'vfy_<id>'
```

该字段只在 `source.kind === 'remote_ci'` 时接受。main 从当前项目 D11 profiles 中解析，必须存在且启用，并冻结 fingerprint。它只控制修复后的本地 advisory 验证，不影响远程来源真实性或 repair prompt。

### 7.2 Repair store v2

D13 记录把“来源”和“本地验证 profile”拆开：

```js
{
  repairRef: string,
  projectKey: string,
  source: RepairSource,
  sourceFingerprint: string,
  validationProfile?: {
    profileId: string,
    profileFingerprint: string
  },
  // 其余 D13 状态字段不变
}
```

- D11/D12 来源：`sourceFingerprint` 是 source refs、profile id/fingerprint 与 workspace fingerprint 的稳定 hash，并且 `validationProfile` 必填。
- remote CI 来源：`sourceFingerprint` 是 repoKey、PR、head SHA、check run、job、attempt 和 conclusion 的稳定 hash；`validationProfile` 可选。
- 旧 v1 `profileId/profileFingerprint/sourceWorkspaceFingerprint` 在读取时迁移到上述字段；写回使用 v2 envelope。
- public response 在兼容期继续为存在 validation profile 的旧 UI 提供 `profileId` alias，同时新增明确的 `validationProfile`。

旧 repair 记录、retry lineage、D5 resultId 和 validation summary 必须无损恢复。迁移失败时保留损坏文件并关闭 D14/D13 新写入，不能丢弃旧 D5 结果。

### 7.3 Source resolver

`repair-manager` 通过注入的 remote CI manager 解析 `remoteCiRef`。解析分为两个阶段，防止只读浏览或审批等待提前读取私有 CI 日志：

1. `resolveMetadata`：在审批前只读取并验证 bounded repo/PR/job 元数据，返回 source fingerprint、base head、approval label 和 delivery；不读取 annotations 正文或 job log。
2. `materializeRepairSource`：write approval 通过后重新验证全部远程事实，再读取 bounded annotations/steps/log，并生成一次性 result 与 worktree factory。

D11/D12 resolver 适配相同接口，但其内容来自 D11 已保存的有界结果，不产生额外网络读取。第二阶段返回统一形状：

```js
{
  source,
  sourceFingerprint,
  baseHead,
  sourceLabel,
  approvalLabel,
  result: { stdout, stderr, diagnostics },
  validationProfile?,
  delivery: { kind: 'github_pr_update', remoteCiRef },
  createWorktree: async ({ project, sessionId, subagentId, goal, signal }) => handleResult
}
```

repair manager 不直接调用 `gh`、不解析 Actions URL、不执行 fetch，也不持有远端 branch 写权限。授权卡使用 `approvalLabel`，不能依赖一个必然存在的 D11 profile。

### 7.4 Retry 与 validation

- retry 重新验证 remote snapshot 和 PR head，并创建新 repairRef、新 worktree；旧 attempt 保持只读。
- PR head 已变化时 remote repair retry 返回 stale，用户必须选择新 snapshot。
- 未选择 `validationProfileId` 时仍可生成和更新 PR，但“验证修复”不可用并显示“未配置本地复验档案”。
- 选择 profile 后完全复用 D13 `runFrozenProfile`、terminal permission、patch restore 和 advisory 语义。
- 本地 profile 通过不表示 GitHub Actions 会通过；远程 Actions 通过也不回写为 D11 job 或 D12 workflow gate。

## 8. D5 远程基线扩展

### 8.1 Internal create-at-commit

新增 main-internal 创建入口，renderer 和 Agent 均不可直接调用：

```js
worktreeManager.createAtCommit({
  project,
  baseHead,
  sessionId,
  subagentId,
  goal,
  origin: {
    kind: 'remote_ci',
    remoteCiRef
  },
  delivery: 'github_pr_update'
})
```

它复用 D5 create 的 canonical repo、clean status、pending cap、exclude、路径、marker、detached/locked worktree 和 registration 校验。差异只有 base：

- 普通 D5 create 继续使用当前 local HEAD。
- remote CI create 使用已经 fetch 并验证存在于同一 object database 的精确 PR head SHA。

绑定 repo 仍必须 clean；D14 不用远程基线绕过 D5 clean-base 合同。当前 local HEAD 可以不同于 remote `baseHead`。

### 8.2 Subagent runtime 接线

现有 `runIsolatedImplement` 负责 create -> child run -> collect/incomplete/cleanup 的完整生命周期，D14 不复制这条链。它增加一个只允许 main 内部直接调用的可选参数：

```js
runIsolatedImplement(ctx, {
  goal,
  maxTurns,
  subagentId,
  markerGoal,
  createWorktree? // async callback；不属于 tool schema、IPC 或 renderer API
})
```

- 未提供 callback 时继续调用 `worktreeManager.create`，旧 `spawn_implement` 和 D11/D12 repair 不变。
- remote CI repair 由 `materializeRepairSource` 返回闭包；闭包内重新校验 remoteCiRef、执行安全 fetch，并调用 `createAtCommit`。
- runtime 只消费 callback 返回的标准 D5 handle，后续 child root、isolated Gate、collect、incomplete result 和事件仍走原实现。
- callback 不能由 Agent/tool args、IPC payload、settings 或 persisted record 反序列化；应用重启后必须由 remote CI manager 根据 opaque ref 重新构造。
- callback 失败时 runtime 返回固定 D5/D14 code，绝不回退到普通 `create` 或主工作区写入。

### 8.3 安全 fetch

remote CI manager 在 worktree 创建前使用固定流程：

1. 再次读取 PR，取得权威 `headRefName/headSha`。
2. 校验 branch ref 格式，目标 ref 固定为 `refs/codex/remote-ci/<remoteCiRef>`。
3. `git fetch --no-tags --no-write-fetch-head origin refs/heads/<headRefName>:<internal-ref>`；所有参数分离，禁止 shell。
4. `rev-parse <internal-ref>^{commit}` 必须精确等于 head SHA。
5. 调用 `createAtCommit`，并证明 linked worktree HEAD 等于 head SHA。
6. worktree 注册成功后删除临时 internal ref；失败时 best-effort 删除，无法删除则记录固定 warning，不删除用户 refs。

禁止 fetch renderer 提供的 URL/refspec、禁止更新用户 branch/tag、禁止 `git checkout` 主工作区、禁止递归 submodule 网络操作。

### 8.4 Marker 与 capability

D5 marker v2 增加 bounded 字段：

```js
{
  baseKind: 'local_head' | 'remote_commit',
  originKind: 'default' | 'remote_ci',
  remoteCiRef?: string,
  deliveryKind: 'default' | 'github_pr_update'
}
```

路径、repo、branch、host 和 push 参数仍不从 marker 获得授权。对 remote result：

- preview/open/discard 与普通 D5 一致；
- apply 只有当前主工作区 HEAD 精确等于 marker `baseHead` 且 D5 其它检查均通过时可用；
- D6 “创建 Draft PR”禁用，避免从已有 PR head 再创建第二个 PR；
- 新增“更新此 PR” capability，通过 `remoteCiRef` 交给 remote CI manager 重新验证；
- remote CI store 丢失/损坏时 patch 仍可审阅和丢弃，但 PR update 禁用。

普通 D5/D6 marker 按 v1 默认映射为 `local_head/default/default`，行为不变。

## 9. 更新现有 PR

### 9.1 前置条件

用户点击“更新此 PR”后，main 在全局 worktree mutation lock 内重新验证：

1. sender binding、resultId、remoteCiRef、projectKey 和 marker 关联一致。
2. D5 result 状态允许交付，patch/hash/baseHead/expectedTree/manifest/worktree registration 全部通过原有验证。
3. remote snapshot 仍属于当前 `origin` 的同仓库、`OPEN` PR。
4. PR 当前 head SHA 精确等于 D5 `baseHead`，head branch 与 snapshot 一致。
5. PR 非 fork；head ref 不是受 renderer 控制的 refspec。
6. 用户通过独立远端 mutation 确认。该确认不被 `permissionMode`、session allow 或 `full-auto` 复用。

### 9.2 Commit 与 exact lease push

worktree manager 从已验证的 `baseHead + stored patch` 构造单个 commit：

- parent 必须精确等于来源 PR head SHA；
- commit tree 必须精确等于 D5 `expectedTree`；
- commit message subject 默认 `fix: repair <job name>`，用户可编辑但必须单行、非空、最多 300 字符；
- author/committer 沿用 Git 已配置身份；缺失时关闭失败，不自动写全局/local Git config。

commit 创建成功后必须先把 `oldHead/newCommit/subject/expectedTree` 原子写入 marker，再进入 `pr_update_pushing`。后续重试只允许复用该 `newCommit`；即使应用重启、时间或 Git identity 变化，也不能重新生成另一个 commit 后继续同一次 delivery。

push 前再次 `ls-remote origin refs/heads/<headRefName>`，要求仍等于来源 SHA。随后使用：

```text
git push --force-with-lease=refs/heads/<headRefName>:<sourceHeadSha>
         origin <newCommit>:refs/heads/<headRefName>
```

在调用 push 前必须先用 Git 证明 `sourceHeadSha` 是 `newCommit` 的直接 parent，因而更新是单提交 fast-forward。`--force-with-lease` 只提供 exact compare-and-swap；代码禁止任何非 fast-forward commit 图、空 lease、通配 refspec 或用户自定义 force 参数。

服务端 branch protection、权限不足和 required review 拒绝按正常失败返回，不尝试绕过。

### 9.3 状态与恢复

D5 delivery 状态增加：

```text
ready
  -> pr_update_preparing
  -> pr_update_pushing
  -> pr_update_cleanup_pending
  -> pr_updated

pr_update_preparing/pr_update_pushing
  -> pr_update_failed | pr_update_uncertain
```

marker 只保存 bounded 的 old head、新 commit、PR number、时间、subject 和固定错误码；不保存 token、日志或 API 响应原文。

push 后必须重新读取 PR，证明 `headSha === newCommit`。若 push 返回超时/未知或刷新失败，进入 `pr_update_uncertain`，不自动重试。用户点击重试时：

- 当前 PR head 等于 `newCommit`：认领成功，进入 cleanup；
- 当前 PR head 等于旧 `baseHead`：允许再次执行同一个 exact-lease push；
- 当前 PR head 是其它 SHA：返回 `PR_UPDATE_HEAD_CHANGED`，禁止覆盖。

成功后清理本地 worktree、patch、临时 commit/ref，保留 bounded 已更新 marker/repair history。远端 branch 和 PR 保留；不自动删除 branch、不自动转 Ready、不自动 merge。

## 10. 重新运行远程 job

用户可以从 `available` snapshot 显式选择“重新运行此 job”。main 必须：

1. 重新验证 repo、PR head、run attempt、job id 和失败结论；
2. 显示独立确认，包含 repo/PR/job 名称和 head 短 SHA；
3. 使用 `gh api --method POST repos/<owner>/<repo>/actions/jobs/<jobId>/rerun`；
4. 只接受 GitHub 成功响应，不因超时自动重复 POST；
5. 返回“已请求”后由用户手动刷新 PR，新 attempt 创建新的 snapshot。

rerun 不修改旧 snapshot，不创建 D11 job，不触发 repair，也不自动等待。Agent、Hooks、MCP 和后台任务不能调用该 mutation。

## 11. 权限与安全边界

### 11.1 权限矩阵

| 动作 | 风险与授权 |
|------|------------|
| 查看远程失败 / 创建 snapshot | 用户打开 PR 或点击刷新产生的远程只读操作；不进入模型 |
| 生成 repair | D13 `write` Gate；`read-only` 拒绝，`confirm-writes` 审批，`full-auto` 只允许生成隔离结果 |
| 本地验证 | D11 `terminal` Gate、terminalEnabled、profile grant 与 timeout |
| 应用主工作区 | D5 现有用户显式动作与完整 preflight |
| 更新 PR | 每次独立远端 mutation 确认；任何 permissionMode 均不能自动放行 |
| rerun job | 每次独立远端 mutation 确认；任何 permissionMode 均不能自动放行 |

远端 mutation 确认不能使用聊天审批的 `allow_session`，也不能由 renderer 传入已批准标志。

### 11.2 所有权

- 所有 IPC 使用 sender-owned `projectBindingId`；main 从 registry 解析 canonical path。
- PR number/check id/ref 只用于定位，必须与 current origin/projectKey/repoKey 对账。
- `remoteCiRef`、`repairRef`、`resultId` 和 PR target 必须属于同一 projectKey。
- reload、window destroy 或 rebind 后旧 binding 失效；重新绑定同一 canonical 项目后可读取加密历史。
- opaque ref 不是授权凭据；任何敏感动作均重新验证磁盘与远程事实。

### 11.3 网络与命令

- 只通过已有 `gh`/`git` executable + argument array；`shell: false`，窗口隐藏，固定 timeout 和 maxBuffer。
- API path 仅由 canonical repo identity 与经过十进制/hex 校验的 ID 组成；不接受 renderer URL、GraphQL、header、hostname 或 endpoint。
- 不把 `gh` stderr/stdout 原文直接返回 renderer；错误使用固定 code + bounded redacted message。
- 不读取 `gh auth token`，不访问 credential helper 内容，不把环境变量交给模型。

## 12. Main / Preload / Agent 接口

### 12.1 建议模块

| 路径 | 职责 |
|------|------|
| `src/ai/remote-ci-state.js` | ref、snapshot 规范化、public allowlist、fingerprint、错误码和固定上限 |
| `src/ai/remote-ci-store.js` | safeStorage envelope、原子写、history pruning、memory-only/corrupt 状态 |
| `src/ai/remote-ci-manager.js` | repo/PR/job 解析、snapshot、新鲜度、内容获取、rerun、repair source、PR update 编排 |
| `src/ai/github-cli.js` | check-run/Actions API、annotations/log、job rerun、exact-lease push 所需窄 adapter |

`remote-ci-manager` 依赖注入 GitHub CLI、verification manager、repair manager 和 worktree manager。它不复制 D5 patch parser、D13 Agent loop、D11 diagnostics 或 D7 PR normalization。

现有 `github-cli.js` 的通用 `runCommand` 会为错误展示压平换行并裁剪输出，不能用于 job log。D14 增加仅供可信固定命令使用的 bounded raw runner：保留 stdout 换行，流式累计到 2 MiB 后终止或丢弃尾部，stderr 单独有界；raw bytes 只交给 remote CI context builder，绝不直接进入 public error、IPC、日志或 store。JSON/API 元数据仍使用现有 bounded parser 路径。

### 12.2 IPC channels

新增建议：

```text
engineering:remote-ci:failures
engineering:remote-ci:snapshot
engineering:remote-ci:list
engineering:remote-ci:get
engineering:remote-ci:rerun
engineering:remote-ci:update-pr
```

payload：

```js
failures({ projectBindingId, prNumber })
snapshot({ projectBindingId, prNumber, checkRunId })
list({ projectBindingId, limit? })
get/rerun({ projectBindingId, remoteCiRef })
updatePr({ projectBindingId, resultId, subject? })
```

`updatePr` 不接受 `remoteCiRef`，由 D5 marker 的关联值解析，防止 renderer 把 patch 指向另一 PR。preload 必须逐字段重建 payload；main 拒绝 projectPath、repo、URL、branch、SHA、run/job id、log、command、env、token、refspec、lease 和 approval 字段。

D13 `engineering:repair:start` 扩展：

```js
start({
  projectBindingId,
  source: { kind: 'remote_ci', remoteCiRef },
  validationProfileId?,
  note?,
  sessionId?
})
```

### 12.3 Agent tools

主 Agent 增加只读：

- `remote_ci_sources`：列出当前项目已创建的 bounded snapshot 摘要。
- `remote_ci_get`：读取一个 snapshot 的 PR/job/head/status/capability 摘要，不返回日志、annotations 或 URL query。

`repair_start` 接受 `remoteCiRef`，但 Agent 不能创建 snapshot、选择任意 PR/check、指定 validation profile、rerun job 或更新 PR。这样远程日志只有在用户先于 PR UI 选择可信来源、repair 又通过 write Gate 后才进入受限 implement prompt。

plan、explore、implement 子 Agent 不注册 remote CI 或 remote repair 工具。普通 Agent event 只包含 opaque refs、状态和固定错误，不包含 repo 私密文本、日志或 patch。

## 13. UI 设计

### 13.1 PR 详情

D7 PR checks 区增加 Actions job 详情能力：

- 每项显示 job 名称、workflow、状态、结论、attempt 和完成时间；
- 可导入项显示“生成修复”与“重新运行”入口；
- 非 Actions、fork、pending、旧 attempt 或不支持的 conclusion 显示固定原因，不提供动作；
- 点击“生成修复”先创建/复用 snapshot，再打开轻量面板；
- 面板显示来源 PR、head 短 SHA、job、diagnostic/log 可用性、可选本地复验 profile 和 repair note。

UI 不展示 signed log URL、run/job API path、branch refspec 或绝对路径。首版不提供远程日志、annotation message 或 step log 查看器；renderer 只接收 workflow/job 名称、状态、attempt、时间、数量和可用性。用户需要原始详情时沿用 D7 的可信 GitHub check 链接在浏览器中查看。

### 13.2 Repair / D5 结果卡

remote repair 卡显示：

- “GitHub Actions”来源、PR number、job、attempt、来源 head 短 SHA；
- snapshot stale/unavailable、可选本地 validation profile 与 advisory 结果；
- 复用 D5 diff/open/discard；apply capability 按当前 local HEAD 动态显示；
- `deliveryKind=github_pr_update` 时显示“更新此 PR”，隐藏“创建 Draft PR”；
- update 前确认展示文件统计、commit subject、目标 PR/branch、old head；
- push uncertain、head changed、branch protection 等状态用固定可恢复动作展示。

更新成功后卡片显示新 PR head 和“刷新 PR checks”，但不自动轮询。窄窗口沿用 D7/D13 详情抽屉与紧凑卡，不增加新的顶层页面。

## 14. 恢复、退出与降级

- snapshot 创建与远程读取是短请求；应用退出只取消请求，不持久化半条 snapshot。
- active D13 repair/validation 继续按 D13 标记 `interrupted`，不自动重新调用模型或命令。
- `pr_update_preparing/pushing` 在退出后恢复为 `pr_update_uncertain`；启动不自动访问网络或重推。
- 用户打开对应结果时才按 old/new/current head 三态对账，决定认领成功、允许重试或 head changed。
- safeStorage unavailable 时 snapshot memory-only；重启后相关 D5 remote result 仍可 preview/open/discard，PR update 显示来源元数据不可恢复。
- remote CI store corrupt 不影响 D7 PR 浏览、D11/D12、旧 D13 repair 或普通 D5 结果；损坏文件保留，D14 新 snapshot/repair 关闭失败。
- GitHub/网络不可用时已有 patch 不丢失；远端动作禁用，本地 apply 仍由 D5 自身条件决定。
- 不在后台恢复 watcher、rerun、fetch 或 `gh` 请求。

## 15. 固定错误码

```text
REMOTE_CI_PROJECT_BINDING_INVALID
REMOTE_CI_INVALID
REMOTE_CI_NOT_FOUND
REMOTE_CI_UNSUPPORTED_REPOSITORY
REMOTE_CI_GH_UNAVAILABLE
REMOTE_CI_PR_NOT_FOUND
REMOTE_CI_PR_NOT_OPEN
REMOTE_CI_FORK_UNSUPPORTED
REMOTE_CI_HEAD_INVALID
REMOTE_CI_HEAD_CHANGED
REMOTE_CI_CHECK_NOT_FOUND
REMOTE_CI_CHECK_UNSUPPORTED
REMOTE_CI_CHECK_NOT_FAILED
REMOTE_CI_ATTEMPT_CHANGED
REMOTE_CI_RESULT_UNAVAILABLE
REMOTE_CI_FETCH_FAILED
REMOTE_CI_FETCH_MISMATCH
REMOTE_CI_STORE_CORRUPT
REMOTE_CI_STORE_UNAVAILABLE
REMOTE_CI_RERUN_CONFIRM_REQUIRED
REMOTE_CI_RERUN_FAILED
REMOTE_CI_RERUN_UNCERTAIN
REMOTE_CI_VALIDATION_PROFILE_NOT_FOUND
REMOTE_CI_VALIDATION_PROFILE_CHANGED
PR_UPDATE_UNAVAILABLE
PR_UPDATE_CONFIRM_REQUIRED
PR_UPDATE_HEAD_CHANGED
PR_UPDATE_TREE_MISMATCH
PR_UPDATE_IDENTITY_MISSING
PR_UPDATE_PUSH_FAILED
PR_UPDATE_UNCERTAIN
PR_UPDATE_CLEANUP_FAILED
```

底层 D5/D11/D13/D7 错误可作为 `causeCode` 返回，但 public `error` 必须 bounded、脱敏，不含 command、repo absolute path、refspec、日志、annotation message、patch、环境变量、token 或 signed URL。

## 16. 测试与验收

### 16.1 自动化测试

1. remoteCiRef、十进制 GitHub ID、snapshot normalization、dedupe、repoKey/source fingerprint、public allowlist、history 上限和未知字段拒绝。
2. PR provenance：跨项目、origin 改变、repo mismatch、closed/merged、fork、invalid head branch/SHA 和 sender rebind 全部拒绝。
3. check/job provenance：非 Actions、pending/success/cancelled/action_required、旧 attempt、伪造 details URL、job/run/check/head 不一致全部拒绝。
4. GitHub CLI adapter：GitHub.com/Enterprise、分页、数字 ID 保真、non-zero checks JSON、timeout、认证失败、stderr/token/signed URL 脱敏。
5. remote context：annotations-first、相对路径、failed steps、log 头尾、ANSI/控制字符、secret redaction、prompt injection、32 KiB 总上限和零内容拒绝。
6. safeStorage：encrypted、memory-only、corrupt preserve、atomic replace、prune 不删除被 repair/result 引用的 snapshot，且 store 中无日志/annotations。
7. Repair v2 migration：旧 D11/D12 record 无损迁移，public alias 兼容；remote source 可无 validation profile，有 profile 时 fingerprint 冻结。
8. repair start：审批前后 head/check/attempt 变化、fetch mismatch、dirty repo、非 Git、pending cap 均无 worktree 副作用。
9. D5 create-at-commit：remote base 与 local HEAD 不同仍在精确 SHA 创建；internal ref 清理；用户 refs/FETCH_HEAD/main worktree 不变。
10. marker v1/v2：普通 D5/D6 capability 不变；remote result 隐藏 create PR，apply 仅在 local HEAD exact match 时可用。
11. remote repair runtime：仍只有 D13/D5 implement allowlist；无 terminal/MCP/Skills/Hooks/web/subagent，远程正文不进入父聊天。
12. optional validation：无 profile 禁用；profile 删除/禁用/修改拒绝；passed/failed/stale 不改变 update/apply capability。
13. PR update commit：parent、tree、manifest、subject、Git identity、old head 和 linked result 全部对账；不能构造非 fast-forward commit。
14. exact lease push：old head unchanged 成功；远端移动、branch protection、权限失败、timeout、post-read failure 和 retry 三态均正确。
15. update recovery：new head 已生效时认领，old head 未变时允许重试，其它 SHA 关闭失败；不重复生成不同 commit。
16. rerun：只允许 available failure；确认、POST、timeout uncertain、head/attempt changed、重复点击不自动重试。
17. IPC/preload：逐字段 payload、sender ownership、result/snapshot/project 对账、拒绝 path/repo/url/sha/log/refspec/approval 注入。
18. Agent：只能 list/get snapshot 和以已有 ref 请求 repair；无法 snapshot/rerun/update/指定 profile，子 Agent 无 remote tools。
19. privacy：session/localStorage/export/usage/memory/hooks/普通 event/log、repair store 和 remote CI store 均无远程日志、annotation、signed URL、token 或 patch。
20. D5-D13 全量回归；D6 Draft PR、D7 PR lifecycle/merge gate、D11 verification、D12 workflow gate、D13 local repair 行为不变。

### 16.2 真实 Electron 桌面验收

- 在同仓库 PR 上查看 Actions success/pending/failure，确认只有当前 head 的 failure/timed_out 可生成 snapshot。
- 选择失败 job 生成 repair，确认主工作区 HEAD/files/index 不变，隔离 checkout 精确位于 PR head。
- local HEAD 与 PR head 不同时确认 apply 禁用或 preflight 拒绝，但 diff/open/discard/update PR 可用。
- 选择与不选择本地 profile 各跑一次；确认 validation 只是 advisory，且 UI 明确不声称等价远程 CI。
- 更新 PR，确认只新增一个 parent=old head 的 commit、tree 精确、远端 branch 更新、主工作区不变，新 checks 需手动刷新。
- 在 push 前并发更新 PR branch，确认 exact lease 拒绝且不覆盖他人提交。
- 模拟 push timeout/post-read failure，重启后分别覆盖已成功、未推送、远端已变化三种恢复。
- 显式 rerun failure，确认不自动轮询、不修改旧 snapshot；刷新后新 attempt 使用新 ref。
- 覆盖 GitHub Enterprise、认证过期、网络断开、branch protection、无 Git identity、safeStorage unavailable/corrupt。
- 检查 private repo 场景的本地 store、localStorage、导出、日志和 crash artifacts，确认无 CI 正文、token、signed URL 或 patch 泄露。

## 17. 非目标与后续阶段

- D14 不支持 fork PR、GitLab/Bitbucket/Jenkins/CircleCI 或任意用户配置 webhook。
- D14 不提供后台轮询、系统通知、定时同步、云端执行或跨设备 CI 历史。
- D14 不自动把 GitHub Actions workflow/YAML 转换为 D11 profile，也不声称本地 profile 与远程环境等价。
- D14 不自动 rerun、不自动更新 PR、不自动 merge、不自动转 Ready，也不改变 D7 merge gate。
- D14 不提供多候选排名、模型辩论、自动 repair loop、自动解决 merge conflict 或跨 PR patch 搬运。
- D14 不允许查看/下载完整持久化 CI 日志，不保存 Actions artifacts，也不安装依赖或启动容器复刻远程环境。
- D14 不允许非 fast-forward 覆盖分支；exact lease 只用于证明 old head 未变化，commit 图仍必须是单提交 fast-forward。

后续阶段可分别评估：fork PR 安全交付、前台有界 CI watcher、Actions artifacts/测试报告解析、多个独立 repair 候选，或带总预算与人工检查点的多轮 repair loop。每项都必须重新设计远端权限、成本、取消恢复、日志保留和 patch ownership。

## 18. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-09-16 | 初版：锁定 GitHub Actions 单 job 来源、immutable snapshot、PR head 隔离 repair、可选本地复验、exact-lease 更新原 PR 与显式 rerun |
