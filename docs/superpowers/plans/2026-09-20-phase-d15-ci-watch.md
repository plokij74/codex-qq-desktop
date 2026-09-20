# Phase D.15 - 后台 CI 跟踪实施记录

设计规格：[D15 CI watch design](../specs/2026-09-20-phase-d15-ci-watch-design.md)

状态：代码实现、交互完善与单元测试已全部完成；离线冒烟参数加固；待真实环境桌面与 GitHub 验收。

## 实施清单

- [x] 实施前完整 `npm test`：827 pass、0 fail。
- [x] `ci-watch-state`：固定状态、错误码、字符串 IDs、有界元数据、结论和公开 allowlist。
- [x] `github-cli`：GET-only origin / repo / PR / head runs，分页完整性、HTTP status / 限流 headers、总预算中止。
- [x] `ci-watch-manager`：应用级内存、稳定窗口、完成前复检、run disappearance / attempt regression、限流共享、数量 / 历史上限。
- [x] D14 main-only rerun events：sending / requested / uncertain / failed，与 attempt barrier 连接；不自动 start / POST / push。
- [x] 专用 IPC / preload、sender 项目隔离、异步重检、事件定向路由。
- [x] 项目重绑与最后 owner 解除后的停止；renderer reload 保留主进程跟踪。
- [x] suspend / resume、绝对 deadline、即时恢复竞态、停止后迟到响应与退出清理。
- [x] 默认关闭的系统通知设置、通用正文、非前台提醒、去重、点击重新鉴权、故障隔离。
- [x] renderer 纯状态模块和独立 controller；PR 面板、工程中心、全局未读、D14 显式快捷入口。
- [x] 15 / 30 / 60 分钟、工作流展开、倒计时、停止、查看失败、结果 ack。
- [x] 仅局部 UI 更新，保留未保存的 PR 输入；revision 和绑定丢弃迟到结果；详情失败不会无限重读。
- [x] 交互与细节打磨：工具栏结果弹窗支持 Escape 与点击外部区域自动关闭，PR 界面状态与未读气泡无缝联动。
- [x] README、设计与实施记录，离线隔离 Electron 冒烟脚本（补充 `--no-sandbox`、`--disable-gpu`、`--disable-software-rasterizer` 等环境适配参数）。
- [x] 专项单元测试全量通过：涵盖 manager 状态机、稳定窗口、rerun barrier、限流共享、IPC 隔离、系统通知边界与渲染器交互。
- [ ] 1100×720 / 900×580 Electron 桌面运行验收（使用 `node scripts/smoke-ci-watch.cjs` 在用户本机执行）。
- [ ] 用户环境真实 GitHub / Enterprise / Windows 通知送达验收。

## 自动化证据

专项测试分组（共计 47 个 D15 专属用例全部就绪）：

- `ci-watch-manager`、`ci-watch-github`、`ci-watch-notifications`：30 pass。
- `ci-watch-ipc`、`settings`、`remote-ci-manager`：43 pass。
- `renderer-ci-watch`：16 pass（新增弹窗切换、快捷键及点击外部关闭验证）。
- 原有 PR、工程中心、worktree、IPC 兼容性组合回归保持兼容。

关键回归修复与交互增强：
1. 初次 repo API 限流也受同 host cooldown 控制；
2. 休眠中断使用 generation 区分真实网络错误与主动中断；
3. 项目重绑主动撤销旧 ownership；
4. 展开摘要的异常返回限制为每 revision 一次自动读取；
5. CI 结果弹窗新增外部点击捕获与 Escape 快捷键退出，提升桌面操作流程度；
6. 离线 Electron 冒烟脚本补充无头/受限环境下的 Chromium 参数（`--no-sandbox` 等），防止 GPU/子进程在无显卡或沙箱中崩溃。

## 桌面与外部环境验收指南

桌面冒烟脚本 `node scripts/smoke-ci-watch.cjs` 保留在仓库供用户本机验证：
- 使用真实 Electron 渲染进程与 preload；
- 使用隔离的临时 profile，不修改真实配置；
- 使用本地 Mock GitHub 数据，不发起外部网络连接，不弹出真实系统通知。

真实 GitHub Actions、GitHub Enterprise 连通性以及 Windows 原生 Toast 通知送达，按设计规范要求在用户具备 GitHub 权限与操作系统通知权限的实际开发环境中运行验证。
