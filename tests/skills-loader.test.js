const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseFrontmatter,
  sanitizeSkillName,
  discoverSkills,
  loadSkillBody,
  parseTriggers,
  parseArgsField,
  matchSkillsByTriggers,
  resolveSkillCwd,
  SKILL_BODY_MAX,
} = require('../src/ai/skills-loader');

describe('skills-loader', () => {
  it('parseFrontmatter reads name and description', () => {
    const raw = '---\nname: code-review\ndescription: "审查"\n---\n\n# Hi\n';
    const { attrs, body } = parseFrontmatter(raw);
    assert.equal(attrs.name, 'code-review');
    assert.equal(attrs.description, '审查');
    assert.match(body, /# Hi/);
  });

  it('sanitizeSkillName', () => {
    assert.equal(sanitizeSkillName('Code_Review'), 'code_review');
    assert.equal(sanitizeSkillName('OK-1'), 'ok-1');
    assert.equal(sanitizeSkillName('!!!'), null);
  });

  it('discoverSkills priority project over bundled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const project = path.join(root, 'proj');
    const bundled = path.join(root, 'bundled');
    const userData = path.join(root, 'ud');
    fs.mkdirSync(path.join(project, '.codex', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(project, '.codex', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: from-project\n---\nP\n');
    fs.mkdirSync(path.join(bundled, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(bundled, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: from-bundled\n---\nB\n');
    const list = discoverSkills({ projectPath: project, userDataPath: userData, bundledDir: bundled });
    const demo = list.find((s) => s.name === 'demo');
    assert.equal(demo.source, 'project');
    assert.equal(demo.description, 'from-project');
  });

  it('loadSkillBody truncates large body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-body-'));
    const dir = path.join(root, 'big');
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: big\ndescription: d\n---\n' + 'x'.repeat(SKILL_BODY_MAX + 100));
    const r = loadSkillBody({
      name: 'big', description: 'd', source: 'project', dir, skillPath,
    });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.body.length <= SKILL_BODY_MAX);
  });

  it('parseTriggers splits and lowercases', () => {
    assert.deepEqual(parseTriggers('目录树, Tree， FOO'), ['目录树', 'tree', 'foo']);
    assert.deepEqual(parseTriggers(''), []);
    assert.deepEqual(parseTriggers(null), []);
  });

  it('parseArgsField parses JSON array only', () => {
    assert.deepEqual(parseArgsField('["a","b"]'), ['a', 'b']);
    assert.deepEqual(parseArgsField('not-json'), []);
    assert.deepEqual(parseArgsField(''), []);
  });

  it('discoverSkills parses triggers command args timeout cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-meta-'));
    const project = path.join(root, 'proj');
    const dir = path.join(project, '.codex', 'skills', 'dump-tree');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: dump-tree',
        'description: 打印目录',
        'triggers: 目录树, tree',
        'command: node',
        'args: ["scripts/x.js"]',
        'cwd: skill',
        'timeoutMs: 15000',
        '---',
        '',
        '# body',
        '',
      ].join('\n'),
    );
    const list = discoverSkills({ projectPath: project, userDataPath: path.join(root, 'ud'), bundledDir: path.join(root, 'b') });
    const s = list.find((x) => x.name === 'dump-tree');
    assert.ok(s);
    assert.deepEqual(s.triggers, ['目录树', 'tree']);
    assert.equal(s.command, 'node');
    assert.deepEqual(s.skillArgs, ['scripts/x.js']);
    assert.equal(s.timeoutMs, 15000);
    assert.equal(s.cwdKind, 'skill');
  });

  it('matchSkillsByTriggers is case-insensitive substring and caps at 5', () => {
    const catalog = [
      { name: 'a', triggers: ['foo'], description: 'A' },
      { name: 'b', triggers: ['bar'], description: 'B' },
      { name: 'c', triggers: ['baz'], description: 'C' },
      { name: 'd', triggers: ['qux'], description: 'D' },
      { name: 'e', triggers: ['zip'], description: 'E' },
      { name: 'f', triggers: ['zap'], description: 'F' },
      { name: 'g', triggers: ['none'], description: 'G' },
    ];
    const matched = matchSkillsByTriggers(catalog, 'please FOO and Bar then baz QUX zip ZAP extra');
    assert.equal(matched.length, 5);
    assert.deepEqual(matched.map((s) => s.name), ['a', 'b', 'c', 'd', 'e']);
  });

  it('resolveSkillCwd project skill and relative', () => {
    const project = path.resolve('/tmp/proj-cwd-test');
    const skillDir = path.join(project, '.codex', 'skills', 'x');
    assert.equal(resolveSkillCwd({ cwdKind: 'project', dir: skillDir }, project), path.resolve(project));
    assert.equal(resolveSkillCwd({ cwdKind: 'skill', dir: skillDir }, project), skillDir);
    const rel = resolveSkillCwd({ cwdKind: 'sub', dir: skillDir }, project);
    assert.equal(rel, path.resolve(project, 'sub'));
    assert.throws(
      () => resolveSkillCwd({ cwdKind: '../outside', dir: skillDir }, project),
      /越界/,
    );
  });
});
