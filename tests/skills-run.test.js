'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createSkillsProvider } = require('../src/ai/providers/skills');
const { filterToolsForMode } = require('../src/ai/agent-mode');
const { riskForTool } = require('../src/ai/permission');

function makeSpawnMock({ code = 0, stdout = 'out', stderr = '', delayMs = 0 } = {}) {
  return function spawnFn(cmd, args, opts) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {}, destroyed: false };
    child.kill = () => {
      child.emit('close', -1);
    };
    child._meta = { cmd, args, opts };
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, delayMs);
    return child;
  };
}

function writeSkill(project, name, frontmatterBody) {
  const dir = path.join(project, '.codex', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatterBody);
  return dir;
}

describe('skills run_skill + triggers fragment', () => {
  it('list_skills includes runnable and triggers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-run-list-'));
    writeSkill(
      root,
      'dump-tree',
      '---\nname: dump-tree\ndescription: d\ntriggers: tree, 目录\ncommand: node\nargs: ["x.js"]\n---\nbody\n',
    );
    const provider = createSkillsProvider({
      bundledDir: path.join(root, 'bundled-empty'),
      userDataPath: path.join(root, 'ud'),
    });
    const ctx = { project: { path: root }, extensions: {}, settings: {} };
    const raw = await provider.execute('list_skills', {}, ctx);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    const s = parsed.skills.find((x) => x.name === 'dump-tree');
    assert.ok(s);
    assert.equal(s.runnable, true);
    assert.ok(Array.isArray(s.triggers));
    assert.ok(s.triggers.includes('tree'));
  });

  it('run_skill spawns with shell false and returns stdout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-run-spawn-'));
    writeSkill(
      root,
      'echo-skill',
      '---\nname: echo-skill\ndescription: e\ncommand: node\nargs: ["a.js"]\ncwd: project\ntimeoutMs: 5000\n---\nbody\n',
    );
    let lastSpawn;
    const spawnFn = makeSpawnMock({ code: 0, stdout: 'hello-skill' });
    const provider = createSkillsProvider({
      bundledDir: path.join(root, 'b'),
      userDataPath: path.join(root, 'ud'),
      spawnFn: (cmd, args, opts) => {
        const child = spawnFn(cmd, args, opts);
        lastSpawn = { cmd, args, opts };
        return child;
      },
    });
    const ctx = { project: { path: root }, extensions: {}, settings: {}, signal: undefined };
    const raw = await provider.execute('run_skill', { name: 'echo-skill' }, ctx);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, true);
    assert.match(parsed.stdout || '', /hello-skill/);
    assert.equal(lastSpawn.opts.shell, false);
    assert.equal(lastSpawn.cmd, 'node');
    assert.deepEqual(lastSpawn.args, ['a.js']);
  });

  it('run_skill fails without command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-run-nocmd-'));
    writeSkill(root, 'doc-only', '---\nname: doc-only\ndescription: only\n---\nbody\n');
    const provider = createSkillsProvider({
      bundledDir: path.join(root, 'b'),
      userDataPath: path.join(root, 'ud'),
      spawnFn: makeSpawnMock(),
    });
    const ctx = { project: { path: root }, extensions: {}, settings: {} };
    const raw = await provider.execute('run_skill', { name: 'doc-only' }, ctx);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error || '', /command|不可执行/i);
  });

  it('getSystemFragment adds Skills auto-match section', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-run-frag-'));
    writeSkill(
      root,
      'dump-tree',
      '---\nname: dump-tree\ndescription: 打印目录\ntriggers: tree, 目录树\ncommand: node\n---\nbody\n',
    );
    const provider = createSkillsProvider({
      bundledDir: path.join(root, 'b'),
      userDataPath: path.join(root, 'ud'),
    });
    const ctx = {
      project: { path: root },
      extensions: { userPromptText: '请打印目录树 tree 给我' },
      settings: {},
    };
    const frag = provider.getSystemFragment(ctx);
    assert.match(frag, /【可用 Skills】/);
    assert.match(frag, /【Skills 自动匹配】/);
    assert.match(frag, /dump-tree/);
    assert.match(frag, /use_skill/);
  });

  it('plan mode hides run_skill but keeps list/use', () => {
    const defs = ['list_skills', 'use_skill', 'run_skill', 'read_file'].map((name) => ({
      type: 'function',
      function: { name },
    }));
    const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
    assert.ok(plan.includes('list_skills'));
    assert.ok(plan.includes('use_skill'));
    assert.ok(!plan.includes('run_skill'));
  });

  it('run_skill is write risk', () => {
    assert.equal(riskForTool('run_skill'), 'write');
  });
});
