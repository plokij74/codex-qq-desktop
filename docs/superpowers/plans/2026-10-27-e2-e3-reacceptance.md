# E2 / E3 重新验收记录

日期：2026-10-27；Windows；Node v22.22.0；Electron 33.2.1。基线：`661c7a112dec36a13addc8a76709972ba5ecdad7`。本次变更保留在工作区，未提交。

## 当前结论

- E2 消息投影、Plan 绑定/状态机/失败回滚、轨迹与任务事件已接通。真实 Electron 流程覆盖计划生成、审批、执行和刷新过期；发现并修复了快速响应时 IPC 返回抢先于事件处理、导致 Plan 丢失的问题。
- E3 应用层权限、单次原生宿主确认、秘密存储与脱敏已接通，追加修复了 MCP headers/env 明文落盘问题。**生产 OS 文件/网络强隔离后端尚未完成，完整 G15/E3 不能标为完成。**
- 完整串行回归 **1134/1134 通过，0 失败、0 取消、0 跳过**，911.67 秒。该轮开始后继续完成了 MCP 存储及渲染事件竞争修复；新增测试与最终实现由后续相关回归验证，不将其虚计入这 1134 项。
- 最终实现相关组合回归 **461/461 通过，0 失败/取消/跳过，32.55 秒**，覆盖最后的 MCP 存储与渲染事件竞争修复。上一轮专项 321/321、MCP 独立相关回归 73/73 也通过，均不叠加计数。

## 已完成实现与覆盖

E2 使用统一消息投影贯通主进程模型请求、渲染存取、压缩与导出，动态脱敏与大小限制共用。PlanStateManager 绑定窗口、会话、项目物理路径及 projectBindingId；claim 防并发/重放，失败 rollback，执行成功 complete。解绑使旧计划失效，历史加载显示过期计划。TaskHandle 接入 chat 生命周期及事件信封。窗口 destroyed 回调改用预先捕获的 webContents 引用，避免读取已经销毁的窗口对象。

渲染审批先创建事件收集器再等待 IPC；失败恢复为可重试，拒绝以主进程返回成功为准。工具/审批/验证/子任务轨迹持久化为有界摘要。主 Agent 与 write-fence 每次执行生成独立 UUID callId，所有成功/失败/拒绝/异常/取消 TOOL_END 均与 TOOL_START 配对，模型 tool_call_id 保持原值。实际事件经收集、存储及恢复测试验证关联。

真实 Electron 暴露同步 schema IPC 重入期间 invoke 返回抢先、页面提前 finalize 的竞争。现在发送与批准流程等待终止事件处理完成后再固化消息，缺少终止事件时使用 2 秒有界后备处理。零延迟本地模型响应重新验收成功；不是通过给模拟响应加延迟规避问题。

E3 宿主执行 capability 保存在主进程 WeakMap：60 秒有效，绑定物理 root、cwd、session 和完整命令，单次消费。布尔 confirmed/isElevated、HOST_UNCONFINED 设置、allow_session 均不能代替原生单次确认。Agent、手动终端、Verification 及 repair 验证均接通；缓存 profile grant/preAuthorized 不能跳过真实默认终端授权。

SecretManager 各实例共用注册表；配置读取、MCP OAuth 解密/交换/刷新及定向注入注册真实秘密。MCP 完整 env/headers 加密存入 vault，设置只留 opaque credentialsRef，主进程加载时解密；旧配置在 vault 成功写入后原子迁移。更新使用新引用，设置提交后才删除旧引用；缺失凭据或存储失败拒绝加载，不退回明文。Cookie/非标准名称的值也注册脱敏。测试覆盖磁盘/重启/迁移/失败/引用生命周期、IPC 与导出。

真实终端测试覆盖 Junction/失效 Junction、环境凭据剥离、跨 UTF-8 字节输出、能力重放拒绝及孙进程 abort/timeout 后 PID 不存在。原生 dialog 在自动化测试中使用替身；终端子进程实际执行。

## 自动化测试记录

完整串行回归，退出码 0，1134 pass：

```powershell
node --test --test-concurrency=1 --test-timeout=600000 tests/**/*.test.js
```

先前专项，退出码 0，321 pass，32.10 秒：

```powershell
node --test --test-concurrency=2 --test-timeout=120000 tests/e1-*.test.js tests/e2-*.test.js tests/e3-*.test.js tests/renderer-*.test.js tests/agent.test.js tests/agent-call-id.test.js tests/agent-abort.test.js tests/permission.test.js tests/terminal-callbacks.test.js tests/verification-manager.test.js tests/mcp-oauth.test.js tests/session-compact.test.js tests/session-export.test.js
```

MCP 存储修复相关回归，退出码 0，73 pass：

```powershell
node --test tests/e3-mcp-settings.test.js tests/e3-settings-ipc.test.js tests/settings.test.js tests/mcp-config.test.js tests/main-mcp-d10-ipc.test.js tests/session-export.test.js tests/mcp-oauth.test.js
```

历史失败与复测：早期 120 秒文件预算的全量为 1118 项（1113 pass、2 fail、3 cancelled）。D11 旧源码形式断言改为真实 VM 行为测试，D16 Git ls-files 临时失败串行复测 2/2 通过；三个超时文件在 HEAD 基线同样超时，延长预算后独立重跑 19/19 通过（665.26 秒），最终在完整串行回归中通过。D20 四项耗时 135.50、88.67、114.22、68.11 秒，证实原文件预算不足。早期运行与最终结果不合并计数。

## 真实 Electron 验收

使用独立临时 userData 和项目，不修改真实用户数据。实际 main/preload/renderer/Agent 加载，loopback OpenAI SSE 模拟服务返回真实 submit_plan 和 read_file；通过 DOM `.click()` 操作审批卡片，非物理鼠标。

零延迟响应验证链：生成 Plan → 页面显示 proposed 卡片 → 点击批准 → 真实读取 fixture → approved 状态持久化 → 生成第二个 pending Plan → reload → pending 变 expired、approved 保留。最终记录 `complete:true`、`errors:[]`、`console:[]`、`blockedNetwork:[]`，退出码 0。先前本地聊天 smoke 另验证 `persistenceEqual:true`、`errorsAtQuit:0`，无残留 Electron 进程。

证据根目录：`C:\Users\Administrator\AppData\Local\Temp\codex-real-electron-smoke-20261027-1425-b72a`。Plan 最终结果：`plan-run-1793083647991\result.json`；本地聊天结果：`rerun-1793082600872\result.json`。未用外部真实模型服务，不声称覆盖生产网络或人工点击。

## Windows 强隔离原型与未关闭项

本机 Windows 10 Pro 21H2 build 19044.5737；WSL2 的 Ubuntu/docker-desktop 均停止，Docker 服务停止，Windows Sandbox 功能未启用。未启动这些服务、安装组件或修改现有目录 ACL。利用已有 Framework64 csc 编译的独立临时 C# P/Invoke 原型证明：AppContainer 创建成功，TokenIsAppContainer=1；挂起启动、先加入 kill-on-close Job 再恢复；cmd/.NET 可写新建授权目录；外部 canary 读写抛 UnauthorizedAccessException 且保持不变；宿主本地连接成功而容器内连接超时；父进程退出后关闭 Job 清理简单孙进程；所有 profile 已删除。

**兼容性调查进展（第 3 轮）**：PowerShell 对物理绝对路径执行 `Set-Location` 仍失败，堆栈落在 `Utils.NativeFileExists → FileSystemProvider.GetFileSystemInfo → NormalizeThePath → NormalizeRelativePathHelper`。但在授权目录上建立进程内临时 PSDrive（`New-PSDrive -Name W -PSProvider FileSystem -Root $Work -Scope Script; Set-Location W:\`）后，相对 Set/Get-Content、目录枚举和原生 cmd 已成功；绝对 Set-Content 与 .NET 相对 IO 也成功。外部 canary 的 .NET/Provider 读写继续被拒绝，canary 未变，后代进程回收与 profile 删除成功。未扩大现有祖先目录权限。

这证明基础 PowerShell IO 有兼容路径，尚不能据此宣称生产后端可用：嵌套 `Set-Location W:\nested` 后 `$PWD.Path` 是虚拟路径，`$PWD.ProviderPath` 才是物理路径；通过 `&` 启动的 cmd 获得正确的物理子目录，而 `[Environment]::CurrentDirectory` 仍停在初始目录。直接把 `W:\` 交给 .NET/原生程序失败。子 pwsh 可启动并在重新建立自身 PSDrive 后写入，不能依赖继承父 shell 的 drive 定义。安装在 `F:\Program Files\Git\cmd\git.exe` 的 Git 在该容器中报 CommandNotFoundException，尚未验证 Git 操作兼容性。

最小权限因果实验仅修改新建临时目录：私有 drive 下未授权的中间目录导致相同 NormalizeThePath 错误；只授予中间目录 ReadAttributes `(RA)` 后，私有 drive 路径的 Set-Location 成功。现有用户/临时目录祖先仍不授权，物理绝对路径的 Set-Location 继续失败。无需为基础 IO 放开祖先目录列表权限，但不能据此推导任意工具都兼容。

诊断日志中的 `FAIL outside-*` 为预期拒绝，`FAIL set-location-*` 为兼容性失败，不能仅凭原型进程退出码 0 判定整体验收通过。初始证据：`C:\Users\Administrator\AppData\Local\Temp\codex-e3-provider-3f25ff5a2a004107a90ff8b8e7cc07d8\diagnostics-run.txt`。同目录 `final-run.txt` 汇总后续实验：pwsh 7 与 Windows PowerShell 子进程均显示 `inheritedW=False`，未 bootstrap 的相对写入抛 UnauthorizedAccessException，建立自身 Q drive 后写入成功；最终 `outside-canary-unchanged=True`、`descendant-cleaned=True`、`DeleteAppContainerProfile HRESULT=0x00000000`。

上游 [microsoft/mxc PR #448](https://github.com/microsoft/mxc/pull/448) 区分了原生 chdir 的 FILE_TRAVERSE 要求、PowerShell Provider 的祖先检查以及 Git for Windows 的 Mount Point Manager 兼容问题；该资料作为机制线索，本机结论以实际测试为准。

原型不等于完整验收：非 LPAC；未覆盖全部网络/注册表/重解析竞争/恶意 breakaway/资源耗尽；使用宿主环境，生产还必须实现净化环境与输出传输。普通 AppContainer 可访问某些 ALL APPLICATION PACKAGES 资源。生产能力继续 `supported:false / osIsolationAvailable:false / activeMode:host-unconfined`。

原型证据（仅临时文件，无实验二进制进入源码）：

- `C:\Users\Administrator\AppData\Local\Temp\codex-e3-appcontainer-42a727e9ee6b448b9e48ad84f79d0abe\Probe.cs`
- 仓库盘符实验已归档到 `C:\Users\Administrator\AppData\Local\Temp\codex-e3-appcontainer-repo-probe-36b52ba4bc774e4e8e5ef166fecc7f64`；其文件中的原 staging 路径是实验历史路径。

其他保留限制：

1. 确认后的宿主 shell 可访问当前账户的项目外文件与网络；URL 守卫不约束 shell 套接字。realpath 复验不是内核级竞争防护，taskkill 不是 Job containment。
2. 终端每个输出流最多缓存 20KB，进程结束时脱敏发布；超限整段省略，暂不提供实时终端输出。
3. GitHub 凭据由外部 gh 管理，应用不读取内部令牌；AES fallback 不等价于系统密钥环；动态脱敏保留原有至少 4 字符限制。
4. MCP 设置提交失败可能留下无引用的加密记录；服务器重命名未重填隐藏凭据时仍遵循已有按名称匹配行为。

## 可复现原生探针（第 4 轮）

新增 `scripts/e3-native-probe/`，使用已有 csc 在全新临时目录编译，不安装组件，也不启用生产隔离。执行 `node scripts/e3-native-probe/run.cjs --run`，最终 17/17 断言通过，退出码 0；证据 `C:\Users\Administrator\AppData\Local\Temp\codex-e3-native-build-IbLkYp\result.json`。覆盖 Provider bootstrap、嵌套目录中的原生命令、项目外 canary 拒绝、基本后代进程回收、IPv4 loopback 正负对照及 profile 删除。网络断言仅接受超时或明确 AccessDenied，其他 SocketException 不算通过。

执行 `--run --inject-failure` 后 provider 两项按预期失败，返回退出码 1，仍通过 profile 删除检查；证据 `C:\Users\Administrator\AppData\Local\Temp\codex-e3-native-build-S0FDKS\result.json`。这确认验收器不会因原型正常退出而误报全绿。该轮仅改变独立探针与文档，生产实现仍采用上面的最终相关回归结论。

Git 工具链委派调查两次异常结束且未返回报告，没有可采信的新通过结论。生产后端、工具链兼容与完整逆向安全矩阵继续未完成，E3 状态不变。

## 静态 junction 逆向验证（第 5 轮）

独立探针新增真实 NTFS junction：新建授权 workspace 内的 escape 指向同一临时根下未授权 external 目录。宿主正对照确认链接可读；AppContainer 内 Provider 和 .NET 经链接读写均抛 UnauthorizedAccessException，外部 canary 保持原值。检查数从 17 扩展到 23，全部通过，退出码 0：`C:\Users\Administrator\AppData\Local\Temp\codex-e3-native-build-Z46xfH\result.json`。

失败注入复测按预期两项失败、其余 21 项成功，退出码 1，profile 删除成功：`C:\Users\Administrator\AppData\Local\Temp\codex-e3-native-build-NvnUEH\result.json`。这是静态链接场景，没有证明重解析点动态替换的竞争安全性。该轮仅修改探针及文档，尚未接入生产隔离，E3 继续未完成。

## 原生环境净化（第 6 轮）

探针 CreateProcess 改为显式 Unicode 环境块（CREATE_UNICODE_ENVIRONMENT），仅提供系统启动变量、系统 PATH 与指向新建 workspace 的 profile/temp 变量。宿主设置两个合成变量（凭据型名称与普通名称），实际 .NET 子进程均不可见，未读取或输出真实凭据。26/26 检查通过、退出码 0：`C:\Users\Administrator\AppData\Local\Temp\codex-e3-native-build-BBze5e\result.json`。

最初省略 profile 目录变量导致 CreateProcess Win32Error=203；补齐显式 USERPROFILE/LOCALAPPDATA/APPDATA/SystemDrive 后启动成功。Windows 会将 TEMP/TMP 改写到 workspace 下 `Packages\<profile>\AC\Temp`，测试检查两者一致且仍位于私有 workspace 内，未将等于原始目录作为错误标准。已有 IO、junction、loopback、后代回收和 profile 删除检查继续通过。该实现仍在独立探针，生产终端接入及完整工具链/安全矩阵未完成，E3 保持开放。

## 证据与最终相关回归

最终组合回归（461 pass，32.55 秒，退出码 0）：

```powershell
node --test --test-concurrency=2 --test-timeout=120000 tests/e1-*.test.js tests/e2-*.test.js tests/e3-*.test.js tests/renderer-*.test.js tests/agent.test.js tests/agent-call-id.test.js tests/agent-abort.test.js tests/permission.test.js tests/terminal-callbacks.test.js tests/verification-manager.test.js tests/mcp-*.test.js tests/settings.test.js tests/main-mcp-d10-ipc.test.js tests/session-compact.test.js tests/session-export.test.js
```

最终日志 `round2-final-acceptance-retest.log`。其前一轮 460/461 的唯一失败为旧 VM 测试未加载新 helper（`waitForChatRunEvents is not defined`），已让 fixture 加载真实 helper 与 timers，未用生产变更绕过失败。新增事件顺序定向测试另 14/14 通过，真实零延迟 Electron 流程在最终 app.js 版本验证通过。


原始 TAP 日志位于 `C:\Users\Administrator\AppData\Local\Temp\codex-e23-acceptance-20261027`：`full-final.log`（1134）、`final-acceptance.log`（321）、`extended-regression.log`（19）。HEAD 超时基线证据位于 `C:\Users\Administrator\AppData\Local\Temp\codex-qq-head-baseline-61f3761b9e49465999c5b24edbe9c165`。各轮以实际结果为准，不以清单勾选代替证据。
