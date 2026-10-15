'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

function extractFunction(source, fnName) {
  const marker = `function ${fnName}(`;
  const idx = source.indexOf(marker);
  if (idx === -1) throw new Error(`Function ${fnName} not found`);
  let depth = 0;
  let started = false;
  let end = idx;
  for (let i = idx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return source.slice(idx, end);
}

describe('E1 Direct Defects - MCP OAuth and Prompt Commands (G01)', () => {
  it('cloneMcpOAuth does not contain misplaced slash command checks', () => {
    const fnCode = extractFunction(appSource, 'cloneMcpOAuth');
    assert.doesNotMatch(fnCode, /\blower\b/);
    assert.doesNotMatch(fnCode, /\bhandleMcpPromptsListCommand\b/);
    assert.doesNotMatch(fnCode, /\bhandleMcpPromptGetCommand\b/);
  });

  it('handleSlashCommand dispatches /mcp-prompts and /mcp-prompt', () => {
    const fnCode = extractFunction(appSource, 'handleSlashCommand');
    assert.match(fnCode, /\/mcp-prompts/);
    assert.match(fnCode, /\/mcp-prompt/);
    assert.match(fnCode, /handleMcpPromptsListCommand/);
    assert.match(fnCode, /handleMcpPromptGetCommand/);
  });

  it('cloneMcpOAuth executes cleanly and extracts valid OAuth config', () => {
    const fnCode = extractFunction(appSource, 'cloneMcpOAuth');
    const sandbox = { raw: null, out: null };
    vm.createContext(sandbox);
    vm.runInContext(`${fnCode}\nout = cloneMcpOAuth({ clientId: 'app123', tokenEndpoint: 'https://auth.example.com/token', scopes: ['read', 'write'] });`, sandbox);
    assert.equal(sandbox.out.clientId, 'app123');
    assert.equal(sandbox.out.tokenEndpoint, 'https://auth.example.com/token');
    assert.deepEqual(Array.from(sandbox.out.scopes), ['read', 'write']);
  });
});

describe('E1 Direct Defects - Max Agent Turns 0=Unlimited (G02)', () => {
  it('openSettings preserves 0 rather than falling back to 8 via || operator', () => {
    assert.doesNotMatch(appSource, /at\.value\s*=\s*settings\.maxAgentTurns\s*\|\|\s*8/);
    assert.match(appSource, /at\.value\s*=\s*settings\.maxAgentTurns\s*\?\?\s*8/);
  });

  it('saveSettingsFromForm correctly preserves 0 as numeric maxAgentTurns', () => {
    const saveFn = extractFunction(appSource, 'saveSettingsFromForm');
    assert.doesNotMatch(saveFn, /maxAgentTurns:\s*Number\([^)]*\|\|\s*8\)/);
  });
});

describe('E1 Direct Defects - Empty Projects and Storage Corruption (G02)', () => {
  it('loadState preserves empty projects array instead of forcing defaultProjects()', () => {
    const loadStateFn = extractFunction(appSource, 'loadState');
    assert.doesNotMatch(loadStateFn, /projects\s*=\s*Array\.isArray\(data\.projects\)\s*&&\s*data\.projects\.length\s*\?\s*data\.projects\s*:\s*defaultProjects\(\)/);
  });

  it('loadState backs up corrupted storage instead of wiping silently', () => {
    const loadStateFn = extractFunction(appSource, 'loadState');
    assert.match(loadStateFn, /codex-qq-corrupted/);
  });
});

describe('E1 Direct Defects - Task Creation and Execution (G03)', () => {
  it('createTaskFromModal triggers execution when brief is provided and protects against double submit', () => {
    const fnCode = extractFunction(appSource, 'createTaskFromModal');
    assert.match(fnCode, /sendMessage/);
    assert.match(fnCode, /taskModalSubmitting|submitting/i);
  });
});
