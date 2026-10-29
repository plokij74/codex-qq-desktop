# Windows 原生隔离探针

这是可复现的 AppContainer 可行性检查，**没有接入生产终端，不代表 E3/G15 已完成**。

在 Windows 仓库根目录运行（使用系统已有 Framework64 C# 编译器，不安装工具）：

```powershell
node scripts/e3-native-probe/run.cjs --run
```

每次创建全新的临时目录和 AppContainer profile，仅向该 profile 授予新建探针目录的权限。测试会启动 PowerShell、cmd 和 .NET 子进程、打开临时 IPv4 loopback listener；结束时关闭 Job 并删除 profile，保留临时文件作为证据。控制台 JSON 给出日志和证据路径，result.json 存在构建临时目录。

通过需要全部 26 项断言成功，包括：合成宿主环境变量存在的正对照、子进程不继承这些变量、Windows 改写后的 TEMP/TMP 仍在私有 workspace 内；真实 junction 的宿主可读正对照、容器内 Provider/.NET 经 junction 读写项目外文件均拒绝且外部 canary 不变；以及 PowerShell 临时 PSDrive 的项目内读写、嵌套 cwd 中原生程序执行、Provider/.NET 项目外 canary 读写被拒绝、简单后代进程回收、宿主 loopback 正对照与 AppContainer loopback 拒绝、canary 不变和 profile 删除。缺失检查、超时、非零原生退出码或任一失败都会使 Node 返回 1。编译失败也返回非零。

检查失败路径可用：

```powershell
node scripts/e3-native-probe/run.cjs --run --inject-failure
```

该命令只修改新建临时 fixture，故意注入 `provider-bootstrap=FAIL`，**预期退出码 1**。它用于验证验收器会报告失败。

限制：普通 AppContainer（非 LPAC）；没有生产环境净化、输出通道和秘密注入；不覆盖 Git/Node 工具链、全面出站网络、junction 竞争、恶意 breakaway、资源耗尽或打包分发。进程被外部强制终止时 finally 无法保证 profile 清理；正常与断言失败路径均检查删除结果。不能将这些局部检查当成生产隔离证明。生产能力状态保持不可用。
