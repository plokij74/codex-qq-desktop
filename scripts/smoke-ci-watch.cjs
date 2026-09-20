'use strict';

// Run with: node scripts/smoke-ci-watch.cjs
// Real Electron renderer/preload + real watch/IPC managers, fake GitHub only.
// Uses an isolated temporary profile; no GitHub access or OS notifications.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { createCiWatchManager } = require('../src/ai/ci-watch-manager');
  const { createEngineeringIpcHandlers } = require('../src/ai/engineering-ipc');
  const { createWorktreeIpcHandlers } = require('../src/ai/worktree-ipc');
  const { DEFAULT_SETTINGS } = require('../src/ai/settings');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d15-smoke-'));
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  const roots = ['project-a', 'project-b'].map((name) => { const root = path.join(profile, name); fs.mkdirSync(root); return root; });
  const head = 'a'.repeat(40); const repoKey = 'b'.repeat(64);
  const unexpected = []; const rendererErrors = []; const network = [];
  let win; let engineering; let watches; let clockNow = Date.now(); let nextTimer = 0;
  let started = 0; let queryCount = 0;
  const timers = new Map();
  const ghState = { status: 'in_progress', conclusion: '' };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  async function advance(ms = 0) {
    const end = clockNow + ms;
    for (;;) {
      await turn();
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clockNow = Math.max(clockNow, next[1].at); timers.delete(next[0]); next[1].fn();
    }
    clockNow = end; await turn();
  }
  async function js(source) { return win.webContents.executeJavaScript(source); }
  async function until(source) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await js(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`UI condition timed out: ${source}`);
  }
  async function capture(name) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(profile, name + '.png'), image.toPNG());
  }
  const repository = { host: 'github.com', owner: 'example', repo: 'demo', nameWithOwner: 'example/demo' };
  function pr(number) {
    return { number, url: `https://github.com/example/demo/pull/${number}`, title: `D15 smoke PR ${number}`, body: 'Test-only PR description',
      state: 'OPEN', author: 'smoke-test', isDraft: false, headRefName: 'feature/d15', baseRefName: 'main', headSha: head,
      checks: [], checksSummary: {}, files: [], comments: [], mergeable: 'UNKNOWN' };
  }
  const worktrees = createWorktreeIpcHandlers({ manager: {} });
  const handlers = new Map();
  let settings = { ...DEFAULT_SETTINGS, mcpServers: [], apiKeySet: false };
  handlers.set('settings:get', () => settings);
  handlers.set('settings:save', (_event, payload) => { settings = { ...settings, ...payload }; return settings; });
  handlers.set('worktree:bind', (event, payload) => {
    const previous = worktrees.listProjectPaths(event);
    const result = worktrees.bind(event, payload);
    for (const root of previous) if (!worktrees.hasProjectBinding(event, root)) engineering.dropProject(event, root);
    engineering.syncOwnerBindings(event, worktrees.listProjectPaths(event));
    return result;
  });
  handlers.set('worktree:list', () => ({ ok: true, results: [] }));
  handlers.set('worktree:pr:list', (_event, payload) => ({ ok: true, repo: repository, prs: [pr(payload.state === 'closed' ? 8 : 7), pr(9)] }));
  handlers.set('worktree:pr:get', (_event, payload) => ({ ok: true, repo: repository, pr: pr(payload.number) }));
  handlers.set('engineering:remote-ci:failures', () => ({ ok: true, failures: [], unsupported: [] }));
  for (const [channel, result] of [
    ['engineering:index:ensure', { ok: true, state: 'ready' }], ['engineering:index:status', { ok: true, state: 'ready' }],
    ['engineering:verification:profiles', { ok: true, profiles: [], candidates: [] }],
    ['engineering:verification:list', { ok: true, jobs: [] }],
    ['engineering:workflow:list', { ok: true, workflows: [] }], ['engineering:workflow:runs', { ok: true, runs: [] }],
    ['engineering:repair:list', { ok: true, repairs: [] }],
    ['mcp:tasks:list', { ok: true, tasks: [] }], ['mcp:oauth:status', { ok: true, servers: [] }],
    ['mcp:session:status', { ok: true, servers: [] }], ['hooks:summary', { ok: true, hooks: [] }],
    ['memory:list', { ok: true, entries: [] }], ['usage:summary', { ok: true, summary: {}, groups: [] }],
    ['skills:list', { ok: true, skills: [] }],
  ]) handlers.set(channel, () => result);
  for (const [action, method] of [['start', 'ciWatchStart'], ['list', 'ciWatchList'], ['get', 'ciWatchGet'], ['stop', 'ciWatchStop'], ['ack', 'ciWatchAck']]) {
    handlers.set(`engineering:ci-watch:${action}`, (event, payload) => { if (action === 'start') started++; return engineering[method](event, payload); });
  }
  const preload = path.resolve(__dirname, '../src/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]));
  for (const channel of channels) ipcMain.handle(channel, (event, payload) => {
    if (handlers.has(channel)) return handlers.get(channel)(event, payload);
    unexpected.push(channel); throw new Error(`Unexpected smoke IPC: ${channel}`);
  });

  app.whenReady().then(async () => {
    try {
      watches = createCiWatchManager({
        now: () => clockNow,
        setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: clockNow + ms }); return id; },
        clearTimeout: (id) => timers.delete(id),
        githubCli: {
          getCiWatchRepository: async ({ projectPath }) => ({ ok: true, repository: { ...repository, repoRoot: projectPath, repoKey } }),
          getCiWatchOrigin: async () => ({ ok: true, repoKey }),
          getCiPrStatus: async ({ number }) => ({ ok: true, pr: { ...pr(number), isCrossRepository: false, headRepository: repository.nameWithOwner } }),
          getCiRunsForHead: async () => { queryCount++; return { ok: true, runs: [{ id: '90071992547409931', name: '构建 / 单元测试 · Windows', headSha: head, runAttempt: 2, ...ghState }] }; },
        },
        onEvent: (event) => {
          if (win && !win.isDestroyed() && engineering?.ciWatchOwnerIds(event.projectKey).includes(win.webContents.id)) win.webContents.send('engineering:ci-watch:event', event);
        },
      });
      engineering = createEngineeringIpcHandlers({ ciWatchManager: watches, resolveBinding: (event, payload) => worktrees.resolveBinding(event, payload) });
      win = new BrowserWindow({ width: 1100, height: 720, frame: false, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
      win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) { worktrees.dropSender(win.webContents.id); engineering.dropSender(win.webContents.id); }
      });
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      await js(`(async () => {
        projects = ${JSON.stringify(roots.map((root, index) => ({ id: `smoke-${index}`, path: root, name: `D15 项目 ${index + 1}`, createdAt: Date.now() })))};
        sessions = projects.map((p) => ({ id: 'session-' + p.id, title: p.name, kind: 'project', peer: 'codex', projectId: p.id, messages: [], updatedAt: Date.now() }));
        activeSessionId = sessions[0].id; saveState();
        await Promise.all(projects.map((p) => bindWorktreeProject(p)));
        setView('prs'); await loadPullRequests(); await loadPullRequestDetail(7);
      })()`);
      await until("Boolean(document.querySelector('#pr-ci-watch [data-ci-action=\"start\"]:not(:disabled)'))");
      assert.equal(started, 0);
      await js("document.querySelector('#pr-ci-watch [data-ci-action=\"start\"]').click()");
      await until('ciWatchUi.snapshot().length === 1'); await advance();
      await until("ciWatchUi.snapshot()[0].status === 'watching'");
      await js("document.querySelector('#pr-ci-watch [data-ci-action=\"details\"]').click(); document.querySelector('.pr-edit-title').value = 'unsaved title'; document.querySelector('.pr-edit-body').value = 'unsaved body'; document.querySelector('.pr-comment-input').value = 'unsaved comment';");
      await advance(15_000);
      await until('ciWatchUi.snapshot()[0].revision >= 3');
      assert.deepEqual(await js("['.pr-edit-title', '.pr-edit-body', '.pr-comment-input'].map((s) => document.querySelector(s).value)"), ['unsaved title', 'unsaved body', 'unsaved comment']);
      for (const [width, height] of [[1100, 720], [900, 580]]) {
        win.setContentSize(width, height);
        await js("document.getElementById('pr-ci-watch').scrollIntoView({block:'center'})");
        await capture(`pr-${width}x${height}`);
        const sizes = await js("['.pr-detail', '.ci-watch-panel', '.qq-toolbar'].map((s) => { const n = document.querySelector(s); return {selector:s, width:n.clientWidth, scroll:n.scrollWidth}; })");
        for (const size of sizes) assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
      }
      await js("openProjectChat('smoke-1')"); win.minimize();
      ghState.status = 'completed'; ghState.conclusion = 'failure'; await advance(45_000);
      await until("document.getElementById('btn-ci-watch').textContent.includes('1 未读')");
      assert.equal(watches.list(roots[0]).watches[0].outcome, 'failed');
      win.restore();
      await js("document.getElementById('btn-ci-watch').click()");
      await capture('inbox-900x580');
      await js("document.querySelector('#ci-watch-inbox [data-ci-action=\"failures\"]').click()");
      await until("sessionProject()?.id === 'smoke-0' && pullRequestView.detail?.number === 7 && ciWatchUi.snapshot()[0].unread === false");
      await js("setView('scheduled')");
      await until("Boolean(document.querySelector('#engineering-ci-watches .ci-watch-record'))");
      await capture('engineering-900x580');
      // Reload while another watch is active. No watch is stored in localStorage.
      ghState.status = 'in_progress'; ghState.conclusion = '';
      await js("ciWatchUi.start('smoke-1', 9, 15)"); await advance();
      assert.equal(started, 2);
      assert.doesNotMatch(await js("localStorage.getItem(STORAGE_KEY)"), /ciw_|watchRef|ciWatch/);
      const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      win.reload(); await reloaded;
      await until('ciWatchUi.snapshot().length === 2');
      assert.equal(started, 2);
      assert.equal(watches.list(roots[1]).watches[0].status, 'watching');
      await js('openSettings()');
      assert.equal(await js("document.getElementById('set-ci-watch-notifications').checked"), false);
      await js("document.getElementById('set-ci-watch-notifications').scrollIntoView({block:'center'})");
      await capture('settings-900x580');
      const settingWidth = await js("(() => { const n = document.querySelector('#settings-modal .modal-card'); return [n.clientWidth,n.scrollWidth]; })()");
      assert.ok(settingWidth[1] <= settingWidth[0] + 1);
      assert.deepEqual(unexpected, []); assert.deepEqual(rendererErrors, []); assert.deepEqual(network, []);
      console.log(JSON.stringify({ ok: true, sizes: ['1100x720', '900x580'], started, queryCount, rendererErrors, networkRequests: network.length, artifacts: profile }));
      engineering.close(); win.destroy(); app.exit(0);
    } catch (error) {
      console.error(error.stack || error); console.error(JSON.stringify({ unexpected, rendererErrors, artifacts: profile }));
      engineering?.close(); win?.destroy(); app.exit(1);
    }
  });
}
