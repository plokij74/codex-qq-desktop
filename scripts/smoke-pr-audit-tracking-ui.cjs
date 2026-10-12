'use strict';
// Focused real-Electron check of D21's read model, preload and panel. Lifecycle
// delivery is exercised separately by smoke-pr-audit-tracking.cjs.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { pathToFileURL } = require('node:url'); const assert = require('node:assert/strict');
  const { followupFixture } = require('../tests/helpers/pr-audit-recheck-repair-fixture');
  const { PrAuditTracking } = require('../src/ai/pr-audit-tracking');
  const A = require('../src/ai/pr-audit-state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d21-ui-'));
  app.setPath('userData', dir); app.disableHardwareAcceleration();
  for (const flag of ['no-sandbox', 'disable-gpu', 'disable-software-rasterizer']) app.commandLine.appendSwitch(flag);
  app.whenReady().then(async () => {
    const cleanups = []; let win;
    try {
      const f = await followupFixture({ after: (fn) => cleanups.push(fn) });
      const tasks = [{ repairRef: A.ref('rpr'), projectKey: f.row.projectKey, source: { kind: 'pr_audit', auditRepairRef: f.item.auditRepairRef },
        resultId: f.marker.id, createdAt: '2026-10-10T00:00:00.000Z', status: 'ready' }];
      let parent = f.parent;
      for (let round = 1; round <= 2; round++) {
        const saved = await f.snapshot([f.parent.source.findingIds[0]], parent); assert.equal(saved.ok, true, saved.code);
        const marker = f.deliver(saved.recheckRepairRef);
        tasks.push({ repairRef: A.ref('rpr'), projectKey: f.row.projectKey, source: { kind: 'pr_audit_recheck', recheckRepairRef: saved.recheckRepairRef },
          resultId: marker.id, createdAt: `2026-10-${10 + round}T00:00:00.000Z`, status: 'ready', validation: { status: 'passed' } });
        f.rechecks.now = () => Date.parse(f.parent.createdAt) + round * 1000;
        f.rechecks.runtime = async ({ snapshot, findings }) => {
          const e = await snapshot.read({});
          return { report: { summary: '逐项复审', findings: findings.map((v) => ({ findingId: v.findingId,
            status: round === 2 ? 'resolved' : 'still_present', reason: '已检查对应提交的输入处理', evidence: [e.evidenceId] })) } };
        };
        parent = await f.done(await f.rechecks.start(f.root, marker.id));
      }
      const tracking = new PrAuditTracking({ audits: f.audits, auditRepairs: f.manager, followups: f.followups, rechecks: f.rechecks,
        worktree: f.worktree, repairs: { store: { list: () => tasks, persistenceStatus: () => ({ persistence: 'memory' }) } } });
      ipcMain.handle('engineering:pr-audit:tracking:list', (_e, p) => tracking.list(f.root, p.prNumber));
      ipcMain.handle('engineering:pr-audit:tracking:get', (_e, p) => tracking.get(f.root, p.auditRef));
      const style = pathToFileURL(path.resolve(__dirname, '../src/renderer/styles.css')).href;
      const script = pathToFileURL(path.resolve(__dirname, '../src/renderer/pr-audit-tracking-ui.js')).href;
      const harness = path.join(dir, 'panel.html');
      fs.writeFileSync(harness, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${style}">
        <style>html,body{height:100%;overflow:auto}body{margin:0;padding:14px;box-sizing:border-box;background:#e9f4fc}#panel{width:100%;min-width:0}</style>
        <div id="panel"></div><script src="${script}"></script><script>
        window.nav=[];
        window.panel=PrAuditTrackingUi.create({api:codex,document,getProject:()=>({path:'fixture'}),getToken:()=> 'fixture-token',
          openOriginal:p=>nav.push(['original',p]),openRecheck:p=>nav.push(['recheck',p]),openRepair:p=>nav.push(['repair',p]),openResult:p=>nav.push(['result',p]),navigateToPr:p=>nav.push(['navigate',p])});
        window.ready=panel.mount(document.getElementById('panel'),{projectId:'fixture',prNumber:7});</script>`);
      win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { preload: path.resolve(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false } });
      const errors = []; const network = [];
      win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => { network.push(d.url); cb({ cancel: true }); });
      const js = (source) => win.webContents.executeJavaScript(source);
      await win.loadFile(harness); assert.equal(await js('ready'), true);
      assert.equal(await js("document.querySelectorAll('[data-tracking-open^=round-]').length"), 3);
      assert.match(await js("document.querySelector('.tracking-detail').textContent"), /已解决 1.*待复审 \/ 未核实 1/);
      for (const [width, height] of [[1100, 720], [900, 580]]) {
        win.setSize(width, height);
        await js("document.querySelector('[data-tracking-open^=finding-]').open=true; document.querySelector('[data-tracking-open=history]').open=true; document.querySelector('[data-tracking-open^=round-]').open=true");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await js('document.body.scrollWidth <= innerWidth'), true);
        fs.writeFileSync(path.join(dir, `tracking-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
      }
      for (const action of ['original', 'recheck', 'repair', 'result']) await js(`document.querySelector('[data-tracking-action=${action}]').click()`);
      assert.deepEqual(await js('nav.map(n=>n[0])'), ['original', 'recheck', 'repair', 'result']);
      await js('panel.refresh()'); assert.equal(await js("document.querySelector('[data-tracking-open=history]').open"), true);
      const read = f.github.getAuditPr; f.github.getAuditPr = async () => { throw A.fail('UNAVAILABLE'); };
      await js('panel.refresh()'); assert.match(await js("document.querySelector('.tracking-detail').textContent"), /已解决 0/);
      assert.match(await js("document.querySelector('.tracking-detail').textContent"), /当前性未核实/);
      f.github.getAuditPr = read;
      await win.loadFile(harness); assert.equal(await js('ready'), true);
      assert.equal(await js("document.querySelectorAll('[data-tracking-open^=round-]').length"), 3);
      await js("panel.mount(document.getElementById('panel'),{projectId:'fixture'})");
      await js("document.querySelector('[data-tracking-action=navigate]').click()");
      assert.equal(await js('nav[0][0]'), 'navigate');
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      console.log(JSON.stringify({ ok: true, sizes: ['1100x720', '900x580'], rounds: 3, offline: true, reload: true, rendererErrors: errors, networkRequests: network.length, artifacts: dir }));
      win.destroy(); for (const fn of cleanups.reverse()) await fn(); app.exit(0);
    } catch (error) { console.error(error.stack || error); console.error('Artifacts: ' + dir); win?.destroy(); for (const fn of cleanups.reverse()) await fn(); app.exit(1); }
  });
}
