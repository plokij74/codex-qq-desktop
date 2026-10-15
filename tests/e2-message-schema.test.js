'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION,
  DEFAULT_BUDGETS,
  createMessageV2,
  normalizeMessage,
  projectToUIMessage,
  projectToModelMessages,
  projectToStorageMessage,
  migrateV1ToV2,
} = require('../src/ai/message-schema');

const {
  TASK_GATE_STATUS,
  buildTaskContract,
  parseTaskInstructions,
  evaluateTaskGate,
  recordContractStep,
  isTaskComplete,
} = require('../src/ai/task-contract');

describe('E2 Message Schema & Projections (E2 Contract)', () => {
  it('creates valid v2 messages with default fields', () => {
    const msg = createMessageV2('user', 'Hello world');
    assert.equal(msg.schemaVersion, SCHEMA_VERSION);
    assert.equal(msg.role, 'user');
    assert.equal(msg.content, 'Hello world');
    assert.equal(Array.isArray(msg.parts), true);
    assert.equal(msg.parts.length, 1);
    assert.deepEqual(msg.parts[0], { type: 'text', text: 'Hello world' });
    assert.equal(Array.isArray(msg.trajectory), true);
    assert.ok(msg.id && typeof msg.id === 'string');
    assert.ok(typeof msg.createdAt === 'number');
  });

  it('supports structured parts (text, plan, tool_call, tool_result, attachment_ref)', () => {
    const parts = [
      { type: 'text', text: 'Here is the plan and reference' },
      {
        type: 'attachment_ref',
        attachmentId: 'att-1',
        name: 'spec.pdf',
        mime: 'application/pdf',
        size: 1024,
      },
      {
        type: 'plan',
        planId: 'plan-101',
        title: 'Refactor Step',
        markdown: '1. Do this\n2. Do that',
        steps: ['Do this', 'Do that'],
        status: 'proposed',
      },
      {
        type: 'tool_call',
        callId: 'call-1',
        tool: 'read_file',
        args: { path: 'a.js' },
      },
      {
        type: 'tool_result',
        callId: 'call-1',
        tool: 'read_file',
        result: { ok: true, content: 'code' },
      },
    ];

    const msg = createMessageV2('assistant', parts);
    assert.equal(msg.parts.length, 5);
    assert.equal(msg.parts[1].type, 'attachment_ref');
    assert.equal(msg.parts[2].type, 'plan');
    assert.equal(msg.planId, 'plan-101');
    assert.equal(msg.planStatus, 'proposed');
  });

  it('migrates legacy v1 message to v2 seamlessly', () => {
    const legacyMsg = {
      role: 'assistant',
      content: 'Legacy reply',
      fileChanges: [{ path: 'foo.js', op: 'write' }],
      planId: 'p-1',
      planTitle: 'Legacy Plan',
      planMarkdown: 'steps...',
      planStatus: 'approved',
    };

    const v2 = migrateV1ToV2(legacyMsg);
    assert.equal(v2.schemaVersion, 2);
    assert.equal(v2.role, 'assistant');
    assert.equal(v2.content, 'Legacy reply');
    assert.equal(v2.parts.some((p) => p.type === 'plan' && p.planId === 'p-1' && p.status === 'approved'), true);
    assert.equal(v2.fileChanges.length, 1);
  });

  it('normalizes unknown/malformed messages without dropping data', () => {
    const malformed = {
      role: 'assistant',
      content: 12345,
      parts: 'not-an-array',
      unknownCustomProp: 'should-preserve',
    };
    const norm = normalizeMessage(malformed);
    assert.equal(norm.schemaVersion, 2);
    assert.equal(norm.content, '12345');
    assert.equal(Array.isArray(norm.parts), true);
    assert.equal(norm.unknownCustomProp, 'should-preserve');
  });

  it('projects to UI message with clean display markdown and badge metadata', () => {
    const msg = createMessageV2('assistant', [
      { type: 'text', text: 'I completed the task.' },
      { type: 'attachment_ref', name: 'report.docx', size: 2048 },
      { type: 'plan', planId: 'p-2', title: 'Plan', markdown: 'Steps', status: 'approved' },
    ]);
    msg.trajectory = [
      { kind: 'tool', tool: 'write_file', summary: 'wrote report.docx' },
      { kind: 'verify', passed: true, command: 'npm test' },
    ];

    const uiMsg = projectToUIMessage(msg);
    assert.equal(uiMsg.role, 'assistant');
    assert.ok(uiMsg.content.includes('I completed the task.'));
    assert.equal(uiMsg.plan.status, 'approved');
    assert.equal(uiMsg.attachments.length, 1);
    assert.equal(uiMsg.attachments[0].name, 'report.docx');
    assert.equal(uiMsg.trajectory.length, 2);
  });

  it('projects to Model messages excluding heavy UI widgets and rendering attachments', () => {
    const msg = createMessageV2('user', [
      { type: 'text', text: 'Please review this file' },
      { type: 'attachment_ref', name: 'config.json', size: 100, mime: 'application/json' },
    ]);

    const modelMsgs = projectToModelMessages(msg);
    assert.equal(modelMsgs.length, 1);
    assert.equal(modelMsgs[0].role, 'user');
    assert.ok(modelMsgs[0].content.includes('Please review this file'));
    assert.ok(modelMsgs[0].content.includes('[附件: config.json (application/json, 100 字节)]'));
  });

  it('projects to Storage message preserving compact schema', () => {
    const msg = createMessageV2('assistant', [
      { type: 'text', text: 'Done.' },
      { type: 'plan', planId: 'p-1', status: 'approved' },
    ]);
    msg.trajectory = [{ kind: 'tool', tool: 'build', status: 'success' }];

    const stored = projectToStorageMessage(msg);
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.role, 'assistant');
    assert.equal(stored.parts.length, 2);
    assert.equal(stored.trajectory.length, 1);
  });
});

describe('E2 Common Task Contract (E9/E10 Contract)', () => {
  it('builds task contract with default and overridden budgets', () => {
    const contract = buildTaskContract({
      taskId: 'task-001',
      title: 'Fix issue',
      instructions: 'Fix bug in auth module',
      verificationCriteria: ['Tests must pass', 'No lint errors'],
      budgets: {
        maxTurns: 10,
        maxCostUsd: 1.5,
      },
    });

    assert.equal(contract.taskId, 'task-001');
    assert.equal(contract.title, 'Fix issue');
    assert.equal(contract.verificationCriteria.length, 2);
    assert.equal(contract.budgets.maxTurns, 10);
    assert.equal(contract.budgets.maxCostUsd, 1.5);
    assert.equal(contract.budgets.maxToolCalls, DEFAULT_BUDGETS.maxToolCalls);
    assert.equal(contract.status, TASK_GATE_STATUS.PENDING);
  });

  it('parses structured instructions from text/markdown with verification criteria', () => {
    const raw = `
# Task: Migrate Database
Instructions: Run migration script and verify integrity.
Verification:
- schema version is 5
- all rows preserved
- no duplicate keys
`;
    const parsed = parseTaskInstructions(raw);
    assert.equal(parsed.title, 'Migrate Database');
    assert.ok(parsed.instructions.includes('Run migration script'));
    assert.equal(parsed.verificationCriteria.length, 3);
    assert.equal(parsed.verificationCriteria[0], 'schema version is 5');
  });

  it('records steps and evaluates task budgets and gates', () => {
    const contract = buildTaskContract({
      taskId: 'task-test',
      budgets: { maxTurns: 2, maxToolCalls: 2 },
      verificationCriteria: ['tests pass'],
    });

    // Record turn 1
    recordContractStep(contract, { tool: 'search', ok: true });
    assert.equal(contract.spent.toolCalls, 1);
    assert.equal(contract.spent.turns, 1);

    let gate = evaluateTaskGate(contract, { verifyPassed: false });
    assert.equal(gate.status, TASK_GATE_STATUS.IN_PROGRESS);

    // Record turn 2
    recordContractStep(contract, { tool: 'edit', ok: true });
    assert.equal(contract.spent.toolCalls, 2);
    assert.equal(contract.spent.turns, 2);

    // Turn limit reached without verification passed
    gate = evaluateTaskGate(contract, { verifyPassed: false });
    assert.equal(gate.status, TASK_GATE_STATUS.FAILED);
    assert.ok(gate.reason.includes('Turn budget exceeded'));

    // If verification passed, should succeed
    const passGate = evaluateTaskGate(contract, { verifyPassed: true });
    assert.equal(passGate.status, TASK_GATE_STATUS.PASSED);
    assert.equal(isTaskComplete(contract), true);
  });
});
