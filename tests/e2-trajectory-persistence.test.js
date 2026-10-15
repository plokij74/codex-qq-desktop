'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TRAJECTORY_KINDS,
  stripSecrets,
  createMessageV2,
  normalizeMessage,
  projectToUiModel,
  projectToModelMessages,
  projectToStorageJson,
} = require('../src/ai/message-schema');

describe('E2 Tool Trajectory Persistence (G05)', () => {
  it('strips API keys and credentials from trajectory details', () => {
    const rawData = {
      apiKey: 'sk-ant-api03-secret1234567890',
      token: 'bearer 998877665544332211',
      nested: {
        authorization: 'Bearer secret_token',
        password: 'super-password',
        safeProperty: 'safe-value',
      },
      arrayProp: [
        { client_secret: 'secret-val', label: 'ok-label' },
      ],
    };

    const sanitized = stripSecrets(rawData);
    assert.equal(sanitized.apiKey, '[REDACTED]');
    assert.equal(sanitized.token, '[REDACTED]');
    assert.equal(sanitized.nested.authorization, '[REDACTED]');
    assert.equal(sanitized.nested.password, '[REDACTED]');
    assert.equal(sanitized.nested.safeProperty, 'safe-value');
    assert.equal(sanitized.arrayProp[0].client_secret, '[REDACTED]');
    assert.equal(sanitized.arrayProp[0].label, 'ok-label');
  });

  it('bounds trajectory item count to MAX_TRAJECTORY_ITEMS (50)', () => {
    const items = [];
    for (let i = 0; i < 70; i += 1) {
      items.push({
        kind: TRAJECTORY_KINDS.TOOL,
        tool: `tool_${i}`,
        summary: `Action ${i}`,
        status: 'completed',
      });
    }

    const msg = createMessageV2({
      role: 'assistant',
      content: 'Work done',
      trajectory: items,
    });

    assert.equal(msg.trajectory.length, 50);
    // Keeps the most recent items
    assert.equal(msg.trajectory[0].tool, 'tool_20');
    assert.equal(msg.trajectory[49].tool, 'tool_69');
  });

  it('bounds long output strings in trajectory details to MAX_OUTPUT_LENGTH', () => {
    const hugeOutput = 'A'.repeat(5000);
    const msg = createMessageV2({
      role: 'assistant',
      content: 'Ran command',
      trajectory: [
        {
          kind: TRAJECTORY_KINDS.TOOL,
          tool: 'bash',
          summary: 'Long output test',
          status: 'completed',
          detail: { output: hugeOutput },
        },
      ],
    });

    assert.equal(msg.trajectory.length, 1);
    assert.ok(msg.trajectory[0].detail.output.length <= 2050);
    assert.ok(msg.trajectory[0].detail.output.includes('[TRUNCATED]'));
  });

  it('never leaks trajectory items into model messages', () => {
    const msg = createMessageV2({
      role: 'assistant',
      content: 'Here is the response text',
      trajectory: [
        {
          kind: TRAJECTORY_KINDS.TOOL,
          tool: 'bash',
          summary: 'Internal bash execution',
          detail: { command: 'cat /etc/passwd' },
          status: 'completed',
        },
        {
          kind: TRAJECTORY_KINDS.VERIFY,
          summary: 'Run verification tests',
          status: 'completed',
        },
      ],
    });

    const modelMsgs = projectToModelMessages([msg]);
    assert.equal(modelMsgs.length, 1);
    assert.equal(modelMsgs[0].role, 'assistant');
    assert.equal(modelMsgs[0].content, 'Here is the response text');
    assert.ok(!modelMsgs[0].content.includes('Internal bash execution'));
    assert.ok(!modelMsgs[0].content.includes('/etc/passwd'));
    assert.ok(!modelMsgs[0].content.includes('Run verification tests'));
  });

  it('preserves full trajectory timeline across storage serialization and reload (G05)', () => {
    const originalMsg = createMessageV2({
      role: 'assistant',
      content: 'Analyzed files',
      trajectory: [
        {
          id: 'step-1',
          kind: TRAJECTORY_KINDS.APPROVAL,
          summary: 'User approved file edit',
          status: 'approved',
          timestamp: 1700000000000,
        },
        {
          id: 'step-2',
          kind: TRAJECTORY_KINDS.TOOL,
          tool: 'readFile',
          summary: 'Read src/index.js',
          status: 'completed',
          durationMs: 42,
          timestamp: 1700000001000,
        },
        {
          id: 'step-3',
          kind: TRAJECTORY_KINDS.VERIFY,
          summary: 'Check TypeScript compilation',
          status: 'completed',
          timestamp: 1700000002000,
        },
        {
          id: 'step-4',
          kind: TRAJECTORY_KINDS.SUBAGENT,
          summary: 'Spawned code reviewer agent',
          status: 'completed',
          timestamp: 1700000003000,
        },
      ],
    });

    // 1. Storage serialization
    const storageJson = projectToStorageJson(originalMsg);
    assert.ok(storageJson.parts);
    assert.equal(storageJson.trajectory.length, 4);

    // 2. Storage roundtrip
    const serialized = JSON.stringify(storageJson);
    const parsed = JSON.parse(serialized);

    // 3. Reload / Deserialization
    const restored = normalizeMessage(parsed);
    assert.equal(restored.schemaVersion, 2);
    assert.equal(restored.trajectory.length, 4);
    assert.equal(restored.trajectory[0].kind, TRAJECTORY_KINDS.APPROVAL);
    assert.equal(restored.trajectory[1].kind, TRAJECTORY_KINDS.TOOL);
    assert.equal(restored.trajectory[1].durationMs, 42);
    assert.equal(restored.trajectory[2].kind, TRAJECTORY_KINDS.VERIFY);
    assert.equal(restored.trajectory[3].kind, TRAJECTORY_KINDS.SUBAGENT);

    // 4. UI projection
    const ui = projectToUiModel(restored);
    assert.equal(ui.trajectory.length, 4);
    assert.equal(ui.displayText, 'Analyzed files');
  });
});
