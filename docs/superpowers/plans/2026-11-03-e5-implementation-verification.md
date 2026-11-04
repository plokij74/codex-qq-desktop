# Phase E5：实现与验证记录

**状态：业务实现与离线/Windows/native/实际 Electron 验证已完成。正式真实端点与 OS 用户手势验收未执行。**

日期：2026-11-03。实现基线为 `91f3bd028e5b8ae1f87ca75298501bae42c70486`，变更保留在工作区，未提交 Git。环境：Windows、Node `22.22.0`、npm `11.16.0`、实际 Electron `33.2.1`。

依据：[E5 Spec](<../specs/2026-11-03-phase-e5-text-attachments-controlled-storage-design.md>)、[E5 Plan](<2026-11-03-phase-e5-text-attachments-controlled-storage.md>)、[Phase E 总规划](<2026-10-15-phase-e-product-readiness.md#L133-L146>)。设计文档、测试夹具、真实原生 helper、实际 Electron 与真实模型端点证据互不替代。

## 1. 已实现的范围

| 计划任务 | 实现及契约 |
| --- | --- |
| E5-01 公共契约与预算 | [attachment-contract](<../../../src/ai/attachment-contract.js>)：RefV1 正白名单、不可授能 ID、安全公共错误、UTF-8/Base64/JSON 先验边界、主进程品牌工作槽与保留内存预算。 |
| E5-02 授权读取 | [attachment-reader](<../../../src/ai/attachment-reader.js>)、[Windows launcher](<../../../src/native/windows-isolation/Launcher.cs>)：external 一次性 capture、项目 root/ancestor/file 身份与同 handle 有界读取/hash、托管包的原子写入/回验/删除；无普通文件系统降级。 |
| E5-03 受控存储 | [attachment-store](<../../../src/ai/attachment-store.js>)：真实 safeStorage-only 密文包，未知 backend 明确 memory；namespace、去重、草稿/消息链接、lease、TTL、坏包保留、仅清应用副本。 |
| E5-04 预览及 IPC | [attachment-preview](<../../../src/ai/attachment-preview.js>)、[attachment-ipc](<../../../src/ai/attachment-ipc.js>)：main 当前文本解析 `@`，独立来源授权、分页惰性正文、目标/预算/截断确认、5 分钟单次票据、claim/consume/release 与取消。 |
| E5-05 真实 UI | [preload](<../../../src/preload.js>)、[renderer](<../../../src/renderer/app.js>)、[E5 UI helper](<../../../src/renderer/e5-attachments.js>)：native 文本选择、drop 提案、仅附件发送、Plan 预览、历史状态、缓存管理、会话/目标/草稿竞争失效；正文和票据只在内存。 |
| E5-06 发送与守卫 | [main](<../../../src/main.js>)、[projection](<../../../src/ai/attachment-projection.js>)、[operation budget](<../../../src/ai/model-operation-budget.js>)、[router](<../../../src/ai/model-router.js>)：claim 在前台 acquire、Plan 消费及 compact 前；当前确认正文不走存储截断；每次实际 wire 在凭据及物理 dispatch 前校验。 |
| E5-07 兼容与用量 | [message schema](<../../../src/ai/message-schema.js>)、[compact](<../../../src/ai/session-compact.js>)、[export](<../../../src/ai/session-export.js>)、[chat state](<../../../src/renderer/e4-chat-state.js>)、[model usage](<../../../src/ai/model-usage.js>)、[usage store](<../../../src/ai/usage-store.js>)：消息 v2/会话 v3 不迁型，历史/compact/导出 metadata-only，legacy 保原容器且不授能，用量只存公开计数。 |
| E5-08 分层验证 | [actual Electron smoke](<../../../scripts/e5-electron-attachments-smoke.cjs>) 与本记录；离线、Windows/native、Electron、live 独立标注。 |

### 关键边界

- 仅 UTF-8/BOM 文本、代码、Markdown、JSON、CSV 等惰性文本；不执行附件中的 `@`、HTML、脚本或链接。图片、Office/PDF/OCR、压缩包及原件导入导出属于 E6/E7/E12，不在本次范围。
- 单文件原件 `2 MiB`，最多 `8` 个、原件合计 `8 MiB`；单文件选择 `64 Ki` Unicode code points、整次 `256 Ki`；最终 wire `4 MiB`。缓存 `64 MiB/512` 条、idle TTL `30` 天。
- 保留文本/字节预算 `16 MiB`，临时工作预算 `48 MiB`，全应用只有一个非排队工作槽。预留后分配、实际 cleanup 后归还；这是受控预留账本，不是 RSS 保证。
- 已注册秘密先用 [中立有界脱敏](<../../../src/ai/attachment-redaction.js>) 再预览；实际发送相同结果。合法 `2 MiB` 原件可生成最多 `5 MiB` 脱敏候选，再选择最多 `64 Ki` code points；不放宽原件或最终发送预算。
- `sourceValidatedAt` 是 claim 的源复验截止点。此前源变化使票据 stale；之后发送冻结快照、不重开源。每次 dispatch 仍复核 owner、grant、物理 root、策略、记录及脱敏代数；已 physical dispatch 的字节不能追回，只能 abort 后续。
- 保留原 Agent 工具/Gate/模型策略，不因附件存在静默关闭 native tool loop。附件 Agent 关闭自动项目指令/目录树、物理 root 注入及自动项目 hooks/fragments；显式已授权工具仍按 E4 执行。预览预算是基础文本估算，动态工具 schema/系统片段另受每次真实 wire/context 最终守卫，不声称精确 tokenizer 结果。
- 成功 compact 后同步当前 namespace 的 metadata message links；当前已确认附件保留，历史 ID 不能获得字节权限，不重新读取历史正文。

## 2. 已执行验证

下列测试有重叠，不能将计数相加为不同测试的总数。

| 层次 | 实际结果 | 说明 |
| --- | --- | --- |
| E5 全套最近完整轮次 | `200/200`，0 fail/skip/cancel，`65969.8403 ms` | 含 19 项真实 Windows/native、30.28 秒 capture timeout 等待 helper close、46 store、三协议 wire、IPC、预览、renderer/preload、schema/compact/export 等。 |
| 最终 Agent/usage 直接依赖回归 | `85/85`，0 fail/skip/cancel，`1647.0141 ms` | 包含新增的附件 native Agent 用例、用量摘要落盘、原 E4 Agent 绑定/撤权/Plan/用量测试。最终 E5 用例数量为 201；不把前述 200 轮次伪写成 201 全量轮次。 |
| Main 绑定/前台/Plan 等直接依赖 | `103/103`，0 fail/skip/cancel | 默认 unit metadata fixture 只覆盖其自建临时项目，保留实际 reader/capture 与生产绑定授权；修复 fixture 身份及真正的 host Plan WeakMap 快照问题。 |
| Router/adapters 等定向回归 | `146/146` | 三协议、实际 opaque Responses wire、单次物理 attempt/usage、取消等待 cleanup；没有新增 client 或自动 retry。 |
| schema/compact/export/会话/usage 定向回归 | `129/129` | 消息/会话旧版兼容、128/129 manifest 边界、legacy-body 原容器保护、cold memory 不假 READY。 |
| Windows reader/native 初次定向轮次 | `37/37`：18 unit + 19 native，0 skip | 实际 helper；另 E3 native `10/10`。原生源与二进制哈希验证通过；未以 unit mock 代替 OS 证据。 |
| 实际 Electron | 已有一轮通过；最终源代码复核见第 3 节 | 实际 main/preload/renderer/native/safeStorage；模型 fetch 仅离线合成夹具。 |

关键负测包括：原件/包/manifest/编码/JSON/内存/磁盘精确边界，跨 owner、失钥/坏包不覆盖、preview stale/BUSY 不花 Plan 或草稿、取消与窗口失效、缩小自动 `@` 选段重新确认、历史无正文读取、Responses opaque 最终请求超限在 credential/fetch 前拒绝。

## 3. 实际 Electron 与 Windows 加密证据

已通过检查点：[public result](<C:/Users/Administrator/AppData/Local/Temp/codex-e5-electron-wZhGkk/result.json>)、[真实安全预览截图](<C:/Users/Administrator/AppData/Local/Temp/codex-e5-electron-wZhGkk/chat-preview.png>)。

- 实际 Electron `33.2.1` 加载现有应用源码，未启动替代服务器。
- `openai-chat-completions`、`openai-responses`、`anthropic-messages` 分别 1 次物理离线 fetch，实际 JSON wire 为 `557/562/588` bytes；确认文本与 wire 一致，HTML 惰性，历史仅 typed metadata，发送后前台 cleanup。
- external capture 后替换原件，仍仅发送已确认旧副本，不重开原件。
- 真正的 safeStorage 可用，模式 `encrypted`；原件 `2097152` bytes，加密包总磁盘 `3730568` bytes，近上限真实加密/解密读回通过。结束后 `retainedBytes=0/workBytes=0/activeWork=0`。
- 临时 userData/sessionData、合成源文件及合成凭据与真实用户数据隔离；只有 `.invalid` 离线模型夹具，Chromium HTTP 被拒绝。没有真实凭据或模型端点访问。
- `liveEndpointEvidence=false`。native dialog 决策由 harness 安排合成选择，不是实际 OS 用户点击/拖放手势证明。

最终源代码复核：同一 actual Electron smoke 在最终 Agent/usage 修正后再次通过（进程 exit `0`，结果 `status=passed`）。第 3 节链接是本轮最终结果；三协议 wire、真实加密近界读回与清理计数均再次一致。native Agent 的授权工具保留由第 2 节真实 Node Agent loop/合成工具夹具验证，不冒称实际 Electron OS 工具手势或 live 端点证据。

## 4. 未验事项与交付纪律

1. 三协议真实模型端点、账单、提供商凭据及真实 native 用户手势没有授权/执行，不能据本记录宣称 E5 正式 live 验收闭合。无需为了已授权实现再次请求开发授权。
2. 本次验证是 E5 及直接依赖的最小充分验证，不宣称全仓测试/所有 E2/E3/E4 前置开放项闭合；既有 unrelated/flaky 项不因本次结果自动关闭。
3. 未安装新依赖、升级工具链、创建工作树或提交 Git。临时测试文件只在明确自建目录；不清理真实用户原件、用户已有 `.dsh-work` 或旧数据容器。
4. 前述结果文件位于临时目录，可能被 OS 清理；本记录保存已核验结论，不把路径存在当作任何未运行项通过。
