'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : text.length;
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return text.slice(start, end);
}

function assertIdOnce(html, id) {
  const matches = html.match(new RegExp(`\\bid=["']${escapeRegExp(id)}["']`, 'g')) || [];
  assert.equal(matches.length, 1, `expected one #${id} control, found ${matches.length}`);
}

function tagWithId(html, id) {
  const match = html.match(new RegExp(`<[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`, 'i'));
  assert.ok(match, `missing tag for #${id}`);
  return match[0];
}

const preload = source('src/preload.js');
const main = source('src/main.js');
const html = source('src/renderer/index.html');
const app = source('src/renderer/app.js');
const css = source('src/renderer/styles.css');

describe('D.3 preload and main-process integration', () => {
  it('exposes the three renderer APIs through their IPC channels', () => {
    assert.match(preload, /webFetch\s*:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]web:fetch['"]\s*,\s*payload\s*\|\|\s*\{\}\s*\)/);
    assert.match(preload, /usageSummary\s*:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]usage:summary['"]\s*,\s*payload\s*\|\|\s*\{\}\s*\)/);
    assert.match(preload, /usageClear\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]usage:clear['"]\s*\)/);
  });

  it('registers web fetch, usage summary, and usage clear IPC handlers', () => {
    assert.equal(countOf(main, "ipcMain.handle('web:fetch'"), 1);
    assert.equal(countOf(main, "ipcMain.handle('usage:summary'"), 1);
    assert.equal(countOf(main, "ipcMain.handle('usage:clear'"), 1);

    const web = section(main, "ipcMain.handle('web:fetch'", "ipcMain.handle('usage:summary'");
    assert.match(web, /settings\.webEnabled\s*!==\s*true/);
    assert.match(web, /fetchUrl\(String\(payload\.url\s*\|\|\s*['"]['"]\)/);
    for (const setting of ['webAllowDomains', 'webDenyDomains', 'webMaxBytes', 'webTimeoutMs', 'webMaxChars']) {
      assert.match(web, new RegExp(`settings\\.${setting}\\b`));
    }

    const summary = section(main, "ipcMain.handle('usage:summary'", "ipcMain.handle('usage:clear'");
    assert.match(summary, /readRecords\(usageFilePath\(userDataPath\(\)\)\)/);
    assert.match(summary, /aggregate\(filtered\s*,\s*\{\s*groupBy:\s*payload\.groupBy\s*\}\)/);
    assert.match(summary, /\bskipped\b/);

    const clear = section(main, "ipcMain.handle('usage:clear'", null);
    assert.match(clear, /clearRecords\(usageFilePath\(userDataPath\(\)\)\)/);
  });

  it('meters the fallback chatCompletionMessage call exactly once', () => {
    const fallback = section(main, '// Fallback single-shot', 'if (signal.aborted) throwAborted();');
    assert.equal(countOf(fallback, 'chatCompletionMessage({'), 1);
    assert.equal(countOf(fallback, 'buildUsageEvent({'), 1);
    assert.equal(countOf(fallback, 'emit(usageEvent)'), 1);
    assert.ok(fallback.indexOf('chatCompletionMessage({') < fallback.indexOf('buildUsageEvent({'));
    assert.ok(fallback.indexOf('buildUsageEvent({') < fallback.indexOf('emit(usageEvent)'));
    assert.match(fallback, /if\s*\(!content\)\s*throw new Error\(['"]API 返回空内容['"]\)/);

    const emit = section(main, "if (e && e.type === AGENT_EVENTS.USAGE)", "safeSend(sender, 'chat:event'");
    assert.equal(countOf(emit, 'persistUsageEvent(settings, sessionId, e)'), 1);
  });
});

describe('D.3 renderer markup', () => {
  it('has the session usage bar and composer context meter', () => {
    assertIdOnce(html, 'usage-bar');
    assertIdOnce(html, 'context-meter');
    assert.match(tagWithId(html, 'usage-bar'), /class=["'][^"']*\busage-bar\b[^"']*\bhidden\b[^"']*["']/);
    assert.match(tagWithId(html, 'context-meter'), /class=["'][^"']*\bcontext-meter\b[^"']*\bhidden\b[^"']*["']/);
    assert.ok(html.indexOf('id="usage-bar"') < html.indexOf('id="chat-input"'));
    assert.ok(html.indexOf('id="context-meter"') < html.indexOf('id="chat-input"'));
  });

  it('has all web and usage settings controls', () => {
    const ids = [
      'set-web-enabled',
      'set-web-confirm',
      'set-web-allow',
      'set-web-deny',
      'set-web-timeout',
      'set-web-max-bytes',
      'set-web-max-chars',
      'set-usage-enabled',
      'set-usage-max-records',
      'set-usage-pricing',
      'set-usage-currency',
      'usage-summary-box',
      'btn-usage-clear',
    ];
    for (const id of ids) assertIdOnce(html, id);
    assert.match(tagWithId(html, 'set-web-enabled'), /type=["']checkbox["']/);
    assert.match(tagWithId(html, 'set-usage-enabled'), /type=["']checkbox["']/);
    assert.match(tagWithId(html, 'set-web-timeout'), /min=["']3000["']/);
    assert.match(tagWithId(html, 'set-usage-max-records'), /max=["']50000["']/);
  });
});

describe('D.3 renderer behavior', () => {
  it('wires /fetch and /usage commands to the preload APIs', () => {
    const slash = section(app, 'function handleSlashCommand(text)', 'function clearCurrentChat()');
    assert.match(slash, /lower\.startsWith\(\s*['"]\/fetch ['"]\s*\)/);
    assert.match(slash, /window\.codex\.webFetch\(\s*\{\s*url\s*\}\s*\)/);
    assert.match(slash, /result\.truncated/);
    assert.match(slash, /lower\s*===\s*['"]\/usage['"]/);
    assert.match(slash, /const\s+query\s*=\s*\(from,\s*groupBy\)\s*=>\s*window\.codex\.usageSummary/);
    assert.match(slash, /query\([^)]*,\s*['"]kind['"]\)/);
    assert.match(slash, /query\([^)]*,\s*['"]model['"]\)/);
    assert.match(slash, /\/fetch <url>/);
    assert.match(slash, /['"]今日['"]/);
    assert.match(slash, /['"]本周['"]/);
    assert.match(slash, /['"]总计['"]/);
  });

  it('accumulates usage events and redraws both meters', () => {
    const events = section(app, 'function handleChatEvent(ev)', 'function renderLeftDynamic()');
    assert.match(events, /if\s*\(type\s*===\s*['"]usage['"]\)/);
    assert.match(events, /applyUsageToSession\(session,\s*ev\)/);
    const accumulator = section(app, 'function applyUsageToSession(session, event)', 'function renderUsageBar()');
    for (const field of ['inputTokens', 'outputTokens', 'estimated', 'kind', 'contextTokens', 'contextLimit']) {
      assert.match(accumulator, new RegExp(`event\\.${field}\\b`));
    }
    assert.match(events, /saveState\(\)/);
    assert.match(events, /renderUsageBar\(\)/);
    assert.match(events, /renderContextMeter\(\)/);

    assert.match(app, /function\s+renderUsageBar\s*\(\)/);
    assert.match(app, /getElementById\(\s*['"]usage-bar['"]\s*\)/);
    assert.match(app, /function\s+renderContextMeter\s*\(\)/);
    assert.match(app, /getElementById\(\s*['"]context-meter['"]\s*\)/);
    assert.match(app, /classList\.toggle\(\s*['"]is-over['"]/);
    assert.match(app, /if\s*\(!usageDisplayEnabled\s*\|\|/);
    assert.match(app, /`\$\{approximate\}↑/);
    assert.match(app, /getElementById\(\s*['"]usage-bar['"]\s*\)[\s\S]{0,300}addEventListener\(\s*['"]click['"]/);
  });

  it('attributes compact usage to its session and merges the returned event', () => {
    const compact = section(app, 'function requestCompact(session, force)', '/** Manual `/compact`');
    assert.match(compact, /sessionId:\s*String\(session\?\.id\s*\|\|\s*['"]['"]\)/);
    assert.match(app, /if\s*\(res\.usage\)\s*applyUsageToSession\(session,\s*res\.usage\)/);
  });

  it('loads, saves, summarizes, and clears D.3 settings', () => {
    const open = section(app, 'async function openSettings()', 'function closeSettings()');
    const save = section(app, 'async function saveSettingsFromForm()', 'async function sendMessage()');
    const pairs = [
      ['set-web-enabled', 'webEnabled'],
      ['set-web-confirm', 'webRequireConfirm'],
      ['set-web-allow', 'webAllowDomains'],
      ['set-web-deny', 'webDenyDomains'],
      ['set-web-timeout', 'webTimeoutMs'],
      ['set-web-max-bytes', 'webMaxBytes'],
      ['set-web-max-chars', 'webMaxChars'],
      ['set-usage-enabled', 'usageEnabled'],
      ['set-usage-max-records', 'usageMaxRecords'],
      ['set-usage-pricing', 'usagePricing'],
      ['set-usage-currency', 'usageCurrency'],
    ];
    for (const [id, setting] of pairs) {
      assert.match(open, new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)`), `${id} is not loaded`);
      assert.match(open, new RegExp(`settings\\.${setting}\\b`), `${setting} is not read`);
      assert.match(save, new RegExp(`\\b${setting}\\s*:`), `${setting} is not saved`);
      assert.match(save, new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)`), `${id} is not saved`);
    }
    assert.match(app, /async\s+function\s+refreshUsageSummaryBox\s*\(\)/);
    assert.match(app, /window\.codex\.usageSummary\(\s*\{\s*groupBy:\s*['"]model['"]\s*\}\s*\)/);
    assert.match(app, /getElementById\(\s*['"]btn-usage-clear['"]\s*\)[\s\S]{0,300}window\.codex\.usageClear\(\)/);
  });

  it('shows the approved network scope in the approval card', () => {
    const approval = section(app, 'function renderApprovalCard(ev)', 'function handleChatEvent(ev)');
    assert.match(approval, /ev\.risk\s*===\s*['"]network['"]/);
    assert.match(approval, /ev\.scope/);
  });
});

describe('D.3 renderer styles', () => {
  it('styles usage, context warning, and settings summary states', () => {
    assert.match(css, /\.usage-bar\s*\{/);
    assert.match(css, /\.context-meter\s*\{/);
    assert.match(css, /\.context-meter\.is-over\s*\{/);
    assert.match(css, /\.usage-summary\s*\{/);
  });
});
