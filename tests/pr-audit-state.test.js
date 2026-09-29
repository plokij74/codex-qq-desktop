'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/ai/pr-audit-state');

describe('D17 PR audit state contracts', () => {
  it('validates refs, digests, and numeric identifiers', () => {
    const auditRef = S.ref('pra');
    assert.match(auditRef, /^pra_[a-f0-9]{24}$/);
    assert.equal(S.isRef(auditRef, 'pra'), true);
    assert.equal(S.isRef('pra_invalid', 'pra'), false);
    assert.equal(S.isRef(auditRef, 'pad'), false);

    const draftRef = S.ref('pad');
    assert.match(draftRef, /^pad_[a-f0-9]{24}$/);
    assert.equal(S.isRef(draftRef, 'pad'), true);

    const findingId = S.ref('paf');
    assert.match(findingId, /^paf_[a-f0-9]{24}$/);
    assert.equal(S.isRef(findingId, 'paf'), true);

    assert.equal(S.number(1), true);
    assert.equal(S.number(0), false);
    assert.equal(S.number(-5), false);
    assert.equal(S.number(1.5), false);
    assert.equal(S.number(NaN), false);

    assert.equal(S.remoteId(12345), true);
    assert.equal(S.remoteId(0), false);

    assert.equal(S.digest('a'.repeat(64)), true);
    assert.equal(S.digest('a'.repeat(40)), false);
  });

  it('enforces scopePath inside repo and subdirectory bounds', () => {
    assert.equal(S.scopePath('src/app.js', ''), true);
    assert.equal(S.scopePath('README.md', ''), true);
    assert.equal(S.scopePath('packages/foo/index.js', 'packages/foo'), true);
    assert.equal(S.scopePath('packages/bar/index.js', 'packages/foo'), false);
    assert.equal(S.scopePath('../outside.js', ''), false);
    assert.equal(S.scopePath('src/../outside.js', ''), false);
  });

  it('normalizes PR data and rejects invalid or cross-repo head', () => {
    const repo = { nameWithOwner: 'owner/repo' };
    const validRaw = {
      number: 42,
      state: 'open',
      merged: false,
      headRepo: 'owner/repo',
      baseRepo: 'owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      headRefName: 'feature',
      baseRefName: 'main',
      changedFiles: 3,
      title: 'Fix edge case',
      body: 'Details here',
    };
    const norm = S.normalizePr(validRaw, repo);
    assert.equal(norm.prNumber, 42);
    assert.equal(norm.headSha, 'a'.repeat(40));
    assert.equal(norm.baseSha, 'b'.repeat(40));
    assert.match(norm.descriptionHash, /^[a-f0-9]{64}$/);

    // Fork PR rejection
    assert.throws(() => S.normalizePr({ ...validRaw, headRepo: 'fork/repo' }, repo), /PR_AUDIT_FORK/);
    // Closed PR rejection
    assert.throws(() => S.normalizePr({ ...validRaw, state: 'closed' }, repo), /PR_AUDIT_NOT_OPEN/);
    // Merged PR rejection
    assert.throws(() => S.normalizePr({ ...validRaw, merged: true }, repo), /PR_AUDIT_NOT_OPEN/);
  });

  it('parses unified diff patch and computes changed lines per side', () => {
    const patch = [
      '@@ -10,4 +10,5 @@',
      ' context line 1',
      '-old line 2',
      '+new line 2',
      '+added line 2.5',
      ' context line 3',
      ' context line 4',
    ].join('\n') + '\n';

    const hunks = S.parsePatch(patch, { additions: 2, deletions: 1 });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].leftStart, 10);
    assert.equal(hunks[0].leftCount, 4);
    assert.equal(hunks[0].rightStart, 10);
    assert.equal(hunks[0].rightCount, 5);
    assert.deepEqual(hunks[0].changedLeft, [11]);
    assert.deepEqual(hunks[0].changedRight, [11, 12]);

    // Added file diff
    const addedPatch = '@@ -0,0 +1,2 @@\n+line 1\n+line 2\n';
    const addedHunks = S.parsePatch(addedPatch, { additions: 2, deletions: 0 });
    assert.equal(addedHunks[0].leftStart, 0);
    assert.deepEqual(addedHunks[0].changedRight, [1, 2]);

    // Incomplete or mismatched patch throws INCOMPLETE
    assert.throws(() => S.parsePatch('invalid diff format', {}), /PR_AUDIT_INCOMPLETE/);
    assert.throws(() => S.parsePatch(patch, { additions: 99, deletions: 1 }), /PR_AUDIT_INCOMPLETE/);
  });

  it('validates finding location against file hunks', () => {
    const files = [{
      path: 'src/app.js',
      hunks: [{
        leftStart: 10, leftCount: 4, rightStart: 10, rightCount: 5,
        changedLeft: [11], changedRight: [11, 12],
      }],
    }];

    // Valid RIGHT finding on changed line
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 11, startLine: 11 }, files), true);
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 12, startLine: 11 }, files), true);
    // Valid LEFT finding on changed line
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'LEFT', line: 11, startLine: 11 }, files), true);

    // Invalid: untouched context line only
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 10, startLine: 10 }, files), false);
    // Invalid: outside hunk range
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 99, startLine: 99 }, files), false);
    // Invalid: startLine > line
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 11, startLine: 12 }, files), false);
    // Invalid: span > 20 lines
    assert.equal(S.validLocation({ path: 'src/app.js', side: 'RIGHT', line: 35, startLine: 10 }, files), false);
    // Invalid: unknown file
    assert.equal(S.validLocation({ path: 'unknown.js', side: 'RIGHT', line: 11, startLine: 11 }, files), false);
  });

  it('normalizes report and rejects invalid findings or duplicates', () => {
    const files = [{
      path: 'src/app.js',
      hunks: [{ leftStart: 1, leftCount: 2, rightStart: 1, rightCount: 2, changedLeft: [1], changedRight: [1] }],
    }];

    const rawReport = {
      summary: '本次改动审查汇总',
      findings: [{
        priority: 'P1',
        title: '缺少空指针检查',
        body: '当输入为空时可能抛出异常。',
        path: 'src/app.js',
        side: 'RIGHT',
        line: 1,
        startLine: 1,
      }],
    };

    const norm = S.normalizeReport(rawReport, files);
    assert.equal(norm.summary, '本次改动审查汇总');
    assert.equal(norm.findings.length, 1);
    assert.match(norm.findings[0].findingId, /^paf_[a-f0-9]{24}$/);
    assert.equal(norm.findings[0].priority, 'P1');

    // Duplicate findings rejected
    assert.throws(() => S.normalizeReport({
      summary: 'test',
      findings: [rawReport.findings[0], rawReport.findings[0]],
    }, files), /PR_AUDIT_REPORT_INVALID/);

    // Invalid priority rejected
    assert.throws(() => S.normalizeReport({
      summary: 'test',
      findings: [{ ...rawReport.findings[0], priority: 'P9' }],
    }, files), /PR_AUDIT_REPORT_INVALID/);

    // Invalid location rejected
    assert.throws(() => S.normalizeReport({
      summary: 'test',
      findings: [{ ...rawReport.findings[0], line: 999 }],
    }, files), /PR_AUDIT_REPORT_INVALID/);
  });

  it('normalizes durable record and computes revisions', () => {
    const record = {
      auditRef: S.ref('pra'),
      projectKey: 'a'.repeat(32),
      prNumber: 10,
      createdAt: new Date().toISOString(),
      status: 'completed',
      source: {
        repoKey: 'b'.repeat(64),
        prNumber: 10,
        baseSha: 'c'.repeat(40),
        headSha: 'd'.repeat(40),
        mergeBaseSha: 'e'.repeat(40),
        baseRefName: 'main',
        headRefName: 'feature',
        descriptionHash: 'f'.repeat(64),
        changedFiles: 1,
        prefix: '',
      },
      coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] },
      report: {
        summary: '完成',
        findings: [{
          findingId: S.ref('paf'),
          priority: 'P2',
          title: '边界条件',
          body: '注意处理负数输入',
          path: 'src/calc.js',
          side: 'RIGHT',
          line: 5,
          startLine: 5,
        }],
      },
    };

    const validated = S.normalizeRecord(record);
    assert.equal(validated.auditRef, record.auditRef);
    const rev1 = S.revision(record);
    assert.match(rev1, /^[a-f0-9]{64}$/);

    const changed = { ...record, stale: true };
    const rev2 = S.revision(changed);
    assert.notEqual(rev1, rev2);
  });
});
