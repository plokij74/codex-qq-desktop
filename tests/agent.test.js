const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTextToolCalls, executeToolFixed } = require('../src/ai/agent');
const { isBlockedCommand, runTerminal } = require('../src/ai/terminal');

describe('agent tools', () => {
  it('parseTextToolCalls extracts fenced tools', () => {
    const text = '先看目录\n```tool list_dir\n{"path":"."}\n```\n';
    const calls = parseTextToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'list_dir');
  });

  it('executeToolFixed list_dir and write_file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
    const ctx = {
      project: { name: 't', path: root },
      settings: { terminalEnabled: false },
    };
    const listed = JSON.parse(await executeToolFixed('list_dir', { path: '.' }, ctx));
    assert.equal(listed.ok, true);
    assert.match(listed.tree, /a\.txt/);

    const written = JSON.parse(await executeToolFixed('write_file', { path: 'b.txt', content: 'x' }, ctx));
    assert.equal(written.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'x');
  });

  it('blocks dangerous terminal patterns', () => {
    assert.equal(isBlockedCommand('rm -rf /'), true);
    assert.equal(isBlockedCommand('npm test'), false);
  });

  it('runTerminal executes in project dir', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-'));
    const r = await runTerminal(root, 'Write-Output "hello-agent"', { timeoutMs: 15000 });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /hello-agent/);
  });
});
