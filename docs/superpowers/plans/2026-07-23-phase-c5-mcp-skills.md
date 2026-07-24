# Phase C.5 MCP/Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付三传输 MCP（stdio/SSE/Streamable HTTP）+ 只读 resources、Skills 可执行 `run_skill` + triggers 自动路由提示、MCP 服务器列表 UI（含测试连接）；无新 npm 依赖。

**Architecture:** `mcp-config` 统一 sanitize；`createMcpClient(cfg)` 按 `transport` 分发 stdio/sse/http 适配器，共享 JSON-RPC 语义；`mcp-hub` 串行连接并暴露 tools + 固定资源工具；`skills-loader` 解析 `triggers`/`command`；`skillsProvider` 增加 `run_skill` 与匹配 system 片段；设置页列表 CRUD + `mcp:testServer` IPC。

**Tech Stack:** Electron 33、Node CommonJS、`node:test`、`http`/`https` 内置模块（无新依赖）。

## Global Constraints

- 无新 npm 依赖（纯 Node CommonJS）
- 用户可见文案 **zh-CN**
- stdio 兼容：旧 `mcpServers` 仅 `command` → `transport: 'stdio'`
- 传输：`stdio` | `sse` | `http`；lifecycle = 每主 run 连/断
- resources 只读；无 prompts/sampling/OAuth
- `run_skill`：`spawn` + `shell: false`；**禁止** `require` 用户 JS；risk = **`write`**
- triggers：子串不区分大小写；最多 5 个 skill；只注入 description 提示，不灌全文、不自动 run
- plan 隐藏所有 `mcp_*` 与 `run_skill`；depth≥1 无 MCP/Skills
- URL 仅 `http:`/`https:`
- `npm test` 全绿

**Spec:** `docs/superpowers/specs/2026-07-23-phase-c5-mcp-skills-design.md`

---

## File map

| 路径 | 动作 | 职责 |
|------|------|------|
| `src/ai/mcp-config.js` | Create | `sanitizeMcpServers` / `inferTransport` |
| `src/main.js` | Modify | 用 mcp-config；`mcp:testServer` IPC |
| `src/ai/mcp-client.js` | Modify | 工厂按 transport 分发；stdio 实现保留/小改 resources |
| `src/ai/mcp-http.js` | Create | Streamable HTTP 最小客户端 |
| `src/ai/mcp-sse.js` | Create | SSE 最小客户端 |
| `src/ai/mcp-hub.js` | Modify | enabled/transport；resources；固定工具 defs |
| `src/ai/providers/mcp.js` | Modify | hub 固定资源工具合并 |
| `src/ai/skills-loader.js` | Modify | triggers/command/args/timeout/cwd |
| `src/ai/providers/skills.js` | Modify | `run_skill` + 匹配片段 |
| `src/ai/permission.js` | Modify | `run_skill` → write |
| `src/ai/agent-mode.js` | Modify | plan 隐藏 `run_skill` |
| `src/ai/agent.js` | Modify | 若需把 user 文本传入 skills fragment（见 Task 6） |
| `src/preload.js` | Modify | `testMcpServer` |
| `src/renderer/*` | Modify | 列表 UI |
| `README.md` | Modify | Phase C.5 |
| `tests/mcp-config.test.js` 等 | Create/Modify | 见各 Task |

---

### Task 1: mcp-config sanitize + main 接线

**Files:**
- Create: `src/ai/mcp-config.js`
- Modify: `src/main.js`（替换内联 `sanitizeMcpServers`）
- Create: `tests/mcp-config.test.js`

**Interfaces:**
- Produces: `sanitizeMcpServers(raw) → object[]`；`inferTransport(item) → 'stdio'|'sse'|'http'`

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeMcpServers, inferTransport } = require('../src/ai/mcp-config');

describe('mcp-config', () => {
  it('legacy command-only becomes stdio', () => {
    const out = sanitizeMcpServers([
      { name: 'fs', command: 'npx', args: ['-y', 'x'] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].transport, 'stdio');
    assert.equal(out[0].enabled, true);
    assert.equal(out[0].command, 'npx');
  });

  it('accepts http url transport', () => {
    const out = sanitizeMcpServers([
      { name: 'r', transport: 'http', url: 'https://example.com/mcp' },
    ]);
    assert.equal(out[0].transport, 'http');
    assert.equal(out[0].url, 'https://example.com/mcp');
  });

  it('rejects non-http url and missing command for stdio', () => {
    assert.deepEqual(sanitizeMcpServers([
      { name: 'bad', transport: 'http', url: 'file:///etc/passwd' },
      { name: 'ncmd', transport: 'stdio' },
    ]), []);
  });

  it('enabled false preserved; duplicate names keep first', () => {
    const out = sanitizeMcpServers([
      { name: 'a', command: 'c1', enabled: false },
      { name: 'a', command: 'c2' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].enabled, false);
    assert.equal(out[0].command, 'c1');
  });

  it('inferTransport', () => {
    assert.equal(inferTransport({ command: 'x' }), 'stdio');
    assert.equal(inferTransport({ url: 'https://a' }), 'http');
    assert.equal(inferTransport({ transport: 'sse', url: 'https://a' }), 'sse');
  });
});
```

- [ ] **Step 2: Run → FAIL**（module missing）

Run: `node --test tests/mcp-config.test.js`

- [ ] **Step 3: 实现 `src/ai/mcp-config.js`**

```js
'use strict';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HEADER_KEY_MAX = 128;
const HEADER_VAL_MAX = 4 * 1024;

function clampTimeoutMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60000;
  return Math.max(1000, Math.min(300000, Math.floor(n)));
}

function inferTransport(item) {
  const t = String(item?.transport || '').toLowerCase();
  if (t === 'stdio' || t === 'sse' || t === 'http') return t;
  if (item?.command) return 'stdio';
  if (item?.url) return 'http';
  return 'stdio';
}

function sanitizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim().slice(0, HEADER_KEY_MAX);
    if (!key) continue;
    out[key] = String(v ?? '').slice(0, HEADER_VAL_MAX);
  }
  return Object.keys(out).length ? out : undefined;
}

function isHttpUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function sanitizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const transport = inferTransport(item);
    const enabled = item.enabled === false ? false : true;
    const timeoutMs = clampTimeoutMs(item.timeoutMs);

    if (transport === 'stdio') {
      const command = String(item.command || '').trim();
      if (!command) continue;
      const entry = { name, transport: 'stdio', enabled, command, timeoutMs };
      if (Array.isArray(item.args)) entry.args = item.args.map(String);
      if (item.env && typeof item.env === 'object' && !Array.isArray(item.env)) {
        entry.env = { ...item.env };
      }
      if (item.cwd) entry.cwd = String(item.cwd);
      seen.add(name);
      out.push(entry);
      continue;
    }

    // sse | http
    const url = String(item.url || '').trim();
    if (!isHttpUrl(url)) continue;
    const entry = { name, transport, enabled, url, timeoutMs };
    const headers = sanitizeHeaders(item.headers);
    if (headers) entry.headers = headers;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

module.exports = {
  sanitizeMcpServers,
  inferTransport,
  clampTimeoutMs,
  isHttpUrl,
};
```

- [ ] **Step 4: main.js** — `const { sanitizeMcpServers } = require('./ai/mcp-config');` 删除本地函数副本。

- [ ] **Step 5: 测试通过 + commit**

```bash
node --test tests/mcp-config.test.js
git add src/ai/mcp-config.js src/main.js tests/mcp-config.test.js
git commit -m "feat(codex-qq): Phase C.5 mcp-config sanitize multi-transport"
```

---

### Task 2: stdio client resources + createMcpClient factory

**Files:**
- Modify: `src/ai/mcp-client.js`
- Modify: `tests/mcp-client.test.js`

**Interfaces:**
- `createMcpClient(opts)`：若 `opts.transport === 'http'|'sse'` 委托后续模块；默认/`stdio` 走现实现
- 增加 `listResources()` / `readResource(uri)`：`resources/list` / `resources/read`；失败或无能力返回 `[]` / throw 由 hub 捕获

- [ ] **Step 1: 扩展 stdio 测试**（mock spawn 响应 `resources/list`）

```js
// 在现有 createMcpClient mock 测试中增加 tools/list 后 listResources 分支
// method === 'resources/list' → { resources: [{ uri: 'file://a', name: 'a' }] }
// method === 'resources/read' → { contents: [{ text: 'hi' }] }
```

- [ ] **Step 2: 实现 listResources/readResource + factory 入口**

```js
// mcp-client.js 末尾工厂：
function createMcpClient(opts = {}) {
  const transport = String(opts.transport || 'stdio').toLowerCase();
  if (transport === 'http') {
    return require('./mcp-http').createMcpHttpClient(opts);
  }
  if (transport === 'sse') {
    return require('./mcp-sse').createMcpSseClient(opts);
  }
  return createMcpStdioClient(opts); // rename existing body
}

async function listResources() {
  try {
    const result = await request('resources/list', {});
    if (Array.isArray(result?.resources)) return result.resources;
    return [];
  } catch {
    return [];
  }
}

async function readResource(uri) {
  return request('resources/read', { uri: String(uri || '') });
}
// export listResources, readResource on client object
```

在 Task 2 阶段：http/sse 文件可先 **stub** 抛 `Error('not implemented')` 并在 Task 3/4 填充——**更干净：Task 2 仅 stdio 扩展 + factory 仅 stdio，Task 3 加 http 分支**。

**本任务选定：** factory 仅处理 stdio（现逻辑）；`listResources`/`readResource` 加在 stdio client；export 不变 `createMcpClient`。

- [ ] **Step 3: 测试绿 + commit**

```bash
node --test tests/mcp-client.test.js
git commit -m "feat(codex-qq): Phase C.5 stdio MCP resources/list and read"
```

---

### Task 3: Streamable HTTP client

**Files:**
- Create: `src/ai/mcp-http.js`
- Create: `tests/mcp-http.test.js`
- Modify: `src/ai/mcp-client.js` factory 委托 http

**Interfaces:**
- `createMcpHttpClient({ url, headers?, timeoutMs?, requestFn? })`
- `requestFn(url, { method, headers, body, signal }) → Promise<{ status, headers, bodyText }>` 可注入；默认用 `http`/`https.request`

**协议（最小）：**

1. `start()`: POST JSON-RPC `initialize`；解析 JSON body 或 `text/event-stream` 中 data 行 JSON；成功后可选 POST `notifications/initialized`（notification 可无 id）。  
2. `listTools` / `callTool` / `listResources` / `readResource`：同上 POST。  
3. 每请求带 headers；`Accept: application/json, text/event-stream`。  
4. 超时与 abort。

- [ ] **Step 1: 测试用注入 requestFn**

```js
it('initialize + listTools via mock requestFn', async () => {
  const calls = [];
  const requestFn = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const msg = JSON.parse(opts.body);
    if (msg.method === 'initialize') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'h' } },
        }),
      };
    }
    if (msg.method === 'tools/list') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] },
        }),
      };
    }
    if (msg.method === 'notifications/initialized') {
      return { status: 202, headers: {}, bodyText: '' };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }),
    };
  };
  const c = createMcpHttpClient({ url: 'https://example.com/mcp', requestFn });
  await c.start();
  const tools = await c.listTools();
  assert.equal(tools[0].name, 'ping');
  await c.close();
});
```

- [ ] **Step 2: 实现 mcp-http.js**（完整可读实现：id 递增、parseSseOrJson helper、close 置位）

- [ ] **Step 3: factory 接线 + commit**

```bash
git commit -m "feat(codex-qq): Phase C.5 streamable HTTP MCP client"
```

---

### Task 4: SSE client

**Files:**
- Create: `src/ai/mcp-sse.js`
- Create: `tests/mcp-sse.test.js`
- Modify: `src/ai/mcp-client.js` factory

**协议（本项目最小契约，测试锁定）：**

- 配置 `url` 为 **消息 POST 端点**。  
- 可选 `opts.sseUrl`：若缺省，用 `url` 将 path 末段换为常见形态或 **同 url GET** 建立 SSE（实现选：**单独 `sseUrl` 可选；缺省 `url + ''` 且 GET `url` with Accept text/event-stream 拿 endpoint 通知**——过复杂则简化为）：  

**简化锁定（实现必须遵守）：**

1. `start()`: GET `url` with `Accept: text/event-stream`（注入 `openSseFn` 可测）→ 解析 event `endpoint` 的 data 为 POST 路径（绝对或相对 url）；若无 endpoint 事件，**POST 直接打同一 `url`**。  
2. 后续 JSON-RPC 与 http 客户端相同 POST。  
3. 测试：`openSseFn` 立即推送 `event: endpoint\ndata: https://example.com/message\n\n`，`requestFn` 处理 POST。

- [ ] **Step 1–4: TDD 实现 + factory + commit**

```bash
git commit -m "feat(codex-qq): Phase C.5 SSE MCP client"
```

---

### Task 5: mcp-hub resources + 固定工具 + provider

**Files:**
- Modify: `src/ai/mcp-hub.js`
- Modify: `src/ai/providers/mcp.js`（若 defs 从 hub 出则可能只改 hub）
- Modify: `tests/mcp-hub.test.js`

**Interfaces:**
- `startAll`：跳过 `enabled === false`；`createClient` 传入完整 cfg（含 transport）
- 连接成功后 `listResources` 缓存 `resourcesByServer: Map<name, array>`
- `getToolDefs()`：动态 mcp tools + 若 **任一 server 已连接** 则附加：

```js
{
  type: 'function',
  function: {
    name: 'mcp_resources_list',
    description: 'List MCP resources from connected servers',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string' } },
    },
  },
},
{
  type: 'function',
  function: {
    name: 'mcp_resource_read',
    description: 'Read one MCP resource by server name and uri',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        uri: { type: 'string' },
      },
      required: ['server', 'uri'],
    },
  },
}
```

- `call(fullName, args)`：若 name 为资源工具则分支处理；动态工具名不得注册为这两个保留名

- [ ] **Step 1: 测试**

```js
it('skips disabled servers', async () => { /* mock createClient never called for disabled */ });
it('registers resource tools when connected', async () => { /* getToolDefs names include mcp_resources_list */ });
it('mcp_resource_read returns truncated content', async () => { /* */ });
```

- [ ] **Step 2: 实现 hub**

`createClient` 默认：

```js
(cfg) => createMcpClient({ ...cfg, transport: cfg.transport || 'stdio' })
```

- [ ] **Step 3: commit**

```bash
git commit -m "feat(codex-qq): Phase C.5 MCP hub resources and enabled flag"
```

---

### Task 6: Skills loader + run_skill + triggers fragment

**Files:**
- Modify: `src/ai/skills-loader.js`
- Modify: `src/ai/providers/skills.js`
- Modify: `src/ai/permission.js` — `WRITE_TOOLS` add `run_skill`
- Modify: `src/ai/agent-mode.js` — `PLAN_HIDDEN_TOOLS` add `run_skill`
- Modify: `tests/skills-loader.test.js`
- Create: `tests/skills-run.test.js`（或扩 provider 测）
- Modify: `tests/permission.test.js` / `tests/agent-mode.test.js`

**Interfaces:**
- `SkillMeta` 增加：`triggers: string[]`, `command?: string`, `args?: string[]`, `timeoutMs?: number`, `cwdMode?: string`（project|skill|relative）
- `matchSkillsByTriggers(catalog, userText) → SkillMeta[]` 最多 5
- `run_skill` execute：resolve cwd、spawn、返回 JSON

**skills-loader 解析要点：**

```js
function parseTriggers(raw) {
  if (!raw) return [];
  return String(raw).split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20)
    .map((s) => s.slice(0, 64));
}
function parseArgsField(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a.map(String) : [];
    } catch { return []; }
  }
  return [];
}
// discover 时写入 meta.triggers, meta.command, meta.skillArgs, meta.timeoutMs, meta.cwdKind
```

**run_skill cwd：**

```js
function resolveSkillCwd(meta, projectPath) {
  const kind = meta.cwdKind || 'project';
  if (kind === 'skill') return meta.dir;
  if (kind === 'project' || !kind) return projectPath;
  // relative under project
  const path = require('path');
  const resolved = path.resolve(projectPath, kind);
  if (!resolved.startsWith(path.resolve(projectPath))) throw new Error('cwd 越界');
  return resolved;
}
```

**getSystemFragment：** 在 catalog 摘要后，若 `ctx.extensions?.userPromptText` 或从 `ctx.messages` 取最后 user 文本：

```js
const matched = matchSkillsByTriggers(catalog, userText);
if (matched.length) {
  parts.push('【Skills 自动匹配】下列技能与当前用户消息相关，请优先 use_skill 加载全文后再执行；可执行技能用 run_skill，勿臆造步骤。');
  for (const s of matched) {
    parts.push(`- ${s.name}: ${String(s.description||'').slice(0,80)} (triggers: ${s.triggers.slice(0,5).join(', ')})`);
  }
}
```

**agent.js：** 在构建 system / collectTools 前设置  
`ctx.extensions.userPromptText = extractLastUserText(messages)`（实现小函数）。

**run_skill spawn：** 注入 `spawnFn` 可测；默认 `child_process.spawn`；`shell: false`。

- [ ] **Step 1–5: TDD + commit**

```bash
git commit -m "feat(codex-qq): Phase C.5 run_skill and trigger routing"
```

---

### Task 7: mcp:testServer IPC + 设置列表 UI

**Files:**
- Modify: `src/main.js` — `ipcMain.handle('mcp:testServer', …)`
- Modify: `src/preload.js` — `testMcpServer: (cfg) => ipcRenderer.invoke('mcp:testServer', cfg)`
- Modify: `src/renderer/index.html` — 列表容器替换/增强 textarea
- Modify: `src/renderer/app.js` — 列表模型、增删、测试、保存序列化
- Modify: `src/renderer/styles.css` — 紧凑列表样式

**testServer 实现：**

```js
ipcMain.handle('mcp:testServer', async (_e, rawCfg) => {
  const list = sanitizeMcpServers([rawCfg]);
  if (!list.length) return { ok: false, error: '无效配置' };
  const cfg = list[0];
  const { createMcpClient } = require('./ai/mcp-client');
  const client = createMcpClient({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs || 15000, 15000) });
  try {
    await client.start();
    const tools = await client.listTools();
    let resourcesCount = 0;
    try {
      const res = await client.listResources();
      resourcesCount = Array.isArray(res) ? res.length : 0;
    } catch { /* ignore */ }
    await client.close();
    return { ok: true, toolsCount: tools.length, resourcesCount, transport: cfg.transport };
  } catch (err) {
    try { await client.close(); } catch { /* */ }
    return { ok: false, error: err.message || String(err), transport: cfg.transport };
  }
});
```

**UI 最小行为：**

- 打开设置：从 `settings.mcpServers` 填列表  
- 每行：enabled、name、transport select、command 或 url、测试、删除  
- 添加：push 默认 stdio 空行  
- 保存：`mcpServers: serializeList()` 经 main sanitize  
- 导入 JSON：prompt/textarea 一次 parse → sanitize → 替换列表  

- [ ] **Step 1: 实现 UI + IPC**  
- [ ] **Step 2: `node --check` renderer/main**  
- [ ] **Step 3: commit**

```bash
git commit -m "feat(codex-qq): Phase C.5 MCP server list UI and test connection"
```

---

### Task 8: README + 全量测试

**Files:**
- Modify: `README.md`
- 回归 `npm test`

**README 要点（zh-CN）：**

- 三传输与配置字段  
- `mcp_resources_list` / `mcp_resource_read`  
- `run_skill`、triggers、风险（远程 URL、可执行命令）  
- 设置列表 + 测试连接  
- 无 OAuth / prompts  

- [ ] **Step 1: 写 README**  
- [ ] **Step 2: `npm test` 全绿；修回归**  
- [ ] **Step 3: commit**

```bash
git commit -m "docs(codex-qq): Phase C.5 MCP and Skills usage in README"
```

---

## Self-review (plan vs spec)

| Spec 项 | Task |
|---------|------|
| sanitize 多传输 | T1 |
| stdio resources | T2 |
| HTTP | T3 |
| SSE | T4 |
| hub enabled + resource tools | T5 |
| run_skill + triggers | T6 |
| 列表 UI + testServer | T7 |
| README + 全测 | T8 |
| 无新依赖 / plan 隐藏 / depth 门闩 | T5–T6 约束 + 测试 |

无 TBD 阻断；SSE endpoint 简化契约已在 Task 4 锁定。

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-phase-c5-mcp-skills.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每任务独立 subagent + review  
2. **Inline Execution** — 本会话连续执行  

**Which approach?**
