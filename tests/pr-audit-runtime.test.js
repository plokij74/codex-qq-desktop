'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runAudit, reportFromText, TOOLS } = require('../src/ai/pr-audit-runtime');
const S = require('../src/ai/pr-audit-state');

function fakeSnapshot() {
  const files = [{
    path: 'src/main.js',
    oldPath: 'src/main.js',
    patch: '@@ -1,3 +1,4 @@\n context 1\n+added line\n context 2\n context 3\n',
    hunks: [{ leftStart: 1, leftCount: 3, rightStart: 1, rightCount: 4, changedLeft: [], changedRight: [2] }],
  }];

  return {
    source: {
      prNumber: 42,
      headSha: 'a'.repeat(40),
      mergeBaseSha: 'b'.repeat(40),
      prefix: '',
      title: 'Fix issue',
      body: 'Description',
    },
    coverage: { total: 1, scoped: 1, outside: 0, reviewed: 1, skipped: [] },
    files,
    contextBytes: 0,
    consume(val) { return val; },
    read: async (args) => ({ path: args.path, side: args.side || 'RIGHT', offset: 1, totalLines: 5, content: '1: line 1\n2: added line' }),
    list: async () => ({ files: ['src/main.js'], truncated: false }),
    search: async () => ({ matches: [{ path: 'src/main.js', line: 2, text: 'added line' }], truncated: false }),
  };
}

describe('D17 PR audit runtime', () => {
  it('parses report from markdown fenced or bare JSON', () => {
    assert.deepEqual(reportFromText('{"summary":"ok","findings":[]}'), { summary: 'ok', findings: [] });
    assert.deepEqual(reportFromText('```json\n{"summary":"ok","findings":[]}\n```'), { summary: 'ok', findings: [] });
    assert.equal(reportFromText('invalid json'), null);
  });

  it('rejects without required API settings', async () => {
    const snapshot = fakeSnapshot();
    await assert.rejects(
      () => runAudit({ snapshot, settings: { mode: 'local' } }),
      /PR_AUDIT_MODEL_REQUIRED/
    );
    await assert.rejects(
      () => runAudit({ snapshot, settings: { mode: 'api', agentEnabled: false } }),
      /PR_AUDIT_MODEL_REQUIRED/
    );
    await assert.rejects(
      () => runAudit({ snapshot, settings: { mode: 'api', agentEnabled: true, apiKey: '' } }),
      /PR_AUDIT_MODEL_REQUIRED/
    );
  });

  it('executes model turns with tool calls and completes with submit_review', async () => {
    const snapshot = fakeSnapshot();
    const settings = {
      mode: 'api',
      agentEnabled: true,
      apiKey: 'test-key',
      model: 'test-model',
    };

    let turn = 0;
    const chatFn = async () => {
      turn++;
      if (turn === 1) {
        return {
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'review_read_file',
              arguments: JSON.stringify({ path: 'src/main.js' }),
            },
          }],
        };
      }
      return {
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: {
            name: 'submit_review',
            arguments: JSON.stringify({
              summary: '代码审查完成，发现 1 处问题。',
              findings: [{
                priority: 'P1',
                title: '边界检查缺失',
                body: '缺少对 null 的判断。',
                path: 'src/main.js',
                side: 'RIGHT',
                line: 2,
                startLine: 2,
              }],
            }),
          },
        }],
      };
    };

    const progress = [];
    const result = await runAudit({
      snapshot,
      settings,
      note: '关注空指针',
      chatFn,
      onProgress: (p) => progress.push(p),
    });

    assert.equal(result.turns, 2);
    assert.equal(result.report.summary, '代码审查完成，发现 1 处问题。');
    assert.equal(result.report.findings.length, 1);
    assert.equal(result.report.findings[0].priority, 'P1');
    assert.equal(result.report.findings[0].line, 2);
    assert.deepEqual(progress, [{ turn: 1 }, { turn: 2 }]);
  });

  it('accepts bare JSON direct report in model content', async () => {
    const snapshot = fakeSnapshot();
    const settings = {
      mode: 'api',
      agentEnabled: true,
      apiKey: 'test-key',
      model: 'test-model',
    };

    const chatFn = async () => ({
      content: JSON.stringify({
        summary: '未发现明显缺陷。',
        findings: [],
      }),
    });

    const result = await runAudit({
      snapshot,
      settings,
      chatFn,
    });

    assert.equal(result.turns, 1);
    assert.equal(result.report.summary, '未发现明显缺陷。');
    assert.equal(result.report.findings.length, 0);
  });

  it('allows 1 correction for invalid report then fails if still invalid', async () => {
    const snapshot = fakeSnapshot();
    const settings = {
      mode: 'api',
      agentEnabled: true,
      apiKey: 'test-key',
      model: 'test-model',
    };

    // Returns invalid format twice
    const chatFn = async () => ({
      content: 'I am not returning json at all.',
    });

    await assert.rejects(
      () => runAudit({ snapshot, settings, chatFn }),
      /PR_AUDIT_REPORT_INVALID/
    );
  });

  it('fails with TURNS when exceeding max turns without submit', async () => {
    const snapshot = fakeSnapshot();
    const settings = {
      mode: 'api',
      agentEnabled: true,
      apiKey: 'test-key',
      model: 'test-model',
    };

    // Always just reads files, never submits
    const chatFn = async () => ({
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: {
          name: 'review_read_file',
          arguments: JSON.stringify({ path: 'src/main.js' }),
        },
      }],
    });

    await assert.rejects(
      () => runAudit({ snapshot, settings, chatFn }),
      /PR_AUDIT_TURNS/
    );
  });

  it('fails with CANCELLED on aborted signal', async () => {
    const snapshot = fakeSnapshot();
    const settings = {
      mode: 'api',
      agentEnabled: true,
      apiKey: 'test-key',
      model: 'test-model',
    };

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => runAudit({ snapshot, settings, signal: controller.signal }),
      /PR_AUDIT_CANCELLED/
    );
  });
});
