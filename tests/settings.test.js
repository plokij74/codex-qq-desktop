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

  it('defaults and clamps Phase D.2 memory settings', () => {
    const { DEFAULT_SETTINGS, loadSettings, saveSettings } = require('../src/ai/settings');
    assert.equal(DEFAULT_SETTINGS.memoryEnabled, true);
    assert.equal(DEFAULT_SETTINGS.memoryMaxEntries, 200);
    assert.equal(DEFAULT_SETTINGS.memoryInjectTopN, 8);
    assert.equal(DEFAULT_SETTINGS.memoryInjectMaxTokens, 1200);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mem-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.memoryEnabled, true);
    assert.equal(s.memoryInjectTopN, 8);

    saveSettings(dir, {
      memoryMaxEntries: 1,
      memoryInjectTopN: 999,
      memoryInjectMaxTokens: 10,
    });
    const s2 = loadSettings(dir);
    assert.equal(s2.memoryMaxEntries, 20);
    assert.equal(s2.memoryInjectTopN, 30);
    assert.equal(s2.memoryInjectMaxTokens, 200);

    // 0 是合法的「不注入」，不能被 clamp 成默认值
    saveSettings(dir, { memoryInjectTopN: 0, memoryEnabled: false });
    const s3 = loadSettings(dir);
    assert.equal(s3.memoryInjectTopN, 0);
    assert.equal(s3.memoryEnabled, false);
  });

  it('D.3 defaults: web off, usage on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    const s = loadSettings(dir);
    assert.equal(s.webEnabled, false);
    assert.equal(s.webRequireConfirm, true);
    assert.deepEqual(s.webAllowDomains, []);
    assert.deepEqual(s.webDenyDomains, []);
    assert.equal(s.webTimeoutMs, 15000);
    assert.equal(s.webMaxBytes, 524288);
    assert.equal(s.webMaxChars, 15000);
    assert.equal(s.usageEnabled, true);
    assert.equal(s.usageMaxRecords, 5000);
    assert.deepEqual(s.usagePricing, []);
    assert.equal(s.usageCurrency, '$');
  });

  it('D.3 clamps numeric web/usage settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, {
      webTimeoutMs: 1, webMaxBytes: 99999999, webMaxChars: 999999,
      usageMaxRecords: 1,
    });
    const s = loadSettings(dir);
    assert.equal(s.webTimeoutMs, 3000);
    assert.equal(s.webMaxBytes, 4194304);
    assert.equal(s.webMaxChars, 50000);
    assert.equal(s.usageMaxRecords, 500);
  });

  it('D.3 normalizes domain lists and drops junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, {
      webAllowDomains: ['  HTTPS://Example.COM/docs  ', 'example.com', '', 'a.b.cn'],
    });
    assert.deepEqual(loadSettings(dir).webAllowDomains, ['example.com', 'a.b.cn']);
  });

  it('D.3 sanitizes pricing rows and caps at 20', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-'));
    saveSettings(dir, {
      usagePricing: [
        { modelPrefix: ' gpt-4o ', inputPerM: '2.5', outputPerM: 10 },
        { modelPrefix: '', inputPerM: 1, outputPerM: 1 },
        { modelPrefix: 'bad', inputPerM: -5, outputPerM: 99999 },
      ],
      usageCurrency: '\uFFE5\uFFE5\uFFE5\uFFE5\uFFE5\uFFE5',
    });
    const s = loadSettings(dir);
    assert.deepEqual(s.usagePricing, [
      { modelPrefix: 'gpt-4o', inputPerM: 2.5, outputPerM: 10 },
      { modelPrefix: 'bad', inputPerM: 0, outputPerM: 10000 },
    ]);
    assert.equal(s.usageCurrency, '\uFFE5\uFFE5\uFFE5\uFFE5');
  });

  it('D.4 defaults memory candidate extraction on and preserves explicit false', () => {
    assert.equal(DEFAULT_SETTINGS.memoryCandidateEnabled, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d4-settings-'));
    assert.equal(loadSettings(dir).memoryCandidateEnabled, true);
    saveSettings(dir, { memoryCandidateEnabled: false });
    assert.equal(loadSettings(dir).memoryCandidateEnabled, false);
  });

  it('D.4 normalizes hand-edited candidate setting to a boolean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d4-settings-'));
    fs.writeFileSync(
      getSettingsPath(dir),
      JSON.stringify({ memoryCandidateEnabled: 'false' }),
      'utf8'
    );
    assert.equal(loadSettings(dir).memoryCandidateEnabled, true);
  });

  it('D11 defaults the code index on and normalizes hand-edited switch values', () => {
    assert.equal(DEFAULT_SETTINGS.codeIndexEnabled, true);
    assert.deepEqual(DEFAULT_SETTINGS.verificationProfiles, []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-settings-'));
    assert.equal(loadSettings(dir).codeIndexEnabled, true);
    saveSettings(dir, { codeIndexEnabled: false });
    assert.equal(loadSettings(dir).codeIndexEnabled, false);
    // Only an explicit false disables the index; junk must not read as "off".
    for (const junk of ['no', 0, 'false', null]) {
      fs.writeFileSync(getSettingsPath(dir), JSON.stringify({ codeIndexEnabled: junk }), 'utf8');
      assert.equal(loadSettings(dir).codeIndexEnabled, true, `${JSON.stringify(junk)} 应视为开启`);
    }
  });

  it('D11 round-trips a project-scoped verification profile through save and load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-settings-'));
    const projectKey = 'a'.repeat(32);
    saveSettings(dir, {
      verificationProfiles: [{
        id: 'vfy_1234567890abcdef', name: 'Unit tests', kind: 'test',
        command: 'npm test', cwd: 'packages/app', timeoutMs: 120000,
        enabled: true, projectKey,
      }],
    });
    const [profile] = loadSettings(dir).verificationProfiles;
    // A dropped projectKey here silently loses every saved profile on reload.
    assert.ok(profile, 'profile 必须在重新加载后仍存在');
    assert.equal(profile.projectKey, projectKey);
    assert.equal(profile.id, 'vfy_1234567890abcdef');
    assert.equal(profile.command, 'npm test');
    assert.equal(profile.cwd, 'packages/app');
    assert.equal(profile.timeoutMs, 120000);
    assert.equal(profile.kind, 'test');
    assert.equal(profile.enabled, true);
  });

  it('D11 rejects unscoped or malformed verification profiles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-settings-'));
    const projectKey = 'b'.repeat(32);
    const base = { name: 'X', kind: 'test', command: 'npm test', cwd: '.', timeoutMs: 60000, enabled: true, projectKey };
    saveSettings(dir, {
      verificationProfiles: [
        { ...base, projectKey: undefined },        // unscoped: available to every project
        { ...base, projectKey: 'short' },          // not a canonical project key
        { ...base, name: '' },                     // no name
        { ...base, command: '' },                  // no command
        { ...base, command: 'npm test\nrm -rf /' },// newline injection
        { ...base, command: 'npm\u0000test' },     // NUL
        { ...base, cwd: '/etc' },                  // absolute cwd
        { ...base, cwd: 'C:/Windows' },            // absolute Windows cwd
        { ...base, cwd: '../outside' },            // escapes the project
      ],
    });
    assert.deepEqual(loadSettings(dir).verificationProfiles, []);
  });

  it('D11 clamps profile fields and caps profiles per project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-settings-'));
    const projectKey = 'c'.repeat(32);
    saveSettings(dir, {
      verificationProfiles: [
        { name: 'fast', kind: 'nonsense', command: 'a', cwd: './sub/', timeoutMs: 10, enabled: true, projectKey },
        { name: 'slow', kind: 'lint', command: 'b', cwd: '.', timeoutMs: 99999999, projectKey },
        { name: 'weird', kind: 'build', command: 'c', cwd: '.', timeoutMs: 'x', projectKey },
      ],
    });
    const list = loadSettings(dir).verificationProfiles;
    assert.equal(list[0].kind, 'custom');
    assert.equal(list[0].timeoutMs, 5000);
    assert.equal(list[0].cwd, 'sub');
    assert.match(list[0].id, /^vfy_[a-f0-9]{16}$/);
    assert.equal(list[1].timeoutMs, 15 * 60 * 1000);
    assert.equal(list[1].enabled, true);
    assert.equal(list[2].timeoutMs, 60000);

    saveSettings(dir, {
      verificationProfiles: Array.from({ length: 15 }, (_unused, i) => ({
        id: `vfy_${String(i).padStart(16, '0')}`, name: `p${i}`, kind: 'test',
        command: 'npm test', cwd: '.', timeoutMs: 60000, enabled: true, projectKey,
      })),
    });
    assert.equal(loadSettings(dir).verificationProfiles.length, 12);
  });

  it('D11 leaves a pre-D11 settings file and its soft verifyCommand untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d11-settings-'));
    fs.writeFileSync(
      getSettingsPath(dir),
      JSON.stringify({ mode: 'api', model: 'legacy-model', verifyCommand: 'npm run legacy' }),
      'utf8'
    );
    const s = loadSettings(dir);
    assert.equal(s.verifyCommand, 'npm run legacy');
    assert.equal(s.codeIndexEnabled, true);
    assert.deepEqual(s.verificationProfiles, []);
    assert.equal(s.model, 'legacy-model');
  });
});
