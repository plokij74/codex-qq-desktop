'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_STATUS,
  createMessageV2,
  normalizeMessage,
  projectToUiModel,
  projectToModelMessages,
} = require('../src/ai/message-schema');

describe('E2 Plan Lifecycle & Disentanglement (G04)', () => {
  it('initializes plan part in proposed status with steps and markdown', () => {
    const planPart = {
      type: 'plan',
      planId: 'plan-123',
      title: 'Database Migration Plan',
      markdown: '1. Backup DB\n2. Run migration\n3. Verify integrity',
      steps: ['Backup DB', 'Run migration', 'Verify integrity'],
      status: PLAN_STATUS.PROPOSED,
      createdAt: Date.now(),
    };

    const msg = createMessageV2('assistant', [
      { type: 'text', text: 'Here is the plan for review:' },
      planPart,
    ]);

    assert.equal(msg.planId, 'plan-123');
    assert.equal(msg.planStatus, PLAN_STATUS.PROPOSED);
    assert.equal(msg.parts.length, 2);
    assert.equal(msg.parts[1].status, PLAN_STATUS.PROPOSED);
    assert.deepEqual(msg.parts[1].steps, ['Backup DB', 'Run migration', 'Verify integrity']);
  });

  it('transitions proposed plan to approved upon user approval', () => {
    const planPart = {
      type: 'plan',
      planId: 'plan-123',
      title: 'Database Migration Plan',
      markdown: '1. Backup DB\n2. Run migration',
      steps: ['Backup DB', 'Run migration'],
      status: PLAN_STATUS.PROPOSED,
      createdAt: Date.now(),
    };

    const msg = createMessageV2('assistant', [planPart]);
    assert.equal(msg.parts[0].status, PLAN_STATUS.PROPOSED);

    // Simulate approval action
    msg.parts[0].status = PLAN_STATUS.APPROVED;
    msg.parts[0].resolvedAt = Date.now();
    msg.planStatus = PLAN_STATUS.APPROVED;

    const ui = projectToUiModel(msg);
    assert.equal(ui.plan.status, PLAN_STATUS.APPROVED);
    assert.ok(ui.plan.resolvedAt > 0);
  });

  it('transitions proposed plan to rejected upon user rejection', () => {
    const planPart = {
      type: 'plan',
      planId: 'plan-456',
      title: 'Dangerous Refactor',
      markdown: '1. Delete everything\n2. Start over',
      steps: ['Delete everything', 'Start over'],
      status: PLAN_STATUS.PROPOSED,
      createdAt: Date.now(),
    };

    const msg = createMessageV2('assistant', [planPart]);

    // Simulate rejection action
    msg.parts[0].status = PLAN_STATUS.REJECTED;
    msg.parts[0].resolvedAt = Date.now();
    msg.planStatus = PLAN_STATUS.REJECTED;

    const ui = projectToUiModel(msg);
    assert.equal(ui.plan.status, PLAN_STATUS.REJECTED);
  });

  it('marks older proposed plans as superseded when a new plan is proposed', () => {
    const sessionMessages = [
      createMessageV2('assistant', [
        {
          type: 'plan',
          planId: 'plan-v1',
          title: 'Initial Plan',
          markdown: 'Old steps',
          status: PLAN_STATUS.PROPOSED,
        },
      ]),
      createMessageV2('user', 'Can you refine the plan?'),
    ];

    // New plan proposed
    const newPlanId = 'plan-v2';
    // Supercede older proposed plans
    for (const m of sessionMessages) {
      if (Array.isArray(m.parts)) {
        for (const p of m.parts) {
          if (p.type === 'plan' && p.status === PLAN_STATUS.PROPOSED) {
            p.status = PLAN_STATUS.SUPERSEDED;
          }
        }
      }
      if (m.planStatus === PLAN_STATUS.PROPOSED) {
        m.planStatus = PLAN_STATUS.SUPERSEDED;
      }
    }

    const newMsg = createMessageV2('assistant', [
      {
        type: 'plan',
        planId: newPlanId,
        title: 'Refined Plan',
        markdown: 'New steps',
        status: PLAN_STATUS.PROPOSED,
      },
    ]);
    sessionMessages.push(newMsg);

    assert.equal(sessionMessages[0].parts[0].status, PLAN_STATUS.SUPERSEDED);
    assert.equal(sessionMessages[2].parts[0].status, PLAN_STATUS.PROPOSED);
  });

  it('projects plan history to model correctly without widget leaks', () => {
    const msg = createMessageV2('assistant', [
      {
        type: 'plan',
        planId: 'p-1',
        title: 'Implementation Plan',
        markdown: '1. Step 1\n2. Step 2',
        status: PLAN_STATUS.APPROVED,
      },
      {
        type: 'text',
        text: 'I will now begin executing this plan.',
      },
    ]);

    const modelMsgs = projectToModelMessages([msg]);
    assert.equal(modelMsgs.length, 1);
    assert.equal(modelMsgs[0].role, 'assistant');
    assert.ok(modelMsgs[0].content.includes('已提交计划：'));
    assert.ok(modelMsgs[0].content.includes('1. Step 1'));
    assert.ok(modelMsgs[0].content.includes('I will now begin executing this plan.'));
    // Should NOT contain internal buttons or UI tokens
    assert.ok(!modelMsgs[0].content.includes('plan-btn'));
    assert.ok(!modelMsgs[0].content.includes('plan-actions'));
  });

  it('preserves plan cards and actions across session message reloads', () => {
    const originalMsg = createMessageV2('assistant', [
      {
        type: 'plan',
        planId: 'plan-persist',
        title: 'Deploy Plan',
        markdown: 'Run docker compose up',
        steps: ['Run docker compose up'],
        status: PLAN_STATUS.PROPOSED,
      },
    ]);

    // Simulate saving to JSON (LocalStore) and reading back
    const serialized = JSON.stringify(originalMsg);
    const deserialized = JSON.parse(serialized);
    const restored = normalizeMessage(deserialized);

    assert.equal(restored.schemaVersion, 2);
    assert.equal(restored.parts.length, 1);
    assert.equal(restored.parts[0].type, 'plan');
    assert.equal(restored.parts[0].planId, 'plan-persist');
    assert.equal(restored.parts[0].status, PLAN_STATUS.PROPOSED);
    assert.equal(restored.planId, 'plan-persist');
  });
});
