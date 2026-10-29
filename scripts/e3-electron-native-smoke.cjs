'use strict';
// Run with the repository's real Electron executable. Uses disposable userData only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const repo = path.resolve(__dirname, '..');
const output = process.env.E3_ELECTRON_QA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-electron-status-'));
fs.mkdirSync(output, { recursive: true });
const userData = path.join(output, 'disposable-user-data');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
const guard = setTimeout(() => { console.error('E3 Electron status QA exceeded 60 seconds'); app.exit(1); }, 60_000);
require(path.join(repo, 'src/main.js'));
app.whenReady().then(async () => {
  try {
    let win = BrowserWindow.getAllWindows()[0];
    if (!win) win = await new Promise((resolve) => app.once('browser-window-created', (_event, created) => resolve(created)));
    assert.ok(win, 'Actual main must create its production window');
    win.setTitle('E3 QA — disposable native isolation status');
    if (win.webContents.isLoadingMainFrame()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const inspect = () => win.webContents.executeJavaScript(`(async () => {
      await updateIsolationBadge();
      const element = document.getElementById('isolation-badge');
      return { status: await window.codex.getIsolationStatus(), badge: { text: element.textContent, className: element.className, title: element.title } };
    })()`);
    await win.webContents.executeJavaScript("window.codex.saveSettings({ executionPolicy: 'strict-isolated' })");
    const strict = await inspect();
    assert.equal(strict.status.capabilities.osIsolationAvailable, true);
    assert.match(strict.badge.text, /Windows OS 隔离可用/);
    assert.doesNotMatch(strict.badge.text, /已隔离/);
    const strictImage = path.join(output, 'strict-backend-available.png');
    fs.writeFileSync(strictImage, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window.codex.saveSettings({ executionPolicy: 'host-unconfined' })");
    const host = await inspect();
    assert.match(host.badge.text, /宿主执行模式（未隔离）/);
    assert.equal(host.status.capabilities.activeMode, 'host-unconfined');
    assert.equal(host.status.capabilities.requiresHostConfirmation, true);
    assert.match(host.status.modeSource, /per command/);
    assert.equal(host.badge.className, 'isolation-badge unconfined');
    const hostImage = path.join(output, 'explicit-host-not-isolated.png');
    fs.writeFileSync(hostImage, (await win.webContents.capturePage()).toPNG());
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await loaded;
    const reloaded = await inspect();
    assert.match(reloaded.badge.text, /宿主执行模式（未隔离）/);
    assert.equal(reloaded.status.executionPolicy, 'host-unconfined');
    const result = {
      ok: true, scope: 'Actual Electron main, preload IPC and renderer with disposable userData; no model, external service or terminal command used by this UI smoke',
      strict, host, reloaded, screenshots: [strictImage, hostImage], userData,
      result: path.join(output, 'result.json'),
    };
    fs.writeFileSync(result.result, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    clearTimeout(guard); app.exit(0);
  } catch (error) {
    console.error(error.stack); clearTimeout(guard); app.exit(1);
  }
}).catch((error) => { console.error(error.stack); clearTimeout(guard); app.exit(1); });
