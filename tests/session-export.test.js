'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  exportSessionMarkdown,
  exportSessionJson,
  defaultExportFilename,
  stripSecrets,
} = require('../src/ai/session-export');

function sampleSession() {
  return {
    id: 's1',
    title: '修 bug/登录',
    kind: 'task',
    peer: 'codex',
    projectId: null,
    agentMode: 'agent',
    pinned: false,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool: 'write_file', toolSummary: 'ok a.js' },
      { role: 'assistant', content: 'secret', apiKey: 'sk-leak' },
      { role: 'assistant', content: '要点若干', compact: true, compactedCount: 9 },
    ],
  };
}

describe('session-export', () => {
  it('markdown includes title, metadata and roles', () => {
    const md = exportSessionMarkdown(sampleSession());
    assert.match(md, /修 bug\/登录/);
    assert.match(md, /s1/);
    assert.match(md, /我/);
    assert.match(md, /助手/);
    assert.match(md, /hello/);
    assert.match(md, /write_file/);
    assert.match(md, /ok a\.js/);
  });

  it('markdown marks compacted summary messages', () => {
    const md = exportSessionMarkdown(sampleSession());
    assert.match(md, /摘要/);
    assert.match(md, /9/);
  });

  it('markdown never carries an apiKey field value', () => {
    const md = exportSessionMarkdown(sampleSession());
    assert.ok(!md.includes('sk-leak'));
  });

  it('markdown tolerates an empty session', () => {
    const md = exportSessionMarkdown({ id: 'x' });
    assert.match(md, /x/);
    assert.equal(typeof md, 'string');
  });

  it('json has version 1, exportedAt and session fields', () => {
    const raw = exportSessionJson(sampleSession());
    const obj = JSON.parse(raw);
    assert.equal(obj.version, 1);
    assert.match(obj.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(obj.session.id, 's1');
    assert.equal(obj.session.title, '修 bug/登录');
    assert.equal(obj.session.agentMode, 'agent');
    assert.equal(obj.session.messages.length, 4);
    assert.equal(obj.session.messages[1].tool, 'write_file');
  });

  it('json strips secret keys from messages', () => {
    const raw = exportSessionJson(sampleSession());
    assert.ok(!raw.includes('sk-leak'));
    assert.ok(!raw.includes('apiKey'));
  });

  it('stripSecrets removes banned keys at any depth', () => {
    const out = stripSecrets({
      a: 1,
      apiKey: 'k',
      nested: { token: 't', keep: 'yes', deeper: [{ password: 'p', ok: 1 }] },
    });
    assert.equal(out.a, 1);
    assert.equal('apiKey' in out, false);
    assert.equal('token' in out.nested, false);
    assert.equal(out.nested.keep, 'yes');
    assert.equal('password' in out.nested.deeper[0], false);
    assert.equal(out.nested.deeper[0].ok, 1);
  });

  it('defaultExportFilename sanitizes title and adds extension', () => {
    const s = sampleSession();
    const md = defaultExportFilename(s, 'md');
    assert.match(md, /\.md$/);
    assert.ok(!md.includes('/'));
    assert.ok(!md.includes('\\'));
    assert.match(defaultExportFilename(s, 'json'), /\.json$/);
    assert.match(defaultExportFilename({}, 'md'), /^session-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('defaultExportFilename falls back when the title has no safe chars', () => {
    const name = defaultExportFilename({ title: '///***' }, 'md');
    assert.match(name, /^session-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('never exports pending memory candidates or evidence', () => {
    const session = sampleSession();
    session.pendingMemoryCandidates = [{
      id: 'mc_private',
      text: 'PRIVATE_CANDIDATE_TEXT',
      tags: ['private'],
      evidence: 'PRIVATE_EVIDENCE_EXCERPT',
      scope: 'user',
      projectRef: null,
      createdAt: 1700000002000,
    }];
    const markdown = exportSessionMarkdown(session);
    const json = exportSessionJson(session);
    for (const secret of ['mc_private', 'PRIVATE_CANDIDATE_TEXT', 'PRIVATE_EVIDENCE_EXCERPT']) {
      assert.equal(markdown.includes(secret), false);
      assert.equal(json.includes(secret), false);
    }
    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.equal('pendingMemoryCandidates' in parsed.session, false);
  });

  it('never exports pending worktree result authority or preview data', () => {
    const session = sampleSession();
    session.pendingWorktreeResults = [{
      id: 'wt_private',
      goal: 'PRIVATE_WORKTREE_GOAL',
      files: [{ path: 'PRIVATE_FILE_PATH' }],
      preview: 'PRIVATE_PATCH_PREVIEW',
      checkout: 'C:/private/checkout',
      prDraftTitle: 'PRIVATE_PR_TITLE',
      prDraftBody: 'PRIVATE_PR_BODY',
    }];
    const markdown = exportSessionMarkdown(session);
    const json = exportSessionJson(session);
    for (const secret of ['wt_private', 'PRIVATE_WORKTREE_GOAL', 'PRIVATE_FILE_PATH', 'PRIVATE_PATCH_PREVIEW', 'C:/private/checkout', 'PRIVATE_PR_TITLE', 'PRIVATE_PR_BODY']) {
      assert.equal(markdown.includes(secret), false);
      assert.equal(json.includes(secret), false);
    }
    assert.equal('pendingWorktreeResults' in JSON.parse(json).session, false);
  });
});
