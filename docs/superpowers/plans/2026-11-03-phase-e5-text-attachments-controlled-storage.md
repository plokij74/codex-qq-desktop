# Phase E5：文本附件与受控附件存储实施计划

**状态：E5 业务实现已落地；实施与分层验证见 [E5 验证记录](<2026-11-03-e5-implementation-verification.md>)。正式真实端点/OS 用户手势验收未执行。下文保留原实施计划，不充当执行日志。**

文档日期：2026-11-03。静态检查基线：`91f3bd028e5b8ae1f87ca75298501bae42c70486`。日期仅为文档标识，不设置具体日程或工期。

设计依据：[E5 Spec](<../specs/2026-11-03-phase-e5-text-attachments-controlled-storage-design.md>)。所属阶段：[Phase E 总规划](<2026-10-15-phase-e-product-readiness.md#L133-L146>)。前置：[E2/E3 记录](<2026-10-28-e2-e3-frontgate-closure.md>)、[E4 Spec](<../specs/2026-10-29-phase-e4-model-capabilities-assistants-design.md>)、[E4 实现与验证记录](<2026-10-30-e4-implementation-verification.md>)。

本文件初稿仅交付文档，后续已获得用户开发授权并实施。执行记录、实际验证与未验边界见 [E5 验证记录](<2026-11-03-e5-implementation-verification.md>)；下文任务、样本与命令是保留的原实施计划，不代表每条命令已执行或正式验收已闭合。没有安装新依赖、访问真实用户数据/凭据或模型端点，也未提交 Git。

## 0. 固定决策与实施纪律

### 0.1 范围、协议与授权

1. E5 只做 UTF-8/BOM 文本、代码、Markdown、JSON/CSV 等惰性文本。JSON/CSV 不求值、不承诺业务 schema 或表格解析；正文中的 `@`、HTML、脚本、链接不执行。支持白名单、编码/魔数/控制字符规则以 Spec 第一节为准。
2. 外部选取只授权本次只读 capture，以后发送不可变应用副本；没有长期源重开或外部目录工具权限。项目 `@` 使用当前 sender-owned binding、相对路径、策略/Gate/root/源身份及hash复验，两类授权不能互换；源变化检查截止claim的 `sourceValidatedAt`，随后只发送与preview一致的不可变快照，不长持源pin等待compact/model，项目grant/物理root/owner/策略仍在每次dispatch复验。
3. 主进程持有 record/blob/hash/source identities/leases；renderer 使用正向公开 DTO 与 opaque ID。`ready`、metadata、旧消息、renderer `sessionId` 或 model session refs不是能力。
4. 附件 session namespace/窗口 grant由main建立；重启只恢复导航，用户在实际窗口重新本地确认后获新grant，不能跨窗口自动接管。所有旧参与项目读取/补全/附件的原始路径 IPC 收敛，不保留字节读取旁路。
5. 现有 Windows launcher只是命令隔离，不是附件 reader。新增独立 `--capture-file`，同handle bounded read、ancestor/root/source身份、无 ACL/shell/整树副作用；不安全/不支持平台fail closed。
6. safeStorage-only 密文缓存，临时密文→解密回验→原子提交；无安全加密/丢钥/坏包/写失败显式memory或不可用，原包保留。禁止 SecretManager机器指纹fallback、plaintext落盘与localStorage base64。
7. 先得到最终有界/脱敏文本，再预览目标/截断/预算，票据单次消费。main独立解析当前用户 `@` token并验证ticket覆盖，不接受renderer省略ref/preview绕过；接受前可判定错误必须早于compact/memory/model外发，dispatch前再查当前授权。
8. 三协议均是 E5 请求级交付对象：`openai-chat-completions`、`openai-responses`、`anthropic-messages`。复用 E4 binding/client/router、`ModelMessage.content: string`、单前台BUSY/定向cancel；已accepted foreground lease等cleanup后释放，import/prepare/未accepted claim独立controller/工作槽不占foreground，不增加admission锁、网络客户端或隐式retry/fallback。
9. 当前run可复用同一确认片段；历史、compact、记忆默认只有安全元信息/已有结论。下一次正文外发需重新选择/预览；Responses续接不能带回未确认历史正文。
10. E2消息v2/E4会话v3加性扩展；旧64 KiB/20 refs草稿保留/blocked行为不破坏。本次可外发上限与旧容器上限分开，坏容器不空覆盖。
11. 默认MD/JSON仅安全元信息及已有会话文字，不携原件、自动附件正文/dataUrl、私有绝对路径或能力。E6图像、E7复杂解析、E12原件包不进入本期；不承诺清除已在模型结论中的摘录。
12. 每任务 RED → 最小实现 → GREEN → 相关回归。证明行为、请求、资源/源完整性，不只检查源码字符串。真实证据、fixture、skip和未授权严格区分；不安装新依赖、不自行升级工具链或提交Git。

### 0.2 默认预算摘要

Spec 第六节是常量、单位与边界行为唯一权威，本计划不能另设更宽值。

| 维度 | 固定默认值 |
| --- | --- |
| 单文件 / 单次选择 | 2 MiB；8个；原始字节合计8 MiB，硬超限拒绝 |
| 最终文本 | 每文件64 Ki Unicode码点；整次附件256 Ki码点，prefix/范围截断须预览确认 |
| `@` 行范围 | 显式最多500行；默认最多前2,000行，仍受字节/字符限制 |
| 完整请求 / 上下文 | 既有4 MiB wire硬限；已知binding+输出预留；未知估算门槛不高于32,000且更低显式设置优先 |
| 缓存 / 临时内存 | 实际密文包合计64 MiB、512记录；保留cache16 MiB、独立临时work48 MiB（合计预留≤64 MiB）；30天闲置TTL |
| capture / preview | capture及byte工作槽各全应用1个，read/decrypt/encode/prepare/claim共用后者；30秒（不含picker等待）；5分钟单次票据；16个preview、每页16 Ki码点 |
| blob / manifest | blob外层4 MiB/cipher3 MiB/plain3 MiB/raw2 MiB；manifest外层4 MiB/cipher3 MiB/plain2 MiB、512rows、深度8；parse前节点≤65,536 |
| compact | 128项去重公开引用，超限不提交compact |

raw bytes、UTF-8 selected bytes、Unicode码点、UTF-16 `.length`、估算token不是同一单位。已知/未知窗口与实际wire（含Responses opaque state）、输出预留都必须再检查；不把32,000写成模型实测窗口，不放宽既有存储sanitizer解决附件文本截断。

### 0.3 前置与静态基线门槛

- 当前项目入口为 [主进程](<../../../src/main.js>)、[preload](<../../../src/preload.js>) 与 `src/ai` 服务，不使用不存在的 `src/main/`、`src/shared/messages.js` 设计实现。
- 基线只读Git无tracked修改；已有 `.dsh-work/` 未跟踪目录属于既有内容，不清理或纳入提交。本计划不授权清理无关文件。
- 环境只读记录 Node `v22.22.0`、npm `11.16.0`；[包脚本](<../../../package.json#L5-L15>) 的pretest/native build会写构建产物，所以本轮未运行 `npm test`。
- E2/E3前置记录保留历史全量/平台限制；E4历史离线专项691/691、完整1879 pass/0 fail/0 cancelled/1 skip（600秒测试文件预算）、实际隔离Electron14checks不等于E5已验证，真实端点仍开放。
- 可以分步做独立模块；进入集成前复核会影响新链路的E2/E3/E4消息/Plan/owner/Gate/vault/router回归。E5新reader不能替旧命令隔离或剩余E3边界背书。
- E5 capture native能力未能真实证明时，该导入入口保持不可用；不能以fallback或未执行的测试通过口头放行。

## 1. 任务总览与依赖

| 任务 | 交付 | 前置 | 主要验收 |
| --- | --- | --- | --- |
| E5-01 | 契约、预算、状态/错误和消息白名单 | 静态基线/前置核对 | AC-01/03/04/13 |
| E5-02 | bounded native capture、严格文本提取、项目身份 | E5-01 | AC-01/02/03/04 |
| E5-03 | safeStorage store、leases、dedupe/TTL/删除 | E5-01 | AC-04/08/09 |
| E5-04 | session/window/source IPC能力、preview/claim/取消 | E5-02、E5-03 | AC-03/05/07/10 |
| E5-05 | 真实renderer选择/预览/draft/outbox/切换 | E5-04 | AC-05/07/10/13 |
| E5-06 | 接受前复验、文本投影、三协议wire/预算/usage | E5-04 | AC-04/05/06/07/14 |
| E5-07 | compact/history/export/retry/legacy兼容 | E5-05、E5-06 | AC-09/10/11/12/13/14 |
| E5-08 | 请求级/前置回归、实际Electron/native/live证据登记 | E5-01～E5-07 | AC-01～AC-15 |

E5-02/03可以在契约稳定后独立推进；E5-05/06可以在IPC稳定后分工。共享文件修改必须串行协调，不复制消息权威或模型transport。native、取消和存储负测随各任务完成，不拖到E5-08才补；E5-08负责整合与正式证据。

每项“预计RED”是测试设计，不表示本轮已经运行并失败。后续必须记录实际RED原因、最小修复、GREEN与回归；测试文件尚未创建前不执行对应命令。

## 2. E5-01：契约、预算与公开引用

### 目标与文件

建立Spec唯一常量、AttachmentRefV1/public DTO、私有record校验、状态/错误及Unicode单位，E2 v2/E4 v3加性兼容。

- **计划新增**：`src/ai/attachment-contract.js`、`tests/e5-attachment-contract.test.js`。
- 既有：[消息schema](<../../../src/ai/message-schema.js#L123-L168>)、[存储投影](<../../../src/ai/message-schema.js#L565-L577>)、[E2 schema测试](<../../../tests/e2-message-schema.test.js>)、[会话迁移测试](<../../../tests/e4-session-migration.test.js>)。

### RED → 最小实现 → GREEN

1. 先测试公开DTO拒绝path/bytes/dataUrl/hash/grant/preview/模型binding，renderer ready/name/MIME/size不创建host记录；legacy无记录保持unavailable。
2. 对每常量做边界和+1，Unicode中文/emoji与UTF-8字节区别、非法整数/长ID/深层对象/巨量数组；保留旧草稿64 KiB/20refs的blocked与原内容。
3. 正向白名单替代“删几个字段”；严格状态/来源，`tool_output`只兼容元信息。ID用main随机来源，不用路径/hash或renderer值。
4. 拆开存储脱敏截断与主进程有界模型文本路径，不能全局抬高65536限额；prefix算法不切断surrogate/UTF-8。
5. GREEN跑新契约及E2/E4迁移相关测试，登记无引用提升、无path/body泄漏、旧容器不受损。

### 完成门槛

FR-01/06/13契约明确；Spec各数字只有一套实现常量，普通规范化不是权限；未来module/schema调用不能绕白名单。纯同步message:project仍无IO。

## 3. E5-02：无副作用 bounded capture 与来源身份

### 目标与文件

外部一次capture/项目当前grant通过同一安全字节reader，编码/魔数/范围在硬预算内验证。

- **计划新增**：`src/ai/attachment-reader.js`、`tests/e5-attachment-reader.test.js`、`tests/e5-attachment-native.test.js`。
- 既有：[native源码](<../../../src/native/windows-isolation/Launcher.cs#L48-L109>)、[native root pin](<../../../src/native/windows-isolation/Launcher.cs#L230-L233>)、[构建脚本](<../../../scripts/build-windows-isolation.cjs>)、[Windows品牌授权范例](<../../../src/ai/windows-isolation.js#L21-L55>)、[worktree binding](<../../../src/ai/worktree-ipc.js#L17-L75>)、[resolveBinding](<../../../src/ai/worktree-ipc.js#L195-L201>)、[@ parser/caps](<../../../src/ai/at-ref.js#L9-L119>)、[旧项目reader](<../../../src/ai/project-fs.js#L186-L222>)。

### RED → 最小实现 → GREEN

1. 新native/reader测试先覆盖ASCII/中文/emoji跨chunk、BOM、空文件、CRLF、坏JSON文本/CSV公式惰性；UTF-16/32、NUL、坏UTF-8、二进制改名/MIME伪造拒绝；证明最多读取max+1而非全读。
2. 建真实Windows临时fixture：outside选取只读，源/root/ancestor替换、junction/symlink/hardlink/ADS/device/UNC、同名root重建、in-place writer、打开前后变化、构建校验失效/缺native；核对source bytes、目录和ACL前后不变、无shell。
3. 独立 `--capture-file` 分支复用Physical/Information/ObjectIdentity思路，但新增GENERIC_READ/只share READ和逐级pin；不使用现有整树Walk/ACL/Job执行模式。验证expected root/ancestor/file IDs、physical boundary/links，在同handle前后复验和bounded read，finally关闭。
4. 主进程private有界通信输出，取消/30秒超时杀停并等待helper/reader回收，不把原件/正文写临时文件或工程stdout日志。更新既有native构建校验链，不新装工具链。
5. worktree绑定增加main内部root identity/current校验；legacy仅path绑定不得假设根对象未换。补全与capture用当前binding，旧路径读取/补全收敛，保留token/行范围词法，不调用旧expandFileRef的sample→全读。
6. 外部capture完成后丢弃源重开能力；项目record存相对路径/范围/身份，prepare/claim重新bounded复验hash。源变化生成stale/new capture而非修改旧record。
7. GREEN分别记录纯reader、真实native结果及skip理由；支持不了的环境明确禁用入口，不给“已安全隔离”假象。

### 完成门槛

FR-01/02/03/06达到AC-01/02/03/04；真实Windows证明必须独立于旧E3命令负测。仅路径检查、final O_NOFOLLOW、mock helper或skipped native不足以放行生产capture。

## 4. E5-03：密文缓存、引用保护与安全删除

### 目标与文件

建立不可变blob和加密manifest，safeStorage-only、明确memory、容量/TTL/refs/GC及不删原件。

- **计划新增**：`src/ai/attachment-store.js`、`tests/e5-attachment-store.test.js`。
- 复用：[ProjectIndex cache](<../../../src/ai/project-index.js#L200-L250>)、[PrAuditStore](<../../../src/ai/pr-audit-store.js#L62-L99>)、[repair store](<../../../src/ai/pr-audit-repair-store.js#L25-L96>)、[相关cache负测](<../../../tests/project-index.test.js#L124-L202>)、[vault原包保护测试](<../../../tests/e4-secret-manager-atomic.test.js#L157-L182>)；不将附件存进[SecretManager](<../../../src/ai/secret-manager.js#L108-L148>)。

### RED → 最小实现 → GREEN

1. 写store测试：无/false/throwing/unsafe safeStorage、encrypt/decrypt/rename/temp失败、lost key、future/corrupt/truncated manifest/blob、profile/record/hash/字节关系错配、missing、关闭后延迟写；blob外层/cipher/plain/raw及manifest各层边界+1、非canonical base64/rawLength错配/JSON深度节点、无可验证decrypt输出界。
2. 用canary检查所有落盘包/临时包都没有原件文本、raw base64、秘密和源绝对路径；memory不创建文件，坏原包字节不变。deferred追踪8文件批次与preview/run并存时raw/base64/JSON/cipher/full-decode副本，分配前预留、保留16 MiB/临时48 MiB硬限和cleanup后回收。
3. 建userData内部随机blob路径及Spec safeStorage envelope；私有managed包读取同handle max+1、严格base64预测cipher长度、decrypt前按已验证输出界预留、plain字节/结构扫描在parse前、raw长度/hash/映射最后对比。先容量/临时预留及有界encrypt，再临时密文bounded回验/rename，批次manifest commit成功才发布refs；不stat后全read。安全失效明确memory/不可用，不用机器派生fallback。
4. blob共享但逻辑ref/namespace独立；owner校验及内层version/profile/blobId/hash与manifest映射必须一致，不能复制ciphertext或猜ref绕owner。
5. 实现draft/preview/run leases、512记录/64 MiB实际密文/16 MiB保留内存/48 MiB临时工作/30天idleTTL、有限tombstone；全局byte工作槽1，picker不占槽。保护无空间拒绝，不protected prune；cancel/failure直到其实际cleanup结束才归还工作槽/内存。
6. deleteCopy/clear验证应用内部绝对目标、物理边界/身份、引用计数；shared/active延期、失败可重试。cancel batch只收新孤儿，不删旧共享blob，更不能删源。
7. GREEN记录atomic rollback、mode/durable披露、GC/dedupe/删除负测；不以fake safeStorage测试单独证明OS加密可用，实际Electron另测。

### 完成门槛

FR-05/06/10达到AC-04/08/09；所有明文仅有界内存，memory不谎称耐久；损坏包不覆盖，cache清理无用户目录/源/ACL副作用。

## 5. E5-04：session/window IPC、预览票据与取消

### 目标与文件

把reader/store能力连接成可取消、不可伪造的session/来源/预览协议。

- **计划新增**：`src/ai/attachment-preview.js`、`src/ai/attachment-ipc.js`、`tests/e5-attachment-ipc.test.js`、`tests/e5-attachment-preview.test.js`。
- 既有：[主进程](<../../../src/main.js#L978-L1023>)、[preload](<../../../src/preload.js#L4-L68>)、[项目撤权](<../../../src/main.js#L268-L286>)、[permission取消](<../../../src/ai/permission.js#L97-L151>)、[worktree owner回收](<../../../src/ai/worktree-ipc.js#L270-L272>)、[window测试](<../../../tests/e2-window-lifecycle.test.js>)、[opaque binding测试](<../../../tests/worktree-ipc.test.js>)。

### RED → 最小实现 → GREEN

1. 用两个sender/多个session/new namespace测试：forged path/bytes/storagePath/hash/status/MIME/budget/senderId、foreign token/ref/namespace、model session refs冒权；拒绝必须先于正文泄露/源读取。
2. 冷恢复只导航不授予bytes；验证actual sender native本地确认、profile/session/namespace和未被别window持有，发新window grant；旧locator/ticket/window/project grant不能恢复。
3. 实现Spec IPC逐项白名单，message:project保持纯同步；chooseExternal绑定actual BrowserWindow并在late dialog回调重验owner，drop只候选、主进程确认后capture；batch commit才返回refs。
4. prepareSend按requestKind解析current userText与token inventory；approvePlan用既有owner内批准引用/revision由main纯生成同一最终userMessage，不消耗Plan执行权。main resolve固定model/assistant/project/contextPolicy，得到final post-redaction文本/selection/预算/目标；不resolveCredential/fetch/自动compact。page从票据内存读，不提供blob/path接口。
5. 票据随机、5分钟、至多16；绑定draft/history/selection/refGeneration、最终当前user片段digest、目标/策略/解码/脱敏/预算revision。reserved/consumed CAS精确，变化/过期/重放拒绝。
6. owner controller挂navigation/destruction/project rebind/unbind/session删除；remove递增generation撤销preview和未dispatch调度，foreign cancel不影响owner。capture并发1，所有资源清理await。
7. deferred覆盖picker/capture/decrypt/prepare/claim之间cancel、late completion、owner/project/assistant撤权，验证零请求/零physical usage/无新逻辑ref泄露。

### 完成门槛

FR-03/04/06/07/09达到AC-03/05/07/10；所有grant main品牌，API不提供renderer byte/path权限；相同目标外的变化不能悄悄复用确认。

## 6. E5-05：Renderer实际预览与会话草稿

### 目标与文件

把旧上传元信息/图片Markdown路径改为真实受控文本工作流，保持E4draft/outbox语义。

- **计划新增**：`tests/e5-attachment-renderer.test.js`。
- 既有：[renderer app](<../../../src/renderer/app.js>)、[renderer样式](<../../../src/renderer/styles.css>)、[draft状态](<../../../src/renderer/e4-chat-state.js#L78-L125>)、[启动恢复测试](<../../../tests/e4-renderer-startup-drafts.test.js>)、[事件順序测试](<../../../tests/renderer-chat-event-order.test.js>)、[最终invoke测试](<../../../tests/e4-renderer-final-invoke.test.js>)、[会话生命周期测试](<../../../tests/e4-renderer-session-lifecycle.test.js>)、[migration测试](<../../../tests/e4-session-migration.test.js>)。

### RED → 最小实现 → GREEN

1. 真实production函数/boot fixture断言：点击选择/拖拽不由FileReader/dataUrl持久化正文；ref/preview属于原session，迟到回调不串当前会话；attach-only可prepare。
2. 先覆盖预览期间新编辑/排序/增删/换模型/换项目，使旧ticket失效；run-start consume只清同request/revision，不抹后来草稿，accept拒绝不消费。
3. 文件chip显示actualtype/size/status、快照时间、encrypted/memory、missing/corrupt/expired/legacy。预览使用textContent/escaped pre，不渲染Markdown/HTML，不触发脚本或嵌入远端资源。
4. 可分页查看所有final文本、未发送/截断量、估算、target与隐私；任何截断须明确确认。页关闭/失效清理临时正文，localStorage/消息仅正向ref元信息。
5. 新状态接入既有per-session pending/draft/outbox；picker/preview pending与accepted foreground区分。切换保存旧draft，delete/reload撤销控制器，owner-scoped late事件只清理。
6. 保留64 KiB/20refs旧草稿及坏容器blocked，不把容器限额改8覆盖旧数据；E5只限制本次8可外发选择，unsupported图片清楚标记，不制造“已读”话术。
7. GREEN用真实函数与actualpreload API验证，恶意文件名/HTML内容不执行、无正文storage写、重试/取消/BUSY不丢稿；实际Electron UI在E5-08补真实渲染证据。

### 完成门槛

FR-07/09/11/13达到AC-05/07/10/13；真实预览而非只展示文件名，旧dataUrl不能成为新外发/持久化路径。

## 7. E5-06：接受前复验、三协议真实文本与完整预算

### 目标与文件

在E4接受边界之前完成附件claim，只有合法lease的确认正文能进入模型请求。

- **计划新增**：`src/ai/attachment-projection.js`、`tests/e5-attachment-model-projection.test.js`、`tests/e5-attachment-send.test.js`、`tests/e5-attachment-usage.test.js`、`tests/helpers/e5-attachment-fixture.js`。
- 既有：[主进程接受/执行](<../../../src/main.js#L2134-L2277>)、[Plan批准](<../../../src/main.js#L2673-L2727>)、[消息投影](<../../../src/ai/message-schema.js#L505-L555>)、[bound client](<../../../src/ai/llm-client.js#L20-L50>)、[router](<../../../src/ai/model-router.js#L80-L150>)、[transport](<../../../src/ai/model-adapters/transport.js#L64-L87>)、[runtime](<../../../src/ai/model-runtime.js#L31-L60>)、[usage](<../../../src/ai/model-usage.js#L17-L62>)。
- 三协议：[Chat](<../../../src/ai/model-adapters/openai-chat.js>)、[Responses](<../../../src/ai/model-adapters/openai-responses.js>)、[Anthropic](<../../../src/ai/model-adapters/anthropic-messages.js>)；fixture复用[真实main底座](<../../../tests/helpers/e4-main-fixture.js#L31-L168>)、[context/wire回归](<../../../tests/e4-router-capability-context-regressions.test.js>)、[撤权竞争](<../../../tests/e4-main-revocation-race.test.js>)。

### RED → 最小实现 → GREEN

1. 真正main handlers+preload fixture、合成registry/vault/cache/reader和`.invalid` transport；记录sourceReads/credentialReads/body/attempt，不stub最终正文或跳过claim。global真实fetch禁用。
2. 请求级先断言upload/项目范围文本、BOM/emoji、attach-only和截断确认正文确进三协议stream/非stream/tool往返，而非filename descriptor；长片段+当前user合计超过旧65536slice仍与preview一致。
3. before any source/blob IO验证BUSY/owner/session/window/目标/ticket/revision/abort；main以既有parseAtRefs解析当前userText（Plan批准用main最终userMessage），规范路径/范围并去重匹配inventory。缺previewId、少报token、目录token、ref范围不一致均先拒绝；代码围栏/inline/email依旧忽略，绝不旧自动expand。
4. reserve lease后bounded验证blob；项目再读取验证所有身份与整hash，外部只读快照；源检查截止 `sourceValidatedAt`，释放源pin并冻结preview一致文本。projection只用main品牌lease，不信renderer正文map、不再用storage sanitizer截断；current片段digest匹配ticket，history/compact policy在接受时锁定，后续合法summary/tool逐轮预算。
5. 异步claim后原子再查/acquire foreground并consume票据；未接受失败释放临时保护，Plan rollback保留，只有authoritative run-start消费draft。已accepted lease的cleanup继续BUSY；未accepted操作独立cleanup只占byte工作槽/内存，不占foreground。deferred让并发纯文字chat先acquire，验证本claim BUSY、零attempt、无票据/草稿/Plan权消费；owner-scoped cancel pending claim不误停另一run。
6. 接受前可识别的附件/源/预览/预算错误必须本次零compact/memory/credential/fetch/usage，此后才compact。给现有router/context.check注入main-only operation budget：完整4 MiB wire、已知context及output预留、未知min(explicit,32000)门槛；Responses opaque annotations也计，不用rawbytes/visible文本替代；后续每轮同样guard。
7. 紧邻每次transport复验cancel/remove generation/live owner/当前项目grant/物理root/策略/助手权限；currentrun只复用lease文本，不重开源。复验返回后compact等待中源同名替换只发旧快照；同时root/grant/ref变化则abort/无后续。本次首dispatch前取消零外发，已dispatch不可追回；await Gate/native/reader/transport cleanup后释放accepted lease。
8. usage保持终态physicalattempt一次，只加main聚合count/rawBytes/selectedBytes/selectedChars/truncatedCount；未dispatch无physicalusage，估算/actual/unavailable不混淆。
9. GREEN覆盖目标/助手/策略/registry/secret-redaction generation/selection顺序/草稿变更、stale/expired/replay、每限额+1、remove在decrypt/Gate/dispatch前竞争；不自动删附件/换模型/retry。

### 完成门槛

FR-07/08/09/14/15达到AC-04/05/06/07/14；三协议均有wire/body断言，不复制transport；接受前可识别的附件/源/预览/预算错误必须早于本次compact外发，accepted lease直到cleanup终态才释放，未accepted操作不占foreground。

## 8. E5-07：Compact、历史、导出、重试与旧数据

### 目标与文件

各消费者只拿明确获准的正文，默认历史/导出/摘要不重新读取原件或恢复能力。

- **计划新增**：`tests/e5-attachment-session-compat.test.js`。
- 既有：[compact](<../../../src/ai/session-compact.js#L87-L131>)、[export](<../../../src/ai/session-export.js#L52-L148>)、[消息schema](<../../../src/ai/message-schema.js>)、[renderer状态](<../../../src/renderer/e4-chat-state.js>)、[renderer app](<../../../src/renderer/app.js>)、[usage](<../../../src/ai/model-usage.js>)、[export测试](<../../../tests/session-export.test.js>)、[legacy/migration测试](<../../../tests/e4-session-migration.test.js>)、[draft状态测试](<../../../tests/e4-renderer-chat-state.test.js>)。

### RED → 最小实现 → GREEN

1. 当前run多轮保留同一确认片段；下一次请求同历史ref默认仅元信息/“未随本次发送”。显式“再次使用”新prepare/确认；历史`@`不自动展开，foreign/projectContext撤销拒绝。
2. Responses用确切history/binding失效规则，attachment选择/有效文本变化不允许hidden续接带回未选内容；cancel/failedattempt不自动重放。
3. compact测试同时检查transcript无blob读/原件正文/dataUrl，summary后保留≤128项去重公开manifest+已有结论；超过128或验证失败保留原history不commit。record link更新与compact commit同步，active leases不删。
4. memory候选/子Agent/MCP/PR不能因attachmentId拿正文；已有用户/模型文字按既有策略处理，不把“结论”当重新加载文件的权限。
5. MD/JSON正向export，无storagePath/localAbsPath/source/cache/control绝对路径、hash/blobKey/capability/ticket、自动附件正文/manageddataUrl；旧metadata缺原件也能导出，用户既有文字/模型摘录不冒充完全匿名。
6. legacy无host记录不可用；已识别旧自动图片Markdown/dataUrl只未支持元信息，异常不确定payload保留原容器并显式阻断该次投影/导出，不能猜测回填或空覆盖。
7. retry新request/ticket/目标确认，不回放consumed票据、不覆盖等待期新draft；BUSY/接受前失败保留draft，接受后失败用既有outbox精确恢复/再次选择。Plan批准不替代附件权限。
8. store状态/clear/delete副本与会话切换/删除/关闭同步；只在main namespace内改链接/leases，不由renderer自报history授予权限。GREEN跑E2/E4/export/compact相关回归并记录原件/原容器canary不变。

### 完成门槛

FR-10/11/12/13/14/15达到AC-09/10/11/12/13/14；不向compact/memory/export/续接悄悄扩散附件正文，不破坏旧数据，元数据导出不携读取能力。

## 9. E5-08：跨层回归、真实平台及授权端点验收

### 目标与文件

把模块GREEN、实际UI/native与真实协议证据合并成有边界的验证记录，不把fixture或计划命令算通过。

- **计划新增**：`tests/e5-attachment-regressions.test.js`、`scripts/e5-electron-attachments-smoke.cjs`。
- 后续实际执行时另建**计划验证记录**：`docs/superpowers/plans/YYYY-MM-DD-e5-implementation-verification.md`，日期取实际验证日；本轮不创建。
- 既有：[E4 main/preload fixture](<../../../tests/helpers/e4-main-fixture.js>)、[原生负测](<../../../tests/e3-windows-native.test.js#L108-L120>)、[E4验证记录](<2026-10-30-e4-implementation-verification.md>)、[native构建](<../../../scripts/build-windows-isolation.cjs>)；实际UI说明在后续实现完成时更新[README](<../../../README.md>)及[总规划](<2026-10-15-phase-e-product-readiness.md>)，不是本轮越权修改。

### RED → GREEN 与证据层级

1. 先做跨层矩阵：upload/@、每文本类别、空/长/截断、三协议stream/非stream/tools、model/assistant/project变化、draft/owner/取消/cleanup、encrypted/memory/损坏/GC、legacy/history/compact/export/usage/retry。
2. 统一负测要求：接受前拒绝为requests=0、credentialReads=0、physical usage=0、source/旧container bytes不变；已经dispatch取消不虚假断言已发字节可回收，只测abort/无后续/cleanup。
3. 跑相关E2/E3/E4回归及完整回归，记录Node/Electron/native版本、实际command、timeout预算、pass/fail/cancelled/skip与影响。历史flaky/120秒取消不因新统计消失，不自行拉长预算掩盖问题。
4. 隔离临时userData与合成文件，在**实际Electron**验证真实preload/IPC、nativecapture、窗口归属、实际预览与mode/UI/关闭回收。受控dialog注入可证明callback竞争，但不能代替实际sender绑定picker及显式恢复确认的UI证据；人工native选择另列。
5. 真实Windows重复文件/ancestor/root/link/ADS/hardlink/writer等负测，核对native build校验与read-only无源ACL副作用。平台缺失/skip保留未验证，入口不得静默退旧reader。
6. 仅在单独授权后，按三个协议分别用事先生成、未见于prompt/文件名的合成文本细节验证真实模型输出。用户明确目标/模型/费用上限/临时凭据/样本；不读或上传真实私有文件，不将key写日志/记录。
7. 完整登记请求级、Electron、Windows和live矩阵；真实端点未授权就不发请求并保留正式验收开放。没有真实视觉/Office/原件包，不以“附件能力”统称已支持这些格式。

### 完成门槛

FR-16与全部AC由真实证据定位闭环，前置影响面显式登记；模块/fixture完成与正式验收分开。未获得资源不是删减三协议范围或伪造完成的理由。

## 10. 后续命令模板与安全说明

**以下命令仅供后续实施授权、文件已创建和环境核对后使用；本轮均未执行。** 无新依赖安装/工具链升级授权。native构建与test写临时文件/产物，真实端点另需明确授权。

```powershell
# 单项测试只在对应实现/测试文件已创建后执行，并记录实际RED/GREEN。
node --test tests/e5-attachment-contract.test.js
node --test tests/e5-attachment-reader.test.js tests/e5-attachment-store.test.js
node --test tests/e5-attachment-ipc.test.js tests/e5-attachment-preview.test.js
node --test tests/e5-attachment-renderer.test.js tests/e5-attachment-send.test.js
node --test tests/e5-attachment-model-projection.test.js tests/e5-attachment-usage.test.js
node --test tests/e5-attachment-session-compat.test.js tests/e5-attachment-regressions.test.js

# 后续native校验；构建会写产物，不能当作本轮只读文档检查。
node scripts/build-windows-isolation.cjs
node --test tests/e5-attachment-native.test.js

# npm test会触发pretest；如直接Node运行，先完成规定native构建。
# 600000仅为历史E4文件预算模板，不是生产model/capture timeout。
node --test --test-timeout=600000 tests/**/*.test.js

# 后续实际Electron脚本，独立临时userData、合成文件、无默认真实网络。
.\node_modules\.bin\electron.cmd scripts\e5-electron-attachments-smoke.cjs
```

每次实际执行保存完整结果、失败literal/取消原因及fixture/native/live分类。未创建测试、native缺失或skip时登记未验证；不得把当前旧测试通过数写成E5已通过。E5生产capture为30秒、E4 model timeout保持现有策略，不能与测试文件预算混用。

## 11. FR → Task → AC 追踪

| FR | 任务 | 必要验收 | 核心证明 |
| --- | --- | --- | --- |
| FR-01 | E5-01、E5-02 | AC-01 | 实际UTF-8/type/范围/空文件与惰性文本 |
| FR-02 | E5-02、E5-08 | AC-02 | 同handle max+1/ancestor身份及真实源/ACL不变 |
| FR-03 | E5-02、E5-04、E5-06 | AC-03 | 外部/@分离、旧读取旁路、foreign/forged拒绝 |
| FR-04 | E5-04、E5-05、E5-07 | AC-03、AC-10 | main namespace/window grant与冷恢复确认 |
| FR-05 | E5-03 | AC-08 | 密文/memory/坏原包保护、无plaintext |
| FR-06 | E5-01、E5-02、E5-03、E5-04、E5-06 | AC-04 | 每维+1及最终wire/输出预留/未知门槛 |
| FR-07 | E5-04、E5-05、E5-06 | AC-05 | finalpreview一致、revision/nonce/CAS |
| FR-08 | E5-06、E5-08 | AC-06 | 三协议实际body、接受前防compact外发 |
| FR-09 | E5-04、E5-05、E5-06 | AC-07 | race零外发、cleanup lease、不fallback/重放 |
| FR-10 | E5-03、E5-07 | AC-09 | 状态/dedupe/TTL/GC仅清副本 |
| FR-11 | E5-05、E5-07 | AC-10 | draft/outbox准确消费、迟到事件/切换/删除 |
| FR-12 | E5-06、E5-07 | AC-11 | 历史/compact/memory无隐式附件原文 |
| FR-13 | E5-01、E5-05、E5-07 | AC-12、AC-13 | default export/legacy原数据完整 |
| FR-14 | E5-06、E5-07 | AC-14 | physical usage单次与估算/未知真实呈现 |
| FR-15 | E5-06、E5-07 | AC-07、AC-11 | 新确认重试、Responses exact-history |
| FR-16 | E5-08 | AC-15 | 分层真实证据及前置开放项 |

全部AC定义以Spec第十一节为准。每个任务的GREEN和实证登记必须引用这些ID，不以“功能看起来正常”替代负测。

## 12. 风险与回退边界

| 风险 | 检查/约束 | 不能采用的回退 |
| --- | --- | --- |
| 新reader安全但旧read/atRef仍可读任意root | 列出并绑定全部参与读取/补全callsite，sourceReads负测 | 隐藏旧按钮却保留IPC |
| 仅token/string路径，物理root/ancestor被替换 | binding冻结identity、native handle链及pre-send hash | lstat→readFile、sample/text两次开文件 |
| 复用native执行器触发ACL/遍历/shell副作用 | 独立capture mode、source/ACL/目录前后canary | 把命令隔离运行当文件读取 |
| 后台模式/坏包被写成plaintext或空包 | safeStorage-only、memory原因、原包hash保护 | SecretManager机器派生key、localStorage base64 |
| preview后sanitizer悄悄截断 | finalprojection/digest/Unicode边界与>65536案例 | 放大全局storage预算、确认后slice |
| 异步claim先外发compact或先消费Plan/draft | 接受顺序、deferredraces、零attempt和rollback | 只在最后messagesForModel加检查 |
| 隐式history/Responses/memory泄漏正文 | run scopedlease、下一次metadata、exacthistory失效 | 复用opaque续接或读缓存自动补齐 |
| GC/删除共享blob或用户源 | main链接/lease、内部身份、protected失败报告 | renderer path递归rm、假称远端内容已擦除 |
| 原legacy图像/坏容器被迁移丢失 | 原container/canary、unavailable标识、异常显式阻断 | 空覆盖、metadata ready、假看图 |
| tokenizer/窗口/计费未知 | 输出预留、现有估算、未知门槛与actual/estimated分开 | 把base64长度或32,000称精确/实测 |
| 只fixture/native skip、真实端点未授权 | 分层验证矩阵/前置开放项 | 修改文档标全部完成或自行外发 |

E5只闭合其读取/发送/缓存边界，不替剩余E3执行/写入/平台边界宣称全局权限完成。发现会影响E5的旧读取旁路必须阻断集成验收并修正；不因计划阶段已授权文档而自动扩展到其他业务重构。

## 13. 实证登记模板与最终门槛

后续验证记录至少包含：基线/最终commit、环境和native版本/完整性、每任务RED→GREEN、实际commands/timeout、请求/源读取/credential/usage计数、source/原container完整性、取消/清理证据、Electron/native/live矩阵、失败/skip及前置影响面。

| 证据层 | 当前状态 | 后续需要 |
| --- | --- | --- |
| 设计/静态依据 | 本轮完成文档，不等于功能 | Spec/Plan/index/追踪一致 |
| E5 unit/main/renderer fixture | 本轮未执行 | 各task实际RED/GREEN与负测 |
| E5完整E2/E3/E4回归 | 本轮未执行 | command/预算/pass/fail/cancelled/skip及影响 |
| 实际Electron附件workflow | 本轮未执行 | 真实preload/UI/owner/picker恢复确认与mode/cleanup |
| 实际Windows只读capture | 本轮未执行 | 新模式identity/links/writer/源ACL不变和build校验 |
| 三协议真实模型 | 未授权、未请求 | 各协议合成文件细节/目标/费用/临时凭据独立授权与结果 |
| E2/E3/E4前置正式验收 | 继承开放项 | 引用原记录，按影响面核对，不伪造关闭 |
| E6/E7/E12后续能力 | 本期不实施 | 不以E5验收覆盖 |

**本轮文档完成门槛**：只新增Spec/Plan并更新E5索引；链接/行锚、FR/Task/AC、预算/错误/来源/状态/术语一致；拟新增文件明确、无关键TBD、无超范围实现或虚假测试/验收结论。

**后续功能完成门槛**：E5-01～E5-08对应实现与相关回归有实证，源与旧数据不损、反向安全失败成立。**正式验收门槛**：再有实际Electron、真实Windowscapture及三协议授权端点矩阵，并处理前置影响面；任何缺口如实开放，不自动开始E6/E7/E12。
