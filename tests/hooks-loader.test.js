'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { matchTool, loadHooks, HOOK_EVENTS } = require('../src/ai/hooks-loader');

describe('matchTool', () => {
  it('matches * exact prefix and OR', () => {
    assert.equal(matchTool('*', 'write_file'), true);
    assert.equal(matchTool('write_file', 'write_file'), true);
    assert.equal(matchTool('write_file', 'read_file'), false);
    assert.equal(matchTool('mcp_*', 'mcp_srv_tool'), true);
    assert.equal(matchTool('mcp_*', 'write_file'), false);
    assert.equal(matchTool('write_file|search_replace', 'search_replace'), true);
    assert.equal(matchTool('write_file|search_replace', 'delete_path'), false);
  });
});

describe('loadHooks', () => {
  it('missing files → empty rules no throw', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-proj-'));
    const r = loadHooks({ userDataPath: user, projectPath: project });
    assert.equal(r.countsByEvent.PreToolUse, 0);
    assert.ok(Array.isArray(r.rulesByEvent.PreToolUse));
    assert.ok(HOOK_EVENTS.includes('PreToolUse'));
  });

  it('merges user then project', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-proj-'));
    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: '*', command: 'node', args: ['u.js'] }],
      },
    }));
    fs.writeFileSync(path.join(project, '.codex', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: 'write_file', command: 'node', args: ['p.js'] }],
      },
    }));
    const r = loadHooks({ userDataPath: user, projectPath: project });
    assert.equal(r.rulesByEvent.PreToolUse.length, 2);
    assert.equal(r.rulesByEvent.PreToolUse[0].source, 'user');
    assert.equal(r.rulesByEvent.PreToolUse[1].source, 'project');
    assert.equal(r.countsByEvent.PreToolUse, 2);
  });

  it('ignores bad version layer and records error', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 99,
      hooks: { PreToolUse: [{ matcher: '*', command: 'x' }] },
    }));
    const r = loadHooks({ userDataPath: user, projectPath: null });
    assert.equal(r.rulesByEvent.PreToolUse.length, 0);
    assert.ok(r.errors.length >= 1);
  });

  it('skips invalid rules missing command', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        PostToolUse: [{ matcher: '*', command: '' }, { matcher: '*', command: 'node' }],
      },
    }));
    const r = loadHooks({ userDataPath: user });
    assert.equal(r.rulesByEvent.PostToolUse.length, 1);
    assert.equal(r.rulesByEvent.PostToolUse[0].command, 'node');
  });

  it('clamps timeoutMs', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    fs.writeFileSync(path.join(user, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        Stop: [{ matcher: '*', command: 'node', timeoutMs: 5 }],
      },
    }));
    const r = loadHooks({ userDataPath: user });
    assert.equal(r.rulesByEvent.Stop[0].timeoutMs, 1000);
  });
});
