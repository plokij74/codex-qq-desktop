# Phase A Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

## Status

| Field | Value |
|-------|--------|
| **Status** | **Complete** (Task 10 polish) |
| **Baseline commit** | `9815e38` |
| **Capability design** | `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md` |
| **Execution readiness** | `docs/superpowers/specs/2026-07-18-phase-a-execution-readiness-design.md` |
| **Milestones** | M0–M5 done (Tasks 1–10) |
| **Last plan revision** | 2026-07-18 — Task 10 README + tests + checkbox closeout |
| **Phase A commits** | `ab6ec62` … `8957b63` (+ Task 10 docs commit) |

**Goal:** Deliver Phase A agent core: `search_replace` + `grep`/`glob`, three-tier permissions with inline chat approvals, per-turn streaming content + tool events, and thin context enhancements (gitignore, `AGENTS.md`/`CLAUDE.md`, read offset/limit).

**Architecture:** Keep Electron main/preload/renderer split. Add a PermissionGate and event channel around the existing `runAgentLoop`. Tools live in `project-fs.js` + new `search.js`; model streaming in `openai-compatible.js`; UI shows a run timeline + stream body + approval cards. Spec: `docs/superpowers/specs/2026-07-17-phase-a-agent-core-design.md`.

**Tech Stack:** Electron 33, plain Node.js (no new deps), `node:test`, fetch SSE streaming, existing QQ renderer HTML/CSS/JS.

## Global Constraints

- All code under this repo root only (paths are **repo-relative**, e.g. `src/ai/agent.js`)
- `contextIsolation: true`, `nodeIntegration: false`, API key only in main
- Abort: **throw** `Error` with `code: 'ABORTED'` and message matching `/已停止/`
- Default `permissionMode: 'confirm-writes'` (stricter than old auto-write)
- No MCP / sub-agents / apply_patch / Diff Accept panel / forced ripgrep binary
- UI language: zh-CN labels
- Tests: `node --test` via `npm test`
- Follow existing CommonJS `module.exports` style
- Frequent commits; do not mix unrelated dirty working tree files into Phase A commits unless required
- Execute Tasks **1 → 10 serially**; do not skip; do not start Phase B/C in the same commits

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/ai/agent-events.js` | Create | Event type string constants |
| `src/ai/permission.js` | Create | PermissionGate: modes, session memory, approval wait/resolve |
| `src/ai/search.js` | Create | `grepFiles`, `globFiles` + gitignore-aware walk helpers used by grep/glob |
| `src/ai/project-instructions.js` | Create | Load `AGENTS.md` / `CLAUDE.md` |
| `src/ai/gitignore.js` | Create | Parse basic `.gitignore` + `isIgnored(relPath, rules)` |
| `src/ai/settings.js` | Modify | Add `permissionMode` default |
| `src/ai/project-fs.js` | Modify | gitignore in listTree; `searchReplace`; read `offset`/`limit` |
| `src/ai/openai-compatible.js` | Modify | SSE stream + `onDelta`; keep non-stream path |
| `src/ai/agent.js` | Modify | New tools, gate, `onEvent`, stream model turns |
| `src/ai/terminal.js` | Modify | No direct dialog; caller supplies approval via gate |
| `src/main.js` | Modify | Events, approve IPC, wire gate, host path events |
| `src/preload.js` | Modify | `onChatEvent`, `approveChat` |
| `src/renderer/index.html` | Modify | permissionMode select; timeline styles hooks if needed |
| `src/renderer/styles.css` | Modify | Timeline, approval card, stream body |
| `src/renderer/app.js` | Modify | Event-driven send UI, approvals, settings |
| `README.md` | Modify | Phase A settings & behavior notes |
| `tests/settings.test.js` | Modify | permissionMode default |
| `tests/permission.test.js` | Create | Gate matrix + session allow + abort |
| `tests/gitignore.test.js` | Create | Parse / match |
| `tests/project-instructions.test.js` | Create | Load files |
| `tests/project-fs.test.js` | Modify | searchReplace + read slice |
| `tests/search.test.js` | Create | grep/glob |
| `tests/openai-compatible.test.js` | Modify | stream deltas |
| `tests/agent.test.js` | Modify | new tools + event order (mocked) |
| `tests/abort.test.js` / `agent-abort.test.js` | Modify if needed | stay ABORTED-consistent |

---

### Task 1: Settings default + event constants

**Depends-on:** none (kickoff after M0 baseline `npm test` green)  
**Touches:** `src/ai/settings.js`, `src/ai/agent-events.js` (create), `tests/settings.test.js`

**Files:**
- Modify: `src/ai/settings.js`
- Create: `src/ai/agent-events.js`
- Modify: `tests/settings.test.js`

**Interfaces:**
- Consumes: existing `DEFAULT_SETTINGS` / `loadSettings` / `saveSettings`
- Produces:
  - `DEFAULT_SETTINGS.permissionMode === 'confirm-writes'`
  - `AGENT_EVENTS = { RUN_START, TEXT_DELTA, TOOL_START, TOOL_END, APPROVAL_NEEDED, APPROVAL_RESOLVED, TURN_END, DONE, ERROR, ABORTED }` with string values matching names in kebab or same tokens as spec: `'run-start'`, `'text-delta'`, etc.

- [x] **Step 1: Write failing settings test**

Add to `tests/settings.test.js`:

```js
it('defaults permissionMode to confirm-writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  const s = loadSettings(dir);
  assert.equal(s.permissionMode, 'confirm-writes');
});

it('saveSettings persists permissionMode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
  saveSettings(dir, { permissionMode: 'read-only' });
  assert.equal(loadSettings(dir).permissionMode, 'read-only');
});
```

- [x] **Step 2: Run test — expect FAIL**

Run: `node --test tests/settings.test.js`  
Expected: FAIL on `permissionMode` undefined

- [x] **Step 3: Implement settings + agent-events**

In `src/ai/settings.js` add to `DEFAULT_SETTINGS`:

```js
permissionMode: 'confirm-writes', // read-only | confirm-writes | full-auto
```

Create `src/ai/agent-events.js`:

```js
const AGENT_EVENTS = {
  RUN_START: 'run-start',
  TEXT_DELTA: 'text-delta',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
  APPROVAL_NEEDED: 'approval-needed',
  APPROVAL_RESOLVED: 'approval-resolved',
  TURN_END: 'turn-end',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
};

module.exports = { AGENT_EVENTS };
```

- [x] **Step 4: Run tests — expect PASS**

Run: `node --test tests/settings.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/ai/settings.js src/ai/agent-events.js tests/settings.test.js
git commit -m "feat(codex-qq): permissionMode default and agent event constants"
```

---

### Task 2: PermissionGate

**Depends-on:** Task 1 (`AGENT_EVENTS` available; optional import)  
**Touches:** `src/ai/permission.js` (create), `tests/permission.test.js` (create)

**Files:**
- Create: `src/ai/permission.js`
- Create: `tests/permission.test.js`

**Interfaces:**
- Consumes: `AGENT_EVENTS` (optional; gate may not emit itself)
- Produces:
  - `createPermissionGate({ permissionMode, terminalEnabled, terminalRequireConfirm, onApprovalNeeded })`
  - Methods:
    - `async authorize({ tool, risk, summary, detail, path, sessionKey, signal }) → { allowed: boolean, reason?: string }`
    - `resolveApproval(approvalId, decision)` where decision is `'allow' | 'deny' | 'allow_session'`
    - `rememberSession(sessionKey, risk)` / internal session map
    - `riskForTool(toolName) → 'read' | 'write' | 'delete' | 'terminal'`
  - Risks: `list_dir|read_file|grep|glob` → read; `write_file|search_replace` + write-fence → write; `delete_path` → delete; `run_terminal` → terminal
  - `read-only`: deny write/delete/terminal with Chinese reason
  - `confirm-writes`: read auto-allow; write/delete/terminal need approval unless session remembered; if `terminalEnabled === false` deny terminal
  - `full-auto`: allow write/delete; terminal allow unless `terminalEnabled === false`; if `terminalRequireConfirm === true` still approve terminal only
  - `onApprovalNeeded(payload)` called with `{ approvalId, tool, risk, summary, detail, path }` and must return a Promise that Gate also tracks via `resolveApproval`
  - Abort signal during wait → throw ABORTED error (`code: 'ABORTED'`, message `已停止`)

- [x] **Step 1: Write failing tests `tests/permission.test.js`**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionGate, riskForTool } = require('../src/ai/permission');

describe('permission', () => {
  it('riskForTool maps tools', () => {
    assert.equal(riskForTool('grep'), 'read');
    assert.equal(riskForTool('search_replace'), 'write');
    assert.equal(riskForTool('delete_path'), 'delete');
    assert.equal(riskForTool('run_terminal'), 'terminal');
  });

  it('read-only denies write', async () => {
    const gate = createPermissionGate({
      permissionMode: 'read-only',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { throw new Error('should not approve'); },
    });
    const r = await gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'w', sessionKey: 's1',
    });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /只读|read-only|不允许/i);
  });

  it('confirm-writes auto-allows read', async () => {
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: false,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => { throw new Error('no'); },
    });
    const r = await gate.authorize({ tool: 'grep', risk: 'read', summary: 'g', sessionKey: 's1' });
    assert.equal(r.allowed, true);
  });

  it('confirm-writes waits for allow', async () => {
    let pendingId;
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { pendingId = p.approvalId; },
    });
    const p = gate.authorize({
      tool: 'search_replace', risk: 'write', summary: 'edit', path: 'a.js', sessionKey: 's1',
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(pendingId);
    gate.resolveApproval(pendingId, 'allow');
    const r = await p;
    assert.equal(r.allowed, true);
  });

  it('allow_session skips later same risk', async () => {
    const ids = [];
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async (p) => { ids.push(p.approvalId); },
    });
    const p1 = gate.authorize({ tool: 'write_file', risk: 'write', summary: '1', sessionKey: 's1' });
    await new Promise((r) => setImmediate(r));
    gate.resolveApproval(ids[0], 'allow_session');
    assert.equal((await p1).allowed, true);
    const r2 = await gate.authorize({ tool: 'write_file', risk: 'write', summary: '2', sessionKey: 's1' });
    assert.equal(r2.allowed, true);
    assert.equal(ids.length, 1);
  });

  it('abort during approval throws ABORTED', async () => {
    const ac = new AbortController();
    const gate = createPermissionGate({
      permissionMode: 'confirm-writes',
      terminalEnabled: true,
      terminalRequireConfirm: true,
      onApprovalNeeded: async () => {},
    });
    const p = gate.authorize({
      tool: 'write_file', risk: 'write', summary: 'x', sessionKey: 's1', signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(p, (err) => err.code === 'ABORTED');
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `node --test tests/permission.test.js`  
Expected: cannot find module

- [x] **Step 3: Implement `src/ai/permission.js`**

Implement `createPermissionGate` with:
- internal `Map` approvalId → `{ resolve }`
- internal `Map` sessionKey → `Set(risk)`
- `approvalId = 'appr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)`
- on need approval: call `onApprovalNeeded`, then `await` new Promise stored in map; `resolveApproval` settles it
- deny decision → `{ allowed: false, reason: '用户拒绝' }`
- abort listener rejects with ABORTED

Export `riskForTool` and `createPermissionGate`.

- [x] **Step 4: Run — expect PASS**

Run: `node --test tests/permission.test.js`  
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/ai/permission.js tests/permission.test.js
git commit -m "feat(codex-qq): PermissionGate with session allow and abort"
```

---

### Task 3: gitignore + project instructions

**Depends-on:** none strictly (can follow Task 1–2); listTree wiring touches `project-fs.js`  
**Touches:** `src/ai/gitignore.js`, `src/ai/project-instructions.js` (create), `src/ai/project-fs.js`, `tests/gitignore.test.js`, `tests/project-instructions.test.js`, maybe `tests/project-fs.test.js`

**Files:**
- Create: `src/ai/gitignore.js`
- Create: `src/ai/project-instructions.js`
- Create: `tests/gitignore.test.js`
- Create: `tests/project-instructions.test.js`
- Modify: `src/ai/project-fs.js` (`listTree` skip ignored)
- Modify: `tests/project-fs.test.js` (one ignore case)

**Interfaces:**
- Consumes: `fs`, `path`
- Produces:
  - `parseGitignore(text: string) → rules[]`
  - `isIgnored(relPath: string, rules) → boolean` (posix-ish relative path, no leading `./`)
  - `loadGitignoreRules(projectRoot) → rules` (read `.gitignore` if exists, else `[]`)
  - `loadProjectInstructions(projectRoot) → { agentsText, claudeText, parts: string }`  
    reads `AGENTS.md` then `agents.md`; `CLAUDE.md`; each max 8192 chars; `parts` is system prompt fragment

Basic gitignore (YAGNI):
- ignore blank lines and `#` comments
- trim; support trailing `/` as directory prefix match
- support `*` within one path segment; support leading `**/` or bare pattern matching any segment end
- do not implement full git negation `!` in Phase A (if seen, skip rule)

- [x] **Step 1: Write failing tests**

`tests/gitignore.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseGitignore, isIgnored } = require('../src/ai/gitignore');

describe('gitignore', () => {
  it('parses and matches simple patterns', () => {
    const rules = parseGitignore('# c\nnode_modules/\n*.log\ndist\n');
    assert.equal(isIgnored('node_modules/foo', rules), true);
    assert.equal(isIgnored('a.log', rules), true);
    assert.equal(isIgnored('src/a.js', rules), false);
  });
});
```

`tests/project-instructions.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProjectInstructions } = require('../src/ai/project-instructions');

describe('project-instructions', () => {
  it('loads AGENTS.md and CLAUDE.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Always Chinese MARKER_A');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Use tests MARKER_C');
    const r = loadProjectInstructions(root);
    assert.match(r.parts, /MARKER_A/);
    assert.match(r.parts, /MARKER_C/);
    assert.match(r.parts, /AGENTS\.md|项目指令/);
  });
});
```

- [x] **Step 2: Run — FAIL**

Run: `node --test tests/gitignore.test.js tests/project-instructions.test.js`

- [x] **Step 3: Implement modules + wire listTree**

Implement `gitignore.js` and `project-instructions.js`.

In `listTree`, after computing relative path from walk root, if caller passes `ignoreRules` or auto-loads from `projectRoot` option:
- Add optional `opts.ignoreRules`
- When listing a full project, `main`/agent can pass `loadGitignoreRules(root)`
- Skip ignored files/dirs (still can show nothing)

Also keep `SKIP_DIRS` as today.

Add test: project with `.gitignore` containing `secret.txt` → `listTree` treeText does not include it when rules loaded.

- [x] **Step 4: Run — PASS**

Run: `node --test tests/gitignore.test.js tests/project-instructions.test.js tests/project-fs.test.js`

- [x] **Step 5: Commit**

```bash
git add src/ai/gitignore.js src/ai/project-instructions.js src/ai/project-fs.js tests/gitignore.test.js tests/project-instructions.test.js tests/project-fs.test.js
git commit -m "feat(codex-qq): basic gitignore and project instruction loaders"
```

---

### Task 4: search_replace + read offset/limit

**Depends-on:** Task 3 preferred (same `project-fs.js`; avoid merge conflicts if parallel)  
**Touches:** `src/ai/project-fs.js`, `tests/project-fs.test.js`

**Files:**
- Modify: `src/ai/project-fs.js`
- Modify: `tests/project-fs.test.js`

**Interfaces:**
- Produces:
  - `searchReplace(projectRoot, relPath, oldString, newString, { replaceAll?: boolean }) → { path, replacements, bytes }`
  - `readFile(projectRoot, relPath, { maxBytes?, offset?, limit? })`  
    - `offset` 1-based start line; `limit` max lines  
    - when offset/limit set, `content` is line-numbered text like `   12|code`  
    - return `{ path, content, size, totalLines?, startLine?, endLine? }`

Rules per spec §3.2.

- [x] **Step 1: Write failing tests** (append to project-fs.test.js)

```js
const { searchReplace, readFile } = require('../src/ai/project-fs');

it('searchReplace unique match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
  writeFile(root, 'a.js', 'const x = 1;\nconst y = 2;\n');
  const r = searchReplace(root, 'a.js', 'const x = 1;', 'const x = 42;');
  assert.equal(r.replacements, 1);
  assert.equal(readFile(root, 'a.js').content, 'const x = 42;\nconst y = 2;\n');
});

it('searchReplace fails on multiple matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
  writeFile(root, 'a.js', 'foo\nfoo\n');
  assert.throws(() => searchReplace(root, 'a.js', 'foo', 'bar'), /次|multiple|多/i);
});

it('searchReplace replace_all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
  writeFile(root, 'a.js', 'foo\nfoo\n');
  const r = searchReplace(root, 'a.js', 'foo', 'bar', { replaceAll: true });
  assert.equal(r.replacements, 2);
});

it('readFile offset limit with line numbers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proj-'));
  writeFile(root, 'a.txt', 'l1\nl2\nl3\nl4\n');
  const f = readFile(root, 'a.txt', { offset: 2, limit: 2 });
  assert.match(f.content, /2\|l2/);
  assert.match(f.content, /3\|l3/);
  assert.ok(!f.content.includes('l1') || !/1\|l1/.test(f.content));
});
```

- [x] **Step 2: Run — FAIL**

Run: `node --test tests/project-fs.test.js`

- [x] **Step 3: Implement**

```js
function searchReplace(projectRoot, relPath, oldString, newString, opts = {}) {
  const oldS = String(oldString ?? '');
  const newS = String(newString ?? '');
  if (!oldS) throw new Error('old_string 为空');
  const full = resolveSafe(projectRoot, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在，请用 write_file 创建: ${relPath}`);
  }
  const text = fs.readFileSync(full, 'utf8');
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(oldS, idx)) !== -1) { count += 1; idx += oldS.length; }
  if (count === 0) throw new Error(`未找到 old_string 匹配: ${relPath}`);
  if (!opts.replaceAll && count > 1) {
    throw new Error(`old_string 出现 ${count} 次，默认要求唯一匹配；可设 replace_all=true`);
  }
  const next = opts.replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  fs.writeFileSync(full, next, 'utf8');
  return {
    path: relPath.replace(/\\/g, '/'),
    replacements: opts.replaceAll ? count : 1,
    bytes: Buffer.byteLength(next, 'utf8'),
  };
}
```

Extend `readFile` for offset/limit; if neither provided, keep raw full content behavior for backward compatibility.

Export `searchReplace`.

- [x] **Step 4: Run — PASS**

- [x] **Step 5: Commit**

```bash
git add src/ai/project-fs.js tests/project-fs.test.js
git commit -m "feat(codex-qq): search_replace and read_file offset/limit"
```

---

### Task 5: grep + glob

**Depends-on:** Task 3 (`gitignore` helpers)  
**Touches:** `src/ai/search.js` (create), `tests/search.test.js` (create)

**Files:**
- Create: `src/ai/search.js`
- Create: `tests/search.test.js`

**Interfaces:**
- Consumes: `resolveSafe` or path join under root; `loadGitignoreRules` / `isIgnored`; `SKIP_DIRS` (duplicate set or import if exported — if not exported, duplicate minimal set in search.js)
- Produces:
  - `grepFiles(projectRoot, { pattern, path?, glob?, maxResults?, literal? }) → { ok, matches: [{path,line,text}], truncated, scannedFiles, skippedFiles }`
  - `globFiles(projectRoot, { pattern, maxResults? }) → { ok, files: string[], truncated }`
  - default maxResults 50, hard cap 200
  - skip files > 1.5 * 1024 * 1024 for grep
  - regex: if `literal: true` escape; else try `new RegExp(pattern)` and on invalid throw friendly error

- [x] **Step 1: Write `tests/search.test.js`**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { grepFiles, globFiles } = require('../src/ai/search');

describe('search', () => {
  it('grep finds line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function runAgentLoop() {}\n');
    const r = grepFiles(root, { pattern: 'runAgentLoop', maxResults: 10 });
    assert.equal(r.ok, true);
    assert.ok(r.matches.some((m) => m.path.includes('a.js') && m.line === 1));
  });

  it('glob finds js', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.writeFileSync(path.join(root, 'x.js'), '1');
    fs.writeFileSync(path.join(root, 'y.txt'), '1');
    const r = globFiles(root, { pattern: '**/*.js' });
    assert.ok(r.files.some((f) => f.endsWith('x.js')));
    assert.ok(!r.files.some((f) => f.endsWith('y.txt')));
  });

  it('respects gitignore node_modules style via rules file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'h.js'), 'SECRET_TOKEN');
    fs.writeFileSync(path.join(root, 'app.js'), 'SECRET_TOKEN');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    const r = grepFiles(root, { pattern: 'SECRET_TOKEN' });
    assert.ok(r.matches.every((m) => !m.path.includes('node_modules')));
    assert.ok(r.matches.some((m) => m.path.includes('app.js')));
  });
});
```

- [x] **Step 2: Run — FAIL**

- [x] **Step 3: Implement `src/ai/search.js`**

Walk project with SKIP_DIRS + gitignore. Implement simple glob matcher (`**`, `*`). Cap results.

- [x] **Step 4: Run — PASS**

- [x] **Step 5: Commit**

```bash
git add src/ai/search.js tests/search.test.js
git commit -m "feat(codex-qq): host-side grep and glob tools"
```

---

### Task 6: Streaming chatCompletionMessage

**Depends-on:** none strictly (independent of tools/gate); required before Task 7 stream wiring  
**Touches:** `src/ai/openai-compatible.js`, `tests/openai-compatible.test.js`, maybe `tests/abort.test.js`

**Files:**
- Modify: `src/ai/openai-compatible.js`
- Modify: `tests/openai-compatible.test.js`
- Modify: `tests/abort.test.js` if stream abort needs coverage

**Interfaces:**
- Produces:
  - `buildChatPayload` may set `stream: true` when streaming
  - `async function chatCompletionMessage({ ..., stream, onDelta, signal, fetchFn })`  
    - if `stream: true`, POST with `stream: true`, parse SSE `data: {...}` lines, accumulate `content` and `tool_calls` deltas (OpenAI-style), call `onDelta({ text?: string })` for content pieces only  
    - return same shape `{ role, content, tool_calls? }`  
  - if stream fails mid-way with parse issues, throw; agent will catch and retry non-stream (Task 7)
  - non-stream path unchanged
  - abort → `code: 'ABORTED'`

SSE parse sketch: read body via `res.body.getReader()` if present; in tests, mock `fetchFn` returning `{ ok, status, body: { getReader(){...} } }` OR `{ ok, status, text }` for non-stream.

For Node 18+ / Electron, prefer:

```js
async function* iterateSse(fetchRes) {
  // if fetchRes.body and getReader: decode UTF-8, split lines, yield JSON for data: lines
  // else if text(): not stream
}
```

Test without real network:

```js
it('chatCompletionMessage stream concatenates deltas', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  let i = 0;
  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = encoder.encode(chunks[i++]);
            return { done: false, value };
          },
        };
      },
    },
  });
  const deltas = [];
  const msg = await chatCompletionMessage({
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    onDelta: (d) => { if (d.text) deltas.push(d.text); },
    fetchFn,
  });
  assert.equal(msg.content, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
});
```

Also test tool_calls accumulation from deltas (name + arguments fragments) → final `tool_calls` array.

- [x] **Step 1: Write failing stream test**
- [x] **Step 2: Run — FAIL**
- [x] **Step 3: Implement stream path in `chatRequest` / `chatCompletionMessage`**
- [x] **Step 4: Run full openai + abort tests — PASS**
- [x] **Step 5: Commit**

```bash
git add src/ai/openai-compatible.js tests/openai-compatible.test.js tests/abort.test.js
git commit -m "feat(codex-qq): SSE stream for chat completions deltas"
```

---

### Task 7: Agent loop — tools, gate, events, stream

**Depends-on:** Tasks 1–6 (events, gate, instructions/gitignore, search_replace/read slice, grep/glob, stream)  
**Touches:** `src/ai/agent.js`, `tests/agent.test.js` (optional `tests/agent-events.test.js`)

**Files:**
- Modify: `src/ai/agent.js`
- Modify: `tests/agent.test.js`
- Create or modify: `tests/agent-events.test.js` optional; prefer extend `agent.test.js`

**Interfaces:**
- Consumes: `searchReplace`, `grepFiles`, `globFiles`, `loadProjectInstructions`, `loadGitignoreRules`, `createPermissionGate` (or gate instance passed in), `chatCompletionMessage` with stream, `AGENT_EVENTS`
- Produces: `runAgentLoop({ project, settings, messages, gate, onEvent, fetchFn, signal, sessionKey })`
  - **Remove** direct `confirmTerminal` dialog dependency; terminal goes through `gate.authorize`
  - TOOL_DEFS add: `grep`, `glob`, `search_replace`; extend `read_file` params with offset/limit
  - `onEvent({ type, runId?, ... })` called for text-delta, tool-start, tool-end, approval handled inside gate (main wires approval-needed)
  - Prefer: gate created in **main** and passed in so main can bind `onApprovalNeeded` → webContents.send
  - On each model turn: `chatCompletionMessage({ stream: true, onDelta: (d) => onEvent({ type: TEXT_DELTA, text: d.text }), ...})` with fallback to non-stream if error message matches /stream|SSE|parse/i once
  - System prompt: agent rules + `loadProjectInstructions` + short note prefer search_replace; optional short tree maxDepth 3 maxEntries 80 instead of huge tree
  - `executeToolFixed`: handle new tools; list_dir pass ignore rules

- [x] **Step 1: Write failing agent tests**

```js
it('executeToolFixed search_replace and grep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
  const { createPermissionGate } = require('../src/ai/permission');
  const gate = createPermissionGate({
    permissionMode: 'full-auto',
    terminalEnabled: false,
    terminalRequireConfirm: false,
    onApprovalNeeded: async () => {},
  });
  const ctx = { project: { name: 't', path: root }, settings: { terminalEnabled: false }, gate };
  const g = JSON.parse(await executeToolFixed('grep', { pattern: 'const x' }, ctx));
  assert.equal(g.ok, true);
  const s = JSON.parse(await executeToolFixed('search_replace', {
    path: 'a.js', old_string: 'const x = 1;', new_string: 'const x = 2;',
  }, ctx));
  assert.equal(s.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const x = 2;\n');
});

it('runAgentLoop emits tool events with mock model', async () => {
  // mock fetchFn or inject chatCompletionMessage via optional dependency if you add opts.chatFn
});
```

**Recommended for testability:** accept optional `opts.chatFn` defaulting to `chatCompletionMessage` so unit tests mock turns:

```js
// turn1: tool_calls grep; turn2: final content
```

Events array must include `tool-start`, `tool-end`, `text-delta` or final content via deltas, `done` is emitted by main not agent — agent can call `onEvent` for tool/text only; document that main emits run-start/done.

Agent `runAgentLoop` returns same `{ content, applied, agentLog, turns, toolsSupported }` and uses `onEvent` during run.

Before execute tool:
```js
const risk = riskForTool(name);
onEvent?.({ type: AGENT_EVENTS.TOOL_START, tool: name, args });
const auth = await gate.authorize({ tool: name, risk, summary, detail, path, sessionKey, signal });
if (!auth.allowed) {
  resultStr = JSON.stringify({ ok: false, error: auth.reason || '未授权' });
} else {
  resultStr = await executeToolFixed(...);
}
onEvent?.({ type: AGENT_EVENTS.TOOL_END, tool: name, ok: ..., summary: ... });
```

For write fence at end: authorize write once per op before applyWriteFences or fold apply behind gate in agent.

- [x] **Step 2–4: TDD implement until agent tests pass**
- [x] **Step 5: Commit**

```bash
git add src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): agent tools grep/glob/search_replace with PermissionGate"
```

---

### Task 8: Main process IPC — events, approve, wire gate

**Depends-on:** Task 7 (`runAgentLoop` accepts `gate` / `onEvent` / stream)  
**Touches:** `src/main.js`, `src/preload.js`

**Baseline hooks (current code — extend, do not invent parallel chat APIs):**

| Location | Existing symbol | Phase A change |
|----------|-----------------|----------------|
| `src/main.js` | `ipcMain.handle('chat:send', …)` ~L145 | Create `runId`, build `PermissionGate`, pass `gate`/`onEvent`/`signal` into `runAgentLoop`; emit `chat:event` |
| `src/main.js` | `ipcMain.handle('chat:stop', …)` ~L138 | Also deny/resolve any pending approvals on active gate |
| `src/main.js` | `let activeChatAbort` + `confirmTerminal` (~L123 MessageBox) | Replace chat-path terminal confirm with gate; keep abort controller, expand active-run state |
| `src/main.js` | `runAgentLoop({ project, settings, messages, confirmTerminal, signal })` ~L197 | Drop `confirmTerminal`; add `gate`, `onEvent`, `sessionKey` from `payload.sessionId` |
| `src/main.js` | host `listTree` / `buildTreeReply` fast path ~L163 | Emit `tool-start`/`tool-end` + `done` events |
| `src/preload.js` | `sendChat` → `chat:send`, `stopChat` → `chat:stop` | Keep; **add** `onChatEvent`, `approveChat` |

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`

**Interfaces:**
- Produces:
  - `ipcMain.handle('chat:approve', …)` → `gate.resolveApproval` for active run
  - Active run state: `{ abort, gate, runId, sender }`
  - `chat:send` creates `runId`, `createPermissionGate` with:

```js
onApprovalNeeded: async (payload) => {
  sender.send('chat:event', {
    type: AGENT_EVENTS.APPROVAL_NEEDED,
    runId,
    ...payload,
  });
}
```

  - During agent: `onEvent: (e) => sender.send('chat:event', { runId, ...e })`
  - On start: `run-start`; on success `done` with final fields; on abort `aborted` + throw; on error `error` + throw
  - `toPublicSettings` includes `permissionMode`
  - `settings:save` validates permissionMode ∈ three values
  - Host listTree path also emits tool-start/end + done
  - Single-shot API/local: emit text-delta (full) + done
  - Remove MessageBox `confirmTerminal` usage from chat path

Preload:

```js
onChatEvent: (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on('chat:event', listener);
  return () => ipcRenderer.removeListener('chat:event', listener);
},
approveChat: (payload) => ipcRenderer.invoke('chat:approve', payload),
```

- [x] **Step 1: Implement main + preload (no Electron UI test; keep unit surface)**
- [x] **Step 2: Manual smoke optional via `npm start` later**
- [x] **Step 3: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(codex-qq): chat events and inline approval IPC"
```

---

### Task 9: Renderer — timeline, stream body, approval cards, settings

**Depends-on:** Task 8 (`onChatEvent` / `approveChat` on preload)  
**Touches:** `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/app.js`

**Baseline hooks (current code — extend):**

| Location | Existing symbol | Phase A change |
|----------|-----------------|----------------|
| `src/renderer/app.js` | `window.codex.sendChat(payload)` ~L553 | Keep invoke; add `sessionId`; drive UI primarily from `onChatEvent` |
| `src/renderer/app.js` | `window.codex.stopChat()` ~L65 | Keep; ensure approvals disable on abort |
| `src/renderer/app.js` | settings open/save fields for mode/agent/terminal | Add `#set-permission-mode` load/save |
| `src/preload.js` (after Task 8) | `onChatEvent`, `approveChat` | Wire global listener at boot |

**Files:**
- Modify: `src/renderer/index.html` — add permission mode select; update terminal confirm hint text
- Modify: `src/renderer/styles.css` — `.agent-timeline`, `.agent-step`, `.approval-card`, `.stream-body`
- Modify: `src/renderer/app.js` — event-driven send

**Interfaces:**
- Consumes: `window.codex.onChatEvent`, `approveChat`, `sendChat`, `stopChat`
- Behavior:
  - On send: append user message; create assistant placeholder with `data-run-id` pending; `setSending(true)`; subscribe events if not global
  - Prefer **one global** `onChatEvent` from boot that routes by `activeRunId`
  - `text-delta`: append to buffer; update stream body with escaped text
  - `tool-start`/`tool-end`: append timeline rows
  - `approval-needed`: render card with three buttons → `approveChat`
  - `done`: set message content from event or invoke result; `renderMarkdownLite`; clear sending
  - `aborted`/`error`: show state; setSending false
  - `sendChat` still awaited for final content / errors; if events already filled content, merge carefully (prefer done event content, then invoke result)
  - Pass `sessionId: activeSessionId` in sendChat payload
  - Settings open/save read/write `permissionMode` (`#set-permission-mode`)
  - Update agent checkbox label to mention grep/replace
  - Terminal confirm checkbox label: 「全自动时终端仍需确认」

HTML snippet for settings:

```html
<label class="field">
  <span>权限模式</span>
  <select id="set-permission-mode">
    <option value="read-only">只读（禁止写/删/终端）</option>
    <option value="confirm-writes" selected>写操作需确认（推荐）</option>
    <option value="full-auto">全自动</option>
  </select>
</label>
```

Approval card buttons (zh-CN): `允许` / `拒绝` / `本会话始终允许此类`

- [x] **Step 1: Implement HTML/CSS/JS**
- [x] **Step 2: Manual checklist from spec §7.2 items 1–7 if API available; otherwise code review logic paths**
- [x] **Step 3: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(codex-qq): agent timeline, streaming bubble, inline approvals"
```

---

### Task 10: README + full test suite + polish

**Depends-on:** Tasks 1–9  
**Touches:** `README.md`, any failing `tests/*`, checkbox updates in this plan

**Files:**
- Modify: `README.md`
- Fix any failing tests from integration

**README sections to add/update:**
- 权限模式三档说明 + 默认 confirm-writes 行为变化
- 新工具：grep / glob / search_replace
- 内联审批与停止
- AGENTS.md / CLAUDE.md
- maxAgentTurns 0 = unlimited（已有可保留）

**Acceptance (must all pass before calling Phase A done):**

1. **Automated:** `npm test` — all PASS  
2. **Manual** (map to capability design §7.2; skip live API items only if no key, and record skips):
   1. 绑定本仓库，grep `runAgentLoop` 有轨迹与命中  
   2. search_replace 改注释 → 内联审批 → 允许后仅局部变更  
   3. 拒绝写入 → 磁盘不变  
   4. allow_session 后再写 → 不再弹卡  
   5. read-only 下修改被拒  
   6. 正文流式出现（或无 stream 网关时整段 + 工具事件）  
   7. 审批挂起时停止 → 无续写  
   8. 根目录短 `AGENTS.md` 约束可观察  
   9. 无 tools 网关文本协议不崩  
   10. local 模式与 list 快路径可用  
3. This plan: Tasks 1–10 checkboxes all `[x]`

- [x] **Step 1: Run `npm test`** — all PASS
- [x] **Step 2: Update README**
- [x] **Step 3: Commit**

```bash
git add README.md tests/
git commit -m "docs(codex-qq): Phase A agent core usage and test polish"
```

- [x] **Step 4: Final status** — list commits; note manual QA remaining / skipped for live API

---

## Kickoff (M0)

Run before Task 1:

```bash
# From repo root
npm test
# Expected: all existing tests PASS (baseline regression gate on 9815e38 lineage)
```

Then start **Task 1** and proceed serially through Task 10.  
Recommended worker skill: `subagent-driven-development` (fresh subagent per task + review) or `executing-plans` (inline batches).

Do **not** implement Phase B/C items in these commits.

---

## Spec Coverage Check

| Spec requirement | Task |
|------------------|------|
| permissionMode default confirm-writes | 1, 8, 9 |
| AGENT_EVENTS constants | 1 |
| PermissionGate + allow_session + abort | 2, 7, 8 |
| Inline approval IPC (not MessageBox) | 8, 9 |
| search_replace rules | 4, 7 |
| read offset/limit | 4, 7 |
| grep + glob | 5, 7 |
| gitignore basic | 3, 5 |
| AGENTS.md / CLAUDE.md | 3, 7 |
| Stream content per turn + tool events | 6, 7, 8, 9 |
| Fallback non-stream / no-tools text protocol | 6, 7 (keep parseTextToolCalls) |
| write fence via gate | 7 |
| Host listTree events | 8 |
| ABORTED throw unified | 2, 6, 8 |
| README | 10 |
| Out of scope MCP/patch/diff panel | — not scheduled |

## Placeholder Scan

No TBD steps; code samples included for core modules. Task 7 mock `chatFn` is required if stream integration hard to test without it — implement `opts.chatFn` in `runAgentLoop`.

## Type Consistency

- Event types: kebab-case strings from `AGENT_EVENTS`
- Decisions: `'allow' | 'deny' | 'allow_session'`
- `permissionMode`: `'read-only' | 'confirm-writes' | 'full-auto'`
- `risk`: `'read' | 'write' | 'delete' | 'terminal'`
- Abort: `err.code === 'ABORTED'`
- sendChat payload: `{ messages, project, sessionId }`
- approveChat: `{ approvalId, decision }`

## Execution Notes

- **Only stage files listed in each task** when committing (avoid mixing unrelated dirty files).
- Prefer implementing Tasks 1–7 fully under `npm test` before Electron UI tasks 8–9.
- Repo-relative paths only; historical `D:\workspace\...` references are obsolete.
- Execution readiness context: `docs/superpowers/specs/2026-07-18-phase-a-execution-readiness-design.md`.
- After Task 10: update Status table at top of this plan to **Complete** and list final commit SHAs.
- After plan approval, use subagent-driven-development (one task per subagent) or executing-plans inline.
