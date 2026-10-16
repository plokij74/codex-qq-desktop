# Phase E3 实施计划与任务跟踪：权限、OS 隔离与秘密管理

日期：2026-10-16。对应 [设计规格](../specs/2026-10-16-phase-e3-permissions-os-isolation-secrets-design.md) 与 [总规划](2026-10-15-phase-e-product-readiness.md)。

---

## 一、实施清单与状态跟踪

- [x] 1. 创建 OS 级隔离核心模块（`src/ai/os-isolation.js`）
  - [x] 实现 `verifyPathSandbox(projectRoot, targetPath, options)`，基于 `fs.realpathSync.native` 进行物理路径解引用与前缀校验，拦截 `..` 相对逃逸、绝对盘符逃逸与 Windows 软链接/Junction 越界。
  - [x] 规范化路径拒绝检查（拦截 Windows 备用数据流 `ADS` 与保留设备名 `CON`, `PRN`, `AUX`, `NUL` 等）。
  - [x] 实现极简环境白名单构造器 `buildSanitizedEnv(customEnv, options)`，仅注入必需的系统运行变量（`SystemRoot`, `PATH` 等），自动剥离敏感变量。
  - [x] 实现 Windows 子进程树彻底回收器 `terminateProcessTree(pid, options)`，利用 `taskkill /T /F /PID` 强杀整棵进程树，容错处理 ESRCH 边缘情况。
  - [x] 实现出站网络策略校验器 `checkOutboundPolicy(target, options)`，防范私网 IP、保留网段及云厂商元数据（`169.254.169.254`）。
  - [x] 实现真实隔离能力探测器 `probeIsolationCapabilities()`，检测平台硬件加密与沙箱运行特性。
- [x] 2. 创建主进程安全秘密管理模块（`src/ai/secret-manager.js`）
  - [x] 实现双模存储加密引擎（Electron `safeStorage` DPAPI 优先，Headless/测试环境回退为带机器盐的 `AES-256-GCM`）。
  - [x] 实现 `SecretManager` 核心类，管理 `apiKey`、MCP Token 及通用凭据加密读写。
  - [x] 实现 `settings.json` 明文凭据自动迁移逻辑，启动时提取明文并持久化为引用标记 `{ apiKeyConfigured: true, secretRef }`。
  - [x] 实现内存注册与全局动态凭据脱敏器 `redactSecrets(text)`，支持精确字串匹配与正则启发式脱敏。
  - [x] 实现最小凭据定向注入工具，严禁向普通子进程无差别广播密钥。
- [x] 3. 创建执行策略与能力模型（`src/ai/execution-policy.js`）
  - [x] 定义 `ExecutionPolicyLevel` 标准枚举（`STRICT_ISOLATED`, `WORKSPACE_WRITE`, `HOST_UNCONFINED`）。
  - [x] 实现工具执行策略评估器 `evaluateToolExecution(toolName, args, context)`。
  - [x] 实现跨项目权限隔离（Cross-Project Isolation），将 `allow_session` 深度绑定至 `projectId` 与物理 `projectPath`。
- [x] 4. 改造文件操作与终端执行底层链路
  - [x] 改造 `src/ai/project-fs.js`：将 `resolveSafe` 升级为基于物理真实路径的 `verifyPathSandbox`。
  - [x] 改造 `src/ai/terminal.js`：工作目录接入沙箱校验；子进程环境变量采用 `buildSanitizedEnv`；超时/取消采用 `terminateProcessTree` 终止整棵进程树；输出流接入 `redactSecrets`。
  - [x] 改造 `src/ai/permission.js`：接入 `ExecutionPolicy` 级别评估与 `SecretManager` 动态脱敏，阻断跨项目授权继承。
- [x] 5. 改造主进程配置持久化与 IPC 通道
  - [x] 改造 `src/ai/settings.js`：移除明文 `apiKey` 保存逻辑，对接 `SecretManager`。
  - [x] 改造 `src/main.js`：启动阶段执行凭据迁移；注册 `isolation:get-status` 与 `isolation:request-elevation` IPC 通道；大模型请求从保管库实时解密读取。
  - [x] 改造 `src/preload.js`：暴露安全隔离状态与提权查询接口。
- [x] 6. 改造渲染进程安全状态呈现与显式提权交互
  - [x] 改造 `src/renderer/app.js`：状态栏右侧新增真实隔离状态显示（`[已隔离]` / `[宿主模式 (未隔离)]`）。
  - [x] 实现宿主提权确认模态弹窗（Host Elevation Modal），非隔离操作必须经用户显式确认。
  - [x] 改造 `src/renderer/styles.css`：增加安全状态胶囊、风险警告徽章与提权弹窗样式。
- [x] 7. 编写专项测试套件并执行全量回归
  - [x] 编写 `tests/e3-os-isolation.test.js`：验证路径逃逸拦截、子进程树彻底杀死、极简环境变量与出站防护。
  - [x] 编写 `tests/e3-secret-manager.test.js`：验证双模加密存储、配置平滑迁移、全局脱敏器。
  - [x] 编写 `tests/e3-execution-policy.test.js`：验证策略级别评估、跨项目授权隔离。
  - [x] 编写 `tests/e3-terminal-sandbox.test.js`：验证终端在极简环境下的执行、流式脱敏与进程树清理。
  - [x] 执行 E1、E2 与既有测试套件回归，确保 100% 通过。

---

## 二、架构约束与安全原则

1. **零虚假隔离原则**：仅设置 `cwd`、正则过滤或渲染进程 `sandbox: true` 绝不标称为完整 OS 沙箱。系统如实汇报隔离能力与当前模式；在宿主模式运行时必须醒目标注，拒绝误导。
2. **物理路径权威原则**：所有路径安全判定必须基于规范化物理路径（`fs.realpathSync.native`），软链接与连接点必须在物理层面严格约束在工作区基准根目录以内。
3. **最小秘密暴露原则**：子进程与外部工具环境默认零凭据暴露；大模型 API 密钥只在主进程发起网络请求的内存瞬间解密使用，绝不注入常规子进程，绝不明文落盘。
4. **确定性资源回收原则**：所有派生执行必须具备有界生命周期，在超时、中断或异常时，必须递归终止整棵进程树，绝不遗留后台孤儿进程。
