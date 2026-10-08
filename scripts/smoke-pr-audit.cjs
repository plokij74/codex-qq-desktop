'use strict';

// node scripts/smoke-pr-audit.cjs
// Real Electron renderer/preload/IPC with D17 AI PR Review. GitHub and
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
  const { createPrAuditManager } = require('../src/ai/pr-audit-manager');
  const { createPrReviewManager } = require('../src/ai/pr-review-manager');
  const { createCiWatchManager } = require('../src/ai/ci-watch-manager');
  const { createPermissionGate } = require('../src/ai/permission');
  const { repositoryKey } = require('../src/ai/remote-ci-state');
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d17-smoke-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  for (const flag of ['no-sandbox', 'disable-gpu', 'disable-software-rasterizer', 'disable-gpu-compositing']) app.commandLine.appendSwitch(flag);

  const root = path.join(profile, 'repo'); fs.mkdirSync(root);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'D17 Smoke']); git(['config', 'user.email', 'd17@example.test']);
  git(['remote', 'add', 'origin', root]);

  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function divide(a, b) {\n  return a / b;\n}\n');
  git(['add', '.']); git(['commit', '-qm', 'PR base']);
  git(['branch', '-M', 'main']);
  const baseHead = git(['rev-parse', 'HEAD']);

  git(['checkout', '-qb', 'feature/audit']);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function divide(a, b) {\n  if (b === 0) throw new Error("zero");\n  return a / b;\n}\n');
  git(['add', '.']); git(['commit', '-qm', 'fix divide by zero']);
  const headSha = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);

  const repo = { host: 'github.com', owner: 'example', repo: 'demo', nameWithOwner: 'example/demo' };
  const repoKey = repositoryKey(repo.host, repo.nameWithOwner);

  const appDiff = git(['diff', '-u', baseHead, headSha, '--', 'src/app.js']);
  const patch = appDiff.slice(appDiff.indexOf('@@')) + '\n';

  const publishedReviews = [];
  const publishedComments = [];

  function pr() {
    return {
      number: 7,
      state: 'OPEN',
      isDraft: false,
      isCrossRepository: false,
      headSha,
      baseSha: baseHead,
      headRefName: 'feature/audit',
      baseRefName: 'main',
      headRepo: repo.nameWithOwner,
      baseRepo: repo.nameWithOwner,
      headRepository: { nameWithOwner: repo.nameWithOwner },
      repository: { nameWithOwner: repo.nameWithOwner },
      url: 'https://github.com/example/demo/pull/7',
      title: '处理除以零异常',
      body: 'D17 审查冒烟验证',
      author: 'smoke-dev',
      changedFiles: 1,
      checks: [],
      checksSummary: {},
      files: [{ path: 'src/app.js', additions: 1, deletions: 0 }],
      comments: [],
      mergeable: 'MERGEABLE',
    };
  }

  const github = {
    runCommand: async (cmd, args, opts = {}) => {
      try {
        const stdout = execFileSync(cmd, args, { cwd: opts.cwd || root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        return { ok: true, stdout };
      } catch (err) {
        return { ok: false, error: err.message, stdout: '', stderr: String(err.stderr || '') };
      }
    },
    repository: async () => ({ ok: true, remote: repo, nameWithOwner: repo.nameWithOwner, base: 'main' }),
    listPrs: async () => ({ ok: true, prs: [pr()], truncated: false }),
    getPr: async () => ({ ok: true, pr: pr() }),
    getChecks: async () => ({ ok: true, checks: [], summary: {} }),
    getCiWatchRepository: async () => ({ ok: true, repository: { ...repo, repoKey, repoRoot: root } }),
    getCiWatchOrigin: async () => ({ ok: true, repoKey }),
    getCiPrStatus: async () => ({ ok: true, pr: pr() }),
    getCiRunsForHead: async () => ({ ok: true, runs: [] }),
    getReviewThreads: async () => ({ ok: true, pr: { number: 7, reviewThreads: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } } }),
    getAuditPr: async () => ({
      number: 7,
      state: 'open',
      merged: false,
      title: '处理除以零异常',
      body: 'D17 审查冒烟验证',
      headSha,
      baseSha: baseHead,
      headRefName: 'feature/audit',
      baseRefName: 'main',
      headRepo: repo.nameWithOwner,
      baseRepo: repo.nameWithOwner,
      changedFiles: 1,
    }),
    getAuditFiles: async () => [{
      filename: 'src/app.js',
      status: 'modified',
      additions: 1,
      deletions: 0,
      sha: git(['rev-parse', `${headSha}:src/app.js`]),
      patch,
    }],
    getAuditMergeBase: async () => baseHead,
    getAuditViewer: async () => ({ id: 555, login: 'smoke-reviewer' }),
    createAuditReview: async ({ payload }) => {
      const reviewId = 12345;
      publishedReviews.push({
        id: reviewId,
        user: { id: 555, login: 'smoke-reviewer' },
        state: 'COMMENTED',
        commit_id: payload.commit_id,
        body: payload.body,
        submitted_at: new Date().toISOString(),
      });
      let cId = 20000;
      for (const c of payload.comments) {
        publishedComments.push({
          id: ++cId,
          pull_request_review_id: reviewId,
          user: { id: 555 },
          path: c.path,
          side: c.side,
          line: c.line,
          start_line: c.start_line,
          original_line: c.line,
          original_start_line: c.start_line,
          original_commit_id: payload.commit_id,
          body: c.body,
        });
      }
      return { id: reviewId, state: 'COMMENTED' };
    },
    getAuditReview: async ({ reviewId }) => publishedReviews.find((r) => r.id === reviewId),
    listAuditReviews: async () => publishedReviews,
    getAuditComments: async ({ reviewId }) => publishedComments.filter((c) => c.pull_request_review_id === reviewId),
  };

  const fakeRuntime = async () => ({
    report: {
      summary: '代码审查完成，发现 1 项问题。',
      findings: [{
        priority: 'P1',
        title: '缺少空指针防护',
        body: '函数未检查参数类型。',
        path: 'src/app.js',
        side: 'RIGHT',
        line: 2,
        startLine: 2,
      }],
    },
    turns: 1,
    usage: { inputTokens: 200, outputTokens: 100 },
  });

  const settings = {
    ...DEFAULT_SETTINGS,
    mode: 'api',
    apiKey: 'smoke-test-key',
    apiKeySet: true,
    model: 'fake-model',
    permissionMode: 'full-auto',
    hooksEnabled: false,
    mcpServers: [],
  };

  let win;
  const rendererErrors = [];
  const network = [];
  const worktreeManager = createWorktreeManager({ githubCli: github });
  const worktrees = createWorktreeIpcHandlers({ manager: worktreeManager });

  const js = (source) => win.webContents.executeJavaScript(source);
  async function until(source, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`UI condition timed out: ${source}`);
  }

  app.whenReady().then(async () => {
    try {
      const prAudits = createPrAuditManager({
        githubCli: github,
        userDataPath: profile,
        safeStorage,
        runtime: fakeRuntime,
        getSettings: () => settings,
        onEvent: (event, ownerIds) => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send('engineering:pr-audit:event', event);
        },
      });

      const prReviews = createPrReviewManager({ github, worktree: worktreeManager, userDataPath: profile, safeStorage, resolveRepo: () => root });
      const ciWatches = createCiWatchManager({ githubCli: github });

      const engineering = createEngineeringIpcHandlers({
        prAuditManager: prAudits,
        prReviewManager: prReviews,
        ciWatchManager: ciWatches,
        githubCli: github,
        worktreeManager,
        userDataPath: profile,
        safeStorage,
        getSettings: () => settings,
        resolveBinding: (event, payload) => worktrees.resolveBinding(event, payload),
        createPermissionGate: (event) => createPermissionGate({
          permissionMode: 'full-auto',
          onApprovalNeeded: (approval) => {
            event.sender.send('chat:event', { type: 'approval-needed', ...approval });
          },
        }),
        onPrAuditEvent: (event, ownerIds) => {
          if (!win || win.isDestroyed() || !ownerIds.includes(win.webContents.id)) return;
          win.webContents.send('engineering:pr-audit:event', event);
        },
      });

      const handlers = new Map();
      handlers.set('settings:get', () => settings);
      handlers.set('worktree:bind', (event, payload) => {
        const previous = worktrees.listProjectPaths(event);
        const result = worktrees.bind(event, payload);
        for (const old of previous) if (!worktrees.hasProjectBinding(event, old)) engineering.dropProject(event, old);
        engineering.syncOwnerBindings(event, worktrees.listProjectPaths(event));
        return result;
      });
      for (const [channel, method] of [['worktree:list', 'list'], ['worktree:get', 'get'], ['worktree:pr:list', 'listPrs'], ['worktree:pr:get', 'getPr']]) {
        handlers.set(channel, (event, payload) => worktrees[method](event, payload));
      }
      for (const [action, method] of [
        ['start', 'prAuditStart'], ['list', 'prAuditList'], ['get', 'prAuditGet'], ['cancel', 'prAuditCancel'],
        ['context', 'prAuditContext'], ['prepare', 'prAuditPrepare'], ['publish', 'prAuditPublish'], ['reconcile', 'prAuditReconcile'],
      ]) {
        handlers.set(`engineering:pr-audit:${action}`, (event, payload) => engineering[method](event, payload));
      }
      for (const [action, method] of [['threads', 'prReviewThreads'], ['get', 'prReviewGet']]) {
        handlers.set(`engineering:pr-review:${action}`, (event, payload) => engineering[method](event, payload));
      }
      for (const [action, method] of [['list', 'ciWatchList'], ['get', 'ciWatchGet']]) {
        handlers.set(`engineering:ci-watch:${action}`, (event, payload) => engineering[method](event, payload));
      }
      handlers.set('chat:approve', (event, payload) => ({ ok: engineering.resolveApproval(event, payload.approvalId, payload.decision) }));
      handlers.set('engineering:remote-ci:failures', () => ({ ok: true, failures: [], unsupported: [] }));
      handlers.set('engineering:pr-audit:recheck:list', (event, payload) => engineering.prAuditRecheckList(event, payload));
      for (const [channel, result] of [
        ['engineering:index:ensure', { ok: true, state: 'ready' }], ['engineering:index:status', { ok: true, state: 'ready' }],
        ['engineering:verification:profiles', { ok: true, profiles: [], candidates: [] }], ['engineering:verification:list', { ok: true, jobs: [] }],
        ['engineering:workflow:list', { ok: true, workflows: [] }], ['engineering:workflow:runs', { ok: true, runs: [] }],
        ['engineering:repair:list', { ok: true, repairs: [] }],
        ['mcp:tasks:list', { ok: true, tasks: [] }], ['mcp:oauth:status', { ok: true, servers: [] }], ['mcp:session:status', { ok: true, servers: [] }],
        ['hooks:summary', { ok: true, hooks: [] }], ['memory:list', { ok: true, entries: [] }], ['usage:summary', { ok: true, summary: {}, groups: [] }], ['skills:list', { ok: true, skills: [] }],
      ]) {
        handlers.set(channel, () => result);
      }

      const preload = path.resolve(__dirname, '../src/preload.js');
      for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))) {
        ipcMain.handle(channel, (event, payload) => {
          if (handlers.has(channel)) return handlers.get(channel)(event, payload);
          throw new Error(`Unexpected smoke IPC: ${channel}`);
        });
      }

      win = new BrowserWindow({
        width: 1100, height: 720, frame: false, show: false,
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        network.push(details.url); callback({ cancel: true });
      });
      win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) { worktrees.dropSender(win.webContents.id); engineering.dropSender(win.webContents.id); }
      });

      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      await js(`(async () => {
        projects = [{ id: 'smoke-d17', name: 'D17 AI 审查', path: ${JSON.stringify(root)} }];
        sessions = [{ id: 'session-d17', title: 'D17 AI 审查', kind: 'project', peer: 'codex', projectId: 'smoke-d17', messages: [], updatedAt: Date.now() }];
        activeSessionId = 'session-d17';
        saveState();
        await bindWorktreeProject(projects[0]);
        setView('prs');
        await loadPullRequests();
        await loadPullRequestDetail(7);
      })()`);

      // Verify PR Audit panel is mounted
      await until("Boolean(document.querySelector('.pr-audit-panel'))");
      assert.equal(await js("Boolean(document.querySelector('[data-audit-action=start]'))"), true);

      // Start AI PR Audit
      await js("document.querySelector('[data-audit-action=start]').click()");

      // Wait until completed
      await until("document.querySelector('.pr-audit-status')?.textContent.includes('审查完成')");
      assert.equal(await js("document.querySelectorAll('.pr-audit-finding').length"), 1);

      // View code context
      await js("document.querySelector('[data-audit-context]').click()");
      await until("Boolean(document.querySelector('.pr-audit-code'))");

      // Select finding and edit title
      await js(`(() => {
        const check = document.querySelector('[data-audit-check]');
        check.checked = true;
        check.dispatchEvent(new Event('change'));
        const title = document.querySelector('[data-audit-title]');
        title.value = 'SMOKE_EDITED_TITLE';
        title.dispatchEvent(new Event('input'));
      })()`);

      // Prepare review
      await js("document.querySelector('[data-audit-action=prepare]').click()");
      await until("Boolean(document.querySelector('[data-audit-preview] pre'))");
      assert.match(await js("document.querySelector('[data-audit-preview] pre').textContent"), /SMOKE_EDITED_TITLE/);

      // Publish review
      await js("document.querySelector('[data-audit-action=publish]').click()");

      // Handle approval dialog
      await until("!document.getElementById('app-dialog').classList.contains('hidden')");
      await js("document.getElementById('app-dialog-ok').click()");

      // Wait until published notice appears
      await until("document.querySelector('.pr-audit-notice')?.textContent.includes('COMMENT Review 已发布')");

      // Verify published data in fake GitHub
      assert.equal(publishedReviews.length, 1);
      assert.equal(publishedComments.length, 1);
      assert.match(publishedComments[0].body, /SMOKE_EDITED_TITLE/);

      // Switch to engineering center
      await js("setView('scheduled')");
      await until("Boolean(document.querySelector('.pr-audit-center'))");
      assert.equal(await js("document.querySelectorAll('.pr-audit-center .pr-audit-history-row').length"), 1);

      // Click history item in center to navigate back to PR
      await js("document.querySelector('.pr-audit-center [data-audit-open]').click()");
      await until("currentView === 'prs' && pullRequestView.selectedNumber === 7");

      assert.equal(network.length, 0, 'No unexpected network requests');
      assert.equal(rendererErrors.length, 0, `Renderer errors: ${rendererErrors.join('; ')}`);

      console.log('Phase D17 smoke test PASSED successfully.');
      engineering.close();
      app.quit();
    } catch (err) {
      console.error('Phase D17 smoke test failed:', err);
      app.exit(1);
    }
  });
}
