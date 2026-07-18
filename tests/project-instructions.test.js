const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProjectInstructions } = require('../src/ai/project-instructions');

describe('project-instructions', () => {
  it('loads AGENTS.md and CLAUDE.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Always Chinese MARKER_A');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Use tests MARKER_C');
    const r = loadProjectInstructions(root);
    assert.match(r.parts, /MARKER_A/);
    assert.match(r.parts, /MARKER_C/);
    assert.match(r.parts, /AGENTS\.md|项目指令/);
  });
});
