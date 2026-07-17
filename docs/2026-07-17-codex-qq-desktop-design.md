# Codex QQ Desktop — 设计规格

**日期:** 2026-07-17  
**项目路径:** `D:\workspace\ai\codex-qq-desktop`  
**状态:** 待用户确认

## 1. 目标

构建一个 Windows 桌面应用：**QQ 2007 经典皮肤风格的 Codex 聊天客户端**。

- 主交互：与 Codex AI 助手对话
- 视觉：高还原 QQ 2007 三栏布局（非像素级）
- 运行时：Electron + 原生 HTML/CSS/JS
- 全部源码、文档、配置、构建产物配置均位于本项目文件夹内

## 2. 用户已确认的决策

| 项 | 选择 |
|----|------|
| 产品形态 | B — Codex 聊天客户端 |
| 技术栈 | A — Electron + HTML/CSS |
| AI 后端 | C — 本地模拟 + 可切换 OpenAI 兼容 API |
| 还原程度 | A — 高还原 MVP |
| 项目组织 | 独立文件夹 `codex-qq-desktop`，所有内容放其内 |

## 3. 架构方案

**选定：单窗口 Electron + 纯静态前端（方案 1）**

| 方案 | 说明 | 结论 |
|------|------|------|
| 1. 单页 Electron + HTML/CSS/JS | 一个 BrowserWindow，主进程管窗口与配置 | **采用** |
| 2. Electron + React/Vue | 组件化 | 首版过重，不采用 |
| 3. 多窗口 QQ 式 | 主面板 + 独立聊天窗 | 超出 MVP，不采用 |

### 3.1 进程职责

- **主进程 (`src/main.js`)**
  - 创建窗口、应用菜单（可选精简）
  - 读写本地配置（JSON 文件，位于用户数据目录或项目 `data/`）
  - IPC：发送聊天请求、读写设置
  - 调用 OpenAI 兼容 API（避免 API Key 暴露在无隔离页面）
  - 本地模拟回复生成

- **预加载 (`src/preload.js`)**
  - `contextBridge` 暴露安全 API：`sendMessage`、`getSettings`、`saveSettings` 等
  - `contextIsolation: true`，`nodeIntegration: false`

- **渲染进程 (`src/renderer/`)**
  - QQ 2007 皮肤 UI
  - 会话状态、消息列表渲染、输入框
  - 设置弹窗

## 4. 界面规格

### 4.1 整体布局

```
┌─────────────────────────────────────────────────────────────┐
│ 标题栏: Codex 2007 - {当前会话标题}              [_][□][X] │
├─────────────────────────────────────────────────────────────┤
│ 工具栏: 新建任务 | 已安排 | 插件 | 站点 | 拉取请求 | 聊天   │
├──────────┬──────────────────────────────┬───────────────────┤
│ 左侧栏   │ 中间会话区                    │ 右侧栏             │
│ ~220px   │ flex:1                        │ ~200px            │
│ Codex    │ 会话标题 + 消息流             │ Codex 好友        │
│ 导航/联系人│ 气泡、chip、代码块           │ 机器人卡片        │
│ 项目/任务│ 底部输入区                    │ 我的好友          │
├──────────┴──────────────────────────────┴───────────────────┤
│ 状态栏                                                      │
└─────────────────────────────────────────────────────────────┘
```

默认窗口约 **1024×700**，最小约 **860×560**。

### 4.2 视觉

- 主色：QQ 经典蓝（标题栏/工具栏渐变蓝、选中项亮蓝）
- 侧栏背景：浅蓝灰
- 消息区背景：偏白/浅灰
- 代码块：深色或浅灰底 + 等宽字体，带 `bash` 标签样式
- 右侧机器人：蓝色圆形机器人头像（CSS/SVG，不依赖外网图）
- 好友列表：示例头像 + 昵称

### 4.3 左侧栏内容（演示数据）

- 顶部：Codex 折叠组
- 导航项：新建任务、已安排、插件、站点、拉取请求、聊天
- 置顶文件夹：hn、hma、lingmo、notepal-app、imgcook
- 项目：showdex、epubkit-electron、anyicon、prisma-schema、image-agent
- 任务：微信发送 hello world 等
- 在线联系人示例：Randy Lu

### 4.4 中间会话

- 默认会话标题示例：`优化 KV 读写成本`
- 消息类型：
  - 纯文本
  - 列表 + 标签 chip（如 `redeem_codes`）
  - fenced 代码块（bash）
- 底部：表情/图片/附件按钮（UI 占位，可不实现真实功能）
- 输入框 + 发送；Enter 发送，Shift+Enter 换行

### 4.5 右侧栏

- 「Codex 好友」+ 机器人大头像
- 简介：代码有问题？找我！…
- 「我的好友 (n)」列表

## 5. 功能规格

### 5.1 聊天

1. 用户在输入框发送消息 → 追加用户气泡
2. 显示「正在输入/思考」状态（可选短延迟）
3. 根据设置调用：
   - **local**：主进程模板/关键词模拟回复（可含代码块）
   - **api**：`POST {baseUrl}/chat/completions`，Bearer token
4. 助手回复追加到会话；支持基本 Markdown 子集：段落、行内 code、fenced code

### 5.2 设置

- 入口：工具栏或标题旁齿轮/菜单
- 字段：
  - 模式：`local` | `api`
  - Base URL（默认 `https://api.openai.com/v1`）
  - API Key（密码框）
  - Model（默认 `gpt-4o-mini`）
- 持久化到本地 JSON（通过主进程）

### 5.3 本地模拟策略

- 命中关键词（如 migration、wrangler、KV、bug）→ 返回贴近截图风格的技术回复
- 否则通用助手模板
- 回复可带 1 段 bash 示例代码块

### 5.4 安全

- `contextIsolation: true`
- 不启用 `nodeIntegration`
- API Key 仅主进程持有
- 渲染消息时转义 HTML，代码块仅作文本展示

## 6. 目录结构（全部在项目根内）

```
codex-qq-desktop/
├── package.json
├── electron-builder.yml          # 可选
├── README.md
├── docs/
│   └── 2026-07-17-codex-qq-desktop-design.md
├── src/
│   ├── main.js
│   ├── preload.js
│   ├── ai/
│   │   ├── local-mock.js
│   │   └── openai-compatible.js
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       ├── app.js
│       └── assets/               # 内置 SVG/图标
└── data/                         # 可选：开发期默认配置样例
    └── settings.example.json
```

## 7. 非目标（首版不做）

- 真实账号体系、云同步
- 语音/视频/文件发送真实逻辑
- 系统托盘、开机启动
- 多独立聊天窗口
- 像素级换肤引擎
- 自动更新

## 8. 成功标准

1. 在项目目录执行 `npm install` && `npm start` 可打开三栏 QQ 风界面
2. 本地模式下可与 Codex 多轮对话
3. API 模式配置正确后可真实对话；错误时有可读提示
4. `npm run dist` 可生成 Windows 可执行产物（至少 portable 或 nsis 之一）
5. 所有相关文件均在 `codex-qq-desktop/` 内，不污染仓库其他目录

## 9. 实现顺序（概要）

1. 初始化 npm + Electron 入口与安全 preload
2. 搭建 QQ 2007 三栏静态 UI + 演示数据
3. 接入发送消息与本地模拟
4. 设置页 + API 模式
5. 打包配置与 README

---

请确认本规格。确认后进入实现计划并开始编码。
