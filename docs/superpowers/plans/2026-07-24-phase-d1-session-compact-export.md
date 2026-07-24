# Phase D.1 Session Compact + Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付结构化会话压缩（compact）与 Markdown/JSON 导出；默认手动、可选自动；无新 npm 依赖。

**Architecture:** Renderer 持有 `sessions[].messages`（localStorage）。纯函数 `session-compact.js` / `session-export.js` 负责划分、token 启发、序列化；main 提供 `session:compact`（调模型或 local 占位摘要）与 `dialog:saveTextFile`；renderer 挂 `/compact`、`/export`、设置与 send 前自动检查。

**Tech Stack:** Electron 33、Node CommonJS、`node:test`、现有 `openai-compatible.chatCompletion`、无新依赖。

## Global Constraints

- 无新 npm 依赖（纯 Node CommonJS；token 用 char/4 启发）
- 用户可见文案 **zh-CN**
- `autoCompact` 默认 **false**
- `compactKeepMessages` 默认 **24**（clamp 6..80）
- `compactMaxMessages` 默认 **40**（clamp 20..200）
- `compactMaxApproxTokens` 默认 **24000**（clamp 4000..200000）
- 摘要消息：`role: 'assistant'`，`compact: true`，content 前缀 `【会话摘要 · 更早 N 条已压缩】`
- 活跃 `chatRun` / `sending` 时 **拒绝 compact**；export 仍允许
- 导出不得包含 `apiKey`
- Transcript 序列化总长上限约 **100_000** 字符；tool 行摘要 ≤200 字符
- local mode compact 不调外网，返回确定性占位摘要
- `npm test` 全绿

**Spec:** `docs/superpowers/specs/2026-07-24-phase-d1-session-compact-export-design.md`

---

## File map

| 路径 | 动作 | 职责 |
|------|------|------|
| `src/ai/settings.js` | Modify | compact 四项默认值 + clamp |
| `src/main.js` | Modify | toPublicSettings / save clamp；`session:compact`；`dialog:saveTextFile` |
| `src/ai/session-compact.js` | Create | plan/apply/transcript/token 纯函数 |
| `src/ai/session-export.js` | Create | md/json 序列化 |
| `src/preload.js` | Modify | `compactSession`、`saveTextFile` |
| `src/renderer/app.js` | Modify | 命令、按钮、设置、自动 compact、气泡 class |
| `src/renderer/index.html` | Modify | 设置项 + 工具栏按钮 |
| `src/renderer/styles.css` | Modify | `.msg-compact` |
| `tests/settings.test.js` | Modify | 默认与 clamp |
| `tests/session-compact.test.js` | Create | 纯函数 |
| `tests/session-export.test.js` | Create | 纯函数 |
| `README.md` | Modify | Phase D.1 |

---

### Task 1: settings — compact defaults + clamp

**Files:**
- Modify: `src/ai/settings.js`
- Modify: `tests/settings.test.js`
- Modify: `src/main.js`（`toPublicSettings` + `settings:save` 数字 clamp）

**Interfaces:**
- Produces: `DEFAULT_SETTINGS.autoCompact === false`；`compactKeepMessages === 24`；`compactMaxMessages === 40`；`compactMaxApproxTokens === 24000`；load/save clamp

- [ ] **Step 1: 写失败测试**

在 `tests/settings.test.js` 追加：

```js
it('defaults Phase D.1 compact settings', () => {
  const { DEFAULT_SETTINGS, loadSettings, saveSettings } = require('../src/ai/settings');
  assert.equal(DEFAULT_SETTINGS.autoCompact, false);
  assert.equal(DEFAULT_SETTINGS.compactKeepMessages, 24);
  assert.equal(DEFAULT_SETTINGS.compactMaxMessages, 40);
  assert.equal(DEFAULT_SETTINGS.compactMaxApproxTokens, 24000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  const s = loadSettings(dir);
  assert.equal(s.autoCompact, false);
  assert.equal(s.compactKeepMessages, 24);
  saveSettings(dir, { compactKeepMessages: 1, compactMaxMessages: 999, compactMaxApproxTokens: 100 });
  const s2 = loadSettings(dir);
  assert.equal(s2.compactKeepMessages, 6);
  assert.equal(s2.compactMaxMessages, 200);
  assert.equal(s2.compactMaxApproxTokens, 4000);
  saveSettings(dir, { autoCompact: true, compactKeepMessages: 50 });
  assert.equal(loadSettings(dir).autoCompact, true);
  assert.equal(loadSettings(dir).compactKeepMessages, 50);
});
```

- [ ] **Step 2: Run → FAIL**

Run: `node --test tests/settings.test.js`  
Expected: FAIL — defaults undefined

- [ ] **Step 3: 实现 settings.js**

```js
// DEFAULT_SETTINGS 增加
autoCompact: false,
compactKeepMessages: 24,
compactMaxMessages: 40,
compactMaxApproxTokens: 24000,

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampCompactSettings(s) {
  s.autoCompact = s.autoCompact === true;
  s.compactKeepMessages = clampInt(s.compactKeepMessages, 6, 80, 24);
  s.compactMaxMessages = clampInt(s.compactMaxMessages, 20, 200, 40);
  s.compactMaxApproxTokens = clampInt(s.compactMaxApproxTokens, 4000, 200000, 24000);
  return s;
}

// loadSettings / saveSettings 在 return 前 clampCompactSettings(merged|next)
```

- [ ] **Step 4: main.js toPublicSettings + save**

```js
// toPublicSettings 增加：
autoCompact: s.autoCompact === true,
compactKeepMessages: clamp…, // 与 settings 相同范围，或 require settings 导出 clamp
compactMaxMessages: …,
compactMaxApproxTokens: …,

// settings:save：若字段存在则 Boolean / clampInt
```

优先从 `settings.js` 导出 `clampCompactSettings` 供 main 复用，避免三份拷贝；若 main 已有 exploreMaxParallel 内联风格，可同样内联但数值必须一致。

- [ ] **Step 5: 测试通过 + commit**

```bash
node --test tests/settings.test.js
git add src/ai/settings.js src/main.js tests/settings.test.js
git commit -m "feat(codex-qq): Phase D.1 compact settings defaults and clamp"
```

---

### Task 2: session-compact 纯函数

**Files:**
- Create: `src/ai/session-compact.js`
- Create: `tests/session-compact.test.js`

**Interfaces:**
- Produces:
  - `approxTokensFromText(s: string): number`
  - `approxTokensFromMessages(messages: array): number`
  - `planCompact(messages, opts): { needed, older, keep, approxTokens, olderApproxTokens }`
  - `serializeOlderTranscript(older, opts?): string`
  - `applyCompact(messages, plan, summary): array`
  - `buildCompactSystemPrompt(): string`（中文摘要助手说明）

`opts` for plan: `{ keepMessages, maxMessages, maxApproxTokens, force?: boolean }`

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  approxTokensFromText,
  approxTokensFromMessages,
  planCompact,
  serializeOlderTranscript,
  applyCompact,
} = require('../src/ai/session-compact');

describe('session-compact', () => {
  it('approxTokensFromText uses ceil length/4', () => {
    assert.equal(approxTokensFromText('abcd'), 1);
    assert.equal(approxTokensFromText('abcde'), 2);
  });

  it('planCompact not needed when under thresholds', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const p = planCompact(msgs, {
      keepMessages: 24,
      maxMessages: 40,
      maxApproxTokens: 24000,
    });
    assert.equal(p.needed, false);
  });

  it('planCompact splits older and keep', () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
    }
    const p = planCompact(msgs, {
      keepMessages: 10,
      maxMessages: 20,
      maxApproxTokens: 24000,
    });
    assert.equal(p.needed, true);
    assert.equal(p.keep.length, 10);
    assert.equal(p.older.length, 20);
    assert.equal(p.keep[0].content, 'm20');
  });

  it('force compact when under max thresholds but has older prefix', () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user', content: 'x' + i });
    }
    const p = planCompact(msgs, {
      keepMessages: 10,
      maxMessages: 100,
      maxApproxTokens: 999999,
      force: true,
    });
    assert.equal(p.needed, true);
    assert.equal(p.older.length, 20);
  });

  it('serializeOlderTranscript truncates tool lines and total length', () => {
    const older = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world', tool: 'write_file', toolSummary: 'x'.repeat(500) },
    ];
    const t = serializeOlderTranscript(older, { maxChars: 10000 });
    assert.match(t, /\[user\]/);
    assert.match(t, /\[assistant\]|\[tool/);
    assert.ok(!t.includes('x'.repeat(300)));
  });

  it('applyCompact prepends summary message with compact flag', () => {
    const msgs = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old2' },
      { role: 'user', content: 'new1' },
    ];
    const plan = planCompact(msgs, {
      keepMessages: 1,
      maxMessages: 1,
      maxApproxTokens: 1,
      force: true,
    });
    const out = applyCompact(msgs, plan, '要点：测试');
    assert.equal(out.length, 2);
    assert.equal(out[0].compact, true);
    assert.equal(out[0].role, 'assistant');
    assert.match(out[0].content, /会话摘要/);
    assert.match(out[0].content, /要点：测试/);
    assert.equal(out[1].content, 'new1');
    assert.equal(out[0].compactedCount, plan.older.length);
  });
});
```

- [ ] **Step 2: Run → FAIL**

Run: `node --test tests/session-compact.test.js`

- [ ] **Step 3: 实现 `src/ai/session-compact.js`**

```js
'use strict';

const TRANSCRIPT_MAX_DEFAULT = 100000;
const TOOL_SUMMARY_MAX = 200;

function approxTokensFromText(s) {
  return Math.ceil(String(s || '').length / 4);
}

function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  let t = typeof m.content === 'string' ? m.content : String(m.content || '');
  if (m.tool) t += '\n' + String(m.tool);
  if (m.toolSummary) t += '\n' + String(m.toolSummary);
  return t;
}

function approxTokensFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let n = 0;
  for (const m of list) n += approxTokensFromText(messageText(m));
  return n;
}

function planCompact(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const keepMessages = Math.max(1, Number(opts.keepMessages) || 24);
  const maxMessages = Number(opts.maxMessages) || 40;
  const maxApproxTokens = Number(opts.maxApproxTokens) || 24000;
  const force = opts.force === true;
  const approxTokens = approxTokensFromMessages(list);

  if (list.length <= keepMessages) {
    return { needed: false, older: [], keep: list, approxTokens, olderApproxTokens: 0 };
  }

  if (!force) {
    if (list.length < maxMessages && approxTokens < maxApproxTokens) {
      return { needed: false, older: [], keep: list, approxTokens, olderApproxTokens: 0 };
    }
  }

  const older = list.slice(0, -keepMessages);
  const keep = list.slice(-keepMessages);
  if (!older.length) {
    return { needed: false, older: [], keep: list, approxTokens, olderApproxTokens: 0 };
  }

  return {
    needed: true,
    older,
    keep,
    approxTokens,
    olderApproxTokens: approxTokensFromMessages(older),
  };
}

function serializeOlderTranscript(older, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : TRANSCRIPT_MAX_DEFAULT;
  const list = Array.isArray(older) ? older : [];
  const parts = [];
  for (const m of list) {
    const role = m.role || 'unknown';
    if (m.tool || role === 'tool') {
      const name = m.tool || m.name || 'tool';
      let body = String(m.toolSummary || m.content || '').slice(0, TOOL_SUMMARY_MAX);
      parts.push(`[tool:${name}]\n${body}`);
    } else {
      parts.push(`[${role}]\n${String(m.content || '')}`);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    text = '…[transcript truncated]…\n' + text;
  }
  return text;
}

function applyCompact(messages, plan, summary) {
  const keep = plan && Array.isArray(plan.keep) ? plan.keep : [];
  const olderLen = plan && Array.isArray(plan.older) ? plan.older.length : 0;
  const summaryMsg = {
    role: 'assistant',
    content: `【会话摘要 · 更早 ${olderLen} 条已压缩】\n${String(summary || '').trim()}`,
    compact: true,
    compactAt: Date.now(),
    compactedCount: olderLen,
  };
  return [summaryMsg, ...keep];
}

function buildCompactSystemPrompt() {
  return [
    '你是会话压缩助手。根据用户提供的对话摘录，用中文写简洁结构化摘要。',
    '必须尽量保留：关键文件路径、已做决策、未决问题、用户明确约束、错误与修复结论。',
    '不要编造摘录中未出现的事实。使用短段落或 bullet。不要输出前言客套。',
  ].join('\n');
}

module.exports = {
  approxTokensFromText,
  approxTokensFromMessages,
  planCompact,
  serializeOlderTranscript,
  applyCompact,
  buildCompactSystemPrompt,
  TRANSCRIPT_MAX_DEFAULT,
  TOOL_SUMMARY_MAX,
};
```

- [ ] **Step 4: 测试通过 + commit**

```bash
node --test tests/session-compact.test.js
git add src/ai/session-compact.js tests/session-compact.test.js
git commit -m "feat(codex-qq): Phase D.1 session-compact pure helpers"
```

---

### Task 3: session-export 纯函数

**Files:**
- Create: `src/ai/session-export.js`
- Create: `tests/session-export.test.js`

**Interfaces:**
- `exportSessionMarkdown(session): string`
- `exportSessionJson(session): string`（pretty JSON，`version: 1`）
- `defaultExportFilename(session, format): string`（安全文件名）

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
} = require('../src/ai/session-export');

describe('session-export', () => {
  const session = {
    id: 's1',
    title: '修 bug/登录',
    kind: 'task',
    peer: 'codex',
    projectId: null,
    agentMode: 'agent',
    pinned: false,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool: 'write_file', toolSummary: 'ok a.js' },
      { role: 'assistant', content: 'secret', apiKey: 'sk-leak' },
    ],
  };

  it('markdown includes title and roles', () => {
    const md = exportSessionMarkdown(session);
    assert.match(md, /修 bug/);
    assert.match(md, /### User|### user|User/i);
    assert.match(md, /hello/);
    assert.match(md, /write_file|tool/i);
  });

  it('json has version 1 and messages without inventing apiKey field on session root', () => {
    const raw = exportSessionJson(session);
    const obj = JSON.parse(raw);
    assert.equal(obj.version, 1);
    assert.ok(obj.exportedAt);
    assert.equal(obj.session.id, 's1');
    assert.equal(obj.session.messages.length, 3);
    assert.ok(!JSON.stringify(obj).includes('sk-leak') === false);
    // message may still have spurious apiKey if present on message — strip known secret keys
    assert.ok(!raw.includes('sk-leak'));
  });

  it('defaultExportFilename sanitizes title', () => {
    const name = defaultExportFilename(session, 'md');
    assert.match(name, /\.md$/);
    assert.ok(!name.includes('/'));
  });
});
```

实现时：**剥离** messages 上的 `apiKey` / `authorization` 等敏感键；content 中的密钥无法可靠清除，文档说明即可。测试用 `apiKey` 字段断言被剥。

- [ ] **Step 2–4: 实现、测绿、commit**

```js
// session-export.js 要点
function stripSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const ban = new Set(['apiKey', 'authorization', 'token', 'password', 'secret']);
  if (Array.isArray(obj)) return obj.map(stripSecrets);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ban.has(k)) continue;
    out[k] = typeof v === 'object' && v ? stripSecrets(v) : v;
  }
  return out;
}

function exportSessionJson(session) {
  const safe = stripSecrets({
    id: session.id,
    title: session.title,
    kind: session.kind,
    peer: session.peer,
    projectId: session.projectId,
    agentMode: session.agentMode,
    pinned: session.pinned,
    messages: Array.isArray(session.messages) ? session.messages : [],
  });
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), session: safe }, null, 2);
}

function exportSessionMarkdown(session) {
  // 元数据头 + 每条消息；tool 行折叠
}

function defaultExportFilename(session, format) {
  const ext = format === 'json' ? 'json' : 'md';
  const base = String(session?.title || session?.id || 'session')
    .replace(/[<>:"/\\|?* -]+/g, '_')
    .slice(0, 40) || 'session';
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.${ext}`;
}
```

```bash
git commit -m "feat(codex-qq): Phase D.1 session export markdown and json"
```

---

### Task 4: main IPC — session:compact + dialog:saveTextFile

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Optional: `tests` 对 compact 用可注入逻辑——若难测 IPC，将摘要函数放在 `session-compact.js`：

**Interfaces:**
- 在 `session-compact.js` 增加：
  - `async function generateCompactSummary({ transcript, settings, chatFn? }): Promise<string>`
  - local：`return '（本地模式占位摘要）字符约 ' + transcript.length + '…'`
  - api：`chatFn` 或 `chatCompletion` 非流式
- main：
  - `ipcMain.handle('session:compact', async (_e, payload) => { ... })`
  - `ipcMain.handle('dialog:saveTextFile', async (_e, payload) => { showSaveDialog; writeFile })`

- [ ] **Step 1: 单测 generateCompactSummary**

```js
it('local mode returns placeholder without chatFn', async () => {
  const { generateCompactSummary } = require('../src/ai/session-compact');
  const s = await generateCompactSummary({
    transcript: 'hello',
    settings: { mode: 'local' },
  });
  assert.match(s, /本地|摘要|hello|字符/);
});

it('api mode uses chatFn', async () => {
  const { generateCompactSummary } = require('../src/ai/session-compact');
  const s = await generateCompactSummary({
    transcript: 'abc',
    settings: { mode: 'api', apiKey: 'k', baseUrl: 'http://x', model: 'm' },
    chatFn: async () => '摘要正文',
  });
  assert.equal(s, '摘要正文');
});
```

- [ ] **Step 2: 实现 generateCompactSummary**

```js
async function generateCompactSummary({ transcript, settings, chatFn }) {
  const text = String(transcript || '');
  if (!text.trim()) throw new Error('transcript 为空');
  const mode = settings?.mode === 'api' ? 'api' : 'local';
  if (mode === 'local') {
    return `（本地模式占位摘要）摘录约 ${text.length} 字符、约 ${approxTokensFromText(text)} token。请切换 API 模式生成真实摘要。`;
  }
  const fn = typeof chatFn === 'function'
    ? chatFn
    : (opts) => require('./openai-compatible').chatCompletion(opts);
  const content = await fn({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [
      { role: 'system', content: buildCompactSystemPrompt() },
      { role: 'user', content: text.slice(0, TRANSCRIPT_MAX_DEFAULT) },
    ],
    // 若 chatCompletion 支持 max_tokens 则传入；否则忽略
  });
  const out = String(content || '').trim();
  if (!out) throw new Error('摘要为空');
  return out;
}
```

检查 `chatCompletion` / `chatRequest` 是否支持 `max_tokens`；若 `buildChatPayload` 可扩展则传 `max_tokens: 1500`，否则 YAGNI 跳过。

- [ ] **Step 3: main handlers**

```js
const {
  generateCompactSummary,
} = require('./ai/session-compact');
const fs = require('fs');

ipcMain.handle('session:compact', async (_e, payload = {}) => {
  try {
    const transcript = String(payload.transcript || '');
    const settings = loadSettings(userDataPath());
    const summary = await generateCompactSummary({ transcript, settings });
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('dialog:saveTextFile', async (_e, payload = {}) => {
  const content = String(payload.content ?? '');
  const defaultName = String(payload.defaultName || 'export.txt');
  const filters = Array.isArray(payload.filters) && payload.filters.length
    ? payload.filters
    : [{ name: 'Text', extensions: ['txt', 'md', 'json'] }];
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win || undefined, {
    defaultPath: defaultName,
    filters,
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
```

- [ ] **Step 4: preload**

```js
compactSession: (payload) => ipcRenderer.invoke('session:compact', payload || {}),
saveTextFile: (payload) => ipcRenderer.invoke('dialog:saveTextFile', payload || {}),
```

- [ ] **Step 5: 测试 + commit**

```bash
node --test tests/session-compact.test.js tests/settings.test.js
git add src/ai/session-compact.js src/main.js src/preload.js tests/
git commit -m "feat(codex-qq): Phase D.1 session compact and saveTextFile IPC"
```

---

### Task 5: renderer — 命令、按钮、设置、样式、自动 compact

**Files:**
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`

**注意：** renderer 是浏览器环境，**不能** `require('../ai/session-compact')`。二选一：

**A（推荐）：** 在 `src/renderer/` 下放一份薄包装不可行；用 **preload 已暴露的逻辑不够**。  
**正确做法：** 将纯函数挂到 **不依赖 Node 专有 API** 的文件，通过 **复制打包** 或：

**本项目实际模式：** renderer 纯 DOM；算法在 main。但 planCompact 应在 **决定是否 compact / 划分 keep** 时本地执行以免每次 IPC。

**拍板实现：** 用 `src/ai/session-compact.js` / `session-export.js` 且保证 **仅用** 标准 JS（已满足）。在 `package.json` 若 browser 不能 require——Electron renderer **无 nodeIntegration** 时不能 require。

检查 preload / browser：`contextIsolation: true` 通常 **无 require**。

**因此：**

1. **planCompact / applyCompact / serialize / export\*** 的运行位置：  
   - **方案 R1：** preload 中 `require` 纯函数并 expose：`window.codex.planCompact` 等  
   - **方案 R2：** compact 全流程 main：`session:compactFull({ messages, settings, force })` 返回新 messages  

**采用 R1（与技能 list 类似的主进程能力）更轻：** preload expose：

```js
// 在 preload 里
const compact = require('./ai/session-compact'); // 路径相对 preload 位置 src/preload.js → ./ai/...
const exp = require('./ai/session-export');
// expose:
planCompact: (messages, opts) => compact.planCompact(messages, opts),
applyCompact: (messages, plan, summary) => compact.applyCompact(messages, plan, summary),
serializeOlderTranscript: (older, opts) => compact.serializeOlderTranscript(older, opts),
exportSessionMarkdown: (session) => exp.exportSessionMarkdown(session),
exportSessionJson: (session) => exp.exportSessionJson(session),
defaultExportFilename: (session, format) => exp.defaultExportFilename(session, format),
```

preload 路径：文件在 `src/preload.js`，require 应为 `./ai/session-compact`（与 main 同级 `src/`）。

- [ ] **Step 1: preload 暴露纯函数 + 已有 IPC**

- [ ] **Step 2: HTML 设置项 + 按钮**

在设置模态 Agent 相关区域追加：

```html
<label class="switch-row">
  <input type="checkbox" id="set-auto-compact" />
  <span>发送前自动压缩会话（超阈值时）</span>
</label>
<label class="field">
  <span>压缩保留最近消息数</span>
  <input id="set-compact-keep-messages" type="number" min="6" max="80" value="24" />
</label>
<label class="field">
  <span>压缩条数阈值</span>
  <input id="set-compact-max-messages" type="number" min="20" max="200" value="40" />
</label>
<label class="field">
  <span>压缩约 token 阈值</span>
  <input id="set-compact-max-tokens" type="number" min="4000" max="200000" value="24000" />
</label>
```

聊天顶栏（`#btn-stop` 旁或 header 区）增加：

```html
<button type="button" id="btn-compact" class="btn-small" title="压缩会话">压缩</button>
<button type="button" id="btn-export" class="btn-small" title="导出会话">导出</button>
```

若顶栏拥挤，可放在会话标题旁；实现时选 **header 操作区** 与现有按钮风格一致。

- [ ] **Step 3: CSS**

```css
.msg-compact .bubble,
.msg.msg-compact .bubble {
  border: 1px dashed #8a9bcc;
  background: #f4f6fc;
  color: #243a6a;
  font-size: 12px;
}
```

`renderMessages`：若 `msg.compact` 给 `msg` 根节点加 `msg-compact`。

- [ ] **Step 4: app.js 核心逻辑**

```js
function compactSettingsFrom(s) {
  return {
    keepMessages: Number(s.compactKeepMessages) || 24,
    maxMessages: Number(s.compactMaxMessages) || 40,
    maxApproxTokens: Number(s.compactMaxApproxTokens) || 24000,
    autoCompact: s.autoCompact === true,
  };
}

async function runCompactOnSession(session, { force }) {
  if (sending || chatRun) {
    toast('请先停止生成再压缩会话');
    return false;
  }
  const settings = await window.codex.getSettings();
  const cs = compactSettingsFrom(settings);
  const plan = window.codex.planCompact(session.messages || [], {
    keepMessages: cs.keepMessages,
    maxMessages: cs.maxMessages,
    maxApproxTokens: cs.maxApproxTokens,
    force: !!force,
  });
  if (!plan.needed) {
    toast(force ? '无需压缩（没有可压缩的更早消息）' : '未达压缩阈值');
    return false;
  }
  const transcript = window.codex.serializeOlderTranscript(plan.older);
  const res = await window.codex.compactSession({ transcript });
  if (!res || res.ok === false) {
    toast('压缩失败：' + (res?.error || '未知错误'));
    return false;
  }
  session.messages = window.codex.applyCompact(session.messages, plan, res.summary);
  session.updatedAt = Date.now();
  saveState();
  renderMessages();
  toast(`已压缩更早 ${plan.older.length} 条消息`);
  return true;
}

async function runExportOnSession(session, format) {
  const fmt = format === 'json' ? 'json' : 'md';
  const content = fmt === 'json'
    ? window.codex.exportSessionJson(session)
    : window.codex.exportSessionMarkdown(session);
  const defaultName = window.codex.defaultExportFilename(session, fmt);
  const filters = fmt === 'json'
    ? [{ name: 'JSON', extensions: ['json'] }]
    : [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
  const res = await window.codex.saveTextFile({ content, defaultName, filters });
  if (res?.canceled) return;
  if (!res?.ok) {
    toast('导出失败：' + (res?.error || ''));
    return;
  }
  toast('已导出：' + res.path);
}
```

**handleSlashCommand 增加：**

```js
if (lower === '/compact') {
  runCompactOnSession(activeSession(), { force: true }).catch((e) => toast(e.message || String(e)));
  return true;
}
if (lower === '/export' || lower.startsWith('/export ')) {
  const arg = lower === '/export' ? '' : lower.slice('/export '.length).trim();
  if (!arg || arg === 'md' || arg === 'markdown') {
    runExportOnSession(activeSession(), 'md').catch(...);
  } else if (arg === 'json') {
    runExportOnSession(activeSession(), 'json').catch(...);
  } else {
    toast('用法：/export md 或 /export json');
  }
  return true;
}
// /help 文案追加 /compact /export md|json
```

**openSettings / saveSettingsFromForm：** 读写四个字段。

**sendMessage：** 在 `session.messages.push({ role:'user'...})` 之后、`createAssistantRunPlaceholder` 之前：

```js
try {
  const st = await window.codex.getSettings();
  if (st.autoCompact === true) {
    await runCompactOnSession(session, { force: false });
    // runCompactOnSession 内部若 sending 已 true 会失败——注意顺序：
  }
} catch { /* 不阻断 */ }
```

**顺序修正：** 自动 compact 必须在 `setSending(true)` **之前** 完成：

```js
session.messages.push({ role: 'user', content: text });
// auto compact while sending still false
try {
  const st = await window.codex.getSettings();
  if (st.autoCompact === true) {
    const cs = compactSettingsFrom(st);
    const plan = window.codex.planCompact(session.messages, { ...cs, force: false });
    // keepMessages 等字段展开
    if (plan.needed) {
      const transcript = window.codex.serializeOlderTranscript(plan.older);
      const res = await window.codex.compactSession({ transcript });
      if (res?.ok) {
        session.messages = window.codex.applyCompact(session.messages, plan, res.summary);
        toast(`发送前已自动压缩 ${plan.older.length} 条`);
      }
    }
  }
} catch { /* ignore */ }
session.updatedAt = Date.now();
// ... clear input, setSending(true), sendChat
```

可将自动路径抽 `maybeAutoCompact(session)`，**不要**调用完整 `runCompactOnSession`（避免 sending 检查搅局），失败静默或短 toast。

**按钮：**

```js
document.getElementById('btn-compact')?.addEventListener('click', () => {
  runCompactOnSession(activeSession(), { force: true }).catch(...);
});
document.getElementById('btn-export')?.addEventListener('click', () => {
  // 简单：先 md；或 window.confirm 选 json
  const useJson = window.confirm('导出 JSON？\n确定=JSON，取消=Markdown');
  runExportOnSession(activeSession(), useJson ? 'json' : 'md').catch(...);
});
```

- [ ] **Step 5: node --check + 手工清单 + commit**

```bash
node --check src/preload.js
node --check src/main.js
# renderer app.js 若为浏览器脚本无 require，用 node --check 仍可语法检查
node --check src/renderer/app.js
git add src/preload.js src/renderer/ app.js ...
git commit -m "feat(codex-qq): Phase D.1 compact export UI and slash commands"
```

---

### Task 6: README + 全量测试

**Files:**
- Modify: `README.md`
- 全量 `npm test`

**README 要点（zh-CN）：**

- `/compact`、自动压缩设置（默认关）
- 阈值含义：保留条数、条数阈值、约 token（len/4）
- `/export md` / `/export json`
- 进行中不可 compact
- local 模式占位摘要

- [ ] **Step 1: 写 README**  
- [ ] **Step 2: `npm test` 全绿**  
- [ ] **Step 3: commit**

```bash
git commit -m "docs(codex-qq): Phase D.1 session compact and export usage"
```

---

## Self-review (plan vs spec)

| Spec 项 | Task |
|---------|------|
| settings 默认与 clamp | T1 |
| planCompact / token / apply / transcript | T2 |
| export md/json | T3 |
| session:compact + save dialog | T4 |
| UI 命令按钮设置自动 | T5 |
| README + 全测 | T6 |
| 活跃 run 拒绝 compact | T5 |
| 无 apiKey 进导出 | T3 |
| 无新依赖 | 全局 |

无 TBD；preload 暴露纯函数已解决 renderer 无 require 问题。

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-phase-d1-session-compact-export.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — 每任务独立 subagent + review  
2. **Inline Execution** — 本会话连续执行  

**Which approach?**
