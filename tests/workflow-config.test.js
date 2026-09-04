'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkflow, stableTopologicalSort, workflowFingerprint,
} = require('../src/ai/workflow-config');

const profiles = [
  { id: 'vfy_aaaaaaaa', name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', cwd: '.', timeoutMs: 60000, enabled: true },
  { id: 'vfy_bbbbbbbb', name: 'test', kind: 'test', command: 'npm test', cwd: '.', timeoutMs: 60000, enabled: true },
  { id: 'vfy_cccccccc', name: 'build', kind: 'build', command: 'npm run build', cwd: '.', timeoutMs: 60000, enabled: true },
];

describe('D12 workflow config', () => {
  it('normalizes a stable DAG and rejects cycles, missing profiles, and unknown fields', () => {
    const workflow = normalizeWorkflow({
      name: 'gate',
      nodes: [
        { nodeId: 'build', profileId: 'vfy_cccccccc', dependsOn: ['test'] },
        { nodeId: 'test', profileId: 'vfy_bbbbbbbb', dependsOn: ['typecheck'] },
        { nodeId: 'typecheck', profileId: 'vfy_aaaaaaaa', dependsOn: [] },
      ],
    }, profiles);
    assert.deepEqual(stableTopologicalSort(workflow.nodes), ['typecheck', 'test', 'build']);
    assert.equal(workflow.workflowFingerprint, workflowFingerprint(workflow));
    assert.throws(() => normalizeWorkflow({ name: 'bad', extra: true, nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa' }] }, profiles), (e) => e.code === 'WORKFLOW_INVALID');
    assert.throws(() => normalizeWorkflow({ name: 'bad', nodes: [{ nodeId: 'a', profileId: 'vfy_aaaaaaaa', dependsOn: ['b'] }, { nodeId: 'b', profileId: 'vfy_bbbbbbbb', dependsOn: ['a'] }] }, profiles), (e) => e.code === 'WORKFLOW_CYCLE');
    assert.throws(() => normalizeWorkflow({ name: 'bad', nodes: [{ nodeId: 'a', profileId: 'vfy_deadbeef' }] }, profiles), (e) => e.code === 'WORKFLOW_PROFILE_NOT_FOUND');
  });
});
