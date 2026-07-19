# Phase C.1 Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase C.1 orchestration: session-level `plan | agent` mode with mandatory `submit_plan`, approve-to-run auto-execution, and soft `verifyCommand` gate before done—without MCP, sub-agents, or Skills.

**Architecture:** Single `runAgentLoop` takes `agentMode`. Plan mode filters tools and double-gates writes via PermissionGate. `submit_plan` emits `plan-ready`; renderer shows a plan card; `chat:approvePlan` switches session to agent, injects a synthetic user message, and starts a new run. Verify resolves a command (settings → package.json `scripts.test`) and, after successful writes, prompts the model (up to limited retries) to run it via `run_terminal`.

**Tech Stack:** Electron 33, plain Node.js CommonJS (no new deps), `node:test` via `npm test`, existing QQ renderer HTML/CSS/JS.

**Design spec:** `docs/superpowers/specs/2026-07-20-phase-c-orchestration-design.md`

## Global Constraints

- Repo-relative paths only; `contextIsolation: true`, `nodeIntegration: false`, API key only in main
- Abort: throw `Error` with `code: 'ABORTED'` and message matching `/已停止/`
- Default session mode: **`agent`**; default `permissionMode: 'confirm-writes'` unchanged
- **plan** mode: no write / delete / terminal / git_commit (tool list + Gate); **must** expose `submit_plan`
- **agent** mode: no `submit_plan` tool; permissionMode applies as in Phase A/B
- Approve-exec: switch to agent + **auto** send synthetic user message containing plan markdown
- Verify: **soft** gate only—never hard-block `git_commit` or `done`; max one extra repair prompt after failed verify
- No MCP / sub-agents / Skills / dual runAgentLoop rewrite / PLAN.md auto-save
- UI labels: zh-CN
- Tests: `node --test` via `npm test`; Linux may skip PowerShell live terminal tests
- CommonJS `module.exports`; frequent commits; Tasks **1 → 10 serially**
- Do not mix unrelated dirty files; do not start C.2 in these commits

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/ai/agent-events.js` | Modify | `PLAN_READY`, `VERIFY_RESULT`, optional `PLAN_APPROVED` / `PLAN_REJECTED` |
| `src/ai/settings.js` | Modify | `defaultAgentMode`, `verifyCommand`, `verifyBeforeDone` |
| `src/ai/agent-mode.js` | Create | normalize mode, blocked risks, tool filter helpers, approve message template, planId |
| `src/ai/verify.js` | Create | `resolveVerifyCommand(projectPath, settings)` |
| `src/ai/permission.js` | Modify | optional `agentMode` on authorize → deny write/delete/terminal in plan |
| `src/ai/agent.js` | Modify | `toolsForSettings(settings, { agentMode })`, `submit_plan`, loop mode/verify, system prompts |
| `src/main.js` | Modify | pass `agentMode`; `chat:approvePlan`; pending plan map; shared start-run helper if needed |
| `src/preload.js` | Modify | `approvePlan`, optional `rejectPlan` |
| `src/renderer/index.html` | Modify | mode toggle; settings fields |
| `src/renderer/styles.css` | Modify | mode control, plan card, verify strip |
| `src/renderer/app.js` | Modify | session.agentMode, plan card, approve flow, verify UI, disable mode while sending |
| `README.md` | Modify | Phase C.1 usage |
| `tests/settings.test.js` | Modify | new defaults |
| `tests/agent-mode.test.js` | Create | filter tools, message template, planId |
| `tests/verify.test.js` | Create | resolveVerifyCommand matrix |
| `tests/permission.test.js` | Modify | plan mode denies write |
| `tests/agent.test.js` | Modify | plan tools, submit_plan event, verify prompt turn |

---

### Task 1: Settings defaults + event constants

**Files:**
- Modify: `src/ai/settings.js`
- Modify: `src/ai/agent-events.js`
- Modify: `tests/settings.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SETTINGS.defaultAgentMode === 'agent'`
  - `DEFAULT_SETTINGS.verifyCommand === ''`
  - `DEFAULT_SETTINGS.verifyBeforeDone === true`
  - `AGENT_EVENTS.PLAN_READY === 'plan-ready'`
  - `AGENT_EVENTS.VERIFY_RESULT === 'verify-result'`
  - `AGENT_EVENTS.PLAN_APPROVED === 'plan-approved'` (optional but implement for UI)
  - `AGENT_EVENTS.PLAN_REJECTED === 'plan-rejected'`

- [ ] **Step 1: Write failing tests** in `tests/settings.test.js`

```js
it('defaults Phase C.1 orchestration settings', () => {
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');
  assert.equal(DEFAULT_SETTINGS.defaultAgentMode, 'agent');
  assert.equal(DEFAULT_SETTINGS.verifyCommand, '');
  assert.equal(DEFAULT_SETTINGS.verifyBeforeDone, true);
});

it('AGENT_EVENTS includes plan and verify names', () => {
  const { AGENT_EVENTS } = require('../src/ai/agent-events');
  assert.equal(AGENT_EVENTS.PLAN_READY, 'plan-ready');
  assert.equal(AGENT_EVENTS.VERIFY_RESULT, 'verify-result');
  assert.equal(AGENT_EVENTS.PLAN_APPROVED, 'plan-approved');
  assert.equal(AGENT_EVENTS.PLAN_REJECTED, 'plan-rejected');
});
```

- [ ] **Step 2: Run to fail**

Run: `node --test tests/settings.test.js`  
Expected: FAIL missing keys/events

- [ ] **Step 3: Implement**

`src/ai/settings.js` — add to `DEFAULT_SETTINGS`:

```js
defaultAgentMode: 'agent', // plan | agent — only seeds new sessions
verifyCommand: '', // empty = auto-detect; 'none' or '-' disables
verifyBeforeDone: true,
```

`src/ai/agent-events.js` — add:

```js
PLAN_READY: 'plan-ready',
PLAN_APPROVED: 'plan-approved',
PLAN_REJECTED: 'plan-rejected',
VERIFY_RESULT: 'verify-result',
```

- [ ] **Step 4: Pass tests**

Run: `node --test tests/settings.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ai/settings.js src/ai/agent-events.js tests/settings.test.js
git commit -m "feat(codex-qq): Phase C.1 settings and plan/verify event constants"
```

---

### Task 2: `agent-mode.js` pure helpers

**Files:**
- Create: `src/ai/agent-mode.js`
- Create: `tests/agent-mode.test.js`

**Interfaces:**
- Produces:
  - `normalizeAgentMode(value) → 'plan' | 'agent'` (invalid → `'agent'`)
  - `PLAN_BLOCKED_RISKS = new Set(['write','delete','terminal'])`
  - `isPlanBlockedRisk(risk) → boolean`
  - `filterToolsForMode(toolDefs, agentMode) → toolDefs`  
    - plan: drop write/delete/terminal/git_commit tools by name; **keep** only if later submit_plan is in list  
    - agent: drop `submit_plan`
  - `makePlanId() → string` like `plan_${Date.now().toString(36)}_...`
  - `buildApproveExecutionMessage({ title, markdown }) → string` (exact Chinese template from spec)
  - `PLAN_MARKDOWN_MAX = 32 * 1024`
  - `truncatePlanMarkdown(md) → { text, truncated }`

Tool names blocked in plan (exact):

```js
const PLAN_HIDDEN_TOOLS = new Set([
  'search_replace', 'write_file', 'delete_path',
  'git_commit', 'run_terminal',
]);
```

`buildApproveExecutionMessage`:

```js
function buildApproveExecutionMessage({ title, markdown }) {
  const head = title ? `# ${title}\n\n` : '';
  return [
    '请严格按以下已批准计划执行。不要重新规划，除非发现计划不可行。',
    '',
    head + String(markdown || '').trim(),
  ].join('\n');
}
```

- [ ] **Step 1: Failing tests**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAgentMode,
  isPlanBlockedRisk,
  filterToolsForMode,
  buildApproveExecutionMessage,
  truncatePlanMarkdown,
  PLAN_MARKDOWN_MAX,
} = require('../src/ai/agent-mode');

describe('agent-mode', () => {
  it('normalizeAgentMode', () => {
    assert.equal(normalizeAgentMode('plan'), 'plan');
    assert.equal(normalizeAgentMode('agent'), 'agent');
    assert.equal(normalizeAgentMode('nope'), 'agent');
    assert.equal(normalizeAgentMode(null), 'agent');
  });

  it('isPlanBlockedRisk', () => {
    assert.equal(isPlanBlockedRisk('write'), true);
    assert.equal(isPlanBlockedRisk('read'), false);
  });

  it('filterToolsForMode plan hides writes and keeps submit_plan', () => {
    const defs = [
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } },
      { function: { name: 'submit_plan' } },
      { function: { name: 'run_terminal' } },
      { function: { name: 'git_commit' } },
    ];
    const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
    assert.deepEqual(plan.sort(), ['read_file', 'submit_plan'].sort());
    const agent = filterToolsForMode(defs, 'agent').map((t) => t.function.name);
    assert.ok(agent.includes('write_file'));
    assert.ok(!agent.includes('submit_plan'));
  });

  it('buildApproveExecutionMessage contains plan body', () => {
    const m = buildApproveExecutionMessage({ title: 'T', markdown: '步骤 1' });
    assert.match(m, /已批准计划/);
    assert.match(m, /# T/);
    assert.match(m, /步骤 1/);
  });

  it('truncatePlanMarkdown', () => {
    const big = 'x'.repeat(PLAN_MARKDOWN_MAX + 100);
    const r = truncatePlanMarkdown(big);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= PLAN_MARKDOWN_MAX + 80); // allow suffix note
  });
});
```

- [ ] **Step 2–4: Implement, pass, commit**

```bash
git add src/ai/agent-mode.js tests/agent-mode.test.js
git commit -m "feat(codex-qq): agent-mode helpers for plan filter and approve message"
```

---

### Task 3: `verify.js` resolveVerifyCommand

**Files:**
- Create: `src/ai/verify.js`
- Create: `tests/verify.test.js`

**Interfaces:**

```js
/**
 * @param {string|null} projectPath
 * @param {{ verifyCommand?: string }} settings
 * @returns {string|null}
 */
function resolveVerifyCommand(projectPath, settings)
```

Logic (exact):

1. Let `raw = String(settings?.verifyCommand ?? '').trim()`
2. If `raw` length > 0:
   - if `/^(none|-)$/i.test(raw)` → return `null`
   - else return `raw`
3. If no `projectPath` → return `null`
4. Try read `path.join(projectPath, 'package.json')` UTF-8 JSON
5. If `scripts && scripts.test` (string or exists) → return `'npm test'`
6. Else `null`

- [ ] **Step 1: Tests** with temp dirs

```js
it('settings wins', () => {
  assert.equal(resolveVerifyCommand('/x', { verifyCommand: 'pnpm test' }), 'pnpm test');
});
it('none disables', () => {
  assert.equal(resolveVerifyCommand('/x', { verifyCommand: 'none' }), null);
  assert.equal(resolveVerifyCommand('/x', { verifyCommand: '-' }), null);
});
it('package.json scripts.test → npm test', () => {
  const root = fs.mkdtempSync(...);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  assert.equal(resolveVerifyCommand(root, { verifyCommand: '' }), 'npm test');
});
it('no test script → null', () => {
  const root = fs.mkdtempSync(...);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'a' }));
  assert.equal(resolveVerifyCommand(root, {}), null);
});
```

- [ ] **Step 2–4: Implement, pass, commit**

```bash
git add src/ai/verify.js tests/verify.test.js
git commit -m "feat(codex-qq): resolveVerifyCommand for Phase C.1 soft verify"
```

---

### Task 4: PermissionGate plan mode deny

**Files:**
- Modify: `src/ai/permission.js`
- Modify: `tests/permission.test.js`

**Interfaces:**
- `createPermissionGate({ ..., agentMode })` optional; default `'agent'`
- `authorize({ ..., agentMode })` — if effective mode is plan and `effectiveRisk` in write/delete/terminal → deny with reason  
  `'当前为计划模式，仅允许只读与提交计划'`
- Prefer per-call `agentMode` over gate constructor default when provided

Also export nothing new required beyond behavior.

- [ ] **Step 1: Test**

```js
it('plan mode denies write even in full-auto', async () => {
  const gate = createPermissionGate({
    permissionMode: 'full-auto',
    terminalEnabled: true,
    agentMode: 'plan',
    onApprovalNeeded: async () => {},
  });
  const r = await gate.authorize({ tool: 'write_file', risk: 'write', sessionKey: 's' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /计划模式/);
});

it('plan mode allows read', async () => {
  const gate = createPermissionGate({
    permissionMode: 'full-auto',
    agentMode: 'plan',
    onApprovalNeeded: async () => {},
  });
  const r = await gate.authorize({ tool: 'read_file', risk: 'read', sessionKey: 's' });
  assert.equal(r.allowed, true);
});
```

- [ ] **Step 2: Implement** at start of `authorize` after computing `effectiveRisk`:

```js
const mode = normalizeAgentMode(arguments agentMode ?? gateAgentMode);
// or inline: mode === 'plan' without requiring agent-mode if you want zero dep — prefer require('./agent-mode').isPlanBlockedRisk
if (mode === 'plan' && isPlanBlockedRisk(effectiveRisk)) {
  return { allowed: false, reason: '当前为计划模式，仅允许只读与提交计划' };
}
```

- [ ] **Step 3–4: Pass + commit**

```bash
git add src/ai/permission.js tests/permission.test.js
git commit -m "feat(codex-qq): PermissionGate denies writes in plan mode"
```

---

### Task 5: Agent tools — `submit_plan` + `toolsForSettings(mode)`

**Files:**
- Modify: `src/ai/agent.js`
- Modify: `tests/agent.test.js`

**Interfaces:**
- Extend `TOOL_DEFS` with `submit_plan` (schema from spec)
- Change:

```js
function toolsForSettings(settings, opts = {}) {
  const agentMode = normalizeAgentMode(opts.agentMode);
  let tools = TOOL_DEFS.slice();
  if (!settings.terminalEnabled) {
    tools = tools.filter((t) => t.function.name !== 'run_terminal');
  }
  return filterToolsForMode(tools, agentMode);
}
```

- `riskForTool('submit_plan')` → already defaults to write via unknown → **must fix**:

In `permission.js` READ_TOOLS add `'submit_plan'` OR handle in `riskForTool`:

```js
if (toolName === 'submit_plan') return 'read';
```

(Do this in permission.js in this task if not done.)

- `executeToolFixed` / execute path for `submit_plan`:
  - validate markdown trim length >= 10
  - truncate markdown via `truncatePlanMarkdown`
  - `planId = makePlanId()`
  - `onEvent` PLAN_READY — **need onEvent on ctx**: ensure execute ctx gets `onEvent` (already for terminal)
  - return JSON `{ ok:true, planId, message:'计划已提交，等待用户批准执行' }`

- `toolSummary` / `toolDetail` for submit_plan

- [ ] **Step 1: Tests**

```js
it('toolsForSettings plan exposes submit_plan not write_file', () => {
  const plan = toolsForSettings({ terminalEnabled: true }, { agentMode: 'plan' }).map((t) => t.function.name);
  assert.ok(plan.includes('submit_plan'));
  assert.ok(!plan.includes('write_file'));
  assert.ok(!plan.includes('run_terminal'));
  const agent = toolsForSettings({ terminalEnabled: false }, { agentMode: 'agent' }).map((t) => t.function.name);
  assert.ok(!agent.includes('submit_plan'));
  assert.ok(agent.includes('write_file'));
});

it('riskForTool submit_plan is read', () => {
  assert.equal(riskForTool('submit_plan'), 'read');
});
```

- [ ] **Step 2–4: Implement TOOL_DEFS + filter + execute submit_plan + commit**

```bash
git add src/ai/agent.js src/ai/permission.js tests/agent.test.js tests/permission.test.js
git commit -m "feat(codex-qq): submit_plan tool and mode-aware toolsForSettings"
```

---

### Task 6: `runAgentLoop` agentMode + system prompt + submit_plan in loop

**Files:**
- Modify: `src/ai/agent.js`
- Modify: `tests/agent.test.js`

**Interfaces:**
- `runAgentLoop({ ..., agentMode })`  
  `const mode = normalizeAgentMode(agentMode);`  
  `const tools = toolsForSettings(settings, { agentMode: mode });`  
  system: `agentSystemPrompt(project, settings, { agentMode: mode, verifyCmd })`

- `agentSystemPrompt` third arg:
  - if plan: append plan rules (must submit_plan, no claims of writes)
  - if agent and verifyCmd: append verify instruction

- Wire `authorizeTool` to pass `agentMode: mode` into gate

- Create gate in main will also get agentMode (Task 7); loop must pass mode into authorizeTool

- On successful submit_plan in tool loop: already emits via execute; ensure ctx includes onEvent

- [ ] **Step 1: Integration test**

```js
it('plan mode submit_plan emits plan-ready and cannot write', async () => {
  const root = fs.mkdtempSync(...);
  fs.writeFileSync(path.join(root, 'a.js'), 'x\n');
  const events = [];
  let turn = 0;
  const chatFn = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: {
            name: 'submit_plan',
            arguments: JSON.stringify({
              title: '改 a',
              markdown: '1. 修改 a.js\n2. 跑测试\n3. 完成',
              steps: ['改 a', '测试'],
            }),
          },
        }],
      };
    }
    return { role: 'assistant', content: '计划已交，等待批准' };
  };
  const result = await runAgentLoop({
    project: { name: 't', path: root },
    settings: { terminalEnabled: false, maxAgentTurns: 4, permissionMode: 'full-auto' },
    messages: [{ role: 'user', content: '规划一下' }],
    gate: createPermissionGate({
      permissionMode: 'full-auto',
      agentMode: 'plan',
      terminalEnabled: false,
      onApprovalNeeded: async () => {},
    }),
    agentMode: 'plan',
    onEvent: (e) => events.push(e),
    chatFn,
    sessionKey: 'plan1',
  });
  assert.ok(events.some((e) => e.type === 'plan-ready' || e.type === AGENT_EVENTS.PLAN_READY));
  assert.match(result.content, /计划|批准/);
  // write attempt test: second test with write_file tool call → ok false, disk unchanged
});

it('plan mode write_file tool_call does not write disk', async () => {
  // mock first turn write_file; gate plan; assert file unchanged and agentLog ok false
});
```

- [ ] **Step 2–4: Implement system prompt branches + pass agentMode through authorizeTool + tests green + commit**

```bash
git add src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): runAgentLoop plan mode system prompt and wiring"
```

---

### Task 7: Verify soft gate inside `runAgentLoop`

**Files:**
- Modify: `src/ai/agent.js`
- Modify: `tests/agent.test.js`

**Interfaces / run state:**

```js
const verifyCmd = settings.verifyBeforeDone === false
  ? null
  : resolveVerifyCommand(project.path, settings);
let verifyPrompted = false;
let verifyRepairPrompted = false;
let verifySucceeded = false;
// When run_terminal completes successfully and command trims equal verifyCmd → verifySucceeded = true; emit VERIFY_RESULT
```

**Before final return** (after fence handling, before footer), when model returns final text without tool_calls:

```js
const hadSuccessfulWrite = fileChanges.some(...) || applied.some(a => a.ok && !a.error);
// use fileChanges length or applied with write modes

if (
  mode === 'agent'
  && verifyCmd
  && settings.verifyBeforeDone !== false
  && hadSuccessfulWrite
  && settings.terminalEnabled
  && !verifySucceeded
  && (unlimited || turn < maxTurns)
) {
  if (!verifyPrompted) {
    verifyPrompted = true;
    working.push({
      role: 'user',
      content: `请立即使用 run_terminal 执行项目验证命令（不要改命令）：\n${verifyCmd}\n根据输出修复问题或总结结果。`,
    });
    continue; // next turn
  }
  if (!verifyRepairPrompted && /* last terminal for verify failed */) {
    verifyRepairPrompted = true;
    working.push({
      role: 'user',
      content: `验证命令未通过。请根据失败输出尽量修复，并再次 run_terminal：\n${verifyCmd}\n若无法修复请说明原因。`,
    });
    continue;
  }
  // allow done with skipped/incomplete
  onEvent?.({ type: VERIFY_RESULT, command: verifyCmd, ok: false, skipped: true, summary: '未完成验证' });
}
```

Detect verify success: in tool_end path for `run_terminal`, if `String(args.command).trim() === verifyCmd` and result ok → emit VERIFY_RESULT ok:true, set verifySucceeded.

If terminal disabled and had writes: emit verify-result skipped once on done path (optional).

- [ ] **Step 1: Test** — mock model: turn1 write_file, turn2 final without terminal → assert working got verify prompt (inspect via chatFn calls count >= 3 or content includes verify command)

```js
it('after write, prompts verify before done when verifyCommand set', async () => {
  // settings: terminalEnabled true, verifyCommand: 'npm test', full-auto, maxAgentTurns 6
  // turn1: write_file, turn2: final text, turn3 after prompt: final "done"
  // assert chatFn called >= 3 OR events include verify-result
});
```

- [ ] **Step 2–4: Implement + commit**

```bash
git add src/ai/agent.js tests/agent.test.js
git commit -m "feat(codex-qq): soft verifyCommand gate before agent done"
```

---

### Task 8: Main IPC — agentMode on send + approvePlan

**Files:**
- Modify: `src/main.js`
- Modify: `src/preload.js`

**Interfaces:**

**Pending plans (main memory):**

```js
/** @type {Map<string, { planId, title, markdown, steps, sessionId }>} */
const pendingPlansBySession = new Map();
```

On `plan-ready` event from agent (in emit wrapper or agent onEvent): store by `payload.sessionId`.

**chat:send:**

```js
const agentMode = normalizeAgentMode(payload.agentMode);
const gate = createPermissionGate({
  ...,
  agentMode,
  onApprovalNeeded: ...
});
// runAgentLoop({ ..., agentMode })
// when emitting events, if type plan-ready, pendingPlansBySession.set(sessionId, {...})
```

**chat:approvePlan:**

```js
ipcMain.handle('chat:approvePlan', async (event, payload = {}) => {
  const sessionId = payload.sessionId;
  const planId = payload.planId;
  const pending = pendingPlansBySession.get(sessionId);
  if (!pending || pending.planId !== planId) {
    return { ok: false, error: '计划不存在或已更新' };
  }
  if (activeRun) {
    return { ok: false, error: '请先停止当前生成再批准执行' };
  }
  const markdown = pending.markdown;
  const title = pending.title;
  const content = buildApproveExecutionMessage({ title, markdown });
  // emit plan-approved
  safeSend(event.sender, 'chat:event', {
    type: AGENT_EVENTS.PLAN_APPROVED,
    planId,
    sessionId,
  });
  // Start agent run with agentMode 'agent' and messages: payload.messages + { role:'user', content }
  // Reuse internal helper startChatRun(event, { ...payload, agentMode: 'agent', messages: [...] })
  // Return { ok: true, agentMode: 'agent', userMessage: { role:'user', content } }
});
```

**Refactor note:** Extract body of `chat:send` into `async function startChatRun(event, payload)` so approvePlan can call it without duplication. Keep behavior identical for normal send.

**preload:**

```js
approvePlan: (payload) => ipcRenderer.invoke('chat:approvePlan', payload),
rejectPlan: (payload) => ipcRenderer.invoke('chat:rejectPlan', payload), // optional: emit PLAN_REJECTED and clear pending
```

**chat:rejectPlan:** clear pendingPlansBySession entry; emit plan-rejected; return ok.

- [ ] **Step 1: Implement + manual reasoning; unit-test pure pieces already covered**

- [ ] **Step 2: `npm test` green**

- [ ] **Step 3: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(codex-qq): chat:approvePlan and agentMode on chat:send"
```

---

### Task 9: Renderer — mode toggle, plan card, verify strip, settings

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`

**Session model:**

```js
// when creating sessions:
agentMode: settings.defaultAgentMode === 'plan' ? 'plan' : 'agent',
// migrate old sessions: if s.agentMode missing → 'agent'
```

**UI — mode toggle** near composer or session header:

```html
<div class="agent-mode-toggle" id="agent-mode-toggle">
  <button type="button" data-mode="plan" class="mode-btn">计划</button>
  <button type="button" data-mode="agent" class="mode-btn is-active">执行</button>
</div>
```

- Click sets `session.agentMode`, updates active class, `saveState()`
- While `sending` / chatRun active: disable toggle

**sendMessage payload:**

```js
agentMode: activeSession()?.agentMode || 'agent',
```

**plan-ready handler:**

```js
function renderPlanCard(ev) {
  // similar to approval card
  // store chatRun.pendingPlanId = ev.planId
  // buttons: 批准执行 / 驳回
  // 批准: 
  //   1. session.agentMode = 'agent'; update toggle UI; saveState
  //   2. append user message content from build template client-side OR wait for main return
  //   Prefer: call approvePlan; on ok, push returned userMessage to session.messages; start chatRun streaming like send
}
```

Approve flow detail (write-dead):

1. Disable buttons on card  
2. `const res = await window.codex.approvePlan({ sessionId, planId })`  
3. if !res.ok → toast error; re-enable  
4. session.agentMode = 'agent'; saveState; update toggle  
5. Push `res.userMessage` to session.messages if provided  
6. Open assistant placeholder / setSending true — main already started run; listen onChatEvent for same session (runId from events)  
7. If main returns full result like sendChat, mirror sendMessage finalize path

**Important:** Today `sendChat` is invoke that resolves on done. approvePlan should **also** return the final agent result the same way as chat:send (reuse startChatRun return value) so renderer can finalize identically.

**verify-result handler:** append strip under timeline:

- ✅ 验证通过 (`cmd`)  
- ❌ 验证失败  
- ⚠ 未验证  

**Settings modal:** add fields for `defaultAgentMode` select, `verifyCommand` text input, optional checkbox verifyBeforeDone; save in existing saveSettings.

- [ ] **Step 1: Implement UI + wire**

- [ ] **Step 2: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(codex-qq): plan/agent mode UI, plan card, verify strip"
```

---

### Task 10: README + full suite + polish polish

**Files:**
- Modify: `README.md`
- Touch-up any gaps from Tasks 1–9

**README section Phase C.1:**

| 能力 | 说明 |
|------|------|
| 计划 / 执行 | 会话切换；计划模式只读 + submit_plan |
| 批准执行 | 自动切入执行并按计划开跑 |
| 验证命令 | 设置 verifyCommand；空则探测 npm test；none 禁用 |

- [ ] **Step 1: Update README**

- [ ] **Step 2: Full `npm test`**

Expected: all pass; 0 fail (skips OK)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(codex-qq): Phase C.1 plan mode and verify usage in README"
```

- [ ] **Step 4: Manual checklist (human)** — document in report, not blocking commit:
  - [ ] plan 下无法写文件  
  - [ ] submit_plan → 卡 → 批准 → 自动执行  
  - [ ] 有写盘后出现验证提示/结果  
  - [ ] run 中无法切换 mode  

---

## Self-Review (plan vs spec)

| Spec requirement | Task(s) |
|------------------|---------|
| Session plan\|agent | 1, 2, 6, 9 |
| plan tool filter + Gate | 2, 4, 5, 6 |
| submit_plan mandatory in plan | 5, 6 |
| plan-ready + plan card | 5, 6, 9 |
| approve → agent + auto message | 2, 8, 9 |
| activeRun blocks approve | 8 |
| permissionMode after agent | 4, 6, 8 |
| resolveVerifyCommand priority | 3 |
| soft verify after writes | 7 |
| UI verify strip | 9 |
| settings defaults | 1, 9, 10 |
| No MCP/sub-agent/Skills | Global + all tasks |
| Tests / README | throughout + 10 |

**Placeholder scan:** none intentional.  
**Type consistency:** `agentMode` string `'plan'|'agent'`; events `plan-ready` / `verify-result`; `planId` from `makePlanId`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-20-phase-c-orchestration.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with executing-plans checkpoints  

**Which approach?**
