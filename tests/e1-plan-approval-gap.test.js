'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

describe('E1 Plan Approval Gap Regression Contract (G04 -> Handed to E2)', () => {
  it('documents current finalizeChatRun disabling approval cards and nulling chatRun', () => {
    // Current behavior: finalizeChatRun disables cards and clears chatRun
    assert.match(appSource, /disableApprovalCards\(chatRun\.el\);/);
    assert.match(appSource, /chatRun\s*=\s*null;/);
  });

  it('documents current approvePlanFromCard early-returning when chatRun is null or finalized', () => {
    // Current behavior: approvePlanFromCard cannot execute after chatRun finalized
    assert.match(appSource, /if\s*\(!chatRun\s*\|\|\s*chatRun\.finalized\s*\|\|\s*card\.classList\.contains\('resolved'\)\)\s*return;/);
  });

  it('documents that session messages currently do not persist structured plan approval state', () => {
    // Current behavior: session.messages only receives string/markdown content, losing approval widgets across re-render
    assert.match(appSource, /session\.messages\.push\(\{\s*role:\s*'assistant',\s*content,/);
    // E2 will introduce structured plan persistence and post-finalize approval
  });
});
