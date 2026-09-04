const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAgentMode,
  isPlanBlockedRisk,
  filterToolsForMode,
  buildApproveExecutionMessage,
  truncatePlanMarkdown,
  PLAN_MARKDOWN_MAX,
  shouldUseAgent,
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

  it('isPlanBlockedRisk includes mcp', () => {
    assert.equal(isPlanBlockedRisk('mcp'), true);
  });

  it('filterToolsForMode plan hides spawn_explore and mcp_*', () => {
    const defs = [
      { function: { name: 'read_file' } },
      { function: { name: 'spawn_explore' } },
      { function: { name: 'mcp_demo_ping' } },
      { function: { name: 'submit_plan' } },
      { function: { name: 'list_skills' } },
    ];
    const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
    assert.ok(plan.includes('read_file'));
    assert.ok(plan.includes('submit_plan'));
    assert.ok(plan.includes('list_skills'));
    assert.ok(!plan.includes('spawn_explore'));
    assert.ok(!plan.includes('mcp_demo_ping'));
  });

  it('plan mode hides spawn_implement and spawn_explores', () => {
    const defs = ['spawn_explore', 'spawn_explores', 'spawn_implement', 'read_file'].map((name) => ({
      type: 'function',
      function: { name },
    }));
    const plan = filterToolsForMode(defs, 'plan');
    const names = plan.map((t) => t.function.name);
    assert.deepEqual(names, ['read_file']);
  });

  it('plan mode hides run_skill keeps list_skills and use_skill', () => {
    const defs = ['list_skills', 'use_skill', 'run_skill', 'read_file'].map((name) => ({
      type: 'function',
      function: { name },
    }));
    const plan = filterToolsForMode(defs, 'plan').map((t) => t.function.name);
    assert.ok(plan.includes('list_skills'));
    assert.ok(plan.includes('use_skill'));
    assert.ok(plan.includes('read_file'));
    assert.ok(!plan.includes('run_skill'));
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

  it('plan mode hides verification and workflow mutations while keeping bounded engineering reads', () => {
    const defs = [
      'code_index_status', 'code_index_search', 'verification_profiles', 'verification_get', 'verification_result', 'verification_start',
      'engineering_workflows', 'workflow_get', 'workflow_result', 'workflow_start', 'workflow_cancel',
    ]
      .map((name) => ({ type: 'function', function: { name } }));
    const names = filterToolsForMode(defs, 'plan').map((tool) => tool.function.name);
    assert.ok(names.includes('code_index_status'));
    assert.ok(names.includes('verification_result'));
    assert.ok(names.includes('engineering_workflows'));
    assert.ok(names.includes('workflow_result'));
    assert.ok(!names.includes('verification_start'));
    assert.ok(!names.includes('workflow_start'));
    assert.ok(!names.includes('workflow_cancel'));
  });

  it('uses a memory-only Agent for unbound API chats only when memory is enabled', () => {
    assert.equal(shouldUseAgent({
      settings: { mode: 'api', agentEnabled: true, apiKey: 'k', memoryEnabled: true },
      project: null,
    }), true);
    assert.equal(shouldUseAgent({
      settings: { mode: 'api', agentEnabled: true, apiKey: 'k', memoryEnabled: false },
      project: null,
    }), false);
    assert.equal(shouldUseAgent({
      settings: { mode: 'api', agentEnabled: true, apiKey: 'k', memoryEnabled: false },
      project: { path: 'C:\\project' },
    }), true);
  });
});
