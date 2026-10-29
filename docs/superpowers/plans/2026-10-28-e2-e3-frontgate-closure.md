# E2/E3 前置缺口闭环与后续阶段归属（2026-10-28）

## 结论与范围

按“后续已有闭环规划的留到对应阶段，没有后续承接的现在补齐”处理：

- **留后续**：完整检查点、导出/恢复、暂停/继续与通用自动修复恢复，已有 E10/E12/E13/E23 明确承接，本次不提前实现这些阶段。
- **现在补齐**：同一次 Plan 批准开始执行后失败不能重新获得旧授权；Windows 生产终端必须有真实文件/网络/子孙进程隔离。这两项是 E2/E3 自身的前置要求，不被后面的恢复阶段替代。
- **不声称全量完成**：Windows 原生生产后端及其相关专项已通过；完整全量回归稳定性仍开放，E3 阶段不因此被整体标成正式验收完成。没有修改无关 D20 业务代码，也未清理或重置工作树既有改动。
- [10 月 27 日验收记录](<2026-10-27-e2-e3-reacceptance.md>)保留为历史，不用新结果覆盖当时的“宿主未隔离”事实。

## 后续归属核对

| 事项 | 已有规划与证据 | 本次处理 |
| --- | --- | --- |
| 通用任务暂停/继续、检查点、安全恢复 | [E10](<2026-10-15-phase-e-product-readiness.md#L191-L203>)明确不盲目重放已发生的副作用 | 留 E10 |
| 会话/附件导出导入与恢复，恢复前核对副作用 | [E12](<2026-10-15-phase-e-product-readiness.md#L215-L225>) | 留 E12 |
| 隔离 worktree、恢复任务及失败现场 | [E13](<2026-10-15-phase-e-product-readiness.md#L227-L237>) | 留 E13 |
| 组合执行、预算、修复工作流与中断恢复 | [E23](<2026-10-15-phase-e-product-readiness.md#L351-L362>) | 留 E23 |
| 同一 Plan 已执行后失败的即时授权防重放 | [E2](<2026-10-15-phase-e-product-readiness.md#L98-L103>)自身要求；不是完整恢复功能 | 已补齐 |
| OS 文件/网络/子孙隔离、最小秘密暴露 | [E3](<2026-10-15-phase-e-product-readiness.md#L110-L116>)及 [G15 归属](<2026-10-15-phase-e-product-readiness.md#L433>)，没有后续阶段接替其生产前置 | Windows 已补齐生产后端和专项 |
| 全量稳定性与正式发布 | [G43](<2026-10-15-phase-e-product-readiness.md#L461>)由 E1 跟踪、各阶段回归、E27 最终关闭 | 保留失败，不冒充全量绿 |

## E2：启动边界与不可重放授权

实现位于 [PlanStateManager](<../../../src/ai/plan-state.js>)、[主进程批准入口](<../../../src/main.js#L2245-L2285>)，相关测试为 [实际 main IPC 集成测试](<../../../tests/e2-e3-main-integration.test.js>)和 [边界回归](<../../../tests/e2-behavior.test.js>)。

- 在任务被接受、开始执行的边界调用 `markStarted(planId, claimId)`；不等待 `tool-end` 才耗用授权。
- 仅尚未开始执行的准备失败可回滚到可重试状态。
- 开始执行后报错：原 Plan 过期，返回 `isRetryable: false`，提示检查现场并生成新计划；旧批准不复用，不自动重放。
- 实际 main IPC + 临时项目文件反测：第一次已 append 后抛错；再次批准旧 Plan 被拒，Agent 仅运行一次，副作用文件仅一行。
- 本次没有实现自动恢复检查点；新 Plan 必须由用户重新核对并授权。

## E3：Windows 原生生产隔离

### 生产链路

[原生 C# 启动器](<../../../src/native/windows-isolation/Launcher.cs>) → [构建与哈希核验](<../../../src/ai/native-isolation-build.js>) → [Node 原生桥及一次性能力](<../../../src/ai/windows-isolation.js>) → [终端入口](<../../../src/ai/terminal.js>)与[主进程 Gate](<../../../src/main.js#L133-L165>)。

- 验证平台：Windows 10 x64，build 19045，Node 22.22.0；后端最低支持 build 19041。其他系统或原生组件不可用时拒绝严格执行，不伪称已隔离。
- 挂起创建 LPAC，使用 `ALL_APPLICATION_PACKAGES_POLICY` 限制，并在恢复线程前做真实 token/AccessCheck 检验、加入 Job Object；不是仅设置 cwd、命令黑名单或 Job 标签。
- 只保留固定运行时 capability `registryRead` / `lpacCom` / `lpacInstrumentation`，无网络 capability；必要的系统运行时不等于任意宿主目录授权。
- 文件边界由 LPAC 与 Windows ACL 实施；允许获准工作区、私有临时数据和必要系统运行时，但不提供全磁盘命名空间虚拟化，也不声称隐藏 Windows 明确公开给受限应用的共享资源。私有外部/别项目/vault 拒绝以实际反测为证。
- 默认 `strict-isolated` 授工作区只读，只有明确 `workspace-write` 授工作区写入；外部参数不能升级已经签发的一次性能力。
- 一次性能力绑定物理 root/cwd、对象身份、命令、会话、策略和有效期；直接布尔 `confirmed`、设置标签、旧 `allow_session` 和伪造对象不能替代它。
- 预扫描拒绝 junction/reparse、hardlink、ADS；root/cwd 固定对象身份并持有禁止删除共享的句柄，防止授权后的根对象替换。
- 出站网络策略为 **deny-all**，实际拒绝 TCP、UDP、私网/loopback 和 DNS；本后端不提供“只允许某些域名”的网络放行。命名管道另由 LPAC 访问控制，已反测外部测试管道拒绝，不把必要系统 IPC 说成整个管道命名空间不存在。
- 原生子进程不继承宿主完整环境，不注入普通 API/MCP 密钥；输出每流 20KB 有界缓冲，完成后净化，超限整流省略，不提供实时流式终端输出。
- Job 限制：最多 16 个活动进程，单进程 512MiB、整 Job 1GiB；最长 120 秒，工作区最多 65,536 个对象。超限显式失败。
- 父进程提前退出、超时、取消及 helper 崩溃均回收 Job 子孙；journal/lease 恢复撤销临时 ACL 和删除 profile。异常不会自动重跑命令，也不会静默转宿主。
- 明确选择宿主模式时仍需主进程原生单次确认，返回 `isolated: false`；UI 分清“后端可用”“未隔离”“待核验/未知”，不把可用性当作当前命令已执行的证明。

### 构建与分发约束

[构建脚本](<../../../scripts/build-windows-isolation.cjs>)使用已有 .NET Framework x64 C# 编译器，不新增依赖。源码/生成程序 SHA-256 必须与 manifest 匹配。[启动与打包配置](<../../../package.json>)的 `prestart`、`prestart:win`、`pretest`、`predist` 先构建核验；原生程序通过 `asarUnpack` 分发。生成的程序和 manifest 不替代源码、也不依赖旧的独立可行性探针。

### 真实专项证据

- [原生边界反测](<../../../tests/e3-windows-native.test.js>)：项目读写；默认只读拒绝写/创建/删除；外部、别项目、模拟 userData/vault（含宽 AAP ACL）拒绝；TCP/UDP/命名管道拒绝；路径别名和伪造能力拒绝；宿主秘密不继承、分段输出净化、有界输出、timeout 清理。
- [DNS 反测](<../../../tests/e3-native-dns.test.js>)：同一受控 UDP 接收器前后宿主各实际收到一个 DNS 请求，LPAC 中间收到 0 包。另以默认 Windows resolver 和 .NET DNS API 的宿主阳性对照独立复测：宿主得到 `127.0.0.1`；LPAC `DnsQueryEx=9852`、.NET 错误 `11003`，无地址。错误码或超时**单独不算拒绝证据**。公共合成域名探针须显式 `E3_RUN_SYSTEM_DNS_PROBE=1`；普通离线回归不暗中依赖外部 DNS。
- [生命周期/资源反测](<../../../tests/e3-windows-native-lifecycle.test.js>)：父早退、abort、helper crash/profile 回收、breakaway 拒绝、活动进程配额、内存配额；真实子孙也不能读取/写入临时外部宽 AAP ACL 目录。宿主 600MiB 分配阳性，LPAC 单进程 512MiB 配额拒绝。
- [主进程 IPC](<../../../tests/e2-e3-main-integration.test.js>)在主进程原生确认替身允许后，实际执行原生终端并断言 `executionMode: strict-isolated`、`isolated: true`、backend、清理完成和 profile 删除；没有以 renderer 弹窗签发能力。
- [实际徽章函数与初始 HTML](<../../../tests/e3-isolation-badge.test.js>)覆盖默认待核验、后端可用、明确宿主模式、后端不可用、空回应及查询失败清除旧绿色状态。

## 回归记录

| 回归 | 结果 | 说明 |
| --- | --- | --- |
| 前一轮相关组合 | 480/480，0 失败/取消/跳过，125.51 秒 | 含系统 DNS opt-in 与真实原生生命期反测 |
| 最后组合相关回归 | **486/486，0 失败/取消/跳过，119.50 秒** | 含新增徽章函数测试及强化 main IPC 隔离模式断言；之后仅补初始 HTML 待核验与状态 IPC 宿主配置字段，另行复验 |
| 最后初始 HTML/renderer/main IPC 复验 | **121/121，0 失败/取消/跳过，7.35 秒** | 已覆盖初始待核验、查询失败清旧绿与宿主配置 IPC 字段；不与前 486 项相加计算唯一测试数 |
| 真实 Electron UI/刷新验收 | **通过：后端可用 → 明确宿主未隔离 → 刷新仍未隔离** | [验收脚本](<../../../scripts/e3-electron-native-smoke.cjs>)使用真实 main/preload/renderer 与独立临时 userData，无模型或终端命令；实际 IPC 宿主模式为 `host-unconfined`、必须单次确认；[结果与截图路径](<C:/Users/Administrator/AppData/Local/Temp/codex-e3-electron-status-2ceeebec578647cf86d80ecd1283349d/result.json>) |
| 本次首次全量 `npm test` | 1157/1160 通过，3 失败 | 0 跳过/取消；不能声称全量绿 |
| 3 个首次失败文件低并发复测 | 57/58，1 失败 | 原 3 个具体 case 通过，但同 D20 文件另一个 worktree 创建 case 出现 `EPERM`；稳定性仍开放 |

相关组合可复现命令：

```powershell
npm run build:native
$env:E3_RUN_SYSTEM_DNS_PROBE='1'
node --test --test-concurrency=1 --test-timeout=120000 tests/e1-*.test.js tests/e2-*.test.js tests/e3-*.test.js tests/renderer-*.test.js tests/agent.test.js tests/agent-call-id.test.js tests/agent-abort.test.js tests/permission.test.js tests/terminal-callbacks.test.js tests/verification-manager.test.js tests/mcp-*.test.js tests/settings.test.js tests/main-mcp-d10-ipc.test.js tests/session-compact.test.js tests/session-export.test.js
```

本轮 486 项完整输出：[相关回归日志](<C:/Users/Administrator/AppData/Local/Temp/dsh-spill-1BIs2V/session-fad085958f23/e5db9a984d33-job_output.txt>)。首次全量失败原文：[全量 TAP](<C:/Users/Administrator/AppData/Local/Temp/dsh-subprocess-w7ewSu/dsh-subprocess-23748-1-8e6b01bcc2df-stdout.log>)。

## 仍开放的事项

1. 既有全量回归不稳定：首次全量的 Agent `git init`、D13 基线 commit、D20 PR 审查夹具失败；低并发复测后二者通过，D20 另一个用例仍 `EPERM`。本次不修改无关 D20，也不在未证明前把原因定为并发。
2. E10/E12/E13/E23 已明确承接的完整检查点/导出恢复/通用工作流恢复，留到各自阶段。
3. 只有 Windows 实机边界得到本次原生验收证据，不把未测试平台、任意工具链或整个 E4–E27 标成完成。受限后端未授权的宿主工具、网络和过大/别名工作区会拒绝；需要宿主模式必须另行明确确认。
4. 本次真实 Electron UI smoke 不执行外部模型请求或自动点击真正的风险确认弹窗；原生命令和资源边界由实际进程测试证明，主进程确认路径由实际 IPC + 对话框替身验证。正式发布端到端与重复全量结果留给后续验收，不以 UI 截图替代边界证明。
