'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

describe('D.4 renderer memory UI contract', () => {
  it('loads the pure candidate helper before app.js', () => {
    const helper = html.indexOf('<script src="memory-candidate-state.js"></script>');
    const application = html.indexOf('<script src="app.js"></script>');
    assert.ok(helper >= 0);
    assert.ok(application > helper);
  });

  it('contains the candidate entry, review dialog and fixed settings copy', () => {
    for (const id of [
      'btn-memory-candidates',
      'memory-candidate-count',
      'memory-candidate-modal',
      'memory-candidate-list',
      'btn-memory-candidate-accept',
      'btn-memory-candidate-reject',
      'btn-memory-candidate-later',
      'set-memory-candidate-enabled',
    ]) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(
      html,
      /压缩时提炼记忆候选（每次压缩可能增加一次模型调用；候选需审核后才写入）/
    );
    assert.match(html, /btn-memory-candidate-close[\s\S]*稍后处理/);
  });

  it('normalizes pending candidates on load/save and wires the setting both ways', () => {
    assert.match(app, /normalizePendingCandidates\(\s*session\.pendingMemoryCandidates/);
    assert.match(app, /memoryCandidateEnabled\s*:\s*document\.getElementById/);
    assert.match(app, /settings\.memoryCandidateEnabled\s*!==\s*false/);
    assert.match(app, /updateMemoryCandidateCount\(\)/);
    assert.match(app, /memory-candidate-text[\s\S]*addEventListener\('input'/);
    assert.match(app, /memory-candidate-tags[\s\S]*addEventListener\('input'/);
    assert.match(app, /e\.key === 'Escape'[\s\S]*closeMemoryCandidateReview/);
  });

  it('sends remaining capacity and persists compact messages before candidate merge', () => {
    assert.match(app, /candidateLimit:\s*(?:window\.)?MemoryCandidateState\.candidateLimit/);
    assert.match(app, /sessionId:\s*session\.id/);
    assert.match(app, /originProjectRef\s*=\s*currentProjectRef\(session\)/);
    const start = app.indexOf('function applyCompactResult');
    const messageSwap = app.indexOf('session.messages = response.messages', start);
    const firstSave = app.indexOf('saveState()', messageSwap);
    const merge = app.indexOf('MemoryCandidateState.mergePendingCandidates', start);
    assert.ok(start >= 0 && messageSwap > start && firstSave > messageSwap && merge > firstSave);
  });

  it('opens existing candidates after a manual no-op compact but never from auto compact', () => {
    const noNeed = app.indexOf('if (!res.needed)');
    const manualOpen = app.indexOf('openMemoryCandidateReview(session)', noNeed);
    const autoStart = app.indexOf('async function maybeAutoCompact');
    const autoOpen = app.indexOf('openMemoryCandidateReview', autoStart);
    assert.ok(noNeed >= 0 && manualOpen > noNeed);
    assert.equal(autoOpen, -1);
  });

  it('uses narrow accept IPC and confirmed reject actions', () => {
    assert.match(app, /window\.codex\.acceptMemory\(built\.payload\)/);
    assert.match(app, /for \(const candidate of selected\)/);
    assert.match(app, /confirm\('确定拒绝所选记忆候选？'\)/);
    assert.match(app, /buildAcceptPayload\(candidate, currentProjectRef\(session\)\)/);
    assert.match(app, /memoryCandidateInvalidIds\.has\(candidate\.id\)/);
  });

  it('edits existing memory through the narrow optimistic update contract', () => {
    assert.match(app, /function renderMemoryEntryRow\(entry, projectPath\)/);
    assert.match(app, /window\.codex\.updateMemory\(\{/);
    assert.match(app, /expected:\s*\{\s*text:\s*entry\.text,/);
    assert.match(app, /updatedAt:\s*entry\.updatedAt\s*\?\?\s*null/);
    assert.match(app, /result\?\.code === 'CONFLICT'/);
  });
});
