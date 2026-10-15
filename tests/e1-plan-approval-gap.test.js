'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

describe('E1 Plan Approval Gap Regression Contract (G04 -> Handed to E2 -> Closed in E2)', () => {
  it('documents finalizeChatRun clearing chatRun while preserving plan persistence', () => {
    assert.match(appSource, /disableApprovalCards\(chatRun\.el\);/);
    assert.match(appSource, /chatRun\s*=\s*null;/);
  });

  it('verifies G04 fixed: approvePlanFromCard operates even when chatRun is null/finalized', () => {
    // G04 is closed: approvePlanFromCard no longer early-returns on !chatRun or chatRun.finalized
    assert.doesNotMatch(appSource, /if\s*\(!chatRun\s*\|\|\s*chatRun\.finalized\s*\|\|\s*card\.classList\.contains\('resolved'\)\)\s*return;/);
    assert.match(appSource, /if\s*\(card\s*&&\s*card\.classList\.contains\('resolved'\)\)\s*return;/);
  });

  it('verifies session messages persist structured plan parts and trajectory across re-render', () => {
    assert.match(appSource, /schemaVersion:\s*2/);
    assert.match(appSource, /planPart/);
    assert.match(appSource, /trajectory/);
  });
});
