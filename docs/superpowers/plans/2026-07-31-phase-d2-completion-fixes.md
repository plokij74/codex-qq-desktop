# Phase D.2 Completion Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified Phase D.2 gaps so long-term memory obeys its storage and injection safety contracts, works in unbound API chats, and has race-safe renderer commands.

**Architecture:** Keep the existing JSONL store, memory provider, and Agent loop. Harden data at the store boundary, enforce the token budget at the final formatted-fragment boundary, run unbound chats through a memory-only registry, and move renderer memory-command orchestration into a dependency-injected browser/CommonJS module that can be tested without a DOM framework.

**Tech Stack:** Electron 33, Node CommonJS, browser JavaScript, `node:test` + `node:assert/strict`, no new dependency.

## Global Constraints

- Do not add npm dependencies.
- User-visible copy remains zh-CN.
- Preserve current uncommitted Phase D.3 settings, URL guard, HTML extraction, and RED web-fetch test.
- A hand-edited JSONL row is untrusted: injected `text` is at most 1000 characters and tags are normalized on read.
- Missing memory files (`ENOENT`) are empty stores; all other read errors remain observable and become `{ ok: false, error }` at operation boundaries.
- The final formatted memory fragment, including header, entry prefixes, newlines, and footer, must not exceed `memoryInjectMaxTokens` under `approxTokensFromText`.
- The hard token budget governs over the old test expectation that the first full entry is always retained. Keep one truncated entry when the minimum 200-token budget has room; never exceed the budget.
- An unbound API chat may expose only `recall`, `remember`, and `forget` through its registry. It must not expose filesystem, terminal, git, skill execution, subagent, or MCP tools.
- Keep project-bound Agent behavior unchanged.
- Every production behavior change must first have a focused failing test whose failure is caused by the unfixed defect.

---

### Task 1: Harden memory-store read and canonicalization boundaries

**Files:**
- Modify: `src/ai/memory-store.js`
- Modify: `tests/memory-store.test.js`

**Interfaces:**
- Preserve public exports and return shapes.
- Add internal `normalizeEntryText(raw) -> string` and use it before dedupe and persistence.
- `readEntries(file, scope)` returns an empty store only for `ENOENT`; it throws other I/O errors for callers to translate.

- [ ] **Step 1: Add failing storage regression tests**

Append tests equivalent to:

```js
it('normalizes hand-edited rows to the persisted safety limits', () => {
  const { userDataPath } = tmpDirs();
  const file = memoryFilePath({ scope: 'user', userDataPath });
  fs.writeFileSync(file, JSON.stringify({
    id: 'm_manual', text: 'x'.repeat(TEXT_MAX + 500),
    tags: Array.from({ length: 12 }, (_, i) => ' TAG-' + i + '-'.repeat(10)),
    createdAt: 1, source: 'tool',
  }) + '\n');
  const { entries } = readEntries(file, 'user');
  assert.equal(entries[0].text.length, TEXT_MAX);
  assert.equal(entries[0].text.endsWith('…'), true);
  assert.equal(entries[0].tags.length, 8);
  assert.equal(entries[0].tags.every((tag) => tag.length <= 24), true);
});

it('dedupes repeated over-long input after canonical truncation', () => {
  const { userDataPath } = tmpDirs();
  const text = 'x'.repeat(TEXT_MAX + 500);
  const first = appendEntry({ scope: 'user', userDataPath, text, maxEntries: 200, now: 1 });
  const second = appendEntry({ scope: 'user', userDataPath, text, maxEntries: 200, now: 2 });
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(readEntries(memoryFilePath({ scope: 'user', userDataPath }), 'user').entries.length, 1);
});

it('treats ENOENT as empty but surfaces other read errors', () => {
  const { userDataPath } = tmpDirs();
  const file = memoryFilePath({ scope: 'user', userDataPath });
  assert.deepEqual(readEntries(file, 'user'), { entries: [], skipped: 0 });
  const realRead = fs.readFileSync;
  fs.readFileSync = () => Object.assign(new Error('denied'), { code: 'EACCES' });
  try { assert.throws(() => readEntries(file, 'user'), /denied/); }
  finally { fs.readFileSync = realRead; }
});

it('append and delete translate read failures to ok:false', () => {
  const { userDataPath } = tmpDirs();
  const realRead = fs.readFileSync;
  fs.readFileSync = () => Object.assign(new Error('denied'), { code: 'EACCES' });
  try {
    assert.equal(appendEntry({ scope: 'user', userDataPath, text: 'x' }).ok, false);
    assert.equal(deleteEntry({ scope: 'user', userDataPath, id: 'm_x' }).ok, false);
  } finally { fs.readFileSync = realRead; }
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/memory-store.test.js`

Expected: the new assertions fail because over-long input is deduped before truncation, hand-edited rows are not normalized, and `EACCES` is swallowed.

- [ ] **Step 3: Implement canonical storage boundaries**

Use one canonical text function for input and parsed rows:

```js
function normalizeEntryText(raw) {
  const clean = String(raw || '').trim();
  return clean.length > TEXT_MAX ? clean.slice(0, TEXT_MAX - 1) + '…' : clean;
}
```

In `readEntries`, catch only `ENOENT`; rethrow all other read errors. Normalize `text` and `tags` before returning an entry. In `appendEntry`, canonicalize before deriving the dedupe key. Wrap its read in the existing `{ ok:false }` operation contract. In `deleteEntry`, translate a read failure to `{ ok:false, error:'删除记忆失败：...' }`.

- [ ] **Step 4: Run GREEN and adjacent tests**

Run:

```powershell
node --test tests/memory-store.test.js tests/memory-ipc.test.js tests/memory-provider.test.js
```

Expected: all pass.

- [ ] **Step 5: Record report**

Write the RED command/output, implementation summary, GREEN command/output, and self-review to the task report. Git commit may remain pending because the sandbox has a read-only Git index.

---

### Task 2: Enforce the hard budget on the final injection fragment

**Files:**
- Modify: `src/ai/memory-recall.js`
- Modify: `src/ai/providers/memory.js`
- Modify: `tests/memory-recall.test.js`
- Modify: `tests/memory-provider.test.js`

**Interfaces:**
- Preserve `selectForInjection(...) -> Entry[]` and existing ranking semantics.
- Extend `formatInjection(entries, { writeHint?, maxApproxTokens? }) -> string`.
- The provider passes its clamped `memoryInjectMaxTokens` to both selection and final formatting.

- [ ] **Step 1: Add failing final-fragment budget tests**

Add literal-budget assertions:

```js
it('caps the complete formatted fragment and truncates the first entry if needed', () => {
  const maxApproxTokens = 200;
  const text = formatInjection([
    entry({ text: 'x'.repeat(1000), scope: 'project' }),
  ], { maxApproxTokens });
  assert.ok(text.includes('【长期记忆】'));
  assert.ok(text.includes('- (项目)'));
  assert.ok(approxTokensFromText(text) <= maxApproxTokens);
});

it('caps hand-edited oversized entries without losing the boundary header', () => {
  const text = formatInjection([
    entry({ text: 'x'.repeat(100000), scope: 'project' }),
  ], { maxApproxTokens: 200, writeHint: false });
  assert.ok(text.startsWith('【长期记忆】'));
  assert.ok(approxTokensFromText(text) <= 200);
});
```

Add a provider test that writes or supplies a maximum-size entry, sets `memoryInjectMaxTokens: 200`, and asserts the complete `getSystemFragment` result is at most 200 approximate tokens.

- [ ] **Step 2: Run RED**

Run: `node --test tests/memory-recall.test.js tests/memory-provider.test.js`

Expected: complete fragments exceed 200 approximate tokens.

- [ ] **Step 3: Bound the final formatter**

Build the fragment from fixed header/footer and entry lines under `maxApproxTokens * 4` characters, because D.1 defines `approxTokensFromText` as `ceil(chars / 4)`. Fold whitespace before measuring. Add complete lines while they fit; if the first line does not fit, keep its scope prefix and a truncated text ending in `…`. Return `''` only if even the fixed security header cannot fit. Do not slice the already-joined block because that can cut the boundary header or create a malformed line.

Pass the same clamped budget from `getSystemFragment` into `formatInjection`.

- [ ] **Step 4: Run GREEN and mutation checks**

Run:

```powershell
node --test tests/memory-recall.test.js tests/memory-provider.test.js
node -e "const r=require('./src/ai/memory-recall');const c=require('./src/ai/session-compact');const s=r.formatInjection([{text:'x'.repeat(100000),scope:'project'}],{maxApproxTokens:200});console.log(c.approxTokensFromText(s));if(c.approxTokensFromText(s)>200)process.exit(1)"
```

Expected: all tests pass and the probe prints a value no greater than 200.

- [ ] **Step 5: Record report**

Record RED/GREEN evidence and self-review.

---

### Task 3: Support a memory-only Agent in unbound API chats

**Files:**
- Modify: `src/ai/providers/index.js`
- Modify: `src/ai/agent-mode.js`
- Modify: `src/ai/agent.js`
- Modify: `src/main.js`
- Modify: `tests/agent-mode.test.js`
- Modify: `tests/agent.test.js`
- Modify: `tests/permission.test.js`
- Modify: `tests/memory-provider.test.js`

**Interfaces:**
- Add `createMemoryOnlyRegistry() -> Registry`, exporting it from `providers/index.js`.
- Add `shouldUseAgent({ settings, project }) -> boolean`, exporting it from `agent-mode.js` and consuming it in main.
- `runAgentLoop` accepts `project: null` only when its supplied registry is safe for that context.

- [ ] **Step 1: Add failing routing and unbound-loop tests**

Add routing expectations:

```js
assert.equal(shouldUseAgent({
  settings: { mode: 'api', agentEnabled: true, apiKey: 'k', memoryEnabled: true },
  project: null,
}), true);
assert.equal(shouldUseAgent({
  settings: { mode: 'api', agentEnabled: true, apiKey: 'k', memoryEnabled: false },
  project: null,
}), false);
```

Add an Agent integration test using `createMemoryOnlyRegistry`, a temporary `userDataPath`, a full-auto gate, and an injected `chatFn`. On the first turn the fake model asserts that tools are exactly `forget`, `recall`, and `remember`, and returns a `remember` tool call. On the second turn it returns final text. Assert the user memory file contains the remembered text and no project path is required.

Add a confirm-writes integration assertion that a `remember` approval summary contains at most the first 80 characters of its text. Strengthen the existing plan-mode assertions so both `remember` and `forget` are absent/blocked.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test tests/agent-mode.test.js tests/agent.test.js tests/permission.test.js tests/memory-provider.test.js
```

Expected: routing helper/export is absent, unbound `runAgentLoop` throws, and approval summary is only `remember`.

- [ ] **Step 3: Implement the memory-only path**

In `providers/index.js`, create a registry containing only `createMemoryProvider()`.

In `agent-mode.js`, implement the pure routing predicate. In `main.js`, replace the inline `useAgent` expression with it and pass `createMemoryOnlyRegistry()` when `project?.path` is absent.

In `runAgentLoop`:

- remove the unconditional missing-project rejection;
- set `verifyCmd` only with a project path;
- start hooks only with a project path;
- use a no-project system prompt that says no local project is bound and only advertised non-project tools are available;
- skip write-fence processing when no project is bound;
- keep all project-bound behavior byte-for-byte equivalent where practical.

Add `remember` and `forget` cases to `toolSummary`; `remember` uses the first 80 characters of normalized text.

- [ ] **Step 4: Run GREEN and focused integration**

Run:

```powershell
node --test tests/agent-mode.test.js tests/agent.test.js tests/permission.test.js tests/memory-provider.test.js
node --check src/ai/agent.js
node --check src/main.js
```

Expected: all pass.

- [ ] **Step 5: Record report**

Record RED/GREEN evidence and explicitly list the unbound tool names observed by the fake model.

---

### Task 4: Make renderer memory commands race-safe and testable

**Files:**
- Create: `src/renderer/memory-commands.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Create: `tests/renderer-memory-commands.test.js`

**Interfaces:**
- Browser global and CommonJS export: `CodexMemoryCommands.handleMemoryCommand(text, deps) -> boolean`.
- `deps` contains the captured `session`, `projectPath`, memory IPC functions, `toast`, and `onMessagesChanged(session)`.
- Export `deleteResultMessage(result) -> string` for settings-list deletion feedback.

- [ ] **Step 1: Create the failing CommonJS tests**

Test these observable behaviors with real promises and dependency functions:

```js
function depsFor(overrides = {}) {
  return {
    session: { id: 's1', messages: [] },
    projectPath: null,
    addMemory: async () => ({ ok: true, scope: 'user' }),
    listMemory: async () => ({ ok: true, entries: [], counts: { project: 0, user: 0 }, skipped: 0 }),
    deleteMemory: async () => ({ ok: true, removed: true }),
    toast() {},
    onMessagesChanged() {},
    ...overrides,
  };
}

it('handles bare remember as a usage error without calling IPC', () => {
  const toasts = [];
  let calls = 0;
  const handled = handleMemoryCommand('/remember', depsFor({
    addMemory: async () => { calls += 1; return { ok: true }; },
    toast: (message) => toasts.push(message),
  }));
  assert.equal(handled, true);
  assert.equal(calls, 0);
  assert.deepEqual(toasts, ['用法：/remember <要记住的事实>']);
});

it('handles bare forget as a usage error without calling IPC', () => {
  const toasts = [];
  let calls = 0;
  const handled = handleMemoryCommand('/forget', depsFor({
    deleteMemory: async () => { calls += 1; return { ok: true }; },
    toast: (message) => toasts.push(message),
  }));
  assert.equal(handled, true);
  assert.equal(calls, 0);
  assert.deepEqual(toasts, ['用法：/forget <id>，id 用 /memory 查看']);
});

it('appends an async memory listing to the captured session', async () => {
  const sessionA = { id: 'a', messages: [] };
  const sessionB = { id: 'b', messages: [] };
  let resolveList;
  let changedSession = null;
  const pending = new Promise((resolve) => { resolveList = resolve; });
  assert.equal(handleMemoryCommand('/memory', depsFor({
    session: sessionA,
    listMemory: () => pending,
    onMessagesChanged: (session) => { changedSession = session; },
  })), true);
  const activeSession = sessionB;
  resolveList({
    ok: true,
    entries: [{ id: 'm_1', scope: 'user', text: '回答一律中文' }],
    counts: { project: 0, user: 1 },
    skipped: 0,
  });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeSession.messages.length, 0);
  assert.equal(sessionA.messages.length, 1);
  assert.match(sessionA.messages[0].content, /回答一律中文/);
  assert.equal(changedSession, sessionA);
});

it('reports removed:false as not found', () => {
  assert.equal(deleteResultMessage({ ok: true, removed: false }), '未找到该 id');
});

it('returns false for unrelated slash commands', () => {
  assert.equal(handleMemoryCommand('/skills', depsFor()), false);
});
```

The async race test passes session A in `deps`, changes a separate active-session variable to B before resolving `listMemory`, and asserts only A receives the assistant message.

- [ ] **Step 2: Run RED**

Run: `node --test tests/renderer-memory-commands.test.js`

Expected: module not found.

- [ ] **Step 3: Implement and wire the controller**

Create a dependency-injected module with no DOM access. Recognize both the bare command and the command-plus-argument forms. Capture the passed session before starting any promise. For `/memory`, append to that captured session and call `onMessagesChanged(session)`.

Load `memory-commands.js` before `app.js` in `index.html`. Replace the three inline memory branches in `handleSlashCommand` with one delegation call. In `renderMemoryList`, use `deleteResultMessage` so `{ ok:true, removed:false }` is not reported as deleted.

- [ ] **Step 4: Run GREEN and syntax checks**

Run:

```powershell
node --test tests/renderer-memory-commands.test.js tests/memory-ipc.test.js
node --check src/renderer/memory-commands.js
node --check src/renderer/app.js
```

Expected: all pass.

- [ ] **Step 5: Record report**

Record RED/GREEN evidence and self-review.

---

### Task 5: D.2 acceptance regression and final review

**Files:**
- Modify: `.superpowers/sdd/2026-07-31-phase-d2-completion-fixes/progress.md`
- No production edits unless review finds a defect.

- [ ] **Step 1: Run the complete D.2-focused suite**

Run:

```powershell
node --test tests/settings.test.js tests/memory-store.test.js tests/memory-recall.test.js tests/permission.test.js tests/memory-provider.test.js tests/memory-ipc.test.js tests/agent-mode.test.js tests/agent.test.js tests/renderer-memory-commands.test.js
```

- [ ] **Step 2: Run the broad suite excluding the intentional D.3 RED file**

Run:

```powershell
node --test (Get-ChildItem tests -Filter '*.test.js' -Recurse | Where-Object { $_.Name -ne 'web-fetch.test.js' } | ForEach-Object { $_.FullName })
```

Expected: all executed tests pass. Also run `npm test` and confirm its only failure remains `tests/web-fetch.test.js` requiring the not-yet-created D.3 module.

- [ ] **Step 3: Run syntax and diff hygiene checks**

Run:

```powershell
node --check src/ai/memory-store.js
node --check src/ai/memory-recall.js
node --check src/ai/agent.js
node --check src/main.js
node --check src/preload.js
node --check src/renderer/memory-commands.js
node --check src/renderer/app.js
git diff --check
```

- [ ] **Step 4: Dispatch final D.2 completion review**

The reviewer receives the task reports and a working-tree review package containing only this repair plan's files. It must separately verdict spec compliance and code quality, and re-check the previously verified probes.

- [ ] **Step 5: Update the ledger**

Record test totals, the expected D.3-only failure, final review verdict, deferred minors, and the fact that Git commits remain pending if the read-only index still blocks them.
