# Phase E4：模型能力管理与真实 AI 助手会话设计规格

**状态：设计已确定，待实施；不是功能完成或真实端点验收记录。**

文档日期：2026-10-29。静态检查基线：`a77ac04b412cef0559eb930b765254bce333576c`。

关联：[Phase E 总计划](<../plans/2026-10-15-phase-e-product-readiness.md#L118-L128>)、[E4 实施计划](<../plans/2026-10-29-phase-e4-model-capabilities-assistants.md>)、[E2/E3 最新前置记录](<../plans/2026-10-28-e2-e3-frontgate-closure.md>)。

本轮仅生成设计规格、实施计划与总计划索引，不修改业务代码、不读取实际凭据、不访问模型端点、不安装依赖、不运行原生构建或业务测试。本文中的“新增”“必须”“验收”均为后续实现要求，不代表已有实现。

## 一、范围、决策与完成口径

### 1.1 首批协议范围已确认

用户明确选择三种协议，三者均是本期完整交付对象，不能只做配置选项：

| 协议 ID | 正式交付 | 不据此承诺的能力 |
| --- | --- | --- |
| `openai-chat-completions` | OpenAI-compatible Chat Completions；保留现有兼容网关能力 | 不把任意“兼容”网关、模型名或非标准字段当作已验收 |
| `openai-responses` | OpenAI Responses 的文本、流式、原生工具往返、取消与 usage | 不包含所有内置 hosted tools、后台模式或任意 reasoning 扩展参数 |
| `anthropic-messages` | Anthropic Messages 的文本、流式、原生工具往返、取消与 usage | 不包含 extended thinking、Bedrock/Vertex 专用接入或 OAuth |

Gemini 原生、Azure 专用部署/认证、真实 QQ 联系人、通话、账号同步不列入本期支持。第三方网关按其实际使用的协议和具体配置记录结果，不获得“任意厂商支持”的统称。

### 1.2 本期必须完成

- **G11**：provider/model 分离配置，能力与认证状态，三协议真实实现，错误/兼容语义一致，凭据更新及受控连接诊断。
- **G10 的 E4 部分**：非 Codex 的 AI 助手走真实模型链路；身份、模型、知识范围、项目/工具限制、历史、草稿与取消归属真实存在。
- 所有现有模型调用入口统一选路，不能只替换聊天入口。
- E2 消息/任务/Plan 契约与 E3 执行/秘密边界在新链路中继续生效。

### 1.3 边界与非目标

| 本期边界 | 承接阶段 |
| --- | --- |
| 附件仍只提供已有元信息；能力表不等于已读取附件或看图 | E5 文本附件、E6 多模态、E7 复杂解析 |
| 保持全应用单个前台聊天/Plan/手动 compact 租约；只补齐归属，不新增会话并行调度 | E10 通用任务、E14 并行协作 |
| 不增加暂停/继续、崩溃后自动重放、跨重启授权恢复 | E10/E12/E13/E23 |
| 补齐调用与 usage 归因，不宣称完整缓存折扣、阶梯计价或预算产品完成 | E11 |
| 示例联系人不是真人；真实联系人的通信及身份可行性仍需独立验收 | E26 |

“隐藏模拟入口”“新增下拉选项”“离线 fixture 通过”都不能单独关闭 E4。三个协议各自具备请求级测试和授权的真实端点证据，且真实助手 UI、状态、持久化、错误/取消链路同时通过后，才可登记 E4 验收结果。缺资源时保留未验证项，不自行删减已确认的三协议范围。

## 二、事实基线与复用点

以下是本轮静态阅读所得，不是本轮运行测试的结论：

| 现状 | 代码依据 | E4 处理 |
| --- | --- | --- |
| 只有固定 Chat Completions、Bearer 与 OpenAI 风格 payload | [现有请求实现](<../../../src/ai/openai-compatible.js#L125-L171>) | 包装成首个 adapter，另实现 Responses/Anthropic |
| 现有 providers 是工具 registry | [工具 provider registry](<../../../src/ai/providers/index.js#L23-L45>) | 新建 model-adapters，不混淆两个 registry |
| 单一全局模型配置与单个主 API key | [设置默认值](<../../../src/ai/settings.js#L7-L18>)、[公开设置投影](<../../../src/main.js#L527-L586>) | 版本化 provider/model registry，复用 vault |
| Agent 会因 stream/stream_options 错误自动重发，并因宽泛 400 转文本工具 | [流式兼容逻辑](<../../../src/ai/agent.js#L1521-L1554>)、[工具兼容逻辑](<../../../src/ai/agent.js#L1714-L1752>) | 改成明确配置/用户选择，不以任意 400 推断能力 |
| 非 Codex peer 直接生成固定模拟回复 | [模拟发送分支](<../../../src/renderer/app.js#L5753-L5765>) | AI 会话与示例联系人分流；真实 AI 调用主进程 |
| 单全局 activeRun，新发送先停止旧任务；公开 stop 无参数 | [运行入口](<../../../src/main.js#L1769-L1819>)、[preload](<../../../src/preload.js#L14-L19>) | BUSY、不隐式停止、带归属的 stop |
| 草稿、pending attachments、chatRun 尚非会话隔离状态 | [渲染状态](<../../../src/renderer/app.js#L64-L74>)、[发送逻辑](<../../../src/renderer/app.js#L5713-L5792>) | per-session draft/outbox 与按运行路由的状态 |
| E2 已有安全投影、消息迁移、任务归属和取消 | [模型/存储投影](<../../../src/ai/message-schema.js#L475-L579>)、[任务契约](<../../../src/ai/task-contract.js#L63-L154>) | 复用并扩展白名单，不平行制造另一份消息权威 |
| 还有压缩、记忆、sampling、PR audit 直接调用旧模型入口 | [压缩](<../../../src/ai/session-compact.js#L152-L202>)、[记忆候选](<../../../src/ai/memory-candidates.js#L94-L143>)、[sampling](<../../../src/ai/mcp-sampling.js#L184-L221>)、[PR audit](<../../../src/ai/pr-audit-runtime.js#L23-L69>) | 全部明确模型绑定并共享 router |

E2/E3 相关专项已有历史通过记录，但全量稳定性和正式验收仍开放。不得将[前置记录中的历史结果](<../plans/2026-10-28-e2-e3-frontgate-closure.md#L65-L91>)写成本轮重新测试通过。E4 可以完成规格和独立模块开发；集成验收须列出相关前置证据和仍开放项，不用 E4 文档把 E3 勾选为完成。

## 三、需求编号

| 编号 | 需求 |
| --- | --- |
| FR-01 | 三协议 adapter 具有同一模型调用契约，分别实现并验证 |
| FR-02 | provider、model、assistant 与能力证据版本化、可编辑且可迁移 |
| FR-03 | 秘密仅在主进程受控使用，配置/认证/诊断状态真实区分 |
| FR-04 | 所有模型消费者共享明确绑定，运行内不漂移、不隐式跨服务外发 |
| FR-05 | 错误、兼容选择、部分输出和重试语义一致，没有假成功 |
| FR-06 | AI 身份与示例/真人联系人区分，角色知识/工具策略在主进程执行 |
| FR-07 | 历史、草稿、事件和停止按会话/运行归属，全局串行不暗中抢占 |
| FR-08 | E2 消息/Plan 与 E3 Gate、撤权、秘密投影在新链路中保持有效 |
| FR-09 | 诊断使用最小合成输入、独立取消和预算，证据变更即过期 |
| FR-10 | UI、离线测试、真实端点及状态记录共同验收，未测不得记为支持 |

## 四、分层与模块责任

```text
renderer：公共配置、助手/会话、draft/outbox、运行视图
    ↓ preload：有类型的有限 IPC；不提供 secret read
main：配置事务、身份/绑定解析、运行租约、秘密解析、公共事件
    ↓
model-router：能力预检、统一调用/错误/usage、预算与取消
    ↓
model-adapters：Chat Completions / Responses / Anthropic Messages
    ↓
用户明确配置的端点

Agent / compact / memory candidates / MCP sampling / PR audit
    → 同一 router + 明确的模型快照
工具执行 → 既有 ToolProvider + PermissionGate + executionPolicy
```

拟新增主模块：

| 模块（计划新增） | 责任 |
| --- | --- |
| `src/ai/model-profiles.js` | registry schema、校验、公共投影、能力证据与版本规则 |
| `src/ai/model-adapters/index.js` | 固定协议 registry 与内部消息/结果校验 |
| `src/ai/model-adapters/openai-chat.js` | 包装已有 Chat Completions 请求，不维持第二份 wire 实现 |
| `src/ai/model-adapters/openai-responses.js` | Responses wire、流式、工具往返与运行内续接 |
| `src/ai/model-adapters/anthropic-messages.js` | Anthropic wire、流式、工具往返与 usage |
| `src/ai/model-router.js` | 已解析绑定的调用、能力/参数预检、错误与 usage 归一化 |
| `src/ai/model-diagnostics.js` | 合成能力检查、独立任务/取消、证据产出 |
| `src/ai/model-ipc.js` | 模型/助手 CRUD、凭据事务、诊断 IPC 与公共返回 |
| `src/renderer/e4-models.js` | 公共配置/能力/诊断与助手编辑 UI helper |
| `src/renderer/e4-chat-state.js` | draft/outbox、请求/运行归属和会话视图 helper |

主进程仍是执行、项目授权和凭据的权威。renderer 传入的模型引用、角色提示、历史字段或工具开关不构成权限授予。

## 五、配置与存储契约

### 5.1 Registry

在既有 settings 中增加一个独立版本域，保留其他设置，不替换整个 settings：

```js
settings.modelRegistry = {
  schemaVersion: 1,
  revision: 1,
  defaultModelProfileId: 'model_legacy_default',
  providers: [],
  models: [],
  assistants: [],
  migration: { from: 'legacy-single-model', completed: true }
};
```

- registry revision 为所有写操作的乐观并发版本；实体另有单调递增 revision。
- ID 稳定、不从名称或模型名动态生成；改名不改变引用。
- 上限：provider 32 个、model 128 个、assistant 128 个；名称 128 字符、模型名 256 字符、base URL 2048 字符、助手提示词 16,384 字符、工具白名单 256 个。超限返回配置错误，不截断成另一配置。
- `defaultModelProfileId` 必须指向有效 model。未知 ID 不自动换默认模型。
- 不自动访问 `/models` 或把远端清单当能力证明；首期使用明确填写的模型名。

### 5.2 ProviderProfile

```js
{
  id, name, revision,
  protocol: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages',
  baseUrl,
  auth: {
    kind: 'bearer' | 'api-key' | 'none',
    secretRef,             // 仅主进程内部；不是密钥本身
    credentialOrigin,
    credentialRevision
  },
  transportConfirmation: { origin, plainHttpAcceptedAt: null }
}
```

- Chat/Responses 默认 `bearer`；显式配置无认证的兼容/本地服务可选 `none`。Anthropic 首期仅 `api-key`，由 adapter 构造认证头。
- `baseUrl` 只接受 HTTP(S)，拒绝 URL 内用户名/密码、fragment 和 query 中的认证方式；认证不能混在 URL。端点后缀由所选 adapter 确定，不自动试探其他协议或 origin。
- 支持用户明确配置的本地/私网端点，不把 MCP 公网规则直接套用后宣称本地模型已支持。明文 HTTP 保存/发送前需一次针对该 origin 的可见风险确认；改 origin 使确认失效。
- `credentialOrigin` 与端点 origin 绑定。修改 origin 或认证种类时，旧凭据不自动带过去，进入需重新绑定状态；禁止跨 origin 跟随重定向，首期统一拒绝自动重定向。
- 公开 DTO 不返回明文 key，也不要求 renderer 使用 `secretRef`；仅返回协议、端点公共字段、revision、认证种类和 credentialState。

### 5.3 ModelProfile 与能力

```js
{
  id, name, providerId, model, revision,
  request: {
    maxOutputTokens: 4096,
    temperature: undefined,
    chatTokenLimitField: 'max_tokens' // 或 max_completion_tokens，仅 Chat 使用
  },
  capabilities: {
    text, nativeTools, vision, streaming, usage,
    temperature, stop,
    contextWindow: { tokens: null, source: 'unknown', bindingRevision: null }
  },
  compatibility: {
    toolMode: 'native' | 'text-compat' | 'none',
    streamMode: 'auto' | 'on' | 'off',
    includeUsage: true
  }
}

Capability = {
  state: 'supported' | 'unsupported' | 'unknown',
  source: 'declared' | 'observed' | 'unknown',
  checkedAt: null,
  bindingRevision: null
};
```

- 不按模型名字猜测是否 reasoning、工具或特定参数可用。没有显式参数时不统一注入 `temperature: 0.7`；压缩等消费者的温度仅为可省略的偏好，不是强制条件。
- `maxOutputTokens` 范围 1..32,768，默认 4096，再与调用者更小预算取交集。Chat 由明确字段映射，Responses 使用 `max_output_tokens`，Anthropic 使用 `max_tokens`。不支持必要预算映射时明确失败，不静默移除上限。
- 显式模型能力声明可用于发送前决策，但 UI 必须标为“用户声明/未实测”；一次成功不证明所有模型或同名其他端点可用。
- `text: unknown` 允许一次正常最小文本请求，并根据结果记录本配置的文本可用性。原生工具为 unknown 时，不自动发复杂 Agent 请求；用户可先声明/验证或选择纯文本/显式文本工具兼容。
- `streamMode: auto` 只在有有效 supported 声明/证据时启用流式，否则使用非流式；`on` 遇 unknown 先要求声明或诊断，遇 unsupported 阻断。去 usage 选项、转非流式均不由错误处理偷偷重发。
- `toolMode: text-compat` 是既有文本工具机制的显式兼容选择，不改写 nativeTools 为 supported；工具白名单、参数校验、预算和 Gate 与原生调用相同。
- contextWindow 由明确资料/人工配置提供；不做逐步放大输入的上限探测。不把 `compactMaxApproxTokens` 当模型 context window；已知上限时输入估算加输出预留不得超过该上限。
- `bindingRevision` 是 wire 配置的确定性指纹：协议、规范化 endpoint、auth kind/credentialRevision、模型名、显式 request/compatibility 参数；不包含密钥本体、显示名称、registry/entity CRUD revision 或能力结果自身。配置 revision 用于并发控制，wire 指纹用于能力证据有效性，二者不能混用。
- 改协议、端点、模型、请求参数、认证 revision 后，相应 observed 证据过期。改显示名称不使 wire 能力证据失效；证据过期显示 unknown，不沿用旧绿色状态。诊断回写只合并仍匹配 wire 指纹的结果，不覆盖并发修改的用户能力声明。
- vision 仅登记声明，E6 前发送仍只能使用已有文本/附件元信息投影，必须标明“图片内容未发送”。

### 5.4 AssistantProfile

```js
{
  id, name, revision, identityType: 'ai',
  modelProfileId: null,    // null 表示跟随全局默认
  systemPrompt: '',
  knowledge: { projectContext: false, projectMemory: false },
  projectId: null,        // 关联信息，不是项目授权
  toolPolicy: { mode: 'none' | 'allowlist', allowedTools: [] },
  builtIn: false
}
```

- 内置 `assistant_codex` 保留 Codex 工程身份；内置 `assistant_general` 是默认无工具通用 AI。模型引用可配置，内置身份不能冒充真人。
- 新建自定义助手默认 `knowledge` 全关、`toolPolicy.mode: none`、无项目。不得继承全局 memory、hooks、项目树、命令快捷路径或 write-fence 自动应用行为。
- 项目/记忆/工具能力均显式开启；有效项目绑定在每次主进程接受运行时重新解析。助手关联 projectId 或历史路径不代表授权。
- 角色提示只改变交流任务/风格，不能覆盖主进程工具策略。对工具列表的过滤和实际执行都应用同一受限策略。
- Codex 可编辑的提示作为宿主规则之外的角色补充，不替换 E2/E3 授权与 Plan 规则。

### 5.5 会话、草稿与消息来源

保留既有 session kind/project/消息字段，增量加入：

```js
session = {
  ...legacyFields,
  identityType: 'ai' | 'demo-contact',
  assistantId: 'assistant_codex',
  modelProfileId: null, // 会话覆盖；null 时跟随助手，再跟随全局默认
  legacyPeer: null
};

draft = {
  text: '', attachmentRefs: [], revision: 0, updatedAt: 0
};

message.modelSource = {
  kind: 'api' | 'local-demo' | 'legacy-demo' | 'unknown',
  assistantId, providerId, modelProfileId, protocol, model,
  providerRevision, modelRevision, assistantRevision,
  runId, clientRequestId
};
```

- 活跃运行的 source 只能由主进程生成。历史缺来源时显示未知/旧记录，不能按当前所选模型倒推归属；历史元数据也不是外部调用的密码学证明。
- 消息维持 E2 `schemaVersion: 2`，只新增有界可选来源字段；必须同步 normalize、UI/storage/export 白名单。模型内容投影不自动携带 UI 来源、raw provider output 或凭据。
- session 容器改为 `codex-qq-state-v3`，显式 `schemaVersion: 3`，包含 sessions/projects/activeSessionId/pluginState/draftsBySession。依次读 v3、v2、旧 sessions；迁移成功后只写 v3，保留旧数据供回退核对。
- 草稿单会话文本上限 64 KiB、附件引用最多 20 个；持久化草稿合计最多 1 MiB。超限明确保留当前内存草稿并提示未持久化，不悄悄截断/丢弃，也不删除别的会话草稿。
- 只存已存在的附件引用/元数据，不把 key、绝对路径、raw base64 或真实附件字节加入草稿。附件解析/受控存储仍归 E5/E6。

## 六、模型调用契约与三协议映射

### 6.1 内部规范

以下是计划实现的接口，不是现有导出：

```js
resolveModelBinding({ senderId, sessionId, assistantId, modelProfileId,
  projectBindingId, expectedRegistryRevision }) -> ResolvedModelBinding

invokeModelTurn({ binding, messages, tools, request, signal,
  onEvent, providerState, fetchFn, purpose = 'workload', diagnosticCheck }) -> Promise<ModelTurn>

ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
  toolCalls?: [{ id, name, argumentsJson }],
  toolCallId?: string
};

ModelTurn = {
  content: string,
  toolCalls: [{ id, name, argumentsJson }],
  finishReason: 'stop' | 'tool_calls' | 'length' | 'filtered' | 'unknown',
  usage: NormalizedUsage,
  providerState: unknown // 主进程运行内不透明状态；不是可持久化消息
};
```

`ResolvedModelBinding` 固定 protocol/endpoint/model/各 revision、运行身份与有效策略；凭据只在主进程必要的调用内解析，不放公共 binding。router 不接受 renderer 直接构造 binding。保留 `chatFn`/`fetchFn` 注入，兼容 wrapper 在单一边界把旧 snake_case 消息/结果转成内部规范，不能让各消费者自行猜测协议。

system 仅来自宿主构造的前缀段；router 拒绝非前缀 system 消息，不将用户内容或 raw 历史字段提升为 system。宿主生成的 compact 系统摘要由消息投影在发送前纳入此有序前缀。Responses 将前缀依序以 `\n\n` 连接为 instructions，其余消息按角色/工具 item 进入 input；Anthropic 将前缀依序转换为顶层 system text blocks；Chat 保留有序 system messages。

### 6.2 协议要求

| 项目 | Chat Completions | Responses | Anthropic Messages |
| --- | --- | --- | --- |
| endpoint | 所配置 root 的 `/chat/completions` | 所配置 root 的 `/responses` | 所配置 root 的 `/messages`；官方 root 含 `/v1` |
| 认证 | Bearer 或显式 none | Bearer 或显式 none | `x-api-key`，固定受支持的 `anthropic-version: 2023-06-01` |
| 系统提示 | system messages，保留顺序 | 映射 instructions/input 的固定策略，不能混入用户角色 | 提取为顶层 system，保持各段顺序 |
| 工具 | function definitions、assistant tool_calls、tool_call_id | function definitions、function_call 的 call_id、function_call_output | tool definitions、tool_use id、user tool_result blocks |
| token 上限 | 模型配置指定的 max_tokens 或 max_completion_tokens | max_output_tokens | max_tokens，必须存在 |
| 流式 | 既有 data/SSE 与工具参数片段 | 按 event/item/call 标识累积文本和函数参数 | 按 content block index/id 累积 text/tool_use/usage |
| 状态 | finish_reason 归一化 | completed/incomplete/error 与 output items | stop_reason 与 message/content 事件 |
| 服务端会话 | 不使用 | 默认 `store: false`，不自动依赖 previous_response_id | 不使用隐式服务端会话 |

- endpoint 构建只规范化本协议自己的已知 operation 后缀；保留用户的合法网关前缀。不得看到 404 后自动换 `/v1`、换协议或换 host 再试。
- Responses 在同一次工具循环中保留必要 output/续接 items，工具引用使用 `call_id` 而非 item ID。若所选模型需要额外的 stateless reasoning 续接材料，只能由 adapter 按已支持 wire 能力在运行内保存，不渲染、记录或转交其他协议；未实现的模型特性标为不支持，不伪装普通文本。
- Anthropic 保持 assistant tool_use 与随后 user tool_result 的正确关联和顺序；不把 system 作为普通用户提示发送，不将相邻工具结果随意合并到另一轮。
- 非流式和流式产出同一 ModelTurn 语义。工具参数必须在调用完成后通过 JSON/schema 校验才交给工具调度；取消或残缺片段不得执行工具。
- SSE 按完整事件帧处理 UTF-8/分片/多行 data/CRLF，并在正常终结后清理 reader。没有完整 terminal 的 EOF 属于协议失败，不拿已有文字冒充完整成功。
- 保留已有 Chat Completions 入口供明确的旧调用兼容，但生产消费者最终都经 router；不能维持一条会自动使用全局模型的隐蔽生产旁路。

### 6.3 预算与取消

- 普通模型调用默认截止时间 120,000 ms，取调用者更短 deadline；输出默认 4096 tokens，并取模型上限/调用者预算交集。现有[任务默认预算](<../../../src/ai/task-contract.js#L195-L200>)继续保留，E4 不把 `maxAgentTurns=0` 改写为新的轮数语义。
- 单请求编码体最多 4 MiB，单响应累计 wire body 最多 8 MiB、单 SSE 帧最多 256 KiB、单工具 arguments JSON 最多 64 KiB；超限终止并返回明确限额错误，不截断成可执行参数。
- 预算为实现默认值，不代表已经有完整 E11 预算 UI；界面能说明当前生效限制，调用者已有更严限额不放宽。
- 父运行取消必须传到 fetch/reader、待审批与关联自动模型子调用；清理 timer/listener/providerState。取消之后到达的数据不能再触发工具或成功终态。
- 已开始的副作用不自动重放。超时/连接中断不能证明上游没有计费，usage 不可用必须如实显示。

## 七、绑定、角色策略与所有消费者

### 7.1 绑定规则

1. 主进程验证 sender、session、assistant/model ID 和当前配置版本。
2. 解析 `session.modelProfileId ?? assistant.modelProfileId ?? registry.defaultModelProfileId`。
3. 使用有效项目绑定解析知识与工具范围；没有授权的 projectId 不获得路径/记忆/工具。
4. 在接受边界固定公开 source、运行内 binding 与有效工具策略。
5. 正常改显示名、提示词、模型参数影响下一轮，已接受运行不漂移。端点/认证变更、凭据替换/清除、删除配置在相关运行占用期间返回 `CONFIG_IN_USE`，须先停止并等清理完成。
6. 工具/项目权限被撤销时立即取消相关运行；不得因配置快照仍在内存而继续执行。

模型切换保留历史和草稿，只影响下一次接受的请求。切到新 provider/origin 前明确展示将发送的当前上下文及自动压缩/记忆处理目标，并要求确认；不是偷偷重新发送旧失败请求。

### 7.2 有效角色策略

`有效工具 = 角色白名单 ∩ 当前项目/宿主授权 ∩ E3 Gate ∩ plan/agent 模式限制`。

- 无工具助手不进入全功能 Codex loop；走受限文本路径，不处理工具代码块、host list-tree 快捷路径或 write-fence 应用。
- 有工具助手可复用 Agent，但 system persona、自动项目上下文、记忆、hooks 和工具 registry 均由已解析策略注入。hook/skill/记忆入口不能绕开同一限制。
- `projectContext: false` 不自动展开项目树或 `@refs`；UI 显示未启用项目知识。需要展开时须显式启用范围并持有当前项目授权。
- `projectMemory: false` 不注入、提炼或写入项目记忆。用户仍可保留既有普通聊天历史；这不是项目知识授权。
- Plan 生成与批准保留 E2 权威。待批准 Plan 记录助手/模型及相关配置版本；角色、模型、项目或工具策略变更后旧可执行绑定失效，历史仍可见，需重新提出/生成计划。已经开始执行的旧批准永不因失败或切模型恢复。

### 7.3 消费者选路表

| 消费者 | 绑定来源 | 保持的限制 |
| --- | --- | --- |
| 普通助手/Agent | 当前会话在接受时固定的 binding | 角色策略、工具 Gate、输出预算、同一个 run source |
| 发送前自动 compact | 本次待发送会话的同一个模型快照；纳入发送事务 | 原摘要/候选审阅边界；不偷偷用全局模型 |
| 手动 compact/记忆候选 | 操作发起时明确的 session/model 快照 | 用户看见目标，知识策略未启用时不做自动记忆处理 |
| Agent 内关联子调用 | 父运行 binding；若未来允许覆盖，必须独立明确选择 | 不能靠子调用回到旧全局配置 |
| MCP sampling | 有父运行则继承；脱离聊天的已授权任务固定该任务模型 | 既有逐 server 审批、context 限制、无 tools/递归、调用/输出配额 |
| PR audit/工程模型任务 | 有会话绑定则继承；否则在任务接受时固定全局默认 | 显示目标、只读快照工具/既有预算；不继承任意助手额外权限 |

sampling、compact、记忆、audit 不得再以 `settings.apiKey` 是否非空作为所有协议的统一可用性判断；API key、无认证本地服务与凭据不可用都由已选 provider 的 resolver 判断。

### 7.4 Usage 与价格归属

```js
NormalizedUsage = {
  inputTokens: null, outputTokens: null,
  cachedInputTokens: null, cacheCreationInputTokens: null,
  source: 'actual' | 'estimated' | 'unavailable'
};
```

- 每次物理模型请求记录 providerId/modelProfileId/model/assistantId/runId/clientRequestId/kind 和尝试 ID；同一 usage 不能既由 adapter 又由消费者重复入账。
- Anthropic 新输入、cache read/create 合并成总输入时只合并一次；Responses input tokens 不重复加已含缓存。缺失缓存计数是未知，不声称 0 命中。
- 完整文本结果可沿用已有 char/4 估算，并标 estimated。取消、失败、部分结果没有足够信息时标 unavailable，不能写成零消费或实际账单。
- 历史记录缺 provider 时归 legacy/unknown，不按当前配置重写。价格优先 modelProfile，再 provider+modelPrefix；旧价格行迁移到 legacy provider，不跨新 provider 套用。
- 未匹配价格显示费用未知；普通输入/输出估算与缓存折扣未知明确区分，不据此宣称 E11 完整计价已完成。

## 八、运行、事件、草稿与定向取消

### 8.1 接受与全局租约

- 本期保留一个全应用聊天/Plan/手动 compact 前台租约。`chat:send`、`chat:approvePlan` 和 `session:compact` 都先检查租约/工作区状态；忙碌返回 `BUSY`，不调用公开或内部“先停旧任务再发”的默认逻辑。
- 发送前自动 compact 是该发送事务的子阶段，不能发生在另一会话忙碌检查之前、也不能抢用另一模型；需纳入同一取消/归属链。
- 手动 compact 使用同一接受/停止信封与租约，按 `task.kind: session_compact` 路由进度/终态，不创建聊天助手气泡或消费发送草稿；完成后的摘要/候选仍按原审阅规则应用。独立 audit/诊断保持自己的任务边界，不借本期扩展成通用调度器。
- 预检失败没有 accepted run，不创建成功消息或副作用。运行接受时发送包含 clientRequestId 的 `run-start`，此后 source 不变。
- 同一 sender/clientRequestId 在活跃期不重复创建任务；重试是用户明确的新 attempt，不复用已发生副作用的旧授权。
- 保持现有 invoke 返回最终结果的兼容语义，不用本期顺便重写整个异步 API。renderer 继续支持 event 早于/晚于 invoke；两者都必须含相同 run/session/request 身份。

### 8.2 事件归属

所有聊天事件公共信封至少包含：

```js
{ type, runId, sessionId, clientRequestId, modelSource, task, ...safeEventData }
```

- 使用现有 TaskHandle/task envelope，不新建另一套任务 ID；主进程保留 ownerId，renderer 不以自己上报 owner 授权。允许增加 `session_compact` 与 `model_diagnostic` 两个有限 task kind，不改变状态枚举，也不引入 E10 调度/恢复语义。
- renderer 以 clientRequestId 关联首次 run-start，再固定 runId/sessionId；未知/不匹配事件不污染当前聊天。
- 运行 UI 不以 DOM 是否仍挂在当前聊天面板判断存在；切换会话继续更新原会话状态，返回时能恢复轨迹/部分文本。
- done/error/aborted 只产生一个最终消息；迟到 delta/usage 按明确入账与终态规则处理，不能新建第二个助手回答。
- invoke 提前返回不抹掉尚未处理的 Plan/工具事件；沿用并扩展[现有事件顺序行为 harness](<../../../tests/renderer-chat-event-order.test.js>)。

### 8.3 草稿与 outbox

- `draftsBySession` 保存文本、附件引用与 revision；切会话先保存当前 draft，再加载目标 draft。模型/助手选择不清空 draft。
- 点击发送建立不可变 outbox 快照与 clientRequestId，不立即不可恢复地消费 draft；run-start 接受后才确认发送。
- 若用户已在等待接受期间继续编辑，只清理与 outbox 相同的 draft revision，不覆盖新输入。BUSY/预检失败保留原草稿；已编辑的情况下保留可恢复的未发送 outbox，不用旧文本覆盖新草稿。
- 取消已接受运行保留已发送用户消息与有界部分输出，并清楚标为已停止；不把停止文案写成工具已执行成功。

### 8.4 Stop、配置占用与关闭

`chat:stop({ sessionId, runId })` 校验 sender/session/run 后请求取消；错误归属不停止其他会话。无参数的公开 stop 不再具有全局取消能力，所有 renderer 调用点必须升级。

停止期间 UI 可显示 `stopping`，但不更改 E2 TaskHandle 的状态枚举。底层取消和清理完成前租约仍占用，新发送返回 BUSY；终态不意味着资源已经可被另一运行抢用。关闭窗口/应用的内部清理保留主进程权威，不恢复成无归属公开停止入口。

删除被助手/default/session 引用的配置返回 `PROFILE_IN_USE`；用户先显式换绑，不能批量偷偷改默认。助手有会话引用时先归档，保留历史名称/source；历史来源不是活引用，不因删配置而删除历史。模型删除和凭据清除不清理用户会话、原文件或旧消息。

## 九、IPC 与公开状态

### 9.1 统一返回与并发

配置读取返回公共 DTO；写操作携带 `expectedRevision`。成功返回新 revision；冲突返回 `CONFIG_CONFLICT` 与最新公共状态，不覆盖并发修改。主进程对枚举、长度、引用和 sender 上下文做完整验证。

| IPC | 参数要点 | 返回/约束 |
| --- | --- | --- |
| `models:list` | 无秘密参数 | 公共 registry、当前 mode、revision、credential/diagnostic 状态 |
| `models:saveProvider` | provider draft、expectedRevision | 不含 key；origin/auth 改动按重新绑定规则处理 |
| `models:saveModel` | model draft、expectedRevision | 校验 provider、参数、能力声明与兼容模式 |
| `models:setDefault` | modelProfileId、expectedRevision | 校验有效引用并原子更新 defaultModelProfileId/registry revision；仅影响后续接受，不外发、不改变聊天 mode |
| `models:remove` | kind: provider/model、id、expectedRevision | 活引用/运行占用明确拒绝；不级联删历史 |
| `models:setCredential` | providerId、credential、expectedRevision | 只接收用户本次输入；返回公共状态，不回显；不记录参数 |
| `models:clearCredential` | providerId、expectedRevision | 独立显式解除引用；占用时先停止；提交后清理失败返回最新公共状态/cleanupState |
| `models:retryCredentialCleanup` | expectedRevision | 幂等重试主进程 journal 中未被有效引用的待清理记录；不接受任意 secret ID，不回滚配置 |
| `models:diagnose` | modelProfileId、checks、expectedRevision | 创建独立诊断任务，返回 diagnosticId；只用合成输入 |
| `models:cancelDiagnosis` | diagnosticId | 校验 sender 归属；取消不生成成功证据 |
| `assistants:list` | 无 | 公共 AI profiles、引用状态、revision |
| `assistants:save` | assistant draft、expectedRevision | 模型/知识/工具约束校验；不是授权 API |
| `assistants:delete` | assistantId、expectedRevision | 内置身份不删除；有会话时归档 |
| `chat:send` | 原字段 + assistantId/modelProfileId/clientRequestId/expectedRegistryRevision | main 解析快照；公共 source；未知引用明确失败 |
| `chat:stop` | sessionId/runId | sender 绑定取消；可停止本人的 chat/Plan/手动 compact 租约，绝不默认停止另一会话 |
| `session:compact` | 原字段 + assistantId/modelProfileId/clientRequestId/expectedRegistryRevision | 共享前台租约；chat:event 以 session_compact kind 分流，final reply 返回同一归属及原摘要结果 |

诊断事件另走 `models:diagnostic-event`，由 preload 的订阅/取消订阅 helper 接入；不混入聊天历史。配置中发生的 credentialState 变化通过更新后的公共 DTO/订阅刷新，不在 renderer 缓存 key。

### 9.2 状态分离

- credentialState：`unset / configured / unavailable`。configured 仅表示有可用的受控记录，不表示认证成功。
- cleanupState：`clean / pending`，与凭据可用性独立；公开 DTO/写入返回可附待清理数量但不含内部引用。pending 不意味着已提交的更新/解除绑定未生效，UI 必须分别说明并提供重试清理。
- diagnosticState：`not-tested / running / passed / failed / stale / cancelled`，附模型/端点公共标签、时间、接受时配置 revision 与 wire bindingRevision。
- AI 会话：待配置/可发送/生成中/停止中/失败；展示所选模型和证据来源，不显示“真人在线”。
- local mode 明确标“本地模拟”，不能获得 API 健康或真实端点通过状态。API 失败不转 local mode。

## 十、错误、兼容选择与重试

统一 `ModelError` 公共字段：`code`、`safeMessage`、`retryable`、可选 `httpStatus/upstreamCode/requestId/retryAfterMs`、`partialOutput` 和公共 source。内部 cause 不能未经净化发给 renderer。

| 分类 | 例子 | 行为 |
| --- | --- | --- |
| `MODEL_CONFIG_INVALID` / `MODEL_CREDENTIAL_UNAVAILABLE` | 未配置、未知引用、无法解密 | 在外发前失败，不换 provider |
| `MODEL_AUTH_FAILED` / `MODEL_PERMISSION_DENIED` | 上游明确认证/权限失败 | 显示安全原因，不假报健康 |
| `MODEL_NOT_FOUND` | 明确模型不存在 | 不根据 404 自动改 URL 或模型 |
| `MODEL_CAPABILITY_UNSUPPORTED` / `MODEL_CAPABILITY_UNKNOWN` | 工具/流式/必要参数未满足 | 用户选模式或先声明/诊断，不自动降级 |
| `MODEL_CONTEXT_LIMIT` / `MODEL_LIMIT` | 上下文或本地请求/响应限额 | 明确保留草稿/部分结果，不悄悄丢正文 |
| `MODEL_RATE_LIMIT` | 429 或明确上游限流 | 展示可用 retry-after；不无限重试 |
| `MODEL_TIMEOUT` / `MODEL_NETWORK` | 超时、断线 | 不能声称未计费或安全重放 |
| `MODEL_PROTOCOL` / `MODEL_EMPTY_RESPONSE` | 无完整终止、无法解释的响应 | 不用部分流或 HTML 当成功 |
| `MODEL_CANCELLED` | 用户/父任务取消 | 不重试、不执行残缺工具调用 |

普通 400 只按上游明确 safe code/字段分类；不足以判断时归协议/请求错误，不把 `/tools|unsupported|400/` 当能力发现。

默认无自动重试。用户可明确修改 stream/includeUsage/toolMode 后新发一次；每次物理请求具有独立 attempt/usage 记录，并展示目标和可能重复计费。已有部分输出的失败保持部分输出和失败状态，不无缝替换成另一请求。文本工具仅在已明确选择 `text-compat` 时解析执行；普通文本里的代码块不触发工具。

## 十一、秘密事务、迁移与回退

### 11.1 秘密更新

复用[现有 SecretManager](<../../../src/ai/secret-manager.js>)和[settings 原子保存基础](<../../../src/ai/settings.js#L275-L316>)，不新建明文 key 表：

1. 校验 expectedRevision、目标 origin、占用和认证种类。
2. 使用新 opaque secret ID 保管本次输入，完成加密/可读取性检查。
3. 原子提交新配置引用与 credentialRevision。
4. **提交前失败**：保持旧引用/旧配置 revision 可用，回收本次未提交的新记录；回收未完成时另报 cleanup pending，不能删除旧有效秘密。
5. **提交后**：新引用/新 revision 已生效；旧记录退休失败不回滚配置或删除新引用。返回最新公共配置与 `cleanupState: pending` 警告，不将其伪装成“更新未生效”。
6. clear 先原子解除引用；提交前失败保持原绑定，提交后则保持已解除状态。后续 vault 删除失败返回最新公共状态并明确“已解除绑定，旧记录清理待完成”，不能声称已彻底删除，也不恢复旧引用。

待清理记录以主进程私有 journal 持久化并校验仍无有效引用；只记录 opaque ID，不向 renderer 返回秘密/内部引用。`models:retryCredentialCleanup` 幂等处理 journal，始终返回当前公共 revision 与 clean/pending 状态；不得删除其他配置仍引用的记录或重新绑定已清除凭据。配置提交成功但清理未完成时，UI 保留已提交状态并独立展示清理提示。

旧 `main_api_key` 迁移沿用既有引用，不无条件复制或删除共享秘密。公开 settings 继续兼容 `apiKey: ''`/apiKeySet 等旧字段，但新运行不得从 renderer alias 取得凭据。key 不进入 localStorage、历史、usage、诊断、日志、错误、providerState、export 或子进程环境。

### 11.2 Registry 迁移

- 没有 registry 时，使用稳定 ID `provider_legacy_openai`、`model_legacy_default` 迁移旧 baseUrl/model/key 引用；创建 `assistant_codex` 与 `assistant_general`，能力默认 unknown，保留原 `settings.mode`。
- 已存在有效 registry 时不再次覆盖；半完成迁移依据版本/稳定 ID 合并缺少项，不按名称重复创建。
- 旧 local 模式仍是显式本地模拟；填好新模型不等于用户已同意开始 API 外发。
- 旧配置不合法、vault 不可用或引用缺失时保留原资料、标需修复，不清空也不切到另一 provider。
- 迁移前保留一次受控备份；其中不新增明文 secret。未知更高 schema 拒绝覆盖并给出恢复提示。

### 11.3 会话迁移

- 既有 Codex 会话绑定 `assistant_codex`，保留 ID、消息、Plan、轨迹、project 与 agentMode；来源缺失不伪造模型信息。
- 既有非 Codex 示例 peer 迁为 `demo-contact`，保留 peer、标题、用户编辑、消息与 legacy-demo 标识；保留示例只读入口，不计为真实助手。
- 新建 AI 助手/会话是显式操作。沿用示例会话时展示“历史为模拟，未来将发给所选模型”，默认不外发旧模拟回复；用户可明确选择包含哪些旧历史。
- v3 首次保存成功后才切换新容器；旧 v2/legacy 内容不直接删除。配额、JSON 或投影失败不加载空白当成功。
- 降级旧客户端可能忽略新 profile/来源/草稿字段，不能保证无损；提供备份与说明，不自动双写两份会话权威，也不在本期实现 E12 导入恢复。

## 十二、诊断与 UI

### 12.1 受控诊断

- 用户选择具体 model 和 checks，预览目标 origin、模型、预计请求数、数据为合成内容及可能计费后启动；不在应用启动、设置保存或输入 key 时自动请求。
- 每个 check 一次独立受控请求；文本、流式、usage 分项记录。工具 check 最多两个请求，以纯内存固定回执完成合成 function/tool-result 往返，不注册或调用项目/宿主工具。
- 诊断服务可为当前 check 创建内部 `purpose: diagnostic` 调用，允许在所测能力 unknown/unsupported 时发送一次受控合成检查；只跳过该项普通工作负载的能力前置阻断，不跳过认证、origin、预算、owner 或工具隔离。renderer 不能设置此 purpose、提交自定义工具或借诊断外发真实内容。
- 每个 check 截止 15,000 ms，最多 128 输出 tokens，响应累计不超过 256 KiB，单个诊断最多 5 个物理请求。取消/预算超限停止余下 checks，清理 controller/timer/reader。
- 不发送真实会话、附件、文件、记忆、项目路径或工具结果。没有拿到有效工具往返不能认定 supported；一次未选择调用工具也不能直接认定 unsupported。诊断的显式授权独立于聊天 local/API mode，诊断不改变该 mode。
- text/streaming/nativeTools/usage 的证据只覆盖本 wire bindingRevision；vision/context window 不做内容探测。保留接受时配置 revision 供审计，但不据 CRUD revision 单独使能力失效。诊断失败不覆盖已知事实为“所有能力都不支持”。
- 诊断与聊天共用 adapter/router，但具有独立 TaskHandle/owner、诊断事件与用量 kind。凭据/端点变更须先取消并清理关联诊断，避免旧结果写回新配置。

### 12.2 必须交付的 UI 状态

1. **模型设置**：provider/model 列表、协议/端点、认证种类、默认模型、能力声明/来源、工具/流式兼容模式；保存冲突和引用错误可恢复。
2. **凭据**：空输入保留、显式更新、独立清除、未配置/已保管/不可用；无 key 回显。
3. **诊断**：目标/费用说明、分项结果、取消、时间和 stale；不是永久绿色在线点。
4. **AI 助手管理**：创建/编辑/归档，模型/提示词/知识/项目/工具设置；与示例联系人分组。
5. **聊天头部**：AI 身份、下一轮目标、当前运行固定目标、本地模拟标识、忙碌/停止状态与可用模式；能力不满足时给出明确选择。
6. **草稿与历史**：切模型/会话不丢草稿，拒绝发送可恢复；消息按实际来源展示，不把旧回答标成当前模型。
7. **错误/部分结果**：安全信息、retry-after、部分输出和显式重试；没有模拟回答兜底。

继续使用现有 Electron/Node/renderer，不更换 UI 框架。首期以现有 fetch/TextDecoder/Node test 实现协议，不预设新增运行依赖；若实现需要新依赖，另行说明许可证、打包、维护与变更理由，不能暗中安装。

## 十三、验收矩阵与证据

| 验收 ID | 必须证据 | 对应需求 |
| --- | --- | --- |
| AC-01 | 三协议各自请求编码、系统提示、参数、非流式/流式、工具多轮 ID/结果/终止/usage 的离线行为测试 | FR-01/02 |
| AC-02 | 三协议各自用户授权的真实文本、流式、合成工具往返和取消证据；逐配置登记 | FR-01/10 |
| AC-03 | 设置/凭据 set/clear、配置版本冲突、registry 幂等迁移、提交前失败保留/提交后 cleanup pending、公共投影测试 | FR-02/03 |
| AC-04 | 对话/Agent/compact/记忆/sampling/audit 均使用预期 binding，物理请求与 usage 只计一次 | FR-04 |
| AC-05 | unknown/unsupported/普通 API 错误/部分输出/取消下没有自动降级、换服务或模拟成功 | FR-05 |
| AC-06 | 两个非 Codex AI 助手真实调用、独立历史/草稿/模型显示，示例历史不冒充真人或实测 | FR-06/07 |
| AC-07 | BUSY 不停旧运行、不消费草稿；定向 stop、切会话事件、invoke/event 重排和只终结一次 | FR-07 |
| AC-08 | 无工具助手不执行工具/工程快捷路径；项目知识/记忆/工具按有效角色策略生效 | FR-06/08 |
| AC-09 | Plan 绑定变更使旧执行绑定失效；原 E2 不重放规则和 E3 Gate/秘密投影相关回归保持 | FR-08 |
| AC-10 | 诊断合成内容、预算/取消、分项证据和 stale 规则；与聊天互不串事件 | FR-03/09 |
| AC-11 | Electron 的配置/凭据状态、助手、模式切换、草稿、错误/停止和重载 UI 验收 | FR-06/07/10 |
| AC-12 | 文档记录实现提交、命令/环境、通过/失败/跳过、真实端点缺口和前置开放项 | FR-10 |

请求级测试使用可注入 fetch/确定性分片，不冒充真实端点。真实端点测试默认关闭，只有用户明确授权目标和计费、临时提供必要凭据后才可启用；不自动读取日常 userData/vault 或枚举环境秘密。缺少端点/凭据时写“未验证/阻断”，不将 skip 算通过。

真实端点证据只保存协议、公共目标标签、模型、配置版本、测试输入类别、请求数、终态、usage 质量、时间与脱敏 request ID，不保存 key、认证头、raw provider state 或真实源码。带 fixture 的 Electron smoke 和真实模型 Electron smoke 分开标记。

## 十四、实施入口与状态记录

实施顺序、RED/GREEN 用例、目标文件和验收登记模板见[E4 实施计划](<../plans/2026-10-29-phase-e4-model-capabilities-assistants.md>)。任何偏离三协议范围、角色默认权限、串行接受、凭据边界或无隐式重试政策的调整，都须在实现前显式记录并确认，不能以测试困难或缺凭据为由把支持矩阵直接写绿。

**当前状态：仅设计文档；没有本轮 E4 功能实现、请求级测试、真实端点测试或 Electron 验收结果。**
