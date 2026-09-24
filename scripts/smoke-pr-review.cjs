'use strict';

// node scripts/smoke-pr-review.cjs
// Real Electron renderer/preload/IPC, D13 runtime and D5 worktrees. GitHub and
// the model are local fakes. Uses an independent temporary profile/repository.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process'); const assert = require('node:assert/strict');
  const { createWorktreeManager } = require('../src/ai/worktree');
  const { createWorktreeIpcHandlers } = require('../src/ai/worktree-ipc');
  const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
  const { createPrReviewManager } = require('../src/ai/pr-review-manager');
  const { createCiWatchManager } = require('../src/ai/ci-watch-manager');
  const { createSubagentRuntime } = require('../src/ai/subagent-runtime');
  const { createPermissionGate } = require('../src/ai/permission');
  const { repositoryKey } = require('../src/ai/remote-ci-state');
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d16-smoke-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  for (const flag of ['no-sandbox', 'disable-gpu', 'disable-software-rasterizer', 'disable-gpu-compositing']) app.commandLine.appendSwitch(flag);
  const root = path.join(profile, 'repo'); fs.mkdirSync(root);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'D16 Smoke']); git(['config', 'user.email', 'd16@example.test']);
  git(['remote', 'add', 'origin', 'https://github.com/example/demo.git']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function first(xs) {\n  return xs[0];\n}\n');
  git(['add', '.']); git(['commit', '-qm', 'PR base']);
  const baseHead = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'local.txt'), 'local-only\n'); git(['add', '.']); git(['commit', '-qm', 'local head']);
  const localHead = git(['rev-parse', 'HEAD']); const beforeRefs = git(['show-ref']);
  const repo = { host: 'github.com', owner: 'example', repo: 'demo', nameWithOwner: 'example/demo' };
  const repoKey = repositoryKey(repo.host, repo.nameWithOwner);
  const date = '2026-09-24T02:00:00.000Z';
  const makeComment = (id, body) => ({ id, body, state: 'SUBMITTED', author: { login: 'reviewer' }, createdAt: date, updatedAt: date });
  const state = { head: baseHead, replies: 0, resolves: 0, pushes: 0, generations: 0, watches: 0 };
  const threads = [
    { id: 'THREAD_CURRENT', path: 'src/app.js', line: 2, startLine: null, subjectType: 'LINE', diffSide: 'RIGHT', startDiffSide: null,
      isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true,
      comments: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: [makeComment('C1', '空数组时请返回 null，并保持现有调用方式。\nSMOKE_PRIVATE_REVIEW'), makeComment('C2', '补充：正常数组仍应返回第一个元素。')] } },
    { id: 'THREAD_OLD', path: 'src/removed.js', line: null, startLine: null, subjectType: 'LINE', diffSide: 'LEFT', startDiffSide: null,
      isResolved: false, isOutdated: true, viewerCanReply: true, viewerCanResolve: true,
      comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [makeComment('C3', '这个旧位置已移除，请说明替代方案。')] } },
  ];
  function prInfo() { return { number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headSha: state.head, headRefName: 'feature/review', headRepository: { nameWithOwner: repo.nameWithOwner }, repository: { nameWithOwner: repo.nameWithOwner } }; }
  function pr() { return { ...prInfo(), headRepository: repo.nameWithOwner, url: 'https://github.com/example/demo/pull/7', title: '为空输入添加处理', body: 'D16 本地桌面验收', author: 'smoke-author', baseRefName: 'main', checks: [], checksSummary: {}, files: [{ path: 'src/app.js', additions: 1, deletions: 1 }], comments: [], mergeable: 'UNKNOWN' }; }
  const github = {
    runCommand: async (command, args) => { assert.equal(command, 'git'); assert.deepEqual(args.slice(-2), ['rev-parse', '--show-toplevel']); return { ok: true, stdout: root }; },
    repository: async () => ({ ok: true, remote: repo, nameWithOwner: repo.nameWithOwner, base: 'main' }),
    listPrs: async () => ({ ok: true, prs: [pr()], truncated: false }),
    getPr: async () => ({ ok: true, pr: pr() }), getChecks: async () => ({ ok: true, checks: [], summary: {} }),
    getReviewThreads: async () => structuredClone({ ok: true, pr: { ...prInfo(), reviewThreads: { totalCount: threads.length, nodes: threads, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    getReviewThread: async ({ threadId }) => structuredClone({ ok: true, thread: { ...threads.find((row) => row.id === threadId), pullRequest: prInfo() } }),
    getReviewFile: async ({ path: file }) => ({ ok: file === 'src/app.js', lineCount: 3 }),
    replyReviewThread: async ({ threadId, body }) => { state.replies++; const row = threads.find((item) => item.id === threadId); const id = `REPLY_${state.replies}`; row.comments.nodes.push(makeComment(id, body)); row.comments.totalCount++; return { ok: true, commentId: id }; },
    resolveReviewThread: async ({ threadId }) => { state.resolves++; threads.find((item) => item.id === threadId).isResolved = true; return { ok: true }; },
    fetchBranchToRef: async ({ targetRef }) => { git(['update-ref', targetRef, state.head]); return { ok: true }; },
    resolveCommit: async ({ ref }) => ({ ok: true, head: git(['rev-parse', ref]) }),
    deleteInternalRef: async ({ ref }) => { git(['update-ref', '-d', ref]); return { ok: true }; },
    branchTip: async () => ({ ok: true, head: state.head }),
    exactLeasePush: async ({ oldHead, newCommit }) => { assert.equal(oldHead, state.head); state.pushes++; state.head = newCommit; return { ok: true }; },
    getCiWatchRepository: async () => ({ ok: true, repository: { ...repo, repoKey, repoRoot: root } }),
    getCiWatchOrigin: async () => ({ ok: true, repoKey }),
    getCiPrStatus: async () => ({ ok: true, pr: pr() }),
    getCiRunsForHead: async () => ({ ok: true, runs: [{ id: '123', name: 'Tests', headSha: state.head, runAttempt: 1, status: 'in_progress', conclusion: '' }] }),
  };
  let win; let engineering; let reviews; let watches;
  const unexpected = []; const rendererErrors = []; const network = []; const approvals = [];
  const worktreeManager = createWorktreeManager({ githubCli: github });
  const worktrees = createWorktreeIpcHandlers({ manager: worktreeManager });
  const settings = { ...DEFAULT_SETTINGS, mode: 'api', apiKey: 'local-smoke-only', apiKeySet: true, model: 'fake-local-model', permissionMode: 'full-auto', hooksEnabled: false, mcpServers: [] };
  const runtime = createSubagentRuntime({ worktreeManager, runLoop: async (ctx) => {
    state.generations++;
    assert.equal(ctx.settings.hooksEnabled, false); assert.equal(ctx.settings.terminalEnabled, false);
    assert.match(ctx.messages[0].content, /SMOKE_PRIVATE_REVIEW/); assert.match(ctx.messages[0].content, /SMOKE_PRIVATE_NOTE/);
    assert.notEqual(ctx.project.path.toLowerCase(), root.toLowerCase());
    const allowed = await ctx.gate.authorize({ tool: 'write_file', risk: 'write', path: 'src/app.js' }); assert.equal(allowed.allowed, true);
    fs.writeFileSync(path.join(ctx.project.path, 'src', 'app.js'), 'function first(xs) {\n  return xs.length ? xs[0] : null;\n}\n');
    return { content: '修复完成', turns: 1, terminalReason: 'completed' };
  } });
  const handlers = new Map();
  handlers.set('settings:get', () => settings);
  handlers.set('worktree:bind', (event, payload) => {
    const previous = worktrees.listProjectPaths(event); const result = worktrees.bind(event, payload);
    for (const old of previous) if (!worktrees.hasProjectBinding(event, old)) engineering.dropProject(event, old);
    engineering.syncOwnerBindings(event, worktrees.listProjectPaths(event)); return result;
  });
  for (const [channel, method] of [['worktree:list', 'list'], ['worktree:get', 'get'], ['worktree:pr:list', 'listPrs'], ['worktree:pr:get', 'getPr']]) handlers.set(channel, (event, payload) => worktrees[method](event, payload));
  for (const [action, method] of [['threads', 'prReviewThreads'], ['get', 'prReviewGet'], ['snapshot', 'prReviewSnapshot'], ['source', 'prReviewSource'], ['reply', 'prReviewReply'], ['resolve', 'prReviewResolve'], ['update-pr', 'prReviewUpdatePr']]) handlers.set(`engineering:pr-review:${action}`, (event, payload) => engineering[method](event, payload));
  for (const [action, method] of [['list', 'repairList'], ['get', 'repairGet'], ['result', 'repairResult'], ['start', 'repairStart'], ['cancel', 'repairCancel']]) handlers.set(`engineering:repair:${action}`, (event, payload) => engineering[method](event, payload));
  for (const [action, method] of [['list', 'ciWatchList'], ['get', 'ciWatchGet'], ['start', 'ciWatchStart'], ['stop', 'ciWatchStop'], ['ack', 'ciWatchAck']]) handlers.set(`engineering:ci-watch:${action}`, (event, payload) => { if (action === 'start') state.watches++; return engineering[method](event, payload); });
  handlers.set('chat:approve', (event, payload) => ({ ok: engineering.resolveApproval(event, payload.approvalId, payload.decision) }));
  handlers.set('engineering:remote-ci:failures', () => ({ ok: true, failures: [], unsupported: [] }));
  for (const [channel, result] of [
    ['engineering:index:ensure', { ok: true, state: 'ready' }], ['engineering:index:status', { ok: true, state: 'ready' }],
    ['engineering:verification:profiles', { ok: true, profiles: [], candidates: [] }], ['engineering:verification:list', { ok: true, jobs: [] }],
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
  const js = (source) => win.webContents.executeJavaScript(source);
  async function until(source, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await js(source)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`UI condition timed out: ${source}`);
  }
  async function capture(name) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(profile, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function approve() { await until("!document.getElementById('app-dialog').classList.contains('hidden')"); await js("document.getElementById('app-dialog-ok').click()"); }

  app.whenReady().then(async () => {
    try {
      reviews = createPrReviewManager({ github, worktree: worktreeManager, userDataPath: profile, safeStorage, resolveRepo: () => root });
      watches = createCiWatchManager({ githubCli: github, onEvent: (event) => { if (win && !win.isDestroyed()) win.webContents.send('engineering:ci-watch:event', event); } });
      engineering = createEngineeringIpcHandlers({ prReviewManager: reviews, ciWatchManager: watches, githubCli: github, worktreeManager, subagentRuntime: runtime,
        userDataPath: profile, safeStorage, getSettings: () => settings, getProfiles: () => [], resolveBinding: (event, payload) => worktrees.resolveBinding(event, payload),
        createPermissionGate: (event) => createPermissionGate({ permissionMode: 'full-auto', onApprovalNeeded: (approval) => {
          approvals.push({ tool: approval.tool, source: approval.source }); event.sender.send('chat:event', { type: 'approval-needed', ...approval });
        } }),
        onEvent: (event, ownerIds) => {
          if (!win || win.isDestroyed() || !ownerIds.includes(win.webContents.id)) return;
          win.webContents.send('engineering:event', event);
          if (event.type === 'engineering:repair:event') win.webContents.send('engineering:repair:event', event);
        },
      });
      win = new BrowserWindow({ width: 1100, height: 720, frame: false, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
      win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { worktrees.dropSender(win.webContents.id); engineering.dropSender(win.webContents.id); } });
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      await js(`(async () => { projects = [{id:'smoke', name:'D16 审查反馈', path:${JSON.stringify(root)}}]; sessions = [{id:'session-smoke', title:'D16 审查反馈', kind:'project', peer:'codex', projectId:'smoke', messages:[], updatedAt:Date.now()}]; activeSessionId = 'session-smoke'; saveState(); await bindWorktreeProject(projects[0]); setView('prs'); await loadPullRequests(); await loadPullRequestDetail(7); })()`);
      await until("document.querySelectorAll('[data-review-thread]').length === 2");
      await js("document.querySelector('[data-review-thread]').click()");
      await until("Boolean(document.querySelector('[data-review-field=reply]'))");
      await js("document.querySelector('.pr-edit-title').value = 'SMOKE_PRIVATE_TITLE'; document.querySelector('.pr-edit-body').value = 'SMOKE_PRIVATE_BODY'; document.querySelector('.pr-comment-input').value = 'SMOKE_PRIVATE_COMMENT'; document.querySelector('[data-review-field=reply]').value = 'SMOKE_PRIVATE_REPLY'; renderPullRequestView()");
      assert.deepEqual(await js("['.pr-edit-title','.pr-edit-body','.pr-comment-input','[data-review-field=reply]'].map(s => document.querySelector(s).value)"), ['SMOKE_PRIVATE_TITLE', 'SMOKE_PRIVATE_BODY', 'SMOKE_PRIVATE_COMMENT', 'SMOKE_PRIVATE_REPLY']);
      await js("document.querySelectorAll('[data-review-thread]')[1].click()");
      await until("document.querySelector('.pr-review-location')?.textContent.includes('已过期')");
      assert.equal(await js("document.querySelector('[data-review-action=repair]').disabled"), true);
      assert.equal(await js("document.querySelector('[data-review-action=resolve]').disabled"), false);
      await js("document.querySelector('[data-review-field=reply]').value='SMOKE_PRIVATE_OLD_DRAFT'; document.querySelectorAll('[data-review-thread]')[0].click()");
      await until("document.querySelector('[data-review-field=reply]')?.value === 'SMOKE_PRIVATE_REPLY'");
      await js("document.querySelector('[data-review-repair]').open = true; document.querySelector('[data-review-field=note]').value = 'SMOKE_PRIVATE_NOTE'; document.querySelector('[data-review-field=note]').dispatchEvent(new Event('input',{bubbles:true}))");
      for (const [width, height] of [[1100, 720], [900, 580]]) {
        win.setContentSize(width, height);
        await js("document.getElementById('pr-review-panel').scrollIntoView({block:'start'})");
        await capture(`review-${width}x${height}`);
        const sizes = await js("['.pr-detail','.pr-review-panel','.pr-review-detail','.qq-toolbar'].map(s => {const n=document.querySelector(s); return {selector:s,width:n.clientWidth,scroll:n.scrollWidth};})");
        for (const size of sizes) assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
      }
      await js("document.querySelector('[data-review-action=repair]').click()");
      await until("Boolean(document.querySelector('[data-review-action=repairProgress]'))");
      await js("document.querySelector('[data-review-action=repairProgress]').click()");
      await until("document.querySelector('#engineering-repair-detail .engineering-detail-title')?.textContent.includes('修复建议')");
      await until("Boolean(document.querySelector('#engineering-repairs [data-repair-view]'))", 60000);
      await js("document.querySelector('#engineering-repairs [data-repair-view]').click()");
      await until("Boolean(document.getElementById('engineering-repair-open-result'))");
      await js("document.getElementById('engineering-repair-open-result').click()");
      await until("currentView === 'chat' && Boolean(document.querySelector('.worktree-result-card'))");
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='查看 diff').click()");
      await until("document.querySelector('.worktree-result-preview')?.textContent.includes('xs.length')");
      await capture('repair-diff-900x580');
      assert.equal(state.generations, 1); assert.equal(state.pushes, 0); assert.equal(state.replies, 0); assert.equal(state.resolves, 0);
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='更新此 PR').click()");
      await until("!document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
      await js("document.getElementById('app-dialog-input').value='Fix review feedback'; document.getElementById('app-dialog-ok').click()");
      await until("!document.getElementById('app-dialog').classList.contains('hidden') && document.getElementById('app-dialog-input-wrap').classList.contains('hidden')");
      assert.equal(state.pushes, 0); await capture('push-approval-900x580'); await approve();
      await until("activeSession()?.pendingWorktreeResults?.some(r=>r.state==='pr_updated')", 60000);
      assert.equal(state.pushes, 1); assert.equal(git(['rev-parse', 'HEAD']), localHead); assert.equal(git(['show-ref']), beforeRefs);
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent.includes('跟踪 CI')).click()");
      await until('ciWatchUi.snapshot().length === 1'); assert.equal(state.watches, 1);
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='查看原审查线程').click()");
      await until("currentView === 'prs' && document.querySelector('[data-review-field=reply]')?.value === 'SMOKE_PRIVATE_REPLY'");
      await js("document.querySelector('[data-review-field=reply]').value='SMOKE_PRIVATE_SENT_REPLY'; document.querySelector('[data-review-field=reply]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-review-action=reply]').click()");
      await until("!document.getElementById('app-dialog').classList.contains('hidden')"); assert.equal(state.replies, 0); await approve();
      await until("document.querySelector('[data-review-field=reply]')?.value === '' && !document.querySelector('[data-review-action=resolve]')?.disabled");
      assert.equal(state.replies, 1); assert.equal(state.resolves, 0);
      await js("document.querySelector('[data-review-action=resolve]').click()"); await approve();
      await until("document.querySelector('.pr-review-location')?.textContent.includes('已解决')"); assert.equal(state.resolves, 1);
      assert.deepEqual(approvals.map((row) => row.tool), ['pr_review_update_pr', 'pr_review_reply', 'pr_review_resolve']);
      assert.doesNotMatch(await js('localStorage.getItem(STORAGE_KEY)'), /SMOKE_PRIVATE_/);
      assert.equal(await js('activeSession().messages.length'), 0);
      const snapshots = reviews.store.list(); assert.equal(snapshots.length, 1);
      assert.doesNotMatch(JSON.stringify(snapshots), /SMOKE_PRIVATE_|"body"/);
      reviews.refs.clear();
      const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve)); win.reload(); await reloaded;
      await until("Boolean(document.querySelector('.worktree-result-card'))");
      await js("[...document.querySelectorAll('.worktree-result-card button')].find(n=>n.textContent==='查看原审查线程').click()");
      await until("document.querySelector('.pr-review-location')?.textContent.includes('已解决')");
      assert.equal(await js("document.querySelector('[data-review-field=reply]').value"), '');
      await js("document.getElementById('pr-review-panel').scrollIntoView({block:'start'})"); await capture('resolved-after-reload-900x580');
      assert.equal(state.generations, 1); assert.equal(state.pushes, 1); assert.equal(state.replies, 1); assert.equal(state.resolves, 1);
      assert.deepEqual(unexpected, []); assert.deepEqual(rendererErrors, []); assert.deepEqual(network, []);
      console.log(JSON.stringify({ ok: true, sizes: ['1100x720', '900x580'], ...state, approvalCount: approvals.length, rendererErrors, networkRequests: network.length, artifacts: profile }));
      engineering.close(); win.destroy(); app.exit(0);
    } catch (error) {
      console.error(error.stack || error); console.error(JSON.stringify({ unexpected, rendererErrors, state, artifacts: profile }));
      if (win && !win.isDestroyed()) {
        await capture('failure').catch(() => {});
        console.error(await js("JSON.stringify({view:currentView, repairs:document.getElementById('engineering-repairs')?.textContent, detail:document.getElementById('engineering-repair-detail')?.textContent})").catch(() => 'Renderer unavailable'));
      }
      engineering?.close(); win?.destroy(); app.exit(1);
    }
  });
}
