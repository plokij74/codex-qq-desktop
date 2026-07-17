# Codex QQ Desktop

QQ 2007 风格的 **Codex 聊天客户端**（Windows / Electron）。

## 功能

- 经典 QQ 2007 三栏皮肤
- **多会话**：任务 / 项目 / 好友，localStorage 持久化
- **工具栏 / 侧栏**：新建任务、已安排、插件、站点、拉取请求、聊天
- **搜索**过滤会话与项目
- **表情 / 图片 / 附件**（含粘贴图片）
- **斜杠命令**：`/help` `/clear` `/mode` `/new 标题`
- AI：**本地模拟** 或 **OpenAI 兼容 API**

## 开发

```bash
cd codex-qq-desktop
npm install
npm run start:win
# 或
npm start
```

## 测试

```bash
npm test
```

## 打包

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist
```

## 设置

标题栏 ⚙：

| 字段 | 说明 |
|------|------|
| 模式 | 本地模拟 / OpenAI 兼容 API |
| Base URL | 填到 `/v1`，不要带 `/chat/completions` |
| API Key | 主进程保存 |
| Model | 如 `gpt-4o-mini` |

## 界面操作速查

| 操作 | 效果 |
|------|------|
| 新建任务 | 弹窗创建任务会话 |
| 点击项目文件夹 | 打开项目上下文会话 |
| 点击好友 / Codex 卡片 | 打开对应聊天 |
| 已安排 / 插件 / 站点 / PR | 功能页，可一键丢给 Codex |
| 清空 | 清空当前会话消息 |

## Agent 与终端

| 设置 | 默认 | 说明 |
|------|------|------|
| 启用多轮 Agent | 开 | API 模式 + 已绑定项目时，模型可反复 list/read/write |
| 最大轮数 | 8 | 防止无限循环 |
| 允许终端 | **关** | 开启后 Agent 可调用 `run_terminal` |
| 执行前确认 | 开 | 每条命令弹窗确认 |

在项目会话中可说：「读取 package.json，加一个 scripts.hello，然后运行 npm run hello」。
