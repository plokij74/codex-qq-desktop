'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const projectFs = require('../src/ai/project-fs');
const { AGENT_EVENTS } = require('../src/ai/agent-events');
const { validateModelRegistry } = require('../src/ai/model-profiles');
const { readRecords, usageFilePath } = require('../src/ai/usage-store');
const { loadMainFixture, syntheticRegistry, deferred } = require('./helpers/e4-main-fixture');

function setup(t, heldTool = 'write_file') {
  const registry = syntheticRegistry();
  registry.assistants.find(item => item.id === 'assistant_general').toolPolicy = {
    mode: 'allowlist', allowedTools: ['list_dir', 'write_file'],
  };
  const entered = deferred(), allowed = deferred(), writes = [];
  let signal, reads = 0;
  const f = loadMainFixture(t, {
    registry: validateModelRegistry(registry),
    beforeClose: () => allowed.resolve(),
    fetchFn: () => { throw new Error('Host shortcut must not make a model request'); },
    gateFn: () => ({
      async authorize(request) {
        signal = request.signal;
        if (request.tool === heldTool) { entered.resolve(); await allowed.promise; }
        return { allowed: true };
      },
      cancelPending() {},
    }),
    modules: { './ai/project-fs': { ...projectFs,
      buildTreeReply: () => { reads++; return { content: 'Synthetic project tree', structureMarkdown: '# Synthetic structure' }; },
      writeFile: (root, rel, content) => {
        writes.push({ root, rel, signalAborted: signal?.aborted });
        return { path: rel, bytes: Buffer.byteLength(content) };
      },
    } },
  });
  return { f, entered, allow: () => allowed.resolve(), writes,
    get reads() { return reads; }, get signal() { return signal; } };
}
async function acceptShortcut(probe) {
  const { f } = probe;
  const project = { id: 'e4-host-race-project', path: path.join(f.root, 'project') };
  fs.mkdirSync(project.path);
  const binding = await f.invoke('worktree:bind', { projectId: project.id, projectPath: project.path });
  assert.equal(binding.ok, true);
  const accepted = await f.accept('chat:send', f.payload({ project, projectBindingId: binding.projectBindingId,
    expectedRegistryRevision: f.settings().modelRegistry.revision,
    messages: [{ role: 'user', content: '生成项目结构并保存为 E4_STRUCTURE.md' }] }));
  assert.equal(accepted.accepted, true);
  await probe.entered.promise;
  return { accepted, projectBindingId: binding.projectBindingId };
}

for (const revocation of ['owned stop', 'project unbind', 'assistant policy']) {
  test(`actual main host write does not execute after ${revocation} while an allowed Gate settles`, { timeout: 10000 }, async t => {
    const probe = setup(t), { f } = probe;
    const { accepted, projectBindingId } = await acceptShortcut(probe);
    let revoked;
    if (revocation === 'owned stop') revoked = await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId });
    else if (revocation === 'project unbind') revoked = await f.invoke('worktree:unbind', { projectBindingId });
    else revoked = await f.invoke('assistants:save', { assistant: { id: 'assistant_general', toolPolicy: { mode: 'none', allowedTools: [] } },
      expectedRevision: f.settings().modelRegistry.revision });
    assert.equal(revoked.ok, true); assert.equal(probe.signal.aborted, true);
    probe.allow();
    const result = await f.settle(accepted);
    assert.deepEqual(probe.writes, [], 'No host write is allowed after the accepted signal is revoked');
    assert.equal(result.ok, false); assert.equal(result.aborted, true); assert.equal(result.code, 'MODEL_CANCELLED');
    const events = f.events.filter(item => item.channel === 'chat:event').map(item => item.event);
    assert.equal(events.some(event => event.type === AGENT_EVENTS.TOOL_END && event.ok === true), false);
    assert.equal(events.some(event => event.type === AGENT_EVENTS.FILE_CHANGE), false);
    assert.equal(events.filter(event => [AGENT_EVENTS.DONE, AGENT_EVENTS.ERROR, AGENT_EVENTS.ABORTED].includes(event.type)).length, 1);
    assert.equal(events.at(-1).type, AGENT_EVENTS.ABORTED);
    assert.equal(f.inspect('foregroundModels.current'), null);
    assert.equal(f.requests.length, 0); assert.equal(f.credentialReads.length, 0);
    assert.deepEqual(readRecords(usageFilePath(f.root)).records, []);
  });
}

test('actual main host read rejects cancellation before any shortcut filesystem access', { timeout: 10000 }, async t => {
  const probe = setup(t, 'list_dir'), { f } = probe;
  const { accepted } = await acceptShortcut(probe);
  assert.equal((await f.invoke('chat:stop', { sessionId: accepted.sessionId, runId: accepted.runId })).ok, true);
  probe.allow(); const result = await f.settle(accepted);
  assert.equal(probe.reads, 0); assert.deepEqual(probe.writes, []);
  assert.equal(result.code, 'MODEL_CANCELLED'); assert.equal(result.aborted, true);
  assert.equal(f.requests.length, 0);
});

test('actual main still performs exactly one authorized host write when no revocation occurs', { timeout: 10000 }, async t => {
  const probe = setup(t), { f } = probe;
  const { accepted } = await acceptShortcut(probe);
  probe.allow(); const result = await f.settle(accepted);
  assert.equal(result.ok, true); assert.equal(result.hostTool, 'listTree');
  assert.equal(probe.reads, 1); assert.equal(probe.writes.length, 1);
  assert.equal(probe.writes[0].signalAborted, false);
  assert.equal(result.applied.length, 1); assert.equal(result.applied[0].ok, true);
  assert.equal(f.requests.length, 0); assert.deepEqual(readRecords(usageFilePath(f.root)).records, []);
});
