const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAgentLoop } = require('../src/ai/agent');
const schema = require('../src/ai/message-schema');
const { collect, restore } = require('../src/renderer/e2-messages');

const settings = { maxAgentTurns: 5, hooksEnabled: false, verifyBeforeDone: false, terminalEnabled: false };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-call-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const run = {};
  return {
    events, run, root,
    options: {
      project: { path: root }, settings,
      messages: [{ role: 'user', content: 'exercise tool events' }],
      onEvent(event) { events.push(event); collect(run, event, schema, events.length); },
    },
  };
}
function assertPairs(events, run, statuses) {
  const starts = events.filter((e) => e.type === 'tool-start');
  const ends = events.filter((e) => e.type === 'tool-end');
  assert.equal(starts.length, statuses.length);
  assert.equal(ends.length, starts.length);
  assert.ok(starts.every((e) => typeof e.callId === 'string' && e.callId.length > 0));
  assert.equal(new Set(starts.map((e) => e.callId)).size, starts.length);
  for (const start of starts) {
    const matches = ends.filter((end) => end.callId === start.callId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].tool, start.tool);
    assert.ok(events.indexOf(matches[0]) > events.indexOf(start));
  }
  const restored = restore(JSON.parse(JSON.stringify({ role: 'assistant', parts: [], trajectory: run.trajectory })), schema);
  const tools = restored.trajectory.filter((item) => item.kind === 'tool');
  assert.deepEqual(tools.map((item) => item.callId), starts.map((e) => e.callId));
  assert.deepEqual(tools.map((item) => item.status), statuses);
}
function readCall(file) {
  return { id: 'reused-model-id', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } };
}

test('actual agent pairs repeated same-name and model-ID calls across rounds, including failed results', async (t) => {
  const { options, root, events, run } = setup(t);
  fs.writeFileSync(path.join(root, 'exists.txt'), 'hello');
  let turn = 0;
  await runAgentLoop({
    ...options,
    chatFn: async ({ messages }) => {
      turn += 1;
      if (turn === 1) return { role: 'assistant', tool_calls: [readCall('exists.txt'), readCall('missing.txt')] };
      assert.ok(messages.filter((m) => m.role === 'tool').every((m) => m.tool_call_id === 'reused-model-id'));
      if (turn === 2) return { role: 'assistant', tool_calls: [readCall('exists.txt')] };
      return { role: 'assistant', content: 'done' };
    },
  });
  assertPairs(events, run, ['success', 'error', 'success']);
});

for (const aborted of [false, true]) {
  test(`actual agent pairs unexpected ${aborted ? 'abort' : 'error'} end`, async (t) => {
    const { options, events, run } = setup(t);
    const error = Object.assign(new Error(aborted ? 'cancelled' : 'provider failed'), aborted ? { code: 'ABORTED' } : {});
    const registry = {
      onRunStart: async () => {}, onRunEnd: async () => {},
      collectTools: async () => [], systemFragments: async () => '',
      execute: async () => { throw error; },
    };
    await assert.rejects(runAgentLoop({
      ...options, registry,
      chatFn: async () => ({ role: 'assistant', tool_calls: [readCall('anything.txt')] }),
    }), aborted ? { code: 'ABORTED' } : /provider failed/);
    assertPairs(events, run, ['error']);
    assert.equal(events.find((e) => e.type === 'tool-end').summary, aborted ? '已停止' : 'provider failed');
  });
}

test('actual agent pairs each write fence through success, denied path, denied gate and write failure', async (t) => {
  const { options, root, events, run } = setup(t);
  fs.mkdirSync(path.join(root, 'directory'));
  const gate = {
    validatePath: async ({ path: file }) => ({ allowed: file !== 'bad-path.txt', reason: 'invalid path' }),
    authorize: async ({ path: file }) => ({ allowed: file !== 'denied.txt', reason: 'denied' }),
  };
  await runAgentLoop({
    ...options, gate,
    chatFn: async () => ({ role: 'assistant', content: ['written.txt', 'bad-path.txt', 'denied.txt', 'directory'].map((file) => `\`\`\`write:${file}\nhello\n\`\`\``).join('\n') }),
  });
  assertPairs(events, run, ['success', 'error', 'error', 'error']);
  assert.equal(fs.readFileSync(path.join(root, 'written.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
});

test('actual agent pairs an aborted write fence after an earlier successful fence', async (t) => {
  const { options, events, run } = setup(t);
  let count = 0;
  await assert.rejects(runAgentLoop({
    ...options,
    gate: { authorize: async () => {
      if (++count === 2) throw Object.assign(new Error('cancelled'), { code: 'ABORTED' });
      return { allowed: true };
    } },
    chatFn: async () => ({ role: 'assistant', content: '```write:first.txt\nfirst\n```\n```write:second.txt\nsecond\n```' }),
  }), { code: 'ABORTED' });
  assertPairs(events, run, ['success', 'error']);
  assert.equal(events.filter((e) => e.type === 'tool-end')[1].summary, '已停止');
});
