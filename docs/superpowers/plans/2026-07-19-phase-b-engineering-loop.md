# Phase B Engineering Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase B engineering loop so users can fix a bug, review unified diffs, run commands in a panel, and commit locally—without leaving the QQ client.

**Architecture:** Four micro-subsystems (Diff, Git, Terminal panel, `@`-ref) share Phase A’s PermissionGate and `chat:event` channel. Writes under `confirm-writes` compute unified diff **before** disk I/O and only apply after Accept; `full-auto` writes immediately and emits a read-only change list. Git tools use `execFile` (no shell). Terminal panel reuses `runTerminal` with chunk callbacks. `@` refs expand on send only (history stores user text).

**Tech Stack:** Electron 33, plain Node.js CommonJS (no new deps), `node:test` via `npm test`, existing QQ renderer HTML/CSS/JS.

**Design spec:** `docs/superpowers/specs/2026-07-19-phase-b-engineering-loop-design.md`

## Global Constraints

- Repo-relative paths only; `contextIsolation: true`, `nodeIntegration: false`, API key only in main
- Abort: throw `Error` with `code: 'ABORTED'` and message matching `/已停止/`
- Default `permissionMode: 'confirm-writes'`; commit risk = **`write`** (same session allow as file writes)
- No PTY, no push/PR/branch, no `apply_patch`, no default `git add -A`, no AST `@`
- Diff granularity = **one approval per tool call** (serial)
- UI labels: zh-CN
- Tests: `node --test` via `npm test`; Linux without `powershell.exe` may skip real terminal spawn tests
- Follow existing CommonJS `module.exports` style
- Execute Tasks **1 → 12 serially**; do not start Phase C in these commits
- Frequent commits; do not mix unrelated dirty files

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/ai/diff.js` | Create | `computeUnifiedDiff`, `truncateDiff`, `countLineStats`, text detection helper |
| `src/ai/git.js` | Create | `findGitRoot`, `gitStatus`, `gitDiff`, `gitCommit` via `execFile` |
| `src/ai/at-ref.js` | Create | `parseAtRefs`, `completeAtPath`, `expandAtRefs` + caps |
| `src/ai/agent-events.js` | Modify | `FILE_CHANGE`, `TERMINAL_START`, `TERMINAL_OUTPUT`, `TERMINAL_END` |
| `src/ai/permission.js` | Modify | `riskForTool` for `git_*`; pass `diff` through approval payload |
| `src/ai/project-fs.js` | Modify | `previewSearchReplace` (no write); optional dry helpers |
| `src/ai/terminal.js` | Modify | `onStdout` / `onStderr` chunk callbacks |
| `src/ai/agent.js` | Modify | Pre-diff authorize write path; git tools; terminal events; fileChanges; fence diff |
| `src/main.js` | Modify | `terminal:*`, `atRef:*`, optional `git:*` IPC; expand-on-send hook |
| `src/preload.js` | Modify | Expose new APIs |
| `src/renderer/index.html` | Modify | Terminal panel markup; optional changes strip host |
| `src/renderer/styles.css` | Modify | Diff block, changes strip, terminal panel, `@` popup |
| `src/renderer/app.js` | Modify | Diff in approval card; fileChanges UI; terminal panel; `@` complete |
| `README.md` | Modify | Phase B usage |
| `tests/diff.test.js` | Create | Diff pure functions |
| `tests/git.test.js` | Create | Temp git repo |
| `tests/at-ref.test.js` | Create | Parse/expand/complete/safety |
| `tests/agent.test.js` | Modify | Diff gate order, fileChanges, git tools, terminal events |
| `tests/permission.test.js` | Modify | git_commit risk / read-only deny |
| `tests/terminal.test.js` | Create or modify | Chunk callbacks (mock-friendly) |

---

### Task 1: Event constants + riskForTool for git

**Files:**
- Modify: `src/ai/agent-events.js`
- Modify: `src/ai/permission.js`
- Modify: `tests/permission.test.js`

**Interfaces:**
- Consumes: existing `AGENT_EVENTS`, `riskForTool`, `READ_TOOLS` / `WRITE_TOOLS`
- Produces:
  - `AGENT_EVENTS.FILE_CHANGE === 'file-change'`
  - `AGENT_EVENTS.TERMINAL_START === 'terminal-start'`
  - `AGENT_EVENTS.TERMINAL_OUTPUT === 'terminal-output'`
  - `AGENT_EVENTS.TERMINAL_END === 'terminal-end'`
  - `riskForTool('git_status') === 'read'`, `riskForTool('git_diff') === 'read'`, `riskForTool('git_commit') === 'write'`

- [ ] **Step 1: Write the failing tests**

Add to `tests/permission.test.js`:

```js
const { riskForTool } = require('../src/ai/permission');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

// inside describe('permission', ...) or new describe:
it('riskForTool classifies git tools', () => {
  assert.equal(riskForTool('git_status'), 'read');
  assert.equal(riskForTool('git_diff'), 'read');
  assert.equal(riskForTool('git_commit'), 'write');
});

it('AGENT_EVENTS includes Phase B event names', () => {
  assert.equal(AGENT_EVENTS.FILE_CHANGE, 'file-change');
  assert.equal(AGENT_EVENTS.TERMINAL_START, 'terminal-start');
  assert.equal(AGENT_EVENTS.TERMINAL_OUTPUT, 'terminal-output');
  assert.equal(AGENT_EVENTS.TERMINAL_END, 'terminal-end');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/permission.test.js`  
Expected: FAIL (missing events and/or git risks)

- [ ] **Step 3: Implement**

`src/ai/agent-events.js` — add:

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
  FILE_CHANGE: 'file-change',
  TERMINAL_START: 'terminal-start',
  TERMINAL_OUTPUT: 'terminal-output',
  TERMINAL_END: 'terminal-end',
};
```

`src/ai/permission.js` — update sets:

```js
const READ_TOOLS = new Set([
  'list_dir', 'read_file', 'grep', 'glob',
  'git_status', 'git_diff',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'search_replace', 'git_commit',
]);
// delete_path → delete; run_terminal → terminal (unchanged)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/permission.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent-events.js src/ai/permission.js tests/permission.test.js
git commit -m "feat(codex-qq): Phase B event constants and git tool risks"
```

---

### Task 2: `diff.js` pure helpers

**Files:**
- Create: `src/ai/diff.js`
- Create: `tests/diff.test.js`

**Interfaces:**
- Consumes: none (pure)
- Produces:
  - `computeUnifiedDiff(path, beforeText, afterText) → { path, text, stats: { additions, deletions }, isBinary: boolean }`
  - `truncateDiff(text, { maxBytes = 32768, maxLines = 400 } = {}) → { text, truncated: boolean }`
  - `isProbablyText(bufOrString) → boolean` (reject NUL / high binary ratio for short samples)

Algorithm for `computeUnifiedDiff` (no external lib):

1. If either side looks binary → `{ text: '', stats: { additions: 0, deletions: 0 }, isBinary: true, path }` (caller shows path-only card).
2. Split both on `/\r?\n/` (keep simple; do not require final newline equality gymnastics beyond line arrays).
3. Line-level LCS or simpler **Myers-lite / hunk by scan**: acceptable Phase B approach — produce unified format:
   ```
   --- a/<path>
   +++ b/<path>
   @@ -start,count +start,count @@
   context/add/del lines
   ```
   Minimal acceptable implementation: if files small, emit full-file replace hunk (`-` every before line, `+` every after line) when LCS is heavy; **prefer** a simple line-diff:
   - Walk with two pointers; equal lines as context (` `); runs of unequal as del/add.
   - Or use a compact implementation of longest common subsequence on lines with max line cap (e.g. if `beforeLines.length + afterLines.length > 10000`, fall back to full replace hunk + stats by line count).

4. `stats.additions` = count of `+` content lines (not `+++` header); `deletions` = count of `-` content lines.

`truncateDiff`: if `text` exceeds maxLines or maxBytes, keep first ~60% lines and last ~20% lines with middle marker `\n... diff truncated ...\n`; set `truncated: true`. Stats must **not** be recomputed from truncated text (callers keep original stats).

- [ ] **Step 1: Write failing tests** in `tests/diff.test.js`

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeUnifiedDiff, truncateDiff, isProbablyText } = require('../src/ai/diff');

describe('diff', () => {
  it('computeUnifiedDiff detects simple replace', () => {
    const r = computeUnifiedDiff('a.js', 'const x = 1;\n', 'const x = 2;\n');
    assert.equal(r.isBinary, false);
    assert.ok(r.stats.deletions >= 1);
    assert.ok(r.stats.additions >= 1);
    assert.match(r.text, /a\.js/);
    assert.match(r.text, /const x = 2/);
  });

  it('computeUnifiedDiff empty before is all additions', () => {
    const r = computeUnifiedDiff('new.txt', '', 'hello\n');
    assert.ok(r.stats.additions >= 1);
    assert.equal(r.stats.deletions, 0);
  });

  it('truncateDiff marks truncated and shortens', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { text, truncated } = truncateDiff(lines, { maxLines: 50, maxBytes: 1e9 });
    assert.equal(truncated, true);
    assert.match(text, /truncated/i);
    assert.ok(text.split('\n').length < 500);
  });

  it('isProbablyText rejects NUL', () => {
    assert.equal(isProbablyText('a\0b'), false);
    assert.equal(isProbablyText('hello\n'), true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/diff.test.js`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement `src/ai/diff.js`** (full file)

Implement the three exports as specified. Keep under ~200 lines. Export:

```js
module.exports = {
  computeUnifiedDiff,
  truncateDiff,
  isProbablyText,
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/diff.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/diff.js tests/diff.test.js
git commit -m "feat(codex-qq): unified diff helpers for Phase B approvals"
```

---

### Task 3: Preview helpers + Gate passes `diff`

**Files:**
- Modify: `src/ai/project-fs.js` — add `previewSearchReplace`
- Modify: `src/ai/permission.js` — `authorize` / `waitForApproval` forward `diff`
- Modify: `tests/project-fs.test.js`
- Modify: `tests/permission.test.js` (optional: assert approval payload includes diff when provided)

**Interfaces:**
- Produces:
  - `previewSearchReplace(projectRoot, relPath, oldString, newString, opts?) → { path, before, after, replacements }` — **no disk write**; same uniqueness rules as `searchReplace`
  - `gate.authorize({ ..., diff })` → `onApprovalNeeded` receives `diff` field unchanged

- [ ] **Step 1: Failing test for preview**

```js
it('previewSearchReplace does not write disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pfs-'));
  const p = path.join(root, 'a.js');
  fs.writeFileSync(p, 'const x = 1;\n');
  const { previewSearchReplace } = require('../src/ai/project-fs');
  const r = previewSearchReplace(root, 'a.js', 'const x = 1;', 'const x = 2;');
  assert.equal(r.after, 'const x = 2;\n');
  assert.equal(fs.readFileSync(p, 'utf8'), 'const x = 1;\n');
});
```

- [ ] **Step 2: Run fail → implement previewSearchReplace**

Copy logic from `searchReplace` but return `{ path, before: text, after: next, replacements }` without `writeFileSync`.

- [ ] **Step 3: Gate `diff` passthrough**

In `createPermissionGate`:

```js
async function waitForApproval(payload, signal) {
  // ...
  if (typeof onApprovalNeeded === 'function') {
    await onApprovalNeeded({
      approvalId,
      tool: payload.tool,
      risk: payload.risk,
      summary: payload.summary,
      detail: payload.detail,
      path: payload.path,
      diff: payload.diff, // may be undefined
    });
  }
  // ...
}

async function authorize({ tool, risk, summary, detail, path, sessionKey, signal, diff } = {}) {
  // ... same mode logic ...
  const decisionResult = await waitForApproval(
    { tool, risk: effectiveRisk, summary, detail, path, diff },
    signal,
  );
  // ...
}
```

- [ ] **Step 4: Tests pass + commit**

```bash
git add src/ai/project-fs.js src/ai/permission.js tests/project-fs.test.js tests/permission.test.js
git commit -m "feat(codex-qq): previewSearchReplace and approval diff payload"
```

---

### Task 4: Agent write path — diff-before-write + fileChanges

**Files:**
- Modify: `src/ai/agent.js` (core of Phase B)
- Modify: `tests/agent.test.js`

**Interfaces:**
- Consumes: `computeUnifiedDiff`, `truncateDiff`, `previewSearchReplace`, `readFile`/`writeFile`/`deletePath`
- Produces:
  - Write tools authorize with `detail` = truncated unified diff text (or path-only for binary/delete-dir)
  - `authorizeTool` accepts and forwards `diff`
  - On successful write/delete: `onEvent({ type: FILE_CHANGE, path, op, stats })`
  - `runAgentLoop` return + final path includes `fileChanges: [{ path, op, stats }]`
  - `done` emission in main should pass `fileChanges` (Task 5 if main emits done; agent return value must include it)

**Critical control flow change** (replace “authorize then executeToolFixed writes” for mutating tools):

For `search_replace` | `write_file` | `delete_path` inside the tool loop:

```js
// 1) Build before/after in memory (no write yet)
let before = '';
let after = '';
let op = 'write';
let previewMeta = {};

if (name === 'search_replace') {
  const prev = previewSearchReplace(project.path, rel, args.old_string, args.new_string, {
    replaceAll: args.replace_all === true || args.replaceAll === true,
  });
  // preview throws on no match / non-unique — catch → tool error JSON, skip authorize
  before = prev.before;
  after = prev.after;
  previewMeta = { replacements: prev.replacements };
  op = 'write';
} else if (name === 'write_file') {
  // read existing if any
  try {
    const full = /* resolve via read or exists */;
    before = fs.existsSync(...) ? fs.readFileSync(..., 'utf8') : '';
  } catch { before = ''; }
  after = String(args.content ?? '');
  op = before ? 'write' : 'create';
} else if (name === 'delete_path') {
  // if file: before = content; after = ''; op = 'delete'
  // if dir: diff = null; detail = `递归删除目录: ${rel}`
}

const computed = computeUnifiedDiff(rel, before, after);
const trunc = computed.isBinary
  ? { text: '', truncated: false }
  : truncateDiff(computed.text);
const diffPayload = computed.isBinary
  ? { path: rel, stats: computed.stats, text: '', truncated: false, isBinary: true }
  : { path: rel, stats: computed.stats, text: trunc.text, truncated: trunc.truncated, isBinary: false };

const detailForGate = computed.isBinary
  ? `二进制或无法生成 diff：${rel}`
  : (trunc.text || `删除: ${rel}`);

const auth = await authorizeTool({
  ...,
  detail: detailForGate,
  path: rel,
  diff: diffPayload,
});

if (!auth.allowed) {
  resultStr = JSON.stringify({ ok: false, error: auth.reason || '未授权' });
} else {
  // ONLY NOW call searchReplace / writeFile / deletePath
  resultStr = await executeToolFixed(...);
  if (parsed.ok) {
    fileChanges.push({ path: rel, op, stats: computed.stats });
    onEvent?.({
      type: AGENT_EVENTS.FILE_CHANGE,
      path: rel,
      op,
      stats: computed.stats,
    });
  }
}
```

Also update `applyWriteFencesWithGate` similarly: compute diff from before/after, pass `diff` into authorize, emit `FILE_CHANGE`.

Extend `authorizeTool` to pass `diff` into `gate.authorize`.

Initialize `const fileChanges = []` in `runAgentLoop`; include in return object:

```js
return { content, applied, agentLog, toolsSupported, fileChanges };
```

- [ ] **Step 1: Failing agent tests**

```js
it('confirm-writes search_replace deny leaves disk unchanged and approval has diff shape', async () => {
  // gate that captures last approval payload via onApprovalNeeded
  // first tool turn: search_replace; gate always denies
  // assert file unchanged
});

it('full-auto write emits file-change and returns fileChanges', async () => {
  // fullAutoGate; mock model write_file; assert events include file-change; result.fileChanges length >= 1
});
```

Wire `onApprovalNeeded` in test gate by using real `createPermissionGate` with mode confirm-writes and a resolver that denies after inspecting payload — or a custom gate mock:

```js
const approvals = [];
const gate = {
  authorize: async (p) => {
    approvals.push(p);
    return { allowed: false, reason: '用户拒绝' };
  },
};
```

Assert `approvals[0].diff` has `stats` and `text` or isBinary.

- [ ] **Step 2: Implement agent changes**

- [ ] **Step 3: `npm test` green for agent + permission + diff**

- [ ] **Step 4: Commit**

```bash
git add src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): diff-before-write and fileChanges in agent loop"
```

---

### Task 5: Renderer — approval diff + fileChanges strip; main `done` payload

**Files:**
- Modify: `src/main.js` — when emitting `done`, include `fileChanges` from agent result
- Modify: `src/renderer/app.js` — `renderApprovalCard` shows `ev.diff`; handle `file-change`; on `done` show changes strip
- Modify: `src/renderer/styles.css` — `.appr-diff`, `.file-changes-strip`
- Modify: `src/renderer/index.html` only if a permanent host node is needed (prefer inject under timeline)

**UI rules:**

- If `ev.diff?.text`, render `<pre class="appr-diff">` with escaped text (in addition to or instead of plain `detail` if detail duplicates diff — prefer **diff pre** when `diff.text` non-empty; keep summary line).
- If `ev.diff?.isBinary`, show note「二进制文件，无文本 diff」.
- If `ev.diff?.truncated`, show「（diff 已截断，+a/-d）」using stats.
- On `file-change` events, append path to `chatRun.fileChanges` array.
- On `done`, if `ev.fileChanges?.length` or accumulated list, append a collapsed strip under timeline: 「本轮改动 (N)」listing paths; optional click expands nothing more than path list in Phase B (diff already was on cards for confirm-writes).

Main.js pattern (find where DONE is emitted):

```js
emit({
  type: AGENT_EVENTS.DONE,
  content: result.content,
  applied: result.applied,
  fileChanges: result.fileChanges || [],
});
```

- [ ] **Step 1: Implement UI + main**

- [ ] **Step 2: Manual smoke not required in CI; keep unit tests if any pure helpers**

- [ ] **Step 3: Commit**

```bash
git add src/main.js src/renderer/app.js src/renderer/styles.css src/renderer/index.html
git commit -m "feat(codex-qq): approval unified diff UI and fileChanges strip"
```

---

### Task 6: `git.js` core

**Files:**
- Create: `src/ai/git.js`
- Create: `tests/git.test.js`

**Interfaces:**

```js
// All paths relative to projectRoot; resolveSafe before git add
findGitRoot(startDir) → string | null

gitStatus(projectRoot, { signal } = {}) →
  { ok, branch, entries: [{ path, xy, index, worktree }], summary, error? }

gitDiff(projectRoot, { path, staged, maxBytes = 32768, signal } = {}) →
  { ok, text, truncated, staged, error? }

gitCommit(projectRoot, { message, paths, stage = true, signal } = {}) →
  { ok, commit, branch, summary, error? }
```

Implementation notes:

- `const { execFile } = require('child_process');` promisify manually with timeout + abort kill.
- `git -C <repo> ...` where `repo = findGitRoot(projectRoot) || projectRoot`.
- Status: `git status --porcelain=v1 -b` parse first line `## branch...` and entry lines `XY path`.
- Diff: `git diff --` or `git diff --cached --` plus optional path; truncate with same maxBytes.
- Commit:
  1. Validate message non-empty
  2. If `paths?.length`: for each path `resolveSafe(projectRoot, p)`; then `git add -- <paths>`; if `stage === false` return error
  3. If no paths: do not add; run `git diff --cached --quiet` — if exit 0 (no staged), fail「没有可提交的暂存变更」
  4. `git commit -m <message>` (message as arg, not shell)
  5. `git rev-parse --short HEAD` + branch name for return
- Never `--no-verify`, never `--amend`, never `git add -A`.

- [ ] **Step 1: Failing tests** using temp dir:

```js
const { execFileSync } = require('child_process');
// init repo
execFileSync('git', ['init'], { cwd: root });
execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
execFileSync('git', ['add', 'a.txt'], { cwd: root });
execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n');

const st = await gitStatus(root);
assert.ok(st.ok);
assert.ok(st.entries.some((e) => e.path === 'a.txt' || e.path.endsWith('a.txt')));

const d = await gitDiff(root, { path: 'a.txt' });
assert.ok(d.ok);
assert.match(d.text, /v2/);

const c = await gitCommit(root, { message: 'update a', paths: ['a.txt'] });
assert.ok(c.ok);
assert.ok(c.commit);
```

Skip suite if `git` binary missing (`execFileSync('git',['--version'])` fails).

- [ ] **Step 2: Implement `src/ai/git.js`**

- [ ] **Step 3: Pass tests + commit**

```bash
git add src/ai/git.js tests/git.test.js
git commit -m "feat(codex-qq): git status/diff/commit helpers"
```

---

### Task 7: Register git tools in agent

**Files:**
- Modify: `src/ai/agent.js` — TOOL_DEFS, executeToolFixed, toolSummary/Detail/Path, system prompt line
- Modify: `tests/agent.test.js`

**TOOL_DEFS add:**

```js
{
  type: 'function',
  function: {
    name: 'git_status',
    description: 'Show git working tree status (branch + changed files).',
    parameters: { type: 'object', properties: { short: { type: 'boolean' } } },
  },
},
{
  type: 'function',
  function: {
    name: 'git_diff',
    description: 'Show git diff for worktree or staged changes. Optional path filter.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        staged: { type: 'boolean' },
      },
    },
  },
},
{
  type: 'function',
  function: {
    name: 'git_commit',
    description: 'Stage optional paths and create a git commit. Does not push. Does not git add -A unless paths listed.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        stage: { type: 'boolean' },
      },
      required: ['message'],
    },
  },
},
```

**executeToolFixed cases:** call `gitStatus` / `gitDiff` / `gitCommit` with `ctx.signal`; return `JSON.stringify(result)`.

**Authorization:** existing loop already calls `authorizeTool` with `riskForTool(name)` — commit gets write; status/diff get read auto-allow.

For `git_commit` under confirm-writes, enrich `detail` before authorize:

```js
if (name === 'git_commit') {
  detail = [
    `message: ${args.message}`,
    args.paths?.length ? `paths: ${args.paths.join(', ')}` : 'paths: (已暂存 only)',
  ].join('\n');
  // optional: append short gitDiff staged preview if paths staged first — keep simple in v1: message+paths only
}
```

Note: authorize runs **before** execute; staging happens inside `gitCommit` after allow — detail lists intended paths (correct).

- [ ] **Step 1: Test TOOL_DEFS includes git_* ; mock loop commits in temp repo with full-auto**

- [ ] **Step 2: Implement + `npm test`**

- [ ] **Step 3: Commit**

```bash
git add src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): agent git_status/git_diff/git_commit tools"
```

---

### Task 8: Optional read-only Git IPC (thin)

**Files:**
- Modify: `src/main.js` — `git:status`, `git:diff`
- Modify: `src/preload.js`

```js
// preload
gitStatus: (projectPath) => ipcRenderer.invoke('git:status', { projectPath }),
gitDiff: (projectPath, opts) => ipcRenderer.invoke('git:diff', { projectPath, ...opts }),
```

Main: validate projectPath string, call `git.js`. No commit IPC (commit only via agent tool) — matches spec.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(codex-qq): read-only git status/diff IPC"
```

---

### Task 9: Terminal chunk callbacks + agent terminal events

**Files:**
- Modify: `src/ai/terminal.js` — call `opts.onStdout?.(chunk)`, `opts.onStderr?.(chunk)` on data
- Modify: `src/ai/agent.js` — when running `run_terminal`, emit TERMINAL_START / OUTPUT / END with `termId`, `source: 'agent'`
- Create: `tests/terminal-panel.test.js` or extend agent tests with mock runTerminal via dependency — if `runTerminal` is hard-required, test chunk hooks with a unit test that mocks child_process only if already patterned; else test agent with inject:

Prefer extending `runTerminal` and unit-testing with skip when no powershell — still assert `onStdout` is invoked when probe succeeds; on Linux skip execution but **always** test that options are accepted (spy by monkeypatching module in test).

Simplest solid test:

```js
// tests/terminal-callbacks.test.js
it('runTerminal invokes onStdout when available', async (t) => {
  // skip without powershell
  // else Write-Output hello and collect chunks
});
```

Agent integration: in `executeTool`/`executeToolFixed` for run_terminal:

```js
const termId = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
ctx.onEvent?.({
  type: AGENT_EVENTS.TERMINAL_START,
  termId,
  command,
  cwd: root,
  source: 'agent',
});
const result = await runTerminal(root, command, {
  timeoutMs: ...,
  signal: ctx.signal,
  onStdout: (chunk) => ctx.onEvent?.({
    type: AGENT_EVENTS.TERMINAL_OUTPUT, termId, stream: 'stdout', chunk: String(chunk),
  }),
  onStderr: (chunk) => ctx.onEvent?.({
    type: AGENT_EVENTS.TERMINAL_OUTPUT, termId, stream: 'stderr', chunk: String(chunk),
  }),
});
ctx.onEvent?.({
  type: AGENT_EVENTS.TERMINAL_END,
  termId,
  code: result.code,
  ok: result.ok,
  timedOut: result.timedOut,
  aborted: result.aborted,
  summary: `exit=${result.code}`,
});
```

Pass `onEvent` into executeToolFixed ctx from the loop (already has gate/signal — add onEvent).

- [ ] **Step 1–4: TDD + implement + commit**

```bash
git add src/ai/terminal.js src/ai/agent.js tests/*.test.js
git commit -m "feat(codex-qq): terminal output events for panel"
```

---

### Task 10: Terminal panel UI + manual run IPC

**Files:**
- Modify: `src/main.js` — session-scoped manual terminal controller:
  - `terminal:run` `{ sessionId, projectPath, command, cwd? }`
  - `terminal:stop` `{ sessionId }`
  - `terminal:clear` optional
- Modify: `src/preload.js`
- Modify: `src/renderer/index.html` — bottom panel under `#view-chat` or after message-list:

```html
<div id="terminal-panel" class="terminal-panel collapsed">
  <div class="terminal-head">
    <button type="button" id="btn-term-toggle">终端</button>
    <button type="button" id="btn-term-stop" class="hidden">停止命令</button>
    <button type="button" id="btn-term-clear">清空</button>
  </div>
  <div id="terminal-output" class="terminal-output"></div>
  <div class="terminal-input-row">
    <input id="terminal-input" type="text" placeholder="在项目根执行一条命令…" />
    <button type="button" id="btn-term-run">运行</button>
  </div>
</div>
```

- Modify: `src/renderer/styles.css` — QQ-ish bottom panel, monospace output, stderr color
- Modify: `src/renderer/app.js`:
  - Subscribe to `terminal-*` via existing `onChatEvent` **and/or** same channel (main emits `chat:event` for manual runs too with `runId: null` or `source:user` — **write dead: use `chat:event` with types terminal-*** so one listener works)
  - Manual run: require active session project + settings.terminalEnabled
  - Chat stop does **not** call `terminal:stop`
  - Only one manual run at a time (disable input while running)
  - Fold state in `localStorage` key `codex-qq-term-collapsed`

**Main manual run authorization:**

```js
const gate = createPermissionGate({ /* same settings as chat */ 
  onApprovalNeeded: async (p) => {
    safeSend(sender, 'chat:event', { type: APPROVAL_NEEDED, ...p, runId: activeRun?.runId });
  },
});
// Problem: if no activeRun, approvals need a gate instance stored for terminal
```

**Write-dead pattern:** keep `manualTerm = { abort, gate, sessionId }` separate from `activeRun`. `chat:approve` tries `activeRun.gate` first, then `manualTerm.gate`.

```js
ipcMain.handle('chat:approve', async (_e, payload) => {
  const gates = [activeRun?.gate, manualTerm?.gate].filter(Boolean);
  for (const g of gates) {
    if (g.resolveApproval(approvalId, normalized)) {
      // emit APPROVAL_RESOLVED
      return { ok: true };
    }
  }
  return { ok: false, error: '无待审批项' };
});
```

- [ ] **Step 1: Implement main + preload + UI**

- [ ] **Step 2: Commit**

```bash
git add src/main.js src/preload.js src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(codex-qq): terminal panel with manual run"
```

---

### Task 11: `@` ref parse / expand / complete

**Files:**
- Create: `src/ai/at-ref.js`
- Create: `tests/at-ref.test.js`

**Interfaces:**

```js
const DEFAULT_CAPS = {
  maxFileBytes: 64 * 1024,
  maxFileLines: 2000,
  maxRangeLines: 500,
  maxRefs: 20,
  maxTotalBytes: 200 * 1024,
  maxTreeEntries: 200,
  dirPreviewFiles: 5,
  dirPreviewBytes: 2048,
  completeLimit: 20,
};

parseAtRefs(text) → [{ raw, path, startLine?, endLine?, index }]
// Ignore content inside ``` fences and `inline code`

completeAtPath(projectRoot, prefix, { limit } = {}) → [{ path, type: 'file'|'dir' }]
// Use gitignore via loadGitignoreRules + walk or globFiles

expandAtRefs(projectRoot, text, caps = DEFAULT_CAPS) → {
  contextBlock,  // string fence body or full fenced block
  refs: [...],
  warnings: string[],
}
```

Context format:

````text
```context:refs
### file: src/ai/agent.js:10-40
...lines...
### dir: src/ai
(tree text)
```
````

Safety: every path through `resolveSafe`; `..` fails that ref with warning.

- [ ] **Step 1: Write comprehensive tests** (parse multi, fence ignore, line range, budget, traversal)

- [ ] **Step 2: Implement**

- [ ] **Step 3: Pass + commit**

```bash
git add src/ai/at-ref.js tests/at-ref.test.js
git commit -m "feat(codex-qq): @file parse expand and complete"
```

---

### Task 12: Wire `@` into send path + composer UI + README

**Files:**
- Modify: `src/main.js` — `atRef:complete`, `atRef:expand`; in `chat:send`, before agent, expand last user message if project bound:

```js
// Prefer expand inside chat:send:
const { expandAtRefs } = require('./ai/at-ref');
// clone messages; find last user; 
const expanded = expandAtRefs(project.path, userText);
const modelUserText = expanded.contextBlock
  ? `${userText}\n\n${expanded.contextBlock}`
  : userText;
// use modelUserText in messages fed to runAgentLoop
// do NOT change what renderer stores (renderer already pushed original text)
```

Important: renderer currently sends `messages` including the new user message with original text — main should rewrite only the **copy** passed to the model, not require renderer to pre-expand (renderer may still call complete for UX).

- Modify: `src/preload.js` — `atRefComplete`, `atRefExpand` (expand optional if only main send expands)
- Modify: `src/renderer/app.js` — on `input`/`keyup` of `#chat-input`, detect `@` token, call complete, show popup list; Tab/Enter insert path
- Modify: `src/renderer/styles.css` — `.at-complete-popup`
- Modify: `src/ai/agent.js` `agentSystemPrompt` — one line: 用户消息中的 `context:refs` 代码块是用户显式附加的文件内容
- Modify: `README.md` — Phase B section: diff 审批、git 工具、终端面板、`@文件` 语法

- [ ] **Step 1: Implement wire-up**

- [ ] **Step 2: Full `npm test`**

Expected: all pass; 0 fail (skips OK)

- [ ] **Step 3: Commit**

```bash
git add src/main.js src/preload.js src/renderer/app.js src/renderer/styles.css src/ai/agent.js README.md
git commit -m "feat(codex-qq): @file composer and send-time expand; Phase B README"
```

- [ ] **Step 4: Final checklist against spec §9.2** (document in commit message or leave for human QA)

---

## Self-Review (plan vs spec)

| Spec requirement | Task(s) |
|------------------|---------|
| Diff confirm-writes before write | 2, 3, 4 |
| full-auto direct write + fileChanges list | 4, 5 |
| Per-tool-call approval granularity | 4 (serial loop unchanged) |
| Approval card unified diff + truncate | 2, 4, 5 |
| file-change + done.fileChanges | 1, 4, 5 |
| git_status / git_diff / git_commit | 6, 7 |
| No push / no add -A | 6 |
| commit risk = write | 1, 7 |
| Terminal panel + manual one-shot | 9, 10 |
| No PTY; chat stop ≠ term stop | 10 |
| @ multi/file/range/dir + caps | 11, 12 |
| History stores original only | 12 |
| Shared PermissionGate | all |
| Micro-module files diff/git/at-ref | 2, 6, 11 |

**Placeholder scan:** none intentional.  
**Type consistency:** event names and `fileChanges` / `diff` payload shapes match across tasks 1–5.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-phase-b-engineering-loop.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute in this session with executing-plans checkpoints  

**Which approach?**
