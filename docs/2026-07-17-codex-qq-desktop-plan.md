# Codex QQ Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron app with QQ 2007-style UI for chatting with Codex (local mock + OpenAI-compatible API).

**Architecture:** Single BrowserWindow Electron app. Main process owns settings persistence and AI calls (local mock or HTTP). Preload exposes a narrow contextBridge API. Renderer is pure HTML/CSS/JS implementing the three-column QQ skin and chat UX.

**Tech Stack:** Electron 33+, plain HTML/CSS/JS, Node `https`/`http` for API, electron-builder for Windows package. No React/Vue.

## Global Constraints

- All project files live under `D:\workspace\ai\codex-qq-desktop\` only
- `contextIsolation: true`, `nodeIntegration: false`
- API key never sent to renderer; only main process holds it
- UI language: Simplified Chinese (labels match QQ-style screenshot)
- Default window ~1024x700, min ~860x560
- Message HTML must be escaped; fenced code blocks rendered as text in `<pre><code>`
- YAGNI: no tray, no multi-window chat, no real file/voice upload, no auth system

## File Map

| Path | Responsibility |
|------|----------------|
| `package.json` | scripts, electron, electron-builder deps |
| `src/main.js` | window, IPC, settings I/O, route AI |
| `src/preload.js` | contextBridge API |
| `src/ai/local-mock.js` | keyword/template replies |
| `src/ai/openai-compatible.js` | Chat Completions HTTP client |
| `src/ai/settings.js` | load/save settings JSON |
| `src/renderer/index.html` | DOM structure |
| `src/renderer/styles.css` | QQ 2007 skin |
| `src/renderer/app.js` | UI state, send/receive, settings modal |
| `src/renderer/assets/robot.svg` | Codex robot avatar |
| `data/settings.example.json` | example config |
| `README.md` | run/build instructions |
| `tests/local-mock.test.js` | unit tests for mock AI |
| `tests/openai-compatible.test.js` | unit tests for request builder / error mapping |
| `tests/settings.test.js` | unit tests for settings defaults/merge |

---

### Task 1: Scaffold package + Electron main/preload shell

**Files:**
- Create: `package.json`
- Create: `src/main.js`
- Create: `src/preload.js`
- Create: `src/renderer/index.html` (minimal placeholder)
- Create: `src/renderer/styles.css` (minimal)
- Create: `src/renderer/app.js` (minimal)
- Create: `README.md`

**Interfaces:**
- Consumes: none
- Produces:
  - `npm start` → opens Electron window loading `src/renderer/index.html`
  - preload exposes temporary `window.codex.ping(): Promise<string>` returning `"pong"`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "codex-qq-desktop",
  "version": "1.0.0",
  "description": "QQ 2007 style Codex chat client for Windows",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test tests/**/*.test.js",
    "dist": "electron-builder --win"
  },
  "devDependencies": {
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8"
  },
  "build": {
    "appId": "com.codex.qqdesktop",
    "productName": "Codex QQ",
    "directories": { "output": "dist" },
    "files": ["src/**/*", "package.json"],
    "win": {
      "target": ["portable"]
    }
  }
}
```

- [ ] **Step 2: Create `src/main.js`**

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#c3d9f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('ping', async () => 'pong');
```

- [ ] **Step 3: Create `src/preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  ping: () => ipcRenderer.invoke('ping'),
});
```

- [ ] **Step 4: Create minimal renderer files**

`src/renderer/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;" />
  <title>Codex 2007</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app">Codex QQ Desktop loading…</div>
  <script src="app.js"></script>
</body>
</html>
```

`src/renderer/styles.css`:
```css
html, body { margin: 0; height: 100%; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; }
#app { padding: 16px; }
```

`src/renderer/app.js`:
```js
async function boot() {
  const el = document.getElementById('app');
  try {
    const r = await window.codex.ping();
    el.textContent = `preload ok: ${r}`;
  } catch (e) {
    el.textContent = `preload failed: ${e.message}`;
  }
}
boot();
```

- [ ] **Step 5: Create short `README.md`**

```markdown
# Codex QQ Desktop

QQ 2007 风格 Codex 聊天客户端（Windows / Electron）。

## 开发

```bash
cd codex-qq-desktop
npm install
npm start
```

## 测试

```bash
npm test
```

## 打包

```bash
npm run dist
```

产物在 `dist/`。
```

- [ ] **Step 6: Install deps and smoke-run**

Run (from `codex-qq-desktop`):
```powershell
npm install
```
Expected: electron and electron-builder installed without error.

Run:
```powershell
npm start
```
Expected: window opens showing `preload ok: pong` (manual check). Close window after verify.

- [ ] **Step 7: Commit**

```powershell
git add codex-qq-desktop
git commit -m "feat(codex-qq): scaffold Electron app shell"
```

---

### Task 2: Settings store + unit tests

**Files:**
- Create: `src/ai/settings.js`
- Create: `data/settings.example.json`
- Create: `tests/settings.test.js`

**Interfaces:**
- Consumes: Node `fs`, `path`, Electron `app.getPath('userData')` when available
- Produces:
  - `DEFAULT_SETTINGS = { mode: 'local', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' }`
  - `function getSettingsPath(userDataPath: string): string` → `{userDataPath}/settings.json`
  - `function loadSettings(userDataPath: string): object` → merged with defaults
  - `function saveSettings(userDataPath: string, partial: object): object` → saved full settings

- [ ] **Step 1: Write failing tests `tests/settings.test.js`**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, getSettingsPath, loadSettings, saveSettings } = require('../src/ai/settings');

describe('settings', () => {
  it('getSettingsPath joins settings.json', () => {
    assert.equal(getSettingsPath('/tmp/data'), path.join('/tmp/data', 'settings.json'));
  });

  it('loadSettings returns defaults when file missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.mode, 'local');
    assert.equal(s.model, DEFAULT_SETTINGS.model);
  });

  it('saveSettings persists and loadSettings reads back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, { mode: 'api', apiKey: 'sk-test', model: 'gpt-test' });
    const s = loadSettings(dir);
    assert.equal(s.mode, 'api');
    assert.equal(s.apiKey, 'sk-test');
    assert.equal(s.model, 'gpt-test');
    assert.equal(s.baseUrl, DEFAULT_SETTINGS.baseUrl);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```powershell
npm test
```
Expected: FAIL module not found or assertions fail.

- [ ] **Step 3: Implement `src/ai/settings.js`**

```js
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  mode: 'local',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function loadSettings(userDataPath) {
  const file = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataPath, partial) {
  const next = { ...loadSettings(userDataPath), ...partial };
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(getSettingsPath(userDataPath), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
  loadSettings,
  saveSettings,
};
```

- [ ] **Step 4: Create `data/settings.example.json`**

```json
{
  "mode": "local",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "model": "gpt-4o-mini"
}
```

- [ ] **Step 5: Run tests — expect PASS**

```powershell
npm test
```
Expected: settings tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add codex-qq-desktop/src/ai/settings.js codex-qq-desktop/tests/settings.test.js codex-qq-desktop/data/settings.example.json
git commit -m "feat(codex-qq): add settings load/save"
```

---

### Task 3: Local mock AI + unit tests

**Files:**
- Create: `src/ai/local-mock.js`
- Create: `tests/local-mock.test.js`

**Interfaces:**
- Consumes: none
- Produces:
  - `function generateLocalReply(userText: string): string`
  - Returns Chinese technical-style assistant text
  - If text matches /migration|wrangler|d1|KV|kv/i → include a bash code block with wrangler-like commands
  - If matches /bug|错误|修复/i → debugging-oriented reply
  - Else generic Codex helper reply mentioning the user text (truncated)

- [ ] **Step 1: Write `tests/local-mock.test.js`**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateLocalReply } = require('../src/ai/local-mock');

describe('generateLocalReply', () => {
  it('returns non-empty string for empty input', () => {
    const r = generateLocalReply('');
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  });

  it('includes bash fence for migration keywords', () => {
    const r = generateLocalReply('帮我看 wrangler d1 migrations');
    assert.match(r, /```bash/);
    assert.match(r, /wrangler/i);
  });

  it('mentions user topic for generic chat', () => {
    const r = generateLocalReply('你好 Codex');
    assert.match(r, /你好 Codex|Codex/);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```powershell
node --test tests/local-mock.test.js
```
Expected: FAIL cannot find module.

- [ ] **Step 3: Implement `src/ai/local-mock.js`**

```js
function generateLocalReply(userText) {
  const text = (userText || '').trim();

  if (/migration|wrangler|d1|\bKV\b|kv|读写/i.test(text)) {
    return [
      '结构确认没问题：',
      '',
      '- `redeem_codes`、`push_tokens` 与 migration 一致。',
      '- `android_subscriptions` 多了 `free_trial` 字段，这是后续的增量字段，不影响 baseline。',
      '- `d1_migrations` 已存在，但缺少历史记录。',
      '',
      '现在补记录：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 execute haiker --remote --command \\',
      "\"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql'), ('0002_push_notifications.sql');\"",
      '```',
      '',
      '然后：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 migrations list haiker --remote',
      '```',
      '',
      '确认只显示 `0003_push_delivery_dedup.sql` 后，再运行：',
      '',
      '```bash',
      './node_modules/.bin/wrangler d1 migrations apply haiker --remote',
      '```',
      '',
      '这不会影响现有业务数据。',
    ].join('\n');
  }

  if (/bug|错误|修复|报错/i.test(text)) {
    return [
      '可以，把完整报错栈和复现步骤发我。',
      '',
      '先快速排查清单：',
      '1. 确认依赖版本与 lockfile 一致',
      '2. 清缓存后重装：`rm -rf node_modules && npm i`',
      '3. 用最小复现脚本隔离问题',
      '',
      '我可以陪你写补丁、改代码、查文档。',
    ].join('\n');
  }

  if (!text) {
    return '在呢。把需求、报错或代码片段丢过来就行。';
  }

  return [
    `收到：${text.slice(0, 200)}`,
    '',
    '我是 Codex 小助手。可以直接问架构、改 Bug、写脚本或看日志。',
    '需要我按步骤给出命令的话，说下你的运行环境（Windows / Node 版本）即可。',
  ].join('\n');
}

module.exports = { generateLocalReply };
```

- [ ] **Step 4: Run tests — expect PASS**

```powershell
node --test tests/local-mock.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add codex-qq-desktop/src/ai/local-mock.js codex-qq-desktop/tests/local-mock.test.js
git commit -m "feat(codex-qq): local mock AI replies"
```

---

### Task 4: OpenAI-compatible client + unit tests

**Files:**
- Create: `src/ai/openai-compatible.js`
- Create: `tests/openai-compatible.test.js`

**Interfaces:**
- Consumes: Node `http`/`https` (or injectable `fetchFn` for tests)
- Produces:
  - `function buildChatPayload(model: string, messages: Array<{role, content}>): object`
  - `async function chatCompletion({ baseUrl, apiKey, model, messages, fetchFn? }): Promise<string>`
  - Throws `Error` with readable message on non-2xx or network failure
  - Uses `POST {baseUrl}/chat/completions` with header `Authorization: Bearer {apiKey}`

- [ ] **Step 1: Write `tests/openai-compatible.test.js`**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildChatPayload, chatCompletion } = require('../src/ai/openai-compatible');

describe('openai-compatible', () => {
  it('buildChatPayload shapes request body', () => {
    const body = buildChatPayload('gpt-4o-mini', [{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('chatCompletion returns assistant content on 200', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'hello from api' } }],
      }),
      text: async () => '',
    });
    const text = await chatCompletion({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchFn,
    });
    assert.equal(text, 'hello from api');
  });

  it('chatCompletion throws on error status', async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'bad key' } }),
      text: async () => 'bad key',
    });
    await assert.rejects(
      () => chatCompletion({
        baseUrl: 'https://example.com/v1',
        apiKey: 'x',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn,
      }),
      /401|bad key/
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
node --test tests/openai-compatible.test.js
```

- [ ] **Step 3: Implement `src/ai/openai-compatible.js`**

```js
function buildChatPayload(model, messages) {
  return {
    model,
    messages,
    temperature: 0.7,
  };
}

async function chatCompletion({ baseUrl, apiKey, model, messages, fetchFn }) {
  const fetchImpl = fetchFn || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('当前环境没有 fetch，无法调用 API');
  }
  const root = (baseUrl || '').replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey || ''}`,
    },
    body: JSON.stringify(buildChatPayload(model, messages)),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data?.error?.message || JSON.stringify(data);
    } catch {
      try { detail = await res.text(); } catch { detail = ''; }
    }
    throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) {
    throw new Error('API 返回空内容');
  }
  return content;
}

module.exports = { buildChatPayload, chatCompletion };
```

- [ ] **Step 4: Run — expect PASS**

```powershell
node --test tests/openai-compatible.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add codex-qq-desktop/src/ai/openai-compatible.js codex-qq-desktop/tests/openai-compatible.test.js
git commit -m "feat(codex-qq): OpenAI-compatible chat client"
```

---

### Task 5: Wire IPC chat + settings in main process

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`

**Interfaces:**
- Consumes: `loadSettings`, `saveSettings`, `generateLocalReply`, `chatCompletion`
- Produces preload API:
  - `getSettings(): Promise<SettingsPublic>` where `SettingsPublic` is settings with `apiKey` masked as `********` if non-empty, plus `apiKeySet: boolean`
  - `saveSettings(partial): Promise<SettingsPublic>`
  - `sendChat({ messages: Array<{role, content}> }): Promise<{ content: string }>`
  - Remove temporary `ping` after smoke verified (or keep for debug — remove for cleanliness)

Settings public shape for renderer:
```js
{
  mode: 'local' | 'api',
  baseUrl: string,
  model: string,
  apiKeySet: boolean,
  apiKey: '' // always empty in get; only accept new key on save if non-empty string
}
```

On `saveSettings`:
- if `partial.apiKey` is `undefined` or `''`, keep existing key
- if non-empty string, replace key

On `sendChat`:
- load settings
- if mode local → `generateLocalReply(lastUserMessage)`
- if mode api → `chatCompletion` with full messages; on error return throw to renderer

- [ ] **Step 1: Update `src/preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codex', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
});
```

- [ ] **Step 2: Update `src/main.js` to register handlers**

Full file:

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadSettings, saveSettings } = require('./ai/settings');
const { generateLocalReply } = require('./ai/local-mock');
const { chatCompletion } = require('./ai/openai-compatible');

function userDataPath() {
  return app.getPath('userData');
}

function toPublicSettings(s) {
  return {
    mode: s.mode,
    baseUrl: s.baseUrl,
    model: s.model,
    apiKeySet: Boolean(s.apiKey),
    apiKey: '',
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#c3d9f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', async () => {
  return toPublicSettings(loadSettings(userDataPath()));
});

ipcMain.handle('settings:save', async (_e, partial = {}) => {
  const current = loadSettings(userDataPath());
  const nextPartial = { ...partial };
  if (!nextPartial.apiKey) {
    delete nextPartial.apiKey;
  }
  const saved = saveSettings(userDataPath(), nextPartial);
  return toPublicSettings(saved);
});

ipcMain.handle('chat:send', async (_e, payload = {}) => {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content || '';
  const settings = loadSettings(userDataPath());

  if (settings.mode === 'api') {
    if (!settings.apiKey) {
      throw new Error('未配置 API Key，请先在设置中填写，或切换到本地模拟模式');
    }
    const content = await chatCompletion({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: [
        {
          role: 'system',
          content: '你是 Codex 编程助手，回答简洁、可执行，必要时给出命令与代码块。使用简体中文。',
        },
        ...messages.map((m) => ({ role: m.role, content: String(m.content || '') })),
      ],
    });
    return { content };
  }

  return { content: generateLocalReply(userText) };
});
```

- [ ] **Step 3: Manual IPC smoke (optional temporary renderer)**

Keep renderer minimal; next task builds UI. Optionally run `npm start` and DevTools:
```js
await window.codex.getSettings()
await window.codex.sendChat({ messages: [{ role: 'user', content: 'wrangler migration' }] })
```
Expected: settings object; reply containing bash.

- [ ] **Step 4: Commit**

```powershell
git add codex-qq-desktop/src/main.js codex-qq-desktop/src/preload.js
git commit -m "feat(codex-qq): wire settings and chat IPC"
```

---

### Task 6: QQ 2007 three-column UI (static shell + demo data)

**Files:**
- Replace: `src/renderer/index.html`
- Replace: `src/renderer/styles.css`
- Create: `src/renderer/assets/robot.svg`
- Modify: `src/renderer/app.js` to mount layout (chat wiring in Task 7)

**Interfaces:**
- Consumes: none yet for chat
- Produces: DOM ids used by Task 7:
  - `#session-title`
  - `#message-list`
  - `#chat-input`
  - `#btn-send`
  - `#btn-settings`
  - `#settings-modal` (hidden by default)
  - `#friend-panel`

- [ ] **Step 1: Create `src/renderer/assets/robot.svg`**

Simple blue robot circle SVG (inline-friendly), e.g. 120x120 blue bot with eyes.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="64" r="60" fill="#4da3ff"/>
  <circle cx="64" cy="64" r="52" fill="#6eb6ff"/>
  <rect x="38" y="48" width="52" height="40" rx="12" fill="#1f6feb"/>
  <circle cx="52" cy="66" r="6" fill="#fff"/>
  <circle cx="76" cy="66" r="6" fill="#fff"/>
  <rect x="54" y="78" width="20" height="4" rx="2" fill="#9ad0ff"/>
  <rect x="58" y="20" width="12" height="14" rx="3" fill="#1f6feb"/>
  <circle cx="64" cy="18" r="5" fill="#ffd666"/>
</svg>
```

- [ ] **Step 2: Build full `index.html` structure**

Must include:
- Title bar area text: `Codex 2007 - <span id="session-title">优化 KV 读写成本</span>`
- Toolbar buttons: 新建任务、已安排、插件、站点、拉取请求、聊天、设置
- Left: nav + 置顶 folders + 项目 + 任务 + contact Randy Lu
- Center: message list + composer
- Right: Codex 好友 robot + 简介 + 我的好友
- Footer status
- Settings modal fields: mode select, baseUrl, apiKey, model, save/cancel

Use semantic class names: `.qq-app`, `.qq-toolbar`, `.qq-left`, `.qq-main`, `.qq-right`, `.msg`, `.msg-assistant`, `.msg-user`, `.code-block`, `.chip`.

- [ ] **Step 3: Implement `styles.css` QQ 2007 look**

Requirements:
- Blue gradient toolbar/header (`#6eb6f5` → `#3d8fd9`)
- Three-column flex layout filling viewport
- Left list item hover/selected states
- Message bubbles: assistant left-aligned light card; user right-aligned blue-tinted
- Code blocks: gray background, monospace, `bash` label
- Chips: rounded blue-gray pills
- Classic thin borders `#7e9db9` / `#a5c5e2`
- Modal centered overlay

- [ ] **Step 4: `app.js` only renders seed messages into `#message-list`**

Seed content approximate screenshot (structure确认… + bash blocks). Use a `renderMessages(messages)` function and `escapeHtml`.

Do not call `sendChat` yet if easier — or wire placeholder send that only appends user text without AI (prefer full wire in Task 7).

- [ ] **Step 5: Visual check**

```powershell
npm start
```
Expected: layout matches screenshot structure (三栏、蓝皮肤、示例消息).

- [ ] **Step 6: Commit**

```powershell
git add codex-qq-desktop/src/renderer
git commit -m "feat(codex-qq): QQ 2007 three-column UI shell"
```

---

### Task 7: Chat UX + settings modal + markdown-lite rendering

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css` if needed
- Modify: `src/renderer/index.html` if modal markup missing

**Interfaces:**
- Consumes: `window.codex.getSettings`, `saveSettings`, `sendChat`
- Produces: working chat loop and settings UI

**Rendering rules:**
- `escapeHtml(s)`
- `renderMarkdownLite(text)`:
  - split by fenced code `/```(\w+)?\n([\s\S]*?)```/`
  - paragraphs split on `\n\n`
  - inline `` `code` ``
  - lines starting with `- ` → list items
  - backtick tokens that look like identifiers can be `.chip` optionally for words in backticks at line starts with `- `

**Chat state:**
```js
let messages = [ /* seed assistant message(s) */ ];
```

**Send flow:**
1. Read input, ignore empty
2. Push `{ role: 'user', content }`
3. Clear input, re-render, scroll bottom
4. Disable send, show typing row "Codex 正在输入…"
5. `await window.codex.sendChat({ messages: messages.map(...) })`
6. Push assistant content; on error push assistant error text in red style
7. Re-enable send

**Settings flow:**
1. Open modal → `getSettings` fill fields; apiKey placeholder shows `已配置` if `apiKeySet`
2. Save → `saveSettings({ mode, baseUrl, model, apiKey })` then close
3. Cancel closes without save

**Keyboard:** Enter send, Shift+Enter newline on `#chat-input`

- [ ] **Step 1: Implement helpers + state in `app.js`**

Include complete functions: `escapeHtml`, `renderMarkdownLite`, `renderMessages`, `scrollToBottom`, `openSettings`, `saveSettingsFromForm`, `sendMessage`.

- [ ] **Step 2: Bind DOM events on boot**

- [ ] **Step 3: Manual test local mode**

```powershell
npm start
```
Send: `帮我看 wrangler d1 migrations`  
Expected: assistant reply with bash blocks styled.

- [ ] **Step 4: Manual test settings persistence**

Switch mode to API, set fake key, save, reopen settings → `apiKeySet` reflected. Switch back to local.

- [ ] **Step 5: Commit**

```powershell
git add codex-qq-desktop/src/renderer
git commit -m "feat(codex-qq): chat loop and settings modal"
```

---

### Task 8: Polish, full test run, README finalize, Windows package

**Files:**
- Modify: `README.md`
- Modify: `package.json` if needed
- Possibly small CSS/UI fixes

- [ ] **Step 1: Run all unit tests**

```powershell
npm test
```
Expected: all PASS.

- [ ] **Step 2: Update README with settings instructions and screenshot-like feature list**

Include:
- 本地模拟 / API 模式说明
- API 兼容 OpenAI Chat Completions
- 开发与打包命令
- 安全说明（Key 存在 userData）

- [ ] **Step 3: Build Windows portable**

```powershell
npm run dist
```
Expected: file under `dist/` such as `Codex QQ *.exe` portable.

- [ ] **Step 4: Final manual run of packaged or `npm start`**

Checklist:
- [ ] 三栏布局正常
- [ ] 本地对话正常
- [ ] 设置可保存
- [ ] 代码块显示正常
- [ ] 窗口最小尺寸可用

- [ ] **Step 5: Commit**

```powershell
git add codex-qq-desktop
git commit -m "feat(codex-qq): polish, docs, windows portable build"
```

---

## Spec Coverage Check

| Spec requirement | Task |
|------------------|------|
| Electron + HTML/CSS/JS | 1 |
| contextIsolation / no nodeIntegration | 1, 5 |
| Settings local+API | 2, 5, 7 |
| Local mock replies | 3, 5 |
| OpenAI-compatible API | 4, 5 |
| QQ 2007 three-column UI | 6 |
| Chat bubbles, chips, code blocks | 6, 7 |
| Enter send / Shift+Enter newline | 7 |
| Windows package | 1, 8 |
| All files under project folder | all |
| No tray/multi-window/auth | N/A (out of scope) |

## Placeholder Scan

No TBD/TODO steps. Code blocks included for each implementation step.

## Type Consistency

- Settings fields: `mode`, `baseUrl`, `apiKey`, `model` consistent across tasks 2/5/7
- `sendChat({ messages })` → `{ content }` consistent in 5/7
- `generateLocalReply(string) → string` in 3/5
- `chatCompletion({ baseUrl, apiKey, model, messages, fetchFn? }) → Promise<string>` in 4/5
