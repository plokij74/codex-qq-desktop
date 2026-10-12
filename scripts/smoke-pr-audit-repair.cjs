'use strict';

// Real Electron renderer/preload/IPC, D13/D5 and local Git. GitHub and the
// model are fakes; all files, profiles and the bare origin live in a temp dir.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process'); const assert = require('node:assert/strict');
  const { createWorktreeManager } = require('../src/ai/worktree');
  const { createWorktreeIpcHandlers } = require('../src/ai/worktree-ipc');
  const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
  const { createPrAuditManager } = require('../src/ai/pr-audit-manager');
  const { createCiWatchManager } = require('../src/ai/ci-watch-manager');
  const { createSubagentRuntime } = require('../src/ai/subagent-runtime');
  const { createPermissionGate } = require('../src/ai/permission');
  const { runTerminal } = require('../src/ai/terminal');
  const { repositoryKey } = require('../src/ai/remote-ci-state');
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');
  const { runRecheck } = require('../src/ai/pr-audit-recheck-runtime');
  const followupMode = process.argv.includes('--recheck-repair');
  const trackingMode = process.argv.includes('--tracking');
  const recheckMode = followupMode || process.argv.includes('--recheck');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), followupMode ? 'codex-d20-smoke-' : 'codex-d18-smoke-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  for (const flag of ['no-sandbox', 'disable-gpu', 'disable-software-rasterizer', 'disable-gpu-compositing']) app.commandLine.appendSwitch(flag);
  const root = path.join(profile, 'repo'); const origin = path.join(profile, 'origin.git'); fs.mkdirSync(root); fs.mkdirSync(origin);
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  git(['init', '--bare', '-q'], origin); git(['init', '-q']); git(['config', 'user.name', 'D18 Smoke']); git(['config', 'user.email', 'd18@example.test']);
  git(['config', 'core.autocrlf', 'false']); git(['branch', '-M', 'main']); git(['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(root, 'src'));
  const original = 'function first(xs) {\n  return xs[0];\n}\nmodule.exports = first;\n';
  fs.writeFileSync(path.join(root, 'src/app.js'), original);
  fs.writeFileSync(path.join(root, 'check.cjs'), "const assert = require('node:assert/strict'); const first = require('./src/app'); assert.equal(first([]), null); assert.equal(first(null), null); assert.equal(first([3]), 3); console.log('Local validation passed');\n");
  git(['add', '.']); git(['commit', '-qm', 'PR base']); const baseHead = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'feature/audit']); fs.writeFileSync(path.join(root, 'src/app.js'), original.replace('xs[0]', 'xs.at(0)'));
  git(['add', '.']); git(['commit', '-qm', 'PR head']); const remoteHead = git(['rev-parse', 'HEAD']);
  git(['push', '-q', 'origin', 'main', 'feature/audit']); git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(root, 'local.txt'), 'local only\n'); git(['add', '.']); git(['commit', '-qm', 'local head']);
  const localHead = git(['rev-parse', 'HEAD']); const beforeRefs = git(['show-ref']);
  const repo = { host: 'github.com', owner: 'example', repo: 'demo', nameWithOwner: 'example/demo' };
  const repoKey = repositoryKey(repo.host, repo.nameWithOwner);
  const state = { head: remoteHead, audits: 0, rechecks: 0, generations: 0, pushes: 0, validations: 0, watches: 0, reviews: 0, replies: 0, resolves: 0 };
  const validationProfile = { id: 'vfy_' + 'a'.repeat(16), name: '本地输入检查', kind: 'test', command: 'node check.cjs', cwd: '.', timeoutMs: 10000, enabled: true };
  function auditPr() { return { number: 7, state: 'open', merged: false, title: '为空输入添加处理', body: 'D18 本地桌面验收',
    headSha: state.head, baseSha: baseHead, headRefName: 'feature/audit', baseRefName: 'main', headRepo: repo.nameWithOwner, baseRepo: repo.nameWithOwner, changedFiles: 1 }; }
  function pr() { return { ...auditPr(), state: 'OPEN', isDraft: true, isCrossRepository: false, headRepository: { nameWithOwner: repo.nameWithOwner }, repository: { nameWithOwner: repo.nameWithOwner },
    url: 'https://github.com/example/demo/pull/7', author: 'smoke-author', checks: [], checksSummary: {}, files: [{ path: 'src/app.js', additions: 1, deletions: 1 }], comments: [], mergeable: 'UNKNOWN' }; }
  const github = {
    runCommand: async (command, args) => {
      assert.equal(command, 'git');
      try { return { ok: true, stdout: execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }; }
      catch (error) { return { ok: false, stderr: String(error.stderr || '') }; }
    },
    repository: async () => ({ ok: true, remote: repo, nameWithOwner: repo.nameWithOwner, base: 'main' }),
    listPrs: async () => ({ ok: true, prs: [pr()], truncated: false }),
    getPr: async () => ({ ok: true, pr: pr() }), getChecks: async () => ({ ok: true, checks: [], summary: {} }),
    getReviewThreads: async () => ({ ok: true, pr: { ...pr(), reviewThreads: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } }),
    getAuditPr: async () => auditPr(), getAuditMergeBase: async () => baseHead,
    getAuditFiles: async () => {
      const diff = git(['diff', '--no-ext-diff', baseHead, state.head, '--', 'src/app.js']);
      return [{ filename: 'src/app.js', status: 'modified', additions: 1, deletions: 1, sha: git(['rev-parse', `${state.head}:src/app.js`]), patch: diff.slice(diff.indexOf('@@')) + '\n' }];
    },
    createAuditReview: async () => { state.reviews++; throw new Error('Unexpected Review publication'); },
    replyReviewThread: async () => { state.replies++; throw new Error('Unexpected reply'); },
    resolveReviewThread: async () => { state.resolves++; throw new Error('Unexpected resolution'); },
    fetchBranchToRef: async ({ targetRef }) => { git(['update-ref', targetRef, state.head]); return { ok: true }; },
    resolveCommit: async ({ ref }) => ({ ok: true, head: git(['rev-parse', ref]) }),
    deleteInternalRef: async ({ ref }) => { git(['update-ref', '-d', ref]); return { ok: true }; },
    branchTip: async () => ({ ok: true, head: state.head }),
    exactLeasePush: async ({ oldHead, newCommit }) => {
      assert.equal(oldHead, state.head); assert.equal(git(['rev-list', '--parents', '-n', '1', newCommit]), `${newCommit} ${oldHead}`);
      // The local bare origin simulates GitHub receiving this exact commit.
      git(['fetch', '--no-write-fetch-head', '--no-tags', '--refmap=', root, newCommit], origin);
      git(['update-ref', 'refs/heads/feature/audit', newCommit, oldHead], origin);
      state.pushes++; state.head = newCommit; return { ok: true };
    },
    getCiWatchRepository: async () => ({ ok: true, repository: { ...repo, repoKey, repoRoot: root } }),
    getCiWatchOrigin: async () => ({ ok: true, repoKey }), getCiPrStatus: async () => ({ ok: true, pr: pr() }),
    getCiRunsForHead: async () => ({ ok: true, runs: [{ id: '123', name: 'Tests', headSha: state.head, runAttempt: 1, status: 'in_progress', conclusion: '' }] }),
  };
  let win; let engineering; let audits; let generationFailure;
  const unexpected = []; const rendererErrors = []; const network = []; const approvals = [];
  const worktreeManager = createWorktreeManager({ githubCli: github });
  for (const name of ['preflightRemoteCreate', 'createAtCommit']) {
    const operation = worktreeManager[name];
    worktreeManager[name] = async (input) => {
      const result = await operation(input);
      if (!result?.ok) console.error(JSON.stringify({ operation: name, result }));
      return result;
    };
  }
  const worktrees = createWorktreeIpcHandlers({ manager: worktreeManager });
  const settings = { ...DEFAULT_SETTINGS, mode: 'api', apiKey: 'local-smoke-only', apiKeySet: true, model: 'fake-local-model', permissionMode: 'full-auto', terminalEnabled: true, hooksEnabled: false, mcpServers: [] };
  const runtime = createSubagentRuntime({ worktreeManager, runLoop: async (ctx) => {
    try {
    state.generations++;
    assert.equal(ctx.settings.hooksEnabled, false); assert.equal(ctx.settings.terminalEnabled, false);
    const round = state.generations - 1;
    if (!round || !followupMode) assert.match(ctx.messages[0].content, /SMOKE_PRIVATE_NOTE/);
    else assert.ok(ctx.messages[0].content.includes('SMOKE_PRIVATE_D20_NOTE_' + round));
    if (round < 2) assert.match(ctx.messages[0].content, /SMOKE_ORIGINAL_RIGHT/);
    else assert.doesNotMatch(ctx.messages[0].content, /SMOKE_ORIGINAL_RIGHT/);
    assert.match(ctx.messages[0].content, /SMOKE_ORIGINAL_LEFT/);
    assert.doesNotMatch(ctx.messages[0].content, /SMOKE_EDITED_PUBLICATION/);
    assert.notEqual(ctx.project.path.toLowerCase(), root.toLowerCase()); assert.equal(git(['rev-parse', 'HEAD'], ctx.project.path), state.head);
    const allowed = await ctx.gate.authorize({ tool: 'write_file', risk: 'write', path: 'src/app.js' }); assert.equal(allowed.allowed, true);
    const expression = ['Array.isArray(xs) && xs.length ? xs[0] : null',
      'Array.isArray(xs) ? (xs[0] ?? null) : null', 'Array.isArray(xs) && xs.length > 0 ? xs[0] : null'][round];
    fs.writeFileSync(path.join(ctx.project.path, 'src/app.js'), original.replace('xs[0]', expression));
    return { content: '修复完成', turns: 1, terminalReason: 'completed' };
    } catch (error) { generationFailure = error; throw error; }
  } });
  const handlers = new Map();
  for (const [action, method] of [['start', 'prAuditRecheckStart'], ['list', 'prAuditRecheckList'], ['get', 'prAuditRecheckGet'], ['cancel', 'prAuditRecheckCancel'], ['context', 'prAuditRecheckContext'],
    ['repair-snapshot', 'prAuditRecheckRepairSnapshot'], ['repair-source', 'prAuditRecheckRepairSource'], ['update-pr', 'prAuditRecheckUpdatePr']]) {
    handlers.set(`engineering:pr-audit:recheck:${action}`, (event, payload) => {
      if (action === 'start') {
        const manager = engineering.prAuditRecheckManager;
        assert.ok(manager);
        manager.runtime = (args) => {
          state.rechecks++; let turn = 0;
          return runRecheck({ ...args, chatFn: async () => {
            if (++turn === 1) return { tool_calls: [{ id: 'read_target', type: 'function', function: { name: 'recheck_read_file', arguments: '{"path":"src/app.js","offset":1,"limit":4}' } }] };
            const target = [...args.snapshot.evidence.values()].find((e) => e.stage === 'target'); assert.ok(target);
            return { content: JSON.stringify({ summary: '已逐项检查修复后的输入处理', findings: args.findings.map((f) => {
              const status = followupMode && state.rechecks < 3 ? (f.side === 'LEFT' ? 'unknown' : 'still_present') : 'resolved';
              return { findingId: f.findingId, status,
                reason: status === 'unknown' ? '尚缺调用方预期的证据，需要继续确认。' : status === 'still_present' ? '需要继续检查输入边界。' : '目标代码先检查输入类型与数组长度，原触发条件已消除。',
                evidence: status === 'unknown' ? [] : [target.evidenceId] };
            }) }) };
          } });
        };
      }
      return engineering[method](event, payload);
    });
  }
  handlers.set('settings:get', () => settings);
  handlers.set('worktree:bind', (event, payload) => {
    const previous = worktrees.listProjectPaths(event); const result = worktrees.bind(event, payload);
    for (const old of previous) if (!worktrees.hasProjectBinding(event, old)) engineering.dropProject(event, old);
    engineering.syncOwnerBindings(event, worktrees.listProjectPaths(event)); return result;
  });
  for (const [channel, method] of [['worktree:list', 'list'], ['worktree:get', 'get'], ['worktree:pr:list', 'listPrs'], ['worktree:pr:get', 'getPr']]) handlers.set(channel, (event, payload) => worktrees[method](event, payload));
  for (const [action, method] of [['start', 'prAuditStart'], ['list', 'prAuditList'], ['get', 'prAuditGet'], ['cancel', 'prAuditCancel'], ['context', 'prAuditContext'],
    ['prepare', 'prAuditPrepare'], ['publish', 'prAuditPublish'], ['reconcile', 'prAuditReconcile'], ['repair-snapshot', 'prAuditRepairSnapshot'], ['repair-source', 'prAuditRepairSource'], ['update-pr', 'prAuditUpdatePr']]) {
    handlers.set(`engineering:pr-audit:${action}`, (event, payload) => engineering[method](event, payload));
  }
  handlers.set('engineering:pr-review:threads', (event, payload) => engineering.prReviewThreads(event, payload));
  handlers.set('engineering:pr-audit:tracking:list', (event, payload) => engineering.prAuditTrackingList(event, payload));
  handlers.set('engineering:pr-audit:tracking:get', (event, payload) => engineering.prAuditTrackingGet(event, payload));
  for (const [action, method] of [['list', 'repairList'], ['get', 'repairGet'], ['result', 'repairResult'], ['start', 'repairStart'], ['cancel', 'repairCancel'], ['validate', 'repairValidate']]) handlers.set(`engineering:repair:${action}`, (event, payload) => engineering[method](event, payload));
  for (const [action, method] of [['list', 'ciWatchList'], ['get', 'ciWatchGet'], ['start', 'ciWatchStart'], ['stop', 'ciWatchStop'], ['ack', 'ciWatchAck']]) handlers.set(`engineering:ci-watch:${action}`, (event, payload) => { if (action === 'start') state.watches++; return engineering[method](event, payload); });
  handlers.set('chat:approve', (event, payload) => ({ ok: engineering.resolveApproval(event, payload.approvalId, payload.decision) }));
  handlers.set('engineering:remote-ci:failures', () => ({ ok: true, failures: [], unsupported: [] }));
  for (const [channel, result] of [
    ['engineering:index:ensure', { ok: true, state: 'ready' }], ['engineering:index:status', { ok: true, state: 'ready' }],
    ['engineering:verification:profiles', { ok: true, profiles: [validationProfile], candidates: [] }], ['engineering:verification:list', { ok: true, jobs: [] }],
    ['engineering:workflow:list', { ok: true, workflows: [] }], ['engineering:workflow:runs', { ok: true, runs: [] }],
    ['mcp:tasks:list', { ok: true, tasks: [] }], ['mcp:oauth:status', { ok: true, servers: [] }], ['mcp:session:status', { ok: true, servers: [] }],
    ['hooks:summary', { ok: true, hooks: [] }], ['memory:list', { ok: true, entries: [] }], ['usage:summary', { ok: true, summary: {}, groups: [] }], ['skills:list', { ok: true, skills: [] }],
  ]) handlers.set(channel, () => result);
  const preload = path.resolve(__dirname, '../src/preload.js');
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))) {
    ipcMain.handle(channel, (event, payload) => {
      if (handlers.has(channel)) return handlers.get(channel)(event, payload);
      unexpected.push(channel); throw new Error(`Unexpected smoke IPC: ${channel}`);
    });
  }
  const js = async (source) => {
    let timer;
    try {
      return await Promise.race([win.webContents.executeJavaScript(source), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source.slice(0, 180)}`)), 45000);
      })]);
    } catch (error) {
      throw new Error(`Renderer evaluation failed: ${source.slice(0, 300)}\n${error.message}`, { cause: error });
    } finally { clearTimeout(timer); }
  };
  async function until(source, timeout = 45000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (generationFailure) throw generationFailure;
      if (await js(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`UI condition timed out: ${source}`);
  }
  async function capture(name) {
    // Hidden native windows may not receive animation frames after navigation.
    await js('new Promise(resolve => { setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(resolve)); })');
    await win.webContents.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(profile, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }

  app.whenReady().then(async () => {
    try {
      audits = createPrAuditManager({ githubCli: github, userDataPath: profile, safeStorage, getSettings: () => settings,
        runtime: async () => { state.audits++; return { report: { summary: '原始静态审查', findings: state.audits === 1 ? [
          { priority: 'P1', title: '空值输入会抛错', body: 'SMOKE_ORIGINAL_RIGHT: 缺少输入类型检查。', path: 'src/app.js', side: 'RIGHT', line: 2, startLine: 2 },
          { priority: 'P2', title: '空数组行为需要明确', body: 'SMOKE_ORIGINAL_LEFT: 旧调用要求空数组返回 null。', path: 'src/app.js', side: 'LEFT', line: 2, startLine: 2 },
        ] : [] }, turns: 1, usage: { inputTokens: 10, outputTokens: 20 } }; },
        onEvent: (event) => { if (win && !win.isDestroyed()) win.webContents.send('engineering:pr-audit:event', event); },
      });
      const watches = createCiWatchManager({ githubCli: github, onEvent: (event) => { if (win && !win.isDestroyed()) win.webContents.send('engineering:ci-watch:event', event); } });
      engineering = createEngineeringIpcHandlers({ prAuditManager: audits, ciWatchManager: watches, githubCli: github, worktreeManager, subagentRuntime: runtime,
        onPrAuditRecheckEvent: (event, ownerIds) => { if (win && !win.isDestroyed() && ownerIds.includes(win.webContents.id)) win.webContents.send('engineering:pr-audit:recheck:event', event); },
        userDataPath: profile, safeStorage, getSettings: () => settings, getProfiles: () => [validationProfile], resolveBinding: (event, payload) => worktrees.resolveBinding(event, payload),
        runTerminal: async (cwd, command, options) => { state.validations++; assert.notEqual(cwd.toLowerCase(), root.toLowerCase()); return runTerminal(cwd, command, options); },
        createPermissionGate: (event) => createPermissionGate({
          permissionMode: 'full-auto',
          terminalEnabled: true,
          terminalRequireConfirm: true,
          onApprovalNeeded: (approval) => {
            const source = approval?.source || (approval?.tool === 'verification_start' ? 'verification' : undefined);
            approvals.push({ tool: approval.tool, source: approval.source });
            event.sender.send('chat:event', { type: 'approval-needed', ...approval, ...(source ? { source } : {}) });
          },
        }),
        onEvent: (event, ownerIds) => {
          if (!win || win.isDestroyed() || !ownerIds.includes(win.webContents.id)) return;
          win.webContents.send('engineering:event', event);
          if (event.type === 'engineering:repair:event') win.webContents.send('engineering:repair:event', event);
        },
      });
      audits.store.isProtected = (ref) => engineering.prAuditRepairManager.protectsReport(ref);
      win = new BrowserWindow({ width: 1100, height: 720, frame: false, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.on('console-message', (_event, level, message) => {
        if (message.startsWith('[')) console.log('[RENDERER]', message);
        if (level >= 3) rendererErrors.push(message);
      });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
      win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { worktrees.dropSender(win.webContents.id); engineering.dropSender(win.webContents.id); } });
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      await js(`(async () => { projects = [{id:'smoke', name:'${followupMode ? 'D20 复审继续修复' : 'D18 AI 审查修复'}', path:${JSON.stringify(root)}}]; sessions = [{id:'session-smoke', title:'${followupMode ? 'D20 复审继续修复' : 'D18 审查修复'}', kind:'project', peer:'codex', projectId:'smoke', messages:[], updatedAt:Date.now()}]; activeSessionId = 'session-smoke'; saveState(); await bindWorktreeProject(projects[0]); setView('prs'); await loadPullRequests(); await loadPullRequestDetail(7); })()`);
      await until("Boolean(document.querySelector('[data-audit-action=start]'))");
      await js("document.querySelector('[data-audit-action=start]').click()");
      await until("document.querySelectorAll('[data-audit-repair-check]').length === 2");
      assert.equal(await js("[...document.querySelectorAll('[data-audit-repair-check]')].some(n=>n.checked)"), false);
      await js(`(() => {
        document.querySelector('.pr-edit-title').value = 'SMOKE_PRIVATE_PR_TITLE';
        const ids = [...document.querySelectorAll('[data-audit-repair-check]')].map(n=>n.dataset.auditRepairCheck);
        for (const id of ids) { const n=document.querySelector('[data-audit-repair-check="'+id+'"]'); n.checked=true; n.dispatchEvent(new Event('change')); }
        const title=document.querySelector('[data-audit-title]'); title.value='SMOKE_EDITED_PUBLICATION'; title.dispatchEvent(new Event('input'));
        document.querySelector('[data-audit-repair-field=note]').value='SMOKE_PRIVATE_NOTE';
        document.querySelector('[data-audit-repair-field=profileId]').value=${JSON.stringify(validationProfile.id)};
        renderPullRequestView();
      })()`);
      assert.equal(await js("document.querySelector('.pr-edit-title').value"), 'SMOKE_PRIVATE_PR_TITLE');
      assert.equal(await js("[...document.querySelectorAll('[data-audit-check]')].some(n=>n.checked)"), false);
      await js("document.querySelector('[data-audit-action=previewRepair]').click()");
      await until("Boolean(document.querySelector('[data-audit-action=repair]'))");
      const preview = await js("document.querySelector('[data-audit-repair-preview]').textContent");
      assert.match(preview, /SMOKE_ORIGINAL_RIGHT/); assert.match(preview, /SMOKE_ORIGINAL_LEFT/); assert.doesNotMatch(preview, /SMOKE_EDITED_PUBLICATION/);
      for (const [width, height] of [[1100, 720], [900, 580]]) {
        win.setContentSize(width, height); await js("document.querySelector('.pr-audit-repair').scrollIntoView({block:'start'})"); await capture(`preview-${width}x${height}`);
        const sizes = await js("['.pr-detail','.pr-audit-panel','.pr-audit-repair','.qq-toolbar'].map(s=>{const n=document.querySelector(s);return {selector:s,width:n.clientWidth,scroll:n.scrollWidth};})");
        for (const size of sizes) assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
      }
      await js("document.querySelector('[data-audit-action=repair]').click()");
      await until("currentView === 'scheduled' && Boolean(document.querySelector('#engineering-repairs [data-repair-view]'))", 90000);
      assert.equal(state.generations, 1); assert.equal(state.validations, 0); assert.equal(state.pushes, 0);
      console.log('D18 smoke: isolated repair generated');
      await js("document.querySelector('#engineering-repairs [data-repair-view]').click()");
      await until("Boolean(document.getElementById('engineering-repair-open-audit'))");
      await js("document.getElementById('engineering-repair-open-audit').click()");
      await until("document.querySelectorAll('.pr-audit-finding.is-highlighted').length === 2");
      assert.equal(await js("document.querySelector('[data-audit-title]').value"), 'SMOKE_EDITED_PUBLICATION');
      assert.equal(await js("document.querySelector('[data-audit-repair-field=note]').value"), 'SMOKE_PRIVATE_NOTE');
      await js("document.querySelector('[data-audit-action=repairProgress]').click()");
      await until("Boolean(document.querySelector('#engineering-repairs [data-repair-validate]'))");
      await js("document.querySelector('#engineering-repairs [data-repair-validate]').click()");
      await until("!document.getElementById('engineering-approval').classList.contains('hidden')");
      await js("document.querySelector('#engineering-approval [data-engineering-decision=allow]').click()");
      await until("document.getElementById('engineering-repairs')?.textContent.includes('验证 通过')", 60000);
      assert.equal(state.validations, 1);
      console.log('D18 smoke: explicit validation passed');
      await js("document.querySelector('#engineering-repairs [data-repair-view]').click()");
      await until("Boolean(document.getElementById('engineering-repair-open-result'))");
      await js("document.getElementById('engineering-repair-open-result').click()");
      await until("currentView === 'chat' && Boolean(document.querySelector('.worktree-result-card'))");
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='查看 diff').click()");
      await until("document.querySelector('.worktree-result-preview')?.textContent.includes('Array.isArray')"); await capture('diff-900x580');
      assert.equal(await js("[...document.querySelectorAll('.worktree-result-card button')].some(n=>n.textContent==='创建 Draft PR')"), false);
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='更新此 PR').click()");
      await until("!document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
      await js("document.getElementById('app-dialog-input').value='Fix original AI findings'; document.getElementById('app-dialog-ok').click()");
      await until("!document.getElementById('app-dialog').classList.contains('hidden') && document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
      assert.equal(state.pushes, 0); await capture('update-approval-900x580'); await js("document.getElementById('app-dialog-ok').click()");
      await until("activeSession()?.pendingWorktreeResults?.some(r=>r.state==='pr_updated')", 60000);
      assert.equal(state.pushes, 1); assert.equal(git(['rev-parse', 'HEAD']), localHead); assert.equal(git(['show-ref']), beforeRefs); assert.equal(git(['status', '--porcelain']), '');
      assert.equal(state.audits, 1); assert.equal(state.watches, 0);
      console.log('D18 smoke: PR delivery confirmed');
      const originalResult = engineering.repairManager.store.list().find((r) => r.source.kind === 'pr_audit').resultId;
      const originalCard = '.worktree-result-card[data-result-id="' + originalResult + '"]';
      if (recheckMode) {
        await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='复审本次修复').click()");
        await until(`document.querySelector('.pr-audit-recheck-findings')?.textContent.includes('${followupMode ? '无法判断' : 'AI 判断已解决'}')`, 60000);
        assert.equal(state.rechecks, 1); assert.equal(state.audits, 1); assert.equal(state.pushes, 1);
        console.log('D19 smoke: recheck completed');
        await js("document.querySelector('[data-recheck-action=context]').click()");
        await until("document.querySelector('.pr-audit-recheck-snippet')?.textContent.includes('Array.isArray')");
        for (const [width, height] of [[900, 580], [1100, 720]]) {
          win.setContentSize(width, height);
          await js("document.querySelector('.pr-audit-recheck-snippet').scrollIntoView({block:'center'})");
          await capture(`recheck-evidence-${width}x${height}`);
          const sizes = await js("['.pr-audit-recheck','.pr-audit-recheck-snippet','.pr-detail'].map(s=>{const n=document.querySelector(s);return {selector:s,width:n.clientWidth,scroll:n.scrollWidth};})");
          for (const size of sizes) assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
        }
        if (followupMode) await require('./smoke-pr-audit-recheck-repair-flow.cjs')({ js, until, capture, win, engineering, state, git, root, localHead, beforeRefs, validationProfile });
        if (trackingMode) await require('./smoke-pr-audit-tracking-flow.cjs')({ js, until, capture, win, state });
        win.setContentSize(900, 580);
        const originalGet = github.getAuditPr; github.getAuditPr = async () => ({ ...(await originalGet()), body: 'changed description' });
        await js("prAuditRecheckUi.refresh()"); await until("document.querySelector('[data-recheck-detail]')?.textContent.includes('结论已过期')");
        github.getAuditPr = originalGet;
        assert.doesNotMatch(await js('localStorage.getItem(STORAGE_KEY)'), /目标代码先检查|已逐项检查/);
        assert.equal(git(['status', '--porcelain']), ''); assert.equal(git(['show-ref']), beforeRefs);
        await js("setView('chat')");
      }
      await js(`[...document.querySelectorAll('${originalCard} button')].find(n=>n.textContent.includes('跟踪 CI')).click()`);
      await until('ciWatchUi.snapshot().length === 1'); assert.equal(state.watches, 1);
      await js(`[...document.querySelectorAll('${originalCard} button')].find(n=>n.textContent==='查看原 AI 审查发现').click()`);
      await until("document.querySelectorAll('.pr-audit-finding.is-highlighted').length === 2");
      assert.equal(await js("document.querySelector('[data-audit-repair-check]').disabled"), true);
      assert.doesNotMatch(await js('localStorage.getItem(STORAGE_KEY)'), /SMOKE_PRIVATE_|SMOKE_EDITED_|SMOKE_ORIGINAL_/);
      assert.equal(await js('activeSession().messages.length'), 0);
      const sources = engineering.prAuditRepairManager.store.list(); assert.equal(sources.length, 1);
      assert.doesNotMatch(JSON.stringify(sources), /SMOKE_|"body"/);
      assert.doesNotMatch(JSON.stringify(engineering.repairManager.store.list()), /SMOKE_|"note"/);
      if (followupMode) assert.doesNotMatch(JSON.stringify(engineering.prAuditRecheckRepairManager.store.list()), /SMOKE_|"body"|"note"/);
      await js("setView('chat')");
      const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve)); win.reload(); await reloaded;
      await until("Boolean(worktreeBindings.get('smoke')) && Boolean(document.querySelector('.worktree-result-card'))");
      await js(`[...document.querySelectorAll('${originalCard} button')].find(n=>n.textContent==='查看原 AI 审查发现').click()`);
      await until("document.querySelectorAll('.pr-audit-finding.is-highlighted').length === 2");
      assert.equal(await js("document.querySelector('[data-audit-repair-field=note]').value"), '');
      assert.equal(await js("document.querySelector('[data-audit-repair-check]').checked"), false);
      await capture('source-after-reload-900x580');
      if (followupMode) {
        const lastSource = engineering.prAuditRecheckRepairManager.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        await js(`openPrAuditRecheckRepairSource('smoke', '${lastSource.recheckRepairRef}')`);
        await until("Boolean(document.querySelector('[data-recheck-repair-field=note]'))");
        assert.equal(await js("document.querySelector('[data-recheck-repair-field=note]').value"), '');
        assert.equal(await js("[...document.querySelectorAll('[data-recheck-repair-id]')].some(n=>n.checked)"), false);
        const final = engineering.prAuditRecheckManager.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        await js(`prAuditRecheckUi.select('${final.recheckRef}')`);
        if (trackingMode) {
          await js('prAuditTrackingUi.refresh()');
          await until("document.querySelector('.tracking-detail')?.textContent.includes('完整轮次历史（3）')");
          assert.equal(await js("document.querySelectorAll('[data-tracking-open^=finding-]').length"), 2);
          await capture('tracking-after-reload-900x580');
        }
      }
      if (recheckMode) {
        await js("prAuditRecheckUi.refresh()"); await until("document.querySelector('.pr-audit-recheck-findings')?.textContent.includes('AI 判断已解决')");
        await js("setView('scheduled')"); await until("document.querySelector('#engineering-pr-rechecks')?.textContent.includes('复审完成')");
        await js("document.getElementById('engineering-pr-rechecks').scrollIntoView({block:'start'})");
        await capture('recheck-history-900x580');
      }
      await js(`setView('chat'); [...document.querySelectorAll('${originalCard} button')].find(n=>n.textContent==='重新 AI 审查').click()`);
      await until("document.querySelectorAll('.pr-audit-history-row').length === 2 && document.querySelector('.pr-audit-status')?.textContent.includes('审查完成')");
      assert.equal(state.audits, 2); assert.equal(state.generations, followupMode ? 3 : 1); assert.equal(state.pushes, followupMode ? 3 : 1); assert.equal(state.reviews + state.replies + state.resolves, 0);
      assert.deepEqual(approvals.map((row) => row.tool), ['verification_start', 'pr_audit_update_pr', ...(followupMode ? ['verification_start', 'pr_audit_recheck_update_pr', 'pr_audit_recheck_update_pr'] : [])]);
      assert.deepEqual(unexpected, []); assert.deepEqual(rendererErrors, []); assert.deepEqual(network, []);
      console.log(JSON.stringify({ ok: true, sizes: ['1100x720', '900x580'], ...state, approvalCount: approvals.length, rendererErrors, networkRequests: network.length, artifacts: profile }));
      engineering.close(); win.destroy(); app.exit(0);
    } catch (error) {
      console.error(error.stack || error); console.error(JSON.stringify({ unexpected, rendererErrors, state, approvals, artifacts: profile }));
      if (win && !win.isDestroyed()) {
        await capture('failure').catch(() => {});
        console.error(await js("JSON.stringify({view:currentView,audit:document.querySelector('.pr-audit-error')?.textContent,repairs:document.getElementById('engineering-repairs')?.textContent,detail:document.getElementById('engineering-repair-detail')?.textContent})").catch(() => 'Renderer unavailable'));
      }
      engineering?.close(); win?.destroy(); app.exit(1);
    }
  });
}
