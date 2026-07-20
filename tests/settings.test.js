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
});
