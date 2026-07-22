'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadHooks } = require('../src/ai/hooks-loader');
const { createHooksRunner } = require('../src/ai/hooks-runner');
const { AGENT_EVENTS } = require('../src/ai/agent-events');

function writeHooks(project, hooksObj) {
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.codex', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: hooksObj })
  );
}

function scriptCmd(jsBody) {
  // Prefer temp file on Windows — node -e multi-line can be flaky
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-script-'));
  const file = path.join(dir, 'hook.js');
  fs.writeFileSync(file, jsBody, 'utf8');
  return {
    matcher: '*',
    command: process.execPath,
    args: [file],
    timeoutMs: 10000,
  };
}

describe('hooks-runner PreToolUse', () => {
  it('allow with empty stdout exit 0', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, {
      PreToolUse: [scriptCmd('process.exit(0)')],
    });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const events = [];
    const runner = createHooksRunner({
      hooks,
      projectPath: project,
      userDataPath: user,
      settings: { hooksEnabled: true, permissionMode: 'full-auto' },
      sessionKey: 's1',
      agentMode: 'agent',
      subagentDepth: 0,
      onEvent: (e) => events.push(e),
    });
    const r = await runner.runPreToolUse({
      name: 'read_file',
      args: { path: 'a.js' },
      risk: 'read',
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.args.path, 'a.js');
    assert.ok(events.some((e) => e.type === AGENT_EVENTS.HOOK_START));
    assert.ok(events.some((e) => e.type === AGENT_EVENTS.HOOK_END && e.ok));
  });

  it('deny on exit non-zero', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, {
      PreToolUse: [scriptCmd('process.exit(2)')],
    });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks,
      projectPath: project,
      userDataPath: user,
      settings: { hooksEnabled: true },
      subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({ name: 'write_file', args: {}, risk: 'write' });
    assert.equal(r.decision, 'deny');
  });

  it('skip returns resultStr', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const body = `
      let s=''; process.stdin.on('data',d=>s+=d);
      process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({decision:'skip',result:{ok:true,skipped:true,by:'test'}}));
      });
    `;
    writeHooks(project, { PreToolUse: [scriptCmd(body)] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({ name: 'list_dir', args: {}, risk: 'read' });
    assert.equal(r.decision, 'skip');
    const parsed = JSON.parse(r.resultStr);
    assert.equal(parsed.skipped, true);
  });

  it('allow rewrites args', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    const body = `
      let s=''; process.stdin.on('data',d=>s+=d);
      process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({decision:'allow',args:{path:'b.js'}}));
      });
    `;
    writeHooks(project, { PreToolUse: [scriptCmd(body)] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    const r = await runner.runPreToolUse({
      name: 'read_file',
      args: { path: 'a.js', offset: 1 },
      risk: 'read',
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.args.path, 'b.js');
    assert.equal(r.args.offset, 1);
    assert.equal(r.argsChanged, true);
  });

  it('depth>=1 skips hooks', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, { PreToolUse: [scriptCmd('process.exit(2)')] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const events = [];
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 1,
      onEvent: (e) => events.push(e),
    });
    const r = await runner.runPreToolUse({ name: 'read_file', args: {}, risk: 'read' });
    assert.equal(r.decision, 'allow');
    assert.equal(events.length, 0);
  });

  it('lifecycle failure does not throw', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-run-'));
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-user-'));
    writeHooks(project, { Stop: [scriptCmd('process.exit(1)')] });
    const hooks = loadHooks({ userDataPath: user, projectPath: project });
    const runner = createHooksRunner({
      hooks, projectPath: project, userDataPath: user,
      settings: { hooksEnabled: true }, subagentDepth: 0,
    });
    await runner.runLifecycle('Stop', { reason: 'done' });
  });
});
