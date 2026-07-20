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
});
