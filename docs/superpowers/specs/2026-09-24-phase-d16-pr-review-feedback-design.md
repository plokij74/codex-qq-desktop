# Phase D16：PR 审查反馈闭环

日期：2026-09-24。状态：已按批准方案实现；验证结果见实施记录。

## 目标与范围

在当前绑定项目的 PR 详情中查看代码审查线程，选择一个线程生成隔离修复，审阅 diff 后更新原 PR。回复和解决线程是两个独立动作，不要求先修复或推送，也不会在修复完成后自动执行。

沿用项目 `origin` 和现有 `gh` 登录，支持 GitHub.com 与提供所需 GraphQL 字段的 GitHub Enterprise。PR 必须仍为 OPEN，允许 Draft；head 仓库必须与 origin 仓库相同。普通 PR 评论、审核总评和 review 提交不属于 D16。

## 用户流程

1. 打开已绑定项目的「拉取请求」，选择 PR，在「代码审查」中按未解决、全部、已解决或已过期筛选线程。
2. 选择线程读取当前讨论和位置。刷新只读取远端；没有自动轮询。
3. 可以直接填写回复并确认发布，也可以单独确认解决线程。每次远端写入必须使用一次性批准，`full-auto` 和会话授权不能绕过。
4. 可修复线程可填写最多 2000 字补充说明，选择可选的本地复验档案，生成一次隔离修复。
5. 工程中心查看修复状态、取消、重试、运行可选验证或打开 D5 结果卡。审阅 diff 后，单独确认「更新此 PR」。
6. 更新后可返回原审查线程，读取新 head 下的当前讨论再回复或解决；也可显式点击 D15「跟踪 CI（30 分钟）」。

审查面板只重绘自身。按项目、绑定令牌、PR 和线程隔离临时状态，保留回复、说明和验证档案选择。PR 标题、正文、普通评论和合并方式的未提交编辑也在异步重绘时保留。切换绑定、删除项目或退出应用后清除对应临时状态；草稿不持久化。

## 修复资格与位置

- 必须未解决、未过期，且存在已发布评论。
- LINE 线程需要有效的当前 RIGHT 行；多行范围也必须在 RIGHT，起始行不能晚于结束行。
- FILE 线程需要当前 head 下可读取的文本文件。
- 文件相对路径必须安全，位于当前绑定项目范围内；子目录项目不能修复兄弟目录。Windows 按规范项目路径的大小写规则比较范围，向 GitHub 查询时保留原始路径。
- 当前 head 下的 Blob 必须为文本，最多 128 KiB；行锚点不能超出文件。
- 根评论的原始提交可以早于当前 head。是否可修复由当前锚点决定，不以 `originalCommit` 或根评论 commit 相等为条件。

LEFT、过期、已删除或无法定位的线程仍可查看，并按当前 GitHub 权限回复或解决。已解决线程不能再发起修复或重复解决。讨论不完整时禁用修复和所有线程写操作。

## 信任边界与接口

Renderer 只提交 sender 拥有的 `projectBindingId`、PR 编号或 opaque ref。主进程解析规范项目路径、Git 根和 origin，再确定 host、owner、repo、PR、head、branch 和 GraphQL 节点 ID。拒绝 renderer 注入路径、仓库、SHA、线程节点 ID、refspec 或批准结果。

| IPC | 输入（另加 projectBindingId） | 用途 |
| --- | --- | --- |
| `engineering:pr-review:threads` | `prNumber` | 有界线程列表 |
| `engineering:pr-review:get` | `threadRef` | 当前线程详情和 revision |
| `engineering:pr-review:snapshot` | `threadRef`, `revision` | 创建不可变修复来源 |
| `engineering:pr-review:source` | `reviewRef` | 从历史来源定位当前线程 |
| `engineering:pr-review:reply` | `threadRef`, `revision`, `body` | 单次确认后回复 |
| `engineering:pr-review:resolve` | `threadRef`, `revision` | 单次确认后解决 |
| `engineering:pr-review:update-pr` | `resultId`, `subject` | 更新原 PR 或核对不确定的更新 |

`threadRef` 为进程内的 `prt_<24 hex>`，仅映射已验证的项目、仓库、PR 和 thread ID，最多保留 1000 条。`reviewRef` 为 `prv_<24 hex>`。修复继续使用 D13 `repair:start`，来源为 `{ kind: 'pr_review', reviewRef }`。不增加 Agent 工具；Agent 的 repair bridge 拒绝此来源，发起入口仅在 UI。

GitHub 适配器使用固定 GraphQL query/mutation，通过 `gh api --hostname HOST graphql --input -` 的 JSON stdin 传递变量。正文和节点 ID 不拼入 shell 命令或 GraphQL 文本。stderr、GraphQL errors 和异常正文不进入 IPC 错误，错误仅返回固定代码。

## 快照与新鲜度

快照冻结以下元数据：

```js
{
  reviewRef, projectKey, repoKey, prNumber, headSha, headRefName,
  threadId, threadFingerprint, path, line, subjectType, createdAt
}
```

讨论指纹覆盖线程身份、当前位置、解决/过期状态、评论数量及评论 ID、状态、作者、时间和正文 hash。正文先 hash，再做展示脱敏，避免被脱敏为同一文本的不同内容复用旧批准。pending 评论不展示为已发布讨论或进入修复正文。

详情读取在定位后再次读取线程，并复核 origin。列表跨页检查 head、总数、游标和重复 ID，并在返回前复核仓库及 PR head。用于 UI 写操作的 revision 同时覆盖 head、branch 和当前回复/解决权限。

修复在批准前、批准后、上下文构建、fetch 后和交付前校验快照。新增/编辑评论、解决线程、锚点移动、分支或 head 变化都会使旧来源失效；用户必须重新选择当前线程。来源导航只验证项目和仓库绑定，因此旧修复仍可定位到更新后的当前讨论。

回复与解决不依赖旧 `reviewRef`。每次操作读取当前线程、验证用户所见 revision、请求一次性批准，进入共享远端写入锁后再次读取，确认权限和 revision 未变化再发送。发送后读取线程，核对返回的 comment ID / resolved 状态及其余讨论没有变化。

GitHub 没有线程 revision 的条件写入参数，因此不能把本地复核描述为远端原子事务。发送后的读取失败、权限错误或 head 变化、部分响应和无法准确对账均返回 `PR_REVIEW_ACTION_UNCERTAIN`，由用户手动刷新核对。不会自动重发或自动串联动作；本进程内相同线程、动作及回复正文的已不确定请求不会再次发送。

## 修复与交付复用

D13 继续保证每个规范项目最多一个活动修复，限制 implement Agent 六轮，复用取消和部分结果保留、D5 diff 及可选的 advisory 验证。讨论作为不可信任务数据传入；子 Agent 沿用 D5 工具限制、项目范围限制、关闭终端/网络/MCP/Hooks 的设置。

完整修复任务提示（定位、完整已发布讨论、说明和模板）最多 32 KiB UTF-8。超过预算拒绝排队，不截断讨论后继续。worktree marker 的 goal 固定为「处理 PR 审查反馈」。

共享 `pr-delivery.js` 服务 D14 和 D16：

- 从已验证 PR 分支获取私有临时 ref，验证 SHA 与快照完全一致，复核来源后创建以该提交为基线的 worktree，最后清理临时 ref。
- D16 使用 `refs/codex/pr-review/prv_…`；不更新本地主分支、远端跟踪分支或 FETCH_HEAD。
- 结果带 `originKind: 'pr_review'`、`reviewRef`、`baseKind: 'remote_commit'`、`deliveryKind: 'github_pr_update'`。
- 交付结果不能另建 PR。沿用 D5 的主工作区应用检查，只有本地 HEAD 恰好匹配基线并通过完整 preflight 时才能应用。
- 更新前复核来源、PR head、远端分支 tip 和批准时的结果身份；只创建并复用一个单父提交，验证 parent 和 tree。
- 推送使用 `--force-with-lease=refs/heads/BRANCH:OLD_SHA` 和明确的 `NEW_COMMIT:refs/heads/BRANCH`。本地复验仅供参考，不绕过远端 branch protection。
- 推送退出码非零也可能已被远端接收。仅当 Git 无法启动，或 `--porcelain` 明确报告该精确 ref 被拒绝时，才认定为确定失败；其余传输失败均进入不确定状态。
- 不确定推送或重启恢复只允许读取远端核对；即使远端暂时仍显示旧 head，也不能再次发送该推送。确认 PR head 和分支 tip 都等于已保存提交，且本地 parent/tree 一致，才完成本地清理。

所有异步请求捕获 sender 和绑定状态。解绑、销毁 sender 或退出会取消请求；修复请求的取消信号保留到生成完成。Renderer 另以项目路径、令牌、PR 和请求代次丢弃旧响应，避免旧快照触发后续修复。

## 存储、预算与隐私

| 项目 | 上限 / 行为 |
| --- | --- |
| 线程列表 | 最多 200 条，明确显示截断 |
| 单线程详情 | 最多 50 条；不足以证明完整时禁止修复和写入 |
| 单次 GraphQL 请求 | 15 秒；命令输出最多 256 KiB，溢出按不完整/不可用处理 |
| 回复正文 | 最多 5000 个 JS 字符，保留换行，超限拒绝 |
| 补充说明 | 沿用 D13 的 2000 字上限 |
| 完整修复任务提示 | 32 KiB UTF-8，超限拒绝 |
| 审查快照 | 每项目 50 条、总计 200 条；保留修复历史和未完成结果引用的来源 |
| 面板临时记录 | 最多 50 个 PR；每线程保留本进程草稿 |

`engineering-pr-reviews.json` 为 v1 加密 envelope，仅保存快照元数据。使用 Electron safeStorage，不能加密或写入时退化为内存，不落明文。写入采用临时文件、解密读回校验和 rename；损坏文件保留且不覆盖。空间不足时先淘汰未被引用的最旧来源，全被保护则拒绝插入。

repair store 和 worktree marker 升至 v3，继续读取 v1/v2。旧版本 marker 不能冒充新的 review 来源，来源 ref、基线和交付类型必须相互一致。

讨论正文、完整提示、补充说明、回复草稿不写入 repair/review store、worktree marker、普通聊天、renderer localStorage、会话导出、记忆、usage 或 Hooks。模型只在这次受限修复请求内收到必要讨论。历史和结果卡仅保留 opaque refs 与可公开的结果元数据。

## 验收

自动化验证使用 fake GitHub；交付测试使用临时真实 Git 仓库，桌面冒烟使用真实 Electron renderer/preload/IPC、D13 runtime、D5 worktree，隔离配置并禁止网络。覆盖 1100×720 与 900×580、草稿和 PR 编辑保留、独立批准、修复 diff、更新后原线程导航、D15 跟踪和 renderer reload。

GitHub.com / Enterprise 的真实账号权限、现场 GraphQL 支持和受保护分支推送仍需在指定测试仓库验收。公共 GraphQL schema 的字段和 mutation 已核对；本次实现验证没有向真实 GitHub 回复、解决线程或推送。
