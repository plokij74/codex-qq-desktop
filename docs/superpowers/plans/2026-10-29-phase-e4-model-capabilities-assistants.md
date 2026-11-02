# Phase E4：模型能力管理与真实 AI 助手会话实施计划

**状态：相关代码已实施，2026-11-02 的 E4 离线专项为 691/691；完整回归在明确的 600 秒文件预算下为 1879 pass / 0 fail / 0 cancelled / 1 skip，隔离实际 Electron 14 项检查通过。首轮 120 秒完整回归的两个取消及全部证据见[实现与验证记录](<2026-10-30-e4-implementation-verification.md>)。真实端点尚未获得授权，E4 正式验收仍开放。**

设计依据：[E4 设计规格](<../specs/2026-10-29-phase-e4-model-capabilities-assistants-design.md>)。

所属阶段：[Phase E 总计划](<2026-10-15-phase-e-product-readiness.md#L118-L128>)。静态检查基线：`a77ac04b412cef0559eb930b765254bce333576c`。

本文最初为规划快照，之后已按用户授权落地相关业务代码。下方分步骤保留原开发与验收清单；当前实现、实际 RED→GREEN、全量结果、Electron 证据和真实端点未关闭项统一登记在[实现与验证记录](<2026-10-30-e4-implementation-verification.md>)，不将计划命令或历史通过数当作本轮执行证明。

## 0. 固定决策与实施纪律

1. 首批完整支持 `openai-chat-completions`、`openai-responses`、`anthropic-messages`，不能删掉后两者只交付 Chat Completions。
2. model adapters 与现有工具 providers 分层；所有生产模型消费者共享 router 和显式 binding。
3. 密钥主进程保管；公开 DTO、消息、错误、usage、诊断、localStorage 与子进程不携带明文秘密。
4. 能力声明/实测/未知、凭据已保存/认证已验证、本地模拟/API 真实调用明确区分。
5. 默认不自动重试、降级、改模型/端点或用模拟回复兜底。文本工具兼容须明确选择，且仍经过角色策略与 E3 Gate。
6. 保留全局单前台 chat/Plan/手动 compact 租约，改为 BUSY、不暗中停止旧运行；stop 带 sessionId/runId 并校验 owner。诊断/audit 保持各自有限任务边界，不扩展为 E10 调度器。
7. 新助手默认无工具、无项目知识/记忆，不能把“复用 Codex”当作已经实现角色隔离。
8. E2 消息 schema 保持 v2 的有界增量；session 容器升 v3；settings modelRegistry 单独 schema v1。保留旧数据和幂等迁移。
9. 附件解析/看图、完整任务调度、恢复、多人联系和完整计价不偷渡进本期。
10. 实现遵循 RED → 最小实现 → GREEN → 回归。使用行为/请求断言，不仅以源码字符串存在作为验收。不自动提交 Git、不安装新依赖、不用 `git add .`。

### 0.1 前置现状与分层门槛

[E2/E3 最新前置记录](<2026-10-28-e2-e3-frontgate-closure.md#L65-L91>)保留专项通过但全量/正式验收未闭合的事实。本文不改写这些历史状态。

- 可以开始 E4 契约、adapter、迁移等独立模块的实现。
- 进入 E4 集成验收前，核对会影响新链路的 E2/E3 运行/消息/Plan/Gate/秘密回归。
- 全量不稳定、原生模块环境或真实端点缺失须按影响面记录，不用 fixture 成功掩盖。
- 不因为前置尚未全绿就放弃文档工作，也不因为文档已完成就勾选 E4 或 E3。

### 0.2 工作方式

每个任务建议保持一个可独立审查的 diff，但无需自动 commit。新文件路径均为计划新增；指向已有文件的链接是静态基线参考，不代表本轮编辑了它们。测试命令只在对应测试文件已创建后运行；先确认 Node/npm 与项目规定一致，记录实际版本，不在本轮升级工具链。

## 1. 任务总览与依赖

| 任务 | 交付 | 前置 | 主要验收 |
| --- | --- | --- | --- |
| E4-00 | 基线、fixture、调用入口清单 | 无 | AC-12 |
| E4-01 | 配置 schema、能力、版本与迁移 | E4-00 | AC-03 |
| E4-02 | 凭据事务与公共配置 IPC | E4-01 | AC-03 |
| E4-03 | 统一 router/内部消息契约、Chat adapter | E4-01 | AC-01/05 |
| E4-04 | Responses adapter | E4-03 | AC-01 |
| E4-05 | Anthropic adapter | E4-03 | AC-01 |
| E4-06 | 错误、usage、价格和无隐式重发 | E4-03/04/05 | AC-04/05 |
| E4-07 | 所有消费者显式绑定 | E4-02/06 | AC-04 |
| E4-08 | 助手策略与 E2 Plan 绑定 | E4-07 | AC-08/09 |
| E4-09 | 主进程接受/租约/定向取消 | E4-07/08 | AC-07/09 |
| E4-10 | 会话迁移、draft/outbox、来源与事件 | E4-09 | AC-06/07 |
| E4-11 | 配置/助手/聊天真实 UI | E4-02/10 | AC-06/11 |
| E4-12 | 合成能力诊断与可取消 UI | E4-06/11 | AC-10 |
| E4-13 | 跨协议/消费者/渲染与前置回归 | E4-08/09/10/11/12 | AC-01/03..11 |
| E4-14 | 真实端点、Electron 与验收登记 | E4-13 | AC-02/11/12 |

可以并行的边界：E4-04 与 E4-05 可在 E4-03 契约固定后并行；E4-02 可与 adapters 并行；E4-10 helper 单元可与 main 运行入口改造并行。不得在共享契约尚未固定时各自发明字段，或同时编辑同一主文件而不明确整合人。

<a id="e4-00"></a>
## Task E4-00：登记基线、fixture 与入口清单

**目标：**让后续变化可比较，区分已有环境问题、历史记录与新引入结果。

参考：[包脚本](<../../../package.json>)、[前置执行记录](<2026-10-28-e2-e3-frontgate-closure.md>)、[现有事件 harness](<../../../tests/renderer-chat-event-order.test.js>)。

拟新增 fixture 目录 `tests/fixtures/e4-models/`，只放清楚标注的合成请求/响应和旧配置/会话样本，不放真实 key、私有代码、真实聊天、用户路径或原始上游日志。

- [ ] 记录当前提交、工作树范围、Node/npm/平台；保留用户已有改动，不重置工作区。
- [ ] 列出普通聊天、Agent、自动/手动 compact、记忆候选、MCP sampling、PR audit/工程任务的入口、绑定与 usage 上报位置。
- [ ] 建立 Chat/Responses/Anthropic 的文本、工具两轮、流式分片、usage、普通错误、取消 fixture；记录字段对应协议，不混用响应。
- [ ] 建立 v2/legacy 会话、旧单模型配置、vault 引用不可用、未知高版本的合成迁移样本。
- [ ] 在获得后续实施授权的环境记录必要的既有专项基线；本轮不执行，不把历史通过数抄成本轮结果。

**完成门槛：**fixture 可公开、无真实秘密；入口清单覆盖规格消费者表；开放前置项有具体记录。

<a id="e4-01"></a>
## Task E4-01：版本化模型/助手配置与幂等迁移

**目标：**先固定可测试的数据权威，避免 UI 与 adapters 各自解释配置。

目标：拟新增 `src/ai/model-profiles.js`、`tests/e4-model-profiles.test.js`、`tests/e4-settings-migration.test.js`；修改[settings](<../../../src/ai/settings.js>)，复用[SecretManager](<../../../src/ai/secret-manager.js>)。

**RED：**

- [ ] 验证 schema、ID/引用、长度/数量、协议/auth/URL/参数组合、default 指向与 unknown 高版本。
- [ ] 区分能力三态与 declared/observed/unknown；配置 CRUD revision 与 wire bindingRevision 指纹分开，名称变化不失效，wire/credential 变化使证据 stale，能力结果不使自己的指纹变化。
- [ ] 旧 baseUrl/model/secretRef/mode 迁移为固定 ID，不丢其他 settings；迁移两次无重复 profile。
- [ ] 迁移失败保留原配置；vault 不可用标 unavailable，不清空、改 provider 或变 local 模拟兜底。

**最小实现：**

- [ ] 落地规格的 registry/provider/model/assistant schema、公共 DTO 和 expectedRevision 规则。
- [ ] 新助手无工具/知识；内置 Codex/general 身份与 legacy model/provider 的稳定 ID 固定。
- [ ] 明确 provider/model/assistant 活引用与历史来源的区别；删除前校验，不级联删历史。
- [ ] 实现一次性备份与原子设置提交，未知版本拒绝覆盖；公开旧 aliases 仅兼容读取，不能成为新配置权威。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-profiles.test.js tests/e4-settings-migration.test.js
```

**完成门槛：**AC-03 的数据/迁移部分；fixture 不要求真实 userData 或真实 vault。

<a id="e4-02"></a>
## Task E4-02：凭据事务与公共配置 IPC

**目标：**模型数量增加但秘密暴露面不增加。

目标：拟新增 `src/ai/model-ipc.js`、`tests/e4-model-ipc.test.js`、`tests/e4-credential-lifecycle.test.js`；修改[主进程注册](<../../../src/main.js#L527-L610>)、[preload](<../../../src/preload.js>)，必要时扩展[settings](<../../../src/ai/settings.js>)与[SecretManager](<../../../src/ai/secret-manager.js>)。

**RED：**

- [ ] 模型/助手 list/save/remove 与 models:setDefault 校验 revision、引用、sender 和 public projection；默认值更新可保存/重载，冲突不覆盖，活跃运行绑定不漂移，不自动外发或切 mode。
- [ ] setCredential/clearCredential 不回显、不把 key 交给 renderer；空输入保持，清除独立显式。
- [ ] 新秘密保管/提交前失败保持旧引用与 revision；提交后旧记录退休失败保留新配置/新 revision 并返回 cleanup pending。clear 提交后清理失败仍为已解除，不回滚或声称彻底删除；retryCredentialCleanup 幂等且不删除有效引用。
- [ ] origin/auth 改动要求重绑；明文 HTTP 确认只对该 origin 有效；占用的端点/凭据不能直接换掉。

**最小实现：**

- [ ] 按规格的有限 IPC 表注册并返回统一公共 DTO/错误；不增加通用读取 key 方法。
- [ ] 实现“新 secret → 配置原子换引 → 退休旧 secret”事务及私有 cleanup journal；models:retryCredentialCleanup 幂等重试，独立展示 clean/pending，始终返回当前公共配置，不误删共享有效引用。
- [ ] preload 暴露有限方法与订阅卸载；凭据输入仅用于本次 IPC，提交后清空输入框。
- [ ] 保留既有 settings:get 的无明文语义；旧 settings 保存入口不能覆盖新 registry，旧 UI 同步升级。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-ipc.test.js tests/e4-credential-lifecycle.test.js
```

**完成门槛：**AC-03 的事务/IPC 部分；无外部请求、无真实凭据读取。

<a id="e4-03"></a>
## Task E4-03：统一 router 与 Chat Completions adapter

**目标：**先建立一个规范，保留 Chat 兼容并防止新的全局配置旁路。

目标：拟新增 `src/ai/model-router.js`、`src/ai/model-adapters/index.js`、`src/ai/model-adapters/openai-chat.js`、`tests/e4-model-router.test.js`、`tests/e4-openai-chat-adapter.test.js`；复用[既有 Chat 请求实现](<../../../src/ai/openai-compatible.js>)与[现有流式行为测试](<../../../tests/openai-compatible.test.js>)。

**RED：**

- [ ] 验证已解析 binding、统一消息/工具/结果与事件，不接受 renderer 自造 secret/endpoint binding。
- [ ] Chat 的系统提示、tool call ID/参数、工具结果、finish reason 与 usage 正确转换。
- [ ] max_tokens/max_completion_tokens 明确映射；无配置不注入 temperature；unknown/unsupported 的文本、工具和流式按规格处理。
- [ ] 请求/响应/SSE/参数限额、取消、正常终止、部分 EOF 与 reader/timer 清理正确。
- [ ] stream auto/off/on、includeUsage 和 text-compat 是配置决策，不在失败后自动换一套请求重发。

**最小实现：**

- [ ] 落地规范类型的运行时校验、统一 fetch/事件/错误边界与预算/AbortSignal。
- [ ] 用 wrapper 复用已有 Chat wire 代码；规范化边界只做一次，保留测试注入，不复制一份发送器。
- [ ] adapter registry 固定白名单；不允许模型响应或 renderer 动态加载任意代码。
- [ ] 保留明确的旧调用兼容 wrapper，标出退出路径；不得新增一个默认读全局 settings 的生产入口。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-router.test.js tests/e4-openai-chat-adapter.test.js tests/openai-compatible.test.js
```

**完成门槛：**Chat 请求级 AC-01 与 router 能力/预算部分；保持旧 Chat fixture 可比较。

<a id="e4-04"></a>
## Task E4-04：实现 OpenAI Responses 全链路

**目标：**不是更换 endpoint 名称，而是真正映射 Responses 协议。

拟新增 `src/ai/model-adapters/openai-responses.js`、`tests/e4-openai-responses-adapter.test.js`。

**RED：**

- [ ] instructions/input、max_output_tokens、store:false、文本 output items 与 finish reason 正确。
- [ ] function definitions、function_call 的 call_id、function_call_output 和两轮工具结果保持对应。
- [ ] 对所选支持模型保留必要 output/运行内续接状态，不能丢弃后再提交只有 function result 的残缺第二轮。
- [ ] SSE 文本和参数按 item/call 标识累积；中断/不完整终止不能变成功；取消后无工具调用。
- [ ] required-but-unimplemented reasoning/hosted/background 特性明确报不支持；运行内不透明 state 不进入消息/日志/export。

**最小实现：**

- [ ] 接入统一 adapter 契约、错误/预算/取消与 usage；不依赖持久服务端 previous_response_id。
- [ ] 用确定性两轮 fixture 检查完整 request body，而不只检查返回字符串。
- [ ] endpoint 前缀保留，不因失败自动切 Chat 或换 origin。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-openai-responses-adapter.test.js tests/e4-model-router.test.js
```

**完成门槛：**Responses 离线 AC-01；真实 endpoint 仍待 E4-14。

<a id="e4-05"></a>
## Task E4-05：实现 Anthropic Messages 全链路

**目标：**正确区分 system、content blocks、工具往返和缓存 usage。

拟新增 `src/ai/model-adapters/anthropic-messages.js`、`tests/e4-anthropic-messages-adapter.test.js`。

**RED：**

- [ ] 顶层 system、消息顺序、x-api-key、anthropic-version、必填 max_tokens 和可选 temperature 正确。
- [ ] tool_use id/name/input 与下一轮 user tool_result 对应，多个工具结果和普通文本保持正确顺序。
- [ ] message_start/content_block/message_delta/stop 的文本、工具参数和 usage 累积语义一致。
- [ ] cache read/create 与普通输入只计一次；缺字段保持未知。
- [ ] 取消、普通 HTTP 错误、未完成 blocks 和 EOF 产出统一失败，不用部分参数执行工具。

**最小实现：**

- [ ] 接入同一 ModelTurn，不向 Agent 暴露 Anthropic 独有的任意 raw payload。
- [ ] 合法 root + messages endpoint 构建、认证头与公共错误净化按 adapter 管理。
- [ ] 非流式和流式共用最终规范化结果；不将 extended thinking 当本期已支持。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-anthropic-messages-adapter.test.js tests/e4-model-router.test.js
```

**完成门槛：**Anthropic 离线 AC-01；真实 endpoint 仍待 E4-14。

<a id="e4-06"></a>
## Task E4-06：统一错误、usage、价格归属与无隐式重发

**目标：**不同协议共享可信状态，不能由消费者再套一层猜测式兼容。

目标：拟新增 `tests/e4-model-errors-usage.test.js`；修改[usage 归一化/价格](<../../../src/ai/usage.js>)、[usage store](<../../../src/ai/usage-store.js>)、[Agent 兼容逻辑](<../../../src/ai/agent.js#L1521-L1554>)与[PR audit 调用](<../../../src/ai/pr-audit-runtime.js#L44-L69>)。

**RED：**

- [ ] 普通 400/401/403/404/429、明确能力错误、网络/超时、空响应、部分响应、取消具有各自安全语义。
- [ ] 普通失败、stream_options 不兼容、工具不兼容都不自动产生第二个物理请求；错误分类不依赖宽泛 `/400/`。
- [ ] 同一 usage 只入账一次，normalized/raw 兼容边界不会重复算缓存；actual/estimated/unavailable 不混为零。
- [ ] 不同 provider 的同名模型不合并成同一来源；旧 usage 和价格只迁 legacy/unknown，不按当前模型重写。
- [ ] 部分输出保留失败状态；重试新 attempt 与旧请求可能计费的事实可见。

**最小实现：**

- [ ] 落地规格 ModelError/NormalizedUsage 和 public source；保留安全 requestId/retry-after，不转发原始响应正文。
- [ ] 价格匹配加入 modelProfile/provider 范围，旧行迁移到 legacy provider；没价格显示未知。
- [ ] 去掉生产 Agent/PR audit 自发变更 stream/tools 重试分支；显式 text-compat 仍经过同一工具限制。
- [ ] 原有可注入 chatFn fixture 兼容保留，生产链路只走 router 规范。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-errors-usage.test.js tests/usage.test.js tests/usage-store.test.js
```

**完成门槛：**AC-05 与 AC-04 的计量部分；不是 E11 全量产品验收。

<a id="e4-07"></a>
## Task E4-07：所有模型消费者使用明确绑定

**目标：**切换模型之后，不留“后台仍打旧服务”的生产路径。

目标：拟新增 `tests/e4-model-consumers.test.js`；修改[主进程绑定入口](<../../../src/main.js>)、[Agent](<../../../src/ai/agent.js>)、[compact](<../../../src/ai/session-compact.js>)、[记忆候选](<../../../src/ai/memory-candidates.js>)、[MCP sampling](<../../../src/ai/mcp-sampling.js>)、[PR audit runtime](<../../../src/ai/pr-audit-runtime.js>)。

**RED：**

- [ ] 逐消费者注入两个明显不同的 provider/model，断言实际 fetch 的端点/协议/model 与 accepted binding 一致。
- [ ] 自动 compact 与随后的 chat 使用同一待发送绑定；不在 BUSY 检查前外发或更改另一会话历史。
- [ ] 单独 compact/记忆/审查在接受时固定目标，运行内改默认不漂移；用户能知道数据将发往哪里。
- [ ] sampling 保留逐 server 审批、context 限制、无 tools/递归、预算，不因新 profile 绕过。
- [ ] 无认证的明确本地 provider 不被 `!settings.apiKey` 一刀切；凭据不可用仍在外发前明确失败。

**最小实现：**

- [ ] 各入口调用 resolver，一次接受固定一次 binding；消费者只收已解析快照/受控调用函数。
- [ ] raw settings/baseUrl/apiKey 不再向每个消费者下传；秘密只在受控调用时解析。
- [ ] 同步 compact/memory 的温度偏好/usage callback 与 canonical 结果，保持候选失败不破坏有效摘要的既有规则。
- [ ] 记录任何为测试保留的旧 wrapper 使用点；生产调用入口审阅必须全部归零或给出明确非生产理由。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-consumers.test.js tests/session-compact.test.js tests/memory-candidates.test.js
```

sampling/audit 使用仓库实际存在的对应测试文件追加回归，不用不存在的测试名称充当通过证据。

**完成门槛：**AC-04；所有调用有 binding/usage owner，副消费者不静默换模型。

<a id="e4-08"></a>
## Task E4-08：助手知识/工具策略与 Plan 绑定

**目标：**“新助手”不只是给全功能 Codex 换头像/提示词。

目标：拟新增 `tests/e4-assistant-policy.test.js`；修改[Agent](<../../../src/ai/agent.js>)、[主进程项目绑定](<../../../src/main.js>)、[工具 dispatch](<../../../src/ai/providers/index.js>)、[Plan state](<../../../src/ai/plan-state.js>)；复用[PermissionGate](<../../../src/ai/permission.js>)与[execution policy](<../../../src/ai/execution-policy.js>)。

**RED：**

- [ ] 新助手默认不注入项目树、记忆、hooks 或项目路径，不自动展开未授权 @refs。
- [ ] 无工具助手没有 tools，也不执行文本工具块、list-tree 快捷路径或 write-fence 自动应用。
- [ ] allowlist 从工具呈现与实际执行两端生效；项目关联不等于授权；实时撤权中止相关运行。
- [ ] Plan 记录助手/模型/策略绑定；修改相关绑定后旧待批准执行入口失效，历史不丢。
- [ ] 已执行/失败/取消的 Plan 不恢复授权；纯文本助手不能靠角色提示升级工具权限。

**最小实现：**

- [ ] 计算有效角色策略，统一注入 persona、知识、记忆和受限 ToolProvider。
- [ ] Codex 维持已有工程角色，但所有快捷路径同样检查策略；非 Codex 仅显式开放所需能力。
- [ ] 给 E2 Plan 增加有界 provenance/binding 字段与校验，不创建第二个 Plan 权威或复制授权记录。
- [ ] 角色/模型切换影响下一轮；工具/项目撤权立即取消，模型配置占用按规格禁止原地改 endpoint/key。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-assistant-policy.test.js tests/e2-plan-lifecycle.test.js
```

**完成门槛：**AC-08/09；无工具与受限工具路径都验证实际行为，不仅断言 UI 隐藏。

<a id="e4-09"></a>
## Task E4-09：主进程接受、运行租约与定向取消

**目标：**保持串行而不互相暗杀任务，建立可靠的运行/会话归属。

目标：拟新增 `tests/e4-main-run-ownership.test.js`；修改[chat:send/approvePlan/stop](<../../../src/main.js#L1769-L1992>)、[TaskHandle 契约](<../../../src/ai/task-contract.js>)与[preload](<../../../src/preload.js>)。

**RED：**

- [ ] 第二个会话或另一个窗口发起 chat/approvePlan 时返回 BUSY，旧任务 signal 不被取消，不产生新模型请求。
- [ ] preflight/config conflict/未知引用不接受任务；accepted run-start 与最终 invoke 始终含相同 clientRequestId/sessionId/runId/source。
- [ ] 重复活跃 clientRequestId 不产生两次模型调用/工具副作用。
- [ ] stop 的 owner/session/run 必须对应；停止期间租约不提前释放，迟到响应不执行工具或多次终结。
- [ ] 关闭窗口、项目撤权、父任务取消传播到 fetch/reader/审批/compact 子调用并完整清理。

**最小实现：**

- [ ] 从公共发送路径移除“无条件 abortActiveRun 再发送”；私有 shutdown 清理仍由主进程控制。
- [ ] chat、Plan 批准与自动 compact 采用一次接受/清理边界；BUSY 不消费旧 Plan 的执行权。
- [ ] 手动 compact 与同会话聊天的改写互斥，纳入受控前台租约/任务归属，不在运行中的历史上并发回写。
- [ ] 所有公共 chat:event/final reply 加完整公共信封；不泄露 owner 内部信息/秘密。
- [ ] 升级每个公开 stop 调用点，不保留“无参停止所有人”的兼容后门。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-main-run-ownership.test.js
```

**完成门槛：**AC-07 主进程部分及 AC-09；不顺带实现 E10 并行调度/暂停恢复。

<a id="e4-10"></a>
## Task E4-10：消息来源、会话迁移、draft/outbox 与事件隔离

**目标：**切会话/切模型不丢草稿，事件不依赖当前 DOM 才能落到正确历史。

目标：拟新增 `src/renderer/e4-chat-state.js`、`tests/e4-renderer-chat-state.test.js`、`tests/e4-session-migration.test.js`；修改[renderer app](<../../../src/renderer/app.js>)、[消息白名单/投影](<../../../src/ai/message-schema.js#L326-L427>)、[事件顺序 harness](<../../../tests/renderer-chat-event-order.test.js>)。

**RED：**

- [ ] 两会话 draft/附件引用独立；切模型、切助手、切会话、刷新后保持对应状态。
- [ ] 发送建立 outbox，BUSY/预检失败可恢复；等待期间新编辑的 draft 不被 accepted/failed 旧快照覆盖。
- [ ] 流式期间切会话、隐藏轨迹节点、invoke 早/晚于事件、先 terminal 后迟到事件都只生成一次正确归属的结果。
- [ ] v2/legacy → v3 幂等，旧 demo peer 内容/自定义标题不丢；未知高版本与写入失败不转空状态。
- [ ] modelSource 经 normalize/UI/storage/export 保留允许字段，model content 不包含 UI provenance/秘密/providerState。

**最小实现：**

- [ ] 持久化容器 v3 与有界 draftsBySession；旧容器保留，不双写两个权威。
- [ ] per-session draft + immutable outbox + clientRequestId/runId 路由，消除全局 pendingAttaches/单 DOM chatRun 的错误假设。
- [ ] Codex 旧会话绑定稳定身份；旧示例为 demo-contact；新 AI 会话显式创建。
- [ ] 历史显示实际/未知来源；当前模型切换只改变下一轮，不重标旧消息。
- [ ] 同步主进程和 renderer 的 E2 消息契约实现，不让两个版本的字段白名单漂移。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-renderer-chat-state.test.js tests/e4-session-migration.test.js tests/renderer-chat-event-order.test.js
```

**完成门槛：**AC-06 的持久化部分和 AC-07 renderer 部分。

<a id="e4-11"></a>
## Task E4-11：模型设置、AI 助手管理与真实聊天 UI

**目标：**在真实页面上完成配置和会话闭环，不只提供后端接口。

目标：拟新增 `src/renderer/e4-models.js`、`tests/e4-renderer-model-ui.test.js`；修改[renderer app](<../../../src/renderer/app.js>)、[页面结构](<../../../src/renderer/index.html>)、[现有样式](<../../../src/renderer/styles.css>)与[preload](<../../../src/preload.js>)。

**RED：**

- [ ] 三协议 provider/model CRUD、默认模型、引用/冲突错误和能力来源可见且可恢复；默认选择经 models:setDefault 保存并在重载后保持，不借旧 settings 保存入口覆盖 registry。
- [ ] key 输入的空值保持/更新/清除语义明确；configured 不是认证通过，unavailable 能解释；提交后 cleanup pending 保留最新配置并独立提示/重试，不把 UI 回退到旧 key 状态。
- [ ] 新助手默认无知识/工具，编辑模型/提示词/范围可持久化，归档保留旧会话。
- [ ] 真实 AI 与示例联系人分组，不使用“在线真人”文案；示例转用需显式确认旧历史范围。
- [ ] Chat 标题显示 AI、本地模拟/真实 API、下一轮目标与当前运行固定目标，错误时不固定回复“收到”。
- [ ] 非当前运行会话不能停止其他会话；BUSY 提示与草稿恢复实际可用。

**最小实现：**

- [ ] 提供模型/助手页或现有设置页中的清晰子区，不更换框架或启动另一个 GUI 服务。
- [ ] 新 AI 发送统一走主进程；移除真实 AI 路径的非 Codex 定时模拟分支，demo/local mode 仍明确标注。
- [ ] 切到新 provider/origin 前展示当前上下文及自动处理目标；用户确认后仅影响新请求。
- [ ] 常见失败/unknown 能力提供明确的声明/诊断/显式模式选择；不偷偷重试。
- [ ] 图片附件只显示元信息未发送的事实，即使模型能力声明 vision supported 也不伪装 E6 已完成。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-renderer-model-ui.test.js tests/e4-renderer-chat-state.test.js
```

**完成门槛：**AC-06/11 的页面行为具备离线证据；真实 Electron/真实 endpoint 待 E4-14。

<a id="e4-12"></a>
## Task E4-12：受控能力诊断与分项证据

**目标：**能力来自明确声明/本配置实测，不靠失败自动重发或模型名推断。

目标：拟新增 `src/ai/model-diagnostics.js`、`tests/e4-model-diagnostics.test.js`；扩展 model IPC/renderer helper，并复用[TaskHandle](<../../../src/ai/task-contract.js>)。

**RED：**

- [ ] 用户未启动诊断时没有网络；保存设置、填 key、启动应用不自动探测。
- [ ] check 的 body 只含合成文本/工具，绝不含聊天、项目路径、文件、附件、记忆。
- [ ] 每 check 15 s/128 输出 tokens/256 KiB，诊断最多 5 个物理请求；工具往返最多两请求且只用内存回执。
- [ ] 分项 unknown/supported/unsupported/失败不互相冒充；没有调用工具不能直接判 unsupported。unknown/unsupported 的受控 check 只能由诊断服务内部 purpose 放行，普通聊天仍阻断，renderer 不能自设该用途或自定义外发内容。
- [ ] 诊断取消/wire 指纹过期不写回新证据；仅名称修改不使已有证据过期，回写不覆盖并发声明；事件只到 owner，不混聊天历史。

**最小实现：**

- [ ] 实现独立诊断 TaskHandle、controller、预算和归属，复用 adapters/router 不复制网络实现。
- [ ] `models:diagnose/cancelDiagnosis` 与 `models:diagnostic-event` 完整接入 preload 和 UI。
- [ ] 启动前显示目标、检查项、最多请求数和可能费用；结果有时间、配置版本、数据质量和 stale 状态。
- [ ] 诊断不改变聊天 local/API mode；vision/context window 本期只登记，不主动上传图片/放大上下文探测。

**GREEN：**

```powershell
node --test --test-concurrency=1 --test-timeout=120000 tests/e4-model-diagnostics.test.js tests/e4-renderer-model-ui.test.js
```

**完成门槛：**AC-10；诊断运行不能获得项目/宿主工具执行权限。

<a id="e4-13"></a>
## Task E4-13：跨层矩阵、E2/E3 回归与文档同步

**目标：**完整请求与真实 UI 状态共同证明，而不是孤立 helper 都绿就宣布完成。

拟新增 `tests/e4-integration-matrix.test.js`；按仓库实际结构扩展[现有事件 harness](<../../../tests/renderer-chat-event-order.test.js>)和相关任务/消息/Plan/设置/usage 测试。

- [ ] 三协议 × 非流式/流式 × 纯文本/两轮原生工具至少各有请求级证据。
- [ ] 明确的 text-compat、native unsupported/unknown、stream off、usage 缺失、普通 API 错误、取消和部分输出都有断言；实际 fetch 次数符合“无隐式重发”。
- [ ] 每个模型消费者至少有两个 provider 区分用例，包含自动 compact 与记忆失败的降级结果；usage/source 归属只计一次。
- [ ] main/renderer 共同验证 BUSY、draft/outbox、clientRequestId、owner/session/run、切会话、invoke/event 重排、关闭清理和终态唯一。
- [ ] E2 normalize/projection/TaskHandle/Plan 不重放与 E3 PermissionGate/秘密投影的相关既有回归通过；开放前置项照实登记。
- [ ] 审阅生产调用点，确认没有新的全局 key/endpoint 旁路、无参 public stop 或非 Codex API 模拟兜底。
- [ ] 核对 settings/schema/session 迁移文档与真实实现一致，不把未实现字段先写成能力。

离线 E4 专项命令（仅在进入实现且测试已创建后）：

```powershell
$e4Tests = @(Get-ChildItem -LiteralPath tests -Filter 'e4-*.test.js' -File | ForEach-Object FullName)
if ($e4Tests.Count -eq 0) { throw 'E4 test files are missing; no test evidence was collected.' }
node --test --test-concurrency=1 --test-timeout=120000 @e4Tests
if ($LASTEXITCODE -ne 0) { throw 'E4 test suite failed.' }
```

相关旧测试与 full suite 依[包脚本](<../../../package.json>)在适当环境单独运行。`npm test` 可能触发既有 pretest/native build；先说明环境/副作用，不在文档任务中执行。失败、超时、skip 和环境问题逐项保留，不删除断言或禁用用例换绿色。

**完成门槛：**AC-01/03..10 的离线与集成证据齐全；仍不能替代真实端点/真实 Electron 验收。

<a id="e4-14"></a>
## Task E4-14：真实端点、Electron smoke 与最终登记

**目标：**证明具体三协议配置和真实 AI 会话可用，不把 fixture 或 skip 当厂商支持。

拟新增 `scripts/e4-electron-assistants-smoke.cjs`、可选 `tests/e4-live-models.test.js`。真实端点测试默认关闭；仅在用户明确授权端点/模型/费用并安全提供临时凭据后启用。

### A. 运行隔离与证据规则

- [ ] Electron smoke 使用独立临时 userData，不读取日常 vault/localStorage，测试后按已核对的路径清理；不覆盖用户真实工作区。
- [ ] fixture 模式与真实 endpoint 模式分开登记。fixture 模式的合成回答在页面和记录中明确标注，不产生真实通过声明。
- [ ] live manifest 只保存协议、公共 endpoint/model、认证种类和指定的凭据输入名；不写明文 key，不批量枚举环境变量，不自动复用日常配置。
- [ ] 报告仅保留规格允许的公共证据；截图检查无 key、认证头、私有聊天和路径。

### B. 三协议逐项真实检查

| 协议 | 文本 | 流式完整终态 | 合成工具往返 | 取消/部分输出 | usage 质量 |
| --- | --- | --- | --- | --- | --- |
| Chat Completions | [ ] | [ ] | [ ] | [ ] | [ ] |
| Responses | [ ] | [ ] | [ ] | [ ] | [ ] |
| Anthropic Messages | [ ] | [ ] | [ ] | [ ] | [ ] |

工具往返只使用固定内存回执，不调用项目工具或执行命令。缺少端点、模型权限、余额或凭据时，该格标未验证/阻断并写原因；不能为了矩阵好看自动换服务或将 unsupported 改成 supported。

### C. 真实 Electron 用户路径

- [ ] 创建两个非 Codex AI 助手，分别绑定已授权模型；从联系人/助手入口发送，页面 source 与实际请求一致。
- [ ] 两助手历史/草稿独立；切模型/会话不丢文本或附件元信息；刷新后归属不变。
- [ ] 一会话生成中另一会话发起发送返回 BUSY，原运行不停、草稿可恢复；非原会话不能取消它。
- [ ] 原会话停止后保留用户消息和部分输出；配置更新影响下一轮，旧消息标签不变。
- [ ] 凭据更新/清除、不可用、普通 API 失败、能力 unknown/unsupported、诊断取消/stale 都有页面证据，不回落模拟成功。
- [ ] 旧 Codex/demo 会话迁移后内容保留、身份明确；示例联系人不显示真人在线。
- [ ] local mode 与 API mode 的切换是显式操作；附件能力文案不暗示图片/文件正文已上传。

### D. 验收记录与状态更新

在本计划末尾追加实现后的执行记录，或链接独立记录；至少包含：

```text
实现提交/工作树范围：
平台、Node/npm/Electron 版本：
命令与开始/结束时间：
离线结果：passed / failed / skipped / timeout
E2/E3 相关回归与开放项：
协议、公共目标标签、model、配置 revision：
真实文本/流式/工具/取消结果及 usage 质量：
Electron fixture 结果与真实 endpoint 结果（分开）：
未验证/阻断项目、具体原因和下一步：
证据/截图位置（确认无秘密）：
最终结论：未完成 / 部分实现 / 待真实验收 / 通过
```

只有规格 AC-01..12 全部满足并有证据时，才更新 E4 为通过。G10 只关闭本期“真实 AI 助手”部分；真实联系人/社交能力仍按 E26 独立登记。G11 仅记录已测具体模型配置，不能把一个端点通过写成所有兼容厂商通过。

## 2. 需求—任务—验收追踪

| 需求 | 实施任务 | 验收 |
| --- | --- | --- |
| FR-01 三协议 | E4-03/04/05/13/14 | AC-01/02 |
| FR-02 版本化配置/能力 | E4-01/02/11/12 | AC-01/03/10 |
| FR-03 秘密与状态 | E4-01/02/06/12/14 | AC-03/10/11 |
| FR-04 全消费者绑定 | E4-06/07/09/13 | AC-04 |
| FR-05 错误/兼容/重试 | E4-03/04/05/06/11/13 | AC-05 |
| FR-06 真实身份与策略 | E4-01/08/10/11/14 | AC-06/08/11 |
| FR-07 会话/草稿/运行归属 | E4-09/10/11/13/14 | AC-07/11 |
| FR-08 E2/E3 保持 | E4-02/08/09/13 | AC-08/09 |
| FR-09 受控诊断 | E4-12/14 | AC-10 |
| FR-10 真实验收 | E4-00/11/13/14 | AC-02/11/12 |

## 3. 风险与明确处理

| 风险 | 已确定处理，不留给实现时猜测 |
| --- | --- |
| 兼容服务不支持某参数 | 明确参数/兼容配置与具体上游错误；不因 400 自动换请求 |
| reasoning 模型需要额外续接 | adapter 在运行内支持明确模型形态；无法支持则准确标不支持，不丢 state 伪成功 |
| 新助手获得 Codex 所有能力 | 默认无工具/知识，主进程有效策略控制呈现与执行，覆盖快捷路径 |
| 全局状态导致串会话或丢草稿 | accepted 边界、per-session draft/outbox、run/request 归属、BUSY 不抢占 |
| 配置/秘密半更新 | expectedRevision、原子换引用、失败保持旧配置、占用时禁止换端点/凭据 |
| 迁移覆盖用户会话 | 稳定 ID、v3 新容器、旧数据保留、幂等、错误不空白成功 |
| 真实模型不可用或有费用 | 默认不开 live；用户授权具体目标；未测保留缺口，不减范围/伪通过 |
| E2/E3 前置开放 | 独立模块可推进，集成/正式验收如实列出影响与回归结果 |
| UI smoke 只有 fixture | fixture 与真实 endpoint 分开记录，只有后者支持真实可用结论 |
| 同名模型费用混用 | provider/modelProfile 归因，旧价格局部迁移，不匹配显示未知 |

## 4. 本轮交付记录

- [x] E4 设计规格：三协议、配置/能力、凭据、助手策略、选路、生命周期、迁移、UI 与验收契约。
- [x] E4 实施计划：E4-00..14、RED/GREEN 检查、目标模块、测试矩阵与真实验收规则。
- [x] Phase E 总计划补充 E4 文档索引和范围说明，原未完成状态保持。
- [ ] E4 功能实现。
- [ ] E4 离线/集成测试。
- [ ] 三协议真实端点测试。
- [ ] 真实 Electron 用户路径验收。

**当前结论：规划与文档交付；E4 业务能力尚未由本轮实现或验收。**
