const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, getSettingsPath, loadSettings, saveSettings } = require('../src/ai/settings');

describe('settings', () => {
  it('getSettingsPath joins settings.json', () => {
    assert.equal(getSettingsPath(path.join('tmp', 'data')), path.join('tmp', 'data', 'settings.json'));
  });

  it('loadSettings returns defaults when file missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.mode, 'local');
    assert.equal(s.model, DEFAULT_SETTINGS.model);
  });

  it('saveSettings persists and loadSettings reads back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, { mode: 'api', apiKey: 'sk-test', model: 'gpt-test' });
    const s = loadSettings(dir);
    assert.equal(s.mode, 'api');
    assert.equal(s.apiKey, 'sk-test');
    assert.equal(s.model, 'gpt-test');
    assert.equal(s.baseUrl, DEFAULT_SETTINGS.baseUrl);
  });

  it('defaults permissionMode to confirm-writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.permissionMode, 'confirm-writes');
  });

  it('saveSettings persists permissionMode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, { permissionMode: 'read-only' });
    assert.equal(loadSettings(dir).permissionMode, 'read-only');
  });

  it('defaults Phase C.1 orchestration settings', () => {
    assert.equal(DEFAULT_SETTINGS.defaultAgentMode, 'agent');
    assert.equal(DEFAULT_SETTINGS.verifyCommand, '');
    assert.equal(DEFAULT_SETTINGS.verifyBeforeDone, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.defaultAgentMode, 'agent');
    assert.equal(s.verifyCommand, '');
    assert.equal(s.verifyBeforeDone, true);
  });

  it('AGENT_EVENTS includes plan and verify names', () => {
    const { AGENT_EVENTS } = require('../src/ai/agent-events');
    assert.equal(AGENT_EVENTS.PLAN_READY, 'plan-ready');
    assert.equal(AGENT_EVENTS.VERIFY_RESULT, 'verify-result');
    assert.equal(AGENT_EVENTS.PLAN_APPROVED, 'plan-approved');
    assert.equal(AGENT_EVENTS.PLAN_REJECTED, 'plan-rejected');
  });

  it('defaults Phase C.2 platform settings', () => {
    const { DEFAULT_SETTINGS } = require('../src/ai/settings');
    assert.equal(DEFAULT_SETTINGS.skillsEnabled, true);
    assert.equal(DEFAULT_SETTINGS.subagentEnabled, true);
    assert.equal(DEFAULT_SETTINGS.mcpEnabled, false);
    assert.deepEqual(DEFAULT_SETTINGS.mcpServers, []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = require('../src/ai/settings').loadSettings(dir);
    assert.equal(s.skillsEnabled, true);
    assert.equal(s.mcpEnabled, false);
  });

  it('AGENT_EVENTS includes subagent and mcp names', () => {
    const { AGENT_EVENTS } = require('../src/ai/agent-events');
    assert.equal(AGENT_EVENTS.SUBAGENT_START, 'subagent-start');
    assert.equal(AGENT_EVENTS.SUBAGENT_END, 'subagent-end');
    assert.equal(AGENT_EVENTS.MCP_STATUS, 'mcp-status');
  });

  it('defaults Phase C.3 hooksEnabled', () => {
    const { DEFAULT_SETTINGS, loadSettings } = require('../src/ai/settings');
    assert.equal(DEFAULT_SETTINGS.hooksEnabled, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    assert.equal(loadSettings(dir).hooksEnabled, true);
  });

  it('AGENT_EVENTS includes hook names', () => {
    const { AGENT_EVENTS } = require('../src/ai/agent-events');
    assert.equal(AGENT_EVENTS.HOOK_START, 'hook-start');
    assert.equal(AGENT_EVENTS.HOOK_END, 'hook-end');
  });

  it('defaults Phase C.4 exploreMaxParallel', () => {
    const { DEFAULT_SETTINGS, loadSettings, saveSettings } = require('../src/ai/settings');
    assert.equal(DEFAULT_SETTINGS.exploreMaxParallel, 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    assert.equal(loadSettings(dir).exploreMaxParallel, 2);
    saveSettings(dir, { exploreMaxParallel: 99 });
    assert.equal(loadSettings(dir).exploreMaxParallel, 3);
    saveSettings(dir, { exploreMaxParallel: 0 });
    assert.equal(loadSettings(dir).exploreMaxParallel, 1);
  });

  it('defaults Phase D.1 compact settings', () => {
    assert.equal(DEFAULT_SETTINGS.autoCompact, false);
    assert.equal(DEFAULT_SETTINGS.compactKeepMessages, 24);
    assert.equal(DEFAULT_SETTINGS.compactMaxMessages, 40);
    assert.equal(DEFAULT_SETTINGS.compactMaxApproxTokens, 24000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.autoCompact, false);
    assert.equal(s.compactKeepMessages, 24);
    assert.equal(s.compactMaxMessages, 40);
    assert.equal(s.compactMaxApproxTokens, 24000);
  });

  it('clamps Phase D.1 compact settings on save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, { compactKeepMessages: 1, compactMaxMessages: 999, compactMaxApproxTokens: 100 });
    const s = loadSettings(dir);
    assert.equal(s.compactKeepMessages, 6);
    assert.equal(s.compactMaxMessages, 200);
    assert.equal(s.compactMaxApproxTokens, 4000);
    saveSettings(dir, { autoCompact: true, compactKeepMessages: 50 });
    assert.equal(loadSettings(dir).autoCompact, true);
    assert.equal(loadSettings(dir).compactKeepMessages, 50);
  });

  it('clamps Phase D.1 compact settings on load of hand-edited file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    fs.writeFileSync(
      getSettingsPath(dir),
      JSON.stringify({
        autoCompact: 'yes',
        compactKeepMessages: 1000,
        compactMaxMessages: 'abc',
        compactMaxApproxTokens: 999999,
      }),
      'utf8'
    );
    const s = loadSettings(dir);
    assert.equal(s.autoCompact, false);
    assert.equal(s.compactKeepMessages, 80);
    assert.equal(s.compactMaxMessages, 40);
    assert.equal(s.compactMaxApproxTokens, 200000);
  });

  it('loadSettings sanitizes mcpServers (drops non-http url)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const file = getSettingsPath(dir);
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: [
          { name: 'bad', transport: 'http', url: 'file:///etc/passwd' },
          { name: 'good', command: 'npx', args: ['-y', 'x'] },
        ],
      }),
      'utf8'
    );
    const s = loadSettings(dir);
    assert.equal(s.mcpServers.length, 1);
    assert.equal(s.mcpServers[0].name, 'good');
    assert.equal(s.mcpServers[0].transport, 'stdio');
    assert.ok(!s.mcpServers.some((x) => String(x.url || '').startsWith('file:')));
  });

  it('saveSettings sanitizes mcpServers on write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const next = saveSettings(dir, {
      mcpServers: [
        { name: 'bad', transport: 'sse', url: 'file:///tmp/x' },
        { name: 'ok', transport: 'http', url: 'https://example.com/mcp' },
      ],
    });
    assert.equal(next.mcpServers.length, 1);
    assert.equal(next.mcpServers[0].name, 'ok');
    assert.equal(loadSettings(dir).mcpServers.length, 1);
  });
});
