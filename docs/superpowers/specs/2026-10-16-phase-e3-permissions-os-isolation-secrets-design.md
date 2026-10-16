# Phase E3：权限、OS 隔离与秘密管理设计规格

日期：2026-10-16。对应 [实施规划](../plans/2026-10-15-phase-e-product-readiness.md) 与 [E3 实施记录](../plans/2026-10-16-phase-e3-permissions-os-isolation-secrets.md)。

---

## 一、设计目标与定位

Phase E3 落实全功能补齐规划中的核心安全基础与边界隔离缺口：
1. **闭环 G15（OS 级文件/网络/子进程隔离与最小秘密暴露）**：从根本上终结以宿主全量 `process.env` 与直接无界 `spawn` 派生子进程的高危现状，在既有应用层权限 Gate 基础上建立文件、网络、进程、环境变量与资源五个维度的明确隔离边界。
2. **Windows 平台首要强验证与真实反向测试**：在 Windows 首要运行平台上，以实际拒绝越界读写、拒绝软链接/连接点（Junction）逃逸、拒绝内网/元数据出站访问、彻底清理子进程树（杜绝孤儿进程逃逸）的真实测试证明边界有效性。严禁仅通过设置 `cwd`、正则黑名单、Job Object 声明或渲染进程 `sandbox: true` 伪装为“已实现完整 OS 沙箱”。
3. **基于权能（Capabilities）的统一文件与项目范围隔离**：项目 A 的执行授权绝不自动蔓延覆盖项目 B；统一执行前与变更前的 `realpath` 规范化复验（防 TOCTOU 竞争与软链接逃逸）。
4. **主进程受控秘密管理（SecretManager）**：
   - 敏感凭据（OpenAI API Key、MCP Auth Token、OAuth Refresh Token、GitHub PAT）由主进程加密存储（优先使用 Electron `safeStorage` DPAPI，无图形/测试环境回退为带机器/用户指纹盐的 AES-256-GCM 本地加密保管库），彻底消除 `settings.json` 中明文持久化密钥的安全隐患。
   - 子进程环境实行白名单极简构造（`buildSanitizedEnv`），仅注入必要的基础系统变量（`SystemRoot`、`PATH` 等），绝不默认继承主进程环境变量与凭据。
   - 日志、导出、消息轨迹与模型 Payload 强制接入统一的动态秘密脱敏器（`redactSecrets`），杜绝凭据泄漏。
5. **诚实隔离状态与显式宿主提权（拒绝虚假隔离）**：主进程与渲染进程提供真实的 `isolationStatus` 状态反馈。当强隔离条件不可用或用户主动请求非隔离宿主执行时，必须弹出醒目黄色风险警告并要求独立确认，UI 状态栏明确显示 `【宿主执行模式 (未隔离)】`，严禁在降级执行时仍欺骗性展示“已隔离”。

---

## 二、详细设计与规范

### 1. OS 隔离后端架构（`src/ai/os-isolation.js`）

#### 1.1 文件沙箱与真实路径复验 (`verifyPathSandbox`)
- **核心原则**：纯字符串比对（如 `path.relative`）无法防御通过 Windows 软链接（Symlink）或 NTFS 连接点（Junction）跳出工作区的目录穿透攻击。必须使用物理路径进行确定性校验。
- **校验算法**：
  1. 对 `projectRoot` 执行 `fs.realpathSync.native` 获得规范的物理基准路径 `canonicalRoot`。
  2. 若目标路径 `targetPath` 已存在，执行 `fs.realpathSync.native(targetPath)` 获得 `canonicalTarget`。
  3. 若 `targetPath` 尚不存在（创建新文件情景），向上递归查找最近一个存在的父目录，获取其物理路径后与剩余相对路径片段安全拼接，计算出预期的 `canonicalTarget`。
  4. 计算 `path.relative(canonicalRoot, canonicalTarget)`：
     - 若结果以 `..` 开头或为绝对路径，判定为**越界逃逸**，立即抛出 `SECURITY_TRAVERSAL_DETECTED` 错误；
     - 检查路径中是否包含非法控制字符、Windows 备用数据流（Alternate Data Streams, 如 `file.txt:hidden`）或 Windows 保留设备名称（`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`），一律拒绝。
- **权能约束矩阵**：
  - `read`: 仅允许读取 `canonicalRoot` 范围内的常规文件或目录。
  - `write`: 允许在 `canonicalRoot` 范围内修改已存在文件或创建新文件，禁止覆盖项目外路径。
  - `delete`: 仅允许删除 `canonicalRoot` 范围内的非根路径，禁止删除 `projectRoot` 本身。

#### 1.2 极简环境白名单 (`buildSanitizedEnv`)
- **根因治理**：现存 `terminal.js` 中 `{ ...process.env }` 会使任意被执行的命令（如 PowerShell 脚本、npm、make 等）直接读取主进程所有环境变量，导致 `OPENAI_API_KEY`、GitHub 凭据、私有环境变量被轻易刺探或外发。
- **白名单规范**：
  - 子进程启动时创建全新空对象作为 `env`，仅从宿主环境中显式提取以下白名单变量：
    - **Windows 核心变量**：
      - `SystemRoot`, `SYSTEMDRIVE`, `WINDIR`（系统启动与基本 DLL 解析必需）
      - `PATH`, `PATHEXT`（命令查找必需，经净化后注入）
      - `TEMP`, `TMP`（受控临时目录）
      - `COMSPEC`（cmd.exe 规范位置）
      - `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`
      - `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`（重定向或规范化，防止用户全局敏感目录被直接篡改）
    - **POSIX 核心变量**：
      - `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`
  - **PATH 深度净化**：
    - 自动移除当前目录 `.` 及空项，防止当前目录同名木马二进制劫持；
    - 自动移除可疑的个人下载目录或未受信脚本目录。
  - **黑名单二次兜底**：
    - 遍历提取后的键，任何名称包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`AUTH`、`CREDENTIAL`、`PRIVATE` 的变量一律强制剔除。

#### 1.3 Windows 进程树确定性终止 (`terminateProcessTree`)
- **孤儿进程根因**：在 Windows 平台上，调用 Node.js 的 `childProcess.kill()` 仅向顶层的 `powershell.exe` 发送终止信号，而 PowerShell 启动的孙子进程（例如 `node`、`gcc`、`python` 或耗时构建任务）会脱离父进程继续在后台驻留运行，造成资源泄漏与不受控的隐蔽执行。
- **终止规范**：
  - 在 Windows 下：通过执行系统内置的 `taskkill.exe /pid ${pid} /T /F`，利用内核级进程树遍历，强行杀死目标 PID 及其所有子孙进程。
  - 容错处理：若目标进程在 `taskkill` 执行前已自然退出，忽略 `ERROR: The process ... not found`（返回码 128 / ESRCH），不向调用方抛出误报异常。
  - 超时防护：`taskkill` 本身设置 3000ms 执行超时；若 `taskkill` 异常，回退到 Node.js 兜底 kill。
  - 非 Windows 平台：使用 `process.kill(-pid, 'SIGKILL')` 向进程组广播杀死信号。

#### 1.4 网络出站边界守卫 (`checkOutboundPolicy`)
- 整合 `network-security.js` 与 `url-guard.js`。
- **强隔离模式策略**：
  - 默认禁止通过子进程或网络工具随意发起未经确认的外部网络连接。
  - 严厉拦截私网地址与云元数据地址：`127.0.0.1`, `localhost`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`（AWS/GCP/Azure 实例元数据服务）。
  - DNS 解析必须采用 `makeSafeLookup` 防范 DNS 重绑定攻击（DNS Rebinding）。

#### 1.5 真实隔离能力探测 (`probeIsolationCapabilities`)
- 探测当前宿主操作系统类型与安全特性支持情况：
  - `platform`: `'win32' | 'darwin' | 'linux'`
  - `hardwareEncryption`: 是否支持 Electron `safeStorage` (DPAPI / Keychain)
  - `pathSandbox`: 物理路径解引用与校验支持（全平台支持）
  - `envSanitization`: 环境变量白名单隔离支持（全平台支持）
  - `processTreeTracking`: 进程树回收支持（Windows `taskkill` / POSIX 进程组）
- 严禁在隔离机制失效时虚标状态。

---

### 2. 安全秘密管理库（`src/ai/secret-manager.js`）

#### 2.1 双模加密存储架构
- **第一级：系统密钥环加密（Electron `safeStorage`）**
  - 在 Windows 上底层调用 Windows Data Protection API (DPAPI)，密钥由操作系统维护并与当前 Windows 用户会话紧密绑定，只有当前用户登录上下文下的应用才可解密。
- **第二级：机器与用户派生密钥加密（AES-256-GCM Fallback）**
  - 在测试环境、无图形界面的 CLI 环境或 `safeStorage.isEncryptionAvailable() === false` 时使用。
  - 基于机器物理指纹（机器 GUID / CPU 架构）+ 用户安全目录 + 内置固定盐，通过 `crypto.pbkdf2Sync`（100,000 次迭代，SHA-256）派生 256 位主密钥。
  - 数据使用 `AES-256-GCM` 算法加密，密文中携带 12 字节随机 IV 与 16 字节 Auth Tag，防篡改防重放。
- **存储文件**：加密保管库持久化保存在用户数据目录下 `userData/secrets.vault.json`。

#### 2.2 配置解耦与自动平滑迁移
- **旧版缺陷**：历史版本中 `settings.json` 直接保存了明文的 `apiKey: "sk-..."`，易被同机恶意进程、日志导出或备份文件轻易窃取。
- **平滑迁移流程**：
  1. 应用启动初始化 `SecretManager`。
  2. 读取 `settings.json`：若存在明文 `apiKey` 字段：
     - 将其读入并调用 `secretManager.setSecret('main_api_key', plaintextKey)` 加密写入安全保管库；
     - 从 `settings.json` 中彻底删除 `apiKey` 字段，替换为 `apiKeyConfigured: true` 布尔标记与 `secretRef: "sec_main_api_key"`；
     - 将脱敏后的 `settings.json` 原子回写磁盘。
  3. 后续模型调用时，主进程通过 `secretManager.getSecret('main_api_key')` 实时解密，仅在内存中组装 HTTP 请求头，绝不再次落盘。

#### 2.3 动态凭据注册与全局脱敏器 (`redactSecrets`)
- **内存注册表**：
  - 维护内存中已知的全部动态敏感串集合（`Set<string>`）。
  - 凡是加载入内存的 API Key、MCP 认证 Token、OAuth Refresh Token、GitHub PAT，自动调用 `registerSecret(val, label)` 注入注册表。
- **全局脱敏方法 (`redactSecrets(text)`)**：
  1. 首先遍历内存注册表中的所有有效敏感串（长度 >= 6），执行全文精确字符串替换为 `[REDACTED:<label>]`。
  2. 随后执行高覆盖率正则启发式脱敏：
     - `Bearer\s+[A-Za-z0-9._~+/=-]+` -> `Bearer [REDACTED]`
     - `(?i)(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?([^\s"',;]+)` -> `$1=[REDACTED]`
     - AWS 凭据、私钥头（`-----BEGIN PRIVATE KEY-----`）等常见签名模式。
- **全面接入点**：
  - `message-schema.js`：V2 消息存储投影与 UI 投影；
  - `task-contract.js`：事件信封与任务轨迹；
  - `terminal.js`：`stdout` / `stderr` 流式分块与错误回包；
  - `session-export.js`：Markdown / JSON 导出管道。

#### 2.4 最小凭据定向注入原则
- 子进程与外接工具绝不默认继承任何密钥。
- 仅当明确需要外部凭据且经过用户批准的操作（例如 Git Push 需要特定的认证凭据时），主进程才将该特定操作所必需的单个环境变量注入给对应子进程，操作结束后立即销毁。

---

### 3. 执行策略与权限核心（`src/ai/execution-policy.js`）

#### 3.1 策略级别定义 (`ExecutionPolicyLevel`)
- `STRICT_ISOLATED` (默认推荐级别)：
  - 文件系统：强制要求物理路径必须在项目根目录内（`verifyPathSandbox`）；
  - 环境变量：仅使用极简系统白名单（`buildSanitizedEnv`）；
  - 进程控制：所有执行挂载超时监视，退出时通过 `terminateProcessTree` 清理整棵进程树；
  - 网络出站：严格拦截私网与未知出站，只允许已知模型端点与受控代理。
- `WORKSPACE_WRITE` (常规开发者写入级别)：
  - 允许在项目工作区内进行自由读写与工具调用；
  - 终端命令仍受环境变量白名单与沙箱 cwd 约束；
  - 涉及网络、删除或外部依赖变更需用户确认。
- `HOST_UNCONFINED` (非隔离宿主执行级别)：
  - 仅在用户显式触发提权且在前端确认弹窗中确认后允许；
  - 允许访问项目外指定路径；
  - UI 状态栏与操作历史强制打上 `【宿主执行模式 (未隔离)】` 警示标识。

#### 3.2 跨项目授权隔离（Cross-Project Isolation）
- 针对历史遗留的 `globalSessionAllows`（即 `allow_session` 记忆）：
  - 引入 `projectBindingId` 强作用域绑定；
  - 作用域键值规范为 `allow_session:${projectId}:${bindingId}:${risk}`；
  - 当会话切换项目或重新加载时，不同项目的 `allow_session` 权限绝对隔离，防止在项目 A 获得的放行权限被带到项目 B 中恶意使用。

---

### 4. 工具链路与执行接口改造

#### 4.1 终端模块改造 (`src/ai/terminal.js`)
- 淘汰旧实现：
  ```js
  // 旧高危代码
  const child = spawn('powershell.exe', [...], { cwd, env: { ...process.env } });
  ...
  child.kill();
  ```
- 替换为：
  ```js
  // 新隔离执行链路
  verifyPathSandbox(projectRoot, cwd, { mode: 'read' });
  const sanitizedEnv = buildSanitizedEnv(opts.customEnv);
  const child = spawn('powershell.exe', [...], { cwd, windowsHide: true, env: sanitizedEnv });
  ...
  const onAbort = () => {
    terminateProcessTree(child.pid);
  };
  ```

#### 4.2 文件操作模块改造 (`src/ai/project-fs.js`)
- `resolveSafe` 函数核心改造：
  ```js
  function resolveSafe(projectRoot, relPath = '.', mode = 'read') {
    return verifyPathSandbox(projectRoot, relPath, { mode });
  }
  ```
- 彻底封死通过内部软链接逃逸到项目外的读取与写入路径。

#### 4.3 渲染进程安全交互改造 (`src/renderer/app.js` & `styles.css`)
- **状态栏隔离徽标**：
  - 状态栏右侧新增安全胶囊：
    - 绿色徽章：`[🛡️ 已隔离]`（Hover 提示：物理沙箱有效、极简环境注入、进程树严格监管）；
    - 醒目黄色徽章：`[⚠️ 宿主模式 (未隔离)]`。
- **显式提权确认弹窗（Host Elevation Modal）**：
  - 当操作请求执行 `HOST_UNCONFINED` 级别的非隔离操作时，前端拦截请求并弹出警告弹窗；
  - 弹窗必须明确列出：请求工具、目标非工作区路径、请求环境变量等敏感信息；
  - 必须由用户主动点击“允许本次以宿主模式执行”方可向主进程提交授权。

---

## 三、验收标准与测试套件

| 验证项 | 对应模块 | 验证方法与验收基线 |
| --- | --- | --- |
| 路径沙箱反向逃逸测试 | `os-isolation.js` / `project-fs.js` | 尝试访问 `..`、绝对盘符、指向工作区外的 Symlink/Junction，全部被 `SECURITY_TRAVERSAL_DETECTED` 拦截 |
| 环境变量白名单测试 | `os-isolation.js` / `terminal.js` | 启动测试子进程打印 `env`，断言主进程的 `API_KEY`、`TOKEN`、系统敏感变量 100% 不存在 |
| Windows 进程树彻底回收 | `os-isolation.js` / `terminal.js` | 启动派生二级子进程的脚本，触发 abort/timeout 后，Windows 进程列表中无残留进程 |
| 秘密保管库加密与迁移 | `secret-manager.js` / `settings.js` | `settings.json` 中的明文密钥自动迁移至加密保管库，原文件清理明文且 API 请求正常解密执行 |
| 动态凭据脱敏覆盖率 | `secret-manager.js` | 验证内存中注册的 Secret 在文本、错误对象、轨迹流及导出文件中被替换为 `[REDACTED]` |
| 跨项目权限隔离 | `execution-policy.js` / `permission.js` | 项目 1 授予的 `allow_session` 权限在项目 2 中调用相同工具坚决要求重新授权 |
| 全量回归测试 | `tests/` | 现有 E1 16 项、E2 11 项及工程套件全部保持绿灯，低风险工具功能无回退 |
