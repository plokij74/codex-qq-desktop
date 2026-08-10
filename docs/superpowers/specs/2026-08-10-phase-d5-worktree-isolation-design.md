# Phase D.5 - Worktree 隔离设计规格

**日期:** 2026-08-10
**项目:** `codex-qq-desktop`
**状态:** 复审后定稿，待用户确认
**前置:** Phase D.4 记忆整理闭环已完成（`649c1b3`）

**依据:**

- `docs/superpowers/specs/2026-07-23-phase-c4-subagents-design.md`：`spawn_implement` 已有写工具白名单、串行 runtime、事件与 transcript，并预留 worktree 生命周期
- `docs/superpowers/specs/2026-07-19-phase-b-engineering-loop-design.md`：已有 Git 执行、diff 审批和 `fileChanges` 语义
- `docs/superpowers/specs/2026-07-31-phase-d4-memory-curation-design.md`：把 worktree 隔离列为 D.5+ 独立阶段
- 本轮讨论锁定的产品与技术决策（见第 2 节）

---

## 1. 目标与范围

### 1.1 一句话目标

把 `spawn_implement` 从“子 Agent 直接改主项目目录”改成“每次调用在独立 Git worktree 中修改，产出可恢复的待审补丁；只有用户在聊天卡片明确应用后才改主工作区”，同时保留 C.4 的深度、工具和串行边界。

### 1.2 本 Phase 交付

| # | 能力 | 摘要 |
|---|------|------|
| 1 | **worktree 核心边界** | Git 探测、干净基线校验、本地 exclude、detached worktree 创建、marker、结果收集和安全清理 |
| 2 | **`spawn_implement` 隔离** | 每次调用使用单独 worktree；子 Agent 只看隔离项目路径；非 Git 或创建失败时关闭失败，绝不回退直写 |
| 3 | **完整 Git 补丁** | 纳入新增、删除、重命名、支持的非 symlink 模式和二进制变更；补丁与摘要落在项目 `.codex/worktrees`，不把完整补丁送给模型或 localStorage |
| 4 | **聊天待审卡** | 持久显示目标、基线、文件与行统计；按需查看 bounded diff；整批应用、丢弃或打开隔离目录 |
| 5 | **整批受控应用** | 应用前要求原 HEAD 与整个仓库仍干净；整批检查和应用，不主动支持逐文件或部分成功；异常进入不确定态，不自动 commit/stage |
| 6 | **崩溃恢复** | 启动或打开项目时列出合法 marker；恢复 ready/running/applying 状态，禁止不确定结果被静默重放 |
| 7 | **权限收敛** | `spawn_implement` 入口仍走 write Gate；隔离树内部写不逐次审批；最终主树应用始终要求用户点卡片，不受 full-auto 自动放行 |
| 8 | **测试与文档** | Git 临时仓集成测试、runtime/IPC/renderer 状态测试、README D.5 与 C.4 边界更新 |

### 1.3 非目标（硬边界）

- 主 Agent 自身的 `write_file` / `search_replace` worktree 化
- `spawn_explore`、手动终端、Hooks、Skills、MCP 或非 Agent 写入的隔离
- `isolation: none | worktree` 可选参数；D.5 的 `spawn_implement` 固定使用 worktree
- 非 Git 项目回退到主目录直写
- 把主工作区未提交改动快照进 worktree
- 自动 commit、branch、merge、rebase、push 或 GitHub PR
- 逐文件选择、部分应用、patch 编辑器或冲突编辑器
- 自动执行测试、构建或 `verifyCommand`
- implement 并行、depth > 1、子 Agent 使用终端/删除/commit/MCP/Skills
- 自动删除未知、无 marker 或路径校验失败的目录
- 新 npm runtime 依赖

### 1.4 成功标准

1. `spawn_implement` 仅在绑定目录属于可用 Git 工作树、HEAD 可解析且整个仓库按正常 Git status 语义干净时启动；普通 ignored 内容明确不在基线内。
2. 入口获批后，主项目文件在子 Agent 运行期间保持不变；子写工具只作用于 linked worktree 下的绑定项目子目录。
3. worktree 创建或收集失败、Git 缺失、非 Git、脏基线、补丁超限时绝不回退直写。
4. 子 Agent 的新增、删除、重命名、支持的非 symlink 模式和二进制变更可被完整收集；模型只收到摘要和 opaque result id。
5. 未点击“应用”前，待审结果不会触碰主工作区、index 或 HEAD；`full-auto` 也不能自动应用。
6. 点击应用时，HEAD 或 status 与创建时不同即返回冲突并保留结果；D.5 不主动执行部分应用，但不宣称能对外部进程提供事务原子性。
7. 应用成功后主树得到完整未暂存变更，HEAD 不变；不自动 commit、不自动验证。
8. 点击丢弃只删除该隔离 worktree 和 D.5 artifact，不改主树。
9. 应用/丢弃后的清理失败不会把已完成动作谎报为失败；状态可在下次启动继续清理。
10. 应用崩溃恢复能区分“仍可应用”“已精确应用”“状态不确定”；不自动重放不确定补丁。
11. 合法 pending 结果在应用重启后可恢复到关联会话；session 已不存在时仍可从绑定项目聊天恢复。
12. `npm test` 全绿，无新增 runtime 依赖。

### 1.5 路线图（记账）

| 阶段 | 内容 |
|------|------|
| D.4（已交付） | compact 记忆候选、人工审核、已有记忆编辑 |
| **D.5（本规格）** | `spawn_implement` 单次 worktree 隔离、待审补丁、恢复与应用 |
| 以后 D.6+ | GitHub PR 真集成、MCP OAuth；各自单独成期 |

---

## 2. 已锁定决策

| 主题 | 决定 |
|------|------|
| D.5 主线 | worktree 隔离，不混入 PR 或 OAuth |
| 隔离范围 | **仅 `spawn_implement`**；主 Agent 写入保持现状 |
| 生命周期 | **每次 spawn 单独创建**；结果应用/丢弃后清理 |
| 基线 | **整个 Git 仓库必须达到正常 status clean**，从当前 HEAD 创建 detached worktree；普通 ignored 内容允许且不纳入结果 |
| 非 Git/失败 | **关闭失败**，绝不回退主目录直写 |
| worktree 位置 | 绑定项目内 `.codex/worktrees/<resultId>/checkout` |
| Git 污染防护 | 幂等写入 Git common dir 的 `info/exclude`；不修改项目 `.gitignore` |
| 子写审批 | `spawn_implement` 入口审批一次；隔离树内部 write 自动允许；危险工具仍不可见/不可执行 |
| 结果交互 | **聊天内持久待审卡**；模型不能自行应用 |
| 应用方式 | 用户明确点击后，完整 patch **整批受控应用**；不自动 stage/commit，不承诺跨进程事务原子性 |
| 应用前置 | HEAD 与创建时一致且仓库仍干净；否则严格拒绝并保留结果 |
| 补丁范围 | 完整 Git 变更，含新增/删除/重命名/支持的非 symlink 模式/二进制；D.5 拒绝 mode `120000` |
| 待审并发 | 可继续聊天；主树变化只会让旧结果进入冲突，不静默重基 |
| 验证 | D.5 不自动运行；应用后沿用现有主 Agent/终端显式验证 |
| 崩溃处理 | 启动列出并恢复；不自动删除可能有价值的合法结果 |
| 依赖 | Node CommonJS + Git CLI；无新 npm runtime 依赖 |

### 2.1 采用的主流程

```text
主 Agent 调用 spawn_implement
  -> 既有 write Gate 审批
  -> 检查 Git / HEAD / clean / pending cap
  -> 确保 .git/info/exclude 覆盖 .codex/worktrees/
  -> git worktree add --detach --lock <checkout> <baseHead>
  -> 子 runLoop(project.path = <checkout>/<projectRel>)
       只读 + write_file/search_replace
       隔离写不逐次弹审批
  -> 在隔离 index 收集完整 Git patch
  -> 持久化 patch + marker
  -> emit worktree-ready + 返回摘要给父模型
  -> renderer 保存轻量 result ref 并显示聊天待审卡
       |-- 应用: 严格重检 -> 整批 git apply -> 精确验证 -> 清理
       `-- 丢弃: 标记 discarded -> 清理
```

### 2.2 拒绝的替代方案

| 方案 | 拒绝原因 |
|------|----------|
| 会话/项目长期复用 worktree | 引入任务分支、重启续跑、并行写冲突和主动管理 UI，超出 D.5 安全最小闭环 |
| dirty base 快照 | tracked/untracked/ignored/submodule 复制与重放语义复杂，容易遗漏用户当前上下文 |
| 自动 merge 分支 | 强迫子 Agent commit 并改变历史；与现有 `git_commit` 权限和用户审阅顺序冲突 |
| 模型调用 apply 工具 | 用户控制依赖模型再次调用，且难在 run 结束后可靠恢复 |
| full-auto 自动应用 | 模糊“隔离区写入”和“主树写入”的信任边界 |
| 项目 `.gitignore` 自动修改 | 会制造额外 tracked change；D.5 仅应修改本地 Git 元数据 |

---

## 3. 架构与所有权

### 3.1 模块

| 路径 | 动作 | 职责 |
|------|------|------|
| `src/ai/worktree.js` | Create | Git worktree 命令、路径/marker 校验、exclude、clean/base、create/collect/apply/discard/recover |
| `src/ai/worktree-state.js` | Create | marker schema 规范化、状态机、结果摘要、固定上限；纯函数 |
| `src/ai/subagent-runtime.js` | Modify | implement 创建隔离句柄、替换 child project path、隔离 Gate、结果收集和事件 |
| `src/ai/providers/implement.js` | Modify | 工具说明改为强制 worktree；返回 worktree result 摘要 |
| `src/ai/agent.js` | Modify | pending worktree 不合并到主树 `fileChanges`；主提示说明必须由用户处理卡片 |
| `src/ai/agent-events.js` | Modify | worktree ready/recovered/state 事件常量 |
| `src/ai/worktree-ipc.js` | Create | bind/list/get/apply/discard/retry-collect/cleanup/open 纯 handler、payload/sender/busy 校验和响应整形 |
| `src/main.js` | Modify | manager 注入、注册窄 IPC、全局 mutation/busy 门闩；Git 状态机不写进 Electron 回调 |
| `src/preload.js` | Modify | 暴露窄 worktree API |
| `src/renderer/worktree-result-state.js` | Create | session 轻量引用规范化、合并、状态更新与上限 |
| `src/renderer/app.js` | Modify | 事件持久化、恢复、待审卡、lazy diff、应用/丢弃/open 与冲突状态 |
| `src/renderer/index.html` / `styles.css` | Modify | pending 区与卡片样式；无独立工作台页 |
| `tests/worktree*.test.js` | Create | Git 核心、状态/IPC/renderer 纯边界 |
| `README.md` | Modify | Phase D.5 用法、安全边界、恢复与磁盘说明 |

`worktree-ipc.js` 是固定模块，不是可选拆分；handler 只做 payload 校验、sender/busy 门闩、manager 调用和响应整形，不把 Git 状态机写进 Electron 回调。

### 3.2 数据权威

| 数据 | 权威位置 | 说明 |
|------|----------|------|
| 主项目 | 用户绑定路径 | D.5 只在用户应用后改动；HEAD 永不由 D.5 改变 |
| 隔离 checkout | `<project>/.codex/worktrees/<id>/checkout` | linked detached worktree，子 Agent 唯一写入根 |
| marker | `<project>/.codex/worktrees/<id>/meta.json` | 可恢复的生命周期记录；内容按不可信输入处理，不能单独授权路径或应用 |
| 完整补丁 | `<project>/.codex/worktrees/<id>/result.patch` | 主进程创建和读取；renderer/model 不持有完整内容 |
| renderer 引用 | `session.pendingWorktreeResults[]` / localStorage | 非权威缓存，只含 opaque id 与 bounded 摘要；通过 list/get 与 marker 对账 |
| Git worktree 元数据 | Git common dir `worktrees/*` | 只用 Git CLI 创建/锁定/移除，不手工改内部文件 |

磁盘 marker 的合法直接子目录集合是 unresolved 计数与恢复列表的权威。session 引用和即时事件都只是缓存或提示，不得隐藏磁盘上的 unresolved 结果。marker 中的 `sessionId` 只记录来源与展示归属，不是安全 owner；apply/discard/cleanup/open 只绑定 canonical project identity 与 opaque result id。

main 维护按 `webContents.id` 隔离的 `worktreeProjectBindings`。renderer 在项目加载/重绑时用当前 `projectId + projectPath` 建立绑定，main canonicalize 后签发随机 `projectBindingId`；该 id 只保存在当前 renderer 内存，不进 localStorage，窗口销毁、reload、项目删除或路径重绑即失效。后续 list/get/mutation/open 只接受 `projectBindingId + resultId`，main 从 registry 取 canonical path，不能再接受 renderer path。绑定入口本身沿用现有受信项目选择/加载流程；D.5 的安全边界是 context-isolated 应用 renderer，不声称抵御已经完全控制该 renderer 或同账号主机的攻击者。

### 3.3 目录布局

```text
<bound-project>/.codex/worktrees/
  wt_ab12cd34/
    meta.json
    result.patch          # collect 成功后出现
    checkout/             # git worktree add 的目标；完成清理时先移除
      .git                # linked worktree 管理文件
      ... full repo checkout ...
```

绑定路径可以是 Git 仓库子目录。创建时计算：

```js
repoRoot = git rev-parse --show-toplevel
projectRel = path.relative(repoRoot, boundProjectPath)
checkoutRoot = <boundProject>/.codex/worktrees/<id>/checkout
childProjectPath = path.join(checkoutRoot, projectRel)
```

`projectRel` 必须为空或仍在 `repoRoot` 内；`childProjectPath` 必须存在且在 `checkoutRoot` 内。`repoRoot`、bound project 和 common dir 均先 `realpath`，Windows 再用大小写无关、去尾分隔符的 normalized identity 比较；该 identity 统一用于 pending cap、list、apply、recovery 和 project rebind。这样写工具继续以“绑定项目”为沙箱，而补丁 path 仍以 Git repo root 为准。

### 3.4 运行时注入

`createSubagentRuntime` 增加可注入的 `worktreeManager`，测试使用 fake，生产由 main/run extensions 提供：

```js
createSubagentRuntime({ runLoop, worktreeManager })

worktreeManager.create({ project, projectBindingId, sessionId, subagentId, goal, signal })
worktreeManager.collect(handle, { incomplete, signal })
worktreeManager.cleanup(handle, { reason })
```

`runImplement` 仍保留 C.4 的同主 run 互斥。`runExplore` 与 batch explore 不接触 manager。

---

## 4. 创建与隔离运行

### 4.1 前置检查顺序

入口 `spawn_implement` 的既有 write Gate 通过后才做任何 D.5 磁盘写入。manager 按以下顺序执行：

1. 规范化并 realpath 绑定项目，计算 canonical project identity；拒绝不存在、非目录、路径越界和任一路径组件为 symlink/junction/reparse point。
2. `git rev-parse --is-inside-work-tree`；必须为 `true`。
3. 读取 `--show-toplevel`、`--git-common-dir` 和完整 `HEAD` SHA。
4. 验证 bound project 在 repo root 内；拒绝 bare repo 和无法解析 HEAD 的空仓库。
5. 用 literal pathspec 执行 `git --literal-pathspecs ls-files --stage -z -- <projectRel>`；任何 tracked gitlink mode `160000` 都返回 `UNSUPPORTED_GITLINK`，不创建 worktree。D.5 不进入 nested submodule；用户若直接绑定 submodule 自身，其 `show-toplevel` 是独立仓库，不触发本条。
6. 只按该 canonical project 的合法磁盘 marker 检查 unresolved 上限；达到上限时先让用户处理旧卡。
7. 验证 canonical common dir 及 `info` 路径无 symlink/reparse 后，以并发安全方式幂等追加准确的 worktree root 规则并读回验证。
8. 运行 `git status --porcelain=v1 -z --untracked-files=all`；任何字节都视为 dirty。
9. 生成 main 侧 result id 与专用目录；目标不能预先存在，父路径不得是 symlink/reparse point。
10. 原子写 `state: creating` marker。
11. `git worktree add --detach --lock --reason codex-qq:<id> <checkout> <baseHead>`。
12. 记录并重新查询期望的 worktree git-dir、common-dir、top-level 和 registration；验证 linked worktree 的 HEAD 等于 baseHead、child project path 合法，marker 改为 `running`。

任一步失败时返回稳定 code；如果 Git 已创建 worktree，则 best-effort unlock/remove。清理失败写入 marker，供恢复，不回退直写。

普通 ignored 文件不在 clean 判定中，允许存在；D.5 不声称快照或应用 ignored 内容。上述 pending 检查、id/result-dir 预留和 exclude 更新在 Git common-dir 级进程内 mutex 中完成，避免本应用的并发 spawn 同时越过上限或互相覆盖规则。

### 4.2 本地 exclude

D.5 不修改 `.gitignore`。通过 `git rev-parse --git-common-dir` 找到 common dir，并在 `info/exclude` 中幂等追加 anchored POSIX 规则：

```text
/<projectRel>/.codex/worktrees/
```

repo 根就是 bound project 时规则为 `/.codex/worktrees/`。追加前读取现有内容，只在完全等价规则不存在时补一行，并保留用户原内容。该规则不在清理时移除；它是稳定的本地工具目录规则。

`<projectRel>` 不能直接拼接：先把分隔符规范为 `/`，再用单一 `encodeGitignoreLiteral` 逐字符转义 Git ignore magic、反斜杠和有语义的首尾字符；CR/LF 或不能无损表示的路径直接 `PATH_UNSAFE`。写后用 `git check-ignore -q --no-index <prospective-checkout-path>` 验证准确目标被忽略，并用同仓测试证明 magic 邻近目录没有被意外忽略。

写入采用同目录临时文件、原子 replace 和写后读回验证；实现用进程内 common-dir mutex 串行本应用写入，并保留并发方已经写入的内容。在平台支持时 fsync 文件与父目录。每次读写前重新 `lstat` common dir、`info` 和 exclude，拒绝 symlink/reparse；任何写入、replace 或验证失败都返回 `EXCLUDE_FAILED`，不创建 worktree，因为临时 checkout 可能立即污染主 `git status`。D.5 不承诺与不合作的外部进程实现通用文件锁，但绝不在检测到内容竞争后继续创建。

### 4.3 detached 与 lock

- 使用指定完整 `baseHead`，不跟随创建期间分支移动。
- 使用 detached worktree，不创建用户分支，不要求子 Agent commit。
- worktree 创建后锁定，避免外部 `git worktree prune` 在待审期间移除。
- 不执行 fetch、submodule init、LFS install、依赖安装或 sparse-checkout 改写。

### 4.4 子 Agent project 与 Gate

子 `runLoop` 收到：

```js
{
  project: { ...parentProject, path: childProjectPath },
  subagentDepth: 1,
  subagentKind: 'implement',
  gate: isolatedGate,
  // C.4 原有 child settings: hooks/skills/mcp/subagent/verify/web 关闭
}
```

runtime 只能在 manager 已创建并验证 worktree 后构造全新的 `isolatedGate`，再显式传给 child `runLoop`；不得复用 parent gate、parent session grant 或 permission mode 派生出的 allow-all 状态。`isolatedGate` 只允许 allowlisted read/write 工具：

- read 自动允许，但工具层拒绝读取 `.git` 及 Git 管理路径；
- `write_file` / `search_replace` 自动允许，因为它们只能写 `childProjectPath`；
- delete/terminal/mcp/network/未知 risk 拒绝；
- 不能记 session allow，也不能放宽 builtin provider 白名单。

隔离 read/write 的安全根不是词法 `resolveSafe`：每次打开或修改前都必须逐组件 `lstat`，拒绝 symlink、junction 和其它 reparse point，拒绝 `.git` 路径、任何 tracked gitlink 子树，并在紧邻 mutation 前重新 canonicalize。创建新文件时使用平台可用的 no-follow/独占打开语义；不能证明最终目标仍在 canonical child root 内时 fail-closed。D.5 首版也拒绝读取、写入或产出 Git mode `120000` 的 symlink 与 `160000` gitlink 变更。

路径校验集中到共享 platform adapter，不能在各工具中各写一份弱检查。Windows adapter 除 `lstat().isSymbolicLink()` 外，还必须用 `FILE_ATTRIBUTE_REPARSE_POINT` 等价的可靠能力检查每个现存组件，并以 `fs.realpath.native` 对账 canonical target；Node/平台无法证明某组件不是 redirecting reparse point 时返回 `PATH_UNSAFE`。真实 junction、目录 symlink、case alias 与检查失败均有 Windows 验收测试，不能用只覆盖 POSIX symlink 的 fake 代替。

child settings 必须强制 `webEnabled:false`；不能只依赖 parent settings 或工具列表偶然隐藏网络工具。外层 `spawn_implement` 本身仍为 risk=`write`：read-only 和 plan 模式不创建 worktree；confirm-writes 显示一次入口审批；full-auto 可自动创建隔离树，但**不能自动应用结果**。

### 4.5 子结果与 abort

- `runAgentLoop` 增加显式 terminal reason（例如 `completed`、`max_turns`、`error`、`aborted`），manager 不从最后一轮返回形状猜测 incomplete。
- 正常结束：collect 完整结果。
- 子 Agent 报错或达到 turns：若存在修改，collect 为 `incomplete: true`，卡片明确“子任务未完整结束”；用户仍可应用或丢弃。
- 用户停止：运行中子循环立即 abort；同步写入已完成的文件仍留在隔离树。manager 使用独立、未 aborted 且有短超时的 lifecycle signal best-effort collect/cleanup，不能复用 child signal；有改动收集为 incomplete，无变更则直接清理。
- 创建完成但 collect 自身失败：保留 worktree，marker 为 `collect_failed`，卡片只允许重试收集、打开目录或丢弃，不允许应用。
- 无变更：返回 `changed:false`，立即清理，不生成待审卡。

---

## 5. 补丁与 marker

### 5.1 收集方法

收集只操作隔离 worktree 的 index，不接触主树 index。开始 collect 以及每次重试前，重新逐组件校验 artifact/checkout 无 symlink/reparse，并通过 Git 重新验证 `git-dir`、`git-common-dir`、top-level、HEAD、detached/locked registration 均与创建记录一致；checkout `.git` 指针或管理关系改变即 `COLLECT_FAILED`：

1. 对 bound project 的 literal pathspec 执行 `git --literal-pathspecs add -A -- <projectRel>`；repo 根绑定时 pathspec 为 `.`。所有 Windows 分隔符先规范为 `/`，不得把未经 literal 约束的用户路径传给 Git。
2. `git --literal-pathspecs diff --cached --quiet -- <pathspec>` 判断无变更。此后每个带 pathspec 的 Git 调用都必须使用 `--literal-pathspecs`，不能只保护 `add`。
3. 用固定序列化参数生成完整 patch；实现定义单一 `PATCH_DIFF_ARGS`，collect、重试、preview 校验和 apply 前重生成必须复用：

```text
git -c core.quotePath=true -c color.ui=false -c diff.suppressBlankEmpty=false
    --literal-pathspecs diff --cached --binary --full-index
    --find-renames=50% --diff-algorithm=myers --no-indent-heuristic
    --no-ext-diff --no-textconv --no-color --unified=3 --inter-hunk-context=0
    --src-prefix=a/ --dst-prefix=b/ -- <pathspec>
```

4. 从同一 child index 用 literal pathspec 生成 `--raw -z --no-abbrev --find-renames=50%`、`--name-status -z`、`--numstat -z` 与 `--stat` 摘要；结构化记录始终先按 Buffer/NUL 切分，invalid UTF-8 必须拒绝而不是 replacement decode，rename/copy 的两端都单独校验。
5. 用 Node `spawn` 直接把 patch stdout 按字节流写入 `result.patch.tmp`，同步计算 SHA-256 和 bounded size；不能复用现有 8 MiB `execFile` buffer，也不能把二进制 patch 经字符串或 PowerShell 文本管道改写。
6. 由 child index 执行 `git write-tree` 得到 `expectedTree`。再创建安全临时 alternate index：`read-tree <baseHead>` 后执行 `git apply --cached --binary -p1 <result.patch.tmp>`，并从该 index 计算 `write-tree` 与相同 fixed/literal `--raw -z` manifest；两者必须分别等于 child `expectedTree` 与 manifest。这让 Git 自身解析真实 patch header，并把 rename/copy 两端、binary、mode-only 与 quoted/newline path 绑定到 canonical tree/manifest，而不是手写逐行 patch parser。
7. 临时解析通过后 fsync patch temp、原子 rename 为 `result.patch` 并 fsync 父目录，再原子更新 marker 为 `ready` 或 `oversize`。

隔离 index 可保持 staged；它只服务结果构建，用户不可见。D.5 不在主树 stage 任何文件。

每个 `--raw -z` 记录都要验证 old/new mode、状态与全部路径：绝对路径、`..`、bound project 外路径、malformed record 及任一 old/new mode 为 `120000` 或 `160000` 一律拒绝。rename/copy 必须同时验证来源和目标；binary、mode-only 和含换行/引号的路径不得经逐行文本解析。apply 时只使用从已重新验证 checkout、同一 child index 与 `PATCH_DIFF_ARGS` 重新生成且与持久结果逐字节一致的 patch；最终状态正确性以 Git tree OID + canonical manifest 证明，不依赖 child/main 两个 worktree 重新序列化的 patch bytes 恰好相同。

所有 alternate index 都由 `fs.mkdtemp` 在经过 realpath/no-reparse 验证的 OS temp 根下创建唯一 mode-0700 目录（平台支持时），index 文件在 `read-tree` 前必须不存在且以本次随机目录独占，`.lock` 预存在即失败；绝不复用 stale index/lock。命令只通过显式 `GIT_INDEX_FILE` 环境变量指向该文件，结束后逐项 no-follow best-effort 删除临时目录。

### 5.2 固定上限

| 项 | 上限 | 超限行为 |
|----|------|----------|
| unresolved 结果 | 每 bound project 3 个 | 新 `spawn_implement` 返回 `PENDING_LIMIT` |
| 完整 patch | 16 MiB | marker=`oversize`；禁止卡片应用，可打开目录或丢弃 |
| 文件摘要 | 前 200 条 | 标记 `filesTruncated`；完整 patch 不截断 |
| renderer diff preview | 64 KiB / 800 行 | 头尾截断并保留完整 stats |
| goal | marker 2000 字符；UI 160 字符 | 截断，不影响子 Agent 原始输入 |
| summary | 沿用 C.4 8 KiB | 超长截断 |

上限固定，不新增设置项。patch 超限时不把截断 patch 当作可应用结果。

### 5.3 marker v1

```json
{
  "version": 1,
  "id": "wt_ab12cd34",
  "state": "ready",
  "sessionId": "task_x",
  "subagentId": "sa_1_x",
  "goal": "实现设置校验",
  "createdAt": 1786300000000,
  "updatedAt": 1786300060000,
  "repoRoot": "D:/repo",
  "projectRoot": "D:/repo/packages/app",
  "projectIdentity": "windows:d:/repo/packages/app",
  "projectRel": "packages/app",
  "baseHead": "40-hex-sha",
  "worktreeGitDir": "D:/repo/.git/worktrees/checkout",
  "expectedTree": "40-hex-tree-oid",
  "patchSha256": "64-hex-sha",
  "patchBytes": 18240,
  "incomplete": false,
  "files": [{ "path": "packages/app/src/a.js", "status": "M", "binary": false }],
  "filesTruncated": false,
  "stats": { "files": 1, "additions": 8, "deletions": 2, "binaryFiles": 0 },
  "errorCode": null,
  "error": null
}
```

状态枚举：

```text
creating -> running -> collecting -> ready
                         |            |-> applying -> applied_cleanup_pending
                         |            |      |-----> ready（恢复证明仍为 base）
                         |            |      `-----> conflict | apply_uncertain
                         |            |-> discarded_cleanup_pending
                         |-> collect_failed -> collecting（显式重试）
                         `-> oversize -> discarded_cleanup_pending

conflict -> applying | discarded_cleanup_pending
apply_uncertain -> discarded_cleanup_pending（用户检查主树后）
applied_cleanup_pending | discarded_cleanup_pending -> <artifact deleted>
```

marker 用 tmp + rename 原子更新；每次先 fsync temp，rename 后在平台支持时 fsync 父目录，且 `ready` marker 只能在 patch 已完成同样耐久写顺序后出现。`sessionId` 只是来源 metadata，`projectIdentity`、路径、Git dir、base、hash、expectedTree、summary 与 state 在每次敏感操作时都从 binding、Git registration、checkout、index 和 patch 重新推导；marker 字段不能作为单独授权依据。用户可读 error 必须稳定、截断且不包含 patch 内容；详细 Git stderr 可保留 bounded 诊断字段，但不得进入模型 prompt。

恢复保证针对应用进程/窗口崩溃与重启；突然断电/OS 崩溃仅在文件系统兑现 fsync/rename 语义时 best-effort 保留合法结果。缺失、torn 或顺序不一致的 artifact 一律 fail-closed 并保留可验证现场，不宣称在任意文件系统上零丢失。

同账号本地用户能够同时改 marker、patch 和 checkout，不在 D.5 的恶意主机防护模型内；D.5 不设置伪造安全承诺。任何不一致或无法重新证明的本地篡改都 fail-closed，绝不能用 marker 中被改写的绝对路径扩大读取、应用或删除范围。

### 5.4 模型可见结果

父模型只收到：

```js
{
  ok: true,
  kind: 'implement',
  isolation: 'worktree',
  subagentId,
  summary,
  turns,
  agentLog,
  result: {
    id: 'wt_ab12cd34',
    state: 'ready',
    incomplete: false,
    fileCount: 3,
    additions: 28,
    deletions: 4,
    hasBinary: false,
    message: '改动在隔离 worktree 中，等待用户在聊天卡片应用或丢弃'
  }
}
```

不返回完整 patch、absolute checkout path、marker path 或可伪造的 apply payload。pending worktree 变更也不合并进父 run 的 `fileChanges`，因为主树尚未改变。

---

## 6. 应用、丢弃与清理

### 6.1 应用 IPC 前置

用户点击聊天卡片是本次主树写入的明确授权。handler 必须验证：

1. 当前全局无 active chat run、manual terminal 或另一 worktree mutation；否则 `BUSY`。mutation 开始后也反向阻止新 chat/manual terminal 启动，直到 apply/discard/cleanup 临界区结束。
2. payload 只含当前窗口的 `projectBindingId` 与 `resultId`；id 形状合法。`sessionId`、project path 都不参与 mutation payload。
3. 用 sender `webContents.id + projectBindingId` 查询 main registry，并重新 realpath/canonicalize registry 中的 project identity；结果目录只能由 canonical project + validated result id 推导，不能接受 renderer/marker 传入的 patch、checkout、Git dir、hash 或任意 path。
4. 对 result root、marker、patch、checkout 及所有父组件立即重新 `lstat`；任一 symlink/junction/reparse 或 direct-child 关系不成立即 fail-closed。
5. marker state 为 `ready` 或可重试的 `conflict`；再从 Git/checkout 重新计算 base、registration、patch、hash、raw manifest 和 summary，不把 marker 字段当成权威。
6. registration 组合校验：解析 `git worktree list --porcelain` 的 canonical checkout/HEAD/detached/locked record；在 checkout 内分别执行 `rev-parse --git-dir --git-common-dir --show-toplevel`；解析只读 `.git` pointer 并要求它指向同一个 canonical admin entry。任一信息缺失或互相不一致即 `GIT_METADATA_CHANGED`，不能假定 list 单独提供 git-dir 身份。
7. `git rev-parse HEAD === baseHead`；主 index 与 baseHead 一致，`git status --porcelain=v1 -z --untracked-files=all` 仍为空。
8. raw NUL manifest 的全部 old/new 路径均为原 bound project 的 literal pathspec 内，且主树每个现存目标/父组件都不是 symlink/junction/reparse；symlink mode patch 一律拒绝。

任一不满足时不调用 apply，marker 记 `conflict`（安全校验错误除外），返回稳定 code 并保留 worktree。

### 6.2 整批受控应用

D.5 利用“同一 baseHead + 主树仍干净”保证 patch 可直接重放：

1. 获取全局 mutation gate 与 repo 级进程内 mutex，防止本应用并发启动 run 或应用两个结果。
2. marker 原子改为 `applying`。
3. 从已验证 checkout 的同一 index 重新计算 `expectedTree`/raw manifest，并用 `PATCH_DIFF_ARGS` 流式生成临时 patch；要求其 bytes/hash、temp-index apply 后的 tree/manifest 与持久结果及重新计算值一致，后续只使用该临时 patch。
4. plain `git apply --check --binary <temp.patch>`；主树禁止 `--3way`、`--reject` 和任何写 index 的选项。
5. 再次快速核对 HEAD、index、status、受影响路径的逐组件 `lstat` 与 worktree registration。
6. plain `git apply --binary <temp.patch>`；不接受产品层面的部分选择。
7. 用第 6.3 节的 alternate-index 方法读取主树完整 Git-visible 状态，确认 tree OID 等于 `expectedTree` 且主 index 未变化。
8. marker 改为 `applied_cleanup_pending`，在同一 mutation 临界区内执行 cleanup。

严格基线下不在主树 materialize 三方冲突；check 失败进入 `conflict`。`--check` 加进程内 mutex 不构成跨进程事务：不合作的外部进程仍可能在检查与应用之间改文件，Git 也不提供本流程的多文件事务回滚。因此契约是“单次整批调用、无主动部分成功”；一旦不能证明最终状态精确，必须进入 `apply_uncertain`，绝不自动反向 apply 或自动重试。

成功后：

- HEAD 不变；
- 主 index 保持无 staged changes；
- 结果是普通未暂存工作区改动；
- 返回完整 file summary，renderer 卡片显示“已应用”；
- 不触发 `git_commit`、verify 或新的模型调用。

### 6.3 应用失败与不确定状态

- `--check` 失败：`PATCH_CONFLICT`，主树仍干净，结果可在用户恢复基线后重试。
- apply 非零且 alternate-index 证明主树仍精确等于 base：回到 `conflict`。
- apply 返回非零、异常，或 post-check 不是“精确 base”/“精确结果”之一：标记 `apply_uncertain`；禁止自动重试、自动回滚和自动清理，提示用户查看主树 Git diff 与隔离目录。
- cleanup 失败但应用已确认：返回 `{ ok:true, applied:true, cleanupWarning }`，marker=`applied_cleanup_pending`；后续只重试清理，绝不再 apply。

为处理 untracked 新文件以及应用后、marker 更新前的进程崩溃，post-check 与恢复都不得直接依赖普通 `git diff` 或主 index。它们按第 5.1 节的安全临时目录协议创建唯一 alternate index，并在 main worktree 中执行：

```text
GIT_INDEX_FILE=<secure-temp-index> git read-tree <baseHead>
GIT_INDEX_FILE=<secure-temp-index> git --literal-pathspecs add -A -- .
GIT_INDEX_FILE=<secure-temp-index> git write-tree
```

临时 index 不得位于可替换的 result dir，不得触碰或锁定主 index，使用后 best-effort 删除。`add -A -- .` 有意覆盖整个 repo：bound project 外任何 Git-visible 改动都会改变 full-tree OID，从而进入 uncertain；无需把 full-repo diff bytes 与 scoped patch 比较。普通 ignored 文件按 Git clean 语义不进入比较，也不属于“完整 unstaged result”的验证范围。还要单独比较主 index `write-tree` 与 `baseHead^{tree}`，证明主 index 未变化：

- alternate `write-tree === expectedTree` 且主 index tree 为 base tree：认定已应用，marker=`applied_cleanup_pending`，只待清理；
- alternate `write-tree === baseHead^{tree}`、主 index tree 也为 base tree、status clean 且 patch `--check` 通过：恢复为 `ready`；
- 其它情况：`apply_uncertain`，不自动写盘或清理。

### 6.4 丢弃

“丢弃”需二次确认。handler 按 6.1 的 canonical project/result、no-reparse 和 Git registration 边界校验，不校验 session owner：

1. marker=`discarded_cleanup_pending`；
2. `git worktree unlock <checkout>`（不存在/已解锁视为可继续）；
3. `git worktree remove --force <checkout>`；
4. 确认 `git worktree list --porcelain` 不再登记该路径；
5. 删除专用 result directory。

只允许删除 `<project>/.codex/worktrees/<validated-id>`。每次 unlock/remove/read/delete 紧邻操作前都重新 `lstat` 全部组件，并重新核对 Git registered canonical checkout；marker 内容只能帮助诊断，绝不能改变推导目标。artifact 删除器逐项 no-follow 清理，根目录一旦是 reparse point 就停止，不对 symlink/junction 目标做 recursive remove，也不处理无合法 marker 的未知目录。清理失败时保留 `applied_cleanup_pending` 或 `discarded_cleanup_pending` 与显式“重试清理”动作。

registration 检查与 Git CLI remove 之间仍没有跨进程事务锁；若 remove 返回异常，或 post-check 发现路径/registration 被外部替换，保持原 cleanup-pending 状态并返回 `CLEANUP_FAILED`，不再手工递归删除。D.5 的误删防护针对本进程与非竞争环境；能同时替换 opaque result path 和 Git registration 的同账号外部进程属于第 5.3 节已声明的主机篡改边界。

`cleanupWorktreeResult` 只接受这两个 cleanup-pending 状态并保持幂等；已应用结果永不重新 apply，已丢弃结果永不改变主树。`retryCollectWorktreeResult` 只接受 `collect_failed`，重新验证 worktree/metadata 后收集；它不能接受 renderer path，也不能绕过 patch 上限。

### 6.5 多 pending 与继续聊天

同一项目可保留最多 3 个 unresolved 结果。用户可继续聊天或启动新 Agent；D.5 不锁定会话。若后续主树写入，旧卡在应用时进入冲突。新结果仍要求创建时仓库干净，因此主树一旦有改动，新的 isolated implement 会被拒绝，直到用户提交、暂存处理或恢复干净状态。

---

## 7. IPC 与事件契约

### 7.1 Preload API

```js
bindWorktreeProject(payload)    // { projectId, projectPath } -> { projectBindingId }
listWorktreeResults(payload)    // { projectBindingId }
getWorktreeResult(payload)      // { projectBindingId, resultId }
applyWorktreeResult(payload)    // { projectBindingId, resultId }
discardWorktreeResult(payload)  // { projectBindingId, resultId }
retryCollectWorktreeResult(payload) // { projectBindingId, resultId }
cleanupWorktreeResult(payload)  // { projectBindingId, resultId }
openWorktreeResult(payload)     // { projectBindingId, resultId }
```

preload 不暴露任意 worktree path、patch 文本写入或通用 Git 命令。main 要求 binding 属于当前 sender `webContents.id` 且仍为 registry 中当前版本；stale window/token、已删除或已重绑项目统一返回 `RESULT_NOT_FOUND`。

`openWorktreeResult` 由 main 从 validated id、marker 和 Git registration 推导并重新校验 `childProjectPath`，只打开绑定项目在 checkout 内的对应目录；renderer 不提供目标 path。成功返回 `{ ok:true, opened:true }`；目标缺失、reparse、registration 失配或 shell open 失败返回稳定错误且不泄露绝对路径。

### 7.2 响应形状

列表：

```js
{
  ok: true,
  results: [{
    id, sessionId, subagentId, goal, state, createdAt, baseHead,
    incomplete, files, filesTruncated, stats,
    canApply, canDiscard, canOpen, needsAttention,
  }],
  warnings: []
}
```

详情在用户展开时 lazy 读取：

```js
{
  ok: true,
  result: { /* sanitized list fields */ },
  preview: { text, truncated, bytes, lines }
}
```

应用成功：

```js
{
  ok: true,
  applied: true,
  resultId,
  state: 'applied' | 'applied_cleanup_pending',
  fileChanges: [{ path, op, stats }],
  cleanupWarning: null | '改动已应用，但临时 worktree 清理失败'
}
```

`applied` 是 renderer 的已解决展示态：cleanup 成功后磁盘 marker 已删除；只有清理失败时磁盘保留 `applied_cleanup_pending`。

重试收集成功：

```js
{ ok: true, resultId, state: 'ready', result: sanitizedResult }
{ ok: true, resultId, state: 'no_changes', cleaned: true }
```

超限返回 `{ ok:false, code:'PATCH_TOO_LARGE', state:'oversize', result }` 并保留 checkout；再次失败返回 `COLLECT_FAILED`。两者都发送 `worktree-state` hint，renderer 随后 list 对账。

重试清理成功返回 `{ ok:true, resultId, cleaned:true, resolution:'applied'|'discarded' }`；失败返回 `{ ok:false, code:'CLEANUP_FAILED', state:'applied_cleanup_pending'|'discarded_cleanup_pending' }`。成功后 marker/result dir 已不存在；若首个成功响应丢失，重复调用返回 `RESULT_NOT_FOUND` 且不得执行任何删除，renderer 通过 list 缺项把卡片收敛为已清理。

冲突：

```js
{
  ok: false,
  code: 'BASE_CHANGED' | 'WORKTREE_DIRTY' | 'PATCH_CONFLICT' | 'APPLY_UNCERTAIN',
  state: 'conflict' | 'apply_uncertain',
  error: '主工作区已变化，结果已保留；请恢复干净基线后重试或丢弃'
}
```

### 7.3 事件

新增：

| 事件 | 时机 | 关键字段 |
|------|------|----------|
| `worktree-start` | 入口获批、开始创建 | `projectId`, `projectBindingId`, `subagentId`, `resultId`, `goal` |
| `worktree-ready` | collect 后有待审结果 | `projectId`, `projectBindingId`, sanitized result summary |
| `worktree-state` | collect/recovery/cleanup 状态变化 | `projectId`, `projectBindingId`, `resultId`, `state`, `error?` |
| `worktree-recovered` | 后台 recovery 完成 | `projectId`, `projectBindingId`, sanitized result summary |

事件沿用 `chat:event`。`projectBindingId` 是当前窗口的 opaque routing key，不是绝对路径；即使原 session 已删除，renderer 仍能路由到当前 project。`worktree-ready` 必须先持久化 marker/patch，再发送事件，避免 UI 展示不存在的结果。事件只是低延迟 UI hint，允许因无 `chatRun`、session 切换、renderer reload 或窗口销毁而丢失；磁盘 marker/list 才是权威。renderer 处理任何事件后以及项目打开/恢复时都无条件按 binding 调 list reconciliation，不能依赖事件曾经到达，也不能把 event 中的 state 覆盖较新的磁盘状态。

---

## 8. Renderer 与恢复 UI

### 8.1 session 轻量状态

```js
session.pendingWorktreeResults = [{
  id,
  projectId,
  sessionId,
  subagentId,
  goal,
  state,
  createdAt,
  baseHead,
  incomplete,
  stats,
  files,
  filesTruncated
}]
```

不保存 patch、diff preview、checkout absolute path 或 marker error detail。纯 helper 负责旧 session 缺字段、坏项过滤和按 id 合并；不设置 renderer/session unresolved 上限，磁盘每 canonical project 3 个的限制是唯一权威。resolved 记录只保留最近 20 条轻量状态；unresolved 不能因 UI 修剪被静默丢弃，以磁盘 list 为准重新补回。

JSON/Markdown 会话导出继续使用固定字段白名单，必须显式测试 worktree result、goal、文件列表和 preview 均不进入导出。

### 8.2 聊天待审卡

卡片位于聊天时间线/消息列表中，不新增工作台页，也不嵌套卡片。内容：

- “隔离改动待审” + state；
- 子任务 goal、创建时间、baseHead 前 8 位；
- 文件数、additions/deletions、二进制数；
- incomplete、oversize、conflict、cleanup warning 的明确状态行；
- 文件列表折叠区；
- “查看 diff”按需加载 bounded preview；
- “应用全部”“丢弃”“在资源管理器中打开”；
- `applied_cleanup_pending` / `discarded_cleanup_pending` 时只显示“重试清理”和打开目录；`collect_failed` 显示“重试收集”、打开与丢弃。

应用按钮文案必须包含文件数，且不会因 permissionMode=full-auto 自动触发。整批操作期间锁定本卡操作；其它 pending 卡仍可查看。发送新消息仍可用，但 pending 区提示“主项目变化后此结果将无法直接应用”。

### 8.3 启动恢复

renderer 加载本地 projects 后，先为每个当前项目取得新的 `projectBindingId`，再调用 `listWorktreeResults`（可串行或限制并发），按 marker `sessionId` 合并；sessionId 仅决定展示位置：

1. 原 session 存在且仍绑定同一 project：放回该 session。
2. 原 session 不存在：挂到该 project 的 project chat；若尚未创建 project chat，放入 app 内存态 `recoveredWorktreeResultsByProject[canonicalProjectIdentity]`，值为 sanitized result refs。该缓存不进 localStorage，启动时总能从磁盘重建；创建/打开 project chat 时按 id 合并并清掉对应 cache bucket。
3. project 已删除：不扫描已删除的路径，也不把结果移给其它项目；用户重新以原 canonical 路径添加项目后由磁盘恢复。
4. project 已换路径或经 alias/case 重新绑定：只按 canonical identity 合并；不同 identity 不接管旧结果，相同 Windows identity 不重复计数。

恢复只读取带合法 v1 marker 的直接子目录。每次读取前重做 no-reparse 与 Git registration 校验；未知目录、marker 损坏、路径不匹配或 symlink 只返回 warning，不自动删除。状态对账如下：

- `creating`：有匹配 registration 才转 `running` 并 incomplete collect；没有 registration 时只清理已验证的空/marker-only result dir，无法证明则 warning 保留。
- `running/collecting`：确认匹配 worktree 后 incomplete collect；不能确认则 `collect_failed`。
- `applying`：按第 6.3 节 alternate-index 判定为 `ready`、`applied_cleanup_pending` 或 `apply_uncertain`。
- `applied_cleanup_pending` / `discarded_cleanup_pending`：只尝试/提示 cleanup，绝不重新应用或改变主树。
- `ready/collect_failed/oversize/conflict/apply_uncertain`：保留原用户动作边界并重新计算 capability；非法 transition fail-closed。

`listWorktreeResults` 本身只做验证、sanitize 与列举，active run 中也不改变 marker/index/主树。发现上述需恢复状态时，main 把 canonical project 放入内部 recovery queue；队列只在取得全局 mutation gate、且无 active chat/manual terminal 时执行状态转换，然后发送 `worktree-recovered` hint。忙时 list 返回当前安全 capability 与 `RECOVERY_DEFERRED_BUSY` warning，renderer 保留卡并在 idle/event 后重新 list。

### 8.4 active run 与直接 IPC

- `BUSY` 沿用当前 main 的全局范围：任一 session/project 的 active chat 或 manual terminal 存在时，应用、丢弃、重试收集和清理都返回 `BUSY`；renderer 禁用按钮并提示先停止或等待。反向地，worktree mutation/recovery 临界区内新 chat/manual terminal 也返回 `BUSY`。
- mutation gate 检查必须位于 `chat:send`/`startChatRun`（在既有 `abortActiveRun()` 之前）、`chat:approvePlan`、`terminal:run` 与 subagent worktree create 入口；命中时直接返回 `BUSY`，不得先 abort 当前 lifecycle task。worktree mutation handler 则先检查 `activeRun/manualTerm`，再原子占用 gate。
- 查看详情和打开目录是只读，可在生成期间使用。
- apply/discard 是用户直接 UI 动作，类似 D.4 `memory:accept`；不复用 active PermissionGate，也不制造第二张审批卡。

---

## 9. 错误、安全与隐私

### 9.1 稳定错误码

| code | 含义 | 结果处理 |
|------|------|----------|
| `NOT_GIT_REPO` | 不在 Git working tree | 不创建、不回退 |
| `NO_HEAD` | 空仓库或 HEAD 不可解析 | 不创建 |
| `DIRTY_BASE` | 创建前整个 repo 非干净 | 不创建 |
| `UNSUPPORTED_GITLINK` | bound project 内存在 tracked nested submodule/gitlink | 不创建、不回退 |
| `PENDING_LIMIT` | 未处理结果达到 3 | 先处理旧卡 |
| `EXCLUDE_FAILED` | 无法保证临时目录被 Git 忽略 | 不创建 |
| `WORKTREE_CREATE_FAILED` | git add worktree 失败 | best-effort 清理/恢复 marker |
| `COLLECT_FAILED` | patch 生成失败 | 保留 checkout，禁止应用 |
| `PATCH_TOO_LARGE` | 完整 patch >16 MiB | 保留 checkout，禁止应用 |
| `BASE_CHANGED` | HEAD 与 baseHead 不同 | 保留结果 |
| `WORKTREE_DIRTY` | 主 repo status 不为空 | 保留结果 |
| `PATCH_CONFLICT` | apply check 失败 | 保留结果 |
| `APPLY_UNCERTAIN` | apply 后状态无法证明 | 禁止重试/清理，人工检查 |
| `CLEANUP_FAILED` | 已应用/丢弃但移除失败 | 不重做动作，只重试清理 |
| `PATH_UNSAFE` | pathspec、symlink/reparse 或 canonical 边界失败 | 停止操作、保留可验证现场 |
| `GIT_METADATA_CHANGED` | worktree registration、git-dir 或 `.git` 指针失配 | 禁止收集/应用/删除 |
| `PATCH_INVALID` | raw manifest、symlink mode、hash/bytes 或范围校验失败 | 禁止应用 |
| `RESULT_NOT_FOUND` | marker 不存在，或 result 不属于该 canonical project | 不泄露其它项目路径 |
| `BUSY` | active run/terminal 存在 | 稍后重试 |

### 9.2 路径与命令安全

- 小型 Git 调用使用 `execFile('git', args)`，patch/`-z` 输出使用 `spawn('git', args)` 流式处理；两者都传参数数组且不经过 shell。
- result id 只由主进程生成并匹配固定 ASCII 形状；renderer/model 不能指定目录名。
- 创建以及每次读取、apply、open、remove 前重新验证 canonical project root、dedicated root、marker id、直接子目录关系和 worktree registration。
- 逐组件拒绝 dedicated root、result dir、marker、patch、checkout、bound project 受影响路径中的 symlink/junction/reparse point；隔离工具同时拒绝 `.git` 和 Git 管理路径。
- `git worktree remove` 后才删除 artifact dir；不手工删除 Git common dir 的 worktree 管理项。
- marker 全部权威候选字段都从 canonical payload、Git 和 checkout 重新计算；patch SHA-256、size、raw manifest、重新生成 bytes 必须一致。
- raw NUL manifest 独立校验 rename/copy 两端、binary、quoted/newline path 和 old/new mode；absolute、`..`、非 literal bound pathspec、symlink/gitlink mode 或 malformed 记录均禁止应用。

### 9.3 权限与外部副作用

隔离只保护主工作区文件，不是 OS 沙箱。D.5 子 Agent仍不具备 terminal、delete、MCP、Skills、Hooks 或网络工具，child settings 强制关闭 web；因此不会通过 D.5 新增命令执行或出网路径。read/write 工具使用第 4.4 节的 canonical no-reparse fence，不能只调用现有 lexical `resolveSafe(childProjectPath)`。

用户或其它进程可直接修改隔离目录或主仓库。D.5 通过 hash、baseHead、clean status 和 apply 前重检降低风险，但不宣称跨进程事务锁。检测到不确定状态时必须停下并保留现场。

### 9.4 补丁隐私

- 完整 patch 只保存在项目 `.codex/worktrees`，直到应用/丢弃清理；它可能包含源码或秘密。
- 不把完整 patch、absolute checkout path 或 marker 送给模型、usage、memory candidate 或 session export。
- renderer preview 是用户主动展开的 bounded 本地内容；不写 localStorage。
- README 提醒 `.codex/worktrees` 是本地临时资料，应用/丢弃后会清理；合法 pending 不会被启动自动删除。

---

## 10. 测试计划

### 10.1 `tests/worktree.test.js`

使用 `os.tmpdir()` 临时 Git 仓，所有 Git identity 在 repo local 配置；无网络：

- repo root 与绑定子目录的 `projectRel/childProjectPath`；
- 非 Git、空仓、Git 缺失/exec error；
- `.git/info/exclude` 使用 literal gitignore encoder，幂等、并发保留双方内容、原子写后 `check-ignore` 验证且不修改 `.gitignore`；magic 邻近路径不被误忽略，CR/LF/不可无损路径与 common-dir/exclude reparse 拒绝；
- tracked/untracked/staged dirty 都拒绝；普通 ignored 文件允许，D.5 root 本身被正确忽略；
- detached + locked worktree 创建，HEAD 精确等于 baseHead；
- bound project 内 tracked gitlink 返回 `UNSUPPORTED_GITLINK`；直接绑定 submodule repo 可创建；worktree 中新增/staged mode `160000` 收集失败且现场保留；
- 目标预存在、artifact TOCTOU 替换、symlink/reparse、Windows `FILE_ATTRIBUTE_REPARSE_POINT`/junction/case alias、检测能力缺失和路径越界拒绝；
- 收集文本新增/修改/删除/rename、mode 和二进制 patch，8-16 MiB 原始字节流不受现有 8 MiB runner 限制；
- 只收 literal bound project pathspec，不纳入 repo 其它子目录；覆盖目录名中的 `*`、`?`、`[` 与 `:(...)`；
- raw manifest 覆盖 rename 两端、binary、mode-only、引号/换行文件名；absolute、`..`、out-of-project、malformed 与 symlink mode 拒绝；
- tracked symlink 作为 child 写入父组件时拒绝；main tree ignored junction/reparse 位于 patch 目标父组件时 apply 拒绝；
- checkout `.git` read/write 拒绝；collect/apply/remove 前 `.git` 指针、git-dir/common-dir/top-level/HEAD/lock/registration 篡改拒绝；
- bound project 内 tracked gitlink/submodule 拒绝；submodule 自身作为独立绑定 repo 可用；collect/apply 中新增的 mode `160000` 也拒绝且不清理主树；
- 无变更立即清理；incomplete 有变更保留；
- patch/hash/marker 的 temp-fsync-rename-parent-fsync 顺序、进程崩溃恢复、torn/missing artifact fail-closed、16 MiB 超限、文件列表截断；
- apply 成功后 HEAD/index 不变、主树是完整 unstaged change；plain apply 不使用 `--3way`；
- changed HEAD、dirty status、patch hash/path 越界严格拒绝且 worktree 保留；
- apply check 失败时主树不变；模拟 check 后外部并发修改，任何不能精确证明的结果进入 uncertain；
- fixed `PATCH_DIFF_ARGS` 在 collect/retry/apply 前一致；alternate index 安全独占、拒绝 stale lock，从 baseHead 捕获 untracked 新文件、删除、rename、binary 和 repo 外额外变化，以 `write-tree` 对账且主 index/lock 不被触碰；
- discard/unlock/remove 使用 registration + no-follow 校验；两类 cleanup pending 可重试且不重做 apply/discard；
- repo 本身是 linked worktree、Windows 空格/中文路径（平台支持时）。

### 10.2 `tests/worktree-state.test.js`

- marker v1 字段、state transition 白名单、时间/字符串/文件列表上限；
- 非法 id/version/path/hash/state 拒绝；
- sanitized list/get 不泄露 patch/repoRoot/checkout；
- ready/oversize/collect_failed/conflict/applying/apply_uncertain/applied_cleanup_pending/discarded_cleanup_pending capability flags；
- resolved 与 unresolved 排序；canonical project 的磁盘 unresolved 上限固定为 3，renderer 不另设上限。

### 10.3 Runtime / provider / permission

- `spawn_implement` 外层仍 risk write，plan/read-only 不创建；
- worktree manager fake 验证 child 收到隔离 project path；parent project 未改；
- isolatedGate 在 create 后新建，只允许安全 read/write，拒绝 `.git`、reparse、network 和其它 risk；parent `allow_session`、full-auto 不能扩大 child 白名单；
- child 强制 `webEnabled:false`，即使 parent 启用 web 也不暴露/执行 `web_fetch`；
- C.4 implement 工具白名单、depth=1、互斥、abort 保持；
- terminal reason 明确区分 completed/max_turns/error/aborted；abort 后 collect/cleanup 使用独立 lifecycle signal；
- changed result/`SUBAGENT_END` 只返回 opaque summary，child `fileChanges` 不进入父结果或事件，父 run 不合并；无变更不发 ready；
- 非 Git/create/collect failure 不调用 direct parent write fallback；
- full-auto 只跳过入口弹卡，不自动应用。

### 10.4 IPC 与 renderer

- bind 签发的 `projectBindingId` 按 `webContents` 隔离且不持久化；payload 不能传 project path/patch/checkout/hash/session，stale token、rebind、canonical project/id mismatch 返回 not found，session 删除不影响项目级授权；
- 任一项目 active chat/manual terminal 时 mutation IPC 全局 BUSY，只读 get/list/open 可用；mutation 期间另一 session 的新 chat/manual terminal 也 BUSY；
- cleanup/retry-collect 通过真实 IPC 可达并覆盖 ready/no_changes/oversize/failure/重复已清理响应；apply 后自动 cleanup 与新 run 启动互斥；
- list/recovery 对损坏/篡改 marker 和未知/reparse 目录只 warning、不删除；creating/running/collecting/applying/两类 cleanup pending 均有恢复用例；
- apply/discard 幂等：已应用不能再 apply，cleanup retry 不重做动作，discarded cleanup 不改主树；
- session state 规范化、result id 去重、canonical alias 合并、不同 project rebind 不接管旧结果；
- worktree-ready 在 session 保存轻量 ref；无 `chatRun` 的 late event、session 切换与 reload 即使丢事件也由 list 对账恢复；
- preview lazy 且不进 localStorage；open 目标由 main 推导为 child project，renderer path 注入拒绝；
- 应用/丢弃/冲突/oversize/incomplete/cleanup 卡状态与按钮；
- pending 时继续发送可用；active run 中按钮禁用；mutation gate 分别在 `chat:send`、`chat:approvePlan`、`terminal:run`、worktree create 前验证且不会先 abort；
- app reload 后 marker 恢复到原 session；缺 session 进入项目 chat/内存 cache，删除 project 不迁移，重新添加原 canonical path 后恢复；
- Markdown/JSON export 不包含 result/goal/files/preview。

### 10.5 回归与手工冒烟

- 全量 `npm test`；所有 JS `node --check`；`git diff --check`。
- confirm-writes：spawn 入口审批一次，子写不再逐项审批，主树保持干净。
- full-auto：子任务完成仍只出现待审卡，必须手动点应用。
- text + new + delete + rename + binary 结果整批应用；`git status` 精确符合卡片。
- pending 期间手改主树后点击应用，卡片冲突且无额外写入。
- 应用成功不 staged、不 commit、不自动 test；worktree 与 artifact 被清理。
- 强制退出后重启：ready 和 running/incomplete 可恢复；applying 状态用 tree OID 判定且不自动重放；断电耐久性只按第 5.3 节边界承诺。
- `1100x720` 与 `900x580`：卡片、长路径、diff、按钮无溢出或重叠。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 项目内 nested worktree 污染 status | 先写 common `info/exclude`，再 clean check；失败关闭 |
| checkout 体积大 | 单次生命周期、每项目 unresolved 上限 3、处理后立即清理 |
| 主树运行期间变化 | apply 前 HEAD + 全 status 严格重检；变化即保留并冲突 |
| binary/rename patch 丢信息 | fixed Git patch args + temp-index apply + tree OID + raw NUL manifest，对 rename 两端与模式做结构化校验 |
| 外部竞态造成部分/额外落盘 | `--check` + plain apply + 同 base clean 前置 + alternate-index 精确后验；无法证明即 uncertain，不承诺事务回滚 |
| 崩溃重复应用 | marker applying 状态；恢复用 alternate index 纳入 untracked 的 full-tree OID + base index 判定，未知即停 |
| 清理误删用户目录 | opaque id、canonical direct child、逐操作 no-reparse、组合 registration、no-follow；外部替换竞态失败保留 cleanup pending |
| full-auto 破坏隔离承诺 | full-auto 只允许生成隔离结果；主树应用始终 UI 显式动作 |
| renderer/localStorage 泄漏源码 | 只存摘要与 id；完整 patch/preview 不持久到 session/export |
| 非 Git 项目功能回归 | 明确 fail-closed 文案；主 Agent现有写工具不受影响，只有 spawn_implement 要求 Git |
| 外部进程竞态 | repo mutex + apply 前重复检查；异常后 `apply_uncertain`，不承诺跨进程锁 |

---

## 12. 实现顺序建议

本节描述依赖顺序，不替代逐步骤实施计划：

1. `worktree-state` marker/schema/state 纯函数与测试；
2. `worktree` Git runner、exclude、preflight、create/cleanup 与临时仓测试；
3. collect 完整 patch、hash、limits、apply/discard/recovery；
4. subagent runtime + isolatedGate + provider/result/event 集成；
5. main manager 注入与 list/get/apply/discard/retry-collect/cleanup/open IPC；
6. renderer session state、聊天待审卡、lazy preview 和恢复；
7. export/usage/memory 非披露回归、README、全量测试和桌面冒烟。

---

## 13. 文档交付

- 本规格：`docs/superpowers/specs/2026-08-10-phase-d5-worktree-isolation-design.md`
- 实现计划：用户批准本规格后生成到 `docs/superpowers/plans/2026-08-10-phase-d5-worktree-isolation.md`
- README：实施阶段新增 Phase D.5，并修订 C.4 “无 worktree”说明为历史基线
- 执行状态：实施验收后更新，不在设计阶段宣称 D.5 已交付

---

## 14. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-08-10 | 初版：锁定单次 `spawn_implement` worktree、项目内 `.codex` artifacts、clean base、完整 Git patch、聊天显式整批应用与崩溃恢复 |
| 2026-08-10 | 复审定稿：补齐 no-reparse/`.git` 防护、literal pathspec、流式 patch、alternate index 恢复、非事务 apply 契约、项目级授权、cleanup/retry IPC 与丢事件对账 |
