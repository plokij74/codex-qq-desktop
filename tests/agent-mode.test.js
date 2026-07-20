const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAgentMode,
  isPlanBlockedRisk,
  filterToolsForMode,
  buildApproveExecutionMessage,
  truncatePlanMarkdown,
  PLAN_MARKDOWN_MAX,
} = require('../src/ai/agent-mode');

describe('agent-mode', () => {
  it('normalizeAgentMode', () => {
    assert.equal(normalizeAgentMode('plan'), 'plan');
    assert.equal(normalizeAgentMode('agent'), 'agent');
    assert.equal(normalizeAgentMode('nope'), 'agent');
    assert.equal(normalizeAgentMode(null), 'agent');
  });

  it('isPlanBlockedRisk', () => {
    assert.equal(isPlanBlockedRisk('write'), true);
    assert.equal(isPlanBlockedRisk('delete'), true);
    assert.equal(isPlanBlockedRisk('terminal'), true);
    assert.equal(isPlanBlockedRisk('read'), false);
  });

  it('filterToolsForMode plan hides writes and keeps submit_plan', () => {
    const defs = [
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } },
      { function: { name: 'submit_plan' } },
      { function: { name: 'run_terminal' } },
      { function: { name: 'git_commit' } },
    ];
    const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
    assert.deepEqual(plan.sort(), ['read_file', 'submit_plan'].sort());
    const agent = filterToolsForMode(defs, 'agent').map((t) => t.function.name);
    assert.ok(agent.includes('write_file'));
    assert.ok(!agent.includes('submit_plan'));
  });

  it('buildApproveExecutionMessage contains plan body', () => {
    const m = buildApproveExecutionMessage({ title: 'T', markdown: '步骤 1' });
    assert.match(m, /已批准计划/);
    assert.match(m, /# T/);
    assert.match(m, /步骤 1/);
  });

  it('truncatePlanMarkdown', () => {
    const big = 'x'.repeat(PLAN_MARKDOWN_MAX + 100);
    const r = truncatePlanMarkdown(big);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= PLAN_MARKDOWN_MAX + 80);
  });
});
