# Phase E5：文本附件与受控附件存储设计规格

**状态：设计已批准并实施；实现与分层验证见 [E5 验证记录](<../plans/2026-11-03-e5-implementation-verification.md>)。正式真实端点/OS 用户手势验收未执行。本文是设计契约，不替代测试证据。**

文档日期：2026-11-03。静态检查基线：`91f3bd028e5b8ae1f87ca75298501bae42c70486`；只读环境记录：Windows、Node `v22.22.0`、npm `11.16.0`，项目声明 Electron `33.2.1`。日期仅用于文档标识，不表示排期。

关联：[Phase E 总规划的 E5](<../plans/2026-10-15-phase-e-product-readiness.md#L133-L146>)、[E5 实施计划](<../plans/2026-11-03-phase-e5-text-attachments-controlled-storage.md>)、[E2/E3 前置记录](<../plans/2026-10-28-e2-e3-frontgate-closure.md>)、[E4 规格](<2026-10-29-phase-e4-model-capabilities-assistants-design.md>)、[E4 实现与验证记录](<../plans/2026-10-30-e4-implementation-verification.md>)。

本文件初稿仅输出 Spec、Plan 与总规划索引。后续开发已获用户授权并实施，实际执行与证据边界见 [E5 验证记录](<../plans/2026-11-03-e5-implementation-verification.md>)；下文仍是设计要求而非执行日志。开发授权不包含真实凭据/模型端点、E6/E7/E12 或原件导出。

## 一、目标、范围与完成口径

### 1.1 产品目标

将附件从“名称/大小提示”升级为**主进程受控导入、用户可查看实际外发文本、在固定目标上真实发送**的能力，同时闭合读取预算、来源授权、引用归属、缓存隐私与取消竞争。

成功不以附件卡片出现或模型复述文件名为准：请求级证据必须显示所选文件的确认文本进入实际协议请求；正式验收还需受控真实端点、真实 Electron 与 Windows 文件能力证据。

### 1.2 首期支持与处理方式

| 输入 | E5 处理 | 不据此承诺 |
| --- | --- | --- |
| UTF-8 / UTF-8 BOM 普通文本 | 严格解码，保留文本与换行语义；可为空文件 | 不自动转码、不修复损坏编码 |
| 代码、Markdown、配置文本 | 惰性文本显示与发送；不执行、不渲染活动内容 | 不运行脚本、宏、HTML、外部链接或正文里的 `@` |
| JSON / JSONC / CSV / TSV | 当 UTF-8 文本接收；包括用户想诊断的错误语法 | 不求值、合并对象、验证业务 schema、计算公式或宣称表格解析完成 |
| 项目 `@文件`、`@文件:起始行-结束行` | 复用既有词法；主进程验证绑定和相对路径后形成受控快照 | 不把目录变成递归附件、不把代码块/邮件中的 `@` 当读取指令 |
| 外部用户选取文件 | 本次选取授予一次 capture；以后使用应用副本 | 不授予工具长期读取源路径或遍历外部目录的能力 |

首期扩展名白名单按大小写不敏感处理：`.txt`、`.md`、`.markdown`、`.json`、`.jsonc`、`.csv`、`.tsv`、`.js`、`.cjs`、`.mjs`、`.jsx`、`.ts`、`.tsx`、`.py`、`.java`、`.c`、`.h`、`.cpp`、`.hpp`、`.cs`、`.go`、`.rs`、`.rb`、`.php`、`.sh`、`.ps1`、`.bat`、`.cmd`、`.css`、`.html`、`.htm`、`.xml`、`.yaml`、`.yml`、`.toml`、`.ini`、`.conf`、`.log`、`.sql`；无扩展名只允许 `README`、`LICENSE`、`Makefile`、`Dockerfile`、`.gitignore` 这些明确定义的名称。扩展名只决定文本类别，**不能替代字节、编码和魔数检查**。未知名称明确不支持，不靠 renderer MIME 放行。

图片、PDF、Office、压缩、音视频、可执行文件及其已知魔数，即使改名为 `.txt` 也拒绝。UTF-16/32 BOM、坏 UTF-8、NUL、除 TAB/LF/CR 外的 C0 控制字符拒绝。UTF-8 验证及有限魔数识别不是全格式、恶意内容或隐私识别器；合法文本中的指令仍是不可信用户数据。

### 1.3 非目标及阶段边界

| 非目标 | 承接/约束 |
| --- | --- |
| 图像 content parts、看图、视觉 token 计费 | E6；不能发送 Markdown/base64 并显示“已看图” |
| PDF/Office/OCR/压缩/媒体提取、格式 worker | E7；本期不引入解析依赖 |
| 原件附件包、导入恢复、可携带的缓存或能力 | E12；默认导出仅安全元数据 |
| 通用任务调度、跨会话并行、崩溃自动续跑 | E10/E14；保留 E4 单前台租约 |
| 精确 tokenizer、完整计价/预算产品、缓存折扣 | E11；保留 actual/estimated/unavailable |
| 自动向子 Agent、MCP、记忆、PR 工作流分享正文 | 不因附件引用获得权限；E5 不新增正文共享 grant |
| 自动 Git 提交、安装/升级工具链、修改用户源文件 | 不在本次文档或后续默认实施权限内 |

### 1.4 前置与证据门槛

E2/E3/E4 是集成前置。独立契约、reader 和缓存测试可分步实现；集成验收必须核对消息/Plan/Gate/秘密/窗口/模型回归。E2/E3 的历史全量不稳定、平台证明限制以及 E4 的真实端点缺口继续登记，不因为 E5 文档完成而关闭。

E4 历史记录中离线专项 `691/691`、完整回归 `1879 pass / 0 fail / 0 cancelled / 1 skip`（600 秒测试文件预算）和隔离实际 Electron 14 项检查是历史事实，不是本轮重新执行，也不证明 E5 capture 或真实端点。具体范围以[验证记录](<../plans/2026-10-30-e4-implementation-verification.md>)为准。

## 二、事实基线与必须收敛的缺口

以下是只读源码/已有测试定位，不是本轮运行结果。入口是主进程服务目录，不存在供本设计复用的 `src/main/` 或 `src/shared/messages.js`。

| 现状 | 依据 | E5 决策 |
| --- | --- | --- |
| 主进程解析模型和 sender-owned 项目 binding | [主进程上下文](<../../../src/main.js#L251-L286>)、[worktree binding](<../../../src/ai/worktree-ipc.js#L17-L75>) | 继续使用主进程权威，补充物理根身份；token 存在不等于目录对象未替换 |
| 旧项目读/补全接口接受 renderer 路径 | [项目 IPC](<../../../src/main.js#L1833-L1853>)、[@ IPC](<../../../src/main.js#L2081-L2105>)、[preload](<../../../src/preload.js#L56-L68>) | 收敛所有参与附件/项目读取与补全的旧入口，不能保留原始路径旁路 |
| 文件 sandbox 返回路径，随后 stat/按路径读取 | [路径验证](<../../../src/ai/os-isolation.js#L61-L150>)、[项目读取](<../../../src/ai/project-fs.js#L186-L222>) | 不能作为 E5 安全 reader；使用同一 handle、ancestor 身份及读取硬预算 |
| 旧 `@` caps 限输出，正文仍可能全读；sample 与正文两次开文件 | [旧 caps](<../../../src/ai/at-ref.js#L9-L19>)、[展开](<../../../src/ai/at-ref.js#L229-L277>) | 保留 [parseAtRefs](<../../../src/ai/at-ref.js#L78-L119>) 词法，不保留危险字节读取 |
| E2 attachment_ref 接收元数据，默认 ready，还保留 storagePath | [引用规范化](<../../../src/ai/message-schema.js#L149-L168>)、[存储投影](<../../../src/ai/message-schema.js#L565-L577>) | 公开正向白名单；历史/renderer 状态不构成文件权限 |
| 模型投影只发送描述，最后统一字符串截断 | [模型投影](<../../../src/ai/message-schema.js#L505-L555>)、[stripSecrets](<../../../src/ai/message-schema.js#L123-L140>) | 有界模型正文投影与存储截断分开，不能在确认后再次悄悄 slice |
| 自动 compact 早于现有 `@` 展开 | [接受入口](<../../../src/main.js#L2134-L2200>)、[chat 执行](<../../../src/main.js#L2217-L2277>)、[模型投影调用](<../../../src/main.js#L2443-L2443>) | 接受前可判定的附件/预览/源/预算错误早于本次 compact/memory/model 外发 |
| 单前台、定向取消、cleanup 后释放已有实现 | [foreground runtime](<../../../src/ai/model-runtime.js#L31-L60>)、[owner 生命周期](<../../../src/main.js#L978-L1023>) | 复用该租约，不增加无归属异步链或提前释放 |
| Windows launcher 的 handle 检查服务命令隔离，会修改 ACL | [native handle/Walk](<../../../src/native/windows-isolation/Launcher.cs#L48-L109>)、[root pin](<../../../src/native/windows-isolation/Launcher.cs#L230-L233>) | 新增独立只读模式，不能调用整树 Walk/执行模式读取附件 |
| safeStorage-only 密文原子存储已有范例 | [ProjectIndex](<../../../src/ai/project-index.js#L200-L250>)、[PrAuditStore](<../../../src/ai/pr-audit-store.js#L62-L99>)、[repair store](<../../../src/ai/pr-audit-repair-store.js#L25-L96>) | 复用密文临时写→解密回验→rename→明确 memory 模式 |
| SecretManager 的 fallback 是机器指纹派生密钥 | [加密实现](<../../../src/ai/secret-manager.js#L108-L148>)、[注册/脱敏](<../../../src/ai/secret-manager.js#L212-L242>) | 不用该 fallback 保存附件；只复用已有已注册秘密脱敏 |
| 持久草稿只有安全元信息，超限保留内存/原数据 | [draft 白名单与预算](<../../../src/renderer/e4-chat-state.js#L78-L125>)、[启动恢复测试](<../../../tests/e4-renderer-startup-drafts.test.js#L90-L112>) | E2 消息 v2、会话 v3 加性扩展，不全局缩小/放宽旧草稿或覆盖坏容器 |
| compact 只保留摘要及 keep；export 经存储投影 | [compact](<../../../src/ai/session-compact.js#L87-L131>)、[export](<../../../src/ai/session-export.js#L52-L148>) | 保留有界引用 manifest，默认导出不携附件 payload 或内部路径 |
| 三协议是字符串消息，wire/context/usage 已有最后防线 | [router](<../../../src/ai/model-router.js#L80-L150>)、[transport](<../../../src/ai/model-adapters/transport.js#L64-L87>)、[usage](<../../../src/ai/model-usage.js#L17-L62>) | 复用 binding/client/router；不复制网络栈、不把估算写成实报 |

## 三、功能需求与不变量

### 3.1 功能需求

| ID | 必须交付 | 验收 |
| --- | --- | --- |
| FR-01 | 文本白名单、严格编码/实际类型检查、空文件及行范围的明确语义 | AC-01 |
| FR-02 | 有界只读同-handle capture、ancestor/源/root 身份与无副作用证明 | AC-02 |
| FR-03 | 外部一次 capture 与项目 `@` 权限独立；封堵旧读取旁路 | AC-03 |
| FR-04 | 主进程 session/window/namespace 归属；重启不恢复授权 | AC-03、AC-10 |
| FR-05 | safeStorage-only 密文缓存、明确 memory、坏包/丢钥不覆盖 | AC-08 |
| FR-06 | 单文件、数量、总字节、提取、整请求、缓存和并发预算 | AC-04 |
| FR-07 | 可分页查看最终文本/截断/目标；一次性主进程预览票据 | AC-05 |
| FR-08 | 接受前复验；三协议实际发送文本，完整 wire/context 防线 | AC-06 |
| FR-09 | 取消/移除/撤权/窗口失效安全失败；无隐式重试、去附件或换模型 | AC-07 |
| FR-10 | missing/corrupt/expired/deleted/revoked 可见，去重/lease/GC只清副本 | AC-09 |
| FR-11 | per-session draft/outbox、revision 竞争与会话切换/删除/重载 | AC-10 |
| FR-12 | 本 run 复用确认文本；历史/compact/记忆不自动重新加载正文 | AC-11 |
| FR-13 | 默认 MD/JSON 安全元数据导出；legacy 不授予字节权限或毁原数据 | AC-12、AC-13 |
| FR-14 | 物理请求 usage 正确归因、附件指标仅摘要、估算/未知真实呈现 | AC-14 |
| FR-15 | 显式重试重新确认，Responses 续接不带回未确认历史正文 | AC-07、AC-11 |
| FR-16 | 分离静态/fixture/Electron/native/live 证据，保留前置开放项 | AC-15 |

### 3.2 不可破坏的不变量

1. `attachmentId`、历史消息、公开 hash/ready、`sessionId` 或 [models:syncSessionReferences](<../../../src/ai/model-ipc.js#L151-L162>) **均不是字节能力**；只接受主进程当前品牌 grant。
2. 附件保持 user 数据角色，不进入 system，不取得 shell、网络、tool 或外部目录权限；助手 nativeTools/project/memory 策略继续生效。
3. `contextPolicy.projectContext === false` 拒绝本次项目 `@`；明确外部上传属于用户本次提供的内容，可在支持 text 的目标上独立确认，不伪装为项目授权。
4. 文件正文不进入日志、telemetry、错误栈、usage、localStorage、消息持久化、插件状态或默认导出。已注册秘密先脱敏再给预览；实际发送同一结果，不能仅 UI 脱敏。
5. 所有附件的 import/prepare/claim 失败都不能静默 fallback 为元信息或纯文字继续发送。用户自行移除附件后新发纯文字是新请求，不是自动降级。
6. 硬读取预算在读取之前执行，最多读 `maxFileBytes + 1` 用于超限判断；不能先全读再截断。每次内容检查及 hash 来自同一被验证的 handle。
7. 取消是阻止未来调度并等待清理，不是回收已外发字节；accepted lease 在 Gate、native capture、reader/transport 清理完成后才 release。
8. 删除缓存只删除内部生成路径、已验证身份的应用副本；用户原件及旧存储原容器不被清理/迁移逻辑修改。

## 四、分层与新增模块

下列路径是**计划新增**，不是已有实现文件：

| 模块 | 责任 | 禁止承担 |
| --- | --- | --- |
| `src/ai/attachment-contract.js` | 常量、公开 DTO/错误/状态、内部字段校验与预算单位 | 读文件、发网络、信任 renderer authority |
| `src/ai/attachment-reader.js` | 主进程 native capture 包装、取消/超时、严格解码、类型/范围提取 | 使用旧 readFile、启动 shell、执行文本 |
| `src/ai/attachment-store.js` | 不可变 blob、密文 manifest、引用关系、leases、GC、模式披露 | plaintext 落盘、原件删除、授权恢复 |
| `src/ai/attachment-preview.js` | session capability、owner/controller、prepare/claim、随机票据/CAS/撤销 | 复制 model client、把票据持久化 |
| `src/ai/attachment-projection.js` | 主进程纯文本投影、最终摘要、预算守卫及 usage 摘要 | 文件 IO、使用存储 sanitizer 静默截断正文 |
| `src/ai/attachment-ipc.js` | live sender、白名单、会话/项目解析、安全 DTO 与生命周期 | 暴露任意路径 FS、源字节、品牌对象 |

既有 [preload](<../../../src/preload.js#L4-L8>) 的同步 `message:project` 继续只负责 normalize/ui/storage 纯投影，**不允许 IO、读取附件或注入 renderer 的正文 map**。新增异步附件 IPC 走引用，主进程模型投影才接受品牌 lease。

模型调用继续使用 [createModelChatFunction](<../../../src/ai/llm-client.js#L20-L50>)、已有主进程binding和三协议router：`openai-chat-completions`、`openai-responses`、`anthropic-messages`。未知上下文/整次附件预算守卫由主进程注入现有router的 `context.check`；如需要，增加向后兼容的**主进程内部**guard参数，不增加renderer可覆盖的模型request字段，不改变 `ModelMessage.content: string` 或另建transport。

## 五、数据契约与授权

### 5.1 公开 AttachmentRefV1

公开记录正向投影为：

```js
{
  refVersion: 1,
  attachmentId: 'att_<128-bit-random>',
  name: 'basename-only',
  mimeType: 'text/plain',
  size: 1234,                      // capture 的实际原始字节；不是 renderer size
  source: 'user_upload',          // 或 at_project_ref
  status: 'ready',
  storageMode: 'encrypted',       // 或 memory
  budget: {
    extractedChars: 1000,
    selectedChars: 1000,
    selectedBytes: 3000,
    estimatedTokens: 750,
    truncated: false
  }
}
```

- ID 由主进程 `crypto.randomBytes(16)` 或等熵来源生成，前缀明确；不可用内容 hash、时间戳或路径生成。
- `name` 来自真实源 basename，最多 255 个 Unicode 码点；路径分隔符/控制及欺骗性格式字符不得进入名称，超长显示明确省略。公开 ID/request 字符串不超过 256 字符；模型/助手 ID 继续遵守 E4 限制。
- MIME 是主进程文本类别，不证明 JSON/CSV 语法正确；UTF-8 验证不等于内容安全/隐私检查。
- 预算中的 `estimatedTokens` 只是文本估算，供应商 usage 在物理请求终态另行记录；prepare 返回本次最终值，持久元数据不构成新请求的预算授权。
- 不包含 `storagePath`、`localAbsPath`、源绝对路径、blobKey、原始或最终 hash、base64/dataUrl、正文、文件身份、window/session grant、previewId、模型 binding 或凭据。
- 公开附件引用不能合成新字节记录。旧 `tool_output` source 仍可作兼容元信息，但 E5 不提供 tool_output 字节导入；无 host 记录标为 `legacy_unavailable`。
- 去重提示通过同一已授权会话的操作结果提供，不暴露其他 owner 是否已有同一 blob。

### 5.2 私有记录与品牌对象

`AttachmentRecordV1` 保存于主进程及加密 manifest，至少包含：recordVersion、attachmentId、profileNamespace、logicalSessionId、sessionNamespaceRef、sourceKind、内部 blobKey、原始 SHA-256/字节数、解码/提取版本、选取时间、TTL/访问时间、refGeneration、draft/message 逻辑链接及状态。`at_project_ref` 另保存 projectId、规范相对路径、所选行范围、root/source/ancestor 对象身份与 grant generation；不把窗口 grant 或运行票据存盘。

外部 upload 在 capture 完成后丢弃源绝对路径/重开能力，保留来源类别、basename、选取时间和审计身份。记录和 blob 不可因源路径变化而改内容；刷新/重新选择生成新 capture 与新逻辑记录。

主进程内部品牌对象：`AttachmentSessionGrant`、`CaptureGrant`、`PreparedAttachmentLease`、`AttachmentOperationBudget`。使用 WeakMap/不可序列化品牌并复验 scope；JSON 对象、renderer 字段或复制 opaque ID 不能构造它们。

### 5.3 会话归属及重启恢复

- 新附件会话由 main 建立逻辑 namespace，并签发仅内存的 `attachmentSessionBindingId`，绑定真实 sender、逻辑 session、namespace 及 generation。每个异步操作匹配该 capability，不以 renderer sessionId 为授权。
- 加密 manifest 中的 namespace locator 可以用于导航，不是 capability。新导入、预览、移除和发送都要求当前窗口 grant。
- 冷启动/重载默认仅显示原容器的安全元信息；用户点击“恢复本地附件”后，主进程向实际 sender 窗口显示一次本地恢复确认。确认后核对 manifest 中的逻辑 session/namespace、当前 profile 和未被其他窗口持有，才发新窗口 grant。
- 活动 namespace 不自动跨窗口移交；foreign 读/claim 返回统一无权引用错误，不泄露其他 owner 的正文/路径。原 owner 关闭或显式释放后才可重新确认绑定。
- sender navigation/destruction 撤销窗口、capture、preview 和 lease controller；不会删除耐久副本，不恢复源读取授权。项目重新绑定/解绑额外撤销相关 `@`，不把外部上传变成项目 grant。

### 5.4 状态机

| 层 | 状态/转移 | 规则 |
| --- | --- | --- |
| 导入操作 | queued → capturing → validated → committed；任一步 → cancelled/failed | 只有完整批次 committed 发布引用；临时文件/handles 均清理 |
| 附件记录 | ready → missing/corrupt/expired/deleted/revoked | 由 main 验证，renderer ready 无效；同一 ID 内容不原地替换 |
| legacy | legacy_unavailable / unsupported | 仍可展示安全元信息；不能借路径或名称补齐字节 |
| 预览 | prepared → reserved → consumed；或 stale/cancelled/expired | reserved 仅 owner 内部暂占；原子 acquire 成功才 consumed；不能重放 |
| 存储 | encrypted / memory，另有 unavailable/corrupt 原因 | 模式和耐久性按记录披露；memory 关闭后失效 |

去重是操作提示，不是 `ready` 的替代状态。损坏、未知版本与权限撤销不能伪装为“文件不存在，自动重读”。被 GC 移除的记录/有限 tombstone 不承诺永久保留诊断；旧引用仍明确 unavailable/missing，不自动合成能力。

## 六、只读 capture、范围和预算

### 6.1 Windows 原生模式

在既有 [Launcher.cs](<../../../src/native/windows-isolation/Launcher.cs>) 增加 `--capture-file`，与命令执行分支严格隔离：

1. 调用仅来自主进程，输入为本次品牌 capture scope；拒绝设备/ADS/UNC/绝对路径冒充相对路径及受保护主进程 userData/vault/cache/control 来源。
2. 从可信物理 root/外部明确选取的路径锚点逐级打开并 pin ancestors；验证 handle 的 physical path、volume/fileId、reparse 属性和 expected identity。项目 root 必须与 binding 冻结对象一致，不只比较字符串。
3. 源文件打开 `GENERIC_READ`，只 share READ，拒绝 writer/delete 共享及 hardlinks；检查所有所需对象，不调用整树 Walk、ACL 修改、shell/Job 或原目录临时写入。
4. 前后检查同一 handle 的信息，整个读取持 pin；读取最多 `maxFileBytes + 1`，超限失败，不按 metadata size 分配无界数组。
5. 私有有界 IPC 回传字节/身份，不把原件或解密正文落入临时文件、stdout 日志或通用工程事件。捕获输出通道需限制字节数并支持取消；源码/构建 manifest/hash 链同步更新。
6. finally 关闭所有 handles，主进程等待 helper/reader 清理后结束操作。capture 结束即释放源 pins，不在用户预览的五分钟内锁住编辑器。

仅 final `O_NOFOLLOW`、lstat→open 或“有 E3 launcher”不能证明 ancestor 替换已闭合。首要验收平台是 Windows；其他平台/原生能力缺失时明确禁用入口，不回退旧 path read 并仍标为安全。

### 6.2 内容提取

先在硬字节限内完成完整 UTF-8 fatal 验证和 raw hash，再移除 UTF-8 BOM；保留 CRLF/LF、缩进、Unicode，不 trim、normalize Unicode 或执行任何解析器。空文件合法；标记为空，确认后发送明确空文件标识。

上传默认选取文本前缀。每文件最终片段最多 65,536 Unicode 码点；超出标记 `truncated`，列出原始字节、可提取/所选字符和未发送部分。用户可以缩小前缀并生成新预览；**不在发送阶段继续缩短**。

项目行范围沿用 `parseAtRefs` 的 1-based `startLine/endLine` 语义：正整数、end ≥ start，显式范围最多 500 行；无范围至多取前 2,000 行，之后仍受 65,536 码点限制。范围越界/空选择明确反馈，不静默改成整文件。范围仍对整个 2 MiB 内文件做编码及 hash 验证；不以稀疏读取绕开真实类型检查。目录 token 只用于有权补全导航；发送目录引用报不支持并提示选择具体文件。

已注册秘密先脱敏，再计算最终片段/UTF-8 字节/hash/估算；如果脱敏导致预算变化，在 prepare 阶段生成新披露结果。确认后脱敏规则 generation 变化使票据失效。不能承诺自动发现文件里的全部秘密/隐私，预览必须提示“将向所示模型/端点发送文本”。

### 6.3 固定默认预算

所有常量在主进程 contract 定义，renderer 仅显示；本期不提供放宽硬上限的 renderer override。

| 常量/单位 | 默认值 | 检查点/失败行为 |
| --- | --- | --- |
| `MAX_FILE_BYTES` | `2 * 1024 * 1024` | native 读取前和同 handle max+1；超限拒绝 |
| `MAX_SELECTION_FILES` | `8` | upload 与本次 `@` 合并计数，去除同一 token/范围重复后检查；拒绝不截短列表 |
| `MAX_SELECTION_RAW_BYTES` | `8 * 1024 * 1024` | 同批次/发送选取的实际原始字节之和；截取少量正文不绕过 |
| `MAX_FILE_TEXT_CODEPOINTS` | `64 * 1024` | 最终单附件文本；超出在预览明确 prefix/范围截断 |
| `MAX_SELECTION_TEXT_CODEPOINTS` | `256 * 1024` | 附件片段总量；超限要求用户缩小/移除，不自动分配额度 |
| 完整 request bytes | 既有 `4 * 1024 * 1024` | system/history/tools/附件/JSON/协议续接均计入，最后 transport 再校验 |
| 已知上下文 | 已接受 binding 的声明 + 输出预留 | 沿用现有估算；不足拒绝或用户先处理旧历史，不能删附件/换模型 |
| `UNKNOWN_CONTEXT_APPROX_LIMIT` | `32000` | 与更低现有显式设置取 min，输入估算 + 输出预留不超过门槛；不是模型实测窗口 |
| `MAX_CACHE_DISK_BYTES` | `64 * 1024 * 1024` | 计实际密文 manifest/blob/临时包，写前预留；保护记录无空间时拒绝 |
| `MAX_CACHE_RECORDS` | `512` | 逻辑记录与有限 tombstone 总数；不靠小文件无限增加 metadata |
| `MAX_CACHE_MEMORY_BYTES` | `16 * 1024 * 1024` | 主进程保留的 raw/text/metadata 受控账户，含 preview/lease；不是整个 Electron RSS 保证 |
| `MAX_ATTACHMENT_WORK_BYTES` | `48 * 1024 * 1024` | 全应用独立临时工作账户；包含显式创建的read buffer、base64/JSON/解密字符串、cipher buffer、完整decode及序列化副本，分配前预留 |
| `MAX_BYTE_OPERATION_CONCURRENCY` | `1` | capture、cache read/decrypt/encode、prepare/claim共用工作槽；第二个显式忙，不无界排队；picker等待不占槽 |
| `CACHE_IDLE_TTL_MS` | `30 * 24 * 60 * 60 * 1000` | 按验证访问时间；active lease 期间不淘汰，结束后可 expired |
| `MAX_CAPTURE_CONCURRENCY` | `1` | 全应用；第二个显式返回忙，不无界排队 |
| `CAPTURE_TIMEOUT_MS` | `30000` | 用户完成 picker 后开始；超时取消并等清理 |
| `PREVIEW_TTL_MS` | `5 * 60 * 1000` | prepare 后开始，单次票据；过期需新预览 |
| `MAX_PREVIEWS` / `PREVIEW_PAGE_CODEPOINTS` | `16` / `16 * 1024` | 全应用预览数与每页；页码/offset 有界，不暴露任意读取 |
| `MAX_COMPACT_ATTACHMENT_REFS` | `128` | 去重 manifest 中的公开引用；超限显式阻断 compact，保留原消息 |
| `MAX_BLOB_PACKAGE_BYTES` / `MAX_BLOB_CIPHER_BYTES` / `MAX_BLOB_PLAIN_BYTES` | `4 MiB` / `3 MiB` / `3 MiB` | 单blob外层raw包、base64解码后的密文、解密后JSON的UTF-8字节；内层原件仍最多2 MiB |
| manifest 结构预算 | 明文 `2 MiB`、密文 `3 MiB`、外层包 `4 MiB`、512 rows、深度 8 | 外层同handle max+1；解密前预留输出，parse前检查明文字节/结构，严格版本/字段/数量 |
| `MAX_PACKAGE_JSON_NODES` | `65536` | 外层/内层JSON在完整parse前做有界深度/节点/数组扫描；不先构造无界AST再检查 |

16 MiB是保留缓存账户，**不排除临时副本后又声称它限制全部内存**：临时副本使用另一个48 MiB硬账户，二者同时计账且共用全局工作槽，因此应用显式管理的附件bytes/strings总预留不超过64 MiB。Buffer按实际长度，字符串保守按 `2 * UTF-16 length`，metadata/对象用有界节点与保守预留计入；共享底层只计一次，不能用slice保留未计入的完整原件。批次逐文件处理，manifest、preview、run和其他未完成批次的保留空间一起核算。不能先生成base64/JSON、调用decrypt或分配array后才检查额度；失败/cancel不释放仍被helper/crypto/IPC持有的预留，等cleanup后回收。crypto/运行时内部开销不冒充整个进程RSS保证；只准入已有可验证有界输入/输出的安全backend，不能证明解密输出上界时禁用durable读取、明示memory/不可用。

字符一律注明 Unicode 码点；字节为 UTF-8 或实际 raw/cipher bytes；既有 token 估算仍是 JSON/文本 `.length / 4` 路径，不把码点、UTF-16 code unit、raw bytes、token 当同一单位。中文/emoji、协议开销和 Responses opaque 续接均需反向测试。未知窗口的 32,000 是 E5 操作限制，须进入 accepted budget/display 和现有 router 的最终 guard，不用旧 usage 展示 fallback 伪装为实测。

## 七、IPC 与预览/发送契约

### 7.1 异步白名单

以下为**计划新增 IPC**；除登记/恢复外，公共 envelope 要求 `sessionId`、`attachmentSessionBindingId` 和操作 `clientRequestId`，sender 来自 Electron event。

| IPC | 允许参数/返回 | 主进程行为 |
| --- | --- | --- |
| `attachments:registerSession` | 新逻辑 sessionId；返回窗口 grant ID/namespace locator | 创建新 namespace；不能凭 ID 接管已有记录 |
| `attachments:restoreSession` | sessionId、namespace locator；返回安全状态/新 grant | live sender native 本地确认，查 manifest/owner；不恢复源读取 |
| `attachments:chooseExternal` | envelope；返回安全 refs/模式/同会话去重提示 | `BrowserWindow.fromWebContents(event.sender)` picker，一次 capture、批次提交 |
| `attachments:proposeDrop` | envelope、preload 提取的候选路径 | 路径只是候选；主进程确认确切文件后才授予 capture；无任意 path read |
| `attachments:captureProjectRefs` | envelope、projectBindingId、`{path,startLine?,endLine?}[]` | 当前绑定/策略/Gate/身份验证；path 必须相对，不能传 root |
| `attachments:list` | envelope | 仅当前授权 namespace 的公开 refs/模式，无正文 |
| `attachments:prepareSend` | envelope、requestKind（chat/approvePlan）、draftRevision、消息快照、所选ref/范围、当前模型/助手/项目引用及expected revision；approvePlan另带既有E2批准引用/版本 | main按既有owner内Plan引用纯生成最终userMessage并绑定Plan revision；resolve正式目标、片段/预算/ticket，不取凭据/发模型请求或消耗Plan执行权 |
| `attachments:previewPage` | envelope、previewId、attachmentId、码点 offset/limit | 从该票据的有界内存文本读页，最多 16 Ki 码点；不是 blob/path API |
| `attachments:remove` | envelope、attachmentId、expected draft revision | 移除当前草稿逻辑链接、递增 generation、撤销关联预览/尚未调度发送；不删源 |
| `attachments:deleteCopy` | envelope、attachmentId | 确认后标 tombstone；无 active lease 才按内部引用计数删除副本 |
| `attachments:cancel` | envelope、目标 capture/preview requestId | 仅取消同 owner/session 操作，等待清理；不调用无归属 stop |
| `attachments:cacheStatus` / `attachments:clearCache` | envelope；清理需显式确认 | 披露 bytes/count/mode；保留保护记录，报告未清数量，不删除原件 |

所有 payload 做字段、长度、数组、正整数和版本白名单；不接受 senderId、projectPath/root、bytes/dataUrl、status/hash/size/MIME 覆盖、内部 grant/模型 binding、cachePath 或任意 renderer 模型正文 map。拖拽唯一允许的路径字段是等待主进程用户确认的 proposal，不是权限。未知 API/多余权威字段明确拒绝，不静默透传。

### 7.2 预览记录

`prepareSend` 返回：previewId、expiresAt、公开 refs、selection/预算摘要、主进程安全 modelSource、截断/脱敏提示及首屏/分页描述。完整正文只在 previewPage 的临时有界展示中返回。

私有 ticket 至少绑定：senderId、逻辑 session/namespace/window generation、clientRequestId、draftRevision、原始 userText digest及主进程解析的token inventory、接受前 history digest、selection 顺序/范围/refGeneration、最终附件+当前用户片段 projectionDigest、解码/脱敏 generation、项目 token/root/source/ancestor identity、effective 模型/助手/协议/端点/凭据引用元数据 revision、contextPolicy/预算 revision、compact policy snapshot、expiresAt。

projectionDigest 精确定义为**当前用户正文、最终附件片段与数据边界标识**的摘要；historyDigest 固定接受时历史。它不预先绑定之后模型生成的 assistant/tool/compact 文本，后者逐轮完整预算检查；不能因为后续 compact 合法变化而绕过当前用户片段的一致性，也不能隐式读回原件。

UI 明示：名称/类别/原始字节、选取时间及“选取时快照”，项目源在发送claim复验后冻结、本次不会跟随之后编辑；实际最终文本、已截断范围/未发送量、估算、目标模型/协议/安全端点来源、encrypted/memory、隐私提示。任一截断须显式确认；用户不必滚过所有页面才可确认，但所有将外发的有界文本必须可查看。无“查看全部”去读取超硬预算原件的旁路。

编辑正文/所选范围、增删/排序附件、模型/助手/项目/权限变化、去重/GC状态变化、重载/删除会话、过期/取消均撤销票据。不能 UI 改目标后偷偷沿用旧确认。

### 7.3 接受与发送顺序

现有 `chat:send` / `chat:approvePlan` 带 `attachmentPreviewId`。主进程必须独立对**本次当前用户原始文字**调用既有 `parseAtRefs`，不能依赖 renderer 声明“有正文附件”：所选 host ref 非空或当前文字含有效 `@` token 时均必须有票据。Plan批准使用主进程最终生成的本次 userMessage及Plan revision；不解析历史、附件正文、代码围栏/inline code或被既有词法忽略的邮件。

主进程生成 token inventory：按品牌项目 scope 下的规范相对路径及范围匹配，单行范围规范为 start=end、未指定范围与显式范围区分；同路径/范围重复 token 合并并保留首次顺序。票据必须覆盖每个有效 token，正文 digest仍保留所有出现位置；用户显式选取的项目 chip可另作为可见选择，但不能冒充正文遗漏的 token。缺票据、少报 token、目录 token、token/ref范围不一致或非法路径均在读源/blob/compact/凭据前拒绝，提示重新准备；不得落回旧自动 expand或静默当已读取。内部 `claimForSend` 返回品牌 `PreparedAttachmentLease`，绝不返回可由 renderer 注入的正文。

1. 现有 BUSY 先检查；验证 live sender、session/window grant、目标模型/助手/项目、abort、token inventory、票据 scope/TTL、draft/history/selection generation，失败不读源/blob。
2. reserve 票据及所需 cache lease；在有界工作槽/内存预留内 decrypt并验证 manifest/blob 版本、profile/记录关系/hash/字节预算。外部 upload 只读副本，不重开源。
3. `@` 使用当前 grant 的 bounded native reader 再验证 root/ancestors/source 与整文件 hash；**截至本次 claim源复验完成点 `sourceValidatedAt`**，任何同名重建、链接、源权限、字节变化使票据 stale。不接受“所选前缀没变所以其他部分可随意变化”。复验成功后冻结与预览一致的不可变字节/文本快照并释放源 pins；之后即使在 compact等待中编辑/替换原源文件，本次仍只发送该已验证快照，不重读新内容，也不把此事称为源继续实时一致。
4. 从品牌 lease 生成最终当前用户片段，再脱敏/计算 digest 与完整 context/预测 compact 上限；与 ticket 相同才可继续。超限不能以删附件、猜范围或静默截断修复。
5. 异步复验后再检查 BUSY/owner/current binding，原子 acquire E4 foreground lease、CAS consumed ticket，并保留 E2 Plan claim/rollback 语义。接受失败归还临时保护，不消耗尚未接受的草稿/执行权，本次不发生模型请求。import/prepare/尚未接受的 claim不占 foreground slot，只由 owner controller、全局 byte工作槽/capture并发/内存账户管理；并发纯文字chat可以先 acquire，此时本 claim最终返回 BUSY而不外发，不引入第二个admission锁或无界队列。
6. 仅此后发布 authoritative run-start（安全发送摘要可包含 `sourceValidatedAt`）；renderer 据精确 request/draft revision 消费旧草稿，不抹掉等待期间新编辑。必要旧 history compact 可在此后运行，transcript 仅安全历史/元信息；它的计划和输出上限已纳入操作快照。
7. 所有物理 model/compact 调用继续固定 E4 binding；每次 router/transport 完整 wire 与 budget guard 复验。紧邻 dispatch 检查 signal、ref/remove generation、解码/脱敏generation、live owner、当前项目grant/物理root身份/策略/助手权限；这些授权从未因源快照冻结而免检。**本次首次物理 dispatch前**取消/移除零外发；若已经 dispatch过compact/model，取消只能abort并阻止后续，不能追回既发字节。
8. 当前 run 的多轮 tool 往返复用相同确认片段，不再次读取附件原件。结束后关闭 helper/readers、Gate/transport 与附件 lease，再 release foreground；**已接受的 foreground lease**清理中仍 BUSY。未接受操作的cleanup不占全局foreground，但其工作槽/内存预留必须持有至自己的cleanup终态。

源变化截止点选用“claim复验快照”，不持源 handles等待模型/compact网络，也不在预览五分钟内长锁编辑器。负测必须覆盖复验返回后、compact等待中源同名替换：只可继续发送已确认旧快照，绝不读/发送替换内容；若同时撤销项目grant、更换物理root或移除ref则abort、阻止后续dispatch。

原始附件文本不能放进 `stripSecrets(out)` 的全局 65,536 slice 后再发送。保持既有用户/历史存储限额，独立有界模型路径使用已有 `redactSecrets` 并显式预算/失败；不通过全局放大 storage sanitizer 解决问题。

## 八、受控存储与清理

### 8.1 密文结构

计划在 application userData 的内部 `attachments-v1/` 存储 `manifest.enc.json` 及 `blobs/<internalRandomId>.enc.json`。这些是内部生成路径，不用用户 filename/path/attachmentId 任意拼接；任何删除前检查绝对目标、物理边界及预期对象身份。

外层统一 `{formatVersion:1,cipher:'electron-safeStorage',payload:<base64 ciphertext>}`；base64 只包装**密文**。原始 bytes 的 base64 只允许位于 safeStorage 加密的私有内层，不明文落盘，不返回 renderer。blob 内层绑定 profileNamespace/blobId/version/rawDigest/rawByteLength；加密 manifest 的每条 owner/namespace/逻辑 ref 指向预期 blob/hash。safeStorage 无 AAD 参数，不能把此结构误写成已有自定义 AES-GCM/AAD 实现。

每次cache包读取（包括startup/回验/GC）执行同一有界链：先校验main内部managed namespace/随机路径/对象身份，再同handle读取外层上限+1；不使用stat后readFile全读。managed package读取是独立私有scope，只能由main生成且受4 MiB包上限；不能把它当用户source grant绕过2 MiB原件限制或受保护userData拒绝规则。外层结构/版本/字段/深度/节点先有界扫描，payload须严格canonical base64，先按长度/填充位计算解码大小并验证≤3 MiB，再预留/解码/检查实际cipher bytes。解密前按已验证安全backend的输出上界预留工作空间；解密字符串的UTF-8字节先检查blob≤3 MiB、manifest≤2 MiB，再有界结构扫描/parse，不先parse坏包。blob的rawByteLength必须为0～2 MiB，与内层raw base64的严格预测长度、实际解码长度完全相等；全部解码前预留，最后比对profile/blobId/raw hash及manifest关系。错误映射、未知字段/版本、跨namespace、非canonical/截断base64、外层/cipher/plain/raw任一+1均拒绝并保留原包。

顺序为：校验容量/保护引用并预留保留及临时账户 → 有界生成内层/encode/encryptString → 内部临时**密文**写入 → 上述bounded read/decrypt链回验 → 原子 rename → manifest commit → 发布 refs。实际plain/cipher/外层字节均再次检查；预留不足不得先编码加密。中断产生的密文孤儿只在身份验证后有界回收。新 batch 失败回滚新逻辑 ref 与新孤儿，不删共享旧 blob。原件、base64、JSON、cipher、full decode临时副本按阶段释放后再转移账户；preview/批次并存的48 MiB工作峰值负测是完成门槛。

safeStorage 不可用、抛错、Linux `basic_text` 等非安全 backend、encrypt/decrypt/rename 失败均明确 memory；不得借 SecretManager 的机器派生 key fallback。损坏/未来包保留，禁覆盖原包；可允许独立 volatile namespace 的新导入，但旧 durable refs 仍不可用，用户必须看到模式/原因。丢钥不自动删除或重新读取源。

### 8.2 去重、保护与删除

- blob 用内部 rawDigest+验证版本去重，只在同 profile 内部共享；逻辑 attachmentId/session 授权分离。相同 bytes 不允许 foreign owner 看内容/获准发送。
- duplicate proposal/token 在本次选择内合并，保留首个顺序；不同来源/不同范围仍是不同逻辑选择，数量/原始字节按明确选择核算，不能利用 dedupe 绕过单次上限。
- 已同步 draft、reserved preview、accepted run 形成 host-owned 保护链接/lease；renderer 可以提交自己 namespace 的逻辑链接 revision，但不能提高权限或保护 foreign refs。历史记录可按闲置 TTL/容量过期，UI 不承诺永久附件库。
- 达到容量先清无保护过期/历史副本并发状态更新；无可清记录时拒绝新导入，不清 active lease。超过 512 条或 memory 16 MiB同样适用。
- remove 只是草稿移除并撤销未来发送；deleteCopy 是显式删除逻辑副本。共享 blob 有其他合法 ref/lease 时延期物理删除，结果明确“仍有引用/活动保护”，不宣称安全擦除磁盘或远端内容。
- clearCache 不清用户源文件、不跟随软链接/junction递归删除，不触及 vault/模型设置/其他应用文件。删除失败保留 tombstone/原因并允许显式重试。
- close/dropSender 无延迟写盘或源重开；内存副本/票据失效，耐久副本可供以后重新本地确认导航。

## 九、Renderer、历史与跨流程语义

### 9.1 草稿、UI 与事件

采用现有 per-session pending attachments/draft/outbox，不新建脱离 E4 的全局 pending 状态。异步 chooser/capture/preview 始终记录原 sender/session/request/revision；会话切换后结果不得写入当前会话，删除/关闭后迟到事件仅清理。

旧草稿 `64 KiB / 20 refs` 的保留/blocked行为不改变；E5 本次**可外发**选择只允许 8个/8 MiB。旧容器中更多或 legacy refs仍显示/可移除，不能静默截掉列表、把 20 改 8 后覆盖原容器。扩展安全元数据是加性更新，正文/base64/grant/ticket不能持久化。

仅附件发送合法；空文本但有 ready ref可准备。只有 run-start才代表接受；点击发送/打开预览不是消费草稿。预览期间编辑允许，旧票据失效；接受回调只消费同一 revision，不能清掉新文本/新附件。

### 9.2 历史及协议续接

当前确认片段只在本 accepted run 的 model messages 中存在；持久消息保存用户原始输入、公开 ref 与本次发送摘要（字符/字节/截断/来源），不保存附件正文。

下一次请求的历史默认仅引用元信息并标“原文未随本次发送”；“再次使用”需将当前 owner 可用 ref加入新的显式选择并重新预览。不会自动解析历史 `@` 或在切会话/重试时重开源。项目历史 ref再次使用仍需当前项目策略和新 capture/确认。

Responses providerState 在有效 history/绑定/选取文本变化时按已有 exact-history 规则失效；不得以 opaque continuation 带回本次未选的历史附件内容。当前 run内正常工具续接保留同一确认文本且每次 budget guard 对实际 wire生效。取消/失败不自动 replay。

### 9.3 Compact 与记忆

`serializeOlderTranscript` 只用安全用户/模型既有文字、引用名称/状态/预算和既有结论；不通过 attachmentId 查 blob，不重新展开 `@`，不把 raw/base64交给摘要或记忆候选。

`applyCompact` 的新摘要消息保留去重的公开 `attachment_ref` manifest（最多128项，连同摘要不超过既有 parts数组界限），并标正文未随摘要发送；keep中已存在 refs正常保留。manifest超限或验证失败阻断本次 compact并保留原数组；不静默截 manifest或把 summary当可恢复原件。逻辑引用/lease 更新在compact commit时原子同步，不因先算摘要就删除源副本。

已有模型结论可能含文件摘录，仍按既有会话文字处理；不承诺自动擦除其来源，也不通过“结论”名义重新带原件入记忆。直接正文共享未在E5授权。

### 9.4 默认导出与 legacy

默认 Markdown/JSON 只输出安全 ref白名单、用户原始文字和已有模型/compact结论；不含附件原件/正文、storagePath/localAbsPath、source/cache/control绝对路径、内部 hash/blobKey、票据、window/project grant或profile凭据。原件包留给E12。

这里禁止应用自动采集的附件/缓存隐私路径；用户文字或模型既有回答本身可能含其原先写入的路径/摘录，不宣称全内容匿名化，导出前应明确提示。外部上传的新自动正文不写入消息，因此默认export不携它。

旧无host记录的元信息不会凭id/name/path补读。已识别的旧图片附件/自动 Markdown dataUrl在模型、compact和默认export中仅有“旧图片未发送/由E6支持”标识，不再作为文本payload。不能可靠识别的异常旧payload保留原容器并显式阻断该次投影/导出，给移除/恢复指引，不猜测修复、空覆盖或假装看图；新普通代码中合法`data:`字符串不自动升级为附件。

### 9.5 Usage 与重试

沿用E4attemptId：只有真正物理请求终态产生usage，失败发生在dispatch前不新增physical usage。可加 `attachmentInput:{count,rawBytes,selectedBytes,selectedChars,truncatedCount}`，全部main计算，无正文/path/hash/capability。input/output/context仍保留actual/estimated/unavailable与unknown price；不对base64长度计精确账单。

失败后用户显式重试生成新clientRequestId、新prepare/confirmation；不能复用consumed票据、自动减范围/换模型/换协议或把附件去掉重发。BUSY/接受前失败保留草稿；已接受失败后的重试遵守既有outbox，不覆盖用户在等待期间的新草稿。Plan批准不是附件或外部目录外发授权；`chat:approvePlan`保持[claim/rollback与执行开始界线](<../../../src/main.js#L2673-L2727>)，不能给尚未接受的附件失败消耗执行权。

## 十、错误、取消与安全失败

公开错误为白名单code、safeMessage、session/request相关性和显式用户动作；不含源路径、解密正文、内部hash、stack或凭据。重试指重新prepare/选择，不代表自动网络重试。

| code | 触发 | UI/数据行为 |
| --- | --- | --- |
| `ATTACHMENT_TYPE_UNSUPPORTED` / `ATTACHMENT_ENCODING_INVALID` | 白名单/魔数/UTF-16/坏UTF-8/NUL等 | 说明文本范围，整批失败，源和旧refs不改 |
| `ATTACHMENT_FILE_LIMIT` / `ATTACHMENT_SELECTION_LIMIT` / `ATTACHMENT_TEXT_LIMIT` | 硬字节/数量/总量/所选文本超限 | 减少或明确缩小范围后新预览，无隐式剪裁 |
| `ATTACHMENT_CAPTURE_BUSY` / `ATTACHMENT_WORK_BUSY` / `ATTACHMENT_CAPTURE_TIMEOUT` | capture/byte工作槽并发或超时 | 不无界排队；取消helper并等清理 |
| `ATTACHMENT_READ_DENIED` / `ATTACHMENT_SOURCE_CHANGED` | claim复验截止点前的源权限/身份/链接/bytes变化，或当前project grant/root/策略失效 | 无旧readFile回退；本次首次dispatch前零外发，已dispatch则abort/无后续；冻结后不重读源 |
| `ATTACHMENT_REFERENCE_INVALID` / `ATTACHMENT_SESSION_IN_USE` | forged/foreign/无host记录/namespace已持有 | 无正文泄露、无存在性细节、不接管其他window |
| `ATTACHMENT_PREVIEW_REQUIRED` / `ATTACHMENT_PREVIEW_STALE` / `ATTACHMENT_PREVIEW_EXPIRED` / `ATTACHMENT_PREVIEW_USED` | 缺票据/token未覆盖、草稿/目标/策略/selection变化或重放 | 读源/blob前拒绝，保留草稿，重新查看并确认 |
| `ATTACHMENT_MISSING` / `ATTACHMENT_CORRUPT` / `ATTACHMENT_EXPIRED` / `ATTACHMENT_DELETED` | 缓存不可用状态，包括坏包/base64/映射/各层硬限 | 卡片可见，不从源路径自动恢复，坏原包不覆盖 |
| `ATTACHMENT_CACHE_LIMIT` / `ATTACHMENT_STORAGE_UNAVAILABLE` | disk/count/保留memory/临时工作预算、crypto/write失败 | 显示mode/原因，保护原密文包和active leases；不先分配再拒绝 |
| `ATTACHMENT_COMPACT_MANIFEST_LIMIT` | manifest超过128 refs | 原history/引用保留，不提交compact |
| 既有 `BUSY` / `MODEL_CONTEXT_LIMIT` / request limit | foreground/整请求超限 | 保持E4语义，不换目标或去附件发送 |
| cancelled / owner lost | stop/remove/reload/delete/revoke | 本次首次dispatch前零外发；已dispatch abort后阻止后续，accepted cleanup前不release |

取消capture、remove generation、项目撤权、sender关闭可发生在native读取、decrypt、preview、claim、等待Gate、acquire、compact或dispatch间。测试必须用deferred控制这些边界，不只检查最终signal。foreign cancel不影响owner。**已accepted foreground lease**在cleanup完成前禁止新前台；未接受的import/prepare/claim独立cleanup不承诺占foreground，其controller/byte工作槽/内存账户直到cleanup结束才释放。`attachments:cancel`必须可按owner/session/request取消尚未accepted的claim，不误停另一前台。并发chat先占foreground导致本claim最终BUSY的测试按本request统计零attempt，而非宣称其他请求也无外发。

## 十一、验收标准与测试矩阵

| AC | 必须具备的证据 |
| --- | --- |
| AC-01 | UTF-8/BOM/中文emoji跨块/空文件/代码/MD/坏JSON文本/CSV公式惰性接收；UTF-16/32、坏UTF-8、NUL、二进制伪装拒绝；附件正文中的`@`不触发读取 |
| AC-02 | 真实Windows同handle bounded max+1，ancestor/junction/symlink/hardlink/ADS/device/UNC/root重建/源writer等负测；源字节/目录/ACL不变，无shell；原生缺失fail closed |
| AC-03 | 外部与项目grant分离、助手projectContext限制、旧路径旁路闭合、foreign sender/session/token/伪造ready/path/bytes/hash拒绝；主进程解析当前文字，缺previewId/少报一个token/目录token/ref范围不一致在源/blob/compact/credential前拒绝；代码块/邮件仍忽略 |
| AC-04 | 每维预算边界和+1、Unicode单位、协议开销/输出预留、未知32,000门槛；blob外层/cipher/plain/raw、canonical base64、JSON结构节点和预留失败；8文件批次+preview/run并存及48 MiB临时副本峰值有界；本次首dispatch前超限零fetch/usage，草稿/旧数据不改 |
| AC-05 | UI可看最终选取文本/截断/模式/目标及claim快照截止点；最终请求片段与post-redaction preview逐字/hash一致，65536旧slice不再静默截断；过期/重放/目标/草稿变化拒绝 |
| AC-06 | 三协议stream/非stream与工具往返wire真实含确认正文、attach-only成功；接受前可识别的附件/预览/源/预算错误发生在compact/memory/credential/fetch前；后续每轮最后wire/context guard有效 |
| AC-07 | picker/capture/prepare/decrypt/claim/首dispatch前remove/stop/revoke/reload竞争本次零外发；复验返回后compact等待中源替换只用冻结旧快照，grant/root/ref变化abort；accepted cleanup持续BUSY，未accepted cleanup仅持独立工作槽；并发chat先acquire使本claim BUSY且零attempt；无fallback/retry，Plan可rollback |
| AC-08 | absent/false/unsafe/throwing safeStorage、lost key、encrypt/decrypt/rename/temp失败、未来/坏manifest/blob、owner/hash/base64/长度错配、bounded package max+1和明文超限；未知解密输出界不可准入；无明文、坏原包不覆盖、memory关闭不写 |
| AC-09 | 缺失/损坏/TTL/删除可见；内部dedupe不共享权限，active lease不淘汰，缓存bytes/count有限；clear/delete失败可见且只清应用副本 |
| AC-10 | session切换/删除/重载/迟到picker/事件/预览中编辑不串草稿；run-start精准consume；冷恢复新窗口确认，旧grant/ticket不恢复；E4坏容器blocked保留 |
| AC-11 | 当前run复用同一确认片段；下一请求历史元信息；compact只安全transcript+128项manifest、超限不丢history；记忆无附件正文；Responses不得续接未选正文 |
| AC-12 | MD/JSON默认只安全元信息/既有会话文字；无原件、自动附件正文/dataUrl、绝对内部/源路径、grant/ticket/hash/blobKey；导出不需原件可用 |
| AC-13 | E2 v2/E4 v3/旧metadata/image/unavailable及超20/超8选择保留；id/name不创建hostrecord；异常原容器不被空覆盖、原件不损 |
| AC-14 | physical attempt单次usage、失败前零physical usage；附件指标main计算无正文/path；actual/estimated/unavailable与price未知正确，未把长度当精确token |
| AC-15 | 请求fixture/真实Electron/真实Windows/三协议授权live分别登记，真实端点识别未见过的合成文件细节；前置开放项不被隐藏，未跑/skip不称通过 |

### 11.1 分层验证

- 纯契约/reader/store：注入FS/native/clock/safeStorage；合成文件和临时userData，不读取用户缓存或真实key。
- 主进程：复用 [E4 main fixture](<../../../tests/helpers/e4-main-fixture.js#L31-L168>)、[撤权竞争底座](<../../../tests/e4-main-revocation-race.test.js#L56-L89>)，记录sourceReads、credentialReads、requests和attemptId；global fetch禁用，fixture使用`.invalid`，断言真实handler而不是源码字符串。
- Renderer：复用生产函数/boot和draft/outbox测试，检查实际revision/事件顺序，不只stub附件卡片。
- Windows/Electron：扩展 [既有native负测](<../../../tests/e3-windows-native.test.js#L108-L120>)但明确其旧证据只证明命令隔离；E5 capture必须另证。同样核对实际native构建完整性与实际preload/IPC/UI，无源ACL副作用。
- 真实端点：后续单独授权明确模型、协议、目标、费用上限、临时凭据和合成文本样本；三协议逐一登记，不能用网关任意兼容声明或fixture回答代替。未授权时不请求、正式验收保持开放。

### 11.2 文档/实施完成口径

文档完成：两份文档及索引一致，FR/Task/AC追踪完整、预算和错误契约统一、路径链接有效，未越界到E6/E7/E12，未声称实现或跑过测试。

功能完成：Plan各任务RED→GREEN及相关回归实际登记、source/旧数据不损、negative证据成立。正式验收：再具备真实Electron/Windows capture和三协议授权端点矩阵，并显式处理前置开放项；任何一层缺失仅报告其真实状态。
