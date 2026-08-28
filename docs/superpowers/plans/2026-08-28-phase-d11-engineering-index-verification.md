# Phase D.11 - 工程验证与代码索引实施计划

**设计规格:** `docs/superpowers/specs/2026-08-28-phase-d11-engineering-index-verification-design.md`
**实施状态:** 待实施
**目标:** 在不新增 runtime dependency 的前提下，交付按项目共享的轻量代码索引、后台验证作业、规范化诊断和工程中心 UI。

## 1. 实施前置与基线

- [ ] 完成 D8 真实 HTTPS OAuth MCP 授权、refresh/revoke、allowPrivate 和 SSRF Electron 验收。
- [ ] 完成 D9 prompts、roots、sampling approval、session recovery 外部 MCP UI 冒烟。
- [ ] 完成 D10 Tasks/Elicitation、后台轮询、取消/遗弃、重启恢复和结果认领桌面验收。
- [x] 保留工作区既有 `.idea/` 和临时测试日志，不纳入 D11 提交。
- [ ] 运行 `npm test` 基线并记录结果；实施期间保持全量测试 0 failed。
- [ ] 冻结 profile、index、job 的错误码、资源上限和持久化 envelope 后再实现。

## 2. Task 1 - 共享项目绑定与设置合同

涉及：`src/ai/settings.js`、`src/main.js`、`src/preload.js`、必要时 `src/ai/mcp-config.js`。

- [ ] 增加 `codeIndexEnabled` 默认开关和规范化逻辑。
- [ ] 增加按项目保存的 `verificationProfiles`，限制 12 条、名称/命令/cwd/timeout 和 `enabled` 枚举。
- [ ] 实现自动探测候选接口，只读 package/config 文件且不执行命令。
- [ ] 通过 main 保存 profile，renderer 只能提交 profile 的受限字段；不接受绝对 cwd。
- [ ] 让 `settings:get` 返回 profile 脱敏摘要和索引开关，不返回授权正文、日志或绝对路径。
- [ ] 为 profile 修改、删除和禁用建立 fingerprint 失效规则；已有 job 只读保留，运行中 job 不被静默重绑。
- [ ] 增加设置单测，覆盖手工 JSON、非法字段、profile 上限和旧配置兼容。

## 3. Task 2 - 增量代码索引

新增：`src/ai/project-index.js`、`tests/project-index.test.js`；复用 `src/ai/search.js` 和 `src/ai/gitignore.js` 的遍历/忽略语义。

- [ ] 实现 canonical 项目 key、文件 fingerprint、大小/总量限制和二进制跳过。
- [ ] 实现 JS/TS、Python、Go、Rust、Java 的有限词法声明提取。
- [ ] 实现通用文本词项/位置索引和 definitions/references/text 查询。
- [ ] 明确每条结果 `confidence: 'lexical'`，固定排序并加入 `truncated`/计数。
- [ ] 实现 `idle/building/ready/stale/error` 状态和同项目构建 Promise 合并。
- [ ] 实现启动增量、mtime/size/hash 检查、删除/重命名和 `.gitignore` 变化的完整重建。
- [ ] 实现 500ms 防抖 watcher；项目解绑、clear 和应用退出释放 watcher。
- [ ] 实现 safeStorage 加密 index envelope、临时文件原子替换、损坏保留和 memory-only 降级。
- [ ] 实现 bounded `location` 行窗口，读取时重新校验项目内路径。
- [ ] 完成索引边界、增量、缓存和隐私测试。

## 4. Task 3 - 验证作业管理器与诊断解析

新增：`src/ai/verification-manager.js`、`src/ai/verification-diagnostics.js`、`tests/verification-manager.test.js`、`tests/verification-diagnostics.test.js`。

- [ ] 实现 profile fingerprint、project workspace fingerprint 和 jobRef 生成。
- [ ] 实现 queued/running/terminal 状态机、每项目/全局并发上限和历史清理。
- [ ] 接入现有 `runTerminal`，保证项目内 cwd、timeout、abort、危险命令拦截和 stdout/stderr 回调复用。
- [ ] 将首次/变更授权接入 PermissionGate 的 terminal risk，并按 project+profile fingerprint 持久化 grant。
- [ ] 实现取消、超时、应用退出 interrupted、手动 rerun 和授权 revoke。
- [ ] 在作业开始/结束计算 workspace fingerprint；变化时强制 `stale`。
- [ ] 实现 stdout/stderr 64 KiB、diagnostics 200 条、单条消息 1000 字符和敏感信息脱敏。
- [ ] 解析 TypeScript/JavaScript、ESLint、Jest/Vitest、pytest、Go、Rust、javac/Maven/Gradle 常见诊断格式。
- [ ] 实现 safeStorage jobs/grants envelope；safeStorage 不可用时只保留当前进程，损坏不覆盖原文件。
- [ ] 测试状态迁移、并发、取消、超时、stale、恢复、日志截断和明文泄漏。

## 5. Task 4 - Agent/provider 接入

涉及：`src/ai/agent.js`、`src/ai/agent-mode.js`、`src/ai/permission.js`、`src/ai/providers/builtin.js`、必要时新建 `src/ai/providers/engineering.js`。

- [ ] 增加 `code_index_status`、`code_index_search`、`verification_profiles`、`verification_start`、`verification_get`、`verification_result` 定义。
- [ ] 将索引查询标为 read risk；将 `verification_start` 标为 terminal risk。
- [ ] 过滤 plan、explore 和 implement 子 Agent 的验证启动工具；保留安全的索引查询范围。
- [ ] 确保 `verification_start` 只接受 profileId，不接受命令、cwd、环境变量或项目路径。
- [ ] Agent 只收到 bounded、脱敏结果；jobRef 不泄露远端或内部存储 ID。
- [ ] 增加 Agent/provider/permission 测试，验证 full-auto 也需要首次/变更授权。
- [ ] 将后台 job 事件与普通 chat event 分离，避免写入 session history 和 usage。

## 6. Task 5 - Main/preload IPC 与生命周期

涉及：`src/main.js`、`src/preload.js`、必要时 `src/ai/engineering-ipc.js`。

- [ ] 初始化 main-owned index manager、verification manager；按 canonical 项目目录复用实例。
- [ ] 增加 `engineering:index:*`、`engineering:verification:*` IPC handlers 和统一 bounded redaction。
- [ ] 所有请求使用 sender-owned `projectBindingId`；失效、跨项目、伪造 job/profile 返回稳定错误。
- [ ] 广播 `engineering:event` 到存活窗口，窗口销毁时移除 listener，不停止其它项目后台作业。
- [ ] 应用启动恢复加密 index/jobs/grants；jobs 只转 interrupted，不自动执行。
- [ ] 应用退出释放 watcher/child process/定时器并完成安全存储 flush。
- [ ] 增加 main/preload sender ownership、重启和事件脱敏测试。

## 7. Task 6 - 工程中心 Renderer UI

涉及：`src/renderer/index.html`、`src/renderer/app.js`、`src/renderer/styles.css`。

- [ ] 将“已安排”页扩展为工程中心，保留 D10 MCP Tasks 区块。
- [ ] 增加索引状态卡、重建/清除操作、搜索 tabs、结果列表和近似定位提示。
- [ ] 增加 profile 管理：自动探测候选、保存/编辑/启用/禁用、命令和 cwd 展示。
- [ ] 增加验证 job 列表、运行/取消/重跑、退出码、stale/interrupted/截断状态和诊断入口。
- [ ] 增加诊断点击定位、复制脱敏摘要和 terminal 未启用/授权撤销提示。
- [ ] 监听工程事件；切换聊天、切换视图或停止 Agent 时保持后台状态更新。
- [ ] 所有 job/index/command/log/diagnostic 正文只留内存，不进入 `saveState`、session message、export 或 localStorage。
- [ ] 保持 QQ 2007 样式、窄窗口布局、键盘可操作性和现有 MCP/worktree/PR UI 不回归。
- [ ] 增加 renderer source-contract/UI tests 和必要的 DOM 冒烟。

## 8. Task 7 - 测试、隐私和桌面验收

- [ ] 为所有新增 JS 文件运行 `node --check`。
- [ ] 运行 `npm test`，要求 0 failed；记录因宿主环境缺少 Electron/外部工具产生的明确 skip。
- [ ] 运行 `git diff --check`，确认无新增依赖和无明文工程数据文件。
- [ ] 完成索引中型项目验收：首次构建、增量变更、删除/重命名、定义/引用/文本搜索和点击定位。
- [ ] 完成验证 profile 验收：首次审批、自动重跑、失败诊断、取消、超时、stale、重跑和 revoke。
- [ ] 完成重启验收：索引缓存恢复；未结束验证显示 interrupted，命令不自动执行。
- [ ] 完成隐私扫描：源码正文、命令、日志、诊断、授权、绝对路径不进入 renderer storage/export/history/usage/memory/hooks/log。
- [ ] 重跑 D8 OAuth/SSRF、D9 session/roots/sampling、D10 Tasks/Elicitation、D7 PR、D5 worktree 和旧 verifyCommand 回归。
- [ ] 只有自动化、隐私、真实 Electron 和 D8-D10 硬前置全部通过后，将规格/计划状态更新为“已交付”。

## 9. 交付顺序与回滚

实施顺序固定为：设置/profile 合同 -> 纯索引与诊断函数 -> verification manager -> main/preload 生命周期 -> Agent/provider -> renderer 工程中心 -> 全量回归与桌面验收。

每一步保持旧行为可用：索引或 D11 开关失败时，`grep/glob` 继续工作；验证 manager 不可用时，旧 Agent `verifyCommand` 软验证和手动 terminal 继续工作；safeStorage 不可用时只禁用跨重启恢复，不创建明文文件。D11 失败回滚只移除新增 IPC/provider/UI 接线和三份加密 envelope，不触碰 MCP Tasks、session history、worktree marker 或现有 settings 字段。

## 10. Definition of Done

- [ ] D8、D9、D10 真实桌面前置通过。
- [ ] 索引语言、增量刷新、查询、缓存和 sender ownership 测试全绿。
- [ ] 验证 profile、权限、后台作业、诊断、stale、取消、重启和 rerun 测试全绿。
- [ ] Agent 只能使用保存 profile；结果和事件 bounded、脱敏且不写入聊天历史。
- [ ] 工程中心支持索引和验证完整操作，切页后后台状态仍更新。
- [ ] `npm test`、`node --check`、`git diff --check` 全部通过，无新增 runtime dependency。
- [ ] 真实 Electron 中完成中型项目索引、后台验证、诊断定位和重启流程。
