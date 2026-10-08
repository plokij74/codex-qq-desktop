'use strict';
const { it } = require('node:test'); const assert = require('node:assert/strict');
const { recheckFixture } = require('./helpers/pr-audit-recheck-fixture');
const { runRecheck, TOOLS } = require('../src/ai/pr-audit-recheck-runtime');
it('D19 runtime uses verified read IDs and rejects extra findings, tools and incomplete reports', async (t) => {
  const f = await recheckFixture(t); let calls = 0;
  f.rechecks.runtime = (args) => runRecheck({ ...args, chatFn: async () => {
    if (++calls === 1) return { tool_calls: [{ id: 'read', type: 'function', function: { name: 'recheck_read_file', arguments: '{"path":"src/app.js"}' } }] };
    const evidence = [...args.snapshot.evidence.keys()];
    return { content: JSON.stringify({ summary: '原问题复审', findings: args.findings.map((f, i) => ({ findingId: f.findingId, status: i ? 'unknown' : 'still_present', reason: i ? '缺少足够依据' : '当前分支仍有触发路径', evidence: i ? [] : evidence })) }) };
  } });
  const row = await f.done(await f.rechecks.start(f.root, f.marker.id)); assert.equal(row.status, 'completed', row.errorCode); assert.equal(row.report.findings[0].status, 'still_present');
  assert.deepEqual(TOOLS.map((t) => t.function.name), ['recheck_read_file', 'recheck_list_files', 'recheck_search', 'submit_recheck']);
  calls = 0; f.rechecks.runtime = (args) => runRecheck({ ...args, chatFn: async () => { calls++; return { content: '{"summary":"ok","findings":[]}' }; } });
  const failed = await f.done(await f.rechecks.start(f.root, f.marker.id)); assert.equal(failed.errorCode, 'PR_AUDIT_REPORT_INVALID'); assert.equal(calls, 2);
  calls = 0; f.rechecks.runtime = (args) => runRecheck({ ...args, chatFn: async () => { calls++; return { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'run_terminal', arguments: '{}' } }] }; } });
  const limit = await f.done(await f.rechecks.start(f.root, f.marker.id)); assert.equal(limit.errorCode, 'PR_AUDIT_TURNS'); assert.equal(calls, 8);
});

it('D19 rejects an over-budget original input before calling the model', async (t) => {
  const f = await recheckFixture(t); let calls = 0;
  f.rechecks.runtime = (args) => runRecheck({ ...args, settings: { ...args.settings, compactMaxApproxTokens: 1 },
    chatFn: async () => { calls++; throw new Error('must not call'); } });
  const row = await f.done(await f.rechecks.start(f.root, f.marker.id));
  assert.equal(row.errorCode, 'PR_AUDIT_CONTEXT_LIMIT'); assert.equal(calls, 0);
});
